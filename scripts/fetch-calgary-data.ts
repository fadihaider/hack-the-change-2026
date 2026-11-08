// fetches public calgary snapshots into data/calgary/*.json (PRD section 6); run once, then commit the output
// usage: npx tsx scripts/fetch-calgary-data.ts   (optional SOCRATA_APP_TOKEN avoids the shared ip throttle)
// the app never calls these sources at demo time; it loads the snapshots with lib/mvp/resources.ts loadResources
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "data", "calgary");
const CITY_LICENSE = "Open Government Licence - City of Calgary";
const OSM_LICENSE = "ODbL, (c) OpenStreetMap contributors";
const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const USER_AGENT = "reliefready-hackathon-prototype";
const ALBERTA_OFFSET_MS = 6 * 60 * 60 * 1000;

// alberta time is utc-6 all year since 2026-11-01, so the snapshot date is the alberta calendar date
const fetchedAt = new Date(Date.now() - ALBERTA_OFFSET_MS).toISOString().slice(0, 10);

const COMMUNITY_SERVICE_TYPES = ["Hospital", "PHS Clinic", "Social Dev Ctr", "Community Centre", "Library"];
const PERSONA_ADDRESS = "800 3 ST SE"; // calgary central library, a public building; never a private home
const COMMUNITY_TOLERANCE_DEG = 0.0003; // about 30 m; keeps every boundary small enough to commit
const HOSPITAL_DUPLICATE_M = 500;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// relation 3227127 is the city of calgary admin boundary (admin_level 6, wikidata Q36312); area id = 3600000000 + id
const OVERPASS_QUERY = `[out:json][timeout:90];
area(id:3603227127)->.calgary;
(nwr["amenity"~"^(pharmacy|clinic|doctors|hospital)$"](area.calgary););
out tags center;`;

interface Snapshot<T> {
  source: string;
  sourceUrl: string;
  apiUrl: string;
  license: string;
  fetchedAt: string;
  notes?: string;
  items: T[];
}

