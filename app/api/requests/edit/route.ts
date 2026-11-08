// POST /api/requests/edit {requestId, subject?, body?, contactId?, respondBy?}: back to awaiting_approval, override reset
import "server-only";
import { z } from "zod";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({
  requestId: z.string().min(1).max(128),
  subject: z.string().max(300).optional(),
  body: z.string().max(5000).optional(),
  contactId: z.string().min(1).max(64).optional(),
  respondBy: z.string().max(64).nullable().optional(),
});

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const input = parseInput(schema, await readJson(request, 32 * 1024));
    return json({ request: await rt.queue.edit(user.id, input) });
  });
}
