import assert from "node:assert/strict";
import test from "node:test";
import { elevenLabsClient, MAX_AUDIO_BYTES } from "../lib/elevenlabs.ts";
import { createSpeechHttpHandlers } from "../lib/speech/http.ts";
import type { SpeechHttpDependencies } from "../lib/speech/http.ts";

const baseUrl = "https://reliefready.example";
const audio = () => new Blob(["fictional audio"], { type: "audio/webm;codecs=opus" });
function multipart(file: Blob | string = audio()): FormData {
  const form = new FormData();
  if (typeof file === "string") form.set("file", file);
  else form.set("file", file, "private-original-name.webm");
  return form;
}
function request(kind: "stt" | "tts", body?: BodyInit, headers?: HeadersInit): Request {
  return new Request(`${baseUrl}/api/${kind}`, {
    method: "POST", headers: { Origin: baseUrl, ...headers },
    body: body ?? (kind === "stt" ? multipart() : JSON.stringify({ text: "Fictional timeline" })),
  });
}
function ttsRequest(value: unknown = { text: "Fictional timeline" }): Request {
  return request("tts", JSON.stringify(value), { "Content-Type": "application/json" });
}
function fixture(replies: Array<Response | Error> = [], overrides: Partial<SpeechHttpDependencies> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reservations: Array<Parameters<SpeechHttpDependencies["reserveCall"]>[0]> = [];
  const events: string[] = [];
  const handlers = createSpeechHttpHandlers({
    baseUrl,
    authenticate: async () => { events.push("authenticate"); return { userId: "owner-one" }; },
    reserveCall: async (input) => {
      events.push("reserve"); reservations.push(input);
      return { allowed: true, limit: { retryAfterSeconds: 0 } };
    },
    speech: elevenLabsClient({
      apiKey: "fixture-key", voiceId: "fixture-voice",
      fetch: (async (url, init) => {
        events.push("provider"); calls.push({ url: String(url), init });
        const next = replies.shift();
        if (!next) throw new Error("unexpected provider call");
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
    }),
    ...overrides,
  });
  return { handlers, calls, reservations, events };
}
async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: { code } });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
}
const mp3 = () => new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });

