// calgary resources for the U8 start guide and C9 logistics (PRD section 6): snapshot loading, PostGIS lookups,
// opening hours, geocoding and the guide cards. every card carries its source, url and fetch date.
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ringsOfGeometry, type LonLat } from "../care-access/geometry.ts";
import { p, type Database, type Param, type SqlRunner } from "../db.ts";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type Tenure = "yes" | "no" | "not_sure";

/** resource.kind values written by loadResources */
export const RESOURCE_KINDS = [
  "hospital",
  "health_centre",
  "social_development_centre",
  "community_centre",
  "library",
  "pharmacy",
  "clinic",
  "doctors",
  "transit_stop",
  "caregiver_support",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceRow {
  id: string;
  kind: string;
  name: string;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  wheelchair: string | null;
  description: string | null;
  source: string;
  sourceUrl: string;
  license: string | null;
  fetchedAt: string;
  lat: number;
  lng: number;
  meters: number;
}

export type OpenStatus = "open" | "closed" | "unknown";

export interface PharmacyAtTime extends ResourceRow {
  status: OpenStatus;
  accessibility: string;
}

export interface LoadResult {
  resources: number;
  communities: number;
  rules: number;
}

export type GeocodeFailure = "needs_quadrant" | "not_found" | "unavailable" | "outside_calgary";

export type GeocodeResult =
  | { ok: true; address: string; point: GeoPoint; source: string; cached: boolean }
  | { ok: false; reason: GeocodeFailure; address: string };

export interface GuideCard {
  id: string;
  kind: "leave" | "ei" | "support" | "hospital" | "pharmacy" | "transit";
  title: string;
  /** plain text; never html */
  body: string;
  details: { label: string; value: string }[];
  links: { label: string; url: string }[];
  /** leave card only: a minimal-disclosure notice the user can copy or send through the approval queue */
  draftNotice?: string;
  source: string;
  sourceUrl: string;
  license: string | null;
  fetchedAt: string;
}

type CardSource = Pick<GuideCard, "source" | "sourceUrl" | "license" | "fetchedAt">;

export interface GuideInput {
  address?: string;
  point?: GeoPoint;
  /** app time (real or simulated); pharmacy hours are checked at this instant */
  now: Date;
  tenure: Tenure;
}

export type GuideResult =
  | {
      ok: true;
      location: { address: string | null; point: GeoPoint; community: string };
      tenure: Tenure;
      cards: GuideCard[];
      /** OSM credit to show on screen whenever an OSM row is shown */
      attribution: { text: string; url: string };
    }
  | { ok: false; reason: GeocodeFailure | "missing_location"; message: string };

export interface ResourceOptions {
  /** folder holding calgary/*.json, rules.json and supports.json; defaults to <cwd>/data */
  dataDir?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

// ---------- constants ----------

const OSM_SOURCE = "OpenStreetMap";
const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const OSM_CREDIT = "(c) OpenStreetMap contributors";
const ALBERTA_OFFSET_MS = 6 * 60 * 60 * 1000; // alberta time is utc-6 all year (PRD section 14)
const MINUTES_PER_DAY = 24 * 60;
const INSERT_BATCH = 500;
const HOSPITAL_RADIUS_M = 40_000;
const PHARMACY_RADIUS_M = 5_000;
const PHARMACY_CANDIDATES = 15;
const STOP_LIMIT = 3;
const STOP_RADIUS_M = 800;
const GEOCODE_TIMEOUT_MS = 5_000;
const PARCEL_API = "https://data.calgary.ca/resource/9zvu-p8uz.json";
const PARCEL_SOURCE = "City of Calgary Parcel Address";

/** city of calgary extent (IMPLEMENTATION section 5 overpass bbox); the community polygons are the exact check */
export const CALGARY_BBOX = { south: 50.84, west: -114.32, north: 51.22, east: -113.85 } as const;

const CITY_KINDS: Record<string, ResourceKind> = {
  Hospital: "hospital",
  "PHS Clinic": "health_centre",
  "Social Dev Ctr": "social_development_centre",
  "Community Centre": "community_centre",
  Library: "library",
};
const OSM_KINDS: Record<string, ResourceKind> = {
  pharmacy: "pharmacy",
  clinic: "clinic",
  doctors: "doctors",
  hospital: "hospital",
};

export const GUIDE_MESSAGES: Record<GeocodeFailure | "missing_location", string> = {
  needs_quadrant: "Add the quadrant (NE, NW, SE or SW) to the address.",
  not_found:
    "We couldn't match that address. ReliefReady covers Calgary addresses only. Check the street number and quadrant (NW, NE, SW, SE).",
  unavailable: "The address lookup is unavailable right now. Try again in a minute.",
  outside_calgary: "ReliefReady covers Calgary addresses only. Enter a Calgary address.",
  missing_location: "Enter a Calgary address.",
};

// ---------- snapshot files ----------

interface Snapshot<T> {
  source: string;
  sourceUrl: string;
  license: string;
  fetchedAt: string;
  items: T[];
}

interface CityServiceItem {
  type: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
}
interface TransitStopItem {
  id: string;
  name: string;
  lat: number;
  lng: number;
}
interface OsmItem {
  osmUrl: string;
  amenity: string;
  name: string;
  lat: number;
  lng: number;
  openingHours: string | null;
  wheelchair: string | null;
  phone: string | null;
  address: string | null;
}
interface CommunityItem {
  name: string;
  commCode: string;
  sector: string | null;
  geometry: unknown;
}
interface Persona {
  address: string;
  lat: number;
  lng: number;
  source: string;
}

export interface RuleItem {
  id: string;
  title: string;
  body: string;
  conditions: Record<string, unknown>;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface SupportItem {
  id: string;
  name: string;
  offers: string;
  phone: string | null;
  address: string | null;
  hours: string | null;
  url: string;
  source: string;
  fetchedAt: string;
}

async function readJson<T>(dataDir: string, ...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(dataDir, ...parts), "utf8")) as T;
}

function dataDirOf(options: ResourceOptions): string {
  return options.dataDir ?? path.join(process.cwd(), "data");
}

export async function loadRules(options: ResourceOptions = {}): Promise<RuleItem[]> {
  return (await readJson<{ items: RuleItem[] }>(dataDirOf(options), "rules.json")).items;
}

export async function loadSupports(options: ResourceOptions = {}): Promise<SupportItem[]> {
  return (await readJson<{ items: SupportItem[] }>(dataDirOf(options), "supports.json")).items;
}

// ---------- loading ----------

interface ResourceInsert {
  kind: ResourceKind;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  opening_hours: string | null;
  wheelchair: string | null;
  description: string | null;
  source: string;
  source_url: string;
  license: string | null;
  fetched_at: string;
}

const INSERT_RESOURCES = `INSERT INTO resource (kind, name, address, geog, phone, opening_hours, wheelchair, description,
    source, source_url, license, fetched_at)
  SELECT x.kind, x.name, x.address,
    CASE WHEN x.lat IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(x.lng, x.lat), 4326)::geography END,
    x.phone, x.opening_hours, x.wheelchair, x.description, x.source, x.source_url, x.license, CAST(x.fetched_at AS date)
  FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x(kind text, name text, address text, lat double precision,
    lng double precision, phone text, opening_hours text, wheelchair text, description text, source text,
    source_url text, license text, fetched_at text)`;

// simplified polygons can self-touch, so make them valid and keep only the polygon parts before the cast
const INSERT_COMMUNITIES = `INSERT INTO community (name, comm_code, sector, geom)
  SELECT x.name, x.comm_code, x.sector,
    ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(x.geometry::text), 4326)), 3))::geography
  FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x(name text, comm_code text, sector text, geometry jsonb)
  ON CONFLICT DO NOTHING`;

async function insertBatches(tx: SqlRunner, sql: string, rows: object[], size = INSERT_BATCH): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += size) {
    written += await tx.execute(sql, [p.text("rows", JSON.stringify(rows.slice(start, start + size)))]);
  }
  return written;
}

