// local Postgres for the MVP (RR_DB=pglite): PGlite with PostGIS, pgvector and pgcrypto behind the lib/db.ts Database interface
import "server-only";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite, type Extension, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { DatabaseError, type Database, type Param, type SqlRunner } from "../db.ts";
import { seedDemo } from "./seed.ts";

export interface PgliteDatabase extends Database {
  close(): Promise<void>;
}

// postgres type oids
const TEXT = 25;
const INT8 = 20;
const FLOAT8 = 701;
const BOOL = 16;
const BYTEA = 17;
const UNKNOWN = 0;

/**
 * result values as the Data API returns them with formatRecordsAs JSON, so code tested here also works on Aurora:
 * dates, times and json come back as strings, bytea as base64. ints, floats, booleans and arrays stay native.
 * https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-json.html
 */
const raw = (value: string) => value;
const PARSERS = {
  1082: raw, // date
  1083: raw, // time
  1114: raw, // timestamp
  1184: raw, // timestamptz
  114: raw, // json
  3802: raw, // jsonb
  [BYTEA]: (value: string) => Buffer.from(value.slice(2), "hex").toString("base64"),
};

export interface TranslatedSql {
  text: string;
  values: unknown[];
  types: number[];
}

function paramValue(param: Param): { value: unknown; type: number } {
  const v = param.value ?? { isNull: true };
  if (v.isNull) return { value: null, type: UNKNOWN };
  if (v.stringValue !== undefined) return { value: v.stringValue, type: TEXT };
  if (v.longValue !== undefined) return { value: v.longValue, type: INT8 };
  if (v.doubleValue !== undefined) return { value: v.doubleValue, type: FLOAT8 };
  if (v.booleanValue !== undefined) return { value: v.booleanValue, type: BOOL };
  if (v.blobValue !== undefined) return { value: v.blobValue, type: BYTEA };
  throw new DatabaseError("unsupported_parameter");
}

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

/**
 * turns Data API ":name" parameters into postgres "$n". skips '...' and E'...' literals, "..." identifiers, -- and
 * block comments, $tag$ quotes and the :: cast. a name used twice maps to the same $n. params use the Data API's
 * types (text, bigint, float8, bool, bytea), so a missing CAST fails here just as it would on Aurora.
 */
export function translateNamedParams(sql: string, params: Param[] = []): TranslatedSql {
  const byName = new Map(params.map((param) => [param.name ?? "", param]));
  const positions = new Map<string, number>();
  const values: unknown[] = [];
  const types: number[] = [];
  let out = "";
  let i = 0;

  function copyUntil(end: number) {
    out += sql.slice(i, end);
    i = end;
  }

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'") {
      const escapes = (sql[i - 1] === "E" || sql[i - 1] === "e") && !NAME_PART.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      copyUntil(Math.min(j + 1, sql.length));
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      copyUntil(end === -1 ? sql.length : end + 1);
    } else if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      copyUntil(end === -1 ? sql.length : end);
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      copyUntil(end === -1 ? sql.length : end + 2);
    } else if (ch === "$" && !NAME_PART.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        copyUntil(end === -1 ? sql.length : end + tag.length);
      } else {
        copyUntil(i + 1);
      }
    } else if (ch === ":" && next === ":") {
      copyUntil(i + 2);
    } else if (ch === ":" && next !== undefined && NAME_START.test(next)) {
      let j = i + 1;
      while (j < sql.length && NAME_PART.test(sql[j])) j += 1;
      const name = sql.slice(i + 1, j);
      const param = byName.get(name);
      if (!param) throw new DatabaseError(`missing_parameter:${name}`);
      let position = positions.get(name);
      if (position === undefined) {
        const { value, type } = paramValue(param);
        values.push(value);
        types.push(type);
        position = values.length;
        positions.set(name, position);
      }
      out += `$${position}`;
      i = j;
    } else {
      copyUntil(i + 1);
    }
  }
  return { text: out, values, types };
}

type Queryable = Pick<Transaction, "query">;
type ExtensionModule = Record<string, Extension | undefined>;

