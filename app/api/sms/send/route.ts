// POST /api/sms/send {requestId}: sends one approved text over the runtime sms adapter {text, handoffPhone}. a second
// click finds it no longer approved and gets 409 state_conflict, so a text never goes out twice. handoffPhone is the
// full number only for a simulated (demo) send, so the owner's phone can send it from Messages; otherwise null
import "server-only";
import { sendSms, smsHandoffPhone, smsSendSchema } from "../../_lib/sms.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { requestId } = parseInput(smsSendSchema, await readJson(request, 1024));
    const text = await sendSms(rt, user, requestId);
    return json({ text, handoffPhone: await smsHandoffPhone(rt, user, text) });
  });
}
