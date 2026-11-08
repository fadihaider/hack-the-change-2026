// POST /api/responses/[token]: {} for Accept or Decline, {proposal:{at,note?}} for Propose (docs/INTEGRATIONS.md)
// the token fixes the choice; repeats return the first recorded state with recorded:false. no owner login is needed.
import "server-only";
import { getRuntime } from "../../../../lib/mvp/runtime.ts";
import { checkOrigin, handle } from "../../_lib/http.ts";
import { limitResponseLinks, requestHandlers } from "../../_lib/requests.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  return handle(async () => {
    const rt = await getRuntime();
    const { token } = await context.params;
    const base = checkOrigin(request, rt);
    await limitResponseLinks(rt, request.headers);
    return requestHandlers(rt, base).confirm(request, token);
  });
}
