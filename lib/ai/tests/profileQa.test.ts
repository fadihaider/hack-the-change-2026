import { test } from "node:test";
import assert from "node:assert/strict";
import { EMERGENCY_REDIRECT, MEDICAL_REDIRECT } from "../medicalGuard.ts";
import { HEALTH_NOTICE, NOT_IN_PROFILE, redirectProfileQa, runProfileQa, type ApprovedFact } from "../profileQa.ts";
import { fakeCaller } from "./fakeCaller.ts";

const facts: ApprovedFact[] = [
  { id: "f-breakfast", category: "routine", textExact: "Breakfast at 8:30 with medication." },
  { id: "f-pain", category: "medical_instruction", textExact: "Take acetaminophen 500 mg every 6 hours as needed for pain." },
];

test("A5 drops invented citations and answers Not in profile with an open question", async () => {
  const fake = fakeCaller({ text: JSON.stringify({ answer: "In the hallway drawer.", citedFactIds: ["f-made-up"], notFound: false }) });
  const result = await runProfileQa({ question: "Where are her spare glasses?", facts }, { caller: fake.caller });
  assert.deepEqual(result, { notFound: true, answer: NOT_IN_PROFILE, citedFacts: [], createOpenQuestion: true, healthNotice: null });
});

test("A5 shows no model wording when a cited fact is a medical instruction", async () => {
  const fake = fakeCaller({ text: JSON.stringify({ answer: "Give her two pills.", citedFactIds: ["f-pain", "f-pain"], notFound: false }) });
  const result = await runProfileQa({ question: "What can she take for pain?", facts }, { caller: fake.caller });
  assert.equal(result.answer, null);
  assert.deepEqual(result.citedFacts, [facts[1]]);
  assert.equal(result.healthNotice, HEALTH_NOTICE);
  assert.equal(result.createOpenQuestion, false);
});

test("a medical question cites matching written instructions verbatim under the 811 notice, with no model wording", () => {
  const result = redirectProfileQa({ question: "Should I give her more pain medicine?", facts }, "medical");
  assert.equal(result.answer, null);
  // written instructions come first; "medicine" also matches "medication" in the breakfast fact
  assert.deepEqual(result.citedFacts, [facts[1], facts[0]]);
  assert.equal(result.healthNotice, MEDICAL_REDIRECT);
  assert.equal(result.createOpenQuestion, false);
  const none = redirectProfileQa({ question: "Is it normal that her ankle is swollen?", facts }, "medical");
  assert.deepEqual(none, { notFound: false, answer: MEDICAL_REDIRECT, citedFacts: [], createOpenQuestion: false, healthNotice: null });
});

test("an emergency gets only the 911 notice and no passport text", () => {
  const result = redirectProfileQa({ question: "She has chest pain and cannot breathe", facts }, "emergency");
  assert.deepEqual(result, { notFound: false, answer: EMERGENCY_REDIRECT, citedFacts: [], createOpenQuestion: false, healthNotice: null });
});
