import assert from "node:assert/strict";
import { test } from "node:test";
import type { CareFactView } from "./live-api.ts";
import { pendingSteps } from "../../components/app/care/care-data.ts";
import {
  consequenceLine,
  noteLabel,
  reviewSourceLine,
  sectionTitle,
  sourceContext,
  summarize,
  summaryRows,
  summarySentence,
  type Outcome,
} from "../../components/app/care/review-data.ts";

// the PRD 5.2 voice note
const TRANSCRIPT =
  "Rosa usually has breakfast at eight. She prefers instructions written down. Her spare glasses are in the bedroom drawer. She likes the radio on in the morning.";

function fact(over: Partial<CareFactView> & { id: string; textExact: string }): CareFactView {
  const at = TRANSCRIPT.indexOf(over.textExact);
  return {
    category: "routine",
    status: "suggested",
    sourceId: "s1",
    sourceKind: "voice",
    spanStart: at === -1 ? null : at,
    spanEnd: at === -1 ? null : at + over.textExact.length,
    conflictsWith: [],
    events: [],
    createdAt: "2026-11-07T18:00:00.000Z",
    version: 1,
    supersedes: null,
    sourceAuthor: "caregiver",
    sourceCreatedAt: "2026-11-07T18:00:00.000Z",
    displayText: null,
    ...over,
  };
}

test("each suggestion is labelled with its passport section, practical needs included", () => {
  assert.equal(sectionTitle("routine"), "Daily routine");
  assert.equal(sectionTitle("communication"), "Communication & accessibility");
  assert.equal(sectionTitle("mobility"), "Communication & accessibility");
  assert.equal(sectionTitle("preference"), "Preferences & interests");
  assert.equal(sectionTitle("practical"), "Practical needs & belongings");
  assert.equal(sectionTitle("logistics"), "Contacts & logistics");
});

test("the source line names the kind, who gave it and the source date", () => {
  assert.equal(reviewSourceLine(fact({ id: "f1", textExact: "x" })), "Voice note from you, Nov 7");
  assert.equal(
    reviewSourceLine(fact({ id: "f1", textExact: "x", sourceKind: "note", sourceAuthor: null, sourceCreatedAt: null })),
    "Typed note, Nov 7",
  );
});

test("source context shows the quoted sentence among its neighbours, using the stored span", () => {
  const glasses = fact({ id: "f3", textExact: "Her spare glasses are in the bedroom drawer.", category: "practical" });
  const context = sourceContext(TRANSCRIPT, glasses);
  assert.ok(context);
  assert.equal(context.quote, glasses.textExact);
  assert.equal(context.before, "She prefers instructions written down. ");
  assert.equal(context.after, " She likes the radio on in the morning.");
  assert.equal(context.cutStart, true);
  assert.equal(context.cutEnd, false);
  // the marked part is the exact quote, at the exact place in the transcript
  const rebuilt = `${context.before}${context.quote}${context.after}`;
  assert.ok(TRANSCRIPT.includes(rebuilt));
});

test("source context falls back to the first exact match when the span is off, and gives up when the quote is not there", () => {
  const radio = fact({ id: "f4", textExact: "She likes the radio on in the morning.", spanStart: 0, spanEnd: 5 });
  const context = sourceContext(TRANSCRIPT, radio);
  assert.ok(context);
  assert.equal(context.quote, radio.textExact);
  assert.equal(context.after, "");
  assert.equal(sourceContext(TRANSCRIPT, fact({ id: "f5", textExact: "She takes two pills at noon." })), null);
  // a one-sentence note adds nothing beyond the quote
  assert.equal(sourceContext("Rosa naps at two.", fact({ id: "f6", textExact: "Rosa naps at two." })), null);
});

test("a long sentence is trimmed around the quote at word edges", () => {
  const long = `${"word ".repeat(80)}Rosa likes tea. ${"more ".repeat(80)}`.trim();
  const context = sourceContext(long, fact({ id: "f7", textExact: "Rosa likes tea.", spanStart: null, spanEnd: null }), 80);
  assert.ok(context);
  assert.ok(context.before.length + context.quote.length + context.after.length <= 80);
  assert.ok(context.cutStart && context.cutEnd);
  assert.match(context.before, /^word /);
});

