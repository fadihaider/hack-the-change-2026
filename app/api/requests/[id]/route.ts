// GET /api/requests/[id]: one owner request; a missing or foreign id is 404
import "server-only";
import { handle, json, readContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const { id } = await context.params;
    const view = await rt.queue.read(user.id, id);
    return json({ request: view, appNow: (await rt.stores.appNow(user.id)).toISOString() });
  });
}
