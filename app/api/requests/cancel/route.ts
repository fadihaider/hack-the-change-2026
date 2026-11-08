// POST /api/requests/cancel {requestId}: awaiting_approval or needs_review to cancelled
import "server-only";
import { z } from "zod";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ requestId: z.string().min(1).max(128) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { requestId } = parseInput(schema, await readJson(request));
    return json({ request: await rt.queue.cancel(user.id, requestId) });
  });
}
