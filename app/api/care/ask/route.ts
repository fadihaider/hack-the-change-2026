// POST /api/care/ask {question}: A5 over approved facts with verbatim citations; "Not in profile" opens a question
// a cited medical_instruction answer carries no model wording, only the exact text and the 811/911 notice (PRD C6)
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
