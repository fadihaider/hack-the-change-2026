import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { callStructured, DEFAULT_MODEL, ModelCallError, NeedsReviewError, toModelCallError, type ModelCaller, type UsageRecord } from "../model";
import { geminiCaller, GeminiNotConfiguredError } from "../gemini";
import { fakeCaller } from "./fakeCaller";

const Out = z.object({ ok: z.boolean() });
const call = {
  step: "intake" as const,
  system: "sys",
  content: "hello",
  format: zodOutputFormat(Out),
  effort: "low" as const,
  maxTokens: 4000,
};

test("parses valid output and sends the agreed request shape", async () => {
  const usage: UsageRecord[] = [];
  const fake = fakeCaller({ text: '{"ok":true}' });
  const result = await callStructured(call, { caller: fake.caller, onUsage: (u) => void usage.push(u) });
  assert.deepEqual(result, { ok: true });
  const request = fake.requests[0];
  assert.equal(request.model, DEFAULT_MODEL);
  assert.equal(request.max_tokens, 4000);
  assert.equal(request.output_config?.effort, "low");
  assert.equal(request.output_config?.format?.type, "json_schema");
  assert.equal(request.system, "sys");
  assert.deepEqual(usage, [{ step: "intake", model: DEFAULT_MODEL, inputTokens: 120, outputTokens: 45, stopReason: "end_turn" }]);
});

for (const [name, reply, code] of [
  ["refusal", { text: '{"ok":true}', stopReason: "refusal" as const, category: "cyber" }, "stop_refusal"],
  ["max_tokens cut-off", { text: '{"ok":', stopReason: "max_tokens" as const }, "stop_max_tokens"],
  ["no text block", { stopReason: "end_turn" as const }, "no_text"],
  ["non-JSON text", { text: "Sure! Here you go" }, "invalid_output"],
  ["schema mismatch", { text: '{"ok":"yes"}' }, "invalid_output"],
] as const) {
  test(`${name} becomes NeedsReviewError(${code})`, async () => {
    const fake = fakeCaller(reply);
    await assert.rejects(callStructured(call, { caller: fake.caller }), (error: unknown) => {
      assert.ok(error instanceof NeedsReviewError);
      assert.equal(error.code, code);
      // never echo model output in the error
      assert.ok(!error.message.includes("Sure! Here you go"));
      return true;
    });
  });
}

test("usage is recorded even when the output is rejected", async () => {
  const usage: UsageRecord[] = [];
  const fake = fakeCaller({ text: "nope", stopReason: "refusal" });
  await assert.rejects(callStructured(call, { caller: fake.caller, onUsage: (u) => void usage.push(u) }));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].stopReason, "refusal");
});

test("refuses max_tokens above the non-streaming limit before calling", async () => {
  const fake = fakeCaller({ text: '{"ok":true}' });
  await assert.rejects(callStructured({ ...call, maxTokens: 30_000 }, { caller: fake.caller }));
  assert.equal(fake.requests.length, 0);
});

// regression tests for the review findings

test("a failed model call keeps only the HTTP status and error code", async () => {
  const body = { type: "error", error: { type: "invalid_request_error", message: "messages.0: SECRET Take warfarin 5 mg" } };
  const caller: ModelCaller = async () => {
    throw APIError.generate(400, body, undefined, new Headers({ "request-id": "req_SECRET" }));
  };
  await assert.rejects(callStructured(call, { caller }), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_request_error");
    assert.ok(!JSON.stringify({ ...error, message: error.message, cause: error.cause }).includes("SECRET"));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("a connection failure becomes ModelCallError with no status", async () => {
  const caller: ModelCaller = async () => {
    throw new APIConnectionError({ message: "connect ECONNREFUSED SECRET-host" });
  };
  await assert.rejects(callStructured(call, { caller }), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.status, null);
    assert.equal(error.code, "APIConnectionError");
    assert.ok(!error.message.includes("SECRET"));
    return true;
  });
});

// gemini adapter (RR_AI=gemini) through the same guards; the adapter itself is covered in gemini.test.ts

test("a Gemini not-configured error passes through unchanged", async () => {
  const original = new GeminiNotConfiguredError("GEMINI_API_KEY");
  assert.equal(toModelCallError(original), original);
  const caller: ModelCaller = async () => {
    throw original;
  };
  await assert.rejects(callStructured(call, { caller, model: "gemini-not-configured" }), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.status, null);
    assert.equal(error.code, "not_configured");
    return true;
  });
});

test("a Gemini answer is parsed with the step schema and its tokens are recorded", async () => {
  const usage: UsageRecord[] = [];
  const fetch = async () =>
    Response.json({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 4 },
    });
  const caller = geminiCaller({ apiKey: "k", fetch });
  const result = await callStructured(call, { caller, model: "gemini-test", onUsage: (u) => void usage.push(u) });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(usage, [{ step: "intake", model: "gemini-test", inputTokens: 9, outputTokens: 7, stopReason: "end_turn" }]);
});

test("a Gemini rate limit keeps only status 429 and the shared rate_limit_error code", async () => {
  const fetch = async () => new Response('{"error":{"message":"SECRET quota text"}}', { status: 429 });
  const caller = geminiCaller({ apiKey: "k", fetch });
  await assert.rejects(callStructured(call, { caller, model: "gemini-test" }), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limit_error");
    assert.ok(!error.message.includes("SECRET"));
    return true;
  });
});
