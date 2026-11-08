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
  /** passport embedding batches and question embeddings per signed-in user (RR_EMBED=bedrock), apart from model steps */
  embedPerUser: { name: "embed", limit: 120, windowSeconds: 600 },
  /** texts sent per signed-in user (Twilio charges per message part); the demo outbox counts too */
  smsPerUser: { name: "sms", limit: 10, windowSeconds: 3600 },
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

const VOICE_STEPS = new Set(["stt", "tts"]);
const EMBED_STEPS = new Set(["embed_query", "embed_fact"]);

const RECORD_CALL = `INSERT INTO llm_call (user_id, step, model) VALUES (CAST(:user_id AS uuid), :step, :model) RETURNING id::text AS id`;

const RECORD_TOKENS = `UPDATE llm_call SET input_tokens = :input_tokens, output_tokens = :output_tokens
  WHERE id = CAST(:id AS bigint) AND user_id = CAST(:user_id AS uuid)`;

export interface Reservation {
  allowed: boolean;
  limit: LimitResult;
  /** llm_call row id when allowed; pass to recordTokens after a model call (speech leaves tokens null) */
  callId: string | null;
}

/**
 * Atomically counts one paid call against the user's limit and records it in llm_call, in one transaction.
 * Call before every model or speech request; failed provider calls still count. Voice steps (stt, tts) use the
 * voice limit; embedding steps (embed_query, embed_fact) use the embed limit; model steps use the per-user model limit
 * plus the app-wide daily fuse.
 */
export async function reserveCall(
  database: { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> },
  call: { userId: string; step: string; model: string },
): Promise<Reservation> {
  const checks = VOICE_STEPS.has(call.step)
    ? [{ rule: LIMITS.voicePerUser, subject: call.userId }]
    : EMBED_STEPS.has(call.step)
      ? [{ rule: LIMITS.embedPerUser, subject: call.userId }]
      : modelLimits(call.userId);
  return database.transaction(async (tx) => {
    const limit = await hitAll(tx, checks);
    if (!limit.allowed) {
      return { allowed: false, limit, callId: null };
    }
    const rows = await tx.query<{ id: string }>(RECORD_CALL, [
      p.uuid("user_id", call.userId),
      p.text("step", call.step),
      p.text("model", call.model),
    ]);
    return { allowed: true, limit, callId: rows[0]?.id ?? null };
  });
}

/** fills in token counts for a reserved model call (from response.usage); never stores prompt or output text */
export async function recordTokens(
  sql: SqlRunner,
  input: { callId: string; userId: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await sql.execute(RECORD_TOKENS, [
    p.int("input_tokens", input.inputTokens),
    p.int("output_tokens", input.outputTokens),
    p.text("id", input.callId),
    p.uuid("user_id", input.userId),
  ]);
}
