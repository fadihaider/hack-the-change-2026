import assert from "node:assert/strict";
import test from "node:test";
import { findHealthTerms } from "../lib/healthTerms.ts";

test("flags the demo's diagnosis edit and its variants", () => {
  assert.deepEqual(findHealthTerms("Work shift", "I can't come in after her hip replacement."), ["replacement", "hip"]);
  assert.ok(findHealthTerms("", "She is POST OP and on Insulin").includes("post-op"));
  assert.ok(findHealthTerms("", "two surgeries this year").includes("surgery"));
  assert.ok(findHealthTerms("", "post op check").includes("post-op"));
  assert.ok(findHealthTerms("", "Alzheimer’s care").includes("alzheimer's"));
  assert.ok(findHealthTerms("ICU update", "").includes("icu"));
});

test("leaves the tier-approved general wording and everyday words alone", () => {
  assert.deepEqual(findHealthTerms("Availability", "I'm handling a family caregiving situation from Nov 10 to Nov 16."), []);
  assert.deepEqual(findHealthTerms("", "My mother is recovering from a medical procedure. I'll get back to you."), []);
  assert.deepEqual(findHealthTerms("", "The shipment arrives at the hippodrome near the kidneybean stand"), []);
});

test("adds per-recipient terms and returns each term once", () => {
  assert.deepEqual(findHealthTerms("", "Rosa's knee and knee brace", ["brace", "ab"]), ["knee", "brace"]);
});
