// GET /api/care/sources/[id]: the full retained text of one of the owner's sources, as plain text
// -> {id, kind, author, createdAt, fullText}; an unknown or another owner's id is 404 not_found
import "server-only";
import { careSourceDetail } from "../../../_lib/care.ts";
import { handle, json, readContext } from "../../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const { id } = await context.params;
    return json(await careSourceDetail(rt, user, id));
  });
}
