// POST /api/requests/redraft {requestId, disclosureTier}: a new A3 draft written for the chosen tier, saved through the
// approval queue's edit (back to awaiting_approval, so a fresh approval is needed) -> {request, editFlags, approvalBlocked}
import "server-only";
import { z } from "zod";
import { redraftRequest } from "../../_lib/commitments.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({
  requestId: z.string().min(1).max(128),
  disclosureTier: z.enum(["minimal", "general", "detailed"]),
});

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const input = parseInput(schema, await readJson(request));
    return json(await redraftRequest(rt, user, input));
  });
}
