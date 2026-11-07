import "server-only";
import { z } from "zod";
import {
  MAX_AUDIO_BYTES, MAX_SPEECH_CHARACTERS, SpeechIntegrationError,
} from "../elevenlabs.ts";
import type { elevenLabsClient } from "../elevenlabs.ts";
import { requireSameOrigin, WorkflowError } from "../requests/workflow.ts";

const MAX_TTS_JSON_BYTES = 64 * 1024;
const AUDIO_TYPES = new Set([
  "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav",
  "audio/m4a", "audio/x-m4a", "audio/aac",
]);
const textSchema = z.strictObject({
  text: z.string().refine((value) => value.trim().length > 0 && [...value].length <= MAX_SPEECH_CHARACTERS),
});

export interface SpeechHttpDependencies {
  baseUrl: string;
  authenticate(request: Request): Promise<{ userId: string } | null>;
  // Atomically count recent llm_call rows AND insert this attempt. Use real DB
  // time and a per-user voice counter (STT + TTS share 30 / 10 minutes).
  // Return allowed:true only after the metadata insert commits.
  // Count failed/uncertain attempts too. Never persist audio or text here.
  reserveCall(input: {
    userId: string;
    step: "stt" | "tts";
    model: "scribe_v2" | "eleven_flash_v2_5";
  }): Promise<{ allowed: boolean; limit: { retryAfterSeconds: number } }>;
  speech: ReturnType<typeof elevenLabsClient>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code); }
}

function privateHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: privateHeaders() });
}

async function guarded(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpError) {
      const response = json({ error: { code: error.code } }, error.status);
      if (error.status === 405) response.headers.set("Allow", "POST");
      if (error.retryAfter !== undefined) response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
    if (error instanceof WorkflowError && error.code === "invalid_origin") {
      return json({ error: { code: "invalid_origin" } }, 403);
    }
    if (error instanceof SpeechIntegrationError) {
      const status = {
        invalid_audio: 400, audio_too_large: 413, invalid_text: 400,
        speech_not_configured: 503, speech_access_denied: 503, speech_rate_limited: 429,
        speech_provider_failed: 502, speech_cleanup_failed: 502, invalid_speech_response: 502,
      }[error.code];
      return json({ error: { code: error.code } }, status);
    }
    // Auth, database and provider diagnostics can contain private content or
    // credentials. Neither return nor log exception messages, causes or bodies.
    return json({ error: { code: "temporarily_unavailable" } }, 503);
  }
}

async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, "invalid_input");
  if (length !== null && Number(length) > maxBytes) throw new HttpError(413, "payload_too_large");
  if (!request.body) throw new HttpError(400, "invalid_input");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "payload_too_large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_input");
  } finally { reader.releaseLock(); }
}

async function readAudio(request: Request): Promise<Blob> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "multipart/form-data") {
    throw new HttpError(415, "unsupported_media_type");
  }
  // Bound actual wire bytes BEFORE formData() allocates/parses file objects.
  // The 10 MiB request limit includes multipart headers and boundaries.
  const bytes = await readBody(request, MAX_AUDIO_BYTES);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } }).formData();
  } catch { throw new HttpError(400, "invalid_input"); }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== "file") throw new HttpError(400, "invalid_input");
  const file = entries[0][1];
  if (typeof file === "string" || file.size === 0 || !AUDIO_TYPES.has(file.type.split(";")[0].trim().toLowerCase())) {
    throw new HttpError(400, "invalid_audio");
  }
  // Drop the original filename. The provider adapter uses its own fixed name.
  return new Blob([file], { type: file.type });
}

async function readText(request: Request): Promise<string> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type");
  }
  const bytes = await readBody(request, MAX_TTS_JSON_BYTES);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "invalid_input"); }
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "invalid_input");
  return parsed.data.text;
}

/** HTTP functions only. Production wiring requires verified auth + durable quota. */
export function createSpeechHttpHandlers(deps: SpeechHttpDependencies) {
  async function authorize(request: Request): Promise<string> {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const identity = await deps.authenticate(request);
    if (!identity?.userId) throw new HttpError(401, "unauthenticated");
    requireSameOrigin(request.headers.get("Origin"), deps.baseUrl);
    return identity.userId;
  }
  async function reserve(userId: string, step: "stt" | "tts"): Promise<void> {
    const result = await deps.reserveCall({
      userId, step, model: step === "stt" ? "scribe_v2" : "eleven_flash_v2_5",
    });
    if (result.allowed !== true) {
      const seconds = result.limit.retryAfterSeconds;
      if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error("invalid_quota_result");
      throw new HttpError(429, "rate_limited", seconds);
    }
  }
  return {
    stt(request: Request): Promise<Response> {
      return guarded(async () => {
        const userId = await authorize(request);
        const audio = await readAudio(request);
        await reserve(userId, "stt");
        const { transcript } = await deps.speech.transcribe(audio);
        // Cleanup status remains internal; no storage/model action is triggered.
        return json({ transcript });
      });
    },
    tts(request: Request): Promise<Response> {
      return guarded(async () => {
        const userId = await authorize(request);
        const text = await readText(request);
        await reserve(userId, "tts");
        const bytes = await deps.speech.synthesize(text);
        return new Response(new Uint8Array(bytes), {
          headers: { ...privateHeaders(), "Content-Type": "audio/mpeg" },
        });
      });
    },
  };
}