async function resourceRows(dataDir: string): Promise<ResourceInsert[]> {
  const city = await readJson<Snapshot<CityServiceItem>>(dataDir, "calgary", "community-services.json");
  const stops = await readJson<Snapshot<TransitStopItem>>(dataDir, "calgary", "transit-stops.json");
  const osm = await readJson<Snapshot<OsmItem>>(dataDir, "calgary", "osm-health.json");
  const supports = await loadSupports({ dataDir });
  const empty = { phone: null, opening_hours: null, wheelchair: null, description: null };

  const rows: ResourceInsert[] = [];
  for (const item of city.items) {
    const kind = CITY_KINDS[item.type];
    if (!kind) continue;
    rows.push({
      ...empty,
      kind,
      name: item.name,
      address: item.address,
      lat: item.lat,
      lng: item.lng,
      description: item.type,
      source: city.source,
      source_url: city.sourceUrl,
      license: city.license,
      fetched_at: city.fetchedAt,
    });
  }
  for (const item of stops.items) {
    rows.push({
      ...empty,
      kind: "transit_stop",
      name: item.name,
      address: null,
      lat: item.lat,
      lng: item.lng,
      description: `Stop ${item.id}`,
      source: stops.source,
      source_url: stops.sourceUrl,
      license: stops.license,
      fetched_at: stops.fetchedAt,
    });
  }
  for (const item of osm.items) {
    const kind = OSM_KINDS[item.amenity];
    if (!kind) continue;
    rows.push({
      kind,
      name: item.name,
      address: item.address,
      lat: item.lat,
      lng: item.lng,
      phone: item.phone,
      opening_hours: item.openingHours,
      wheelchair: item.wheelchair,
      description: null,
      source: osm.source,
      source_url: item.osmUrl,
      license: osm.license,
      fetched_at: osm.fetchedAt,
    });
  }
  for (const item of supports) {
    rows.push({
      ...empty,
      kind: "caregiver_support",
      name: item.name,
      address: item.address,
      lat: null,
      lng: null,
      phone: item.phone,
      description: item.offers,
      source: item.source,
      source_url: item.url,
      license: null,
      fetched_at: item.fetchedAt,
    });
  }
  return rows;
}

/**
 * Loads the committed snapshots into resource, community, rule_card and geocode_cache. Each table is filled only
 * when it is empty, so calling this on every boot is cheap. Returns the rows written by this call.
 */
export async function loadResources(db: Database, options: ResourceOptions = {}): Promise<LoadResult> {
  const dataDir = dataDirOf(options);
  const [counts] = await db.query<{ resources: number; communities: number }>(
    `SELECT (SELECT count(*) FROM resource)::int AS resources, (SELECT count(*) FROM community)::int AS communities`,
  );
  const resources = counts.resources === 0 ? await resourceRows(dataDir) : [];
  const communities =
    counts.communities === 0
      ? (await readJson<Snapshot<CommunityItem>>(dataDir, "calgary", "communities.json")).items.map((item) => ({
          name: item.name,
          comm_code: item.commCode,
          sector: item.sector,
          geometry: item.geometry,
        }))
      : [];
  const rules = await loadRules({ dataDir });
  const persona = await readJson<Persona>(dataDir, "calgary", "persona.json");

  return db.transaction(async (tx) => {
    const result: LoadResult = { resources: 0, communities: 0, rules: 0 };
    result.resources = await insertBatches(tx, INSERT_RESOURCES, resources);
    result.communities = await insertBatches(tx, INSERT_COMMUNITIES, communities, 50);
    for (const rule of rules) {
      result.rules += await tx.execute(
        `INSERT INTO rule_card (id, title, body, conditions, source_url, fetched_at)
          VALUES (:id, :title, :body, CAST(:conditions AS jsonb), :source_url, CAST(:fetched_at AS date))
          ON CONFLICT (id) DO NOTHING`,
        [
          p.text("id", rule.id),
          p.text("title", rule.title),
          p.text("body", rule.body),
          p.text("conditions", JSON.stringify(rule.conditions)),
          p.text("source_url", rule.sourceUrl),
          p.text("fetched_at", rule.fetchedAt),
        ],
      );
    }
    // the demo address resolves offline
    await cacheGeocode(tx, normalizeAddress(persona.address).address, { lat: persona.lat, lng: persona.lng }, persona.source);
    return result;
  });
}

