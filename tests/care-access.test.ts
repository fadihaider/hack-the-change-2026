import assert from "node:assert/strict";
import test from "node:test";
import type { AccessArea, AccessResource } from "../lib/care-access/engine.ts";
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
