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

// ---------------------------------------------------------------- slim explorer payloads and the classify proxy
// the /care/access explorer reads a slim basemap once and per-choice scores, instead of the 1 MB public snapshot

import type { AccessSnapshot } from "../lib/care-access/engine.ts";

const ALL_KINDS = "Pharmacy,Health Centre,Hospital,PHS Clinic,Social Dev Ctr,Community Centre,Library";

async function readSnapshotFile(): Promise<AccessSnapshot> {
  const { readFile } = await import("node:fs/promises");
  const file = new URL("../public/care-access/snapshot.json", import.meta.url);
  return JSON.parse(await readFile(file, "utf8")) as AccessSnapshot;
}

function pathNumbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

test("the basemap is a fraction of the snapshot, draws the same map and keeps the report numbers", async () => {
  const { GET } = await import("../app/api/care-access/basemap/route.ts");
  const { basemapSchema, projectAreas } = await import("../components/app/access/access-data.ts");
  const snapshot = await readSnapshotFile();
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") ?? "", /public/);
  const text = await response.text();
  assert.ok(text.length < 150_000, `basemap is ${text.length} bytes`);
  const raw = JSON.parse(text) as Record<string, unknown>;
  for (const heavy of ["distanceKm", "drivingMinutes"]) assert.ok(!(heavy in raw), heavy);
  const basemap = basemapSchema.parse(raw);

  assert.deepEqual(basemap.areas.map((item) => item.id), snapshot.areas.map((item) => item.id));
  assert.deepEqual(basemap.drivingCoverage, snapshot.drivingCoverage);
  assert.deepEqual(basemap.clusters, snapshot.clusters);
  assert.equal(basemap.drivingCoverage.filter((value) => value !== 1).length, 73);
  assert.equal(basemap.resources.total, snapshot.resources.length);
  assert.equal(
    basemap.resources.stepFreeConfirmed,
    snapshot.resources.filter((item) => item.wheelchair === true).length,
  );
  const ambulatory = snapshot.resources.filter((item) => item.category === "Ambulatory Health Care Services").length;
  assert.ok(ambulatory > 0);
  assert.deepEqual(basemap.excludedCategories, [{ category: "Ambulatory Health Care Services", resources: ambulatory }]);
  assert.equal(basemap.inference.configured, Boolean(process.env.CARE_ACCESS_INFERENCE_URL));

  // the report numbers come through untouched, including davies-bouldin and the trained label set
  const selected = snapshot.benchmark.clustering.selected as typeof snapshot.benchmark.clustering.selected & {
    davies_bouldin: number;
  };
  assert.equal(basemap.benchmark.clustering.selected.davies_bouldin, selected.davies_bouldin);
  assert.equal(basemap.benchmark.clustering.selected.silhouette, selected.silhouette);
  const forest = basemap.benchmark.classification.results.find((item) => item.model === "Random Forest");
  const original = snapshot.benchmark.classification.results.find((item) => item.model === "Random Forest");
  assert.equal(forest?.heldout_accuracy, original?.heldout_accuracy);
  assert.ok((forest?.labels?.length ?? 0) > 0);
  assert.ok(!JSON.stringify(basemap.benchmark).includes("confusion_matrix"));

  // rounded outlines land within a fraction of a pixel of the full ones
  const full = projectAreas(snapshot.areas);
  const slim = projectAreas(basemap.areas);
  assert.equal(slim.height, full.height);
  let worst = 0;
  full.shapes.forEach((shape, index) => {
    const a = pathNumbers(shape.d);
    const b = pathNumbers(slim.shapes[index].d);
    assert.equal(b.length, a.length, shape.id);
    a.forEach((value, i) => {
      worst = Math.max(worst, Math.abs(value - b[i]));
    });
  });
  assert.ok(worst <= 0.25, `largest shift ${worst}px`);
});