/** postgres errors become DatabaseError("pg_<sqlstate>"); set RR_DB_DEBUG=1 to print the postgres message locally */
function toDatabaseError(error: unknown): unknown {
  if (error instanceof DatabaseError) return error;
  const fields = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  if (process.env.RR_DB_DEBUG === "1") console.error("pglite:", fields.message);
  return new DatabaseError(typeof fields.code === "string" ? `pg_${fields.code}` : "pglite_error");
}

function runner(target: Queryable): SqlRunner {
  async function run(sql: string, params: Param[] = []) {
    const { text, values, types } = translateNamedParams(sql, params);
    try {
      return await target.query<Record<string, unknown>>(text, values, { paramTypes: types });
    } catch (error) {
      throw toDatabaseError(error);
    }
  }
  return {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      const result = await run(sql, params);
      // the Data API rejects duplicate column names in JSON mode; fail the same way here
      const names = result.fields.map((field) => field.name);
      if (new Set(names).size !== names.length) throw new DatabaseError("duplicate_column_name");
      return result.rows as T[];
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      return (await run(sql, params)).affectedRows ?? 0;
    },
  };
}

/** splits on semicolons that end a line, like scripts/apply-schema.ts; the sql files have no function bodies */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function sqlFile(name: string): string[] {
  return splitStatements(readFileSync(path.join(process.cwd(), "db", name), "utf8"));
}

async function applyStatements(tx: Transaction, statements: string[]): Promise<void> {
  for (const statement of statements) {
    try {
      await tx.exec(statement);
    } catch (error) {
      throw toDatabaseError(error);
    }
  }
}

/**
 * opens (or creates) a PGlite database in dataDir. a new database gets db/schema.sql, db/mvp.sql and the demo seed in
 * one transaction; an existing one only re-applies the idempotent db/mvp.sql. dataDir may be "memory://" in tests.
 */
export async function createPgliteDatabase(dataDir: string, options: { now?: Date } = {}): Promise<PgliteDatabase> {
  if (!dataDir.startsWith("memory://")) mkdirSync(dataDir, { recursive: true });
  // the extension packages export a named binding, or only a default one depending on how they are loaded
  const vectorModule = (await import("@electric-sql/pglite-pgvector")) as unknown as ExtensionModule;
  const postgisModule = (await import("@electric-sql/pglite-postgis")) as unknown as ExtensionModule;
  const vector = vectorModule.vector ?? vectorModule.default;
  const postgis = postgisModule.postgis ?? postgisModule.default;
  if (!vector || !postgis) throw new DatabaseError("pglite_extension_missing");
  const pg = await PGlite.create({ dataDir, parsers: PARSERS, extensions: { vector, postgis, pgcrypto } });

  try {
    const ready = await pg.query<{ ready: boolean }>("SELECT to_regclass('public.app_user') IS NOT NULL AS ready");
    const fresh = !ready.rows[0]?.ready;
    await pg.transaction(async (tx) => {
      if (fresh) await applyStatements(tx, sqlFile("schema.sql"));
      await applyStatements(tx, sqlFile("mvp.sql"));
      if (fresh) await seedDemo(runner(tx), options.now ?? new Date());
    });
  } catch (error) {
    // release the data directory so a retry can open it again
    await pg.close().catch(() => undefined);
    throw error;
  }

  return {
    ...runner(pg),
    async transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> {
      // pglite rolls back and rethrows the original error when work throws
      return pg.transaction((tx) => work(runner(tx)));
    },
    close: () => pg.close(),
  };
}

export function pgliteDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RR_PGLITE_DIR || path.join(process.cwd(), ".data", "pglite");
}

// one instance per process; globalThis survives Next dev hot reloads, which re-evaluate this module
const holder = globalThis as typeof globalThis & { __reliefReadyPglite?: Promise<PgliteDatabase> };

/** the app-wide local database; boots, migrates and seeds on first call */
export function getMvpDatabase(): Promise<Database> {
  if (!holder.__reliefReadyPglite) {
    holder.__reliefReadyPglite = createPgliteDatabase(pgliteDataDir()).catch((error: unknown) => {
      holder.__reliefReadyPglite = undefined;
      throw error;
    });
  }
  return holder.__reliefReadyPglite;
}
