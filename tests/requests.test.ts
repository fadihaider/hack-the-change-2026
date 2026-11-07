import assert from "node:assert/strict";
import test from "node:test";
import { appNow, approvalHash, recoverGroup } from "../lib/state.ts";
import { confirmResponse, hashResponseToken, requireSameOrigin, sendApprovedRequest, WorkflowError } from "../lib/requests/workflow.ts";
import type { RequestRecord, RequestTransaction, ResponseTransaction, StoredToken, Transition, WorkflowStore } from "../lib/requests/workflow.ts";

const realNow = new Date("2026-11-07T22:00:00Z");

// Test fixture only. Production must supply the transactional SQL adapter.
function fixture() {
  const request: RequestRecord = {
    id: "request-1", userId: "user-1", recipientEmail: "teammate@example.test",
    subject: "Coverage request", body: "Could you cover my volunteer shift?",
    disclosureTier: "minimal", state: "approved", healthOverride: false, respondBy: null,
  };
  const approval = { id: "approval-1", hash: approvalHash(request) };
  const events: Transition[] = [];
  const tokens: StoredToken[] = [];
  const proposals: Array<{ at: Date; note: string }> = [];
  let consumed = false;
  let queue = Promise.resolve();
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  const tx: RequestTransaction = {
    request, latestApproval: approval,
    async transition(change) {
      if (request.state !== change.from) return false;
      request.state = change.to;
      if (change.respondBy) request.respondBy ??= change.respondBy;
      events.push(change);
      return true;
    },
    async saveTokens(records) { tokens.push(...records); },
  };
  const store: WorkflowStore = {
    async withOwnedRequest(userId, requestId, work) {
      return locked(async () => {
        if (request.userId !== userId || request.id !== requestId) throw new WorkflowError("not_found");
        return work(tx);
      });
    },
    async withResponseToken(hash, now, work) {
      return locked(async () => {
        const token = tokens.find((item) => item.hash === hash && item.expiresAt > now);
        if (!token) throw new WorkflowError("not_found");
        const responseTx: ResponseTransaction = {
          ...tx, token,
          async consumeAllTokens() { consumed = true; },
          async saveProposal(proposal) { proposals.push(proposal); },
        };
        return work(responseTx);
      });
    },
  };
  const messages: Array<{ userId: string; to: string; subject: string; text: string }> = [];
  const input = {
    userId: request.userId, requestId: request.id, store,
    baseUrl: "http://127.0.0.1:3000", appTime: realNow,
    findHealthTerms: async () => [] as string[],
    send: async (message: typeof messages[number]) => { messages.push(message); return { id: "gmail-1" }; },
  };
  function rawToken(choice: "Accept" | "Decline" | "Propose another time") {
    const url = messages[0].text.split("\n").find((line) => line.startsWith(`${choice}: `))!.slice(choice.length + 2);
    return new URL(url).pathname.split("/").at(-1)!;
  }
  return { request, approval, tx, events, tokens, proposals, messages, input, rawToken, consumed: () => consumed };
}

test("successful send records Gmail evidence and stores only token hashes", async () => {
  const f = fixture();
  assert.deepEqual(await sendApprovedRequest(f.input), { state: "requested", messageId: "gmail-1" });
  assert.equal(f.messages.length, 1);
  assert.equal(f.request.respondBy?.toISOString(), "2026-11-09T22:00:00.000Z");
  assert.equal(f.events[1].evidenceKind, "gmail_message_id");
  assert.equal(f.tokens.length, 3);
  assert.equal(f.tokens[0].hash, hashResponseToken(f.rawToken("Accept")));
  assert.equal(f.tokens[0].expiresAt.toISOString(), "2026-11-16T22:00:00.000Z");
  assert.ok(!JSON.stringify(f.tokens).includes(f.rawToken("Accept")));
});

test("send preserves a user-selected deadline", async () => {
  const f = fixture();
  f.request.respondBy = new Date("2026-11-20T12:00:00Z");
  await sendApprovedRequest(f.input);
  assert.equal(f.request.respondBy.toISOString(), "2026-11-20T12:00:00.000Z");
  assert.equal(f.tokens[0].expiresAt.toISOString(), "2026-11-27T12:00:00.000Z");
});

test("an edited recipient or draft requires a fresh approval", async () => {
  for (const field of ["recipientEmail", "subject", "body", "disclosureTier"] as const) {
    const f = fixture();
    if (field === "disclosureTier") f.request[field] = "general";
    else f.request[field] += "changed";
    assert.deepEqual(await sendApprovedRequest(f.input), { state: "needs_review" });
    assert.equal(f.messages.length, 0);
    assert.equal(f.tokens.length, 0);
    assert.equal(f.events[0].evidenceRef, "approval hash mismatch");
  }
});

