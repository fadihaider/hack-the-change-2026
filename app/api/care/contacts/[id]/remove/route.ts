// POST /api/care/contacts/[id]/remove: hides one of the owner's trusted contacts (removed_at); no body is read
import "server-only";
import { removeCareContact } from "../../../../_lib/careContacts.ts";
import { handle, json, writeContext } from "../../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { id } = await context.params;
    return json(await removeCareContact(rt, user, id));
  });
}
