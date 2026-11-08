// R1 return review: every request grouped by its recorded state, plus commitments created from responses
import "server-only";
import { p } from "../../../lib/db.ts";
import type { RequestView } from "../../../lib/frontend/request-api.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { recoverGroup } from "../../../lib/state.ts";

export interface RecoverGroups {
  handled: RequestView[];
  waiting: RequestView[];
  needsFollowUp: RequestView[];
  notSent: RequestView[];
  /** commitments with source 'response' (a recipient proposed another time) */
  new: { id: string; title: string | null; startsAt: string | null; requestId: string | null }[];
}

const RESPONSE_COMMITMENTS = `SELECT id::text AS id, title, to_json(starts_at)#>>'{}' AS starts_at, source_id
  FROM commitment WHERE user_id = CAST(:user_id AS uuid) AND source = 'response'
  ORDER BY starts_at NULLS LAST, id`;

/** deadline first, requests without a deadline last */
function byDeadline(a: RequestView, b: RequestView): number {
  if (a.respondBy === b.respondBy) return 0;
  if (a.respondBy === null) return 1;
  if (b.respondBy === null) return -1;
  return a.respondBy.localeCompare(b.respondBy);
}

export async function recoverGroups(rt: Runtime, userId: string, requests: RequestView[]): Promise<RecoverGroups> {
  const groups: RecoverGroups = { handled: [], waiting: [], needsFollowUp: [], notSent: [], new: [] };
  const sorted = [...requests].sort(byDeadline);
  for (const request of sorted) {
    const group = recoverGroup(request.state);
    if (group === "handled") groups.handled.push(request);
    else if (group === "waiting") groups.waiting.push(request);
    else if (group === "needs_follow_up") groups.needsFollowUp.push(request);
    else groups.notSent.push(request);
  }
  const rows = await rt.stores.database.query<{ id: string; title: string | null; starts_at: string | null; source_id: string | null }>(
    RESPONSE_COMMITMENTS,
    [p.uuid("user_id", userId)],
  );
  groups.new = rows.map((row) => ({
    id: row.id,
    title: row.title,
    startsAt: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
    requestId: row.source_id,
  }));
  return groups;
}
