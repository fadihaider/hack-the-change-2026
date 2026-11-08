// GET /api/care-access/nearby (PRD 10, AC9): query parsing, the origin point and the response for the resource cards
// and the inline map. every place comes from the resource table with its real coordinates, source and fetch date;
// distances are straight lines, never drive or transit times. the origin is rounded and labelled approximate.
import "server-only";
import type { SqlRunner } from "../db.ts";
import type { NearbyType, NearbyView } from "../frontend/live-api.ts";
import {
  communityAt,
  communityOutlines,
  countingRadiusM,
  geocode,
  GUIDE_MESSAGES,
  isInCalgary,
  nearbyResources,
  SERVICE_TYPE_IDS,
  SERVICE_TYPES,
  type GeocodeFailure,
  type GeoPoint,
  type ResourceOptions,
  type ServiceType,
} from "../mvp/resources.ts";
import { boundsAround, KM_PER_DEGREE, ringsIntersect, ringsOfGeometry, roundTo, type Bounds } from "./geometry.ts";
import { loadAccessSnapshot } from "./snapshot.ts";

export const NEARBY_RADII_KM = [1, 2, 3, 5] as const;
export type NearbyRadiusKm = (typeof NEARBY_RADII_KM)[number];
export type NearbyAccessible = "any" | "yes";

/** every service type except transit, which is opt-in */
export const DEFAULT_NEARBY_TYPES: readonly ServiceType[] = SERVICE_TYPE_IDS.filter((type) => type !== "transit");
export const MAX_NEARBY_ADDRESS = 200;
const DEFAULT_RADIUS_KM: NearbyRadiusKm = 3;
const DEFAULT_PER_TYPE = 4;
const PER_TYPE = /^[1-8]$/;
const METERS_PER_KM = 1000;
const ORIGIN_DIGITS = 3; // about 100 m
const POINT_DIGITS = 6;
const DISTANCE_DIGITS = 2;
const OUTLINE_DIGITS = 5;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// the client contract (lib/frontend/live-api.ts NEARBY_TYPES) and the server table must name the same types
const TYPE_TABLE: Record<NearbyType, (typeof SERVICE_TYPES)[ServiceType]> = SERVICE_TYPES;

export interface NearbyQuery {
  types: ServiceType[];
  radiusKm: NearbyRadiusKm;
  accessible: NearbyAccessible;
  perType: number;
  /** a typed Calgary address; null means the care recipient's stored home point */
  address: string | null;
}

function isServiceType(value: string): value is ServiceType {
  return Object.hasOwn(SERVICE_TYPES, value);
}

/**
 * Validates the query string: types (comma list, default every type except transit), radiusKm 1|2|3|5 (default 3),
 * accessible any|yes (default any), perType 1 to 8 (default 4), address (optional, at most 200 characters).
 * Returns null for anything else, which the route answers as 400 invalid_input.
 */
export function parseNearbyQuery(params: URLSearchParams): NearbyQuery | null {
  let types = [...DEFAULT_NEARBY_TYPES];
  const typesParam = params.get("types");
  if (typesParam !== null) {
    const list = typesParam.split(",").map((item) => item.trim());
    if (list.length === 0 || list.length > SERVICE_TYPE_IDS.length) return null;
    if (!list.every(isServiceType)) return null;
    types = [...new Set(list)];
  }

  const radiusParam = params.get("radiusKm");
  const radiusKm = radiusParam === null ? DEFAULT_RADIUS_KM : NEARBY_RADII_KM.find((km) => String(km) === radiusParam);
  if (radiusKm === undefined) return null;

  const accessible = params.get("accessible") ?? "any";
  if (accessible !== "any" && accessible !== "yes") return null;

  const perTypeParam = params.get("perType");
  if (perTypeParam !== null && !PER_TYPE.test(perTypeParam)) return null;
  const perType = perTypeParam === null ? DEFAULT_PER_TYPE : Number(perTypeParam);

  const address = params.get("address")?.trim() ?? "";
  if (address.length > MAX_NEARBY_ADDRESS) return null;

  return { types, radiusKm, accessible, perType, address: address || null };
}

export type NearbyOrigin =
  | { ok: true; point: GeoPoint; community: string; label: string; fromAddress: boolean }
  | { ok: false; reason: GeocodeFailure | "missing_location"; message: string };

/** "Rosa’s" */
function possessive(name: string): string {
  return `${name}’s`;
}

/**
 * The point to measure from: the typed address (geocoded exactly as the U8 guide does) or the stored home point.
 * A point outside every Calgary community is outside_calgary.
 */
export async function resolveNearbyOrigin(
  db: SqlRunner,
  input: { address: string | null; home: { lat: number | null; lng: number | null }; name: string },
  options: ResourceOptions = {},
): Promise<NearbyOrigin> {
  let point: GeoPoint;
  let label: string;
  if (input.address) {
    const found = await geocode(db, input.address, options);
    if (!found.ok) return { ok: false, reason: found.reason, message: GUIDE_MESSAGES[found.reason] };
    point = found.point;
    label = "The address you entered (approximate)";
  } else {
    const { lat, lng } = input.home;
    if (lat === null || lng === null) {
      return { ok: false, reason: "missing_location", message: GUIDE_MESSAGES.missing_location };
    }
    point = { lat, lng };
    label = `${possessive(input.name)} home (approximate)`;
  }
  const community = isInCalgary(point) ? await communityAt(db, point) : null;
  if (!community) return { ok: false, reason: "outside_calgary", message: GUIDE_MESSAGES.outside_calgary };
  return { ok: true, point, community, label, fromAddress: Boolean(input.address) };
}

