import assert from "node:assert/strict";
import test from "node:test";
import { createRequestHttpHandlers } from "../lib/requests/http.ts";
import { approvalHash } from "../lib/state.ts";
import { WorkflowError } from "../lib/requests/workflow.ts";
import type {
  RequestRecord, RequestTransaction, ResponseTransaction, StoredToken, Transition, WorkflowStore,
} from "../lib/requests/workflow.ts";

const baseUrl = "https://app.example.test";
const now = new Date("2026-11-07T23:00:00Z");

// Fictional in-memory HTTP fixture, never a production/live-send adapter.
function fixture() {
  const record: RequestRecord = {
    id: "request-1", userId: "owner-1", recipientEmail: "recipient@example.test",
    subject: "Coverage", body: "Could you cover my shift?", disclosureTier: "minimal",
    state: "approved", healthOverride: false, respondBy: null,
  };
  const events: Transition[] = [];
  const tokens: StoredToken[] = [];
  const proposals: Array<{ at: Date; note: string }> = [];
  const messages: Array<{ userId: string; to: string; subject: string; text: string }> = [];
  const controls = {
    identity: { userId: record.userId } as { userId: string } | null,
    hits: [] as string[], sendFails: false, finishFails: false, consumed: false,
    ownedReads: 0, tokenReads: 0, appClockOwners: [] as string[],
  };
  let queue = Promise.resolve();
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const before = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await before;
    try { return await work(); } finally { release(); }
  }
  const tx: RequestTransaction = {
    request: record, latestApproval: { id: "approval-1", hash: approvalHash(record) },
    async transition(change) {
      if (controls.finishFails && change.to === "requested") throw new Error("private-storage-diagnostic");
      if (record.state !== change.from) return false;
      record.state = change.to;
      if (change.respondBy) record.respondBy ??= change.respondBy;
      events.push(change);
      return true;
    },
    async saveTokens(value) { tokens.push(...value); },
  };
  const store: WorkflowStore = {
    async withOwnedRequest(userId, requestId, work) {
      controls.ownedReads++;
      return locked(async () => {
        if (record.userId !== userId || record.id !== requestId) throw new WorkflowError("not_found");
        return work(tx);
      });
    },
    async withResponseToken(hash, realNow, work) {
      controls.tokenReads++;
      return locked(async () => {
        const token = tokens.find((value) => value.hash === hash && value.expiresAt > realNow);
        if (!token) throw new WorkflowError("not_found");
        const responseTx: ResponseTransaction = {
          ...tx, token,
          async consumeAllTokens() { controls.consumed = true; },
          async saveProposal(value) { proposals.push(value); },
        };
        return work(responseTx);
      });
    },
  };
  const deps = {
    baseUrl, store,
    authenticate: async () => controls.identity,
    appNow: async (userId: string) => { controls.appClockOwners.push(userId); return now; },
    realNow: () => now,
    findHealthTerms: async () => controls.hits,
    send: async (message: typeof messages[number]) => {
      messages.push(message);
      if (controls.sendFails) throw new Error("private-provider-diagnostic");
      return { id: "gmail-fixture-id" };
    },
  };
  const handlers = createRequestHttpHandlers(deps);
  function token(choice: "Accept" | "Decline" | "Propose another time" = "Accept") {
    const line = messages[0].text.split("\n").find((value) => value.startsWith(`${choice}: `))!;
    return new URL(line.slice(choice.length + 2)).pathname.split("/").at(-1)!;
  }
  return { record, events, tokens, proposals, messages, controls, deps, handlers, token };
}

