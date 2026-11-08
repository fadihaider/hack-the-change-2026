// GET /api/sms/recipients: who a text can go to {provider, options:[{kind, id, label, detail, phoneMasked}], senderName}
// the test number (DEMO_SMS_TO) and saved care contacts appear masked; a typed number is the other choice
import "server-only";
import { smsRecipients } from "../../_lib/sms.ts";
import { handle, json, readContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    return json(await smsRecipients(rt, user));
  });
}
