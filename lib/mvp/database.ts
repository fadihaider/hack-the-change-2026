// local Postgres for the MVP (RR_DB=pglite): PGlite with PostGIS, pgvector and pgcrypto behind the lib/db.ts Database interface
import "server-only";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite, type Extension, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { DatabaseError, type Database, type Param, type SqlRunner } from "../db.ts";
import { RESULT_PARSERS, splitStatements, translateNamedParams } from "../sql.ts";
import { seedDemo } from "./seed.ts";

export interface PgliteDatabase extends Database {
  close(): Promise<void>;
}

export { splitStatements, translateNamedParams, type TranslatedSql } from "../sql.ts";

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
      // duplicate column names would silently overwrite each other in a row object; both adapters reject them
      const names = result.fields.map((field) => field.name);
      if (new Set(names).size !== names.length) throw new DatabaseError("duplicate_column_name");
      return result.rows as T[];
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      return (await run(sql, params)).affectedRows ?? 0;
    },
  };
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
  const pg = await PGlite.create({ dataDir, parsers: RESULT_PARSERS, extensions: { vector, postgis, pgcrypto } });

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
