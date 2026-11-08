import assert from "node:assert/strict";
import { test } from "node:test";
import { isLockedWording } from "../care/lockedWording.ts";

test("medication, dose and wound wording is locked whatever the category", () => {
  assert.equal(isLockedWording("medical_instruction", "Keep the area dry."), true);
  assert.equal(isLockedWording("routine", "Breakfast at 8:30 with medication."), true);
  assert.equal(isLockedWording("routine", "Change the dressing every morning."), true);
  assert.equal(isLockedWording("routine", "Take 500 mg after lunch."), true);
  assert.equal(isLockedWording("routine", "Rosa usually has breakfast at eight."), false);
  assert.equal(isLockedWording("practical", "Her spare glasses are in the bedroom drawer."), false);
});
