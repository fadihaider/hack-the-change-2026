import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioBaseType,
  durationWords,
  formatElapsed,
  isLastingMicProblem,
  isUploadableType,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_SECONDS,
  micProblemMessage,
  micProblemOf,
  normalizeRecordedType,
  pickRecorderMime,
  RECORDER_MIME_PREFERENCE,
  recorderSupportProblem,
  recordingExtension,
  recordingProblem,
  recordingProblemMessage,
  SERVER_MAX_AUDIO_BYTES,
  shouldStopForSize,
} from "./recorder.ts";
import { RequestApiError } from "./request-api.ts";
import {
  canRetrySameRecording,
  createSpeechApi,
  isSpeechUnavailable,
  SPEECH_OFF_MESSAGE,
  speechErrorMessage,
} from "./speech-api.ts";

// ---------------------------------------------------------------- mime choice

test("the recorder prefers webm opus, then plain webm, then mp4, then ogg opus", () => {
  assert.deepEqual([...RECORDER_MIME_PREFERENCE], [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]);
  assert.equal(pickRecorderMime(() => true), "audio/webm;codecs=opus");
  assert.equal(pickRecorderMime((type) => type === "audio/webm"), "audio/webm");
  // safari
  assert.equal(pickRecorderMime((type) => type === "audio/mp4"), "audio/mp4");
  assert.equal(pickRecorderMime((type) => type.startsWith("audio/ogg")), "audio/ogg;codecs=opus");
});

test("with no supported type or no checker, the browser picks its own format", () => {
  assert.equal(pickRecorderMime(() => false), undefined);
  assert.equal(pickRecorderMime(undefined), undefined);
  const flaky = (type: string) => {
    if (type === "audio/webm;codecs=opus") throw new Error("not available");
    return type === "audio/mp4";
  };
  assert.equal(pickRecorderMime(flaky), "audio/mp4");
});

test("every preferred recorder type is one the server accepts", () => {
  for (const type of RECORDER_MIME_PREFERENCE) assert.ok(isUploadableType(type), type);
  assert.equal(audioBaseType(" Audio/WebM ; codecs=opus"), "audio/webm");
  assert.ok(isUploadableType("audio/mpeg"));
  assert.ok(!isUploadableType("video/webm"));
  assert.ok(!isUploadableType(""));
  assert.ok(!isUploadableType("application/pdf"));
});

test("an audio-only video container is labelled as audio, keeping its codec", () => {
  assert.equal(normalizeRecordedType("video/webm;codecs=opus"), "audio/webm;codecs=opus");
  assert.equal(normalizeRecordedType("video/mp4"), "audio/mp4");
  assert.equal(normalizeRecordedType("audio/ogg;codecs=opus"), "audio/ogg;codecs=opus");
  assert.equal(normalizeRecordedType(""), "");
});

test("the upload file name has a matching extension", () => {
  assert.equal(recordingExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(recordingExtension("audio/mp4"), "m4a");
  assert.equal(recordingExtension("audio/ogg;codecs=opus"), "ogg");
  assert.equal(recordingExtension("audio/mpeg"), "mp3");
  assert.equal(recordingExtension("audio/wav"), "wav");
});

// ---------------------------------------------------------------- limits

test("the client size limit stays under the server's 10 MiB request cap", () => {
  assert.equal(SERVER_MAX_AUDIO_BYTES, 10 * 1024 * 1024);
  assert.ok(MAX_AUDIO_BYTES < SERVER_MAX_AUDIO_BYTES);
  assert.equal(MAX_RECORDING_SECONDS, 120);
  assert.ok(!shouldStopForSize(1024));
  assert.ok(shouldStopForSize(MAX_AUDIO_BYTES));
  assert.ok(shouldStopForSize(MAX_AUDIO_BYTES - 100 * 1024));
});

test("a recording is checked before it is sent", () => {
  assert.equal(recordingProblem({ size: 4000, type: "audio/webm;codecs=opus" }), null);
  assert.equal(recordingProblem({ size: 4000, type: "audio/mp4" }), null);
  assert.equal(recordingProblem({ size: 0, type: "audio/webm" }), "empty");
  assert.equal(recordingProblem({ size: MAX_AUDIO_BYTES + 1, type: "audio/webm" }), "too_large");
  assert.equal(recordingProblem({ size: 4000, type: "" }), "unsupported_format");
  assert.equal(recordingProblem({ size: 4000, type: "video/webm" }), "unsupported_format");
  assert.match(recordingProblemMessage("too_large"), /too long/);
  for (const problem of ["empty", "too_large", "unsupported_format"] as const) {
    assert.match(recordingProblemMessage(problem), /type/);
  }
});

test("the clock and spoken durations read naturally", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(5.9), "0:05");
  assert.equal(formatElapsed(65), "1:05");
  assert.equal(formatElapsed(120), "2:00");
  assert.equal(formatElapsed(-3), "0:00");
  assert.equal(formatElapsed(Number.NaN), "0:00");
  assert.equal(durationWords(120), "2 minutes");
  assert.equal(durationWords(61), "1 minute 1 second");
  assert.equal(durationWords(15), "15 seconds");
  assert.equal(durationWords(0), "0 seconds");
});

