import assert from "node:assert/strict";
import test from "node:test";
import type { AccessArea, AccessResource } from "../lib/care-access/engine.ts";
import {
  boundsAround,
  fitProjection,
  KM_PER_DEGREE,
  ringsIntersect,
  ringsOfGeometry,
  ringsPath,
} from "../lib/care-access/geometry.ts";
import { parseNearbyQuery } from "../lib/care-access/nearby.ts";
import {
  classifierLabels,
  clusterSizes,
  modelSuggestion,
  nearestByCategory,
  parseHomeThreshold,
  resolveHomeArea,
  typicalCounts,
} from "../lib/care-access/home.ts";

function area(id: string, name: string, lat: number, lon: number): AccessArea {
  return { id, name, lat, lon, sector: "CENTRE", geometry: { type: "MultiPolygon", coordinates: [] } };
}

function place(id: string, category: string): AccessResource {
  return {
    id,
    name: `Place ${id}`,
    category,
    lat: 51,
    lon: -114,
    address: `${id} Main St`,
    sourceUrl: "https://example.test",
    source: "Test",
    wheelchair: null,
    hours: null,
  };
}

const AREAS = [
  area("ALT", "Altadore", 51.0159, -114.1008),
  area("DNE", "Downtown East Village", 51.0471, -114.0509),
  area("BRI", "Bridgeland/Riverside", 51.0546, -114.0402),
];

test("matches her community by name, ignoring case and spacing", () => {
  assert.deepEqual(resolveHomeArea(AREAS, { community: "DOWNTOWN EAST VILLAGE", lat: null, lng: null }), {
    index: 1,
    matchedBy: "name",
  });
  assert.deepEqual(resolveHomeArea(AREAS, { community: "  bridgeland/riverside ", lat: 51.0, lng: -114.1 }), {
    index: 2,
    matchedBy: "name",
  });
});

test("falls back to the area nearest her home point, and to null without one", () => {
  // a point by the east village, under a community name the snapshot does not have
  assert.deepEqual(resolveHomeArea(AREAS, { community: "EAST VILLAGE", lat: 51.046, lng: -114.052 }), {
    index: 1,
    matchedBy: "nearest",
  });
  assert.deepEqual(resolveHomeArea(AREAS, { community: null, lat: 51.017, lng: -114.1 }), { index: 0, matchedBy: "nearest" });
  assert.equal(resolveHomeArea(AREAS, { community: "Nowhere", lat: null, lng: null }), null);
  assert.equal(resolveHomeArea([], { community: "Altadore", lat: 51, lng: -114 }), null);
});

test("picks the lowest-cost place of each kind and skips unknown costs", () => {
  const resources = [
    place("a", "Pharmacy"),
    place("b", "Pharmacy"),
    place("c", "Hospital"),
    place("d", "Pharmacy"),
    place("e", "Library"),
    place("f", "Ambulatory Health Care Services"),
  ];
  const costs = [9.5, 2.1, null, 4, Number.NaN, 0.5];
  const nearest = nearestByCategory(resources, costs, ["Pharmacy", "Hospital", "Library"]);
  assert.equal(nearest.Pharmacy?.resource.id, "b");
  assert.equal(nearest.Pharmacy?.cost, 2.1);
  assert.equal(nearest.Hospital, null);
  assert.equal(nearest.Library, null);
  assert.ok(!("Ambulatory Health Care Services" in nearest));
});

test("accepts only the listed drive-time windows", () => {
  assert.equal(parseHomeThreshold(null), 20);
  assert.equal(parseHomeThreshold("10"), 10);
  assert.equal(parseHomeThreshold("45"), 45);
  for (const bad of ["12", "0", "-10", "20.0", "1e1", "", "abc", "200"]) assert.equal(parseHomeThreshold(bad), null, bad);
});

test("reads group profiles and sizes without inventing an order", () => {
  assert.deepEqual(
    typicalCounts({ "Library_30min": 19.6, "Pharmacy_20min": 63.29, odd: 1 }, ["Pharmacy", "Library"]),
    [
      { category: "Pharmacy", minutes: 20, mean: 63.29 },
      { category: "Library", minutes: 30, mean: 19.6 },
    ],
  );
  assert.deepEqual(clusterSizes([1, 0, null, 0, -1, 0]), [
    { cluster: 0, areas: 3 },
    { cluster: 1, areas: 1 },
  ]);
});

test("shows a model suggestion only for published types the classifier was trained on", () => {
  const labels = classifierLabels({
    selected_model: "Random Forest",
    results: [
      { model: "Logistic Regression", labels: ["Pharmacy"] },
      { model: "Random Forest", labels: ["Hospital", "Health Centre", "Pharmacy"] },
    ],
  });
  assert.deepEqual([...(labels ?? [])], ["Hospital", "Health Centre", "Pharmacy"]);
  assert.equal(modelSuggestion({ category: "Hospital", modelCategory: "Health Centre" }, labels), "Health Centre");
  assert.equal(modelSuggestion({ category: "Pharmacy", modelCategory: "Pharmacy" }, labels), null);
  // a library can never be predicted as one, so the model's output for it is not a disagreement
  assert.equal(modelSuggestion({ category: "Library", modelCategory: "Diagnostic Services" }, labels), null);
  assert.equal(modelSuggestion({ category: "Hospital", modelCategory: "Health Centre" }, null), null);
  assert.equal(classifierLabels({ selected_model: "Random Forest", results: [{ model: "Random Forest" }] }), null);
});

