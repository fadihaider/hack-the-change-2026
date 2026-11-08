// Gemini adapter: request shape, error mapping, token accounting and the embedder, all with a fake fetch (no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  createGeminiEmbedder,
  GEMINI_API_BASE,
  geminiCaller,
  geminiConfigured,
  geminiDeps,
  geminiModelId,
  GeminiNotConfiguredError,
  toGeminiSchema,
  type FetchLike,
} from "../gemini";
import { callStructured, ModelCallError, NeedsReviewError, type UsageRecord } from "../model";

const KEY = "test-key-SECRET";
const MODEL = "gemini-test-model";
const ENV = { GEMINI_API_KEY: KEY, GEMINI_MODEL: MODEL, GEMINI_EMBED_MODEL: "gemini-embed-test" };

const Out = z.object({ ok: z.boolean(), note: z.string().nullable() });
const call = {
  step: "intake" as const,
  system: "sys prompt",
  content: "hello",
  format: zodOutputFormat(Out),
  effort: "low" as const,
  maxTokens: 4000,
};

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** records each request and answers with the next queued reply (a body object, a status, or a thrown error) */
function fakeFetch(...replies: (object | number | Error)[]): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") {
      // provider error bodies can echo the request; the adapter must never pass this text on
      return new Response(JSON.stringify({ error: { code: reply, message: "SECRET echo of Take warfarin 5 mg", status: "X" } }), { status: reply });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, sent };
}

function reply(text: string | undefined, finishReason = "STOP", usage: Record<string, number> = {}): object {
  return {
    candidates: [{ content: { role: "model", parts: text === undefined ? [] : [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, ...usage },
    responseId: "resp_1",
  };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

test("sends the key in the x-goog-api-key header, never in the URL", async () => {
  const fake = fakeFetch(reply('{"ok":true,"note":null}'));
  await callStructured(call, geminiDeps(undefined, ENV, fake.fetch));
  const [request] = fake.sent;
  assert.equal(request.url, `${GEMINI_API_BASE}/models/${MODEL}:generateContent`);
  assert.ok(!request.url.includes("key="));
  assert.ok(!request.url.includes(KEY));
  assert.equal(request.init.method, "POST");
  assert.equal(header(request.init, "x-goog-api-key"), KEY);
  assert.equal(header(request.init, "Content-Type"), "application/json");
  assert.ok(!JSON.stringify(request.body).includes(KEY));
});

test("builds a generateContent body with system instruction, user content and a JSON schema", async () => {
  const fake = fakeFetch(reply('{"ok":true,"note":null}'));
  await callStructured(call, geminiDeps(undefined, ENV, fake.fetch));
  const body = fake.sent[0].body as {
    systemInstruction: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: { maxOutputTokens: number; responseMimeType: string; responseJsonSchema: Record<string, unknown> };
  };
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "sys prompt" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
  assert.equal(body.generationConfig.maxOutputTokens, 4000);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  const schema = body.generationConfig.responseJsonSchema as { type: string; properties: Record<string, unknown>; required: string[] };
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["note", "ok"]);
  assert.deepEqual([...schema.required].sort(), ["note", "ok"]);
  // effort has no portable Gemini equivalent, so nothing thinking-related is sent
  assert.equal("thinkingConfig" in body.generationConfig, false);
});

test("a PDF document block becomes inlineData; other block types are refused before any request", async () => {
  const fake = fakeFetch(reply('{"ok":true,"note":null}'));
  const caller = geminiCaller({ apiKey: KEY, fetch: fake.fetch });
  await caller({
    model: MODEL,
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
          { type: "text", text: "Extracted text" },
        ],
      },
    ],
  });
  const contents = fake.sent[0].body.contents as { parts: unknown[] }[];
  assert.deepEqual(contents[0].parts, [{ inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } }, { text: "Extracted text" }]);

  await assert.rejects(
    caller({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }],
    }),
    (error: unknown) => error instanceof ModelCallError && error.code === "unsupported_content_block",
  );
  assert.equal(fake.sent.length, 1);
});

