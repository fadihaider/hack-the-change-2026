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

/** how many colour steps the map uses between close (green) and far (red) */
export const DISTANCE_BANDS = 5;

/**
 * the colour step of a place: 0 is the closest fifth of the chosen straight-line distance (green), 4 the farthest
 * fifth (red). a place beyond the chosen distance, such as the nearest hospital, is always red.
 */
export function distanceBand(distanceKm: number, radiusKm: number, withinRadius = true): number {
  const last = DISTANCE_BANDS - 1;
  if (!withinRadius || !(radiusKm > 0) || !Number.isFinite(distanceKm)) return last;
  // a tiny allowance so a place exactly on a step (0.6 of 3 km) is not pushed down by floating point
  return Math.min(last, Math.max(0, Math.floor((distanceKm * DISTANCE_BANDS) / radiusKm + 1e-9)));
}

function stepKm(km: number): string {
  return String(Number(km.toFixed(1)));
}

/** the legend line for the colours, e.g. "Colour shows straight-line distance: green is under 0.6 km, red is 2.4 km or more." */
export function distanceScaleText(radiusKm: number): string {
  const step = radiusKm / DISTANCE_BANDS;
  return (
    `Colour shows straight-line distance: green is under ${stepKm(step)} km, ` +
    `red is ${stepKm(step * (DISTANCE_BANDS - 1))} km or more, or beyond ${stepKm(radiusKm)} km.`
  );
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

/**
 * cards on the first page: at least one of each kind, so the closest of each kind (including a nearest hospital
 * outside the chosen distance, which the limits mention) is never hidden behind "Show more"
 */
export function firstPageSize(resources: readonly Pick<NearbyResourceView, "type">[], initialVisible: number): number {
  return Math.max(initialVisible, new Set(resources.map((resource) => resource.type)).size);
}

/** "800 m" or "2 km" for a counting distance */
export function radiusText(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${Number(km.toFixed(1))} km`;
}

type CountLike = Pick<NearbyView["counts"][number], "type" | "label" | "withinRadius"> & { withinKm?: number };

/** the distance a count really covers: the server's withinKm when it is shorter (transit, 800 m), else the chosen one */
function countingKm(count: { withinKm?: number } | undefined, radiusKm: number): number {
  const km = count?.withinKm;
  return km !== undefined && Number.isFinite(km) && km > 0 && km < radiusKm ? km : radiusKm;
}

/** group items by the distance they are counted within, the chosen distance first */
function byCountingKm<T>(items: readonly T[], radiusKm: number, kmOf: (item: T) => number): [number, T[]][] {
  const groups = new Map<number, T[]>([[radiusKm, []]]);
  for (const item of items) {
    const km = kmOf(item);
    const list = groups.get(km) ?? [];
    list.push(item);
    groups.set(km, list);
  }
  return [...groups].filter(([, list]) => list.length > 0);
}

/**
 * plain sentences about what is within the chosen distance, from the server's counts. a kind counted within a
 * shorter distance (transit stops, 800 m) gets its own sentence with that distance, never the chosen one.
 */
export function summaryText(
  data: { counts: readonly CountLike[]; radiusKm: number },
  stepFreeOnly: boolean,
): string {
  const access = stepFreeOnly ? " with step-free access listed by the source" : "";
  const part = (count: CountLike) => {
    const words = TYPE_WORDS[count.type];
    const many = words?.many ?? count.label.toLowerCase();
    if (count.withinRadius === 0) return `no ${many}`;
    return `${count.withinRadius} ${count.withinRadius === 1 ? (words?.one ?? many) : many}`;
  };
  const groups = byCountingKm(data.counts, data.radiusKm, (count) => countingKm(count, data.radiusKm));
  if (groups.length === 0) return `Within ${radiusText(data.radiusKm)} in a straight line: nothing on these lists${access}.`;
  return groups
    .map(([km, counts]) => `Within ${radiusText(km)} in a straight line${access}: ${joinWords(counts.map(part))}.`)
    .join(" ");
}

/**
 * the empty-state sentence: never a placeholder point, always a next step. counts (from the response) give the real
 * counting distance per kind, so transit stops say 800 m, and a longer distance is only offered when it would help.
 */
export function emptyText(
  types: readonly NearbyType[],
  radiusKm: number,
  stepFreeOnly: boolean,
  counts: readonly Pick<CountLike, "type" | "withinKm">[] = [],
): string {
  const groups = byCountingKm(types, radiusKm, (type) =>
    countingKm(
      counts.find((count) => count.type === type),
      radiusKm,
    ),
  );
  const what = groups
    .map(([km, list], index) => {
      const kinds = joinWords(
        list.map((type) => TYPE_WORDS[type]?.many ?? type),
        "or",
      );
      return `${index === 0 ? "No" : "and no"} ${kinds} within ${radiusText(km)}`;
    })
    .join(", ");
  if (stepFreeOnly) {
    return `${what} have step-free access listed by the source. Unknown isn’t the same as not accessible, so try turning this off.`;
  }
  // a longer distance only helps a kind counted at the chosen distance, and only below the longest choice
  const longer = radiusKm < Math.max(...RADIUS_CHOICES) && groups.some(([km]) => km >= radiusKm);
  return `${what} in these public lists. ${longer ? "Try a longer distance." : "Try another kind of place."}`;
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

/**
 * the map box: the home point, the places inside the chosen distance and the whole distance circle. places outside
 * the distance (a far hospital) are left out, so they can't zoom the map out and stack the nearby markers.
 */
export function mapBounds(
  origin: { lat: number; lon: number },
  radiusKm: number,
  resources: readonly Pick<NearbyResourceView, "lat" | "lon" | "withinRadius">[],
): Bounds | null {
  const points: { lat: number; lon: number }[] = [origin, ...resources.filter((resource) => resource.withinRadius)];
  if (finitePoint(origin) && Number.isFinite(radiusKm) && radiusKm > 0) {
    const dLat = radiusKm / KM_PER_DEGREE_LAT;
    const dLon = radiusKm / (KM_PER_DEGREE_LAT * Math.max(0.1, Math.cos((origin.lat * Math.PI) / 180)));
    points.push(
      { lat: origin.lat + dLat, lon: origin.lon },
      { lat: origin.lat - dLat, lon: origin.lon },
      { lat: origin.lat, lon: origin.lon + dLon },
      { lat: origin.lat, lon: origin.lon - dLon },
    );
  }
  return boundsAround(points, { padRatio: 0.04 });
}

export type MarkerSizes = {
  /** the drawn dot */
  markerR: number;
  /** the largest click target */
  hitR: number;
  /** half the home glyph, so no marker covers it */
  homeR: number;
  /** clear space kept between markers */
  gap: number;
  /** how far in from the map edge a marker for a place beyond the map sits, with room for its arrow */
  edge: number;
};

export type PlacedMarker = {
  /** where the marker is drawn */
  x: number;
  y: number;
  /** the place's real projected point, which may be off the map */
  trueX: number;
  trueY: number;
  /** the real point is beyond the map, so the marker sits at the edge in its direction with an arrow */
  clamped: boolean;
  /** drawn away from its real point so it doesn't cover another marker; a line leads to the real point */
  moved: boolean;
  /** degrees from the drawn marker toward the real point (0 is east, 90 is south on screen) */
  angle: number;
  /** a click target that doesn't overlap the next marker's */
  hitR: number;
};

const GOLDEN_ANGLE = 2.399963;
const SETTLE_ROUNDS = 120;

/**
 * one visible, separate marker per point. a point beyond the map is pulled in along the line from home to the map
 * edge (clamped). markers that would overlap each other or the home glyph are pushed apart a little (moved), so
 * every card keeps its own marker to see and press. points keep their order: result n is point n.
 */
export function placeMarkers(
  points: readonly { x: number; y: number }[],
  home: { x: number; y: number },
  box: { width: number; height: number },
  sizes: MarkerSizes,
): PlacedMarker[] {
  const keep = sizes.markerR + 6;
  const inside = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const anchors = points.map((point) => {
    const minX = sizes.edge;
    const maxX = box.width - sizes.edge;
    const minY = sizes.edge;
    const maxY = box.height - sizes.edge;
    // a marker this far in is drawn whole, so it can sit on its real point
    if (point.x >= keep && point.x <= box.width - keep && point.y >= keep && point.y <= box.height - keep) {
      return { x: point.x, y: point.y, clamped: false };
    }
    // walk from home toward the point and stop at the edge, so the marker keeps the real direction
    const hx = inside(home.x, minX, maxX);
    const hy = inside(home.y, minY, maxY);
    const dx = point.x - hx;
    const dy = point.y - hy;
    let t = 1;
    if (dx > 0) t = Math.min(t, (maxX - hx) / dx);
    if (dx < 0) t = Math.min(t, (minX - hx) / dx);
    if (dy > 0) t = Math.min(t, (maxY - hy) / dy);
    if (dy < 0) t = Math.min(t, (minY - hy) / dy);
    return { x: inside(hx + dx * t, minX, maxX), y: inside(hy + dy * t, minY, maxY), clamped: true };
  });

  const placed = anchors.map((anchor) => ({ x: anchor.x, y: anchor.y }));
  const apart = 2 * sizes.markerR + sizes.gap;
  const fromHome = sizes.markerR + sizes.homeR + sizes.gap;
  const pin = (index: number) => {
    const pad = anchors[index].clamped ? sizes.edge : keep;
    placed[index].x = inside(placed[index].x, pad, box.width - pad);
    placed[index].y = inside(placed[index].y, pad, box.height - pad);
  };
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    let overlap = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        let dx = placed[j].x - placed[i].x;
        let dy = placed[j].y - placed[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= apart - 0.01) continue;
        overlap = true;
        if (d < 1e-6) {
          // the same spot: fan out in a fixed direction so the layout is the same on every render
          const turn = (i + j) * GOLDEN_ANGLE;
          dx = Math.cos(turn);
          dy = Math.sin(turn);
          d = 1;
        } else {
          dx /= d;
          dy /= d;
        }
        const push = (apart - Math.max(d, 0)) / 2 + 0.05;
        placed[i].x -= dx * push;
        placed[i].y -= dy * push;
        placed[j].x += dx * push;
        placed[j].y += dy * push;
        pin(i);
        pin(j);
      }
      const hx = placed[i].x - home.x;
      const hy = placed[i].y - home.y;
      const hd = Math.hypot(hx, hy);
      if (hd < fromHome - 0.01) {
        overlap = true;
        const turn = i * GOLDEN_ANGLE;
        const ux = hd < 1e-6 ? Math.cos(turn) : hx / hd;
        const uy = hd < 1e-6 ? Math.sin(turn) : hy / hd;
        placed[i].x = home.x + ux * (fromHome + 0.05);
        placed[i].y = home.y + uy * (fromHome + 0.05);
        pin(i);
      }
    }
    if (!overlap) break;
  }

  return placed.map((position, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    placed.forEach((other, j) => {
      if (j !== index) nearest = Math.min(nearest, Math.hypot(other.x - position.x, other.y - position.y));
    });
    const trueX = points[index].x;
    const trueY = points[index].y;
    return {
      x: position.x,
      y: position.y,
      trueX,
      trueY,
      clamped: anchors[index].clamped,
      moved: !anchors[index].clamped && Math.hypot(position.x - trueX, position.y - trueY) > 1.5,
      angle: (Math.atan2(trueY - position.y, trueX - position.x) * 180) / Math.PI,
      hitR: Math.max(sizes.markerR + 3, Math.min(sizes.hitR, nearest / 2)),
    };
  });
}

const COMPASS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"] as const;

/** "north-west" for a screen direction (y grows downward) */
export function compassText(dx: number, dy: number): string {
  const degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return COMPASS[((Math.round(degrees / 45) % 8) + 8) % 8];
}