// ---------------------------------------------------------------- microphone errors

function domError(name: string): Error {
  const error = new Error("browser detail that is never shown");
  error.name = name;
  return error;
}

test("microphone failures map to plain reasons by their DOMException name", () => {
  assert.equal(micProblemOf(domError("NotAllowedError")), "permission_denied");
  assert.equal(micProblemOf(domError("PermissionDeniedError")), "permission_denied");
  assert.equal(micProblemOf(domError("SecurityError")), "insecure");
  assert.equal(micProblemOf(domError("NotFoundError")), "no_microphone");
  assert.equal(micProblemOf(domError("DevicesNotFoundError")), "no_microphone");
  assert.equal(micProblemOf(domError("OverconstrainedError")), "no_microphone");
  assert.equal(micProblemOf(domError("NotReadableError")), "mic_busy");
  assert.equal(micProblemOf(domError("AbortError")), "mic_busy");
  assert.equal(micProblemOf(domError("NotSupportedError")), "unsupported");
  assert.equal(micProblemOf(domError("Whatever")), "unknown");
  assert.equal(micProblemOf("not an error"), "unknown");
  assert.equal(micProblemOf(null), "unknown");
});

test("every microphone message is plain and offers typing", () => {
  const problems = ["permission_denied", "no_microphone", "mic_busy", "insecure", "unsupported", "unknown"] as const;
  for (const problem of problems) {
    const message = micProblemMessage(problem);
    assert.match(message, /type the note instead/i, problem);
    assert.doesNotMatch(message, /Error|DOMException|undefined/);
  }
  assert.match(micProblemMessage("permission_denied"), /blocked/);
  assert.match(micProblemMessage("no_microphone"), /No microphone/);
  assert.ok(isLastingMicProblem("insecure"));
  assert.ok(isLastingMicProblem("unsupported"));
  assert.ok(!isLastingMicProblem("permission_denied"));
});

test("browser support is checked before asking for the microphone", () => {
  const ok = { secureContext: true, getUserMedia: true, mediaRecorder: true };
  assert.equal(recorderSupportProblem(ok), null);
  assert.equal(recorderSupportProblem({ ...ok, secureContext: false }), "insecure");
  assert.equal(recorderSupportProblem({ ...ok, getUserMedia: false }), "unsupported");
  assert.equal(recorderSupportProblem({ ...ok, mediaRecorder: false }), "unsupported");
  // an insecure page is the reason to give, even when the apis are also missing
  assert.equal(recorderSupportProblem({ secureContext: false, getUserMedia: false, mediaRecorder: false }), "insecure");
});

// ---------------------------------------------------------------- speech client (lib/frontend/speech-api.ts)

test("transcribe posts exactly one multipart file field to /api/stt and parses {transcript}", async () => {
  let seen: { url: string; init: RequestInit | undefined } | null = null;
  const api = createSpeechApi(async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({ transcript: "Rosa has breakfast at 8:00." });
  });
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });
  const result = await api.transcribe(audio);
  assert.deepEqual(result, { transcript: "Rosa has breakfast at 8:00." });
  assert.ok(seen);
  const { url, init } = seen as { url: string; init: RequestInit | undefined };
  assert.equal(url, "/api/stt");
  assert.equal(init?.method, "POST");
  assert.equal(init?.credentials, "same-origin");
  // the browser sets the multipart boundary itself, so no json content type is forced
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("Content-Type"), null);
  const form = init?.body;
  assert.ok(form instanceof FormData);
  const entries = [...form.entries()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "file");
  const file = entries[0][1];
  assert.ok(typeof file !== "string");
  assert.equal(file.size, 3);
  assert.equal(audioBaseType(file.type), "audio/webm");
  assert.equal((file as File).name, "recording.webm");
});

