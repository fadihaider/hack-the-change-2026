// nearby resource cards and the inline map (PRD 10, AC9): real resource rows around the demo home, over PGlite, and
// GET /api/care-access/nearby parsed by the browser contract (lib/frontend/live-api.ts nearbySchema)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-nearby-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

const persona = JSON.parse(readFileSync(path.join(process.cwd(), "data", "calgary", "persona.json"), "utf8")) as {
  address: string;
  lat: number;
  lng: number;
  community: string;
};
const HOME = { lat: persona.lat, lng: persona.lng };
// saturday 2026-11-07 15:00 in alberta time (utc-6)
const SATURDAY_3PM = new Date("2026-11-07T21:00:00Z");
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Handler = (request: Request) => Promise<Response>;
type Resources = typeof import("../lib/mvp/resources.ts");
type Database = import("../lib/db.ts").Database;

let GET: Handler;
let resources: Resources;
let database: Database;

before(async () => {
  ({ GET } = (await import("../app/api/care-access/nearby/route.ts")) as { GET: Handler });
  resources = await import("../lib/mvp/resources.ts");
  const { getRuntime } = await import("../lib/mvp/runtime.ts");
  database = (await getRuntime()).stores.database;
  await resources.loadResources(database);
});

after(async () => {
  const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
  await (await holder.__reliefReadyPglite)?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(query = ""): Promise<{ status: number; data: any }> {
  const response = await GET(new Request(`${BASE}/api/care-access/nearby${query}`, { headers: { Origin: BASE } }));
  return { status: response.status, data: await response.json() };
}

/** the browser client over the route handler, so the response is checked by the real zod contract */
async function liveApi() {
  const { createLiveApi } = await import("../lib/frontend/live-api.ts");
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) =>
    GET(new Request(new URL(String(input), BASE), { headers: { Origin: BASE }, method: init?.method }))) as typeof fetch;
  return createLiveApi(transport);
}

test("nearest places per type have real coordinates, sources and fetch dates, nearest first", async () => {
  const result = await resources.nearbyResources(database, HOME, {
    types: resources.SERVICE_TYPE_IDS,
    radiusM: 3000,
    perType: 4,
    accessibleOnly: false,
    now: SATURDAY_3PM,
  });
  assert.ok(result.rows.length > 10, `only ${result.rows.length} rows`);
  const perType = new Map<string, number>();
  for (const row of result.rows) {
    perType.set(row.type, (perType.get(row.type) ?? 0) + 1);
    assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lng), `${row.name} has no coordinates`);
    assert.ok(row.source, `${row.name} has no source`);
    assert.match(row.sourceUrl, /^https:\/\//, `${row.name} source url`);
    assert.match(row.fetchedAt, ISO_DATE);
    assert.ok(resources.SERVICE_TYPES[row.type].kinds.includes(row.kind as never), `${row.kind} is not a ${row.type}`);
    if (row.source === "OpenStreetMap") assert.match(row.license ?? "", /ODbL/);
    if (!row.wheelchair) assert.equal(row.access, "unknown", "a missing tag is unknown, never no");
    if (!row.openingHours) assert.equal(row.openStatus, "unknown", "missing hours are unknown, never closed");
  }
  for (const [type, count] of perType) assert.ok(count <= (type === "hospital" ? 2 : type === "transit" ? 3 : 4), type);
  const meters = result.rows.map((row) => row.meters);
  assert.deepEqual(meters, [...meters].sort((a, b) => a - b), "nearest first");
  assert.equal(new Set(result.rows.map((row) => row.id)).size, result.rows.length, "ids are unique");

  for (const row of result.rows.filter((item) => item.type === "transit")) assert.ok(row.meters <= 800, `${row.meters} m`);
  assert.ok(result.withinCounts.pharmacy >= (perType.get("pharmacy") ?? 0));
  assert.equal(result.excludedUnknownAccess, 0);
});

test("the wheelchair filter keeps only yes or designated and counts the unknowns it leaves out", async () => {
  const result = await resources.nearbyResources(database, HOME, {
    types: ["pharmacy", "clinic", "library"],
    radiusM: 5000,
    perType: 8,
    accessibleOnly: true,
    now: SATURDAY_3PM,
  });
  for (const row of result.rows) {
    assert.equal(row.access, "yes", `${row.name} is ${row.wheelchair}`);
    assert.ok(["yes", "designated"].includes(String(row.wheelchair).trim().toLowerCase()));
  }
  assert.ok(result.excludedUnknownAccess > 0, "places with no wheelchair tag are counted as left out");
  assert.equal(resources.wheelchairAccess(null), "unknown");
  assert.equal(resources.wheelchairAccess(" Designated "), "yes");
  assert.equal(resources.wheelchairAccess("limited"), "limited");
  assert.equal(resources.wheelchairAccess("no"), "no");
  assert.equal(resources.wheelchairAccess("partial"), "unknown");
});

test("the nearest hospital is listed even outside a short distance, and marked so", async () => {
  const result = await resources.nearbyResources(database, HOME, {
    types: ["hospital", "transit"],
    radiusM: 1000,
    perType: 4,
    accessibleOnly: false,
    now: SATURDAY_3PM,
  });
  const hospitals = result.rows.filter((row) => row.type === "hospital");
  assert.equal(hospitals.length, 1);
  assert.equal(hospitals[0].withinRadius, false);
  assert.ok(hospitals[0].meters > 1000);
  assert.equal(result.withinCounts.hospital, 0);
  const stops = result.rows.filter((row) => row.type === "transit");
  assert.ok(stops.length > 0 && stops.length <= 3);
  for (const stop of stops) assert.ok(stop.withinRadius && stop.meters <= 800);
});

