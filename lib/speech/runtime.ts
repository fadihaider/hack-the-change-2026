import "server-only";
import { z } from "zod";
import { elevenLabsClient } from "../elevenlabs.ts";
import { reserveCall } from "../rateLimit.ts";
import { requireSameOrigin, WorkflowError } from "../requests/workflow.ts";
import { createElevenLabsSdkClient, PROVISION_REQUEST_OPTIONS } from "../voice-agent/client.ts";
import { DEFAULT_VOICE_ID, HOSTED_VOICE_AGENT_ID } from "../voice-agent/config.ts";
import { createSpeechHttpHandlers } from "./http.ts";

const consentSchema = z.strictObject({ consent: z.literal(true), fictionalData: z.literal(true) });
const MAX_SESSION_BYTES = 1024;
const privateHeaders = {
  "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
};

interface SpeechRuntimeDependencies {
  baseUrl: string;
  authenticate(request: Request): Promise<{ userId: string } | null>;
  database: Parameters<typeof reserveCall>[0];
  agentId: string;
  agentModel: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
}

async function readConsent(request: Request): Promise<boolean> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") return false;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SESSION_BYTES)) return false;
  if (!request.body) return false;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SESSION_BYTES) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return consentSchema.safeParse(value).success;
  } catch { return false; }
  finally { reader.releaseLock(); }
}

/** Concrete provider/quota composition. The runtime owner supplies verified auth and the durable database. */
export function createSpeechRuntime(dependencies: SpeechRuntimeDependencies) {
  const speech = elevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
  });
  const handlers = createSpeechHttpHandlers({
    baseUrl: dependencies.baseUrl,
    authenticate: dependencies.authenticate,
    reserveCall: async (input) => {
      const reservation = await reserveCall(dependencies.database, input);
      if (reservation.allowed && !reservation.callId) throw new Error("missing_call_metadata");
      return reservation;
    },
    speech,
  });
  return {
    ...handlers,
    async session(request: Request): Promise<Response> {
      try {
        if (request.method !== "POST") {
          const response = json({ error: { code: "method_not_allowed" } }, 405);
          response.headers.set("Allow", "POST");
          return response;
        }
        const identity = await dependencies.authenticate(request);
        if (!identity?.userId) return json({ error: { code: "unauthenticated" } }, 401);
        requireSameOrigin(request.headers.get("Origin"), dependencies.baseUrl);
        if (!await readConsent(request)) return json({ error: { code: "consent_required" } }, 400);
        if (!process.env.ELEVENLABS_API_KEY?.trim() || !/^agent_[A-Za-z0-9_-]{8,100}$/.test(dependencies.agentId)) {
          return json({ error: { code: "speech_not_configured" } }, 503);
        }
        // This non-voice step uses both the per-user model quota and daily spend fuse.
        // Store metadata before issuing a bearer connection URL. Never store the URL itself.
        const reserved = await reserveCall(dependencies.database, {
          userId: identity.userId, step: "voice_agent_session", model: dependencies.agentModel,
        });
        if (!reserved.allowed || !reserved.callId) {
          if (reserved.allowed) return json({ error: { code: "temporarily_unavailable" } }, 503);
          const response = json({ error: { code: "rate_limited" } }, 429);
          response.headers.set("Retry-After", String(Math.max(1, reserved.limit.retryAfterSeconds)));
          return response;
        }
        const result = await createElevenLabsSdkClient().conversationalAi.conversations.getSignedUrl(
          { agentId: dependencies.agentId }, PROVISION_REQUEST_OPTIONS,
        );
        const url = new URL(result.signedUrl);
        if (url.protocol !== "wss:" || !url.hostname.endsWith(".elevenlabs.io")) return json({ error: { code: "speech_provider_failed" } }, 502);
        return json({ signedUrl: result.signedUrl });
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "invalid_origin") return json({ error: { code: "invalid_origin" } }, 403);
        // No logs: auth/SQL/provider exceptions can contain bearer URLs or credentials.
        return json({ error: { code: "temporarily_unavailable" } }, 503);
      }
    },
  };
}

export function speechRuntimeUnavailable(): Response {
  return json({ error: { code: "temporarily_unavailable" } }, 503);
}


/** Minimal structural slice of Fadi's Runtime; keeps auth/database ownership with that module. */
interface SpeechAppRuntime {
  baseUrl: string;
  stores: { database: Parameters<typeof reserveCall>[0] };
  auth: { mode: "demo" | "google"; currentUserId(request: Request): Promise<string | null> };
}

export function createSpeechRuntimeFromApp(runtime: SpeechAppRuntime) {
  const base = new URL(runtime.baseUrl);
  const loopbackHttp = base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
  if ((base.protocol !== "https:" && !loopbackHttp) || base.username || base.password) throw new Error("invalid_app_base_url");
  const localDemo = runtime.auth.mode === "demo" && loopbackHttp;
  return createSpeechRuntime({
    baseUrl: runtime.baseUrl,
    database: runtime.stores.database,
    agentId: process.env.ELEVENLABS_AGENT_ID || HOSTED_VOICE_AGENT_ID,
    agentModel: "gpt-oss-120b",
    authenticate: async (request) => {
      // A seeded demo identity must never authorize paid providers on a deployed origin.
      if (runtime.auth.mode !== "google" && !localDemo) return null;
      const userId = await runtime.auth.currentUserId(request);
      return userId ? { userId } : null;
    },
  });
}
