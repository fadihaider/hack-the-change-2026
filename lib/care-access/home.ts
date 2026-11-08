// pure helpers for the care recipient's view of the care access snapshot: find her community, the closest place of
// each kind, and the fixed access-group profile in plain fields. no io, so the route and the tests share them.
import type { AccessArea, AccessResource } from "./engine.ts";

/** drive-time windows the home view accepts, in minutes */
export const HOME_THRESHOLDS = [10, 15, 20, 30, 45] as const;
export const DEFAULT_HOME_THRESHOLD = 20;
/** when a community's driving routes are incomplete, places are counted within this straight-line radius instead */
export const PROXIMITY_FALLBACK_KM = 3;

export type HomePoint = { community: string | null; lat: number | null; lng: number | null };
export type HomeAreaMatch = { index: number; matchedBy: "name" | "nearest" };
export type Closest = { resource: AccessResource; cost: number };
export type TypicalCount = { category: string; minutes: number; mean: number };

/** the threshold query value, or null when it is not one of HOME_THRESHOLDS; absent means the default */
export function parseHomeThreshold(value: string | null): number | null {
  if (value === null) return DEFAULT_HOME_THRESHOLD;
  if (!/^\d{1,3}$/.test(value)) return null;
  const minutes = Number(value);
  return (HOME_THRESHOLDS as readonly number[]).includes(minutes) ? minutes : null;
}

/** "DOWNTOWN EAST VILLAGE" and " Downtown  East Village" are the same community */
export function communityKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleUpperCase("en-CA");
}

/** index of the area whose name matches the community, ignoring case and spacing; -1 when none does */
export function areaIndexByName(areas: readonly Pick<AccessArea, "name">[], community: string | null): number {
  if (!community || !community.trim()) return -1;
  const key = communityKey(community);
  return areas.findIndex((area) => communityKey(area.name) === key);
}

const EARTH_KM = 6371.0088;

/** great-circle distance in km */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** index of the area whose representative point is closest to the point; -1 when no area has a usable point */
export function nearestAreaIndex(
  areas: readonly Pick<AccessArea, "lat" | "lon">[],
  point: { lat: number; lng: number },
): number {
  let best = -1;
  let bestKm = Number.POSITIVE_INFINITY;
  areas.forEach((area, index) => {
    if (!Number.isFinite(area.lat) || !Number.isFinite(area.lon)) return;
    const km = haversineKm(point, { lat: area.lat, lng: area.lon });
    if (km < bestKm) {
      bestKm = km;
      best = index;
    }
  });
  return best;
}

/** her community by name first, else the area nearest her home point, else null */
export function resolveHomeArea(areas: readonly AccessArea[], home: HomePoint): HomeAreaMatch | null {
  const byName = areaIndexByName(areas, home.community);
  if (byName >= 0) return { index: byName, matchedBy: "name" };
  if (home.lat !== null && home.lng !== null && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
    const nearest = nearestAreaIndex(areas, { lat: home.lat, lng: home.lng });
    if (nearest >= 0) return { index: nearest, matchedBy: "nearest" };
  }
  return null;
}

/**
 * the lowest-cost place of each kind from one community's row of the cost matrix (minutes or km), whether or not it
 * is inside the travel window. null for a kind with no place of known cost.
 */
export function nearestByCategory(
  resources: readonly AccessResource[],
  costs: ReadonlyArray<number | null>,
  categories: readonly string[],
): Record<string, Closest | null> {
  const best = new Map<string, Closest | null>(categories.map((category) => [category, null]));
  resources.forEach((resource, index) => {
    if (!best.has(resource.category)) return;
    const cost = costs[index];
    if (cost === null || cost === undefined || !Number.isFinite(cost)) return;
    const current = best.get(resource.category);
    if (!current || cost < current.cost) best.set(resource.category, { resource, cost });
  });
  return Object.fromEntries(best);
}

/** the service types the selected classifier was trained on, from the snapshot benchmark; null when not listed */
export function classifierLabels(classification: {
  selected_model: string;
  results: ReadonlyArray<object>;
}): ReadonlySet<string> | null {
  const selected = classification.results.find(
    (result) => (result as { model?: unknown }).model === classification.selected_model,
  ) as { labels?: unknown } | undefined;
  const labels = selected?.labels;
  if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => typeof label === "string")) return null;
  return new Set(labels as string[]);
}

/**
 * the model's type for a place when it differs from the published one, and only when the published type is one the
 * model could have predicted. city libraries, community centres and programs are outside its label set, so a
 * "suggestion" for them is noise, not a disagreement, and could read as a claim about services.
 */
export function modelSuggestion(
  resource: Pick<AccessResource, "category" | "modelCategory">,
  labels: ReadonlySet<string> | null,
): string | null {
  if (!labels || !labels.has(resource.category)) return null;
  if (!resource.modelCategory || resource.modelCategory === resource.category) return null;
  return resource.modelCategory;
}

/** "Health Centre_30min" is { category: "Health Centre", minutes: 30 }; null for any other shape */
export function parseProfileKey(key: string): { category: string; minutes: number } | null {
  const match = /^(.+)_(\d{1,3})min$/.exec(key);
  if (!match) return null;
  return { category: match[1], minutes: Number(match[2]) };
}

/** a group profile's mean counts as plain rows, in the given category order */
export function typicalCounts(meanCounts: Record<string, number>, order: readonly string[]): TypicalCount[] {
  const rows: TypicalCount[] = [];
  for (const [key, mean] of Object.entries(meanCounts)) {
    const parsed = parseProfileKey(key);
    if (parsed && Number.isFinite(mean)) rows.push({ ...parsed, mean });
  }
  const rank = (category: string) => {
    const at = order.indexOf(category);
    return at < 0 ? order.length : at;
  };
  return rows.sort((a, b) => rank(a.category) - rank(b.category));
}

/** how many communities fall in each fitted group, in group order; unassigned communities are left out */
export function clusterSizes(clusters: ReadonlyArray<number | null>): { cluster: number; areas: number }[] {
  const counts = new Map<number, number>();
  for (const cluster of clusters) {
    if (cluster === null || cluster < 0) continue;
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([cluster, areas]) => ({ cluster, areas }));
}
