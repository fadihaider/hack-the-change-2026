// shared pieces for the care access views: the home api client, the snapshot loader, map geometry, colours and words
import { z } from "zod";
import { SERVICE_CATEGORIES, SERVICE_NAMES, type AccessArea, type AccessSnapshot } from "@/lib/care-access/engine.ts";
import { liveErrorMessage } from "@/lib/frontend/live-api.ts";
import { createCaller, RequestApiError } from "@/lib/frontend/request-api.ts";

export const CATEGORIES: readonly string[] = SERVICE_CATEGORIES;

// ---------------------------------------------------------------- words

const KIND: Record<string, { one: string; many: string }> = {
  Pharmacy: { one: "pharmacy", many: "pharmacies" },
  "Health Centre": { one: "health centre", many: "health centres" },
  Hospital: { one: "hospital", many: "hospitals" },
  "PHS Clinic": { one: "public-health clinic", many: "public-health clinics" },
  "Social Dev Ctr": { one: "social support centre", many: "social support centres" },
  "Community Centre": { one: "community centre", many: "community centres" },
  Library: { one: "library", many: "libraries" },
};

/** "Pharmacies", for a list heading */
export function kindTitle(category: string): string {
  return SERVICE_NAMES[category] ?? category;
}

/** "pharmacy" or "pharmacies", for a sentence */
export function kindWord(category: string, count: number): string {
  const word = KIND[category];
  if (!word) return category;
  return count === 1 ? word.one : word.many;
}

/** "Pharmacy", the published category of one place */
export function kindLabel(category: string): string {
  const word = KIND[category]?.one;
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : category;
}

/** "a, b and c", or "a, b or c" */
export function joinWords(words: string[], last: "and" | "or" = "and"): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

export function possessive(name: string): string {
  return name.endsWith("s") ? `${name}’` : `${name}’s`;
}

export type TravelMode = "driving" | "proximity";

/** "4 min" by car, or "1.2 km" in a straight line */
export function costText(cost: number, mode: TravelMode): string {
  if (mode === "driving") {
    const minutes = Math.round(cost);
    return minutes < 1 ? "under 1 min" : `${minutes} min`;
  }
  return cost < 0.1 ? "under 0.1 km" : `${cost.toFixed(1)} km`;
}

/** "a 20-minute drive" or "3 km" */
export function windowText(threshold: number, mode: TravelMode): string {
  return mode === "driving" ? `a ${threshold}-minute drive` : `${threshold} km`;
}

/** "Nov 7, 2026" in Alberta time */
export function fetchedOn(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "an unknown date";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Etc/GMT+6",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(ms);
}

/**
 * plain names for the two fitted access groups. they are named by size, never by quality: the group numbers have no
 * better or worse order.
 */
export type GroupName = { label: string; phrase: string };

export function groupNames(sizes: { cluster: number; areas: number }[]): Map<number, GroupName> {
  if (sizes.length === 2 && sizes[0].areas !== sizes[1].areas) {
    const [larger, smaller] = [...sizes].sort((a, b) => b.areas - a.areas);
    return new Map([
      [larger.cluster, { label: "Larger group", phrase: "the larger of the two groups" }],
      [smaller.cluster, { label: "Smaller group", phrase: "the smaller of the two groups" }],
    ]);
  }
  return new Map(
    sizes.map((size, index) => [
      size.cluster,
      { label: `Group ${index + 1}`, phrase: `group ${index + 1} of ${sizes.length}` },
    ]),
  );
}

/** "about 63 pharmacies within 20 minutes, and about 9 health centres and 5 hospitals within 30 minutes" */
export function typicalText(typical: { category: string; minutes: number; mean: number }[], categories: string[]): string {
  const byWindow = new Map<number, string[]>();
  for (const row of typical) {
    if (!categories.includes(row.category)) continue;
    const count = Math.round(row.mean);
    const words = byWindow.get(row.minutes) ?? [];
    words.push(`${words.length === 0 ? "about " : ""}${count} ${kindWord(row.category, count)}`);
    byWindow.set(row.minutes, words);
  }
  const parts = [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minutes, words]) => `${joinWords(words)} within ${minutes} minutes`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- the home api