test("health terms block minimal/general sends unless explicitly overridden", async () => {
  const f = fixture();
  f.input.findHealthTerms = async () => ["hip", "replacement"];
  assert.deepEqual(await sendApprovedRequest(f.input), { state: "needs_review" });
  assert.equal(f.messages.length, 0);
  assert.equal(f.events[0].evidenceRef, "health term at send");
  const overridden = fixture();
  overridden.input.findHealthTerms = async () => ["surgery"];
  overridden.request.healthOverride = true;
  assert.equal((await sendApprovedRequest(overridden.input)).state, "requested");
});

test("concurrent send attempts call Gmail once", async () => {
  const f = fixture();
  const results = await Promise.allSettled([sendApprovedRequest(f.input), sendApprovedRequest(f.input)]);
  assert.equal(f.messages.length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
});

test("Gmail failures produce failed state with sanitized evidence and no retry", async () => {
  const f = fixture();
  let attempts = 0;
  f.input.send = async () => { attempts++; throw new Error("provider body includes secret"); };
  assert.deepEqual(await sendApprovedRequest(f.input), { state: "failed", errorCode: "gmail_send_failed" });
  assert.equal(attempts, 1);
  assert.equal(f.request.state, "failed");
  assert.equal(f.events.at(-1)?.evidenceRef, "gmail_send_failed");
});

test("cross-owner sends are not found", async () => {
  const f = fixture();
  await assert.rejects(sendApprovedRequest({ ...f.input, userId: "other-user" }), { code: "not_found" });
  assert.equal(f.messages.length, 0);
});

test("accept is explicit, and second responses preserve the first answer", async () => {
  const f = fixture();
  await sendApprovedRequest(f.input);
  assert.equal(f.request.state, "requested");
  const first = await confirmResponse({ token: f.rawToken("Accept"), store: f.input.store, realNow });
  assert.deepEqual(first, { state: "accepted", recorded: true });
  const second = await confirmResponse({ token: f.rawToken("Decline"), store: f.input.store, realNow });
  assert.deepEqual(second, { state: "accepted", recorded: false });
  assert.equal(f.events.filter((event) => event.evidenceKind === "link_click").length, 1);
  assert.equal(f.consumed(), true);
});

test("concurrent accept/decline produces only one recorded answer", async () => {
  const f = fixture();
  await sendApprovedRequest(f.input);
  const results = await Promise.all([
    confirmResponse({ token: f.rawToken("Accept"), store: f.input.store, realNow }),
    confirmResponse({ token: f.rawToken("Decline"), store: f.input.store, realNow }),
  ]);
  assert.equal(results.filter((result) => result.recorded).length, 1);
  assert.equal(results[0].state, results[1].state);
});

test("expired and malformed response tokens cannot change state", async () => {
  const f = fixture();
  await sendApprovedRequest(f.input);
  await assert.rejects(confirmResponse({ token: "invalid", store: f.input.store, realNow }), { code: "not_found" });
  await assert.rejects(confirmResponse({ token: f.rawToken("Accept"), store: f.input.store, realNow: f.tokens[0].expiresAt }), { code: "not_found" });
  assert.equal(f.request.state, "requested");
});

test("proposal requires an offset and a note of at most 300 characters", async () => {
  const f = fixture();
  await sendApprovedRequest(f.input);
  const input = { token: f.rawToken("Propose another time"), store: f.input.store, realNow };
  await assert.rejects(confirmResponse({ ...input, proposal: { at: "2026-11-10T12:00" } }), { code: "invalid_response" });
  await assert.rejects(confirmResponse({ ...input, proposal: { at: "2026-11-10T12:00:00Z", note: "x".repeat(301) } }), { code: "invalid_response" });
  assert.equal(f.request.state, "requested");
  assert.deepEqual(await confirmResponse({ ...input, proposal: { at: "2026-11-10T12:00:00-06:00", note: "<script>plain text</script>" } }), { state: "needs_review", recorded: true });
  assert.equal(f.proposals[0].at.toISOString(), "2026-11-10T18:00:00.000Z");
  assert.equal(f.proposals[0].note, "<script>plain text</script>");
});

test("app clock, recovery grouping, and mutation origin preserve spec boundaries", () => {
  assert.equal(appNow(realNow, 7 * 86400_000).toISOString(), "2026-11-14T22:00:00.000Z");
  assert.equal(recoverGroup("sending"), "needs_follow_up");
  assert.equal(recoverGroup("accepted"), "handled");
  assert.equal(recoverGroup("requested"), "waiting");
  assert.doesNotThrow(() => requireSameOrigin("https://app.example.test", "https://app.example.test"));
  assert.throws(() => requireSameOrigin(null, "https://app.example.test"), { code: "invalid_origin" });
  assert.throws(() => requireSameOrigin("https://other.example.test", "https://app.example.test"), { code: "invalid_origin" });
});
