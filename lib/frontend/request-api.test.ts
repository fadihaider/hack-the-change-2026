import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRequestApi,
  RequestApiError,
  requestViewSchema,
} from "./request-api.ts";
const revision = "a".repeat(64);

test("live send transmits only the request id, with session credentials", async () => {
  const api = createRequestApi(async (url, options) => {
    assert.equal(url, "/api/requests/send");
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), { requestId: "r1" });
    return Response.json({ state: "requested", messageId: "gmail-actual-id" });
  });
  assert.deepEqual(await api.send("r1"), {
    state: "requested",
    messageId: "gmail-actual-id",
  });
});
test("recorded failed send stays failed even with an HTTP 200", async () => {
  const api = createRequestApi(async () =>
    Response.json({ state: "failed", errorCode: "gmail_send_failed" }),
  );
  assert.equal((await api.send("r1")).state, "failed");
});
test("a success without Gmail evidence is rejected rather than fabricated", async () => {
  const api = createRequestApi(async () =>
    Response.json({ state: "requested" }),
  );
  await assert.rejects(
    api.send("r1"),
    (e: unknown) =>
      e instanceof RequestApiError && e.code === "invalid_response",
  );
});
test("unconfigured or unauthenticated services never fall back to fixtures", async () => {
  for (const status of [401, 503]) {
    const api = createRequestApi(async () =>
      Response.json({ error: { code: "unconfigured" } }, { status }),
    );
    await assert.rejects(
      api.list(),
      (e: unknown) => e instanceof RequestApiError && e.status === status,
    );
  }
});
test("Recover expiry refresh is a POST, not a mutating GET", async () => {
  const api = createRequestApi(async (url, options) => {
    assert.equal(url, "/api/requests/refresh");
    assert.equal(options?.method, "POST");
    assert.equal(options?.body, "{}");
    return Response.json({
      requests: [],
      appNow: "2026-11-10T14:00:00Z",
      expiredRequestIds: [],
    });
  });
  assert.equal((await api.refresh()).requests.length, 0);
});
test("approval sends no client message text or hash", async () => {
  const api = createRequestApi(async (_url, options) => {
    assert.equal(
      new Headers(options?.headers).get("If-Match"),
      `"${revision}"`,
    );
    assert.deepEqual(JSON.parse(String(options?.body)), {
      requestId: "r1",
      healthOverride: true,
    });
    return Response.json(
      { error: { code: "health_terms", terms: ["surgery"] } },
      { status: 422 },
    );
  });
  await assert.rejects(
    api.approve("r1", revision, true),
    (e: unknown) =>
      e instanceof RequestApiError &&
      e.code === "health_terms" &&
      e.terms[0] === "surgery",
  );
});

test("stale or missing approval preconditions never retry automatically", async () => {
  for (const status of [412, 428]) {
    let calls = 0;
    const api = createRequestApi(async () => {
      calls++;
      return Response.json(
        {
          error: {
            code: status === 412 ? "stale_request" : "precondition_required",
          },
        },
        { status },
      );
    });
    await assert.rejects(
      api.approve("r1", revision),
      (error: unknown) =>
        error instanceof RequestApiError && error.status === status,
    );
    assert.equal(calls, 1);
  }
});
test("malformed revisions fail before any approval request", async () => {
  let calls = 0;
  const api = createRequestApi(async () => {
    calls++;
    return Response.json({});
  });
  for (const value of [
    "",
    "*",
    `W/"${revision}"`,
    `${revision},${revision}`,
    "A".repeat(64),
    `${revision}\r\nX-Test: value`,
  ]) {
    await assert.rejects(api.approve("r1", value), RequestApiError);
  }
  assert.equal(calls, 0);
});
test("request views require the server-issued preview revision", () => {
  const record = {
    id: "r1",
    revision,
    state: "awaiting_approval",
    action: "notify",
    recipient: { contactId: "c1", name: "Demo", email: "demo@example.com" },
    subject: "Availability",
    body: "Family responsibilities",
    disclosureTier: "minimal",
    healthTermsFound: [],
    healthOverride: false,
    respondBy: null,
    proposedAt: null,
    proposedNote: null,
    approval: null,
    evidence: [],
  };
  assert.equal(requestViewSchema.safeParse(record).success, true);
  assert.equal(
    requestViewSchema.safeParse({ ...record, revision: undefined }).success,
    false,
  );
});
