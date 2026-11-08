// trusted contacts and user-recorded timeline completions over the real runtime: PGlite in a temp dir, demo AI
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { Runtime } from "../lib/mvp/runtime.ts";
import type { AuthAdapter, SessionUser } from "../lib/mvp/auth.ts";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-care-contacts-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};
let rt: Runtime;
let demoAuth: AuthAdapter;
let other: SessionUser;

before(async () => {
  for (const name of [
    "session", "intake", "impact", "commitments/timeline", "care/sources", "care/facts/[id]/approve", "care/timeline",
    "care/contacts", "care/contacts/[id]/remove", "care/events/[id]/complete",
  ]) {
    routes[name] = (await import(`../app/api/${name}/route.ts`)) as { GET?: Handler; POST?: Handler };
  }
  const { getRuntime } = await import("../lib/mvp/runtime.ts");
  rt = await getRuntime();
  demoAuth = rt.auth;
  // a second owner with their own care recipient, for isolation checks
  const users = await rt.stores.database.query<{ id: string }>(
    "INSERT INTO app_user (email) VALUES ('other@example.test') RETURNING id::text AS id",
  );
  other = { id: users[0].id, email: "other@example.test" };
  await rt.stores.database.execute(
    "INSERT INTO care_recipient (owner_id, alias, display_name) VALUES (CAST(:id AS uuid), 'Dad', 'Ray')",
    [{ name: "id", value: { stringValue: other.id } }],
  );
});

