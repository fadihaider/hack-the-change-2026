// GET /api/session: the signed-in owner, adapter modes, the care recipient and the active episode
import "server-only";
import { albertaDate, loadActiveEpisode, loadRecipient } from "../_lib/context.ts";
import { handle, isAdmin, json, readContext } from "../_lib/http.ts";
import { embeddingMode } from "../../../lib/ai/embeddings.ts";
import { speechMode } from "../../../lib/speech/status.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const database = rt.stores.database;
    const recipient = await loadRecipient(database, user.id).catch(() => null);
    const episode = await loadActiveEpisode(database, user.id);
    const appNow = await rt.stores.appNow(user.id);
    return json({
      user: { id: user.id, email: user.email },
      mode: rt.mode,
      admin: isAdmin(rt, user),
      appNow: appNow.toISOString(),
      today: albertaDate(appNow),
      careRecipient: recipient && {
        id: recipient.id,
        alias: recipient.alias,
        displayName: recipient.displayName,
        address: recipient.address,
        community: recipient.community,
      },
      episode: episode && { id: episode.id, startsOn: episode.startsOn, endsOn: episode.endsOn, status: episode.status },
      providers: { speech: speechMode(), retrieval: embeddingMode() === "off" ? "keyword" : "vector" },
    });
  });
}
