// which speech provider handles /api/stt right now, for GET /api/session (never exposes the key)
import "server-only";
import { paidProvidersAllowed, trustedLanHosts, type AuthMode } from "../mvp/auth.ts";

export type SpeechMode = "elevenlabs" | "off";

/** a key is set; says nothing about whether it works until a real transcript comes back */
export function speechConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY?.trim());
}

/** mirrors createSpeechRuntimeFromApp in lib/speech/runtime.ts: https, or plain http on localhost/127.0.0.1 or an RR_TRUSTED_LAN_HOSTS host */
export function speechBaseAccepted(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", ...trustedLanHosts()].includes(url.hostname));
  } catch {
    return false;
  }
}

/**
 * "elevenlabs" only when ELEVENLABS_API_KEY is set AND paid providers are allowed for this runtime (a demo identity
 * only on a local base url; a deployed origin needs a verified owner). the defaults match lib/mvp/runtime.ts
 * (RR_AUTH, APP_BASE_URL), so GET /api/session can call it with no arguments.
 */
export function speechMode(
  env: NodeJS.ProcessEnv = process.env,
  runtime?: { auth: AuthMode; baseUrl: string },
): SpeechMode {
  if (!speechConfigured(env)) return "off";
  const auth: AuthMode = runtime?.auth ?? (env.RR_AUTH === "google" ? "google" : "demo");
  const baseUrl = runtime?.baseUrl ?? (env.APP_BASE_URL || "http://localhost:3000");
  if (!paidProvidersAllowed(auth, baseUrl, env) || !speechBaseAccepted(baseUrl)) return "off";
  return "elevenlabs";
}
