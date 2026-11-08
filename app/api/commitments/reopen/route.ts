// POST /api/commitments/reopen {commitmentId}: "Change the plan" opens the step again on the server, so a reload keeps
// it open -> {commitment:{id, decision, reopened:true}}. no request changes; the next decision clears it
import "server-only";
import { z } from "zod";
import { reopenCommitment } from "../../_lib/commitments.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ commitmentId: z.string().min(1).max(64) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { commitmentId } = parseInput(schema, await readJson(request));
    return json(await reopenCommitment(rt, user, commitmentId));
  });
}
