import assert from "node:assert/strict";
import test from "node:test";
import { approvalHash } from "../lib/state.ts";
import { approvalRevision, requireApprovalRevision, withCurrentApproval } from "../lib/requests/approval-revision.ts";
import { WorkflowError } from "../lib/requests/workflow.ts";
import type { RequestRecord, Transition, WorkflowStore } from "../lib/requests/workflow.ts";

// Serializing fixture only. This does not verify a durable database lock.
function fixture() {
  const request: RequestRecord = {
    id: "request-1", userId: "owner-1", recipientEmail: "teammate@example.test",
    subject: "Coverage request", body: "Could you cover my volunteer shift?",
    disclosureTier: "minimal", state: "awaiting_approval", healthOverride: false,
    respondBy: new Date("2026-11-10T18:00:00Z"),
  };
  const events: Transition[] = [];
  let queue = Promise.resolve();
  const store: WorkflowStore = {
    async withOwnedRequest(userId, requestId, work) {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (userId !== request.userId || requestId !== request.id) throw new WorkflowError("not_found");
        return await work({
          request, latestApproval: null,
          async transition(change) {
            if (request.state !== change.from) return false;
            request.state = change.to;
            events.push(change);
            return true;
          },
          async saveTokens() { throw new Error("approval must not create response tokens"); },
        });
      } finally { release(); }
    },
    async withResponseToken() { throw new Error("approval must not use response tokens"); },
  };
  const input: { userId: string; requestId: string; store: WorkflowStore; ifMatch: string | null } = {
    userId: request.userId, requestId: request.id, store, ifMatch: `"${approvalRevision(request)}"`,
  };
  const approve = () => withCurrentApproval(input, async (tx) => {
    const hash = approvalHash(tx.request);
    assert.equal(await tx.transition({ from: "awaiting_approval", to: "approved", evidenceKind: "approval", evidenceRef: hash, actor: "user" }), true);
    return hash;
  });
  return { request, events, input, approve };
}

test("the rendered revision approves exact server content using the existing evidence hash", async () => {
  const f = fixture();
  const expected = approvalHash(f.request);
  assert.equal(await f.approve(), expected);
  assert.equal(f.request.state, "approved");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].evidenceRef, expected);
});

test("missing, weak, wildcard and multi-value preconditions cannot write approval", async () => {
  for (const header of [null, "", "  ", "*", 'W/"revision"', '"one", "two"', "unquoted"]) {
    const f = fixture();
    f.input.ifMatch = header;
    await assert.rejects(f.approve(), { code: header === null || !header.trim() ? "precondition_required" : "stale_request", status: header === null || !header.trim() ? 428 : 412 });
    assert.equal(f.request.state, "awaiting_approval");
    assert.equal(f.events.length, 0);
  }
});

test("changed recipient, subject, body, tier, deadline or override requires re-review", async () => {
  const edits: Array<(request: RequestRecord) => void> = [
    (r) => { r.recipientEmail = "other@example.test"; },
    (r) => { r.subject += " changed"; },
    (r) => { r.body += " changed"; },
    (r) => { r.disclosureTier = "detailed"; },
    (r) => { r.respondBy = null; },
    (r) => { r.healthOverride = true; },
  ];
  for (const edit of edits) {
    const f = fixture();
    edit(f.request);
    await assert.rejects(f.approve(), { code: "stale_request", status: 412 });
    assert.equal(f.events.length, 0);
  }
});

test("an edit queued between read and approve wins the lock and prevents unseen approval", async () => {
  const f = fixture();
  const edit = f.input.store.withOwnedRequest(f.input.userId, f.input.requestId, async (tx) => {
    await Promise.resolve();
    tx.request.body = "A changed message the user has not reviewed";
  });
  const approve = f.approve();
  await edit;
  await assert.rejects(approve, { code: "stale_request" });
  assert.equal(f.events.length, 0);
  f.input.ifMatch = `"${approvalRevision(f.request)}"`;
  await f.approve();
  assert.equal(f.events.length, 1);
});

test("competing approvals record one event and the old revision is no longer usable", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.approve(), f.approve()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.events.length, 1);
  f.input.ifMatch = `"${approvalRevision(f.request)}"`;
  await assert.rejects(f.approve(), { code: "state_conflict" });
  assert.equal(f.events.length, 1);
});

test("owner checks run before preconditions and never invoke the approval callback", async () => {
  const f = fixture();
  await assert.rejects(withCurrentApproval({ ...f.input, userId: "other-owner", ifMatch: null }, async () => assert.fail("unauthorized callback")), { code: "not_found" });
  assert.equal(f.events.length, 0);
  // Defense in depth if a defective adapter returns another owner's request.
  const wrongStore: WorkflowStore = {
    ...f.input.store,
    withOwnedRequest: (_user, _id, work) => f.input.store.withOwnedRequest(f.request.userId, f.request.id, work),
  };
  await assert.rejects(withCurrentApproval({ ...f.input, userId: "other-owner", store: wrongStore }, async () => assert.fail("unauthorized callback")), { code: "not_found" });
});

test("field boundaries and request identity cannot reuse a different preview revision", () => {
  const f = fixture();
  const original = { ...f.request, subject: "One\nTwo", body: "Three" };
  const shifted = { ...original, subject: "One", body: "Two\nThree" };
  assert.notEqual(approvalRevision(original), approvalRevision(shifted));
  assert.throws(() => requireApprovalRevision({ ...f.request, id: "request-2" }, f.input.ifMatch), { code: "stale_request" });
  assert.doesNotThrow(() => requireApprovalRevision(f.request, ` ${f.input.ifMatch} `));
});