function post(body: unknown = { requestId: "request-1" }, headers?: Record<string, string>): Request {
  return new Request(`${baseUrl}/api/requests/send`, {
    method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function error(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: { code } });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
}

test("HTTP send uses only the authenticated owner and saved approved content", async () => {
  const f = fixture();
  const response = await f.handlers.send(post());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "requested", messageId: "gmail-fixture-id" });
  assert.deepEqual(f.controls.appClockOwners, ["owner-1"]);
  assert.equal(f.messages[0].userId, "owner-1");
  assert.equal(f.messages[0].to, f.record.recipientEmail);
  assert.equal(f.messages[0].subject, f.record.subject);
  assert.equal(f.events.at(-1)?.evidenceKind, "gmail_message_id");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("missing identity and cross-owner access cannot send", async () => {
  const unauthenticated = fixture();
  unauthenticated.controls.identity = null;
  await error(await unauthenticated.handlers.send(post()), 401, "unauthenticated");
  assert.equal(unauthenticated.controls.ownedReads, 0);
  assert.equal(unauthenticated.messages.length, 0);
  const other = fixture();
  other.controls.identity = { userId: "other-owner" };
  await error(await other.handlers.send(post()), 404, "not_found");
  assert.equal(other.messages.length, 0);
});

test("send rejects absent, null, cross-site and mismatched-port Origins before storage", async () => {
  for (const origin of [undefined, "null", "https://evil.example.test", `${baseUrl}:444`, `${baseUrl}/path`]) {
    const f = fixture();
    const request = post();
    if (origin === undefined) request.headers.delete("Origin");
    else request.headers.set("Origin", origin);
    await error(await f.handlers.send(request), 403, "invalid_origin");
    assert.equal(f.controls.ownedReads, 0);
    assert.equal(f.messages.length, 0);
  }
});

test("send rejects client content, owner, approval, recipient and invalid identifiers", async () => {
  for (const body of [
    { requestId: "request-1", userId: "other-owner" },
    { requestId: "request-1", subject: "Unseen edit" },
    { requestId: "request-1", recipientEmail: "other@example.test" },
    { requestId: "request-1", approvalHash: "client-hash" },
    { requestId: "" }, { requestId: "x".repeat(129) }, { requestId: "request-1\n" },
    {}, null, [], 1,
  ]) {
    const f = fixture();
    await error(await f.handlers.send(post(body)), 400, "invalid_input");
    assert.equal(f.controls.ownedReads, 0);
    assert.equal(f.messages.length, 0);
  }
});

test("wrong HTTP methods never send or confirm a response", async () => {
  const f = fixture();
  for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
    const request = new Request(baseUrl, { method });
    const sent = await f.handlers.send(request);
    assert.equal(sent.headers.get("Allow"), "POST");
    await error(sent, 405, "method_not_allowed");
    await error(await f.handlers.confirm(request, "invalid"), 405, "method_not_allowed");
  }
  assert.equal(f.messages.length, 0);
  assert.equal(f.controls.tokenReads, 0);
});

test("HTTP JSON parsing rejects unsupported, broken, empty and invalid UTF-8 bodies", async () => {
  const f = fixture();
  await error(await f.handlers.send(post({}, { "Content-Type": "text/plain" })), 415, "unsupported_media_type");
  for (const body of ["{broken", "", new Uint8Array([0xff])]) {
    await error(await f.handlers.send(new Request(baseUrl, {
      method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body,
    })), 400, "invalid_input");
  }
  assert.equal(f.messages.length, 0);
});

test("HTTP JSON size limit counts actual streamed bytes despite a small Content-Length", async () => {
  const f = fixture();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(4096)));
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() { cancelled = true; },
  });
  const request = new Request(baseUrl, {
    method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json", "Content-Length": "1" },
    body, duplex: "half",
  } as RequestInit);
  await error(await f.handlers.send(request), 413, "payload_too_large");
  assert.equal(cancelled, true);
  await error(await f.handlers.send(post({}, { "Content-Length": "999999999999" })), 413, "payload_too_large");
  await error(await f.handlers.send(post({}, { "Content-Length": "-1" })), 400, "invalid_input");
  assert.equal(f.messages.length, 0);
});

test("recorded health-review and Gmail-failure results remain normal explicit JSON outcomes", async () => {
  const health = fixture();
  health.controls.hits = ["surgery"];
  const needsReview = await health.handlers.send(post());
  assert.equal(needsReview.status, 200);
  assert.deepEqual(await needsReview.json(), { state: "needs_review" });
  assert.equal(health.messages.length, 0);
  const failed = fixture();
  failed.controls.sendFails = true;
  const response = await failed.handlers.send(post());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "failed", errorCode: "gmail_send_failed" });
  assert.equal(failed.record.state, "failed");
  assert.equal(failed.messages.length, 1);
  assert.equal(failed.events.at(-1)?.evidenceRef, "gmail_send_failed");
});

test("post-Gmail storage failure stays sending and cannot automatically send twice", async () => {
  const f = fixture();
  f.controls.finishFails = true;
  await error(await f.handlers.send(post()), 503, "temporarily_unavailable");
  assert.equal(f.record.state, "sending");
  await error(await f.handlers.send(post()), 409, "state_conflict");
  assert.equal(f.messages.length, 1);
});

test("concurrent HTTP send requests call the fixture Gmail transport once", async () => {
  const f = fixture();
  const results = await Promise.all([f.handlers.send(post()), f.handlers.send(post())]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  assert.equal(f.messages.length, 1);
});

test("GET preview is read-only, returns minimal plain-text fields and protects the bearer link", async () => {
  const f = fixture();
  await f.handlers.send(post());
  const before = JSON.stringify({ record: f.record, events: f.events, tokens: f.tokens });
  for (let i = 0; i < 2; i++) {
    const response = await f.handlers.preview(new Request(baseUrl), f.token());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { request: {
      subject: "Coverage", body: "Could you cover my shift?", state: "requested", choice: "accept",
      respondBy: "2026-11-09T23:00:00.000Z",
    } });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  }
  assert.equal(JSON.stringify({ record: f.record, events: f.events, tokens: f.tokens }), before);
  assert.equal(f.controls.consumed, false);
  await error(await f.handlers.preview(post({}), f.token()), 405, "method_not_allowed");
});

