// POST /api/clock/jump {days}: admin only; audited jump, then the in-process expiry sweep (PRD R3, U6b)
import "server-only";
import { z } from "zod";
import { jumpClock, MAX_JUMP_DAYS } from "../../../../lib/store/clock.ts";
import { ApiError, handle, isAdmin, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ days: z.number().int().min(1).max(MAX_JUMP_DAYS) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    if (!isAdmin(rt, user)) throw new ApiError(403, "forbidden");
    const { days } = parseInput(schema, await readJson(request));
    const result = await jumpClock(rt.stores.database, { days, adminUserId: user.id });
    return json({
      appNow: result.appNow.toISOString(),
      realNow: result.realNow.toISOString(),
      offsetMilliseconds: result.offsetMilliseconds,
      expiredRequestIds: result.expiredRequestIds,
    });
  });
}