test("a reply that is not {transcript} is never shown as a transcript", async () => {
  const api = createSpeechApi(async () => Response.json({ text: "made up" }));
  await assert.rejects(
    api.transcribe(new Blob([new Uint8Array([1])], { type: "audio/mp4" })),
    (error: unknown) => error instanceof RequestApiError && error.code === "invalid_response",
  );
});

test("server errors come back as their code and status", async () => {
  const api = createSpeechApi(async () => Response.json({ error: { code: "speech_not_configured" } }, { status: 503 }));
  await assert.rejects(
    api.transcribe(new Blob([new Uint8Array([1])], { type: "audio/webm" })),
    (error: unknown) =>
      error instanceof RequestApiError && error.code === "speech_not_configured" && error.status === 503,
  );
});

// ---------------------------------------------------------------- speech error text

test("speech errors use their own wording, never the pdf upload text", () => {
  const tooLarge = speechErrorMessage(new RequestApiError("payload_too_large", 413));
  assert.match(tooLarge, /recording is too long/);
  assert.doesNotMatch(tooLarge, /PDF/);
  const wrongType = speechErrorMessage(new RequestApiError("unsupported_media_type", 415));
  assert.doesNotMatch(wrongType, /PDF/);
  assert.match(wrongType, /recording couldn’t be read/);
  assert.equal(speechErrorMessage(new RequestApiError("speech_not_configured", 503)), SPEECH_OFF_MESSAGE);
  assert.match(SPEECH_OFF_MESSAGE, /Live transcription isn’t set up on this server/);
  assert.match(speechErrorMessage(new RequestApiError("speech_cleanup_failed", 502)), /Nothing was saved/);
  assert.match(speechErrorMessage(new RequestApiError("speech_provider_failed", 502)), /Nothing was saved/);
  assert.match(speechErrorMessage(new RequestApiError("rate_limited", 429)), /Wait a few minutes/);
  assert.match(speechErrorMessage(new RequestApiError("network_error", 0)), /recording is still here/);
  // an unmounted route (next answers html, so the json parse fails) reads as "not set up"
  assert.equal(speechErrorMessage(new RequestApiError("invalid_response", 404)), SPEECH_OFF_MESSAGE);
  assert.match(speechErrorMessage(new Error("boom")), /Nothing was saved/);
  assert.match(speechErrorMessage(new RequestApiError("something_new", 500)), /type the note instead/);
});

test("an unknown code on a 404 explains that transcription is not set up", () => {
  assert.equal(speechErrorMessage(new RequestApiError("not_found", 404)), SPEECH_OFF_MESSAGE);
  assert.equal(speechErrorMessage(new RequestApiError("request_failed", 404)), SPEECH_OFF_MESSAGE);
});

test("only failures another try could fix keep the recording for a retry", () => {
  assert.ok(isSpeechUnavailable(new RequestApiError("speech_not_configured", 503)));
  assert.ok(isSpeechUnavailable(new RequestApiError("not_found", 404)));
  assert.ok(isSpeechUnavailable(new RequestApiError("unauthenticated", 401)));
  assert.ok(!isSpeechUnavailable(new RequestApiError("speech_provider_failed", 502)));
  assert.ok(!isSpeechUnavailable(new Error("offline")));

  assert.ok(canRetrySameRecording(new RequestApiError("speech_provider_failed", 502)));
  assert.ok(canRetrySameRecording(new RequestApiError("speech_cleanup_failed", 502)));
  assert.ok(canRetrySameRecording(new RequestApiError("network_error", 0)));
  assert.ok(canRetrySameRecording(new RequestApiError("rate_limited", 429)));
  assert.ok(!canRetrySameRecording(new RequestApiError("invalid_audio", 400)));
  assert.ok(!canRetrySameRecording(new RequestApiError("payload_too_large", 413)));
  assert.ok(!canRetrySameRecording(new RequestApiError("speech_not_configured", 503)));
});