test("STT authenticates, reserves metadata, deletes the transcript, and returns transcript only", async () => {
  const f = fixture([Response.json({ text: "Fictional note", transcription_id: "fixture-id" }), new Response(null, { status: 204 })]);
  const response = await f.handlers.stt(request("stt"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { transcript: "Fictional note" });
  assert.deepEqual(f.events, ["authenticate", "reserve", "provider", "provider"]);
  assert.deepEqual(f.reservations, [{ userId: "owner-one", step: "stt", model: "scribe_v2" }]);
  const file = (f.calls[0].init?.body as FormData).get("file") as File;
  assert.equal(file.name, "recording.webm");
  assert.equal(f.calls[1].init?.method, "DELETE");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("missing provider transcript id does not invent cleanup in the HTTP response", async () => {
  const f = fixture([Response.json({ text: "Fictional note" })]);
  assert.deepEqual(await (await f.handlers.stt(request("stt"))).json(), { transcript: "Fictional note" });
  assert.equal(f.calls.length, 1);
});

test("cleanup failure never releases the transcript and keeps the reserved attempt", async () => {
  const f = fixture([Response.json({ text: "fixture-private-text", transcription_id: "fixture-id" }), new Response("fixture-key", { status: 500 })]);
  await error(await f.handlers.stt(request("stt")), 502, "speech_cleanup_failed");
  assert.equal(f.reservations.length, 1);
  assert.equal(f.calls.length, 2);
});

test("TTS preserves exact text and returns private MP3 bytes with no JSON wrapper", async () => {
  const f = fixture([mp3()]);
  const text = `  ${"🦉".repeat(4000)}  `;
  // Exactly 4000 Unicode characters are permitted; surrounding spaces count.
  const response = await f.handlers.tts(ttsRequest({ text: text.slice(2, -2) }));
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([73, 68, 51]));
  assert.equal(response.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(JSON.parse(f.calls[0].init?.body as string), { text: text.slice(2, -2), model_id: "eleven_flash_v2_5" });
  assert.deepEqual(f.reservations, [{ userId: "owner-one", step: "tts", model: "eleven_flash_v2_5" }]);
});

test("a missing owner session rejects both routes before body reads, quota or provider work", async () => {
  const f = fixture([], { authenticate: async () => null });
  for (const kind of ["stt", "tts"] as const) {
    const req = request(kind);
    await error(await f.handlers[kind](req), 401, "unauthenticated");
    assert.equal(req.bodyUsed, false);
  }
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("missing or foreign Origins fail before reading audio/text or reserving quota", async () => {
  const f = fixture();
  for (const kind of ["stt", "tts"] as const) {
    for (const origin of [null, "https://elsewhere.example", "null"]) {
      const req = request(kind);
      if (origin === null) req.headers.delete("Origin");
      else req.headers.set("Origin", origin);
      await error(await f.handlers[kind](req), 403, "invalid_origin");
      assert.equal(req.bodyUsed, false);
    }
  }
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("both handlers are POST only and advertise their allowed method", async () => {
  const f = fixture();
  for (const kind of ["stt", "tts"] as const) {
    const response = await f.handlers[kind](new Request(`${baseUrl}/api/${kind}`));
    assert.equal(response.headers.get("Allow"), "POST");
    await error(response, 405, "method_not_allowed");
  }
  assert.deepEqual(f.events, []);
});

test("speech content types are strict before quota reservation", async () => {
  const f = fixture();
  await error(await f.handlers.stt(request("stt", "audio", { "Content-Type": "audio/webm" })), 415, "unsupported_media_type");
  await error(await f.handlers.tts(request("tts", "text", { "Content-Type": "text/plain" })), 415, "unsupported_media_type");
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("multipart rejects duplicate/unknown fields, text files, empty audio, and unsupported audio", async () => {
  const duplicate = multipart(); duplicate.append("file", audio());
  const extra = multipart(); extra.set("userId", "another-owner");
  const cases: Array<[FormData, string]> = [
    [duplicate, "invalid_input"], [extra, "invalid_input"], [new FormData(), "invalid_input"],
    [multipart("not a file"), "invalid_audio"],
    [multipart(new Blob([], { type: "audio/webm" })), "invalid_audio"],
    [multipart(new Blob(["fixture"], { type: "text/plain" })), "invalid_audio"],
  ];
  const f = fixture();
  for (const [body, code] of cases) await error(await f.handlers.stt(request("stt", body)), 400, code);
  await error(await f.handlers.stt(request("stt", "broken", { "Content-Type": "multipart/form-data" })), 400, "invalid_input");
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("invalid or excessive Content-Length is rejected before parsing or quota", async () => {
  const f = fixture();
  for (const kind of ["stt", "tts"] as const) {
    for (const [length, status, code] of [["-1", 400, "invalid_input"], ["not-length", 400, "invalid_input"], [String(MAX_AUDIO_BYTES + 1), 413, "payload_too_large"]] as const) {
      const req = kind === "stt" ? request(kind) : ttsRequest();
      req.headers.set("Content-Length", length);
      await error(await f.handlers[kind](req), status, code);
      assert.equal(req.bodyUsed, false);
    }
  }
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("actual streamed body limits hold with missing or false Content-Length and cancel the stream", async () => {
  const f = fixture();
  for (const kind of ["stt", "tts"] as const) {
    for (const declared of [null, "1"]) {
      let cancelled = false;
      const limit = kind === "stt" ? MAX_AUDIO_BYTES : 64 * 1024;
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
        cancel() { cancelled = true; },
      });
      const headers = new Headers({ Origin: baseUrl, "Content-Type": kind === "stt" ? "multipart/form-data; boundary=fixture" : "application/json" });
      if (declared !== null) headers.set("Content-Length", declared);
      const req = new Request(`${baseUrl}/api/${kind}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
      await error(await f.handlers[kind](req), 413, "payload_too_large");
      assert.equal(cancelled, true);
    }
  }
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("TTS accepts only nonempty bounded text without client identity/model/voice overrides", async () => {
  const f = fixture();
  for (const value of [null, [], "text", {}, { text: " " }, { text: 123 }, { text: "🦉".repeat(4001) },
    { text: "fixture", userId: "other" }, { text: "fixture", voiceId: "other" }, { text: "fixture", model: "other" }]) {
    await error(await f.handlers.tts(ttsRequest(value)), 400, "invalid_input");
  }
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("malformed JSON, invalid UTF-8, and broken streams fail safely before any spend", async () => {
  const f = fixture();
  for (const body of ["{", new Uint8Array([0xff])]) {
    await error(await f.handlers.tts(request("tts", body, { "Content-Type": "application/json" })), 400, "invalid_input");
  }
  const body = new ReadableStream({ start(controller) { controller.error(new Error("fixture-private-payload")); } });
  const req = new Request(`${baseUrl}/api/stt`, {
    method: "POST", headers: { Origin: baseUrl, "Content-Type": "multipart/form-data; boundary=fixture" }, body, duplex: "half",
  } as RequestInit);
  await error(await f.handlers.stt(req), 400, "invalid_input");
  assert.equal(f.reservations.length + f.calls.length, 0);
});

test("quota refusal yields 429 with Retry-After and never calls the provider", async () => {
  const f = fixture([], { reserveCall: async () => ({ allowed: false, limit: { retryAfterSeconds: 123 } }) });
  for (const kind of ["stt", "tts"] as const) {
    const response = await f.handlers[kind](kind === "stt" ? request(kind) : ttsRequest());
    assert.equal(response.headers.get("Retry-After"), "123");
    await error(response, 429, "rate_limited");
  }
  assert.equal(f.calls.length, 0);
});

test("auth or quota database failure returns a fixed error and never calls ElevenLabs", async () => {
  for (const key of ["authenticate", "reserveCall"] as const) {
    const f = fixture([], { [key]: async () => { throw new Error("fixture-key/private-record"); } });
    for (const kind of ["stt", "tts"] as const) {
      await error(await f.handlers[kind](kind === "stt" ? request(kind) : ttsRequest()), 503, "temporarily_unavailable");
    }
    assert.equal(f.calls.length, 0);
  }
});

test("provider failures are sanitized, counted, and not retried by either HTTP handler", async () => {
  for (const kind of ["stt", "tts"] as const) {
    for (const [status, httpStatus, code] of [[401, 503, "speech_access_denied"], [429, 429, "speech_rate_limited"], [500, 502, "speech_provider_failed"]] as const) {
      const f = fixture([new Response("fixture-key/private-content", { status })]);
      await error(await f.handlers[kind](kind === "stt" ? request(kind) : ttsRequest()), httpStatus, code);
      assert.equal(f.calls.length, 1);
      assert.equal(f.reservations.length, 1);
    }
    const uncertain = fixture([new Error("fixture-private-provider-payload")]);
    await error(await uncertain.handlers[kind](kind === "stt" ? request(kind) : ttsRequest()), 502, "speech_provider_failed");
    assert.equal(uncertain.calls.length, 1);
    assert.equal(uncertain.reservations.length, 1);
  }
});

test("a provider JSON error cannot become a successful MP3 response", async () => {
  const f = fixture([Response.json({ error: "fixture-private-error" })]);
  await error(await f.handlers.tts(ttsRequest()), 502, "invalid_speech_response");
});

test("TTS supports escaped Unicode JSON and preserves surrounding text whitespace", async () => {
  const f = fixture([mp3(), mp3()]);
  const body = `{"text":"${"\\ud83e\\udd89".repeat(4000)}"}`;
  assert.equal((await f.handlers.tts(request("tts", body, { "Content-Type": "application/json" }))).status, 200);
  const text = "  Fictional timeline.\n";
  assert.equal((await f.handlers.tts(ttsRequest({ text }))).status, 200);
  assert.equal(JSON.parse(f.calls[0].init?.body as string).text, "🦉".repeat(4000));
  assert.equal(JSON.parse(f.calls[1].init?.body as string).text, text);
});

test("an invalid reservation response fails closed before calling the provider", async () => {
  const f = fixture([], {
    reserveCall: async () => ({ allowed: false, limit: { retryAfterSeconds: Number.NaN } }),
  });
  await error(await f.handlers.tts(ttsRequest()), 503, "temporarily_unavailable");
  assert.equal(f.calls.length, 0);
});

test("simultaneous requests honor the atomic quota decision without a local fallback", async () => {
  let available = 1;
  const f = fixture([mp3()], {
    reserveCall: async () => ({ allowed: available-- > 0, limit: { retryAfterSeconds: 600 } }),
  });
  const responses = await Promise.all([f.handlers.tts(ttsRequest()), f.handlers.tts(ttsRequest())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
  assert.equal(f.calls.length, 1);
  // This is a fictional reservation seam, not a database isolation check.
});
