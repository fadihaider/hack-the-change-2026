import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createPgliteDatabase, type PgliteDatabase } from "../lib/mvp/database.ts";
import {
  buildGuide,
  communityAt,
  geocode,
  loadResources,
  nearest,
  nearestStops,
  normalizeAddress,
  openingStatus,
} from "../lib/mvp/resources.ts";

const persona = JSON.parse(readFileSync(path.join(process.cwd(), "data", "calgary", "persona.json"), "utf8")) as {
  address: string;
  lat: number;
  lng: number;
  community: string;
};
const ROSA = { lat: persona.lat, lng: persona.lng };
const CITY_HOSPITALS = [
  "Alberta Children's Hospital",
  "Rockyview General Hospital",
  "South Health Campus",
  "Peter Lougheed Medical Centre",
  "Foothills Hospital",
];
// saturday 2026-11-07 15:00 in alberta time (utc-6)
const SATURDAY_3PM = new Date("2026-11-07T21:00:00Z");
const noNetwork = (async () => {
  throw new Error("network is off in tests");
}) as typeof fetch;

let dir: string;
let db: PgliteDatabase;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-resources-"));
  db = await createPgliteDatabase(dir);
  const loaded = await loadResources(db);
  assert.ok(loaded.resources > 6000, "snapshots load into resource");
  assert.equal(loaded.communities, 313);
});

after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("opening hours are evaluated in alberta time and unknown hours stay unknown", () => {
  assert.equal(openingStatus("Mo-Fr 09:00-21:00", SATURDAY_3PM), "closed");
  assert.equal(openingStatus("Mo-Fr 09:00-21:00; Sa,Su 10:00-18:00", SATURDAY_3PM), "open");
  assert.equal(openingStatus("Mo-Fr 09:00-19:00, Sa 10:00-16:00, Su closed", SATURDAY_3PM), "open");
  assert.equal(openingStatus("Mo-Su 08:00-22:00; Sa off", SATURDAY_3PM), "closed");
  assert.equal(openingStatus("24/7", SATURDAY_3PM), "open");
  assert.equal(openingStatus("Fr 22:00-02:00", new Date("2026-11-07T07:30:00Z")), "open"); // sat 01:30
  assert.equal(openingStatus(null, SATURDAY_3PM), "unknown");
  assert.equal(openingStatus("by appointment", SATURDAY_3PM), "unknown");
});

test("addresses normalize to the city parcel format", () => {
  assert.deepEqual(normalizeAddress("#203 800 3rd Street S.E., Calgary, AB T2G 0E7"), { address: "800 3 ST SE", quadrant: "SE" });
  assert.equal(normalizeAddress("7007 - 14 Street SW").address, "7007 14 ST SW");
  assert.equal(normalizeAddress("800 3 St").quadrant, null);
});

test("nearest hospital to the persona is a real city hospital and stops are within 800 m", async () => {
  const [hospital] = await nearest(db, ROSA, ["hospital"], 1, 40_000);
  assert.ok(CITY_HOSPITALS.includes(hospital.name), `unexpected hospital ${hospital.name}`);
  assert.equal(hospital.source, "City of Calgary Community Services");
  assert.match(hospital.fetchedAt, /^\d{4}-\d{2}-\d{2}$/);

  const stops = await nearestStops(db, ROSA);
  assert.ok(stops.length > 0 && stops.length <= 3);
  for (const stop of stops) assert.ok(stop.meters <= 800, `${stop.name} is ${stop.meters} m away`);
  assert.equal(await communityAt(db, ROSA), persona.community);
});

test("the guide has sourced cards, follows tenure and rejects points outside calgary", async () => {
  const guide = await buildGuide(db, { address: persona.address, now: SATURDAY_3PM, tenure: "not_sure" }, { fetchImpl: noNetwork });
  assert.ok(guide.ok);
  const kinds = guide.cards.map((card) => card.kind);
  for (const kind of ["leave", "ei", "support", "hospital", "pharmacy", "transit"]) assert.ok(kinds.includes(kind as never), kind);
  for (const card of guide.cards) {
    assert.ok(card.source && card.sourceUrl.startsWith("https://") && card.fetchedAt, `${card.id} lacks a source`);
  }
  const pharmacy = guide.cards.find((card) => card.kind === "pharmacy");
  assert.ok(pharmacy?.details.some((detail) => detail.label === "Accessibility"));

  const noLeave = await buildGuide(db, { point: ROSA, now: SATURDAY_3PM, tenure: "no" });
  assert.ok(noLeave.ok && !noLeave.cards.some((card) => card.kind === "leave"));

  const edmonton = await buildGuide(db, { point: { lat: 53.5461, lng: -113.4938 }, now: SATURDAY_3PM, tenure: "yes" });
  assert.deepEqual(edmonton.ok ? null : edmonton.reason, "outside_calgary");

  const missingQuadrant = await geocode(db, "800 3 St", { fetchImpl: noNetwork });
  assert.deepEqual(missingQuadrant.ok ? null : missingQuadrant.reason, "needs_quadrant");
  assert.deepEqual(await loadResources(db), { resources: 0, communities: 0, rules: 0 });
});
