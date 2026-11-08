// pure map geometry shared by the nearby route and the inline map (PRD 10.2): bounds, an equirectangular fit and svg
// paths. it uses the same flat lon x cos(mid latitude) projection as the /care/access explorer, so both maps match.
// no server-only, zod or dom imports, so the browser and node tests can both use it.

/** [longitude, latitude], as in GeoJSON */
export type LonLat = [number, number];

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Projection {
  width: number;
  height: number;
  x(lon: number): number;
  y(lat: number): number;
  /** svg units per straight-line kilometre, the same along both axes */
  pxPerKm: number;
}

/** kilometres per degree of latitude (mean earth radius); close enough for a city-scale map */
export const KM_PER_DEGREE = 111.32;
const DEFAULT_PAD_RATIO = 0.12;
const DEFAULT_MIN_SPAN_KM = 1.5;
const DEFAULT_WIDTH = 640;
const DEFAULT_PAD = 16;
const BOUNDS_DIGITS = 5;
const PATH_DIGITS = 1;
const MIN_RING_POINTS = 3;
const RADIANS_PER_DEGREE = Math.PI / 180;

/** the City of Calgary extent, used only when there is no point to frame */
const CALGARY_EXTENT: Bounds = { west: -114.32, south: 50.84, east: -113.85, north: 51.22 };

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function lonScale(midLat: number): number {
  return Math.cos(midLat * RADIANS_PER_DEGREE);
}

function isFinitePoint(point: LatLon): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon);
}

/**
 * Bounds around the finite points, padded on every side by padRatio of the span, and at least minSpanKm wide and tall
 * so a single point still gives a readable map. NaN and infinite points are skipped. With no usable point, the
 * Calgary extent is returned rather than an invented location.
 */
export function boundsAround(
  points: readonly LatLon[],
  opts: { padRatio?: number; minSpanKm?: number } = {},
): Bounds {
  const padRatio = opts.padRatio ?? DEFAULT_PAD_RATIO;
  const minSpanKm = opts.minSpanKm ?? DEFAULT_MIN_SPAN_KM;
  const usable = points.filter(isFinitePoint);
  if (usable.length === 0) return { ...CALGARY_EXTENT };

  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const point of usable) {
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
    west = Math.min(west, point.lon);
    east = Math.max(east, point.lon);
  }

  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;
  const minLatSpan = minSpanKm / KM_PER_DEGREE;
  const minLonSpan = minSpanKm / (KM_PER_DEGREE * lonScale(midLat));
  const latSpan = Math.max(north - south, minLatSpan);
  const lonSpan = Math.max(east - west, minLonSpan);
  const halfLat = latSpan / 2 + latSpan * padRatio;
  const halfLon = lonSpan / 2 + lonSpan * padRatio;
  return {
    west: roundTo(midLon - halfLon, BOUNDS_DIGITS),
    south: roundTo(midLat - halfLat, BOUNDS_DIGITS),
    east: roundTo(midLon + halfLon, BOUNDS_DIGITS),
    north: roundTo(midLat + halfLat, BOUNDS_DIGITS),
  };
}

/**
 * Fits the bounds into an svg `width` units wide with `pad` units of margin; the height follows the bounds' shape.
 * North is up (smaller y). Longitude is scaled by cos(mid latitude) so distances read the same in both directions.
 */
export function fitProjection(b: Bounds, width = DEFAULT_WIDTH, pad = DEFAULT_PAD): Projection {
  const midLat = (b.south + b.north) / 2;
  const scaleX = lonScale(midLat);
  const spanX = Math.max((b.east - b.west) * scaleX, Number.EPSILON);
  const spanY = Math.max(b.north - b.south, Number.EPSILON);
  const inner = Math.max(width - 2 * pad, 1);
  const scale = inner / spanX;
  const height = Math.ceil(spanY * scale + 2 * pad);
  return {
    width,
    height,
    x: (lon: number) => pad + (lon - b.west) * scaleX * scale,
    y: (lat: number) => pad + (b.north - lat) * scale,
    pxPerKm: scale / KM_PER_DEGREE,
  };
}

/** an svg path of closed rings ("M x,y L x,y ... Z"); rings with fewer than 3 usable points are skipped */
export function ringsPath(rings: readonly (readonly LonLat[])[], p: Pick<Projection, "x" | "y">): string {
  const parts: string[] = [];
  for (const ring of rings) {
    const points = ring.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (points.length < MIN_RING_POINTS) continue;
    const coords = points.map(([lon, lat]) => `${roundTo(p.x(lon), PATH_DIGITS)},${roundTo(p.y(lat), PATH_DIGITS)}`);
    parts.push(`M${coords[0]}L${coords.slice(1).join("L")}Z`);
  }
  return parts.join("");
}

/** every ring (outer and holes) of a GeoJSON Polygon or MultiPolygon; anything else gives no rings */
export function ringsOfGeometry(geometry: unknown, digits?: number): LonLat[][] {
  if (!geometry || typeof geometry !== "object") return [];
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(coordinates)) return [];
  const polygons = type === "Polygon" ? [coordinates] : type === "MultiPolygon" ? coordinates : [];
  const rings: LonLat[][] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    for (const ring of polygon) {
      if (!Array.isArray(ring)) continue;
      const points: LonLat[] = [];
      for (const point of ring) {
        if (!Array.isArray(point)) continue;
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        points.push(digits === undefined ? [lon, lat] : [roundTo(lon, digits), roundTo(lat, digits)]);
      }
      if (points.length >= MIN_RING_POINTS) rings.push(points);
    }
  }
  return rings;
}

/** whether the rings' bounding box overlaps the bounds */
export function ringsIntersect(rings: readonly (readonly LonLat[])[], b: Bounds): boolean {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  if (!Number.isFinite(west)) return false;
  return west <= b.east && east >= b.west && south <= b.north && north >= b.south;
}
