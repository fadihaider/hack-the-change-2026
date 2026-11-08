import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLiveApi,
  liveErrorMessage,
  modeLabels,
  rruleLabel,
  safeHref,
} from "./live-api.ts";

test("session check parses the adapter modes and labels the local outbox honestly", async () => {
  const api = createLiveApi(async (url, options) => {
    assert.equal(url, "/api/session");
    assert.equal(options?.method, "GET");
    return Response.json({
      user: { id: "u1", email: "alex@example.test" },
      mode: { db: "pglite", ai: "demo", mail: "outbox", calendar: "seed", auth: "demo" },
      admin: true,
      appNow: "2026-11-07T18:00:00.000Z",
      today: "2026-11-07",
      careRecipient: null,
      episode: null,
    });
  });
  const session = await api.session();
  const labels = modeLabels(session.mode);
  assert.ok(labels.includes("Local outbox, no real email"));
  assert.ok(labels.some((label) => label.startsWith("Demo AI provider")));
});

test("a pdf goes up as multipart without a json content type, and guide hints come back as plain text", async () => {
  const api = createLiveApi(async (url, options) => {
    if (url === "/api/care/sources") {
      assert.ok(options?.body instanceof FormData);
      assert.equal(new Headers(options?.headers).get("Content-Type"), null);
      return Response.json({ error: { code: "no_text_layer" } }, { status: 422 });
    }
    return Response.json(
      { error: { code: "needs_quadrant", message: "Add the quadrant (NE, NW, SE or SW) to the address." } },
      { status: 422 },
    );
  });
  await assert.rejects(api.uploadCarePdf(new Blob(["%PDF-1.4"], { type: "application/pdf" })), (e) =>
    liveErrorMessage(e).includes("no text layer"),
  );
  await assert.rejects(api.guide("800 3 St, Calgary", "yes"), (e) =>
    liveErrorMessage(e).startsWith("Add the quadrant"),
  );
});

test("only http and https links are clickable, and rrules read in plain words", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,hi"), null);
  assert.equal(safeHref("https://www.alberta.ca/x"), "https://www.alberta.ca/x");
  assert.equal(rruleLabel("FREQ=DAILY"), "Every day");
  assert.equal(rruleLabel("FREQ=WEEKLY;BYDAY=MO,TH"), "Every week on Monday and Thursday");
});
