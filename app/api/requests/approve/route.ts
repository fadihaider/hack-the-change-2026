// POST /api/requests/approve {requestId, healthOverride?} with If-Match: "<revision>" (docs/INTEGRATIONS.md)
// 428 without the header, 412 for a stale revision, 422 {error:{code:"health_terms",terms}} when health terms block it
import "server-only";
import { z } from "zod";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({
  requestId: z.string().min(1).max(128),
  healthOverride: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { requestId, healthOverride } = parseInput(schema, await readJson(request));
    const view = await rt.queue.approve(user.id, requestId, request.headers.get("If-Match"), healthOverride ?? false);
    return json({ request: view });
  });
}