test("community outlines around the home include its own community with drawable rings", async () => {
  const outlines = await resources.communityOutlines(database, {
    west: HOME.lng - 0.02,
    south: HOME.lat - 0.01,
    east: HOME.lng + 0.02,
    north: HOME.lat + 0.01,
  });
  const home = outlines.find((outline) => outline.name === persona.community);
  assert.ok(home, `${persona.community} is missing`);
  assert.ok(home.rings.length > 0);
  for (const outline of outlines) {
    for (const ring of outline.rings) {
      assert.ok(ring.length >= 3);
      for (const [lon, lat] of ring) assert.ok(Number.isFinite(lon) && Number.isFinite(lat));
    }
  }
});

test("GET /api/care-access/nearby returns the contract for the demo home", async () => {
  const api = await liveApi();
  const view = await api.nearby({ types: ["pharmacy", "clinic", "hospital", "library", "transit"], radiusKm: 3, accessible: "any" });
  assert.equal(view.method, "straight_line");
  assert.equal(view.radiusKm, 3);
  assert.equal(view.origin.approximate, true);
  assert.equal(view.origin.label, "Rosa’s home (approximate)");
  assert.equal(view.origin.community, persona.community);
  assert.equal(view.origin.lat, Math.round(persona.lat * 1000) / 1000);
  assert.equal(view.origin.lon, Math.round(persona.lng * 1000) / 1000);
  assert.ok(view.resources.length > 0);
  assert.ok(view.outlines.length > 0);
  assert.ok(view.outlines.some((outline) => outline.name === persona.community));
  assert.equal(new Set(view.resources.map((item) => item.id)).size, view.resources.length);
  const km = view.resources.map((item) => item.distanceKm);
  assert.deepEqual(km, [...km].sort((a, b) => a - b));
  for (const item of view.resources) {
    assert.ok(item.lat >= view.bounds.south && item.lat <= view.bounds.north, `${item.name} is off the map`);
    assert.ok(item.lon >= view.bounds.west && item.lon <= view.bounds.east, `${item.name} is off the map`);
    assert.match(item.sourceUrl, /^https:\/\//);
    assert.ok(item.typeLabel);
  }
  for (const item of view.resources.filter((resource) => resource.type === "transit")) assert.ok(item.distanceKm <= 0.8);
  assert.deepEqual(view.counts.map((count) => count.type), ["pharmacy", "clinic", "hospital", "library", "transit"]);
  for (const count of view.counts) {
    assert.equal(count.shown, view.resources.filter((item) => item.type === count.type).length);
    assert.ok(count.label);
  }
  assert.ok(view.limits.some((line) => /straight lines/.test(line)));
  assert.ok(view.limits.some((line) => /Transit routes/.test(line)));
  assert.ok(view.limits.some((line) => /Unknown/.test(line)));

  const raw = await get();
  assert.equal(raw.status, 200);
  assert.ok(!raw.data.resources.some((item: { type: string }) => item.type === "transit"), "transit is opt-in");
  assert.ok(JSON.stringify(raw.data).length < 120_000, `payload is ${JSON.stringify(raw.data).length} bytes`);
});

test("without PostGIS GeoJSON the outlines come from the public care-access snapshot", async () => {
  const { buildNearby, parseNearbyQuery } = await import("../lib/care-access/nearby.ts");
  const noGeoJson = {
    query: <T>(sql: string, params?: Parameters<Database["query"]>[1]) =>
      /ST_AsGeoJSON/.test(sql) ? Promise.reject(new Error("function st_asgeojson does not exist")) : database.query<T>(sql, params),
    execute: (sql: string, params?: Parameters<Database["execute"]>[1]) => database.execute(sql, params),
  };
  const view = await buildNearby(noGeoJson, {
    origin: { point: HOME, community: persona.community, label: "Rosa’s home (approximate)", fromAddress: false },
    name: "Rosa",
    query: parseNearbyQuery(new URLSearchParams("types=pharmacy,library&radiusKm=2"))!,
    now: SATURDAY_3PM,
  });
  assert.ok(view.resources.length > 0);
  assert.ok(view.outlines.length > 0, "snapshot areas fill the basemap");
  for (const outline of view.outlines) assert.ok(outline.rings.every((ring) => ring.length >= 3));
});

test("the nearby route rejects bad queries and passes location problems through", async () => {
  for (const query of ["?radiusKm=4", "?types=spa", "?perType=9", "?accessible=maybe", `?address=${"a".repeat(201)}`]) {
    const bad = await get(query);
    assert.equal(bad.status, 400, query);
    assert.equal(bad.data.error.code, "invalid_input");
  }
  const noQuadrant = await get("?address=800%203%20St");
  assert.equal(noQuadrant.status, 422);
  assert.equal(noQuadrant.data.error.code, "needs_quadrant");
  assert.ok(noQuadrant.data.error.message);

  // the demo address is in the geocode cache, so no network is used
  const typed = await get(`?address=${encodeURIComponent(persona.address)}&types=hospital&radiusKm=1&accessible=yes`);
  assert.equal(typed.status, 200);
  assert.equal(typed.data.origin.label, "The address you entered (approximate)");
  assert.ok(typed.data.limits.some((line: string) => /left out/.test(line)));
});