test("schema hint keeps property names but drops keywords Gemini does not document", () => {
  const schema = {
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: { type: { type: ["string", "null"], pattern: "^a" }, items: { type: "array", items: { enum: ["a", "b"] } } },
    required: ["type", "items"],
    additionalProperties: false,
  };
  assert.deepEqual(toGeminiSchema(schema), {
    type: "object",
    properties: { type: { type: ["string", "null"] }, items: { type: "array", items: { enum: ["a", "b"] } } },
    required: ["type", "items"],
    additionalProperties: false,
  });
});

test("valid JSON is parsed and still validated by the step's zod schema", async () => {
  const ok = fakeFetch(reply('{"ok":true,"note":"fine"}'));
  assert.deepEqual(await callStructured(call, geminiDeps(undefined, ENV, ok.fetch)), { ok: true, note: "fine" });

  for (const text of ['{"ok":"yes","note":null}', "Sure! Here you go", '{"ok":true}']) {
    const bad = fakeFetch(reply(text));
    await assert.rejects(callStructured(call, geminiDeps(undefined, ENV, bad.fetch)), (error: unknown) => {
      assert.ok(error instanceof NeedsReviewError);
      assert.equal(error.code, "invalid_output");
      assert.ok(!error.message.includes("Sure!"));
      return true;
    });
  }
});

test("thought parts are skipped and the answer parts are joined", async () => {
  const fake = fakeFetch({
    candidates: [
      { content: { parts: [{ text: "thinking SECRET", thought: true }, { text: '{"ok":true,' }, { text: '"note":null}' }] }, finishReason: "STOP" },
    ],
  });
  assert.deepEqual(await callStructured(call, geminiDeps(undefined, ENV, fake.fetch)), { ok: true, note: null });
});

