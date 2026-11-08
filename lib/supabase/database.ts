// cloud Postgres (RR_DB=supabase): Supabase Postgres through node-postgres, behind the lib/db.ts Database interface.
// server-only: SUPABASE_DB_URL carries the database password and is read only here, never in a NEXT_PUBLIC_ variable.
// the app does not use the Supabase Data API or any Supabase API key; db/supabase-security.sql locks those roles out.
import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { DatabaseError, type Database, type Param, type SqlRunner } from "../db.ts";
import { loadResources } from "../mvp/resources.ts";
import { seedDemo } from "../mvp/seed.ts";
import { RESULT_PARSERS, splitStatements, translateNamedParams } from "../sql.ts";

export interface SupabaseDatabase extends Database {
  close(): Promise<void>;
}

export interface SupabaseConfig {
  connectionString: string;
  /** PEM of the Supabase CA (Database Settings, SSL Configuration); when set, TLS verifies the CA and the hostname */
  caCert: string | null;
  poolMax: number;
}

const DEFAULT_POOL_MAX = 5;

/**
 * SUPABASE_DB_URL (required), SUPABASE_DB_CA_CERT (optional: a PEM file path or the PEM text), SUPABASE_DB_POOL_MAX.
 * throws DatabaseError("not_configured") without a URL, which routes report as 503 not_configured.
 */
export function supabaseConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): SupabaseConfig {
  const connectionString = env.SUPABASE_DB_URL?.trim();
  if (!connectionString) throw new DatabaseError("not_configured");
  const ca = env.SUPABASE_DB_CA_CERT?.trim() || "";
  const caCert = !ca ? null : ca.includes("-----BEGIN") ? ca : readFileSync(path.resolve(ca), "utf8");
  const poolMax = Number.parseInt(env.SUPABASE_DB_POOL_MAX ?? "", 10);
  return { connectionString, caCert, poolMax: poolMax > 0 ? poolMax : DEFAULT_POOL_MAX };
}

/** sslmode in the URL would override the ssl option below, so it is dropped and TLS is always set here */
function withoutSslParams(connectionString: string): string {
  const url = new URL(connectionString);
  for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(key);
  return url.toString();
}

const textParser = (oid: number) => pg.types.getTypeParser(oid, "text") as (value: string) => unknown;

/** RESULT_PARSERS plus bigint as a number, as PGlite returns it (counts, bigserial ids) */
const PG_PARSERS: Record<number, (value: string) => unknown> = {
  ...RESULT_PARSERS,
  20: Number, // int8
  1016: (value) => (textParser(1016)(value) as (string | null)[]).map((item) => (item === null ? null : Number(item))),
};

const typeOverrides = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (format === "binary") return pg.types.getTypeParser(oid, "binary");
    return PG_PARSERS[oid] ?? textParser(oid);
  },
};

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** postgres errors become DatabaseError("pg_<sqlstate>"); connection failures "supabase_unavailable". RR_DB_DEBUG=1 logs */
function toDatabaseError(error: unknown): unknown {
  if (error instanceof DatabaseError) return error;
  const fields = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  if (process.env.RR_DB_DEBUG === "1") console.error("supabase:", fields.message);
  const code = typeof fields.code === "string" ? fields.code : "";
  return new DatabaseError(SQLSTATE.test(code) ? `pg_${code}` : "supabase_unavailable");
}

function toValue(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
}

type Queryable = Pick<pg.PoolClient, "query">;

function runner(target: Queryable): SqlRunner {
  async function run(sql: string, params: Param[] = []) {
    const { text, values } = translateNamedParams(sql, params, { castPlaceholders: true });
    try {
      return await target.query<Record<string, unknown>>({ text, values: values.map(toValue) });
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
      return (await run(sql, params)).rowCount ?? 0;
    },
  };
}

let warnedUnverified = false;

