// GET /api/guide?address=&tenure=yes|no|not_sure: U8 cards with source and fetch date (PRD U8)
// no address means the care recipient's stored location. failures are {error:{code,message}}.
import "server-only";
import { loadRecipient } from "../_lib/context.ts";
import { guideFor, parseTenure } from "../_lib/guide.ts";
import { ApiError, handle, json, readContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const params = new URL(request.url).searchParams;
    const tenure = parseTenure(params.get("tenure"));
    const address = params.get("address")?.trim() ?? "";
    if (tenure === null || address.length > 200) throw new ApiError(400, "invalid_input");
    const database = rt.stores.database;
    let point: { lat: number; lng: number } | undefined;
    if (!address) {
      const recipient = await loadRecipient(database, user.id);
      if (recipient.lat !== null && recipient.lng !== null) point = { lat: recipient.lat, lng: recipient.lng };
    }
    const now = await rt.stores.appNow(user.id);
    const guide = await guideFor(database, { address: address || undefined, point, now, tenure });
    if (!guide.ok) {
      throw new ApiError(guide.reason === "unavailable" ? 503 : 422, guide.reason, { message: guide.message });
    }
    return json(guide);
  });
}
