// the words and flat-map geometry behind the nearby cards and their map (components/app/resources)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundsAround,
  checkedOn,
  compassText,
  distanceText,
  emptyText,
  firstPageSize,
  fitProjection,
  hoursText,
  mapBounds,
  orderResources,
  originText,
  placeMarkers,
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

test("transit counts name their real 800 m counting distance, and a longer distance is offered only when it helps", () => {
  const counts = [
    { type: "pharmacy", label: "Pharmacies", shown: 2, withinRadius: 9, withinKm: 5 },
    { type: "transit", label: "Transit stops", shown: 3, withinRadius: 75, withinKm: 0.8 },
  ] as const;
  assert.equal(
    summaryText({ radiusKm: 5, counts }, false),
    "Within 5 km in a straight line: 9 pharmacies. Within 800 m in a straight line: 75 transit stops.",
  );
  assert.equal(
    summaryText({ radiusKm: 5, counts: [{ ...counts[1], withinRadius: 0 }] }, false),
    "Within 800 m in a straight line: no transit stops.",
  );
  assert.equal(
    emptyText(["transit"], 5, false, counts),
    "No transit stops within 800 m in these public lists. Try another kind of place.",
  );
  assert.equal(
    emptyText(["pharmacy", "transit"], 1, false, counts),
    "No pharmacies within 1 km, and no transit stops within 800 m in these public lists. Try a longer distance.",
  );
  assert.match(emptyText(["pharmacy"], 5, false), /Try another kind of place\.$/);
});

test("the first page holds the closest of each kind, so a far hospital card is never behind Show more", () => {
  const types = ["pharmacy", "clinic", "public_health", "social_support", "community_centre", "library"] as const;
  const resources = [
    ...types.flatMap((type, index) => [
      place({ id: `${type}-1`, type, distanceKm: 0.2 + index / 10 }),
      place({ id: `${type}-2`, type, distanceKm: 1 + index / 10 }),
    ]),
    place({ id: "far-hospital", type: "hospital", distanceKm: 5.8, withinRadius: false }),
  ];
  const ordered = orderResources(resources);
  const first = ordered.slice(0, firstPageSize(ordered, 6));
  assert.equal(first.length, 7);
  assert.ok(first.some((resource) => resource.id === "far-hospital"));
  assert.equal(firstPageSize(ordered.slice(0, 3), 6), 6);
});

test("the map fits home and the chosen distance, not a far hospital, and every card keeps its own marker", () => {
  const origin = FIXTURE.origin;
  const resources = FIXTURE.resources as NearbyResourceView[];
  const bounds = mapBounds(origin, FIXTURE.radiusKm, resources);
  assert.ok(bounds);
  const hospital = resources.find((resource) => resource.id === "h1")!;
  assert.ok(hospital.lon < bounds.west, "the far hospital doesn’t widen the map");
  const kmNorth = (bounds.north - origin.lat) * 111.2;
  const kmWest = (origin.lon - bounds.west) * 111.2 * Math.cos((origin.lat * Math.PI) / 180);
  assert.ok(kmNorth >= FIXTURE.radiusKm && kmWest >= FIXTURE.radiusKm, "the whole distance circle is in view");

  const sizes = { markerR: 13, hitR: 22, homeR: 16, gap: 4, edge: 25 };
  for (const [width, height] of [
    [640, 371],
    [340, 323],
  ]) {
    const projection = fitProjection(bounds, width, height);
    const home = { x: projection.x(origin.lon), y: projection.y(origin.lat) };
    // t1 sits about 20 m from home, and a fifth place shares p1's exact spot
    const points = [...resources, { ...resources[0], id: "p1-twin" }].map((resource) => ({
      x: projection.x(resource.lon),
      y: projection.y(resource.lat),
    }));
    const placed = placeMarkers(points, home, { width, height }, sizes);
    assert.equal(placed.length, points.length);
    placed.forEach((marker, i) => {
      assert.ok(marker.x >= 19 && marker.x <= width - 19 && marker.y >= 19 && marker.y <= height - 19, `${i} is on the map`);
      assert.ok(Math.hypot(marker.x - home.x, marker.y - home.y) >= 13 + 16 + 4 - 0.5, `${i} covers home`);
      placed.forEach((other, j) => {
        if (j > i) assert.ok(Math.hypot(other.x - marker.x, other.y - marker.y) >= 2 * 13 + 4 - 0.5, `${i} and ${j} overlap`);
      });
      assert.ok(marker.hitR >= 16 && marker.hitR <= 22);
      // a marker away from its spot always says so: an edge arrow or a line back to the spot
      const away = Math.hypot(marker.x - marker.trueX, marker.y - marker.trueY) > 1.5;
      if (away) assert.ok(marker.clamped || marker.moved, `${i} is off its spot without a cue`);
    });
    const far = placed[2];
    assert.equal(far.clamped, true, "the far hospital sits at the edge");
    // about 5.3 km west and 2.2 km north of home
    assert.equal(compassText(far.trueX - home.x, far.trueY - home.y), "north-west");
    assert.ok(far.x < home.x && far.y < home.y, "the edge marker sits on the home side toward the hospital");
    // its arrow points toward the real place
    const heading = Math.atan2(far.trueY - far.y, far.trueX - far.x);
    assert.ok(Math.abs(heading - (far.angle * Math.PI) / 180) < 1e-9);
    assert.ok(placed[0].moved || placed[4].moved, "the twins are fanned out");
    assert.ok(placed[3].moved, "the stop beside home is moved off the home glyph");
  }

  // a dense downtown list at 5 km on a phone: 18 places within about 400 m of home still get separate markers
  const projection = fitProjection(mapBounds(origin, 5, [])!, 340, 323);
  const home = { x: projection.x(origin.lon), y: projection.y(origin.lat) };
  const dense = Array.from({ length: 18 }, (_, i) => ({
    x: projection.x(origin.lon + Math.cos(i) * 0.004 * ((i % 3) + 1) / 3),
    y: projection.y(origin.lat + Math.sin(i) * 0.003 * ((i % 3) + 1) / 3),
  }));
  const placed = placeMarkers(dense, home, { width: 340, height: 323 }, sizes);
  placed.forEach((marker, i) => {
    placed.forEach((other, j) => {
      if (j > i) assert.ok(Math.hypot(other.x - marker.x, other.y - marker.y) >= 2 * 13 + 4 - 0.5, `${i} and ${j} overlap`);
    });
    assert.ok(Math.hypot(marker.x - home.x, marker.y - home.y) >= 13 + 16 + 4 - 0.5, `${i} covers home`);
  });
});
