// GET /api/clock: app time, real time and the demo offset (PRD R3)
import "server-only";
import { readClock } from "../../../lib/store/clock.ts";
import { handle, json, readContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt } = await readContext(request);
    const clock = await readClock(rt.stores.database);
    return json({
      appNow: clock.appNow.toISOString(),
      realNow: clock.realNow.toISOString(),
      offsetMilliseconds: clock.offsetMilliseconds,
    });
  });
}