for (const [name, body, code] of [
  ["SAFETY finish", reply('{"ok":true,"note":null}', "SAFETY"), "stop_refusal"],
  ["PROHIBITED_CONTENT finish", reply(undefined, "PROHIBITED_CONTENT"), "stop_refusal"],
  ["blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }, "stop_refusal"],
  ["MAX_TOKENS cut-off", reply('{"ok":', "MAX_TOKENS"), "stop_max_tokens"],
  ["unexpected tool call", reply(undefined, "UNEXPECTED_TOOL_CALL"), "stop_pause_turn"],
  ["empty answer", { candidates: [] }, "stop_pause_turn"],
  ["STOP with no text", reply(undefined), "no_text"],
] as const) {
  test(`${name} becomes NeedsReviewError(${code})`, async () => {
    const fake = fakeFetch(body);
    await assert.rejects(callStructured(call, geminiDeps(undefined, ENV, fake.fetch)), (error: unknown) => {
      assert.ok(error instanceof NeedsReviewError);
      assert.equal(error.code, code);
      return true;
    });
  });
}

for (const [status, code] of [
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [403, "permission_error"],
  [404, "not_found_error"],
  [429, "rate_limit_error"],
  [500, "api_error"],
  [503, "overloaded_error"],
  [502, "api_error"],
] as const) {
  test(`HTTP ${status} becomes ModelCallError(${status}, ${code}) with no provider text`, async () => {
    const fake = fakeFetch(status);
    await assert.rejects(callStructured(call, geminiDeps(undefined, ENV, fake.fetch)), (error: unknown) => {
      assert.ok(error instanceof ModelCallError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.ok(!JSON.stringify({ ...error, message: error.message }).includes("SECRET"));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test("network failures and timeouts become connection errors with no status", async () => {
  const offline = fakeFetch(new TypeError("fetch failed SECRET-host"));
  await assert.rejects(callStructured(call, geminiDeps(undefined, ENV, offline.fetch)), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.status, null);
    assert.equal(error.code, "APIConnectionError");
    assert.ok(!error.message.includes("SECRET"));
    return true;
  });
  const slow = fakeFetch(new DOMException("timed out", "TimeoutError"));
  await assert.rejects(
    callStructured(call, geminiDeps(undefined, ENV, slow.fetch)),
    (error: unknown) => error instanceof ModelCallError && error.code === "APIConnectionTimeoutError",
  );
});

test("a 200 that is not a Gemini envelope is a model call error, not an answer", async () => {
  const fake = fakeFetch({ candidates: "nope" });
  await assert.rejects(
    callStructured(call, geminiDeps(undefined, ENV, fake.fetch)),
    (error: unknown) => error instanceof ModelCallError && error.code === "invalid_response",
  );
});

test("token accounting counts prompt plus tool-use input and answer plus thinking output", async () => {
  const usage: UsageRecord[] = [];
  const fake = fakeFetch(reply('{"ok":true,"note":null}', "STOP", { toolUsePromptTokenCount: 5, thoughtsTokenCount: 30 }));
  await callStructured(call, geminiDeps((record) => void usage.push(record), ENV, fake.fetch));
  assert.deepEqual(usage, [{ step: "intake", model: MODEL, inputTokens: 105, outputTokens: 50, stopReason: "end_turn" }]);
});

test("usage is recorded even when Gemini refuses", async () => {
  const usage: UsageRecord[] = [];
  const fake = fakeFetch(reply(undefined, "SAFETY"));
  await assert.rejects(callStructured(call, geminiDeps((record) => void usage.push(record), ENV, fake.fetch)));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].stopReason, "refusal");
});

test("missing key or model fails with not_configured and sends nothing; never falls back to demo", async () => {
  for (const env of [{ GEMINI_MODEL: MODEL }, { GEMINI_API_KEY: KEY }, { GEMINI_API_KEY: KEY, GEMINI_MODEL: "../evil?x=" }, {}]) {
    const fake = fakeFetch(reply('{"ok":true,"note":null}'));
    const deps = geminiDeps(undefined, env, fake.fetch);
    assert.notEqual(deps.model, "demo");
    assert.equal(geminiConfigured(env), false);
    await assert.rejects(callStructured(call, deps), (error: unknown) => {
      assert.ok(error instanceof GeminiNotConfiguredError);
      assert.ok(error instanceof ModelCallError);
      assert.equal(error.code, "not_configured");
      return true;
    });
    assert.equal(fake.sent.length, 0);
  }
  assert.equal(geminiConfigured(ENV), true);
});

test("model ids must be plain ids before they go into the URL path", () => {
  assert.equal(geminiModelId("models/gemini-x-1.5"), "gemini-x-1.5");
  assert.equal(geminiModelId(" gemini-x "), "gemini-x");
  for (const bad of [undefined, "", "../x", "a/b", "x:generateContent?key=1", "a b"]) {
    assert.equal(geminiModelId(bad), null);
  }
});

function vector(seed: number, dims = 1024): number[] {
  return Array.from({ length: dims }, (_, index) => ((index % 7) + seed) / 10);
}

test("embedder posts batchEmbedContents at 1,024 dimensions with the key in a header", async () => {
  const fake = fakeFetch({ embeddings: [{ values: vector(1) }, { values: vector(2) }] });
  const embedder = createGeminiEmbedder({ env: ENV, fetch: fake.fetch });
  assert.equal(embedder.model, "gemini-embed-test");
  assert.equal(embedder.dims, 1024);
  const vectors = await embedder.embed(["Insulin at 8 am", "Key under the mat"]);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, 1024);
  // unit length after normalization
  assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 1e-9);
  const [request] = fake.sent;
  assert.equal(request.url, `${GEMINI_API_BASE}/models/gemini-embed-test:batchEmbedContents`);
  assert.ok(!request.url.includes(KEY));
  assert.equal(header(request.init, "x-goog-api-key"), KEY);
  assert.deepEqual(request.body, {
    requests: [
      { model: "models/gemini-embed-test", content: { parts: [{ text: "Insulin at 8 am" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 1024 },
      { model: "models/gemini-embed-test", content: { parts: [{ text: "Key under the mat" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 1024 },
    ],
  });
});

test("embedder batches by 100, uses the query task type, and rejects the wrong width", async () => {
  const many = Array.from({ length: 150 }, (_, index) => `fact ${index}`);
  const sent: number[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { requests: { taskType: string }[] };
    sent.push(body.requests.length);
    assert.ok(body.requests.every((entry) => entry.taskType === "RETRIEVAL_QUERY"));
    return Response.json({ embeddings: body.requests.map((_, index) => ({ values: vector(index) })) });
  };
  const vectors = await createGeminiEmbedder({ env: ENV, fetch }).embed(many, "query");
  assert.deepEqual(sent, [100, 50]);
  assert.equal(vectors.length, 150);

  const narrow = fakeFetch({ embeddings: [{ values: vector(1, 768) }] });
  await assert.rejects(
    createGeminiEmbedder({ env: ENV, fetch: narrow.fetch }).embed(["x"]),
    (error: unknown) => error instanceof ModelCallError && error.code === "invalid_embedding",
  );
  const short = fakeFetch({ embeddings: [] });
  await assert.rejects(
    createGeminiEmbedder({ env: ENV, fetch: short.fetch }).embed(["x"]),
    (error: unknown) => error instanceof ModelCallError && error.code === "invalid_response",
  );
  const limited = fakeFetch(429);
  await assert.rejects(
    createGeminiEmbedder({ env: ENV, fetch: limited.fetch }).embed(["x"]),
    (error: unknown) => error instanceof ModelCallError && error.status === 429 && error.code === "rate_limit_error",
  );
});

test("embedder needs GEMINI_API_KEY and GEMINI_EMBED_MODEL", () => {
  assert.throws(() => createGeminiEmbedder({ env: { GEMINI_EMBED_MODEL: "e" } }), GeminiNotConfiguredError);
  assert.throws(() => createGeminiEmbedder({ env: { GEMINI_API_KEY: KEY, GEMINI_MODEL: MODEL } }), GeminiNotConfiguredError);
});

// provider.ts is server-only, so its wiring is checked in a child process with the react-server condition
test("RR_AI=gemini selects the Gemini caller in provider.ts", () => {
  const provider = fileURLToPath(new URL("../provider.ts", import.meta.url));
  // the child's global fetch is a stub, so even the configured case never reaches the network
  const script = `
    let url = null;
    globalThis.fetch = async (target) => {
      url = target;
      return Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
    };
    const { aiMode, getModelDeps } = await import(${JSON.stringify(provider)});
    const deps = getModelDeps();
    let code = "ok";
    try { await deps.caller({ model: deps.model, max_tokens: 1, messages: [] }); } catch (error) { code = error.code; }
    console.log(JSON.stringify({ mode: aiMode(), model: deps.model, code, url }));
  `;
  const run = (env: Record<string, string>) => {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", RR_AI: "gemini", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  };
  const generate = `${GEMINI_API_BASE}/models/${MODEL}:generateContent`;
  assert.deepEqual(run({ GEMINI_API_KEY: KEY, GEMINI_MODEL: MODEL }), { mode: "gemini", model: MODEL, code: "ok", url: generate });
  // no key or no model: the step fails as not configured instead of reaching the network or the demo rules
  const unconfigured = { mode: "gemini", model: "gemini-not-configured", code: "not_configured", url: null };
  assert.deepEqual(run({ GEMINI_MODEL: MODEL }), unconfigured);
  assert.deepEqual(run({ GEMINI_API_KEY: KEY }), unconfigured);
});
