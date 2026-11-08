import { test } from "node:test";
import assert from "node:assert/strict";
import { runResources, type ResourceOutput, type ResourceRow } from "../resources.ts";
import type { ModelCaller } from "../model.ts";
import { fakeCaller } from "./fakeCaller.ts";

// fictional rows; real rows carry the dataset URL and fetch date the same way
const rows: ResourceRow[] = [
  {
    id: "res-pharmacy",
    kind: "pharmacy",
    name: "Demo Pharmacy",
    address: "100 Example St SW",
    openingHours: "Mo-Su 09:00-21:00",
    wheelchair: null,
    source: "OpenStreetMap",
    sourceUrl: "https://www.openstreetmap.org/copyright",
    fetchedAt: "2026-11-07",
    meters: 420,
  },
];

test("A6 regenerates once on an unsupported claim, drops unknown ids, and renders accessibility from the row", async () => {
  const replies: ResourceOutput[] = [
    { cards: [{ resourceId: "res-pharmacy", why: "Close by and accepting new patients.", caveats: "" }] },
    {
      cards: [
        { resourceId: "res-pharmacy", why: "A pharmacy about 420 m away.", caveats: "Confirm hours before you go." },
        { resourceId: "res-invented", why: "Another pharmacy.", caveats: "" },
      ],
    },
  ];
  const first = fakeCaller({ text: JSON.stringify(replies[0]) });
  const second = fakeCaller({ text: JSON.stringify(replies[1]) });
  let calls = 0;
  const caller: ModelCaller = (params) => (calls++ === 0 ? first.caller(params) : second.caller(params));
  let reserved = 0;
  const result = await runResources(
    { need: "pharmacy open Sunday evening", rows },
    { caller },
    { beforeRegenerate: async () => ++reserved > 0 },
  );
  assert.equal(result.regenerated, true);
  assert.equal(reserved, 1);
  assert.equal(result.cards.length, 1);
  const [card] = result.cards;
  assert.equal(card.why, "A pharmacy about 420 m away.");
  assert.equal(card.accessibility, "Accessibility unknown");
  assert.equal(card.hours, "Mo-Su 09:00-21:00");
  assert.equal(card.sourceUrl, "https://www.openstreetmap.org/copyright");
  assert.equal(card.fetchedAt, "2026-11-07");
});

test("A6 removes the model text when the claim survives the retry", async () => {
  const fake = fakeCaller({ text: JSON.stringify({ cards: [{ resourceId: "res-pharmacy", why: "Walk-in available.", caveats: "" }] }) });
  const result = await runResources({ need: "pharmacy", rows }, { caller: fake.caller });
  assert.equal(fake.requests.length, 2);
  assert.equal(result.cards[0].why, null);
  assert.equal(result.cards[0].caveats, null);
});