test("recipient confirmation needs no owner login; repeats preserve the first answer", async () => {
  const f = fixture();
  await f.handlers.send(post());
  f.controls.identity = null;
  const accepted = await f.handlers.confirm(post({}), f.token());
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { state: "accepted", recorded: true });
  const repeated = await f.handlers.confirm(post({}), f.token("Decline"));
  assert.deepEqual(await repeated.json(), { state: "accepted", recorded: false });
  assert.equal(f.events.filter((event) => event.evidenceKind === "link_click").length, 1);
  assert.equal(f.controls.consumed, true);
});

test("response choice cannot be supplied or changed by the recipient payload", async () => {
  const f = fixture();
  await f.handlers.send(post());
  for (const payload of [
    { choice: "decline" }, { requestId: "other-request" },
    { proposal: { at: "2026-11-10T12:00:00Z" } },
  ]) {
    const response = await f.handlers.confirm(post(payload), f.token());
    await error(response, 400, "choice" in payload || "requestId" in payload ? "invalid_input" : "invalid_response");
  }
  assert.equal(f.record.state, "requested");
  assert.equal(f.controls.consumed, false);
});

test("confirmation requires same Origin before reading a token", async () => {
  const f = fixture();
  await f.handlers.send(post());
  for (const origin of ["null", "https://evil.example.test", ""]) {
    await error(await f.handlers.confirm(post({}, { Origin: origin }), f.token()), 403, "invalid_origin");
  }
  assert.equal(f.controls.tokenReads, 0);
  assert.equal(f.record.state, "requested");
});

test("malformed, unknown and real-time-expired tokens are 404 without mutation", async () => {
  const f = fixture();
  await f.handlers.send(post());
  for (const token of ["invalid", "a".repeat(43)]) {
    await error(await f.handlers.preview(new Request(baseUrl), token), 404, "not_found");
    await error(await f.handlers.confirm(post({}), token), 404, "not_found");
  }
  const future = createRequestHttpHandlers({ ...f.deps, realNow: () => f.tokens[0].expiresAt });
  await error(await future.preview(new Request(baseUrl), f.token()), 404, "not_found");
  await error(await future.confirm(post({}), f.token()), 404, "not_found");
  assert.equal(f.record.state, "requested");
  assert.equal(f.controls.consumed, false);
});

test("proposal rejects impossible/offset-free dates and extra or oversized note fields", async () => {
  const f = fixture();
  await f.handlers.send(post());
  await error(await f.handlers.confirm(post({}), f.token("Propose another time")), 400, "invalid_response");
  for (const proposal of [
    { at: "2026-11-10T12:00" }, { at: "2026-02-30T12:00:00Z" },
    { at: "2026-11-10T12:00:00Z", note: "x".repeat(301) },
    { at: "2026-11-10T12:00:00Z", note: {} },
    { at: "2026-11-10T12:00:00Z", choice: "accept" },
  ]) {
    await error(await f.handlers.confirm(post({ proposal }), f.token("Propose another time")), 400, "invalid_input");
  }
  assert.equal(f.proposals.length, 0);
  assert.equal(f.record.state, "requested");
});

test("proposal stores offset time and literal note; 300 Unicode characters are accepted", async () => {
  const f = fixture();
  await f.handlers.send(post());
  const note = "<script>literal</script>";
  const response = await f.handlers.confirm(post({ proposal: { at: "2026-11-10T12:00:00-06:00", note } }), f.token("Propose another time"));
  assert.deepEqual(await response.json(), { state: "needs_review", recorded: true });
  assert.deepEqual(f.proposals, [{ at: new Date("2026-11-10T18:00:00Z"), note }]);
  const unicode = fixture();
  await unicode.handlers.send(post());
  const result = await unicode.handlers.confirm(post({ proposal: { at: "2026-11-10T12:00:00Z", note: "🙂".repeat(300) } }), unicode.token("Propose another time"));
  assert.equal(result.status, 200);
  assert.equal([...unicode.proposals[0].note].length, 300);
});

test("session and storage exceptions return fixed codes without private diagnostics", async () => {
  const f = fixture();
  const handlers = createRequestHttpHandlers({
    ...f.deps, authenticate: async () => { throw new Error("private-auth-token"); },
  });
  await error(await handlers.send(post()), 503, "temporarily_unavailable");
  const unavailable = createRequestHttpHandlers({
    ...f.deps, store: { ...f.deps.store, withResponseToken: async () => { throw new Error("private-db-query"); } },
  });
  await error(await unavailable.preview(new Request(baseUrl), "a".repeat(43)), 503, "temporarily_unavailable");
});
