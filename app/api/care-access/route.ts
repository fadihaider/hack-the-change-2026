import { compareAreas, SERVICE_CATEGORIES, type AccessMode } from "../../../lib/care-access/engine";
import { loadAccessSnapshot } from "../../../lib/care-access/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Aggregate public facility data only: no user records, addresses or care facts. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") ?? "driving";
  const threshold = Number(params.get("threshold") ?? (mode === "proximity" ? 3 : 20));
  const categories = [...new Set((params.get("categories") ?? "Pharmacy,Health Centre").split(","))];
  const stepFree = params.get("stepFree") ?? "false";
  if (!["driving", "proximity", "transit"].includes(mode) || !Number.isFinite(threshold)
    || threshold < 0.5 || threshold > (mode === "proximity" ? 20 : 120)
    || categories.length < 1 || categories.some((category) => !(SERVICE_CATEGORIES as readonly string[]).includes(category))
    || !["true", "false"].includes(stepFree)) {
    return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
  }
  if (mode === "transit") return Response.json({ error: { code: "transit_not_routed" }, message: "No scheduled transit router is configured; stop proximity is not travel time." }, { status: 422 });
  try {
    const snapshot = await loadAccessSnapshot();
    const all = compareAreas(snapshot, { mode: mode as AccessMode, categories, threshold, stepFree: stepFree === "true" });
    const id = params.get("area");
    if (id && !snapshot.areas.some((area) => area.id === id)) return Response.json({ error: { code: "unknown_area" } }, { status: 404 });
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
