// POST /api/requests/refresh {}: owner-scoped expiry sweep in app time, then the list
import "server-only";
import { z } from "zod";
import { handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({});

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    parseInput(schema, await readJson(request));
    const { requests, expiredRequestIds } = await rt.queue.refresh(user.id);
    return json({ requests, appNow: (await rt.stores.appNow(user.id)).toISOString(), expiredRequestIds });
  });
}
