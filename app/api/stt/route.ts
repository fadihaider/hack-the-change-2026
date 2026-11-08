// POST /api/stt: recorded audio -> ElevenLabs Scribe v2 transcript (PRD 6, AC3). nothing is saved here; the caller
// reviews and edits the text, then posts it to /api/care/sources as {kind:"voice", text}.
//
// request contract (lib/speech/http.ts readAudio):
// - same-origin POST (the browser's Origin header), signed-in owner
// - Content-Type multipart/form-data; send a FormData and let the browser set the boundary
// - exactly ONE field, named "file": a non-empty Blob/File. any other or extra field (a consent flag, a name) is a
//   400 invalid_input. the filename is ignored; the server sends a fixed "recording.<ext>"
// - the Blob's base mime type (parameters after ";" ignored, so "audio/webm;codecs=opus" is fine) must be one of
//   audio/webm, audio/ogg, audio/mp4, audio/mpeg, audio/wav, audio/x-wav, audio/m4a, audio/x-m4a, audio/aac
// - at most 10 MiB (10485760 bytes) of actual request bytes INCLUDING multipart overhead; keep audio under ~9 MiB.
//   the server has no duration check; the client caps a recording (about 120 s)
// - consent is a client step (an unchecked-by-default box before upload); the server takes no consent field
// - language is fixed to English
//
// response 200: exactly {"transcript": string}. it can be "" for silence: treat a blank transcript as "nothing was
// heard" and never save it. no languageCode or other fields.
// errors are {error:{code}}: 401 unauthenticated; 403 invalid_origin; 503 speech_not_configured (no key; no quota
// used); 415 unsupported_media_type (not multipart); 400 invalid_input (bad multipart, wrong or extra fields) or
// invalid_audio (empty or not an allowed audio type); 413 payload_too_large or audio_too_large; 429 rate_limited
// (Retry-After seconds; 30 stt+tts calls per user per 10 minutes) or speech_rate_limited (provider); 502
// speech_provider_failed, speech_cleanup_failed (transcript withheld) or invalid_speech_response; 503
// speech_access_denied (key refused) or temporarily_unavailable.
//
// retention: the audio is read into memory, bounded, sent once to ElevenLabs and dropped when this request ends. it
// is never written to disk, S3 or the database. lib/elevenlabs.ts deletes the provider's stored transcript
// (DELETE /v1/speech-to-text/transcripts/{id}) before releasing the text; if that delete fails the transcript is
// withheld (502 speech_cleanup_failed). llm_call keeps only user id, step "stt" and model "scribe_v2" for the
// quota. this does not claim the provider keeps no request logs.
import "server-only";
import { speechRoute } from "../_lib/speech.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return speechRoute(request, "stt");
}
