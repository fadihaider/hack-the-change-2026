// POST /api/sms/draft {episodeId?, recipientName?, senderName?, note?, tier}: one model-written text to edit
// {text, healthTermsFound, approvalBlocked, editFlags, parts, drafter}. counts against the model quota; saves nothing
import "server-only";
import { draftSms, smsDraftSchema } from "../../_lib/sms.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    return json(await draftSms(rt, user, parseInput(smsDraftSchema, await readJson(request, 4 * 1024))));
  });
}
