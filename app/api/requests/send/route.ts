// POST /api/requests/send {requestId}: lib/requests/http.ts send over the runtime mail adapter
// {state:"requested",messageId} | {state:"failed",errorCode} | {state:"needs_review"}
import "server-only";
import { getRuntime } from "../../../../lib/mvp/runtime.ts";
import { checkOrigin, handle } from "../../_lib/http.ts";
import { requestHandlers } from "../../_lib/requests.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const rt = await getRuntime();
    let base = rt.baseUrl;
    try {
      base = checkOrigin(request, rt);
    } catch {
      // the handler checks the session and then the origin, so it answers 401 or 403 itself
    }
    return requestHandlers(rt, base).send(request);
  });
}