/** City community outlines over the map; the public care-access snapshot's areas when PostGIS can't return GeoJSON */
async function outlinesFor(db: SqlRunner, bounds: Bounds): Promise<NearbyView["outlines"]> {
  try {
    const rows = await communityOutlines(db, bounds);
    return rows.filter((row) => row.rings.length > 0).map((row) => ({ name: row.name, rings: row.rings }));
  } catch {
    // fall through to the snapshot below
  }
  try {
    const snapshot = await loadAccessSnapshot();
    return snapshot.areas
      .map((area) => ({ name: area.name, rings: ringsOfGeometry(area.geometry, OUTLINE_DIGITS) }))
      .filter((area) => area.rings.length > 0 && ringsIntersect(area.rings, bounds));
  } catch {
    // no basemap at all; the cards and markers still carry real coordinates
    return [];
  }
}

function fetchedOn(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function limitsFor(input: {
  origin: { fromAddress: boolean; name: string };
  resources: NearbyView["resources"];
  accessibleOnly: boolean;
  excludedUnknownAccess: number;
}): string[] {
  const from = input.origin.fromAddress ? "the address you entered" : `${possessive(input.origin.name)} home`;
  const limits = [
    `Distances are straight lines from ${from}, not drive, walk or transit times.`,
    "Transit routes and trip times aren’t calculated.",
    "Hours, step-free access and capacity are often not listed. Unknown means the source doesn’t say, not that a place is closed or not accessible.",
    "Open now and closed now come from the listed hours only. Call ahead before you go.",
  ];
  const dates = [...new Set(input.resources.map((resource) => resource.fetchedAt))].sort();
  if (dates[0]) limits.push(`These lists were fetched on ${fetchedOn(dates[0])}. Places can close or move.`);
  if (input.resources.some((resource) => resource.type === "hospital" && !resource.withinRadius)) {
    limits.push("No hospital is inside the chosen distance, so the nearest one is shown and marked as outside it.");
  }
  if (input.accessibleOnly) {
    const n = input.excludedUnknownAccess;
    limits.push(
      `Only places whose source lists wheelchair access are shown. ${n} ${n === 1 ? "place" : "places"} with unknown ` +
        `access ${n === 1 ? "is" : "are"} left out; unknown isn’t the same as not accessible.`,
    );
  }
  return limits;
}

/** the nearby response (lib/frontend/live-api.ts nearbySchema) for a resolved origin */
export async function buildNearby(
  db: SqlRunner,
  input: {
    origin: { point: GeoPoint; community: string; label: string; fromAddress: boolean };
    /** the care recipient's name for the caveats, e.g. "Rosa" */
    name: string;
    query: NearbyQuery;
    now: Date;
  },
): Promise<NearbyView> {
  const { origin, query } = input;
  const result = await nearbyResources(db, origin.point, {
    types: query.types,
    radiusM: query.radiusKm * METERS_PER_KM,
    perType: query.perType,
    accessibleOnly: query.accessible === "yes",
    now: input.now,
  });

  const resources: NearbyView["resources"] = result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    typeLabel: TYPE_TABLE[row.type].one,
    kind: row.kind,
    name: row.name,
    address: row.address,
    lat: roundTo(row.lat, POINT_DIGITS),
    lon: roundTo(row.lng, POINT_DIGITS),
    distanceKm: roundTo(row.meters / METERS_PER_KM, DISTANCE_DIGITS),
    withinRadius: row.withinRadius,
    phone: row.phone,
    hours: { text: row.openingHours, status: row.openStatus },
    wheelchair: row.access,
    source: row.source,
    sourceUrl: row.sourceUrl,
    license: row.license,
    fetchedAt: ISO_DATE.test(row.fetchedAt) ? row.fetchedAt : row.fetchedAt.slice(0, 10),
  }));

  const shown = { lat: roundTo(origin.point.lat, ORIGIN_DIGITS), lon: roundTo(origin.point.lng, ORIGIN_DIGITS) };
  // the inline map always shows the whole chosen distance around home, so the basemap covers that circle too
  const dLat = query.radiusKm / KM_PER_DEGREE;
  const dLon = query.radiusKm / (KM_PER_DEGREE * Math.max(0.1, Math.cos((shown.lat * Math.PI) / 180)));
  const circle = [
    { lat: shown.lat + dLat, lon: shown.lon },
    { lat: shown.lat - dLat, lon: shown.lon },
    { lat: shown.lat, lon: shown.lon + dLon },
    { lat: shown.lat, lon: shown.lon - dLon },
  ];
  const bounds = boundsAround([shown, ...circle, ...resources]);
  const counts = query.types.map((type) => ({
    type,
    label: TYPE_TABLE[type].label,
    shown: resources.filter((resource) => resource.type === type).length,
    withinRadius: result.withinCounts[type],
    // the real counting distance, which is shorter than the chosen one for transit stops (800 m)
    withinKm: countingRadiusM(type, query.radiusKm * METERS_PER_KM) / METERS_PER_KM,
  }));

  return {
    origin: { ...shown, label: origin.label, community: origin.community, approximate: true },
    radiusKm: query.radiusKm,
    method: "straight_line",
    resources,
    outlines: await outlinesFor(db, bounds),
    bounds,
    counts,
    limits: limitsFor({
      origin: { fromAddress: origin.fromAddress, name: input.name },
      resources,
      accessibleOnly: query.accessible === "yes",
      excludedUnknownAccess: result.excludedUnknownAccess,
    }),
  };
}
