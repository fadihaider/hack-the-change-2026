import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequestApi, RequestApiError } from "./request-api.ts";

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
    api.approve("r1", true),
    (e: unknown) =>
      e instanceof RequestApiError &&
      e.code === "health_terms" &&
      e.terms[0] === "surgery",
  );
});
