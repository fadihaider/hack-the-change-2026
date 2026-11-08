// POST /api/care/facts/[id]/reject: a suggested fact and its events become rejected (kept, never deleted); no body is read
import "server-only";
import { rejectFact } from "../../../../_lib/care.ts";
import { handle, json, writeContext } from "../../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { id } = await context.params;
    return json(await rejectFact(rt, user, id));
  });
}
