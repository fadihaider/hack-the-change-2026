// POST /api/commitments/decide {commitmentId, decision, contactId?, contactIds?, note?}: saves the decision; request
// actions get an A3 draft in the approval queue (PRD U4), one separate request per chosen contact, each approved and
// sent on its own. defer and keep create no request.
import "server-only";
import { z } from "zod";
import { COMMITMENT_DECISIONS } from "../../../../lib/ai/impact.ts";
import { decideCommitment } from "../../_lib/commitments.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .strictObject({
    commitmentId: z.string().min(1).max(64),
    decision: z.enum(COMMITMENT_DECISIONS),
    contactId: z.string().min(1).max(64).optional(),
    contactIds: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((value) => value.contactId === undefined || value.contactIds === undefined);

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const input = parseInput(schema, await readJson(request));
    return json(await decideCommitment(rt, user, input));
  });
}
