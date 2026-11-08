import { scoreRows } from "../../../components/app/access/access-data.ts";
import { compareAreas, SERVICE_CATEGORIES } from "../../../lib/care-access/engine";
import { loadAccessSnapshot } from "../../../lib/care-access/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Aggregate public facility data only: no user records, addresses or care facts.
 * view=scores returns one slim row per community (no place lists) for the explorer map; the default response and
 * area=ID keep their documented shape for the RAG hook.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") ?? "driving";
  const threshold = Number(params.get("threshold") ?? (mode === "proximity" ? 3 : 20));
  const categories = [...new Set((params.get("categories") ?? "Pharmacy,Health Centre").split(","))];
  const stepFree = params.get("stepFree") ?? "false";
  const view = params.get("view");
  if (!["driving", "proximity", "transit"].includes(mode) || !Number.isFinite(threshold)
    || threshold < 0.5 || threshold > (mode === "proximity" ? 20 : 120)
    || categories.length < 1 || categories.some((category) => !(SERVICE_CATEGORIES as readonly string[]).includes(category))
    || !["true", "false"].includes(stepFree) || (view !== null && view !== "scores")) {
    return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
  }
  if (mode === "transit") return Response.json({ error: { code: "transit_not_routed" }, message: "No scheduled transit router is configured; stop proximity is not travel time." }, { status: 422 });
  try {
    const snapshot = await loadAccessSnapshot();
    const options = { mode: mode as "driving" | "proximity", categories, threshold, stepFree: stepFree === "true" };
    const id = params.get("area");
    if (id && !snapshot.areas.some((area) => area.id === id)) return Response.json({ error: { code: "unknown_area" } }, { status: 404 });
    if (view === "scores") {
      const rows = scoreRows(snapshot, options);
      return Response.json({
        mode, threshold, categories, view, scoreFormula: snapshot.scoreFormula,
        areas: id ? rows.filter((row) => row.id === id) : rows,
      }, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    const all = compareAreas(snapshot, options);
    return Response.json({
      mode, threshold, categories, scoreFormula: snapshot.scoreFormula,
      areas: all.filter((row) => !id || row.area.id === id).map(({ area, index, ...result }) => ({
        area: { id: area.id, name: area.name, lat: area.lat, lon: area.lon }, ...result,
        cluster: snapshot.clusters[index], routingCoverage: snapshot.drivingCoverage[index],
      })),
      provenance: snapshot.provenance,
    }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch {
    return Response.json({ error: { code: "access_snapshot_unavailable" } }, { status: 503 });
  }
}
