import "server-only";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_SPEECH_CHARACTERS = 4000;
const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"], ["audio/ogg", "ogg"], ["audio/mp4", "mp4"],
  ["audio/mpeg", "mp3"], ["audio/wav", "wav"], ["audio/x-wav", "wav"],
  ["audio/m4a", "m4a"], ["audio/x-m4a", "m4a"], ["audio/aac", "aac"],
]);

export type SpeechErrorCode =
  | "speech_not_configured" | "invalid_audio" | "audio_too_large" | "invalid_text"
  | "speech_access_denied" | "speech_rate_limited" | "speech_provider_failed"
  | "speech_cleanup_failed" | "invalid_speech_response";

export class SpeechIntegrationError extends Error {
  code: SpeechErrorCode;
  constructor(code: SpeechErrorCode) { super(code); this.code = code; }
}

function providerError(status: number): SpeechIntegrationError {
  if (status === 401 || status === 403) return new SpeechIntegrationError("speech_access_denied");
  if (status === 429) return new SpeechIntegrationError("speech_rate_limited");
  return new SpeechIntegrationError("speech_provider_failed");
}

/** Adapters only: callers must authorize, rate-limit, and log metadata per user. */
export function elevenLabsClient(dependencies: { apiKey: string; voiceId?: string; fetch?: typeof fetch }) {
  const request = dependencies.fetch ?? fetch;
  function headers(): Record<string, string> {
    if (!dependencies.apiKey.trim()) throw new SpeechIntegrationError("speech_not_configured");
    return { "xi-api-key": dependencies.apiKey };
  }
  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await request(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(60_000) });
    } catch {
      // No retries: ambiguous failures may already have incurred provider cost.
      throw new SpeechIntegrationError("speech_provider_failed");
    }
  }

  return {
    async transcribe(audio: Blob): Promise<{ transcript: string; cleanup: "deleted" | "id_not_returned" }> {
      const type = audio.type.split(";")[0].trim().toLowerCase();
      const extension = AUDIO_TYPES.get(type);
      if (!extension || audio.size === 0) throw new SpeechIntegrationError("invalid_audio");
      if (audio.size > MAX_AUDIO_BYTES) throw new SpeechIntegrationError("audio_too_large");
      const form = new FormData();
      form.set("model_id", "scribe_v2");
      form.set("language_code", "en");
      form.set("timestamps_granularity", "word");
      // A fixed filename avoids transmitting the user's original file metadata.
      form.set("file", audio, `recording.${extension}`);
      const response = await call("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST", headers: headers(), body: form,
      });
      if (!response.ok) throw providerError(response.status);
      let result: { text?: unknown; transcription_id?: unknown };
      try { result = await response.json(); } catch { throw new SpeechIntegrationError("invalid_speech_response"); }
      const id = typeof result?.transcription_id === "string" && result.transcription_id ? result.transcription_id : null;
      if (id) {
        // Delete before releasing the transcript. Do not claim zero retention:
        // deletion of a transcript does not remove every provider request log.
        let deleted: Response;
        try {
          deleted = await call(`https://api.elevenlabs.io/v1/speech-to-text/transcripts/${encodeURIComponent(id)}`, {
            method: "DELETE", headers: headers(),
          });
        } catch { throw new SpeechIntegrationError("speech_cleanup_failed"); }
        if (!deleted.ok && deleted.status !== 404) throw new SpeechIntegrationError("speech_cleanup_failed");
      }
      if (typeof result?.text !== "string") throw new SpeechIntegrationError("invalid_speech_response");
      return { transcript: result.text, cleanup: id ? "deleted" : "id_not_returned" };
    },

    async synthesize(text: string): Promise<Uint8Array> {
      if (typeof text !== "string" || !text.trim() || [...text].length > MAX_SPEECH_CHARACTERS) {
        throw new SpeechIntegrationError("invalid_text");
      }
      if (!dependencies.voiceId?.trim()) throw new SpeechIntegrationError("speech_not_configured");
      const voice = encodeURIComponent(dependencies.voiceId);
      const response = await call(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
      });
      if (!response.ok) throw providerError(response.status);
      const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (!["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(type ?? "")) {
        throw new SpeechIntegrationError("invalid_speech_response");
      }
      let audio: Uint8Array;
      try { audio = new Uint8Array(await response.arrayBuffer()); }
      catch { throw new SpeechIntegrationError("speech_provider_failed"); }
      if (!audio.length) throw new SpeechIntegrationError("invalid_speech_response");
      return audio;
    },
  };
}
