// GET /api/requests: the owner's requests, newest first, with app time (docs/INTEGRATIONS.md approval queue)
import "server-only";
import { handle, json, readContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const requests = await rt.queue.list(user.id);
    return json({ requests, appNow: (await rt.stores.appNow(user.id)).toISOString() });
  });
}
