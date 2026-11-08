// which speech provider handles /api/stt right now, for GET /api/session (never exposes the key)
// stub: the voice integration replaces the body with the real check
export type SpeechMode = "elevenlabs" | "off";

export function speechMode(_env: NodeJS.ProcessEnv = process.env): SpeechMode {
  return "off";
}
