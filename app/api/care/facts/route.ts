// GET /api/care/facts: every care fact with status, events and open conflict partners, plus open questions
import "server-only";
import { careProfile } from "../../_lib/care.ts";
import { handle, json, readContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    return json(await careProfile(rt, user));
  });
}
