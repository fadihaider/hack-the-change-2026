// R1 return review. GET reads the recorded states only; POST {} runs the owner's expiry sweep first (PRD R1, U6b)
import "server-only";
import { z } from "zod";
import { handle, json, parseInput, readContext, readJson, writeContext } from "../_lib/http.ts";
import { recoverGroups } from "../_lib/recover.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const groups = await recoverGroups(rt, user.id, await rt.queue.list(user.id));
    return json({ groups, appNow: (await rt.stores.appNow(user.id)).toISOString(), expiredRequestIds: [] });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    parseInput(z.strictObject({}), await readJson(request));
    const { requests, expiredRequestIds } = await rt.queue.refresh(user.id);
    const groups = await recoverGroups(rt, user.id, requests);
    return json({ groups, appNow: (await rt.stores.appNow(user.id)).toISOString(), expiredRequestIds });
  });
}
