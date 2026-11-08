// POST /api/care/events/[id]/complete {date, done}: the caregiver marks (or unmarks) one occurrence done
import "server-only";
import { completeCareEvent, completionInputSchema } from "../../../../_lib/careContacts.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { id } = await context.params;
    const input = parseInput(completionInputSchema, await readJson(request, 1024));
    return json(await completeCareEvent(rt, user, id, input));
  });
}
