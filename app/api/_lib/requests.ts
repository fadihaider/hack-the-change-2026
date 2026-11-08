// send, preview and confirm through lib/requests/http.ts, wired to the mvp runtime adapters
import "server-only";
import { findExtraHealthTerms } from "../../../lib/healthTerms.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { createRequestHttpHandlers } from "../../../lib/requests/http.ts";
import { hit, ipSubject, LIMITS } from "../../../lib/rateLimit.ts";
import { RateLimitedError, readJson } from "./http.ts";

/**
 * baseUrl is the checked origin, so response links point at the host the owner is using. extraHealthTerms are the
 * sent request's own extra terms (intake reason, medical facts), so the send check matches the one at approve
 */
export function requestHandlers(rt: Runtime, baseUrl: string = rt.baseUrl, extraHealthTerms: readonly string[] = []) {
  return createRequestHttpHandlers({
    baseUrl,
    authenticate: async (request) => {
      const userId = await rt.auth.currentUserId(request);
      return userId ? { userId } : null;
    },
    store: rt.stores.workflow,
    appNow: (userId) => rt.stores.appNow(userId),
    findHealthTerms: async (subject, body) => [
      ...new Set([...await rt.findHealthTerms(subject, body), ...findExtraHealthTerms(subject, body, extraHealthTerms)]),
    ],
    send: (message) => rt.mail.send(message),
    // demo mail stays in the local outbox, so response links may use the LAN http address
    allowHttpLinks: rt.mode.mail === "outbox",
  });
}

/**
 * the extra health terms of the request a send names, read before the send's row lock. they only change through an
 * edit, which moves the request out of approved, so they hold still for any send that can go ahead. anything odd
 * gives [] and the send handler answers for the request itself
 */
export async function sendExtraTerms(rt: Runtime, request: Request): Promise<string[]> {
  try {
    const userId = await rt.auth.currentUserId(request);
    if (!userId) return [];
    const body = await readJson(request.clone(), 4096);
    const requestId = (body as { requestId?: unknown } | null)?.requestId;
    return typeof requestId === "string" ? await rt.queue.extraHealthTerms(userId, requestId) : [];
  } catch {
    return [];
  }
}

/** response links are bearer tokens, so previews and confirmations are limited per client ip (hashed) */
export async function limitResponseLinks(rt: Runtime, headers: Headers): Promise<void> {
  const salt = process.env.APP_ENC_KEY || "reliefready-local";
  const result = await hit(rt.stores.database, LIMITS.responsePerIp, ipSubject(headers, salt));
  if (!result.allowed) throw new RateLimitedError(result);
}
