// the words and flat-map geometry behind the nearby cards and their map (components/app/resources)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundsAround,
  checkedOn,
  distanceText,
  emptyText,
  fitProjection,
  hoursText,
  orderResources,
  originText,
  ringsPath,
  summaryText,
  telHref,
  typeText,
  wheelchairText,
} from "../../components/app/resources/nearby-words.ts";
import { createLiveApi, type NearbyResourceView } from "./live-api.ts";

function place(overrides: Partial<NearbyResourceView> & Pick<NearbyResourceView, "id" | "type">): NearbyResourceView {
  return {
    typeLabel: overrides.type,
    kind: overrides.type,
    name: `Place ${overrides.id}`,
    address: null,
    lat: 51.045,
    lon: -114.055,
    distanceKm: 1,
    withinRadius: true,
    phone: null,
    hours: { text: null, status: "unknown" },
    wheelchair: "unknown",
    source: "OpenStreetMap contributors",
    sourceUrl: "https://www.openstreetmap.org/node/1",
    license: "ODbL",
    fetchedAt: "2026-11-07",
    ...overrides,
  };
}

const FIXTURE = {
  origin: { lat: 51.045, lon: -114.055, label: "Rosa’s home", community: "DOWNTOWN EAST VILLAGE", approximate: true },
  radiusKm: 2,
  method: "straight_line",
  resources: [
    place({ id: "p1", type: "pharmacy", distanceKm: 0.4, lat: 51.046, lon: -114.05 }),
    place({ id: "p2", type: "pharmacy", distanceKm: 0.9, lat: 51.04, lon: -114.06, hours: { text: "Mo-Su 08:00-22:00", status: "open" } }),
    place({ id: "h1", type: "hospital", distanceKm: 5.8, withinRadius: false, lat: 51.065, lon: -114.13 }),
    place({ id: "t1", type: "transit", distanceKm: 0.1, lat: 51.0452, lon: -114.0548 }),
  ],
  outlines: [
    {
      name: "DOWNTOWN EAST VILLAGE",
      rings: [
        [
          [-114.06, 51.04],
          [-114.04, 51.04],
          [-114.04, 51.05],
          [-114.06, 51.05],
          [-114.06, 51.04],
        ],
      ],
    },
  ],
  bounds: { west: -114.14, south: 51.03, east: -114.03, north: 51.07 },
  counts: [
    { type: "pharmacy", label: "Pharmacies", shown: 2, withinRadius: 9 },
    { type: "hospital", label: "Hospitals", shown: 1, withinRadius: 0 },
    { type: "transit", label: "Transit stops", shown: 1, withinRadius: 1 },
  ],
  limits: ["Distances are straight lines from the home address, not travel times."],
};

test("the nearby client sends the filters and parses the contract", async () => {
  const api = createLiveApi(async (url) => {
    const query = new URL(String(url), "http://local").searchParams;
    assert.equal(query.get("types"), "hospital,pharmacy,transit");
    assert.equal(query.get("radiusKm"), "2");
    assert.equal(query.get("accessible"), "yes");
    assert.equal(query.get("perType"), "4");
    return Response.json(FIXTURE);
  });
  const view = await api.nearby({ types: ["hospital", "pharmacy", "transit"], radiusKm: 2, accessible: "yes", perType: 4 });
  assert.equal(view.resources.length, 4);
  assert.equal(view.method, "straight_line");
});

test("cards list the closest of each kind first, inside the distance first, one card per id", () => {
  const ordered = orderResources([...FIXTURE.resources, FIXTURE.resources[0]] as NearbyResourceView[]);
  assert.deepEqual(
    ordered.map((resource) => resource.id),
    ["t1", "p1", "h1", "p2"],
  );
  const openFirst = orderResources(FIXTURE.resources as NearbyResourceView[], { openFirst: true });
  assert.deepEqual(
    openFirst.map((resource) => resource.id),
    ["t1", "p2", "h1", "p1"],
  );
});

test("unknown stays Unknown: hours, access, address-free wording", () => {
  assert.deepEqual(hoursText({ text: null, status: "unknown" }), { text: "Hours unknown", status: null });
  assert.equal(hoursText({ text: "Mo-Fr 09:00-17:00", status: "closed" }).status, "Closed now by the listed hours");
  assert.equal(hoursText({ text: "Mo-Fr 09:00-17:00", status: "unknown" }).status, null);
  assert.equal(wheelchairText("unknown"), "Unknown");
  assert.equal(wheelchairText("no"), "No, per the source");
  assert.equal(distanceText(1.23), "1.2 km straight-line");
  assert.equal(distanceText(0.04), "under 0.1 km straight-line");
  assert.equal(typeText({ type: "clinic", kind: "doctors" }), "Doctor’s office");
  assert.equal(typeText({ type: "pharmacy", kind: "pharmacy" }), "Pharmacy");
  assert.equal(checkedOn("2026-11-07"), "Nov 7, 2026");
  assert.equal(checkedOn("soon"), null);
  assert.equal(telHref("(403) 555-0100"), "tel:4035550100");
  assert.equal(telHref("call the front desk"), null);
  assert.equal(originText(FIXTURE.origin), "Rosa’s home (approximate)");
});

test("the summary and empty text name the straight-line distance and never invent places", () => {
  assert.equal(
    summaryText(FIXTURE as never, false),
    "Within 2 km in a straight line: 9 pharmacies, no hospitals and 1 transit stop.",
  );
  assert.match(emptyText(["pharmacy"], 1, false), /^No pharmacies within 1 km in these public lists\. Try a longer/);
  assert.match(emptyText(["pharmacy"], 1, true), /Unknown isn’t the same as not accessible/);
});

test("the flat map keeps every point inside the box, north up, true to scale east-west", () => {
  const points = FIXTURE.resources.map((resource) => ({ lat: resource.lat, lon: resource.lon }));
  const bounds = boundsAround([...points, { lat: Number.NaN, lon: 0 }]);
  assert.ok(bounds);
  const projection = fitProjection(bounds, 640, 400, 24);
  for (const point of points) {
    const x = projection.x(point.lon);
    const y = projection.y(point.lat);
    assert.ok(x >= 24 && x <= 616, `x ${x}`);
    assert.ok(y >= 24 && y <= 376, `y ${y}`);
  }
  assert.ok(projection.y(51.06) < projection.y(51.04), "north is up");
  // one kilometre east and one kilometre north cover the same screen distance
  const east = projection.x(-114.05 + 1 / (111.2 * Math.cos((51.05 * Math.PI) / 180))) - projection.x(-114.05);
  const north = projection.y(51.05) - projection.y(51.05 + 1 / 111.2);
  assert.ok(Math.abs(east - north) / north < 0.01, `${east} vs ${north}`);
  assert.ok(Math.abs(projection.pxPerKm - north) / north < 0.01);

  const single = boundsAround([{ lat: 51.045, lon: -114.055 }]);
  assert.ok(single && (single.north - single.south) * 111.2 >= 1.5);
  assert.equal(boundsAround([]), null);

  const path = ringsPath([FIXTURE.outlines[0].rings[0] as [number, number][], [[-114, 51]]], projection);
  assert.match(path, /^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+){4}Z$/);
});