after(async () => {
  rt.auth = demoAuth;
  const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
  await (await holder.__reliefReadyPglite)?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** runs work signed in as the second owner, then signs the demo user back in */
async function asOther<T>(work: () => Promise<T>): Promise<T> {
  rt.auth = {
    mode: "demo",
    currentUser: async () => other,
    currentUserId: async () => other.id,
  };
  try {
    return await work();
  } finally {
    rt.auth = demoAuth;
  }
}

async function call(
  method: "GET" | "POST",
  route: string,
  options: { body?: unknown; query?: string; params?: Record<string, string>; origin?: string } = {},
): Promise<{ status: number; data: any }> {
  const handler = routes[route]?.[method];
  assert.ok(handler, `${method} ${route} is exported`);
  const headers: Record<string, string> = { Origin: options.origin ?? BASE };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`${BASE}/api/${route}${options.query ?? ""}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, data: await response.json() };
}

function nextDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

test("contacts: nothing seeded, validated input, emergency first, audited without the phone number", async () => {
  const empty = await call("GET", "care/contacts");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, { contacts: [] });

  const invalid: unknown[] = [
    { name: "", phone: "403-555-0142", kind: "trusted" },
    { name: "   ", phone: "403-555-0142", kind: "trusted" },
    { name: "x".repeat(81), phone: "403-555-0142", kind: "trusted" },
    { name: "Lucia", relationship: "y".repeat(61), phone: "403-555-0142", kind: "trusted" },
    { name: "Lucia", phone: "call me", kind: "trusted" },
    { name: "Lucia", phone: "12", kind: "trusted" },
    { name: "Lucia", phone: "1".repeat(21), kind: "trusted" },
    { name: "Lucia", phone: "403\n555", kind: "trusted" },
    { name: "Lu\u0000cia", phone: "403-555-0142", kind: "trusted" },
    { name: "Lucia", phone: "403-555-0142", kind: "family" },
    { name: "Lucia", phone: "403-555-0142" },
    { name: "Lucia", phone: "403-555-0142", kind: "trusted", note: "extra" },
  ];
  for (const body of invalid) {
    const response = await call("POST", "care/contacts", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(response.data, { error: { code: "invalid_input" } });
  }

  const foreign = await call("POST", "care/contacts", {
    body: { name: "Lucia", phone: "403-555-0142", kind: "trusted" }, origin: "https://evil.example",
  });
  assert.equal(foreign.status, 403);

  const lucia = await call("POST", "care/contacts", {
    body: { name: "  Aunt  Lucia ", relationship: "Sister", phone: " +1 (403) 555-0142 ", kind: "trusted" },
  });
  assert.equal(lucia.status, 200);
  assert.equal(lucia.data.contact.name, "Aunt Lucia");
  assert.equal(lucia.data.contact.relationship, "Sister");
  assert.equal(lucia.data.contact.phone, "+1 (403) 555-0142");
  assert.equal(lucia.data.contact.kind, "trusted");
  assert.ok(!Number.isNaN(Date.parse(lucia.data.contact.createdAt)));

  const sam = await call("POST", "care/contacts", { body: { name: "Sam", relationship: "", phone: "403.555.0199", kind: "emergency" } });
  assert.equal(sam.status, 200);
  assert.equal(sam.data.contact.relationship, null);
  const nullRelationship = await call("POST", "care/contacts", {
    body: { name: "Priya", relationship: null, phone: "555-0100", kind: "trusted" },
  });
  assert.equal(nullRelationship.data.contact.relationship, null);

  const listed = await call("GET", "care/contacts");
  assert.deepEqual(listed.data.contacts.map((c: any) => c.name), ["Sam", "Aunt Lucia", "Priya"]);
  assert.deepEqual(Object.keys(listed.data.contacts[0]).sort(), ["createdAt", "id", "kind", "name", "phone", "relationship"]);

  // second owner sees none of these and cannot remove them
  await asOther(async () => {
    const theirs = await call("GET", "care/contacts");
    assert.deepEqual(theirs.data, { contacts: [] });
    const steal = await call("POST", "care/contacts/[id]/remove", { body: {}, params: { id: lucia.data.contact.id } });
    assert.equal(steal.status, 404);
    const own = await call("POST", "care/contacts", { body: { name: "Neighbour", phone: "403-555-0111", kind: "trusted" } });
    assert.equal(own.status, 200);
  });
  const stillThere = await call("GET", "care/contacts");
  assert.equal(stillThere.data.contacts.length, 3);
  assert.ok(!stillThere.data.contacts.some((c: any) => c.name === "Neighbour"));

  const removed = await call("POST", "care/contacts/[id]/remove", { body: {}, params: { id: lucia.data.contact.id } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { removed: true });
  const again = await call("POST", "care/contacts/[id]/remove", { body: {}, params: { id: lucia.data.contact.id } });
  assert.equal(again.status, 404);
  const bogus = await call("POST", "care/contacts/[id]/remove", { body: {}, params: { id: "not-a-uuid" } });
  assert.equal(bogus.status, 404);
  const foreignRemove = await call("POST", "care/contacts/[id]/remove", {
    body: {}, params: { id: sam.data.contact.id }, origin: "https://evil.example",
  });
  assert.equal(foreignRemove.status, 403);
  const remaining = await call("GET", "care/contacts");
  assert.deepEqual(remaining.data.contacts.map((c: any) => c.name), ["Sam", "Priya"]);

  // soft delete keeps the row; the audit trail names the action and kind but never the phone number or name
  const kept = await rt.stores.database.query<{ removed: boolean }>(
    "SELECT removed_at IS NOT NULL AS removed FROM care_contact WHERE id = CAST(:id AS uuid)",
    [{ name: "id", value: { stringValue: lucia.data.contact.id } }],
  );
  assert.deepEqual(kept, [{ removed: true }]);
  const audit = await rt.stores.database.query<{ actor: string; action: string; detail: string }>(
    `SELECT actor, action, detail::text AS detail FROM audit_event WHERE entity = 'care_contact' AND entity_id = :id ORDER BY id`,
    [{ name: "id", value: { stringValue: lucia.data.contact.id } }],
  );
  const session = await call("GET", "session");
  assert.deepEqual(audit.map((row) => row.action), ["care_contact_added", "care_contact_removed"]);
  assert.ok(audit.every((row) => row.actor === session.data.user.id));
  for (const row of audit) {
    assert.ok(!row.detail.includes("555"), "no phone in audit detail");
    assert.ok(!row.detail.includes("Lucia"), "no name in audit detail");
  }
});

test("completion: user-recorded per occurrence, shown on the timeline, refused off-schedule and for others", async () => {
  const session = await call("GET", "session");
  const today: string = session.data.today;

  const source = await call("POST", "care/sources", {
    body: {
      kind: "voice",
      text: "Mom has her breakfast at 8:00 every morning, usually oatmeal with brown sugar. " +
        "She takes her walk around the block at 10 am with her cane, every day if the weather is okay.",
    },
  });
  assert.equal(source.status, 200);
  const breakfast = source.data.facts.find((f: any) => f.textExact.includes("breakfast"));
  const walk = source.data.facts.find((f: any) => f.textExact.includes("walk"));
  assert.equal(breakfast.events.length, 1);
  assert.equal(walk.events.length, 1);
  const breakfastEvent: string = breakfast.events[0].id;
  const walkEvent: string = walk.events[0].id;

  // a suggested (unapproved) event cannot be marked done
  const unapproved = await call("POST", "care/events/[id]/complete", { body: { date: today, done: true }, params: { id: breakfastEvent } });
  assert.equal(unapproved.status, 409);
  assert.equal(unapproved.data.error.code, "state_conflict");

  const approved = await call("POST", "care/facts/[id]/approve", { params: { id: breakfast.id } });
  assert.equal(approved.status, 200);

  const initial = await call("GET", "care/timeline", { query: `?date=${today}` });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.items.length, 1);
  const item = initial.data.items[0];
  // every existing field is still there, plus completedAt
  assert.deepEqual(Object.keys(item).sort(), [
    "category", "completedAt", "eventId", "factId", "fullText", "highlight", "localTime", "locationText", "remindMinutes",
    "rrule", "startsAt", "title",
  ]);
  assert.equal(item.eventId, breakfastEvent);
  assert.equal(item.factId, breakfast.id);
  assert.equal(item.localTime, "08:00");
  assert.equal(item.rrule, "FREQ=DAILY");
  assert.equal(item.remindMinutes, 15);
  assert.equal(typeof item.highlight, "boolean");
  assert.ok(item.fullText.includes("breakfast at 8:00"));
  assert.equal(item.completedAt, null);

  const invalid: unknown[] = [
    { date: "2026-13-01", done: true },
    { date: "tomorrow", done: true },
    { date: today, done: "yes" },
    { date: today },
    { date: today, done: true, at: "now" },
  ];
  for (const body of invalid) {
    const response = await call("POST", "care/events/[id]/complete", { body, params: { id: breakfastEvent } });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(response.data, { error: { code: "invalid_input" } });
  }

  // the day before the first occurrence has nothing to complete
  const offSchedule = await call("POST", "care/events/[id]/complete", {
    body: { date: nextDay(today, -1), done: true }, params: { id: breakfastEvent },
  });
  assert.equal(offSchedule.status, 409);
  assert.equal(offSchedule.data.error.code, "not_scheduled");

  const foreignOrigin = await call("POST", "care/events/[id]/complete", {
    body: { date: today, done: true }, params: { id: breakfastEvent }, origin: "https://evil.example",
  });
  assert.equal(foreignOrigin.status, 403);
  await asOther(async () => {
    const steal = await call("POST", "care/events/[id]/complete", { body: { date: today, done: true }, params: { id: breakfastEvent } });
    assert.equal(steal.status, 404);
  });
  const missing = await call("POST", "care/events/[id]/complete", { body: { date: today, done: true }, params: { id: "nope" } });
  assert.equal(missing.status, 404);

  // viewing the timeline above recorded nothing
  const untouched = await call("GET", "care/timeline", { query: `?date=${today}` });
  assert.equal(untouched.data.items[0].completedAt, null);

  const done = await call("POST", "care/events/[id]/complete", { body: { date: today, done: true }, params: { id: breakfastEvent } });
  assert.equal(done.status, 200);
  assert.equal(done.data.eventId, breakfastEvent);
  assert.equal(done.data.date, today);
  assert.ok(!Number.isNaN(Date.parse(done.data.completedAt)));
  const repeat = await call("POST", "care/events/[id]/complete", { body: { date: today, done: true }, params: { id: breakfastEvent } });
  assert.equal(repeat.data.completedAt, done.data.completedAt);
  const rows = await rt.stores.database.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM usage_signal WHERE care_event_id = CAST(:id AS uuid) AND kind = 'completed'",
    [{ name: "id", value: { stringValue: breakfastEvent } }],
  );
  assert.deepEqual(rows, [{ n: 1 }]);

  const shown = await call("GET", "care/timeline", { query: `?date=${today}` });
  assert.equal(shown.data.items[0].completedAt, done.data.completedAt);
  // the same daily routine tomorrow is a separate occurrence
  const tomorrow = await call("GET", "care/timeline", { query: `?date=${nextDay(today, 1)}` });
  assert.equal(tomorrow.data.items[0].eventId, breakfastEvent);
  assert.equal(tomorrow.data.items[0].completedAt, null);

  const undone = await call("POST", "care/events/[id]/complete", { body: { date: today, done: false }, params: { id: breakfastEvent } });
  assert.equal(undone.status, 200);
  assert.deepEqual(undone.data, { eventId: breakfastEvent, date: today, completedAt: null });
  const cleared = await call("GET", "care/timeline", { query: `?date=${today}` });
  assert.equal(cleared.data.items[0].completedAt, null);
  const undoAgain = await call("POST", "care/events/[id]/complete", { body: { date: today, done: false }, params: { id: breakfastEvent } });
  assert.equal(undoAgain.data.completedAt, null);

  // the walk is still only suggested, so it stays off the timeline
  const walkBlocked = await call("POST", "care/events/[id]/complete", { body: { date: today, done: true }, params: { id: walkEvent } });
  assert.equal(walkBlocked.status, 409);
});

test("an appointment added from Urgent stays on the timeline and can be marked done", async () => {
  const intake = await call("POST", "intake", {
    body: { statement: "My mom Rosa has day surgery tomorrow and I'll be helping her at home for a week." },
  });
  assert.equal(intake.status, 200);
  const impact = await call("POST", "impact", { body: { episodeId: intake.data.episodeId } });
  assert.equal(impact.status, 200);
  const mom = impact.data.commitments.find((c: any) => c.title === "Mom follow-up appointment");
  assert.ok(mom?.startsAt);
  const added = await call("POST", "commitments/timeline", { body: { commitmentId: mom.id } });
  assert.equal(added.status, 200);

  const day = new Date(Date.parse(mom.startsAt) - 6 * 3_600_000).toISOString().slice(0, 10);
  const timeline = await call("GET", "care/timeline", { query: `?date=${day}` });
  const appointment = timeline.data.items.find((item: any) => item.eventId === added.data.eventId);
  assert.ok(appointment, "urgent appointment is on the timeline");
  assert.equal(appointment.factId, null);
  assert.equal(appointment.title, "Mom follow-up appointment");
  assert.equal(appointment.completedAt, null);

  const done = await call("POST", "care/events/[id]/complete", { body: { date: day, done: true }, params: { id: added.data.eventId } });
  assert.equal(done.status, 200);
  assert.ok(done.data.completedAt);
  // a one-off appointment does not occur the next day
  const nextDayDone = await call("POST", "care/events/[id]/complete", {
    body: { date: nextDay(day, 1), done: true }, params: { id: added.data.eventId },
  });
  assert.equal(nextDayDone.status, 409);
  const shown = await call("GET", "care/timeline", { query: `?date=${day}` });
  assert.equal(shown.data.items.find((item: any) => item.eventId === added.data.eventId).completedAt, done.data.completedAt);
});
