import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveFact,
  approveRequest,
  BASE_TIME,
  commitments,
  contacts,
  createDrafts,
  editRequest,
  expireRequests,
  initialFacts,
  reviewGroup,
  simulateSend,
} from "./workflow.ts";

const draft = () => createDrafts({}, contacts, BASE_TIME)[0];
test("simulated delivery requires exact-item approval and edits revoke it", () => {
  assert.equal(simulateSend(draft()).state, "awaiting_approval");
  const approved = approveRequest(draft());
  assert.equal(simulateSend(approved).state, "requested");
  assert.equal(
    editRequest(approved, { body: "Changed" }).state,
    "awaiting_approval",
  );
  assert.equal(
    simulateSend({ ...approved, email: "different@example.com" }).state,
    "needs_review",
  );
});
test("health terms block minimal approval and are rechecked at simulated send", () => {
  const r = editRequest(draft(), { subject: "Mom’s surgery" });
  assert.equal(approveRequest(r).state, "awaiting_approval");
  assert.equal(approveRequest({ ...r, override: true }).state, "approved");
  assert.equal(approveRequest({ ...r, tier: "detailed" }).state, "approved");
});
test("expiry affects only waiting requests at their deadline", () => {
  const sent = simulateSend(approveRequest(draft()));
  assert.equal(
    expireRequests([sent], BASE_TIME + 48 * 3600000 - 1)[0].state,
    "requested",
  );
  assert.equal(
    expireRequests([sent], BASE_TIME + 48 * 3600000)[0].state,
    "expired",
  );
  assert.equal(
    expireRequests(
      [{ ...sent, state: "accepted" }],
      BASE_TIME + 7 * 86400000,
    )[0].state,
    "accepted",
  );
});
test("Recover never presents pending or unknown sends as handled", () => {
  assert.equal(reviewGroup("sending"), "Needs follow-up");
  assert.equal(reviewGroup("approved"), "Not sent");
  assert.equal(reviewGroup("requested"), "Waiting");
  assert.equal(reviewGroup("accepted"), "Handled");
});
test("conflict resolution admits only the chosen exact fact", () => {
  const facts = approveFact(initialFacts, "f2");
  assert.equal(facts.find((f) => f.id === "f1")?.status, "superseded");
  assert.equal(facts.find((f) => f.id === "f2")?.status, "approved");
});
test("keep and defer create no email requests", () => {
  const actions = Object.fromEntries(commitments.map((k) => [k.id, "keep"]));
  assert.equal(createDrafts(actions, contacts, BASE_TIME).length, 0);
});
test("scan limits drafts to the confirmed window and chosen contact", () => {
  const drafts = createDrafts({}, contacts, BASE_TIME, {
    start: "2026-11-11",
    end: "2026-11-11",
    recipientIds: { k2: "c3" },
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].email, "sara@example.com");
  assert.equal(drafts[0].commitment, "Research paper deadline");
});
test("empty or invalid recipient content cannot be approved", () => {
  assert.equal(
    approveRequest({ ...draft(), email: "invalid" }).state,
    "awaiting_approval",
  );
  assert.equal(
    approveRequest({ ...draft(), body: "" }).state,
    "awaiting_approval",
  );
});
