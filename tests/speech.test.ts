import assert from "node:assert/strict";
import test from "node:test";
import { elevenLabsClient, MAX_AUDIO_BYTES, MAX_SPEECH_CHARACTERS } from "../lib/elevenlabs.ts";

function fixture(replies: Array<Response | Error>, options: { apiKey?: string; voiceId?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = elevenLabsClient({
    apiKey: options.apiKey ?? "fixture-api-key", voiceId: options.voiceId ?? "fixture-voice",
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      const result = replies.shift();
      if (!result) throw new Error("unexpected provider request");
      if (result instanceof Error) throw result;
      return result;
    }) as typeof fetch,
  });
  return { client, calls };
}

const audio = () => new Blob(["fixture-audio"], { type: "audio/webm;codecs=opus" });

test("Scribe uses multipart audio, keeps the API key server-side, and deletes by transcript id", async () => {
  const f = fixture([Response.json({ text: "Fictional voice note", transcription_id: "transcript/one" }), new Response(null, { status: 204 })]);
  assert.deepEqual(await f.client.transcribe(audio()), { transcript: "Fictional voice note", cleanup: "deleted" });
  const form = f.calls[0].init?.body as FormData;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("language_code"), "en");
  assert.equal(form.get("timestamps_granularity"), "word");
  assert.equal((form.get("file") as File).name, "recording.webm");
  assert.equal(new Headers(f.calls[0].init?.headers).get("xi-api-key"), "fixture-api-key");
  assert.equal(new Headers(f.calls[0].init?.headers).has("Content-Type"), false);
  assert.equal(f.calls[1].url, "https://api.elevenlabs.io/v1/speech-to-text/transcripts/transcript%2Fone");
  assert.equal(f.calls[1].init?.method, "DELETE");
});

test("missing transcript id is reported honestly without fabricating a deletion", async () => {
  const f = fixture([Response.json({ text: "Fictional voice note" })]);
  assert.deepEqual(await f.client.transcribe(audio()), { transcript: "Fictional voice note", cleanup: "id_not_returned" });
  assert.equal(f.calls.length, 1);
});

test("cleanup failure is surfaced without releasing the transcript as a success", async () => {
  const f = fixture([Response.json({ text: "fixture-private-text", transcription_id: "one" }), new Response("fixture-key", { status: 500 })]);
  await assert.rejects(f.client.transcribe(audio()), { message: "speech_cleanup_failed" });
  assert.equal(f.calls.length, 2);
});

test("malformed transcript text still triggers cleanup when an id was returned", async () => {
  const f = fixture([Response.json({ text: 123, transcription_id: "one" }), new Response(null, { status: 204 })]);
  await assert.rejects(f.client.transcribe(audio()), { message: "invalid_speech_response" });
  assert.equal(f.calls[1].init?.method, "DELETE");
});

test("empty, unsupported and oversized audio are rejected before spending", async () => {
  const f = fixture([]);
  await assert.rejects(f.client.transcribe(new Blob([], { type: "audio/webm" })), { code: "invalid_audio" });
  await assert.rejects(f.client.transcribe(new Blob(["fixture"], { type: "text/plain" })), { code: "invalid_audio" });
  await assert.rejects(f.client.transcribe(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: "audio/webm" })), { code: "audio_too_large" });
  assert.equal(f.calls.length, 0);
});

test("Flash uses the configured voice, explicit model and MP3 output", async () => {
  const f = fixture([new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } })]);
  assert.deepEqual(await f.client.synthesize("Fictional timeline"), new Uint8Array([73, 68, 51]));
  assert.equal(f.calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/fixture-voice?output_format=mp3_44100_128");
  assert.deepEqual(JSON.parse(f.calls[0].init?.body as string), { text: "Fictional timeline", model_id: "eleven_flash_v2_5" });
  assert.equal(f.calls[0].init?.cache, "no-store");
});

test("unconfigured speech and invalid TTS content fail before a provider call", async () => {
  const f = fixture([], { apiKey: "" });
  await assert.rejects(f.client.transcribe(audio()), { code: "speech_not_configured" });
  const tts = fixture([]);
  await assert.rejects(tts.client.synthesize(" "), { code: "invalid_text" });
  await assert.rejects(tts.client.synthesize("x".repeat(MAX_SPEECH_CHARACTERS + 1)), { code: "invalid_text" });
  assert.equal(f.calls.length + tts.calls.length, 0);
});

test("provider access, quota and network errors are sanitized and never retried", async () => {
  for (const [status, code] of [[401, "speech_access_denied"], [403, "speech_access_denied"], [429, "speech_rate_limited"], [500, "speech_provider_failed"]] as const) {
    const f = fixture([new Response("fixture-key/private-content", { status })]);
    await assert.rejects(f.client.transcribe(audio()), { code, message: code });
    assert.equal(f.calls.length, 1);
  }
  const network = fixture([new Error("fixture-provider-payload")]);
  await assert.rejects(network.client.synthesize("fixture"), { message: "speech_provider_failed" });
  assert.equal(network.calls.length, 1);
});

test("a 200 JSON error or empty audio cannot be returned as speech", async () => {
  const json = fixture([Response.json({ error: "fixture-provider-error" })]);
  await assert.rejects(json.client.synthesize("fixture"), { code: "invalid_speech_response" });
  const empty = fixture([new Response(null, { headers: { "Content-Type": "audio/mpeg" } })]);
  await assert.rejects(empty.client.synthesize("fixture"), { code: "invalid_speech_response" });
});

test("audio stream failures cannot expose a provider error body", async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error("fixture-provider-secret")); } });
  const f = fixture([new Response(stream, { headers: { "Content-Type": "audio/mpeg" } })]);
  await assert.rejects(f.client.synthesize("fixture"), { message: "speech_provider_failed" });
});
