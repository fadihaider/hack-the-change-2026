// POST /api/care/conflicts/resolve {keepFactId}: the kept fact is approved, its conflict partners superseded
import "server-only";
import { z } from "zod";
import { resolveConflict } from "../../../_lib/care.ts";
import { handle, json, parseInput, readJson, writeContext } from "../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ keepFactId: z.string().min(1).max(64) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { keepFactId } = parseInput(schema, await readJson(request));
    return json(await resolveConflict(rt, user, keepFactId));
  });
}
