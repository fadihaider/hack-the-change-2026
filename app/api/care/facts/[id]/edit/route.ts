// POST /api/care/facts/[id]/edit {text}: the caregiver's wording becomes a new approved version; the old one is kept
// as superseded (PRD 4.3, 5). returns {fact, previous}
import "server-only";
import { z } from "zod";
import { editFact } from "../../../../_lib/care.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// the library checks 1 to 1000 characters after normalizing; this only bounds the raw body
const schema = z.strictObject({ text: z.string().min(1).max(4000) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { id } = await context.params;
    const { text } = parseInput(schema, await readJson(request));
    return json(await editFact(rt, user, id, text));
  });
}