test("the scores view matches the full comparison without any place lists", async () => {
  const { GET } = await import("../app/api/care-access/route.ts");
  const { compareAreas } = await import("../lib/care-access/engine.ts");
  const { scoresSchema } = await import("../components/app/access/access-data.ts");
  const snapshot = await readSnapshotFile();
  const query = `mode=driving&threshold=20&categories=${encodeURIComponent(ALL_KINDS)}&stepFree=false`;
  const response = await GET(new Request(`http://localhost/api/care-access?${query}&view=scores`));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.length < 80_000, `scores are ${text.length} bytes`);
  const scores = scoresSchema.parse(JSON.parse(text));
  const full = compareAreas(snapshot, {
    mode: "driving",
    threshold: 20,
    categories: ALL_KINDS.split(","),
    stepFree: false,
  });
  assert.equal(scores.areas.length, full.length);
  scores.areas.forEach((row, index) => {
    assert.equal(row.id, full[index].area.id);
    assert.equal(row.score, full[index].score);
    assert.equal(row.inReach, full[index].resources.length);
    assert.deepEqual(row.counts, full[index].counts);
    assert.equal(row.routingCoverage, snapshot.drivingCoverage[index]);
  });
  assert.ok(!text.includes("sourceUrl"));
  assert.equal(scores.areas.filter((row) => row.score === null).length, 73);

  // the documented default and area responses keep their shape
  const one = await GET(new Request(`http://localhost/api/care-access?${query}&area=${snapshot.areas[0].id}`));
  assert.equal(one.status, 200);
  const area = (await one.json()) as { areas: Array<Record<string, unknown>>; provenance: unknown };
  assert.equal(area.areas.length, 1);
  assert.deepEqual(Object.keys(area.areas[0]).sort(), [
    "area",
    "cluster",
    "counts",
    "resources",
    "routingCoverage",
    "score",
    "unknownStepFree",
  ]);
  assert.ok(area.provenance);

  assert.equal((await GET(new Request(`http://localhost/api/care-access?${query}&view=everything`))).status, 400);
  const transit = await GET(new Request("http://localhost/api/care-access?mode=transit&threshold=20&view=scores"));
  assert.equal(transit.status, 422);
  const unknown = await GET(new Request(`http://localhost/api/care-access?${query}&view=scores&area=NOPE`));
  assert.equal(unknown.status, 404);
});

test("the classify proxy needs the signed-in owner and the same origin, and is rate limited", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "rr-classify-"));
  const saved: Record<string, string | undefined> = {
    RR_PGLITE_DIR: process.env.RR_PGLITE_DIR,
    APP_BASE_URL: process.env.APP_BASE_URL,
    CARE_ACCESS_INFERENCE_URL: process.env.CARE_ACCESS_INFERENCE_URL,
  };
  process.env.RR_PGLITE_DIR = dir;
  delete process.env.APP_BASE_URL;
  delete process.env.CARE_ACCESS_INFERENCE_URL;
  t.after(async () => {
    const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
    await (await holder.__reliefReadyPglite)?.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { POST } = await import("../app/api/care-access/classify/route.ts");
  const base = "http://localhost:3000";
  const send = async (body: string, origin: string | null = base) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (origin) headers.Origin = origin;
    const response = await POST(new Request(`${base}/api/care-access/classify`, { method: "POST", headers, body }));
    const data = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: data.error?.code };
  };
  const names = JSON.stringify({ texts: ["Community pharmacy"] });

  assert.deepEqual(await send(names, null), { status: 403, code: "invalid_origin" });
  assert.deepEqual(await send(names, "https://evil.example"), { status: 403, code: "invalid_origin" });
  assert.deepEqual(await send("{not json"), { status: 400, code: "invalid_input" });
  assert.deepEqual(await send(JSON.stringify({ texts: [] })), { status: 400, code: "invalid_input" });
  assert.deepEqual(await send(names), { status: 503, code: "classifier_not_configured" });

  let limited = 0;
  for (let i = 0; i < 30; i += 1) {
    const result = await send(names);
    if (result.status === 429) {
      assert.equal(result.code, "rate_limited");
      limited += 1;
    } else {
      assert.deepEqual(result, { status: 503, code: "classifier_not_configured" });
    }
  }
  assert.ok(limited > 0, "the per-owner limit kicks in");
});
