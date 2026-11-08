// GET /api/outbox: the owner's demo outbox (RR_MAIL=outbox only); bodies hold live response links, so owner-only
import "server-only";
import { listOutbox } from "../../../lib/mvp/mail.ts";
import { handle, json, readContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const messages = rt.mode.mail === "outbox" ? await listOutbox(rt.stores.database, user.id) : [];
    return json({ mail: rt.mode.mail, messages });
  });
}
