// POST /api/impact {episodeId}: commitments in the care window with rule conflicts, A2 suggestions and dependencies
import "server-only";
import { z } from "zod";
import { scanImpact } from "../_lib/commitments.ts";
import { handle, json, parseInput, readJson, writeContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({ episodeId: z.string().min(1).max(64) });

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { episodeId } = parseInput(schema, await readJson(request));
    return json(await scanImpact(rt, user, episodeId));
  });
}
