// GET /api/sms?episodeId=: the owner's texts (Twilio statuses checked first) {provider, texts}
// POST /api/sms {clientKey, episodeId?, to, senderName?, body, tier, healthOverride?, approved:true}: saves the exact
// text and number and records the approval {text}. nothing is sent here; POST /api/sms/send does that
import "server-only";
import { approveSms, listSms, smsApproveSchema } from "../_lib/sms.ts";
import { handle, json, parseInput, readContext, readJson, requireUuid, writeContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const episodeId = new URL(request.url).searchParams.get("episodeId");
    return json(await listSms(rt, user, episodeId ? requireUuid(episodeId) : null));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const input = parseInput(smsApproveSchema, await readJson(request, 8 * 1024));
    return json({ text: await approveSms(rt, user, input) });
  });
}
