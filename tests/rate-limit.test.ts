import assert from "node:assert/strict";
import test from "node:test";
import type { Param, SqlRunner } from "../lib/db.ts";
import { hit, hitAll, ipSubject, LIMITS, modelLimits, tooManyRequests } from "../lib/rateLimit.ts";

/** in-memory stand-in for the atomic upsert: one counter per key, retry_after fixed */
function counterDb() {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const sql: SqlRunner = {
    async query<T>(_sql: string, params: Param[] = []) {
      const key = params.find((p) => p.name === "key")?.value?.stringValue ?? "";
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return [{ count: next, retry_after: 120 }] as T[];
    },
    async execute() { return 0; },
  };
  return { sql, keys };
}

test("allows up to the limit, then denies with Retry-After, and keeps counting denied hits", async () => {
  const { sql } = counterDb();
  const rule = { name: "model", limit: 3, windowSeconds: 600 };
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await hit(sql, rule, "user-1"));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0, 0]);
  assert.equal(results[3].retryAfterSeconds, 120);
});

test("limits are per subject", async () => {
  const { sql } = counterDb();
  const rule = { name: "voice", limit: 1, windowSeconds: 600 };
  assert.equal((await hit(sql, rule, "a")).allowed, true);
  assert.equal((await hit(sql, rule, "b")).allowed, true);
  assert.equal((await hit(sql, rule, "a")).allowed, false);
});

test("model limits check the user first and do not spend the global fuse once the user is blocked", async () => {
  const { sql, keys } = counterDb();
  for (let i = 0; i < LIMITS.modelPerUser.limit; i += 1) assert.equal((await hitAll(sql, modelLimits("u1"))).allowed, true);
  const blocked = await hitAll(sql, modelLimits("u1"));
  assert.equal(blocked.allowed, false);
  assert.equal(keys.filter((k) => k === "model_global:all").length, LIMITS.modelPerUser.limit);
});

test("fails closed when the counter row is missing", async () => {
  const sql: SqlRunner = { async query() { return []; }, async execute() { return 0; } };
  assert.equal((await hit(sql, LIMITS.voicePerUser, "u")).allowed, false);
});

test("ipSubject hashes the first forwarded address and never returns the raw IP", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
  const subject = ipSubject(headers, "salt");
  assert.equal(subject.length, 32);
  assert.ok(!subject.includes("203.0.113.7"));
  assert.equal(subject, ipSubject(new Headers({ "x-forwarded-for": "203.0.113.7" }), "salt"));
  assert.notEqual(subject, ipSubject(headers, "other-salt"));
});

test("tooManyRequests returns 429 with the agreed error shape", async () => {
  const response = tooManyRequests({ allowed: false, limit: 30, remaining: 0, retryAfterSeconds: 42 });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  assert.deepEqual(await response.json(), { error: { code: "rate_limited" } });
});

test("reserveCall records an llm_call row only when allowed, and uses the voice limit for speech steps", async () => {
  const { sql, keys } = counterDb();
  const inserts: string[] = [];
  const tx: SqlRunner = {
    async query<T>(statement: string, params: Param[] = []) {
      if (statement.startsWith("INSERT INTO llm_call")) {
        inserts.push(String(params.find((p) => p.name === "step")?.value?.stringValue));
        return [{ id: String(inserts.length) }] as T[];
      }
      return sql.query<T>(statement, params);
    },
    async execute() { return 1; },
  };
  const database = { transaction: <T,>(work: (t: SqlRunner) => Promise<T>) => work(tx) };
  const { reserveCall } = await import("../lib/rateLimit.ts");
  const first = await reserveCall(database, { userId: "u1", step: "stt", model: "scribe_v2" });
  assert.equal(first.allowed, true);
  assert.equal(first.callId, "1");
  assert.ok(keys.includes("voice:u1"));
  for (let i = 1; i < LIMITS.voicePerUser.limit; i += 1) await reserveCall(database, { userId: "u1", step: "tts", model: "eleven_flash_v2_5" });
  const denied = await reserveCall(database, { userId: "u1", step: "stt", model: "scribe_v2" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.callId, null);
  assert.equal(inserts.length, LIMITS.voicePerUser.limit);
  const model = await reserveCall(database, { userId: "u1", step: "intake", model: "us.anthropic.claude-opus-5-5" });
  assert.equal(model.allowed, true);
  assert.ok(keys.includes("model:u1") && keys.includes("model_global:all"));
});
