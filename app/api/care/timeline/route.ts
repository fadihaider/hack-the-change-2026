// GET /api/care/timeline?date=YYYY-MM-DD: approved events for the Alberta day, reminders highlighted by app time
import "server-only";
import { isIsoDate } from "../../../../lib/ai/time.ts";
import { timelineFor } from "../../_lib/care.ts";
import { ApiError, handle, json, readContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const date = new URL(request.url).searchParams.get("date");
    if (date !== null && date !== "" && !isIsoDate(date)) throw new ApiError(400, "invalid_input");
    return json(await timelineFor(rt, user, date || null));
  });
}
