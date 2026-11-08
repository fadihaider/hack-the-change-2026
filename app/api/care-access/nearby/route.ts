// GET /api/care-access/nearby?types=&radiusKm=1|2|3|5&accessible=any|yes&perType=1..8&address=: the resource cards
// and inline map near the care recipient's home (PRD 10, AC9). owner only. real resource rows with source and fetch
// date, straight-line distances, and a home point rounded to about 100 m. failures are {error:{code,message?}}.
import "server-only";
import { buildNearby, parseNearbyQuery, resolveNearbyOrigin } from "../../../../lib/care-access/nearby.ts";
import { loadRecipient } from "../../_lib/context.ts";
import { ensureResources } from "../../_lib/guide.ts";
import { ApiError, handle, json, readContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const query = parseNearbyQuery(new URL(request.url).searchParams);
    if (!query) throw new ApiError(400, "invalid_input");

    const database = rt.stores.database;
    const recipient = await loadRecipient(database, user.id);
    await ensureResources(database);
    const name = recipient.displayName?.trim() || recipient.alias;
    const origin = await resolveNearbyOrigin(database, {
      address: query.address,
      home: { lat: recipient.lat, lng: recipient.lng },
      name,
    });
    if (!origin.ok) {
      throw new ApiError(origin.reason === "unavailable" ? 503 : 422, origin.reason, { message: origin.message });
    }

    const now = await rt.stores.appNow(user.id);
    return json(await buildNearby(database, { origin, name, query, now }));
  });
}