interface SocrataPoint {
  type: "Point";
  coordinates: [number, number];
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function socrataHeaders(): Record<string, string> {
  const token = process.env.SOCRATA_APP_TOKEN;
  return token ? { "X-App-Token": token, Accept: "application/json" } : { Accept: "application/json" };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: socrataHeaders(), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** pretty metadata and one item per line, so a refreshed snapshot diffs row by row */
function serialize(snapshot: object): string {
  if (!("items" in snapshot) || !Array.isArray(snapshot.items)) {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  }
  const { items, ...meta } = snapshot as { items: unknown[] };
  const head = JSON.stringify(meta, null, 2).replace(/\n}$/, "");
  const rows = items.map((item) => `    ${JSON.stringify(item)}`).join(",\n");
  return `${head},\n  "items": [\n${rows}\n  ]\n}\n`;
}

async function writeSnapshot(file: string, snapshot: object): Promise<void> {
  const text = serialize(snapshot);
  await writeFile(path.join(OUT_DIR, file), text, "utf8");
  console.log(`wrote data/calgary/${file} (${(text.length / 1024).toFixed(0)} KB)`);
}

/** great-circle distance in metres, only used to drop duplicate hospitals */
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// ---------- city of calgary community services (x34e-bcjz) ----------

interface CommunityServiceItem {
  type: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
}

async function fetchCommunityServices(): Promise<Snapshot<CommunityServiceItem>> {
  const apiUrl = "https://data.calgary.ca/resource/x34e-bcjz.json?$limit=5000";
  const rows = await getJson<{ type?: string; name?: string; address?: string; point?: SocrataPoint }[]>(apiUrl);
  const items = rows
    .filter((row) => row.type && COMMUNITY_SERVICE_TYPES.includes(row.type) && row.name && row.point)
    .map((row) => ({
      type: row.type as string,
      name: (row.name as string).trim(),
      address: row.address?.trim() ?? null,
      lng: round6(row.point!.coordinates[0]),
      lat: round6(row.point!.coordinates[1]),
    }));
  return {
    source: "City of Calgary Community Services",
    sourceUrl: "https://data.calgary.ca/d/x34e-bcjz",
    apiUrl,
    license: CITY_LICENSE,
    fetchedAt,
    notes: `types kept: ${COMMUNITY_SERVICE_TYPES.join(", ")}`,
    items,
  };
}

// ---------- city of calgary transit stops (muzh-c9qc) ----------

interface TransitStopItem {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

async function fetchTransitStops(): Promise<Snapshot<TransitStopItem>> {
  const apiUrl = "https://data.calgary.ca/resource/muzh-c9qc.json?status=ACTIVE&$limit=20000";
  const rows = await getJson<{ teleride_number?: string; stop_name?: string; point?: SocrataPoint }[]>(apiUrl);
  const items = rows
    .filter((row) => row.teleride_number && row.stop_name && row.point)
    .map((row) => ({
      id: row.teleride_number as string,
      name: (row.stop_name as string).trim(),
      lat: round6(row.point!.coordinates[1]),
      lng: round6(row.point!.coordinates[0]),
    }));
  return {
    source: "City of Calgary Transit Stops",
    sourceUrl: "https://data.calgary.ca/d/muzh-c9qc",
    apiUrl,
    license: CITY_LICENSE,
    fetchedAt,
    notes: "ACTIVE stops only; id is the teleride stop number",
    items,
  };
}

// ---------- city of calgary community district boundaries (surr-xmvs) ----------

interface CommunityItem {
  name: string;
  commCode: string;
  sector: string | null;
  geometry: { type: "MultiPolygon" | "Polygon"; coordinates: unknown };
}

function roundCoordinates(value: unknown): unknown {
  if (typeof value === "number") return round6(value);
  if (Array.isArray(value)) return value.map(roundCoordinates);
  return value;
}

async function fetchCommunities(): Promise<Snapshot<CommunityItem>> {
  // the full boundaries are about 2 MB; socrata simplifies them server side with topology preserved
  const select = `name,comm_code,sector,simplify_preserve_topology(multipolygon,${COMMUNITY_TOLERANCE_DEG}) as geom`;
  const apiUrl = `https://data.calgary.ca/resource/surr-xmvs.json?$limit=1000&$select=${encodeURIComponent(select)}`;
  const rows = await getJson<{ name?: string; comm_code?: string; sector?: string; geom?: CommunityItem["geometry"] }[]>(apiUrl);
  const items = rows
    .filter((row) => row.name && row.comm_code && row.geom)
    .map((row) => ({
      name: row.name as string,
      commCode: row.comm_code as string,
      sector: row.sector ?? null,
      geometry: { type: row.geom!.type, coordinates: roundCoordinates(row.geom!.coordinates) },
    }));
  return {
    source: "City of Calgary Community District Boundaries",
    sourceUrl: "https://data.calgary.ca/d/surr-xmvs",
    apiUrl,
    license: CITY_LICENSE,
    fetchedAt,
    notes: `polygons simplified with simplify_preserve_topology at ${COMMUNITY_TOLERANCE_DEG} degrees (about 30 m) to stay small`,
    items,
  };
}

// ---------- openstreetmap health amenities (overpass) ----------

interface OsmItem {
  osmId: string;
  osmUrl: string;
  amenity: string;
  name: string;
  lat: number;
  lng: number;
  openingHours: string | null;
  wheelchair: string | null;
  phone: string | null;
  address: string | null;
  addr: Record<string, string>;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function postOverpass(endpoint: string): Promise<{ elements: OverpassElement[] }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: OVERPASS_QUERY }).toString(),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) {
    throw new Error(`overpass ${endpoint} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as { elements: OverpassElement[] };
}

/** main instance, one retry after 30 s, then the mirrors (IMPLEMENTATION section 5) */
async function queryOverpass(): Promise<{ endpoint: string; elements: OverpassElement[] }> {
  const attempts = [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[0], ...OVERPASS_ENDPOINTS.slice(1)];
  let lastError: unknown;
  for (const [index, endpoint] of attempts.entries()) {
    try {
      const out = await postOverpass(endpoint);
      return { endpoint, elements: out.elements };
    } catch (error) {
      lastError = error;
      console.log(`overpass attempt ${index + 1} failed: ${(error as Error).message}`);
      if (index === 0) await wait(30_000);
    }
  }
  throw lastError;
}

/** "1213 4 Street Southwest" style address from addr:* tags, or null */
function osmAddress(addr: Record<string, string>): string | null {
  const street = [addr["addr:housenumber"], addr["addr:street"]].filter(Boolean).join(" ");
  const unit = addr["addr:unit"] ? `Unit ${addr["addr:unit"]}, ` : "";
  return street ? `${unit}${street}` : null;
}

async function fetchOsm(cityFacilities: CommunityServiceItem[]): Promise<Snapshot<OsmItem>> {
  const { endpoint, elements } = await queryOverpass();
  // every osm hospital in calgary is also a city community services hospital or phs clinic row; keep the city row
  const cityHealth = cityFacilities.filter((item) => item.type === "Hospital" || item.type === "PHS Clinic");
  const dropped: string[] = [];
  const items: OsmItem[] = [];
  for (const element of elements) {
    // en and em dashes become plain hyphens, so names read the same and dashed hours still parse
    const tags = Object.fromEntries(
      Object.entries(element.tags ?? {}).map(([key, value]) => [key, value.replace(/[\u2013\u2014]/g, "-")]),
    );
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (!tags.name || lat === undefined || lng === undefined) continue;
    const point = { lat: round6(lat), lng: round6(lng) };
    if (tags.amenity === "hospital" && cityHealth.some((city) => haversineM(city, point) < HOSPITAL_DUPLICATE_M)) {
      dropped.push(tags.name);
      continue;
    }
    const addr = Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith("addr:")));
    items.push({
      osmId: `${element.type}/${element.id}`,
      osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      amenity: tags.amenity,
      name: tags.name.trim(),
      ...point,
      openingHours: tags.opening_hours ?? null,
      wheelchair: tags.wheelchair ?? null,
      phone: tags.phone ?? tags["contact:phone"] ?? null,
      address: osmAddress(addr),
      addr,
    });
  }
  return {
    source: "OpenStreetMap",
    sourceUrl: OSM_COPYRIGHT,
    apiUrl: endpoint,
    license: OSM_LICENSE,
    fetchedAt,
    notes:
      "amenity pharmacy, clinic, doctors, hospital inside the City of Calgary boundary (relation 3227127); " +
      "ways use their center; unnamed elements skipped; " +
      `hospitals within ${HOSPITAL_DUPLICATE_M} m of a City hospital or PHS clinic dropped as duplicates: ${dropped.join(", ") || "none"}`,
    items,
  };
}

// ---------- persona geocode (parcel address 9zvu-p8uz) ----------

/** ray casting over every ring; good enough to label one point with its community */
function inMultiPolygon(point: { lat: number; lng: number }, geometry: CommunityItem["geometry"]): boolean {
  const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
  let inside = false;
  for (const ring of polygons.flat()) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > point.lat !== yj > point.lat && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

async function fetchPersona(communities: CommunityItem[]) {
  const apiUrl = `https://data.calgary.ca/resource/9zvu-p8uz.json?$limit=1&address=${encodeURIComponent(PERSONA_ADDRESS)}`;
  const rows = await getJson<{ address?: string; latitude?: string; longitude?: string }[]>(apiUrl);
  const row = rows[0];
  if (!row?.latitude || !row.longitude) {
    throw new Error(`no parcel address match for ${PERSONA_ADDRESS}; pick another public building`);
  }
  const point = { lat: round6(Number(row.latitude)), lng: round6(Number(row.longitude)) };
  return {
    place: "Calgary Central Library (public building)",
    address: row.address ?? PERSONA_ADDRESS,
    ...point,
    community: communities.find((item) => inMultiPolygon(point, item.geometry))?.name ?? null,
    source: "City of Calgary Parcel Address",
    sourceUrl: "https://data.calgary.ca/d/9zvu-p8uz",
    apiUrl,
    license: CITY_LICENSE,
    fetchedAt,
    notes: "fictional persona Rosa uses this public building address; never a private home",
  };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const services = await fetchCommunityServices();
  await writeSnapshot("community-services.json", services);
  await writeSnapshot("transit-stops.json", await fetchTransitStops());
  const communities = await fetchCommunities();
  await writeSnapshot("communities.json", communities);
  await writeSnapshot("persona.json", await fetchPersona(communities.items));
  await writeSnapshot("osm-health.json", await fetchOsm(services.items));
}

await main();
