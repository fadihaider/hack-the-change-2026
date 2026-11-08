// POST /api/commitments/timeline {commitmentId}: "Add to care timeline" for the care recipient's own appointment (PRD C9)
import "server-only";
import { z } from "zod";
import { addToTimeline } from "../../_lib/commitments.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ commitmentId: z.string().min(1).max(64) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { commitmentId } = parseInput(schema, await readJson(request));
    return json(await addToTimeline(rt, user, commitmentId));
  });
}
