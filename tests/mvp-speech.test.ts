// mounted speech routes over the real runtime (PRD 6, AC3, AC13): PGlite in a temp dir, demo auth, a fake
// ElevenLabs behind globalThis.fetch. no network and no paid calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-speech-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;
delete process.env.RR_AUTH;
delete process.env.ELEVENLABS_API_KEY;
delete process.env.RR_VOICE_AGENT;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};
let database: import("../lib/db.ts").SqlRunner;
let p: typeof import("../lib/db.ts").p;
let speechMode: typeof import("../lib/speech/status.ts").speechMode;
const realFetch = globalThis.fetch;

// what the fake provider saw, and how it answers the next STT and DELETE calls
const provider = { calls: [] as Array<{ method: string; url: string; form?: FormData }>, deleteStatus: 204 };

function installFakeElevenLabs(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.elevenlabs.io/")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    provider.calls.push({ method, url, form: init?.body instanceof FormData ? init.body : undefined });
    if (method === "POST" && url === "https://api.elevenlabs.io/v1/speech-to-text") {
      return Response.json({ text: "Fictional note: Rosa likes tea at 3 pm.", transcription_id: "tr_fixture_1" });
    }
    if (method === "DELETE") return new Response(null, { status: provider.deleteStatus });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

before(async () => {
  for (const name of ["session", "stt", "tts", "voice-agent/session", "care/sources"]) {
    routes[name] = (await import(`../app/api/${name}/route.ts`)) as { GET?: Handler; POST?: Handler };
  }
  ({ speechMode } = await import("../lib/speech/status.ts"));
  ({ p } = await import("../lib/db.ts"));
  const { getMvpDatabase } = await import("../lib/mvp/database.ts");
  database = await getMvpDatabase();
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
  const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
  await (await holder.__reliefReadyPglite)?.close();
  rmSync(dir, { recursive: true, force: true });
});

function audioForm(bytes: BlobPart = "fictional audio bytes", type = "audio/webm;codecs=opus"): FormData {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type }), "private-original-name.webm");
  return form;
}

async function post(
  route: string,
  body: BodyInit,
  options: { origin?: string; url?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: any; headers: Headers }> {
  const handler = routes[route]?.POST;
  assert.ok(handler, `POST ${route} is exported`);
  const request = new Request(options.url ?? `${BASE}/api/${route}`, {
    method: "POST",
    headers: { Origin: options.origin ?? BASE, ...options.headers },
    body,
  });
  const response = await handler(request);
  const type = response.headers.get("Content-Type") ?? "";
  return { status: response.status, data: type.includes("json") ? await response.json() : null, headers: response.headers };
}

async function session(): Promise<any> {
  const handler = routes.session.GET;
  assert.ok(handler);
  const response = await handler(new Request(`${BASE}/api/session`));
  assert.equal(response.status, 200);
  return response.json();
}

async function voiceCalls(): Promise<number> {
  const rows = await database.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM llm_call WHERE step IN ('stt', 'tts')",
  );
  return Number(rows[0].n);
}

test("no key: session says off, stt and tts answer 503 speech_not_configured and spend no quota", async () => {
  installFakeElevenLabs();
  const before = await voiceCalls();
  assert.equal((await session()).providers.speech, "off");

  const stt = await post("stt", audioForm());
  assert.equal(stt.status, 503);
  assert.deepEqual(stt.data, { error: { code: "speech_not_configured" } });
  assert.equal(stt.headers.get("Cache-Control"), "no-store");

  const tts = await post("tts", JSON.stringify({ text: "Fictional" }), { headers: { "Content-Type": "application/json" } });
  assert.equal(tts.status, 503);
  assert.equal(tts.data.error.code, "speech_not_configured");

  assert.equal(provider.calls.length, 0);
  assert.equal(await voiceCalls(), before);
});

