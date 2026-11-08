import { z } from "zod";
import { createCaller, RequestApiError } from "./request-api.ts";
import { recordingExtension } from "./recorder.ts";

// browser client for POST /api/stt (lib/speech/http.ts). the request is multipart/form-data with exactly one
// field named "file" holding the recorded audio; the reply is exactly {transcript}. nothing is saved by this
// call: the caregiver reviews the words, then the care screen posts them to /api/care/sources as kind "voice".

// the server gives the provider up to 60 s to transcribe and 60 s to delete its copy before replying
const TRANSCRIBE_TIMEOUT_MS = 130_000;

export const transcriptSchema = z.object({ transcript: z.string().max(200_000) });
export type TranscriptView = z.infer<typeof transcriptSchema>;

export function createSpeechApi(transport: typeof fetch = fetch) {
  const call = createCaller(transport);
  return {
    transcribe: (audio: Blob) => {
      const form = new FormData();
      // one field only; the server drops the file name and uses its own
      form.append("file", audio, `recording.${recordingExtension(audio.type)}`);
      return call("/api/stt", transcriptSchema, { body: form, timeoutMs: TRANSCRIBE_TIMEOUT_MS });
    },
  };
}
export type SpeechApi = ReturnType<typeof createSpeechApi>;

/** the plain explanation shown when the server has no live transcription; also the "off" panel copy */
export const SPEECH_OFF_MESSAGE =
  "Live transcription isn’t set up on this server, so voice notes can’t be turned into text here. Type the note instead.";

// own wording on purpose: the shared live error text talks about pdf uploads for 413 and 415
const SPEECH_ERROR_TEXT: Record<string, string> = {
  speech_not_configured: SPEECH_OFF_MESSAGE,
  not_configured: SPEECH_OFF_MESSAGE,
  speech_off: SPEECH_OFF_MESSAGE,
  speech_access_denied:
    "The speech service didn’t accept this server’s key, so nothing was transcribed. Type the note instead.",
  rate_limited:
    "Too many recordings in a short time. Wait a few minutes and try again, or type the note instead.",
  speech_rate_limited:
    "The speech service is busy. Wait a few minutes and try again, or type the note instead.",
  invalid_audio: "The recording couldn’t be read. Record it again, or type the note instead.",
  unsupported_media_type: "The recording couldn’t be read. Record it again, or type the note instead.",
  invalid_input: "The recording couldn’t be read. Record it again, or type the note instead.",
  payload_too_large: "That recording is too long to send. Record a shorter note, or type it instead.",
  audio_too_large: "That recording is too long to send. Record a shorter note, or type it instead.",
  speech_cleanup_failed:
    "The speech service couldn’t confirm it deleted its copy, so the transcript was held back. Nothing was saved. Try again, or type the note instead.",
  speech_provider_failed:
    "The speech service didn’t send back a transcript. Nothing was saved. Try again, or type the note instead.",
  invalid_speech_response:
    "The speech service didn’t send back a transcript. Nothing was saved. Try again, or type the note instead.",
  invalid_response:
    "The speech service didn’t send back a transcript. Nothing was saved. Try again, or type the note instead.",
  unauthenticated: "Voice notes need a signed-in account on this server. Type the note instead.",
  invalid_origin: "Open ReliefReady from its usual address to record a voice note, or type the note instead.",
  network_error: "ReliefReady couldn’t be reached. Your recording is still here, so you can try again.",
  temporarily_unavailable:
    "Voice transcription isn’t available right now. Nothing was saved. Try again later, or type the note instead.",
};

const FALLBACK =
  "The recording couldn’t be turned into text. Nothing was saved. Try again, or type the note instead.";

/** plain-language text for a failed /api/stt call; never shows provider wording */
export function speechErrorMessage(error: unknown): string {
  if (!(error instanceof RequestApiError)) return FALLBACK;
  // no /api/stt on this server at all (next answers an html 404, which reads as invalid_response)
  if (error.status === 404) return SPEECH_OFF_MESSAGE;
  const known = SPEECH_ERROR_TEXT[error.code];
  if (known) return known;
  if (error.status === 401) return SPEECH_ERROR_TEXT.unauthenticated;
  if (error.status === 403) return SPEECH_ERROR_TEXT.invalid_origin;
  if (error.status === 413) return SPEECH_ERROR_TEXT.payload_too_large;
  if (error.status === 429) return SPEECH_ERROR_TEXT.rate_limited;
  if (error.status === 503) return SPEECH_ERROR_TEXT.temporarily_unavailable;
  return FALLBACK;
}

/** true when trying again here cannot work (no provider, no route, no sign-in), so only typing is offered */
export function isSpeechUnavailable(error: unknown): boolean {
  if (!(error instanceof RequestApiError)) return false;
  if (error.code === "speech_not_configured" || error.code === "not_configured" || error.code === "speech_off") {
    return true;
  }
  if (error.code === "speech_access_denied" || error.code === "unauthenticated") return true;
  return error.status === 404 || error.status === 401;
}

/** true when the same recording can be sent again (the audio itself was fine) */
export function canRetrySameRecording(error: unknown): boolean {
  if (isSpeechUnavailable(error)) return false;
  if (!(error instanceof RequestApiError)) return true;
  const unreadable = ["invalid_audio", "unsupported_media_type", "invalid_input", "payload_too_large", "audio_too_large"];
  return !unreadable.includes(error.code) && error.status !== 413 && error.status !== 403;
}
