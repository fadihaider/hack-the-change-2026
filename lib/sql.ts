// shared by both database adapters: ":name" parameter translation, sql-file splitting, migration file order
import "server-only";
import { DatabaseError, type Param } from "./db.ts";

// postgres type oids
export const OID = { TEXT: 25, INT8: 20, FLOAT8: 701, BOOL: 16, BYTEA: 17, UNKNOWN: 0 } as const;

const CAST_NAME: Record<number, string> = {
  [OID.TEXT]: "text",
  [OID.INT8]: "int8",
  [OID.FLOAT8]: "float8",
  [OID.BOOL]: "bool",
  [OID.BYTEA]: "bytea",
};

export interface TranslatedSql {
  text: string;
  values: unknown[];
  types: number[];
}

export interface TranslateOptions {
  /**
   * write each typed placeholder as "$n::text" (or ::int8, ::float8, ::bool, ::bytea). PGlite takes the parameter
   * types separately; node-postgres sends untyped parameters, so the cast keeps both adapters resolving SQL the same
   * way (for example ":x IS NULL" stays text instead of failing with "could not determine data type").
   */
  castPlaceholders?: boolean;
}

function paramValue(param: Param): { value: unknown; type: number } {
  const v = param.value ?? { isNull: true };
  if (v.isNull) return { value: null, type: OID.UNKNOWN };
  if (v.stringValue !== undefined) return { value: v.stringValue, type: OID.TEXT };
  if (v.longValue !== undefined) return { value: v.longValue, type: OID.INT8 };
  if (v.doubleValue !== undefined) return { value: v.doubleValue, type: OID.FLOAT8 };
  if (v.booleanValue !== undefined) return { value: v.booleanValue, type: OID.BOOL };
  if (v.blobValue !== undefined) return { value: v.blobValue, type: OID.BYTEA };
  throw new DatabaseError("unsupported_parameter");
}

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

/**
 * turns ":name" parameters into postgres "$n". skips '...' and E'...' literals, "..." identifiers, -- and
 * block comments, $tag$ quotes and the :: cast. a name used twice maps to the same $n. params are typed text, bigint,
 * float8, bool or bytea, so SQL casts uuids, timestamps and json explicitly and a missing CAST fails on both adapters.
 */
export function translateNamedParams(sql: string, params: Param[] = [], options: TranslateOptions = {}): TranslatedSql {
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
      const cast = options.castPlaceholders ? CAST_NAME[types[position - 1]] : undefined;
      out += cast ? `$${position}::${cast}` : `$${position}`;
      i = j;
    } else {
      copyUntil(i + 1);
    }
  }
  return { text: out, values, types };
}

/** splits on semicolons that end a line; the sql files have no function bodies or quoted semicolons */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** bytea arrives as "\x<hex>" text; both adapters hand it to the app as base64, which lib/store/accountStore.ts reads */
export function byteaToBase64(value: string): string {
  return Buffer.from(value.slice(2), "hex").toString("base64");
}

const raw = (value: string) => value;

/**
 * result parsers by type oid, shared by both adapters: dates, times and json stay strings and bytea becomes base64,
 * so stores parse them the same way everywhere. ints, floats, booleans and arrays stay native.
 */
export const RESULT_PARSERS: Record<number, (value: string) => unknown> = {
  1082: raw, // date
  1083: raw, // time
  1114: raw, // timestamp
  1184: raw, // timestamptz
  114: raw, // json
  3802: raw, // jsonb
  [OID.BYTEA]: byteaToBase64,
};
