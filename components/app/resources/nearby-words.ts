// words and flat-map geometry for the nearby places cards and their map. pure: no react, no network, no css.
import type { NearbyResourceView, NearbyType, NearbyView } from "@/lib/frontend/live-api.ts";

export const RADIUS_CHOICES = [1, 2, 3, 5] as const;
export type RadiusKm = (typeof RADIUS_CHOICES)[number];

/** the chip label, then the singular and plural words used in sentences */
export const TYPE_WORDS: Record<NearbyType, { label: string; one: string; many: string }> = {
  pharmacy: { label: "Pharmacies", one: "pharmacy", many: "pharmacies" },
  clinic: { label: "Clinics and doctors", one: "clinic", many: "clinics and doctors’ offices" },
  hospital: { label: "Hospitals", one: "hospital", many: "hospitals" },
  public_health: { label: "Public-health clinics", one: "public-health clinic", many: "public-health clinics" },
  social_support: { label: "Social support centres", one: "social support centre", many: "social support centres" },
  community_centre: { label: "Community centres", one: "community centre", many: "community centres" },
  library: { label: "Libraries", one: "library", many: "libraries" },
  transit: { label: "Transit stops", one: "transit stop", many: "transit stops" },
};

/** the type shown on a card, e.g. "Pharmacy" or "Doctor’s office" */
export function typeText(resource: Pick<NearbyResourceView, "type" | "kind">): string {
  if (resource.type === "clinic" && resource.kind === "doctors") return "Doctor’s office";
  return capitalise(TYPE_WORDS[resource.type]?.one ?? resource.type.replace(/_/g, " "));
}

export function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function joinWords(words: string[], last: "and" | "or" = "and"): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

/** "under 0.1 km", "0.4 km", "1.2 km", "12 km" */
export function kmText(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "Unknown distance";
  if (km < 0.1) return "under 0.1 km";
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** "1.2 km straight-line", never a drive or walking time */
export function distanceText(km: number): string {
  const text = kmText(km);
  return text === "Unknown distance" ? text : `${text} straight-line`;
}

/** the listed hours, or Unknown; open or closed only when the listed hours say so */
export function hoursText(hours: NearbyResourceView["hours"]): { text: string; status: string | null } {
  const text = hours.text?.trim() ? hours.text.trim() : "Hours unknown";
  if (hours.status === "open") return { text, status: "Open now by the listed hours" };
  if (hours.status === "closed") return { text, status: "Closed now by the listed hours" };
  return { text, status: null };
}

/** step-free access as the source lists it; a missing tag is Unknown, never "no" */
export function wheelchairText(value: NearbyResourceView["wheelchair"]): string {
  if (value === "yes") return "Yes, per the source";
  if (value === "limited") return "Limited, per the source";
  if (value === "no") return "No, per the source";
  return "Unknown";
}

/** "Nov 7, 2026" for the date part of a fetched-at value; null when there is none */
export function checkedOn(value: string): string | null {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  if (!day) return null;
  const ms = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    ms,
  );
}

/** digits for a tel: link, or null when the listed phone isn't a dialable number */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  return /^\+?\d{3,15}$/.test(digits) ? `tel:${digits}` : null;
}

/** "Rosa’s home (approximate)": the server's label, with "approximate" added when the point is rounded */
export function originText(origin: NearbyView["origin"]): string {
  const label = origin.label.trim() || "Home";
  return origin.approximate && !/approximate/i.test(label) ? `${label} (approximate)` : label;
}

const OPEN_RANK = { open: 0, unknown: 1, closed: 2 } as const;

/**
 * the reading order of the cards, which is also the marker numbering: the closest of each kind first, then the
 * second closest of each kind, and so on. places inside the chosen distance come before ones outside it.
 * openFirst puts pharmacies open now by their listed hours ahead of unknown, then closed (as /api/guide did).
 */
export function orderResources(
  resources: readonly NearbyResourceView[],
  options: { openFirst?: boolean } = {},
): NearbyResourceView[] {
  const byType = new Map<string, NearbyResourceView[]>();
  for (const resource of resources) {
    const list = byType.get(resource.type) ?? [];
    list.push(resource);
    byType.set(resource.type, list);
  }
  const rounds: NearbyResourceView[][] = [];
  for (const list of byType.values()) {
    list.sort((a, b) => {
      if (options.openFirst && a.type === "pharmacy") {
        const open = OPEN_RANK[a.hours.status] - OPEN_RANK[b.hours.status];
        if (open !== 0) return open;
      }
      return a.distanceKm - b.distanceKm;
    });
    list.forEach((resource, rank) => {
      rounds[rank] ??= [];
      rounds[rank].push(resource);
    });
  }
  const ordered: NearbyResourceView[] = [];
  for (const round of rounds) {
    round.sort((a, b) => Number(b.withinRadius) - Number(a.withinRadius) || a.distanceKm - b.distanceKm);
    ordered.push(...round);
  }
  // one card per id, so every marker maps to exactly one card
  const seen = new Set<string>();
  return ordered.filter((resource) => (seen.has(resource.id) ? false : (seen.add(resource.id), true)));
}

