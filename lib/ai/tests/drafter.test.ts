import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDrafterGuards, runDrafter, type DrafterInput } from "../drafter.ts";
import { fakeCaller } from "./fakeCaller.ts";

const base: DrafterInput = {
  recipientFirstName: "Sam",
  recipientEmail: "sam@example.test",
  relationship: "my mother",
  commitmentTitle: "Work shift",
  commitmentStart: "2026-11-12T15:00:00.000Z",
  action: "coverage",
  episodeStart: "2026-11-10",
  episodeEnd: "2026-11-16",
  tier: "minimal",
  reasonText: "hip replacement",
  extraHealthTerms: ["replacement"],
};

test("A3 sends no relationship or reason at the minimal tier and blocks a draft with a health term", async () => {
  const fake = fakeCaller({
    text: JSON.stringify({
      subject: "Coverage request\r\nBcc: someone@example.test",
      body: "Hi Sam,\n\nAfter her hip replacement I need cover for my shift. See https://example.com or email other@example.test.\n\nThanks",
    }),
  });
  const result = await runDrafter(base, { caller: fake.caller });

  const prompt = JSON.stringify(fake.requests[0].messages);
  assert.ok(!prompt.includes("hip replacement"));
  assert.ok(!prompt.includes("my mother"));
  assert.ok(!prompt.includes("sam@example.test"));
  assert.equal(fake.requests[0].output_config?.effort, "medium");

  assert.ok(!/[\r\n]/.test(result.subject));
  assert.ok(result.subject.length <= 120);
  assert.deepEqual(result.healthTermsFound.sort(), ["hip", "replacement"]);
  assert.equal(result.approvalBlocked, true);
  assert.deepEqual(result.editFlags, ["other_email", "url"]);
});

test("A3 sends the reason only at the detailed tier, where a health term is a warning only", async () => {
  const fake = fakeCaller({
    text: JSON.stringify({ subject: "Coverage request", body: "Hi Sam,\n\nMy mother has a hip replacement. Could you cover my shift?\n\nThank you." }),
  });
  const result = await runDrafter({ ...base, tier: "detailed" }, { caller: fake.caller });
  assert.ok(JSON.stringify(fake.requests[0].messages).includes("hip replacement"));
  assert.equal(result.approvalBlocked, false);
  assert.ok(result.healthTermsFound.includes("hip"));
  assert.deepEqual(applyDrafterGuards({ subject: "Hi", body: "Write to sam@example.test" }, base).editFlags, []);
});
