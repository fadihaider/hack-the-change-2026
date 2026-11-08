// GET /api/care/contacts: the caregiver's own trusted contacts; POST {name, relationship?, phone, kind} adds one
import "server-only";
import { addCareContact, contactInputSchema, listCareContacts } from "../../_lib/careContacts.ts";
import { handle, json, parseInput, readContext, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    return json(await listCareContacts(rt, user));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const input = parseInput(contactInputSchema, await readJson(request, 4 * 1024));
    return json(await addCareContact(rt, user, input));
  });
}