// ---------- spatial queries ----------

function num(name: string, value: number): Param {
  return { name, value: { doubleValue: value } };
}

function pointParams(point: GeoPoint): Param[] {
  return [num("lat", point.lat), num("lng", point.lng)];
}

const POINT = "ST_SetSRID(ST_MakePoint(CAST(:lng AS double precision), CAST(:lat AS double precision)), 4326)::geography";

interface ResourceSqlRow {
  id: string;
  kind: string;
  name: string;
  address: string | null;
  phone: string | null;
  opening_hours: string | null;
  wheelchair: string | null;
  description: string | null;
  source: string;
  source_url: string;
  license: string | null;
  fetched_at: string;
  lat: number;
  lng: number;
  meters: number;
}

function toResource(row: ResourceSqlRow): ResourceRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    address: row.address,
    phone: row.phone,
    openingHours: row.opening_hours,
    wheelchair: row.wheelchair,
    description: row.description,
    source: row.source,
    sourceUrl: row.source_url,
    license: row.license,
    fetchedAt: row.fetched_at,
    lat: Number(row.lat),
    lng: Number(row.lng),
    meters: Math.round(Number(row.meters)),
  };
}

/** resources of the given kinds within radiusM of point, nearest first */
export async function nearest(
  db: SqlRunner,
  point: GeoPoint,
  kinds: readonly string[],
  limit = 5,
  radiusM = 10_000,
): Promise<ResourceRow[]> {
  const rows = await db.query<ResourceSqlRow>(
    `WITH q AS (SELECT ${POINT} AS pt)
     SELECT r.id::text AS id, r.kind, r.name, r.address, r.phone, r.opening_hours, r.wheelchair, r.description,
       r.source, r.source_url, r.license, r.fetched_at::text AS fetched_at,
       ST_Y(r.geog::geometry) AS lat, ST_X(r.geog::geometry) AS lng, ST_Distance(r.geog, q.pt) AS meters
     FROM resource r CROSS JOIN q
     WHERE r.kind = ANY(string_to_array(:kinds, ','))
       AND ST_DWithin(r.geog, q.pt, CAST(:radius_m AS double precision))
     ORDER BY ST_Distance(r.geog, q.pt), r.name
     LIMIT CAST(:max_rows AS int)`,
    [...pointParams(point), p.text("kinds", kinds.join(",")), num("radius_m", radiusM), p.int("max_rows", limit)],
  );
  return rows.map(toResource);
}

/** up to `limit` active transit stops within radiusM (PRD section 6 step 3: 3 within 800 m) */
export function nearestStops(db: SqlRunner, point: GeoPoint, limit = STOP_LIMIT, radiusM = STOP_RADIUS_M): Promise<ResourceRow[]> {
  return nearest(db, point, ["transit_stop"], limit, radiusM);
}

const STATUS_ORDER: Record<OpenStatus, number> = { open: 0, unknown: 1, closed: 2 };

/**
 * Nearby pharmacies with their status at `at` (Alberta Time): open first, then unknown hours, then closed, each nearest
 * first. Unknown or unparseable hours are "unknown", never "closed".
 */
