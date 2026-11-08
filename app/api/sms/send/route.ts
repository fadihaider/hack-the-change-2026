// POST /api/sms/send {requestId}: sends one approved text over the runtime sms adapter {text}. a second click finds it
// no longer approved and gets 409 state_conflict, so a text never goes out twice
import "server-only";
import { sendSms, smsSendSchema } from "../../_lib/sms.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { requestId } = parseInput(smsSendSchema, await readJson(request, 1024));
    return json({ text: await sendSms(rt, user, requestId) });
  });
}