test("the hosted voice agent session is off unless RR_VOICE_AGENT=on", async () => {
  const off = await post("voice-agent/session", JSON.stringify({ consent: true, fictionalData: true }), {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(off.status, 404);
  assert.equal(off.data.error.code, "not_found");
});

test("a foreign origin is refused with 403 before the body, the key or the quota", async () => {
  process.env.ELEVENLABS_API_KEY = "fixture-key";
  const before = await voiceCalls();
  const foreign = await post("stt", audioForm(), { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.data, { error: { code: "invalid_origin" } });
  const missing = await post("stt", audioForm(), { origin: "" });
  assert.equal(missing.status, 403);
  assert.equal(provider.calls.length, 0);
  assert.equal(await voiceCalls(), before);
});

test("with a key: session says elevenlabs, and stt returns only the transcript after deleting the provider copy", async () => {
  process.env.ELEVENLABS_API_KEY = "fixture-key";
  installFakeElevenLabs();
  provider.calls.length = 0;
  provider.deleteStatus = 204;
  assert.equal((await session()).providers.speech, "elevenlabs");
  const before = await voiceCalls();

  // the browser is on 127.0.0.1 while rt.baseUrl is localhost: the matched origin is what the handler checks
  const ok = await post("stt", audioForm(), { origin: "http://127.0.0.1:3000" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { transcript: "Fictional note: Rosa likes tea at 3 pm." });

  assert.deepEqual(provider.calls.map((c) => `${c.method} ${c.url}`), [
    "POST https://api.elevenlabs.io/v1/speech-to-text",
    "DELETE https://api.elevenlabs.io/v1/speech-to-text/transcripts/tr_fixture_1",
  ]);
  // the original filename never leaves the server
  const sent = provider.calls[0].form?.get("file");
  assert.ok(sent instanceof File);
  assert.equal(sent.name, "recording.webm");

  assert.equal(await voiceCalls(), before + 1);
  const rows = await database.query<{ step: string; model: string }>(
    "SELECT step, model FROM llm_call WHERE step = 'stt' ORDER BY id DESC LIMIT 1",
  );
  assert.deepEqual(rows[0], { step: "stt", model: "scribe_v2" });

  // the reviewed transcript is saved through the existing care sources route as a voice source; no audio stored
  const saved = await post("care/sources", JSON.stringify({ kind: "voice", text: ok.data.transcript }), {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.source.kind, "voice");
  const source = await database.query<{ kind: string; no_file: boolean }>(
    "SELECT kind, s3_key IS NULL AS no_file FROM care_source WHERE id = CAST(:id AS uuid)",
    [p.uuid("id", saved.data.source.id)],
  );
  assert.deepEqual(source[0], { kind: "voice", no_file: true });
});

test("oversize audio is 413 before any quota or provider call", async () => {
  process.env.ELEVENLABS_API_KEY = "fixture-key";
  installFakeElevenLabs();
  provider.calls.length = 0;
  const before = await voiceCalls();
  // serialized first, so cancelling the request stream does not race undici's in-process FormData encoder
  const encoded = new Response(audioForm(new Uint8Array(10 * 1024 * 1024 + 1)));
  const big = await post("stt", new Uint8Array(await encoded.arrayBuffer()), {
    headers: { "Content-Type": encoded.headers.get("Content-Type") ?? "" },
  });
  assert.equal(big.status, 413);
  assert.deepEqual(big.data, { error: { code: "payload_too_large" } });
  assert.equal(provider.calls.length, 0);
  assert.equal(await voiceCalls(), before);
});

test("bad input is refused before the quota: not multipart, extra fields, not audio", async () => {
  process.env.ELEVENLABS_API_KEY = "fixture-key";
  installFakeElevenLabs();
  provider.calls.length = 0;
  const before = await voiceCalls();
  const notMultipart = await post("stt", JSON.stringify({ audio: "x" }), { headers: { "Content-Type": "application/json" } });
  assert.equal(notMultipart.status, 415);
  const extra = audioForm();
  extra.set("consent", "true");
  assert.equal((await post("stt", extra)).data.error.code, "invalid_input");
  assert.equal((await post("stt", audioForm("x", "video/webm"))).data.error.code, "invalid_audio");
  assert.equal(provider.calls.length, 0);
  assert.equal(await voiceCalls(), before);
});

test("a failed provider cleanup withholds the transcript but still counts the call", async () => {
  process.env.ELEVENLABS_API_KEY = "fixture-key";
  installFakeElevenLabs();
  provider.calls.length = 0;
  provider.deleteStatus = 500;
  const before = await voiceCalls();
  const failed = await post("stt", audioForm());
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.data, { error: { code: "speech_cleanup_failed" } });
  assert.equal(await voiceCalls(), before + 1);
  provider.deleteStatus = 204;
});

test("speechMode: key plus a runtime that may use paid providers", () => {
  const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
  const key = { ELEVENLABS_API_KEY: "k" };
  assert.equal(speechMode(env({})), "off");
  assert.equal(speechMode(env({ ELEVENLABS_API_KEY: "  " })), "off");
  assert.equal(speechMode(env(key)), "elevenlabs");
  assert.equal(speechMode(env({ ...key, APP_BASE_URL: "http://127.0.0.1:3000" })), "elevenlabs");
  // a demo identity on a deployed origin never spends credits
  assert.equal(speechMode(env({ ...key, APP_BASE_URL: "https://reliefready.example" })), "off");
  assert.equal(speechMode(env({ ...key, APP_BASE_URL: "https://reliefready.example", RR_AUTH: "google" })), "elevenlabs");
  // the owner's opt-in lets the demo identity speak on a deployed https origin, and only "on" counts
  assert.equal(speechMode(env({ ...key, APP_BASE_URL: "https://reliefready.example", RR_ALLOW_PAID_DEMO: "on" })), "elevenlabs");
  assert.equal(speechMode(env({ ...key, APP_BASE_URL: "https://reliefready.example", RR_ALLOW_PAID_DEMO: "1" })), "off");
  assert.equal(speechMode(env({ ...key, APP_BASE_URL: "http://192.168.1.5:3000", RR_ALLOW_PAID_DEMO: "on" })), "off");
  // plain http off loopback, and [::1], are refused by the speech runtime, so they are off too
  assert.equal(speechMode(env({ ...key, RR_AUTH: "google", APP_BASE_URL: "http://192.168.1.5:3000" })), "off");
  assert.equal(speechMode(env(key), { auth: "demo", baseUrl: "http://[::1]:3000" }), "off");
});
