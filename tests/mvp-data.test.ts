import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { p } from "../lib/db.ts";
import { findHealthTerms } from "../lib/healthTerms.ts";
import { createPgliteDatabase, translateNamedParams, type PgliteDatabase } from "../lib/mvp/database.ts";
import { createSeedCalendar } from "../lib/mvp/calendar.ts";
import { createOutboxMailer, listOutbox } from "../lib/mvp/mail.ts";
import { DEMO_EMAIL } from "../lib/mvp/seed.ts";
import { ApprovalPreconditionError } from "../lib/requests/approval-revision.ts";
import { confirmResponse, sendApprovedRequest } from "../lib/requests/workflow.ts";
import { createRequestQueue, HealthTermsError } from "../lib/store/requestQueue.ts";
import { createWorkflowStore } from "../lib/store/workflowStore.ts";

let dir: string;
let db: PgliteDatabase;
let userId: string;

async function contactId(email: string): Promise<string> {
  const rows = await db.query<{ id: string }>("SELECT id::text AS id FROM contact WHERE email = :email", [p.text("email", email)]);
  return rows[0].id;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-pglite-"));
  db = await createPgliteDatabase(dir);
  const users = await db.query<{ id: string }>("SELECT id::text AS id FROM app_user WHERE email = :email", [p.text("email", DEMO_EMAIL)]);
  userId = users[0].id;
});

after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("named params skip literals, identifiers and casts, and reuse one position per name", () => {
  const sql = `SELECT ':skip' AS "a:b", x::int, :id, CAST(:id AS uuid), :n -- :ignored`;
  const out = translateNamedParams(sql, [p.int("n", 2), p.uuid("id", "abc")]);
  assert.equal(out.text, `SELECT ':skip' AS "a:b", x::int, $1, CAST($1 AS uuid), $2 -- :ignored`);
  assert.deepEqual(out.values, ["abc", 2]);
  assert.deepEqual(out.types, [25, 20]);
});

test("seed, approve with revision, send to the outbox and accept through the real workflow over PGlite", async () => {
  const groups = await db.query<{ name: string; disclosure_tier: string }>(
    "SELECT name, disclosure_tier FROM contact_group WHERE user_id = CAST(:user_id AS uuid) ORDER BY name",
    [p.uuid("user_id", userId)],
  );
  assert.deepEqual(groups.map((g) => `${g.name}:${g.disclosure_tier}`), ["Family:detailed", "School:minimal", "Volunteer:minimal", "Work:general"]);

  const queue = createRequestQueue(db);
  const store = createWorkflowStore(db);
  const mail = createOutboxMailer(db);
  const draft = await queue.createDraft(userId, {
    commitmentId: null, contactId: await contactId("morgan.chen@example.test"), action: "coverage",
    subject: "Shift coverage this week", body: "Hi Morgan, a family matter came up. Could someone cover my shift?",
  });
  assert.equal(draft.state, "awaiting_approval");
  assert.equal(draft.disclosureTier, "general");

  // an edit that adds a health term blocks approval for the general tier, and a stale revision is refused
  const risky = await queue.edit(userId, { requestId: draft.id, body: `${draft.body} It is after her hip replacement.` });
  assert.deepEqual([...risky.healthTermsFound].sort(), ["hip", "replacement"]);
  await assert.rejects(queue.approve(userId, draft.id, `"${risky.revision}"`), HealthTermsError);
  await assert.rejects(queue.approve(userId, draft.id, `"${draft.revision}"`), ApprovalPreconditionError);
  const clean = await queue.edit(userId, { requestId: draft.id, body: draft.body });

  const approved = await queue.approve(userId, draft.id, `"${clean.revision}"`);
  assert.equal(approved.state, "approved");
  assert.ok(approved.approval);

  const sent = await sendApprovedRequest({
    userId, requestId: draft.id, store, baseUrl: "http://localhost:3000", appTime: new Date(),
    findHealthTerms: async (subject, body) => findHealthTerms(subject, body), send: (message) => mail.send(message),
  });
  assert.equal(sent.state, "requested");
  assert.equal((await queue.read(userId, draft.id)).state, "requested");

  const outbox = await listOutbox(db, userId);
  assert.equal(outbox.length, 1);
  assert.equal(sent.state === "requested" && sent.messageId, outbox[0].id);
  const token = /Accept: http:\/\/localhost:3000\/r\/([A-Za-z0-9_-]{43})/.exec(outbox[0].body)?.[1];
  assert.ok(token);

  const answer = await confirmResponse({ token, store, realNow: new Date() });
  assert.deepEqual(answer, { state: "accepted", recorded: true });
  const final = await queue.read(userId, draft.id);
  assert.equal(final.state, "accepted");
  assert.deepEqual(final.evidence.map((e) => e.toState).slice(0, 4), ["accepted", "requested", "sending", "approved"]);
});

test("the seed calendar has 6 events from tomorrow on, and the mom appointment is in the window", async () => {
  const now = new Date("2026-11-07T18:00:00Z");
  const events = await createSeedCalendar(() => now).listEvents(userId, now, new Date(now.getTime() + 8 * 86_400_000));
  assert.equal(events.length, 6);
  assert.ok(events.every((e) => (e.start?.dateTime ?? "") > "2026-11-08"));
  assert.ok(events.some((e) => e.summary?.includes("Mom") && e.location?.includes("Foothills")));
});

test("the seed calendar follows a care week that starts after today, so the demo sentence still has clashes", async () => {
  // Sunday 2026-11-08: "hip surgery on Sunday ... until Saturday" resolves to Sunday 2026-11-15 to Saturday 2026-11-21
  const now = new Date("2026-11-08T18:00:00Z");
  const startsAt = new Date("2026-11-15T06:00:00Z");
  const endsAt = new Date("2026-11-22T06:00:00Z");
  const events = await createSeedCalendar(() => now).listEvents(userId, startsAt, endsAt);
  assert.equal(events.length, 6);
  assert.ok(events.every((e) => (e.start?.dateTime ?? "") > "2026-11-16" && (e.start?.dateTime ?? "") < "2026-11-22"));
});
