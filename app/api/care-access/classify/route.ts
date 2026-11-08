// POST /api/care-access/classify: optional proxy to a warm python/lambda classifier for new place names. signed-in
// owner and same origin first, then a per-owner rate limit, so it is never an open proxy to the inference service.
// nothing on the care pages calls it; when CARE_ACCESS_INFERENCE_URL is unset it answers 503 and the app keeps the
// published categories.
import "server-only";
import { hit, type LimitRule } from "../../../../lib/rateLimit.ts";
import { handle, json, RateLimitedError, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// up to 20 names per call, so this is generous for a person and tight for a script
const CLASSIFY_LIMIT: LimitRule = { name: "classify", limit: 30, windowSeconds: 600 };

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json") || !request.body) throw new Error("invalid_input");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 50_000) { await reader.cancel(); throw new Error("invalid_input"); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}

/** Optional warm Python/Lambda service. Never launches Python or trains in a request. */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    // owner and origin before the body is read
    const { rt, user } = await writeContext(request);
    const limit = await hit(rt.stores.database, CLASSIFY_LIMIT, user.id);
    if (!limit.allowed) throw new RateLimitedError(limit);

    let payload: unknown;
    try { payload = await boundedJson(request); }
    catch { return json({ error: { code: "invalid_input" } }, 400); }
    if (!payload || typeof payload !== "object" || !("texts" in payload) || Object.keys(payload).length !== 1
      || !Array.isArray(payload.texts) || payload.texts.length < 1 || payload.texts.length > 20
      || payload.texts.some((text) => typeof text !== "string" || !text.trim() || text.length > 2000)) {
      return json({ error: { code: "invalid_input" } }, 400);
    }
    const endpoint = process.env.CARE_ACCESS_INFERENCE_URL;
    if (!endpoint) return json({ error: { code: "classifier_not_configured" } }, 503);
    try {
      const response = await fetch(endpoint, {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", ...(process.env.CARE_ACCESS_INFERENCE_TOKEN ? { Authorization: `Bearer ${process.env.CARE_ACCESS_INFERENCE_TOKEN}` } : {}) },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("inference_failed");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("predictions" in result) || !Array.isArray(result.predictions)
        || result.predictions.length !== payload.texts.length
        || result.predictions.some((row) => !row || typeof row !== "object" || typeof row.category !== "string" || row.category.length > 100)) throw new Error("invalid_response");
      return json(result);
    } catch { return json({ error: { code: "classifier_unavailable" } }, 503); }
  });
}
