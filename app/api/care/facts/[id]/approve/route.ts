// POST /api/care/facts/[id]/approve: a suggested fact and its events become approved; no body is read
import "server-only";
import { approveFact } from "../../../../_lib/care.ts";
import { handle, json, writeContext } from "../../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { id } = await context.params;
    return json(await approveFact(rt, user, id));
  });
}
