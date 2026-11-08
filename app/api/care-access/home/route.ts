// GET /api/care-access/home?threshold=10|15|20|30|45: what is within reach of the care recipient's community, from
// the public care access snapshot. owner only. never returns the recipient's address or coordinates.
import "server-only";
import { compareAreas, SERVICE_CATEGORIES, type AccessMode, type AccessSnapshot } from "../../../../lib/care-access/engine.ts";
import {
  classifierLabels,
  clusterSizes,
  nearestByCategory,
  parseHomeThreshold,
  PROXIMITY_FALLBACK_KM,
  resolveHomeArea,
  typicalCounts,
} from "../../../../lib/care-access/home.ts";
import { loadAccessSnapshot } from "../../../../lib/care-access/snapshot.ts";
import { loadRecipient } from "../../_lib/context.ts";
import { ApiError, handle, json, readContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALLBACK_REASON =
  "Driving routes for this community are incomplete, so places are counted within 3 km in a straight line instead.";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

async function snapshotOrUnavailable(): Promise<AccessSnapshot> {
  try {
    return await loadAccessSnapshot();
  } catch {
    throw new ApiError(503, "access_snapshot_unavailable");
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await readContext(request);
    const requested = parseHomeThreshold(new URL(request.url).searchParams.get("threshold"));
    if (requested === null) throw new ApiError(400, "invalid_input");

    const recipient = await loadRecipient(rt.stores.database, user.id);
    const snapshot = await snapshotOrUnavailable();
    const match = resolveHomeArea(snapshot.areas, recipient);
    if (!match) throw new ApiError(404, "no_home_area");

    const index = match.index;
    const area = snapshot.areas[index];
    const routingCoverage = snapshot.drivingCoverage[index] ?? 0;
    const routed = routingCoverage === 1;
    const mode: AccessMode = routed ? "driving" : "proximity";
    const threshold = routed ? requested : PROXIMITY_FALLBACK_KM;
    const categories = [...SERVICE_CATEGORIES];

    // the engine only needs this one community's rows
    const [row] = compareAreas(
      {
        ...snapshot,
        areas: [area],
        drivingCoverage: [routingCoverage],
        drivingMinutes: [snapshot.drivingMinutes[index] ?? []],
        distanceKm: [snapshot.distanceKm[index] ?? []],
      },
      { mode, threshold, categories, stepFree: false },
    );

    const costs = (mode === "driving" ? snapshot.drivingMinutes[index] : snapshot.distanceKm[index]) ?? [];
    const closest = nearestByCategory(snapshot.resources, costs, categories);
    const unit = mode === "driving" ? "minutes" : "km";
    // the classifier only knows the national list's types; for city places its output means nothing
    const labels = classifierLabels(snapshot.benchmark.classification);
    const nearest = Object.fromEntries(
      categories.map((category) => {
        const hit = closest[category];
        if (!hit) return [category, null];
        return [
          category,
          {
            name: hit.resource.name,
            address: hit.resource.address,
            [unit]: round1(hit.cost),
            within: hit.cost <= threshold,
            sourceUrl: hit.resource.sourceUrl,
            source: hit.resource.source,
            modelCategory: labels?.has(hit.resource.category) ? (hit.resource.modelCategory ?? null) : null,
          },
        ];
      }),
    );

    const cluster = snapshot.clusters[index] ?? null;
    const profile =
      cluster === null ? null : (snapshot.benchmark.clustering.profiles.find((item) => item.cluster === cluster) ?? null);

    return json({
      area: { id: area.id, name: area.name },
      matchedBy: match.matchedBy,
      mode,
      unit,
      threshold,
      ...(routed ? {} : { requestedThreshold: requested, fallbackReason: FALLBACK_REASON }),
      score: row.score,
      counts: row.counts,
      nearest,
      resourcesWithin: row.resources.length,
      cluster,
      clusterProfile: profile
        ? { cluster: profile.cluster, areas: profile.areas, typical: typicalCounts(profile.mean_counts, categories) }
        : null,
      clusterSizes: clusterSizes(snapshot.clusters),
      clusterBasis: snapshot.clusterBasis,
      routingCoverage,
      limitations: snapshot.provenance.limitations,
      scoreFormula: snapshot.scoreFormula,
      fetchedAt: snapshot.provenance.fetchedAt,
    });
  });
}