/** one plain sentence about what is within the chosen distance, from the server's counts */
export function summaryText(data: Pick<NearbyView, "counts" | "radiusKm">, stepFreeOnly: boolean): string {
  const within = `Within ${data.radiusKm} km in a straight line`;
  const parts = data.counts.map((count) => {
    const words = TYPE_WORDS[count.type];
    const many = words?.many ?? count.label.toLowerCase();
    if (count.withinRadius === 0) return `no ${many}`;
    return `${count.withinRadius} ${count.withinRadius === 1 ? (words?.one ?? many) : many}`;
  });
  const access = stepFreeOnly ? " with step-free access listed by the source" : "";
  if (parts.length === 0) return `${within}: nothing on these lists${access}.`;
  return `${within}${access}: ${joinWords(parts)}.`;
}

/** the empty-state sentence: never a placeholder point, always a next step */
export function emptyText(types: readonly NearbyType[], radiusKm: number, stepFreeOnly: boolean): string {
  const kinds = joinWords(
    types.map((type) => TYPE_WORDS[type]?.many ?? type),
    "or",
  );
  if (stepFreeOnly) {
    return `No ${kinds} within ${radiusKm} km have step-free access listed by the source. Unknown isn’t the same as not accessible, so try turning this off.`;
  }
  return `No ${kinds} within ${radiusKm} km in these public lists. Try a longer distance.`;
}

// ---------------------------------------------------------------- flat map geometry

export type Bounds = { west: number; south: number; east: number; north: number };
export type Projection = {
  width: number;
  height: number;
  x: (lon: number) => number;
  y: (lat: number) => number;
  /** screen units per kilometre, the same east-west and north-south */
  pxPerKm: number;
};

const KM_PER_DEGREE_LAT = 111.2;

function finitePoint(point: { lat: number; lon: number }): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && Math.abs(point.lat) <= 90;
}

/** a box around the points, padded, and never narrower than minSpanKm so one point still makes a readable map */
export function boundsAround(
  points: readonly { lat: number; lon: number }[],
  options: { padRatio?: number; minSpanKm?: number } = {},
): Bounds | null {
  const usable = points.filter(finitePoint);
  if (usable.length === 0) return null;
  const pad = options.padRatio ?? 0.12;
  const minSpanKm = options.minSpanKm ?? 1.5;
  let west = Math.min(...usable.map((p) => p.lon));
  let east = Math.max(...usable.map((p) => p.lon));
  let south = Math.min(...usable.map((p) => p.lat));
  let north = Math.max(...usable.map((p) => p.lat));
  const midLat = (south + north) / 2;
  const cos = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
  const minLat = minSpanKm / KM_PER_DEGREE_LAT;
  const minLon = minSpanKm / (KM_PER_DEGREE_LAT * cos);
  if (north - south < minLat) {
    const mid = (north + south) / 2;
    south = mid - minLat / 2;
    north = mid + minLat / 2;
  }
  if (east - west < minLon) {
    const mid = (east + west) / 2;
    west = mid - minLon / 2;
    east = mid + minLon / 2;
  }
  const padLat = (north - south) * pad;
  const padLon = (east - west) * pad;
  return { west: west - padLon, south: south - padLat, east: east + padLon, north: north + padLat };
}

/**
 * equirectangular with cos(mid latitude), the same flat method as the /care/access explorer. the bounds are centred
 * and scaled to fit inside width x height without stretching, so the box shows a little more than the bounds.
 */
export function fitProjection(bounds: Bounds, width: number, height: number, pad = 24): Projection {
  const midLat = (bounds.south + bounds.north) / 2;
  const cos = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
  const spanX = Math.max(1e-9, (bounds.east - bounds.west) * cos);
  const spanY = Math.max(1e-9, bounds.north - bounds.south);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const midX = ((bounds.west + bounds.east) / 2) * cos;
  const midY = midLat;
  return {
    width,
    height,
    x: (lon: number) => width / 2 + (lon * cos - midX) * scale,
    y: (lat: number) => height / 2 - (lat - midY) * scale,
    pxPerKm: scale / KM_PER_DEGREE_LAT,
  };
}

/** an svg path for lon/lat rings; rings with fewer than 3 usable points are skipped */
export function ringsPath(rings: readonly (readonly (readonly [number, number])[])[], projection: Projection): string {
  return rings
    .map((ring) => {
      const points = ring.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (points.length < 3) return "";
      return `M${points.map(([lon, lat]) => `${projection.x(lon).toFixed(1)},${projection.y(lat).toFixed(1)}`).join("L")}Z`;
    })
    .join("");
}

/** "250 m" or "2 km" for the scale bar */
export function scaleText(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`;
}

/** a round number of kilometres for the scale bar, about a fifth of the map wide */
export function scaleBarKm(projection: Projection): number {
  const target = projection.width / 5 / projection.pxPerKm;
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20];
  return steps.reduce((best, step) => (Math.abs(step - target) < Math.abs(best - target) ? step : best), steps[0]);
}