// ---------- inline map geometry and the nearby query (PRD 10.2) ----------

test("the map projection keeps points inside the padding, north up and true to cos(latitude)", () => {
  const points = [
    { lat: 51.045, lon: -114.055 },
    { lat: 51.06, lon: -114.03 },
    { lat: 51.03, lon: -114.08 },
  ];
  const projection = fitProjection(boundsAround(points), 640, 16);
  for (const point of points) {
    const x = projection.x(point.lon);
    const y = projection.y(point.lat);
    assert.ok(x >= 16 && x <= 624, `x ${x}`);
    assert.ok(y >= 16 && y <= projection.height - 16, `y ${y}`);
  }
  assert.ok(projection.y(51.06) < projection.y(51.03), "north maps to a smaller y");

  // a square in kilometres is square on screen: the longitude span is widened by 1 / cos(latitude)
  const lat = 51;
  const halfLat = 1 / KM_PER_DEGREE;
  const halfLon = 1 / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const square = fitProjection(
    { west: -114 - halfLon, east: -114 + halfLon, south: lat - halfLat, north: lat + halfLat },
    400,
    0,
  );
  assert.ok(Math.abs(square.height - 400) <= 1, `height ${square.height}`);
  assert.ok(Math.abs(square.pxPerKm - 200) < 0.5, `pxPerKm ${square.pxPerKm}`);
});

test("bounds around one point are still readable, and unusable points are skipped", () => {
  const one = boundsAround(
    [
      { lat: 51.045, lon: -114.055 },
      { lat: Number.NaN, lon: -100 },
      { lat: 60, lon: Infinity },
    ],
    { minSpanKm: 1.5, padRatio: 0 },
  );
  const heightKm = (one.north - one.south) * KM_PER_DEGREE;
  const widthKm = (one.east - one.west) * KM_PER_DEGREE * Math.cos((51.045 * Math.PI) / 180);
  assert.ok(heightKm >= 1.49 && heightKm < 1.6, `height ${heightKm} km`);
  assert.ok(widthKm >= 1.49 && widthKm < 1.6, `width ${widthKm} km`);
  assert.ok(one.south < 51.045 && one.north > 51.045 && one.west < -114.055 && one.east > -114.055);

  const padded = boundsAround([
    { lat: 51.0, lon: -114.1 },
    { lat: 51.1, lon: -114.0 },
  ]);
  assert.ok(padded.south < 51.0 && padded.north > 51.1 && padded.west < -114.1 && padded.east > -114.0);
});

test("ring paths close each ring and skip rings too short to draw", () => {
  const projection = { x: (lon: number) => lon * 10, y: (lat: number) => -lat * 10 };
  const path = ringsPath(
    [
      [[0, 0], [1, 0], [1, 1], [0, 0]],
      [[5, 5], [6, 6]],
      [[2, 2], [Number.NaN, 3], [3, 2]],
    ],
    projection,
  );
  assert.equal(path, "M0,0L10,0L10,-10L0,0Z");
  const rings = ringsOfGeometry(
    {
      type: "MultiPolygon",
      coordinates: [
        [[[-114.123456, 51.1], [-114.1, 51.1], [-114.1, 51.2], [-114.123456, 51.1]]],
        [[[1, 1], [2, 2]]],
      ],
    },
    5,
  );
  assert.deepEqual(rings, [[[-114.12346, 51.1], [-114.1, 51.1], [-114.1, 51.2], [-114.12346, 51.1]]]);
  assert.deepEqual(ringsOfGeometry({ type: "Point", coordinates: [1, 2] }), []);
  assert.equal(ringsIntersect(rings, { west: -114.11, south: 51.15, east: -114.0, north: 51.3 }), true);
  assert.equal(ringsIntersect(rings, { west: -113, south: 51.15, east: -112, north: 51.3 }), false);
});

test("the nearby query accepts the listed values and rejects everything else", () => {
  const parse = (query: string) => parseNearbyQuery(new URLSearchParams(query));
  assert.deepEqual(parse(""), {
    types: ["pharmacy", "clinic", "hospital", "public_health", "social_support", "community_centre", "library"],
    radiusKm: 3,
    accessible: "any",
    perType: 4,
    address: null,
  });
  assert.deepEqual(
    parse("types=hospital,pharmacy,transit,pharmacy&radiusKm=2&accessible=yes&perType=8&address=+800+3+St+SE+"),
    { types: ["hospital", "pharmacy", "transit"], radiusKm: 2, accessible: "yes", perType: 8, address: "800 3 St SE" },
  );
  for (const bad of [
    "radiusKm=4",
    "radiusKm=3.0",
    "radiusKm=",
    "types=pharmacy,spa",
    "types=",
    "types=pharmacy,,library",
    "types=__proto__",
    "types=toString",
    "perType=9",
    "perType=0",
    "perType=2.5",
    "accessible=no",
    `address=${"a".repeat(201)}`,
  ]) {
    assert.equal(parse(bad), null, bad);
  }
  assert.equal(parse(`address=${"a".repeat(200)}`)?.address?.length, 200);
});