const nearestSchema = z.object({
  name: z.string(),
  address: z.string(),
  minutes: z.number().optional(),
  km: z.number().optional(),
  within: z.boolean(),
  sourceUrl: z.string(),
  source: z.string(),
  modelCategory: z.string().nullable(),
});

export const homeAccessSchema = z.object({
  area: z.object({ id: z.string(), name: z.string() }),
  matchedBy: z.enum(["name", "nearest"]),
  mode: z.enum(["driving", "proximity"]),
  unit: z.enum(["minutes", "km"]),
  threshold: z.number(),
  requestedThreshold: z.number().optional(),
  fallbackReason: z.string().optional(),
  score: z.number().nullable(),
  counts: z.record(z.string(), z.number()),
  nearest: z.record(z.string(), nearestSchema.nullable()),
  resourcesWithin: z.number(),
  cluster: z.number().nullable(),
  clusterProfile: z
    .object({
      cluster: z.number(),
      areas: z.number(),
      typical: z.array(z.object({ category: z.string(), minutes: z.number(), mean: z.number() })),
    })
    .nullable(),
  clusterSizes: z.array(z.object({ cluster: z.number(), areas: z.number() })),
  clusterBasis: z.string(),
  routingCoverage: z.number(),
  limitations: z.array(z.string()),
  scoreFormula: z.string(),
  fetchedAt: z.string(),
});

export type HomeAccess = z.infer<typeof homeAccessSchema>;
export type HomeNearest = z.infer<typeof nearestSchema>;

const call = createCaller();

export function fetchHomeAccess(threshold: number): Promise<HomeAccess> {
  return call(`/api/care-access/home?${new URLSearchParams({ threshold: String(threshold) })}`, homeAccessSchema);
}

/** what went wrong and what to do, for a failed home lookup */
export function homeErrorMessage(error: unknown, name: string): string {
  if (error instanceof RequestApiError) {
    if (error.code === "no_home_area") {
      return `${name}’s community isn’t in the Calgary community list, so nothing can be counted from it. Check her address on the start screen.`;
    }
    if (error.code === "access_snapshot_unavailable") {
      return "The Calgary care places list didn’t load on the server. Try again in a moment.";
    }
    if (error.code === "network_error") return "ReliefReady couldn’t reach its server. Check your connection, then try again.";
  }
  return liveErrorMessage(error);
}

// ---------------------------------------------------------------- the snapshot

const areaShape = z.object({
  id: z.string().max(40),
  name: z.string().max(200),
  lat: z.number(),
  lon: z.number(),
  geometry: z.object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.array(z.unknown()) }),
});

const resourceShape = z.object({
  id: z.string(),
  name: z.string().max(400),
  category: z.string(),
  modelCategory: z.string().optional(),
  address: z.string().max(400),
  sourceUrl: z.string().max(2000),
  source: z.string().max(200),
  wheelchair: z.boolean().nullable(),
  hours: z.string().nullable(),
});

const resultShape = z.object({ model: z.string(), heldout_accuracy: z.number(), heldout_macro_f1: z.number() });

const snapshotShape = z.object({
  areas: z.array(areaShape).min(1),
  resources: z.array(resourceShape).min(1),
  drivingCoverage: z.array(z.number()),
  clusters: z.array(z.number().nullable()),
  clusterBasis: z.string(),
  scoreFormula: z.string(),
  provenance: z.object({
    fetchedAt: z.string(),
    limitations: z.array(z.string()),
    sources: z.record(z.string(), z.string()),
  }),
  benchmark: z.object({
    classification: z.object({ selected_model: z.string(), results: z.array(resultShape) }),
    clustering: z.object({
      selected: z.object({ algorithm: z.string(), silhouette: z.number(), perturbation_ari: z.number(), clusters: z.number() }),
      profiles: z.array(z.object({ cluster: z.number(), areas: z.number(), mean_counts: z.record(z.string(), z.number()) })),
      accuracy_reason: z.string(),
    }),
  }),
});

function matrixFits(rows: unknown, areas: number, resources: number): boolean {
  return (
    Array.isArray(rows) &&
    rows.length === areas &&
    rows.every((row) => Array.isArray(row) && row.length === resources)
  );
}

