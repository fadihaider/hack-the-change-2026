// POST /api/clock/reset {}: admin only; back to real time so a demo run can start again (audited)
import "server-only";
import { z } from "zod";
import { p } from "../../../../lib/db.ts";
import { readClock, resetClock } from "../../../../lib/store/clock.ts";
import { ApiError, handle, isAdmin, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({});

const AUDIT_RESET = `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
  VALUES (:actor, 'clock_reset', 'sim_clock', '1', '{}'::jsonb)`;

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    if (!isAdmin(rt, user)) throw new ApiError(403, "forbidden");
    parseInput(schema, await readJson(request));
    const clock = await rt.stores.database.transaction(async (tx) => {
      await resetClock(tx);
      await tx.execute(AUDIT_RESET, [p.text("actor", user.id)]);
      return readClock(tx);
    });
    return json({
      appNow: clock.appNow.toISOString(),
      realNow: clock.realNow.toISOString(),
      offsetMilliseconds: clock.offsetMilliseconds,
    });
  });
}