export function createSupabaseDatabase(config: SupabaseConfig): SupabaseDatabase {
  if (!config.caCert && !warnedUnverified) {
    warnedUnverified = true;
    console.warn("supabase: TLS is encrypted but the server certificate is not verified; set SUPABASE_DB_CA_CERT");
  }
  const pool = new pg.Pool({
    connectionString: withoutSslParams(config.connectionString),
    ssl: config.caCert ? { ca: config.caCert, rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: config.poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    application_name: "reliefready",
    types: typeOverrides,
  });
  // an idle client that loses its connection must not crash the server; the next query opens a new one
  pool.on("error", (error) => {
    if (process.env.RR_DB_DEBUG === "1") console.error("supabase pool:", error.message);
  });

  async function connect(): Promise<pg.PoolClient> {
    try {
      return await pool.connect();
    } catch (error) {
      throw toDatabaseError(error);
    }
  }

  return {
    ...runner({ query: ((...args: Parameters<pg.Pool["query"]>) => pool.query(...args)) as pg.PoolClient["query"] }),
    async transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> {
      const client = await connect();
      let broken: Error | undefined;
      try {
        try {
          await client.query("BEGIN");
        } catch (error) {
          throw toDatabaseError(error);
        }
        // work's own errors (WorkflowError, HealthTermsError, ...) pass through unchanged, as on PGlite
        const result = await work(runner(client));
        try {
          await client.query("COMMIT");
        } catch (error) {
          throw toDatabaseError(error);
        }
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          // the connection is unusable; release(error) discards it instead of returning it to the pool
          broken = rollbackError as Error;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

function sqlFile(name: string): string[] {
  return splitStatements(readFileSync(path.join(process.cwd(), "db", name), "utf8"));
}

/** lock the Supabase Data API roles out of every table, including tables db/mvp.sql adds later */
async function secureTables(tx: SqlRunner): Promise<void> {
  const roles = await tx.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('anon', 'authenticated')");
  if (roles[0]?.count === 2) {
    for (const statement of sqlFile("supabase-security.sql")) await tx.execute(statement);
  }
  const tables = await tx.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`);
  for (const { name } of tables) {
    await tx.execute(`ALTER TABLE public."${name.replaceAll('"', '""')}" ENABLE ROW LEVEL SECURITY`);
  }
}

export interface MigrateResult {
  /** true when this call created the schema (and seeded the demo persona, unless seed was false) */
  fresh: boolean;
}

/**
 * the Supabase twin of PGlite's boot: a fresh database gets the extensions, db/schema.sql and the demo seed; every
 * run re-applies the idempotent db/mvp.sql and the access lock-down, then fills any empty Calgary data table. one transaction behind an advisory lock, so
 * two server instances booting together cannot both create the schema.
 */
export async function migrateSupabase(
  database: Database,
  options: { now?: Date; seed?: boolean } = {},
): Promise<MigrateResult> {
  const result = await database.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('reliefready_migrate'))::text AS locked");
    const ready = await tx.query<{ ready: boolean }>("SELECT to_regclass('public.app_user') IS NOT NULL AS ready");
    const fresh = !ready[0]?.ready;
    if (fresh) {
      for (const statement of [...sqlFile("supabase-extensions.sql"), ...sqlFile("schema.sql")]) await tx.execute(statement);
    }
    for (const statement of sqlFile("mvp.sql")) await tx.execute(statement);
    await secureTables(tx);
    if (fresh && options.seed !== false) await seedDemo(tx, options.now ?? new Date());
    return { fresh };
  });
  // the Calgary snapshots (resources, communities, rule cards); each table is filled only while empty, so this is
  // cheap on every boot. PGlite loads them on the first Guide or Nearby call instead, through the same function
  if (options.seed !== false) await loadResources(database);
  return result;
}

// one pool per process; globalThis survives Next dev hot reloads, which re-evaluate this module
const holder = globalThis as typeof globalThis & { __reliefReadySupabase?: Promise<SupabaseDatabase> };

/** the app-wide cloud database; connects, migrates and (when fresh) seeds on first call */
export function getSupabaseDatabase(): Promise<Database> {
  if (!holder.__reliefReadySupabase) {
    holder.__reliefReadySupabase = (async () => {
      const database = createSupabaseDatabase(supabaseConfigFromEnv());
      try {
        await migrateSupabase(database);
      } catch (error) {
        await database.close().catch(() => undefined);
        throw error;
      }
      return database;
    })().catch((error: unknown) => {
      holder.__reliefReadySupabase = undefined;
      throw error;
    });
  }
  return holder.__reliefReadySupabase;
}