export async function pharmaciesOpenAt(
  db: SqlRunner,
  point: GeoPoint,
  at: Date,
  radiusM = PHARMACY_RADIUS_M,
): Promise<PharmacyAtTime[]> {
  const rows = await nearest(db, point, ["pharmacy"], PHARMACY_CANDIDATES, radiusM);
  return rows
    .map((row) => ({ ...row, status: openingStatus(row.openingHours, at), accessibility: accessibilityLabel(row.wheelchair) }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.meters - b.meters);
}

/** the community whose boundary covers point, or null when the point is outside every Calgary community */
export async function communityAt(db: SqlRunner, point: GeoPoint): Promise<string | null> {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM community WHERE ST_Covers(geom, ${POINT}) ORDER BY name LIMIT 1`,
    pointParams(point),
  );
  return rows[0]?.name ?? null;
}

/** quick bounding box check; communityAt is the exact Calgary check */
export function isInCalgary(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= CALGARY_BBOX.south &&
    point.lat <= CALGARY_BBOX.north &&
    point.lng >= CALGARY_BBOX.west &&
    point.lng <= CALGARY_BBOX.east
  );
}

/** wheelchair tag to display text; a missing tag is "accessibility unknown", never "not accessible" */
export function accessibilityLabel(wheelchair: string | null): string {
  switch (wheelchair?.trim().toLowerCase()) {
    case "yes":
    case "designated":
      return "wheelchair accessible";
    case "limited":
      return "limited wheelchair access";
    case "no":
      return "not wheelchair accessible";
    default:
      return "accessibility unknown";
  }
}

// ---------- opening hours ----------

const DAY_CODES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]; // index matches Date.getUTCDay
const MONTH_CODES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = "(?:Mo|Tu|We|Th|Fr|Sa|Su)";
const DAY_ITEM = `(?:${DAY}(?:\\s*-\\s*${DAY})?|PH|SH)`;
const WEEKDAY_RULE = new RegExp(`^(${DAY_ITEM}(?:\\s*,\\s*${DAY_ITEM})*)(?:\\s+(.*))?$`);
const DATE_RULE = new RegExp(`^(${MONTH_CODES.join("|")})\\s+(\\d{1,2})(?:\\s*-\\s*(\\d{1,2}))?\\s+(.*)$`);
const TIME_RANGE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

interface HoursRule {
  /** weekdays (0 = Sunday) the rule covers; null for a date rule */
  days: Set<number> | null;
  date: { month: number; from: number; to: number } | null;
  /** minutes after local midnight; end may pass 1440 for overnight ranges; empty means closed */
  intervals: [number, number][];
}

function parseDays(selector: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of selector.split(",").map((item) => item.trim())) {
    if (part === "PH" || part === "SH") continue; // public and school holidays are not evaluated
    const [from, to = from] = part.split("-").map((item) => DAY_CODES.indexOf(item.trim()));
    if (from < 0 || to < 0) return null;
    for (let day = from; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === to) break;
    }
  }
  return days;
}

function parseIntervals(text: string): [number, number][] | null {
  const value = text.trim().toLowerCase();
  if (value === "off" || value === "closed") return [];
  const intervals: [number, number][] = [];
  for (const range of value.split(",")) {
    const match = TIME_RANGE.exec(range.trim());
    if (!match) return null;
    const start = Number(match[1]) * 60 + Number(match[2]);
    let end = Number(match[3]) * 60 + Number(match[4]);
    if (start >= MINUTES_PER_DAY || end > 2 * MINUTES_PER_DAY) return null;
    if (end <= start) end += MINUTES_PER_DAY;
    intervals.push([start, end]);
  }
  return intervals;
}

/**
 * A small parser for the common OSM opening_hours forms: "24/7", "Mo-Fr 09:00-21:00; Sa,Su 10:00-18:00",
 * "Su off", "08:00-22:00", overnight ranges and "Dec 25 off". Later rules override earlier ones for their days.
 * Public holiday rules are skipped. Returns null for anything else, which callers report as unknown.
 */
export function parseOpeningHours(text: string | null): HoursRule[] | null {
  const value = text?.trim();
  if (!value) return null;
  const rules: HoursRule[] = [];
  const parts = value
    .split(/\s*(?:;|\|\|)\s*/)
    .flatMap((part) => part.split(/(?<=\d|off|closed)\s*,\s*(?=[A-Za-z])/i))
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part === "24/7") {
      rules.push({ days: new Set([0, 1, 2, 3, 4, 5, 6]), date: null, intervals: [[0, MINUTES_PER_DAY]] });
      continue;
    }
    const dateMatch = DATE_RULE.exec(part);
    if (dateMatch) {
      const intervals = parseIntervals(dateMatch[4]);
      if (!intervals) return null;
      const from = Number(dateMatch[2]);
      rules.push({
        days: null,
        date: { month: MONTH_CODES.indexOf(dateMatch[1]), from, to: dateMatch[3] ? Number(dateMatch[3]) : from },
        intervals,
      });
      continue;
    }
    const weekdayMatch = WEEKDAY_RULE.exec(part);
    if (weekdayMatch) {
      if (!weekdayMatch[2]) return null; // a day list without times is too rare to guess
      const days = parseDays(weekdayMatch[1]);
      const intervals = parseIntervals(weekdayMatch[2]);
      if (!days || !intervals) return null;
      if (days.size > 0) rules.push({ days, date: null, intervals });
      continue;
    }
    const intervals = parseIntervals(part);
    if (!intervals) return null;
    rules.push({ days: new Set([0, 1, 2, 3, 4, 5, 6]), date: null, intervals });
  }
  return rules.length > 0 ? rules : null;
}

function intervalsOn(rules: HoursRule[], local: Date): [number, number][] {
  let current: [number, number][] = [];
  for (const rule of rules) {
    const matches = rule.date
      ? rule.date.month === local.getUTCMonth() && local.getUTCDate() >= rule.date.from && local.getUTCDate() <= rule.date.to
      : rule.days?.has(local.getUTCDay()) === true;
    if (matches) current = rule.intervals;
  }
  return current;
}

/** whether an OSM opening_hours value is open at `at`, evaluated in Alberta Time (UTC-6) */
export function openingStatus(openingHours: string | null, at: Date): OpenStatus {
  const rules = parseOpeningHours(openingHours);
  if (!rules) return "unknown";
  const local = new Date(at.getTime() - ALBERTA_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const today = intervalsOn(rules, local);
  const yesterday = intervalsOn(rules, new Date(local.getTime() - MINUTES_PER_DAY * 60_000));
  const open =
    today.some(([start, end]) => minute >= start && minute < end) ||
    yesterday.some(([start, end]) => minute + MINUTES_PER_DAY >= start && minute + MINUTES_PER_DAY < end);
  return open ? "open" : "closed";
}

// ---------- geocoding ----------

// full street type words to the parcel address dataset's street_type codes (checked against its 47 codes)
const STREET_TYPES: Record<string, string> = {
  AVENUE: "AV", AVE: "AV", BAY: "BA", BOULEVARD: "BV", BLVD: "BV", CIRCLE: "CI", CLOSE: "CL", COMMON: "CM",
  COMMONS: "CM", COURT: "CO", CRT: "CO", CT: "CO", COVE: "CV", CRESCENT: "CR", CRES: "CR", DRIVE: "DR", GARDENS: "GD",
  GATE: "GA", GREEN: "GR", GROVE: "GV", HEIGHTS: "HT", HILL: "HL", HIGHWAY: "HI", LANDING: "LD", LANE: "LN",
  LINK: "LI", MANOR: "MR", MEWS: "ME", MOUNT: "MT", PARK: "PA", PARKWAY: "PY", PATH: "PH", PLACE: "PL", PLAZA: "PZ",
  POINT: "PT", RISE: "RI", ROAD: "RD", ROW: "RO", SQUARE: "SQ", STREET: "ST", TERRACE: "TC", TRAIL: "TR", VIEW: "VW",
  WALK: "WK", WAY: "WY",
};
const QUADRANTS: Record<string, string> = {
  NE: "NE", NW: "NW", SE: "SE", SW: "SW", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};

/**
 * The City's parcel address form (IMPLEMENTATION section 5): uppercase, no periods, no unit prefix, no city or postal
 * code, numbered streets without ordinals and two-letter street types. "#203 800 3rd Street S.E., Calgary" becomes
 * "800 3 ST SE". quadrant is null when the address has none.
 */
export function normalizeAddress(input: string): { address: string; quadrant: string | null } {
  let text = input
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g, " ") // postal code
    .replace(/,/g, " ")
    .replace(/\b(CALGARY|ALBERTA|AB|CANADA)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text
    .replace(/^#\s*\S+\s+/, "")
    .replace(/^(UNIT|SUITE|APT|APARTMENT)\s+\S+\s+/, "")
    .replace(/^[A-Z0-9]+-(?=\d+\s)/, "")
    .replace(/^(\d+)\s+-\s+/, "$1 ");
  const tokens = text.split(" ").filter(Boolean).map((token) => token.replace(/^(\d+)(ST|ND|RD|TH)$/, "$1"));
  const last = tokens.length - 1;
  const quadrant = last > 0 ? (QUADRANTS[tokens[last]] ?? null) : null;
  if (quadrant) tokens[last] = quadrant;
  const typeIndex = quadrant ? last - 1 : last;
  if (typeIndex > 0 && STREET_TYPES[tokens[typeIndex]]) tokens[typeIndex] = STREET_TYPES[tokens[typeIndex]];
  return { address: tokens.join(" "), quadrant };
}

async function cacheGeocode(db: SqlRunner, address: string, point: GeoPoint, source: string): Promise<void> {
  await db.execute(
    `INSERT INTO geocode_cache (address_norm, geog, source) VALUES (:address, ${POINT}, :source)
      ON CONFLICT (address_norm) DO NOTHING`,
    [p.text("address", address), ...pointParams(point), p.text("source", source)],
  );
}

/**
 * Geocodes a Calgary address: normalize, check geocode_cache, then the City Parcel Address API (exact match).
 * A result outside the Calgary extent is outside_calgary. Network errors are unavailable, never a guess.
 */
export async function geocode(db: SqlRunner, address: string, options: ResourceOptions = {}): Promise<GeocodeResult> {
  const normalized = normalizeAddress(address);
  if (!normalized.quadrant) return { ok: false, reason: "needs_quadrant", address: normalized.address };

  const cached = await db.query<{ lat: number; lng: number; source: string | null }>(
    `SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, source FROM geocode_cache
      WHERE address_norm = :address`,
    [p.text("address", normalized.address)],
  );
  if (cached[0]) {
    const point = { lat: Number(cached[0].lat), lng: Number(cached[0].lng) };
    return { ok: true, address: normalized.address, point, source: cached[0].source ?? PARCEL_SOURCE, cached: true };
  }

  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;
  let rows: { latitude?: string; longitude?: string }[];
  try {
    const url = `${PARCEL_API}?$limit=1&address=${encodeURIComponent(normalized.address)}`;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: "unavailable", address: normalized.address };
    rows = (await response.json()) as typeof rows;
  } catch {
    return { ok: false, reason: "unavailable", address: normalized.address };
  }
  const point = { lat: Number(rows[0]?.latitude), lng: Number(rows[0]?.longitude) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || rows.length === 0) {
    return { ok: false, reason: "not_found", address: normalized.address };
  }
  if (!isInCalgary(point)) return { ok: false, reason: "outside_calgary", address: normalized.address };
  await cacheGeocode(db, normalized.address, point, PARCEL_SOURCE);
  return { ok: true, address: normalized.address, point, source: PARCEL_SOURCE, cached: false };
}

// ---------- the U8 guide ----------

function km(meters: number): string {
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

function isOsm(row: { source: string }): boolean {
  return row.source === OSM_SOURCE;
}

/** card source fields for a resource row; OSM rows link the copyright page, as the ODbL credit requires */
function rowSource(row: ResourceRow): CardSource {
  return isOsm(row)
    ? { source: OSM_CREDIT, sourceUrl: OSM_COPYRIGHT, license: row.license, fetchedAt: row.fetchedAt }
    : { source: row.source, sourceUrl: row.sourceUrl, license: row.license, fetchedAt: row.fetchedAt };
}

function rowLinks(row: ResourceRow): GuideCard["links"] {
  return isOsm(row) ? [{ label: "View on OpenStreetMap", url: row.sourceUrl }] : [];
}

function leaveCard(rule: RuleItem, tenure: Tenure): GuideCard {
  const unsure = tenure === "not_sure" ? " Check your start date: the leave needs 90 days with the same employer." : "";
  return {
    id: "leave",
    kind: "leave",
    title: rule.title,
    body: `${rule.body}${unsure}`,
    details: [
      { label: "Days per calendar year", value: String(rule.conditions.max_days_per_year ?? 5) },
      { label: "Time with the same employer", value: `${rule.conditions.min_tenure_days ?? 90} days or more` },
      { label: "Pay", value: "Unpaid unless an employment contract or collective agreement says otherwise" },
    ],
    links: [{ label: "Read the Alberta rules", url: rule.sourceUrl }],
    draftNotice:
      "Hello,\n\nI am giving notice that I need to take personal and family responsibility leave for a family " +
      "caregiving situation. I will confirm the dates I need as soon as I can.\n\nThank you.",
    source: rule.source,
    sourceUrl: rule.sourceUrl,
    license: null,
    fetchedAt: rule.fetchedAt,
  };
}

function eiCard(rule: RuleItem): GuideCard {
  const benefits = (rule.conditions.benefits ?? []) as { name: string; max_weeks: number }[];
  return {
    id: "ei",
    kind: "ei",
    title: rule.title,
    body: rule.body,
    details: benefits.map((benefit) => ({ label: benefit.name, value: `up to ${benefit.max_weeks} weeks` })),
    links: [{ label: "Read the EI caregiving pages", url: rule.sourceUrl }],
    source: rule.source,
    sourceUrl: rule.sourceUrl,
    license: null,
    fetchedAt: rule.fetchedAt,
  };
}

function supportCard(item: SupportItem): GuideCard {
  const details = [
    item.phone ? { label: "Phone", value: item.phone } : null,
    item.address ? { label: "Address", value: item.address } : null,
    item.hours ? { label: "Hours", value: item.hours } : null,
  ].filter((detail): detail is { label: string; value: string } => detail !== null);
  return {
    id: `support:${item.id}`,
    kind: "support",
    title: item.name,
    body: item.offers,
    details,
    links: [{ label: "Website", url: item.url }],
    source: item.source,
    sourceUrl: item.url,
    license: null,
    fetchedAt: item.fetchedAt,
  };
}

function hospitalCard(row: ResourceRow | undefined): GuideCard | null {
  if (!row) return null;
  return {
    id: "hospital",
    kind: "hospital",
    title: `Nearest hospital: ${row.name}`,
    body: "In an emergency, call 911. For health questions, call Health Link at 811.",
    details: [
      ...(row.address ? [{ label: "Address", value: row.address }] : []),
      { label: "Distance", value: `${km(row.meters)} in a straight line` },
    ],
    links: rowLinks(row),
    ...rowSource(row),
  };
}

const PHARMACY_TEXT: Record<OpenStatus, { title: string; status: string }> = {
  open: { title: "Pharmacy open now", status: "Open now, by its listed hours" },
  unknown: { title: "Nearest pharmacy", status: "Hours unknown, call ahead" },
  closed: { title: "Nearest pharmacy", status: "None of the nearest pharmacies is open now by its listed hours" },
};

/** pharmacies arrive sorted open, unknown, closed; the first one is the pick */
function pharmacyCard(pharmacies: PharmacyAtTime[]): GuideCard | null {
  const pick = pharmacies[0];
  if (!pick) return null;
  const text = PHARMACY_TEXT[pick.status];
  return {
    id: "pharmacy",
    kind: "pharmacy",
    title: `${text.title}: ${pick.name}`,
    body: `${text.status}. ${pick.accessibility[0].toUpperCase()}${pick.accessibility.slice(1)}.`,
    details: [
      ...(pick.address ? [{ label: "Address", value: pick.address }] : []),
      { label: "Hours", value: pick.openingHours ?? "unknown" },
      { label: "Accessibility", value: pick.accessibility },
      ...(pick.phone ? [{ label: "Phone", value: pick.phone }] : []),
      { label: "Distance", value: `${km(pick.meters)} in a straight line` },
    ],
    links: rowLinks(pick),
    ...rowSource(pick),
  };
}

/** source of the loaded transit stops, for the card that has no stop to cite */
async function stopsSource(db: SqlRunner): Promise<CardSource> {
  const rows = await db.query<{ source: string; source_url: string; license: string | null; fetched_at: string }>(
    `SELECT source, source_url, license, fetched_at::text AS fetched_at FROM resource
      WHERE kind = 'transit_stop' ORDER BY fetched_at DESC LIMIT 1`,
  );
  const row = rows[0];
  return row
    ? { source: row.source, sourceUrl: row.source_url, license: row.license, fetchedAt: row.fetched_at }
    : { source: "City of Calgary Transit Stops", sourceUrl: "https://data.calgary.ca/d/muzh-c9qc", license: null, fetchedAt: "" };
}

function transitCard(stops: ResourceRow[], stopsSnapshot: CardSource): GuideCard {
  return {
    id: "transit",
    kind: "transit",
    title: "Nearest transit stops",
    body: stops.length > 0 ? `${stops.length} stop${stops.length === 1 ? "" : "s"} within 800 m.` : "No stop within 800 m.",
    details: stops.map((stop) => ({ label: stop.name, value: `${stop.description ?? "Stop"}, ${km(stop.meters)}` })),
    links: [],
    ...stopsSnapshot,
  };
}

/**
 * Builds the U8 "first 72 hours" cards for a Calgary address or point (PRD section 5.1 U8): the leave rule for tenure
 * yes and not_sure, EI as "may apply if", supports, the nearest hospital, a pharmacy open at `now`, and up to 3
 * stops within 800 m. Every card has its source, url and fetch date; hours and accessibility come from the data row.
 */
export async function buildGuide(db: SqlRunner, input: GuideInput, options: ResourceOptions = {}): Promise<GuideResult> {
  let point = input.point;
  let address: string | null = null;
  if (!point) {
    if (!input.address?.trim()) return { ok: false, reason: "missing_location", message: GUIDE_MESSAGES.missing_location };
    const found = await geocode(db, input.address, options);
    if (!found.ok) return { ok: false, reason: found.reason, message: GUIDE_MESSAGES[found.reason] };
    point = found.point;
    address = found.address;
  }
  const community = isInCalgary(point) ? await communityAt(db, point) : null;
  if (!community) return { ok: false, reason: "outside_calgary", message: GUIDE_MESSAGES.outside_calgary };

  const [rules, supports] = await Promise.all([loadRules(options), loadSupports(options)]);
  const hospitals = await nearest(db, point, ["hospital"], 1, HOSPITAL_RADIUS_M);
  const pharmacies = await pharmaciesOpenAt(db, point, input.now);
  const stops = await nearestStops(db, point);

  const cards: GuideCard[] = [];
  const leave = rules.find((rule) => rule.id === "ab_personal_family_responsibility_leave");
  const ei = rules.find((rule) => rule.id === "ei_caregiving_benefits");
  if (leave && (input.tenure === "yes" || input.tenure === "not_sure")) cards.push(leaveCard(leave, input.tenure));
  if (ei) cards.push(eiCard(ei));
  cards.push(...supports.map(supportCard));
  const hospital = hospitalCard(hospitals[0]);
  if (hospital) cards.push(hospital);
  const pharmacy = pharmacyCard(pharmacies);
  if (pharmacy) cards.push(pharmacy);
  cards.push(transitCard(stops, stops[0] ? rowSource(stops[0]) : await stopsSource(db)));

  return {
    ok: true,
    location: { address, point, community },
    tenure: input.tenure,
    cards,
    attribution: { text: OSM_CREDIT, url: OSM_COPYRIGHT },
  };
}

// ---------- nearby resource cards and the inline map (PRD 10) ----------

/**
 * The service types offered by GET /api/care-access/nearby and the resource.kind values behind each. Hospitals look
 * further than the chosen distance so the nearest one is always listed; transit stops stay within 800 m.
 */
export const SERVICE_TYPES = {
  pharmacy: { label: "Pharmacies", one: "Pharmacy", kinds: ["pharmacy"] },
  clinic: { label: "Clinics and doctors’ offices", one: "Clinic or doctor’s office", kinds: ["clinic", "doctors"] },
  hospital: { label: "Hospitals", one: "Hospital", kinds: ["hospital"], minRadiusM: HOSPITAL_RADIUS_M, maxPerType: 2 },
  public_health: { label: "Public-health clinics", one: "Public-health clinic", kinds: ["health_centre"] },
  social_support: { label: "Social support centres", one: "Social support centre", kinds: ["social_development_centre"] },
  community_centre: { label: "Community centres", one: "Community centre", kinds: ["community_centre"] },
  library: { label: "Libraries", one: "Library", kinds: ["library"] },
  transit: {
    label: "Transit stops",
    one: "Transit stop",
    kinds: ["transit_stop"],
    maxRadiusM: STOP_RADIUS_M,
    maxPerType: STOP_LIMIT,
  },
} as const satisfies Record<string, ServiceTypeSpec>;
export type ServiceType = keyof typeof SERVICE_TYPES;
export const SERVICE_TYPE_IDS = Object.keys(SERVICE_TYPES) as ServiceType[];

interface ServiceTypeSpec {
  /** plural, for filters and counts */
  label: string;
  /** singular, for a card */
  one: string;
  kinds: readonly ResourceKind[];
  /** look at least this far, so the nearest one is listed even outside the chosen distance */
  minRadiusM?: number;
  /** never look further than this */
  maxRadiusM?: number;
  maxPerType?: number;
}

export type WheelchairAccess = "yes" | "limited" | "no" | "unknown";

export interface NearbyRow extends ResourceRow {
  type: ServiceType;
  /** false only for the nearest hospital when none is inside the chosen distance */
  withinRadius: boolean;
  openStatus: OpenStatus;
  access: WheelchairAccess;
}

export interface NearbyOptions {
  types: readonly ServiceType[];
  radiusM: number;
  perType: number;
  /** only wheelchair yes or designated; a missing tag is unknown and left out */
  accessibleOnly: boolean;
  /** app time; opening hours are checked at this instant */
  now: Date;
}

export interface NearbyResult {
  rows: NearbyRow[];
  /** per type: places inside the type's distance that pass the accessibility filter */
  withinCounts: Record<ServiceType, number>;
  /** places inside the distance left out by accessibleOnly because their source has no usable wheelchair tag */
  excludedUnknownAccess: number;
}

export interface CommunityOutline {
  name: string;
  commCode: string | null;
  rings: LonLat[][];
}

const ACCESSIBLE_TAGS = "('yes','designated')";
const KNOWN_ACCESS_TAGS = "('yes','designated','limited','no')";
const OUTLINE_DIGITS = 5;

/** wheelchair tag to the card value; anything missing or unusual is unknown, never no */
export function wheelchairAccess(tag: string | null): WheelchairAccess {
  switch (tag?.trim().toLowerCase()) {
    case "yes":
    case "designated":
      return "yes";
    case "limited":
      return "limited";
    case "no":
      return "no";
    default:
      return "unknown";
  }
}

interface TypeSearch {
  type: ServiceType;
  kind: string;
  /** how far to look for rows */
  search_m: number;
  /** the distance that counts as within */
  within_m: number;
  max_rows: number;
}

function typeSearches(options: NearbyOptions): TypeSearch[] {
  const perType = Math.max(1, Math.trunc(options.perType));
  const searches: TypeSearch[] = [];
  for (const type of new Set(options.types)) {
    const spec: ServiceTypeSpec = SERVICE_TYPES[type];
    const within = spec.maxRadiusM === undefined ? options.radiusM : Math.min(options.radiusM, spec.maxRadiusM);
    const search = spec.minRadiusM === undefined ? within : Math.max(within, spec.minRadiusM);
    const maxRows = spec.maxPerType === undefined ? perType : Math.min(perType, spec.maxPerType);
    for (const kind of spec.kinds) searches.push({ type, kind, search_m: search, within_m: within, max_rows: maxRows });
  }
  return searches;
}

/**
 * The nearest places of each service type around point, by straight-line distance, nearest first overall. Each type
 * returns at most perType rows inside its distance. A type that looks further (hospital) with nothing inside the
 * distance still returns its single nearest row, marked withinRadius false. Only rows with coordinates are returned.
 */
export async function nearbyResources(db: SqlRunner, point: GeoPoint, options: NearbyOptions): Promise<NearbyResult> {
  const searches = typeSearches(options);
  const withinCounts = Object.fromEntries(SERVICE_TYPE_IDS.map((type) => [type, 0])) as Record<ServiceType, number>;
  if (searches.length === 0) return { rows: [], withinCounts, excludedUnknownAccess: 0 };
  const searchParams = [...pointParams(point), p.text("searches", JSON.stringify(searches))];

  const rows = await db.query<ResourceSqlRow & { type: ServiceType; within_m: number }>(
    `WITH q AS (SELECT ${POINT} AS pt),
       t AS (SELECT * FROM jsonb_to_recordset(CAST(:searches AS jsonb))
         AS t(type text, kind text, search_m double precision, within_m double precision, max_rows int))
     SELECT x.type, x.within_m, x.id, x.kind, x.name, x.address, x.phone, x.opening_hours, x.wheelchair, x.description,
       x.source, x.source_url, x.license, x.fetched_at, x.lat, x.lng, x.meters
     FROM (
       SELECT t.type, t.within_m, t.max_rows, r.id::text AS id, r.kind, r.name, r.address, r.phone, r.opening_hours,
         r.wheelchair, r.description, r.source, r.source_url, r.license, r.fetched_at::text AS fetched_at,
         ST_Y(r.geog::geometry) AS lat, ST_X(r.geog::geometry) AS lng, ST_Distance(r.geog, q.pt) AS meters,
         row_number() OVER (PARTITION BY t.type ORDER BY ST_Distance(r.geog, q.pt), r.name, r.id) AS rank
       FROM resource r JOIN t ON t.kind = r.kind CROSS JOIN q
       WHERE r.geog IS NOT NULL AND ST_DWithin(r.geog, q.pt, t.search_m)
         AND (CAST(:accessible_only AS boolean) = false OR lower(trim(r.wheelchair)) IN ${ACCESSIBLE_TAGS})
     ) x
     WHERE x.rank <= x.max_rows
     ORDER BY x.meters, x.name, x.id`,
    [...searchParams, p.bool("accessible_only", options.accessibleOnly)],
  );

  const counts = await db.query<{ type: ServiceType; total: number; accessible: number; unknown: number }>(
    `WITH q AS (SELECT ${POINT} AS pt),
       t AS (SELECT * FROM jsonb_to_recordset(CAST(:searches AS jsonb)) AS t(type text, kind text, within_m double precision))
     SELECT t.type, count(*)::int AS total,
       count(*) FILTER (WHERE lower(trim(r.wheelchair)) IN ${ACCESSIBLE_TAGS})::int AS accessible,
       count(*) FILTER (WHERE r.wheelchair IS NULL OR lower(trim(r.wheelchair)) NOT IN ${KNOWN_ACCESS_TAGS})::int AS unknown
     FROM resource r JOIN t ON t.kind = r.kind CROSS JOIN q
     WHERE r.geog IS NOT NULL AND ST_DWithin(r.geog, q.pt, t.within_m)
     GROUP BY t.type`,
    searchParams,
  );
  let excludedUnknownAccess = 0;
  for (const row of counts) {
    withinCounts[row.type] = Number(options.accessibleOnly ? row.accessible : row.total);
    if (options.accessibleOnly) excludedUnknownAccess += Number(row.unknown);
  }

  const mapped: NearbyRow[] = rows.map((row) => {
    const resource = toResource(row);
    return {
      ...resource,
      type: row.type,
      withinRadius: Number(row.meters) <= Number(row.within_m),
      openStatus: openingStatus(resource.openingHours, options.now),
      access: wheelchairAccess(resource.wheelchair),
    };
  });
  // a type that looks further than the chosen distance keeps only its rows inside it, or else its single nearest row
  const hasWithin = new Set(mapped.filter((row) => row.withinRadius).map((row) => row.type));
  const nearestOutside = new Set<ServiceType>();
  const kept = mapped.filter((row) => {
    if (row.withinRadius) return true;
    if (hasWithin.has(row.type) || nearestOutside.has(row.type)) return false;
    nearestOutside.add(row.type);
    return true;
  });
  return { rows: kept, withinCounts, excludedUnknownAccess };
}

/** City community boundaries that overlap the bounds, with coordinates rounded to 5 decimals (about 1 m) */
export async function communityOutlines(
  db: SqlRunner,
  bounds: { west: number; south: number; east: number; north: number },
): Promise<CommunityOutline[]> {
  const rows = await db.query<{ name: string; comm_code: string | null; geojson: string }>(
    `SELECT name, comm_code, ST_AsGeoJSON(geom::geometry, ${OUTLINE_DIGITS}) AS geojson FROM community
      WHERE ST_Intersects(geom::geometry, ST_MakeEnvelope(CAST(:west AS double precision),
        CAST(:south AS double precision), CAST(:east AS double precision), CAST(:north AS double precision), 4326))
      ORDER BY name`,
    [num("west", bounds.west), num("south", bounds.south), num("east", bounds.east), num("north", bounds.north)],
  );
  return rows.map((row) => ({ name: row.name, commCode: row.comm_code, rings: outlineRings(row.geojson) }));
}

function outlineRings(geojson: string): LonLat[][] {
  try {
    return ringsOfGeometry(JSON.parse(geojson), OUTLINE_DIGITS);
  } catch {
    return [];
  }
}
