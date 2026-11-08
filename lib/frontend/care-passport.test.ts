import assert from "node:assert/strict";
import { test } from "node:test";
import {
  factSummary,
  openItems,
  passportGroups,
  provenanceLine,
  sourceParts,
  uniqueOpenQuestions,
  versionLabel,
} from "../../components/app/care/care-data.ts";
import type { CareFactView } from "./live-api.ts";

function fact(overrides: Partial<CareFactView> & Pick<CareFactView, "id">): CareFactView {
  return {
    category: "routine",
    textExact: "Rosa usually has breakfast at 8:00.",
    status: "approved",
    sourceId: "s1",
    sourceKind: "voice",
    spanStart: null,
    spanEnd: null,
    conflictsWith: [],
    events: [],
    createdAt: "2026-11-08T15:00:00.000Z",
    version: 1,
    supersedes: null,
    sourceAuthor: "caregiver",
    sourceCreatedAt: "2026-11-08T14:59:00.000Z",
    displayText: null,
    ...overrides,
  };
}

test("passport groups put approved facts in their sections and never show pending ones", () => {
  const facts = [
    fact({ id: "a", category: "routine" }),
    fact({ id: "b", category: "communication", textExact: "She prefers instructions written down." }),
    fact({ id: "c", category: "mobility", textExact: "She uses a walker on stairs." }),
    fact({ id: "d", category: "practical", textExact: "Her spare glasses are in the bedroom drawer." }),
    fact({ id: "e", category: "preference", textExact: "She likes the radio on in the morning." }),
    fact({ id: "f", category: "routine", status: "suggested" }),
    fact({ id: "g", category: "routine", status: "conflicting" }),
    fact({ id: "h", category: "routine", status: "superseded" }),
    fact({ id: "i", category: "something_new" }),
  ];
  const groups = passportGroups(facts);
  assert.deepEqual(
    groups.map((group) => group.section.id),
    ["routine", "communication", "preferences", "practical", "contacts", "instructions"],
  );
  const ids = Object.fromEntries(groups.map((group) => [group.section.id, group.facts.map((item) => item.id)]));
  assert.deepEqual(ids.routine, ["a"]);
  assert.deepEqual(ids.communication.sort(), ["b", "c"]);
  assert.deepEqual(ids.preferences, ["e"]);
  assert.deepEqual(ids.practical.sort(), ["d", "i"]);
  assert.deepEqual(ids.contacts, []);
});

test("fact summary uses the short label, trims long quotes, and never trims written instructions", () => {
  const long = `${"Take the blue folder to every appointment and ".repeat(4)}ask for the printed copy.`;
  assert.equal(factSummary(fact({ id: "a", displayText: "Breakfast around 8" })), "Breakfast around 8");
  assert.ok(factSummary(fact({ id: "b", textExact: long })).endsWith("…"));
  assert.ok(factSummary(fact({ id: "b", textExact: long })).length <= 101);
  const written = fact({ id: "c", category: "medical_instruction", textExact: long, displayText: "Folder" });
  assert.equal(factSummary(written), long);
});

test("provenance names the source kind, date and author without guessing", () => {
  assert.equal(provenanceLine(fact({ id: "a" })), "From a voice note, added Nov 8 by you");
  assert.equal(
    provenanceLine(fact({ id: "b", sourceKind: "document", sourceAuthor: null })),
    "From a PDF, added Nov 8",
  );
  assert.equal(
    provenanceLine(fact({ id: "c", sourceKind: null, sourceAuthor: "Sam", sourceCreatedAt: null })),
    "Source unknown, added Nov 8 by Sam",
  );
  assert.equal(versionLabel(fact({ id: "d" })), null);
  assert.equal(versionLabel(fact({ id: "e", version: 2 })), "Edited — version 2");
});

test("source parts mark the fact's span, fall back to an exact match, and mark nothing when absent", () => {
  const full = "Rosa usually has breakfast at 8:00. Her spare glasses are in the bedroom drawer.";
  const glasses = "Her spare glasses are in the bedroom drawer.";
  const start = full.indexOf(glasses);
  assert.deepEqual(sourceParts(full, { spanStart: start, spanEnd: start + glasses.length, textExact: glasses }), {
    before: "Rosa usually has breakfast at 8:00. ",
    match: glasses,
    after: "",
  });
  // a stale span is not trusted
  assert.equal(sourceParts(full, { spanStart: 0, spanEnd: 10, textExact: glasses })?.match, glasses);
  assert.equal(sourceParts(full, { spanStart: 0, spanEnd: 999, textExact: glasses })?.before.length, start);
  assert.equal(sourceParts(full, { spanStart: null, spanEnd: null, textExact: "Not in this note." }), null);
});

test("open items group conflicts, count suggestions and list each question once", () => {
  const facts = [
    fact({ id: "x", status: "conflicting", conflictsWith: ["y"], createdAt: "2026-11-08T15:00:00.000Z" }),
    fact({
      id: "y",
      status: "conflicting",
      conflictsWith: ["x"],
      textExact: "Breakfast is at 8:30.",
      createdAt: "2026-11-08T16:00:00.000Z",
    }),
    fact({ id: "s1", status: "suggested" }),
    fact({ id: "s2", status: "suggested" }),
    fact({ id: "ok", status: "approved" }),
  ];
  const open = openItems(facts);
  assert.equal(open.conflicts.length, 1);
  assert.deepEqual(open.conflicts[0].map((item) => item.id), ["x", "y"]);
  assert.equal(open.suggested, 2);
  assert.equal(open.steps.length, 3);
  assert.equal(open.steps[0].kind, "conflict");

  const questions = uniqueOpenQuestions([
    { id: "1", question: "Does she take sugar?", askedBy: null },
    { id: "2", question: "does she take sugar", askedBy: null },
    { id: "3", question: "Who picks her up?", askedBy: null },
  ]);
  assert.deepEqual(questions.map((item) => item.id), ["1", "3"]);
});
