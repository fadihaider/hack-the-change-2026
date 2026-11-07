// fixed-window rate limits stored in Postgres, so every serverless instance shares one count (IMPLEMENTATION section 12)
import "server-only";
import { createHash } from "node:crypto";
import { p, type SqlRunner } from "./db.ts";

export interface LimitRule {
  /** short name used in keys and logs */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** agreed limits; one place to tune them */
export const LIMITS = {
  /** model steps A1 to A6 per signed-in user (section 12: about 30 calls per 10 minutes) */
  modelPerUser: { name: "model", limit: 30, windowSeconds: 600 },
  /** speech-to-text and text-to-speech per signed-in user */
  voicePerUser: { name: "voice", limit: 30, windowSeconds: 600 },
  /** response-link confirmations and previews per client IP (links are bearer tokens, so slow down guessing) */
  responsePerIp: { name: "response", limit: 30, windowSeconds: 600 },
  /** spend fuse: all model calls in the app per day; keeps Bedrock spend inside the USD 100 plan */
  modelGlobalDaily: { name: "model_global", limit: 2000, windowSeconds: 86_400 },
} as const satisfies Record<string, LimitRule>;

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** seconds until the current window ends; send as Retry-After on HTTP 429 */
  retryAfterSeconds: number;
}

// one atomic statement: concurrent requests on any instance serialize on the (key, window) row
const HIT = `INSERT INTO rate_limit (key, window_start, count)
  VALUES (:key, to_timestamp(floor(extract(epoch FROM now()) / :window_seconds) * :window_seconds), 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit.count + 1
  RETURNING count, ceil(extract(epoch FROM (window_start + make_interval(secs => :window_seconds) - now())))::int AS retry_after`;

/**
 * Counts one hit against `rule` for `subject` and says whether it is allowed.
 * Every call counts, including denied ones, so a client that keeps retrying stays blocked until the window ends.
 */
export async function hit(sql: SqlRunner, rule: LimitRule, subject: string): Promise<LimitResult> {
  const rows = await sql.query<{ count: number; retry_after: number }>(HIT, [
    p.text("key", `${rule.name}:${subject}`),
    p.int("window_seconds", rule.windowSeconds),
  ]);
  const row = rows[0];
  if (!row) {
    // fail closed: no row means the counter could not be read
    return { allowed: false, limit: rule.limit, remaining: 0, retryAfterSeconds: rule.windowSeconds };
  }
  return {
    allowed: row.count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - row.count),
    retryAfterSeconds: Math.max(1, row.retry_after),
  };
}

/** checks several rules in order and stops at the first denial, so a denied user does not use up the global budget */
export async function hitAll(sql: SqlRunner, checks: { rule: LimitRule; subject: string }[]): Promise<LimitResult> {
  let last: LimitResult = { allowed: true, limit: 0, remaining: 0, retryAfterSeconds: 0 };
  for (const check of checks) {
    last = await hit(sql, check.rule, check.subject);
    if (!last.allowed) {
      return last;
    }
  }
  return last;
}

/** model routes: per-user limit, then the app-wide daily fuse */
export function modelLimits(userId: string): { rule: LimitRule; subject: string }[] {
  return [
    { rule: LIMITS.modelPerUser, subject: userId },
    { rule: LIMITS.modelGlobalDaily, subject: "all" },
  ];
}

/**
 * Stable, non-reversible subject for a client IP, so raw addresses never reach the database.
 * Uses the first x-forwarded-for entry (set by the hosting proxy), else x-real-ip, else "unknown".
 */
export function ipSubject(headers: Headers, salt: string): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/** HTTP 429 with Retry-After and the agreed error shape ({error:{code}}, docs/INTEGRATIONS.md) */
export function tooManyRequests(result: LimitResult): Response {
  return Response.json(
    { error: { code: "rate_limited" } },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": "0",
      },
    },
  );
}

/** stale windows are harmless but grow the table; call from the expiry sweep or a daily job */
export const PRUNE_RATE_LIMITS = `DELETE FROM rate_limit WHERE window_start < now() - interval '2 days'`;
