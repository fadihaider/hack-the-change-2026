// GET /api/care-access/basemap: the explorer's base layer from the public care access snapshot. community outlines,
// driving-route coverage, the fixed access groups and the model reports, without the 1 MB cost matrices or any place
// list. aggregate public data only: no user records, addresses or care facts.
import { slimBasemap } from "../../../../components/app/access/access-data.ts";
import { loadAccessSnapshot } from "../../../../lib/care-access/snapshot.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// about a metre at calgary's latitude, well under a pixel on the explorer map
const OUTLINE_DIGITS = 5;

export async function GET(): Promise<Response> {
  try {
    const snapshot = await loadAccessSnapshot();
    // only whether the optional classifier is set up; never its url or token
    const inferenceConfigured = Boolean(process.env.CARE_ACCESS_INFERENCE_URL);
    return Response.json(slimBasemap(snapshot, { inferenceConfigured, digits: OUTLINE_DIGITS }), {
      headers: { "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return Response.json({ error: { code: "access_snapshot_unavailable" } }, { status: 503 });
  }
}
