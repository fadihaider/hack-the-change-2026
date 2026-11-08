// send, preview and confirm through lib/requests/http.ts, wired to the mvp runtime adapters
import "server-only";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { createRequestHttpHandlers } from "../../../lib/requests/http.ts";
import { hit, ipSubject, LIMITS } from "../../../lib/rateLimit.ts";
import { RateLimitedError } from "./http.ts";

/** baseUrl is the checked origin, so response links point at the host the owner is using */
export function requestHandlers(rt: Runtime, baseUrl: string = rt.baseUrl) {
  return createRequestHttpHandlers({
    baseUrl,
    authenticate: async (request) => {
      const userId = await rt.auth.currentUserId(request);
      return userId ? { userId } : null;
    },
    store: rt.stores.workflow,
    appNow: (userId) => rt.stores.appNow(userId),
    findHealthTerms: rt.findHealthTerms,
    send: (message) => rt.mail.send(message),
  });
}

/** response links are bearer tokens, so previews and confirmations are limited per client ip (hashed) */
export async function limitResponseLinks(rt: Runtime, headers: Headers): Promise<void> {
  const salt = process.env.APP_ENC_KEY || "reliefready-local";
  const result = await hit(rt.stores.database, LIMITS.responsePerIp, ipSubject(headers, salt));
  if (!result.allowed) throw new RateLimitedError(result);
}
