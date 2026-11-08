// pure helpers for the care voice note recorder (PRD 6). no browser globals are read here, so node tests can run
// them; the component passes in what the browser reports (MediaRecorder.isTypeSupported, isSecureContext, errors).

/** first match wins: chrome and firefox record webm/opus, safari records mp4 */
export const RECORDER_MIME_PREFERENCE = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

// mirrors the server allowlist in lib/speech/http.ts (a server-only module, so it cannot be imported here)
export const UPLOADABLE_AUDIO_TYPES: readonly string[] = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
];

/** the server reads at most 10 MiB for the whole multipart request (lib/speech/http.ts, lib/elevenlabs.ts) */
export const SERVER_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** leave room for the multipart wrapper, like the pdf upload does */
export const MAX_AUDIO_BYTES = SERVER_MAX_AUDIO_BYTES - 64 * 1024;
/** stop a little early so the last chunk cannot push the file over the limit */
export const SIZE_HEADROOM_BYTES = 512 * 1024;
/** two minutes is a long voice note and stays far below the byte limit in every browser format */
export const MAX_RECORDING_SECONDS = 120;
/** say how much time is left once, this many seconds before the limit */
export const WARN_BEFORE_LIMIT_SECONDS = 15;
/** MediaRecorder hands over a chunk this often, so a size check can stop the recording in time */
export const RECORDER_TIMESLICE_MS = 1000;
/** same cap as the care compiler (lib/ai/careCompiler.ts CARE_LIMITS.maxSourceChars) */
export const MAX_TRANSCRIPT_CHARS = 50_000;

/** the first supported type from the preference list, or undefined to let the browser choose */
export function pickRecorderMime(isSupported: ((type: string) => boolean) | undefined): string | undefined {
  if (typeof isSupported !== "function") return undefined;
  for (const type of RECORDER_MIME_PREFERENCE) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // a browser that throws for one type may still accept another; keep looking
    }
  }
  return undefined;
}

/** "audio/webm;codecs=opus" -> "audio/webm" */
export function audioBaseType(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

/**
 * the type to send. the stream is audio only, so a "video/webm" or "video/mp4" container from an older recorder
 * holds audio and is labelled as such; anything else keeps its own label
 */
export function normalizeRecordedType(type: string): string {
  const trimmed = type.trim();
  const base = audioBaseType(trimmed);
  if (base !== "video/webm" && base !== "video/mp4") return trimmed;
  const semicolon = trimmed.indexOf(";");
  const params = semicolon === -1 ? "" : trimmed.slice(semicolon);
  return `audio/${base.slice("video/".length)}${params}`;
}

export function isUploadableType(type: string): boolean {
  return UPLOADABLE_AUDIO_TYPES.includes(audioBaseType(type));
}

/** a short file extension for the upload name; the server drops the name anyway */
export function recordingExtension(type: string): string {
  const base = audioBaseType(type);
  if (base === "audio/mp4" || base === "audio/m4a" || base === "audio/x-m4a") return "m4a";
  if (base === "audio/mpeg") return "mp3";
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/aac") return "aac";
  return "webm";
}

export type RecordingProblem = "empty" | "too_large" | "unsupported_format";

/** null when the recording can be sent as it is */
export function recordingProblem(audio: { size: number; type: string }): RecordingProblem | null {
  if (audio.size <= 0) return "empty";
  if (audio.size > MAX_AUDIO_BYTES) return "too_large";
  if (!isUploadableType(audio.type)) return "unsupported_format";
  return null;
}

/** true once the recorded bytes are close enough to the limit that the recorder should stop */
export function shouldStopForSize(bytes: number): boolean {
  return bytes >= MAX_AUDIO_BYTES - SIZE_HEADROOM_BYTES;
}

export function recordingProblemMessage(problem: RecordingProblem): string {
  switch (problem) {
    case "empty":
      return "Nothing was recorded. Try again closer to the microphone, or type the note instead.";
    case "too_large":
      return "That recording is too long to send. Record a shorter note, or type it instead.";
    case "unsupported_format":
      return "This browser recorded audio in a format that can’t be sent. Try another browser, or type the note instead.";
  }
}

export type MicProblem = "permission_denied" | "no_microphone" | "mic_busy" | "insecure" | "unsupported" | "unknown";

export type RecorderSupport = {
  /** window.isSecureContext: browsers only allow the microphone on https or this computer */
  secureContext: boolean;
  /** navigator.mediaDevices.getUserMedia exists */
  getUserMedia: boolean;
  /** window.MediaRecorder exists */
  mediaRecorder: boolean;
};

/** why this browser cannot record at all, or null when it can try */
export function recorderSupportProblem(support: RecorderSupport): MicProblem | null {
  if (!support.secureContext) return "insecure";
  if (!support.getUserMedia || !support.mediaRecorder) return "unsupported";
  return null;
}

/** maps a getUserMedia or MediaRecorder failure to a plain reason, by its DOMException name */
export function micProblemOf(error: unknown): MicProblem {
  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "permission_denied";
    case "SecurityError":
      return "insecure";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no_microphone";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "mic_busy";
    case "NotSupportedError":
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export function micProblemMessage(problem: MicProblem): string {
  switch (problem) {
    case "permission_denied":
      return "Microphone access is blocked. Allow the microphone for this site in your browser settings and try again, or type the note instead.";
    case "no_microphone":
      return "No microphone was found. Connect one and try again, or type the note instead.";
    case "mic_busy":
      return "The microphone couldn’t start. Another app may be using it. Close that app and try again, or type the note instead.";
    case "insecure":
      return "This browser only allows the microphone on a secure (https) address. Type the note instead.";
    case "unsupported":
      return "This browser can’t record audio here. Try a current version of Chrome, Safari or Firefox, or type the note instead.";
    case "unknown":
      return "The microphone couldn’t start. Try again, or type the note instead.";
  }
}

/** true for problems another try in the same browser cannot fix, so the panel offers typing only */
export function isLastingMicProblem(problem: MicProblem): boolean {
  return problem === "insecure" || problem === "unsupported";
}

/** m:ss for the recording clock, e.g. 65 -> "1:05" */
export function formatElapsed(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** "2 minutes", "1 minute 5 seconds", "45 seconds", for screen readers and the limit line */
export function durationWords(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (rest > 0 || minutes === 0) parts.push(`${rest} ${rest === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}