/** the extra benchmark fields the "How this works" section reads when they are there */
export type SnapshotExtras = {
  classification: { test_rows?: number; train_rows?: number; features?: string; label_source?: string };
  clustering: { areas?: number; features?: string[] };
};

/** the public 1 MB snapshot, checked before use: rows must line up with the communities and the places */
export async function loadSnapshot(signal: AbortSignal): Promise<AccessSnapshot> {
  const response = await fetch("/care-access/snapshot.json", { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("snapshot_unavailable");
  const data: unknown = await response.json();
  const shape = snapshotShape.safeParse(data);
  if (!shape.success) throw new Error("snapshot_invalid");
  const raw = data as Record<string, unknown>;
  const areas = shape.data.areas.length;
  const resources = shape.data.resources.length;
  if (
    !matrixFits(raw.drivingMinutes, areas, resources) ||
    !matrixFits(raw.distanceKm, areas, resources) ||
    shape.data.drivingCoverage.length !== areas ||
    shape.data.clusters.length !== areas
  ) {
    throw new Error("snapshot_invalid");
  }
  // the checked object, with its extra fields kept for the method notes
  return data as AccessSnapshot;
}

// ---------------------------------------------------------------- map geometry

export type MapShape = { id: string; d: string; x: number; y: number };
export type MapLayout = { width: number; height: number; shapes: MapShape[] };

// calgary sits near 51 degrees north; this keeps east-west distances true to scale on a flat map
const LON_SCALE = Math.cos((51.05 * Math.PI) / 180);

function ringsOf(area: AccessArea): number[][][] {
  const geometry = area.geometry as { type: string; coordinates: unknown };
  if (!Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "Polygon") return geometry.coordinates as number[][][];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).flat();
  return [];
}

function usable(point: unknown): point is [number, number] {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

/** svg paths for every community, fitted to a box `width` wide; the height follows the city's shape */
export function projectAreas(areas: readonly AccessArea[], width = 1000, pad = 10): MapLayout {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const all = areas.map(ringsOf);
  for (const rings of all) {
    for (const ring of rings) {
      for (const point of ring) {
        if (!usable(point)) continue;
        const x = point[0] * LON_SCALE;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (point[1] < minY) minY = point[1];
        if (point[1] > maxY) maxY = point[1];
      }
    }
  }
  if (!Number.isFinite(minX) || maxX === minX || maxY === minY) return { width, height: width, shapes: [] };
  const scale = (width - 2 * pad) / (maxX - minX);
  const height = Math.round((maxY - minY) * scale + 2 * pad);
  const px = (lon: number) => (pad + (lon * LON_SCALE - minX) * scale).toFixed(1);
  const py = (lat: number) => (pad + (maxY - lat) * scale).toFixed(1);
  const shapes = areas.map((area, index) => {
    const d = all[index]
      .map((ring) => {
        const points = ring.filter(usable);
        if (points.length < 3) return "";
        return `M${points.map(([lon, lat]) => `${px(lon)},${py(lat)}`).join("L")}Z`;
      })
      .join("");
    return { id: area.id, d, x: Number(px(area.lon)), y: Number(py(area.lat)) };
  });
  return { width, height, shapes };
}

// ---------------------------------------------------------------- colours

/** a teal sequential scale for the 0 to 100 access metric, light to dark */
export const SCORE_STEPS = [
  { from: 0, to: 19, fill: "#d6ecee" },
  { from: 20, to: 39, fill: "#a9d6da" },
  { from: 40, to: 59, fill: "#6fb5bc" },
  { from: 60, to: 79, fill: "#2f8d96" },
  { from: 80, to: 100, fill: "#0a5f67" },
] as const;

export function scoreFill(score: number): string {
  const step = SCORE_STEPS.find((item) => score <= item.to) ?? SCORE_STEPS[SCORE_STEPS.length - 1];
  return step.fill;
}

/** two clearly different, quiet hues for the two unordered groups: a cool slate and a warm sand */
export const GROUP_FILLS = ["#7d8ca6", "#d8c398", "#a39cb8", "#9fb59a"] as const;

export function groupFill(cluster: number): string {
  return GROUP_FILLS[cluster % GROUP_FILLS.length];
}
