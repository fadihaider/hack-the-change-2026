// POST /api/demo/reset {}: admin only, demo sign-in only; clears the run so the next demo starts clean (audited)
import "server-only";
import { z } from "zod";
import { clearDemoRun } from "../../../../lib/mvp/demo-reset.ts";
import { ApiError, handle, isAdmin, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({});

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    if (rt.auth.mode !== "demo" || !isAdmin(rt, user)) throw new ApiError(403, "forbidden");
    parseInput(schema, await readJson(request));
    await rt.stores.database.transaction((tx) => clearDemoRun(tx, user.id));
    return json({ reset: true });
  });
}
