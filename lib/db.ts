// the database contract every store and route uses; adapters: PGlite (lib/mvp/database.ts, offline) and Supabase
// Postgres (lib/supabase/database.ts, cloud). SQL uses ":name" parameters, which each adapter turns into "$n"
// (lib/sql.ts), so the same statements run unchanged on both.
import "server-only";

/** one value of a named parameter; exactly one field is set */
export interface ParamValue {
  isNull?: boolean;
  stringValue?: string;
  longValue?: number;
  doubleValue?: number;
  booleanValue?: boolean;
  blobValue?: Uint8Array;
}

export interface Param {
  name: string;
  value: ParamValue;
}

/**
 * Parameter builders. uuids, timestamps and dates are sent as text and cast in SQL
 * (CAST(:id AS uuid), CAST(:at AS timestamptz)), so no session time zone or driver type mapping is involved.
 */
export const p = {
  text: (name: string, value: string | null): Param =>
    value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value } },
  uuid: (name: string, value: string): Param => ({ name, value: { stringValue: value } }),
  ts: (name: string, value: Date | null): Param =>
    value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value.toISOString() } },
  bool: (name: string, value: boolean): Param => ({ name, value: { booleanValue: value } }),
  int: (name: string, value: number): Param => ({ name, value: { longValue: Math.trunc(value) } }),
  bytes: (name: string, value: Uint8Array): Param => ({ name, value: { blobValue: value } }),
};

export interface SqlRunner {
  /** rows of a SELECT or a RETURNING clause; name every column, never SELECT * on tables with embeddings */
  query<T>(sql: string, params?: Param[]): Promise<T[]>;
  /** number of rows changed */
  execute(sql: string, params?: Param[]): Promise<number>;
}

export interface Database extends SqlRunner {
  /** runs work in one transaction; commits on success, rolls back on any error and rethrows it */
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** an error safe to log: a short code (pg_<sqlstate>, not_configured, ...), never SQL text, parameters or credentials */
export class DatabaseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`database error: ${code}`);
    this.name = "DatabaseError";
    this.code = code;
  }
}
