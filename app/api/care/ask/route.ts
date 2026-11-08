// POST /api/care/ask {question}: A5 over the owner's approved facts with verbatim citations; "Not in profile" opens
// a question. medical and emergency questions get a fixed 811/911 pointer before any model call, and a cited
// medical_instruction answer carries no model wording, only the exact text and the notice (PRD C6, 7.2).
// response adds answeredBy, medicalRedirect, retrieval {method, considered} and citation provenance (lib/frontend/live-api.ts)
import "server-only";
import { z } from "zod";
import { askProfile } from "../../_lib/care.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ question: z.string().trim().min(1).max(500) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { question } = parseInput(schema, await readJson(request));
    return json(await askProfile(rt, user, question));
  });
}