test("a timed suggestion says what approving adds, never an instruction", () => {
  const breakfast = fact({
    id: "f1",
    textExact: "Rosa usually has breakfast at eight.",
    events: [
      {
        id: "e1",
        title: "Breakfast",
        startsAt: "2026-11-08T14:00:00.000Z",
        rrule: "FREQ=DAILY",
        remindMinutes: null,
        locationText: null,
        status: "suggested",
      },
    ],
  });
  assert.equal(consequenceLine("Rosa", breakfast), "Approving adds it to Rosa’s day at 8:00 a.m. every day.");
  const once = { ...breakfast, events: [{ ...breakfast.events[0], rrule: null }] };
  assert.equal(consequenceLine("Rosa", once), "Approving adds it to Rosa’s day on Sun, Nov 8 at 8:00 a.m.");
  assert.equal(consequenceLine("Rosa", fact({ id: "f2", textExact: "She prefers instructions written down." })), null);
});

test("conflict notes are labelled by the provider that wrote them; demo rules are never called AI", () => {
  assert.equal(noteLabel("demo"), "Demo rules note");
  assert.doesNotMatch(noteLabel("demo") ?? "", /\bAI\b/);
  assert.equal(noteLabel("anthropic"), "Claude’s note");
  assert.equal(noteLabel("bedrock"), "Claude’s note, via Amazon Bedrock");
  assert.equal(noteLabel(undefined), null);
  assert.equal(noteLabel("something-else"), null);
});

test("the summary counts approved, edited, rejected and left for later, staying compatible with approved + kept", () => {
  const facts = [
    fact({ id: "a", textExact: "Rosa usually has breakfast at eight.", status: "approved" }),
    fact({ id: "b", textExact: "She prefers instructions written down.", status: "superseded" }),
    fact({ id: "c", textExact: "Her spare glasses are in the bedroom drawer.", status: "rejected" }),
    fact({ id: "d", textExact: "She likes the radio on in the morning." }),
    fact({ id: "e", textExact: "Rosa naps at two." }),
    fact({ id: "x1", textExact: "Breakfast at 8:00.", status: "conflicting", conflictsWith: ["x2"] }),
    fact({ id: "x2", textExact: "Breakfast at 8:30.", status: "conflicting", conflictsWith: ["x1"] }),
  ];
  const steps = pendingSteps(
    facts.map((item) => ({ ...item, status: item.status === "conflicting" ? "conflicting" : "suggested" })),
  );
  assert.equal(steps.length, 6);
  const outcomes: Record<string, Outcome> = {
    "fact:a": { kind: "approved" },
    "fact:b": { kind: "edited", factId: "b2", text: "Write instructions down for her.", original: "She prefers instructions written down." },
    "fact:c": { kind: "rejected", text: "Her spare glasses are in the bedroom drawer." },
    "fact:d": { kind: "skipped" },
  };
  // "e" and the conflict were never reached and are still open, so they wait for later too
  const summary = summarize(steps, outcomes, facts);
  assert.deepEqual(summary, { approved: 2, kept: 0, skipped: 3, edited: 1, rejected: 1 });
  assert.deepEqual(
    summaryRows(summary).map((row) => [row.label, row.count]),
    [
      ["Approved as written", 1],
      ["Edited and approved", 1],
      ["Rejected", 1],
      ["Left for later", 3],
    ],
  );
  assert.equal(summarySentence(summary), "1 approved as written, 1 edited and approved, 1 rejected, 3 left for later.");

  const kept = summarize(steps, { ...outcomes, [steps[0].key]: { kind: "kept", factId: "x2" } }, facts);
  assert.equal(kept.kept, 1);
  assert.equal(kept.skipped, 2);
  assert.ok(summaryRows(kept).some((row) => row.key === "kept"));
});
