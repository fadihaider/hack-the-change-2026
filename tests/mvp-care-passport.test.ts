// care passport routes over the real runtime (PGlite in a temp dir, demo AI): the PRD 5.2 note, reject, edit as a new
// version, the full source view with owner scoping, and an AC5 breakfast conflict that updates the timeline
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-passport-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};

const PRD_NOTE =
  "Rosa usually has breakfast at eight. She prefers instructions written down. " +
  "Her spare glasses are in the bedroom drawer. She likes the radio on in the morning.";

before(async () => {
  for (const name of [
    "care/sources", "care/sources/[id]", "care/facts", "care/facts/[id]/approve", "care/facts/[id]/reject",
    "care/facts/[id]/edit", "care/conflicts/resolve", "care/timeline",
  ]) {
    routes[name] = (await import(`../app/api/${name}/route.ts`)) as { GET?: Handler; POST?: Handler };
  }
});

after(async () => {
  const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
  await (await holder.__reliefReadyPglite)?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST",
  route: string,
  options: { body?: unknown; query?: string; params?: Record<string, string> } = {},
): Promise<{ status: number; data: any }> {
  const handler = routes[route]?.[method];
  assert.ok(handler, `${method} ${route} is exported`);
  const headers: Record<string, string> = { Origin: BASE };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`${BASE}/api/${route}${options.query ?? ""}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, data: await response.json() };
}

const post = (route: string, id: string, body: unknown = {}) => call("POST", route, { params: { id }, body });

async function profileFacts(): Promise<any[]> {
  const profile = await call("GET", "care/facts");
  assert.equal(profile.status, 200);
  return profile.data.facts;
}

/** the Alberta Time (UTC-6) day of a UTC instant */
const albertaDay = (iso: string) => new Date(Date.parse(iso) - 6 * 3600_000).toISOString().slice(0, 10);

async function breakfastTimes(day: string): Promise<string[]> {
  const timeline = await call("GET", "care/timeline", { query: `?date=${day}` });
  assert.equal(timeline.status, 200);
  return timeline.data.items.filter((item: any) => /breakfast/i.test(item.title)).map((item: any) => item.localTime);
}

let sourceId = "";
let breakfastId = "";
let day = "";

test("db/mvp.sql swaps the category check by name, allows practical and can run on every boot", async () => {
  // the routes boot the database; load one so the runtime exists
  assert.equal((await call("GET", "care/facts")).status, 200);
  const { getRuntime } = await import("../lib/mvp/runtime.ts");
  const { splitStatements } = await import("../lib/mvp/database.ts");
  const database = (await getRuntime()).stores.database;
  // a second boot re-applies the whole file
  for (const statement of splitStatements(readFileSync(path.join(process.cwd(), "db", "mvp.sql"), "utf8"))) {
    await database.execute(statement);
  }
  const checks = await database.query<{ conname: string; def: string }>(
    "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'care_fact'::regclass AND contype = 'c'",
  );
  const category = checks.filter((check) => check.def.includes("category"));
  assert.deepEqual(category.map((check) => check.conname), ["care_fact_category_check"]);
  assert.match(category[0].def, /'practical'/);
  const columns = await database.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'care_fact' AND column_name = 'display_text'",
  );
  assert.equal(columns.length, 1);
  await assert.rejects(
    database.execute(
      "INSERT INTO care_fact (care_recipient_id, category, text_exact, status) " +
        "SELECT id, 'bogus', 'x', 'suggested' FROM care_recipient LIMIT 1",
    ),
  );
});

test("the PRD note becomes four suggestions: routine with 08:00, communication, practical and preference", async () => {
  const added = await call("POST", "care/sources", { body: { kind: "voice", text: PRD_NOTE } });
  assert.equal(added.status, 200);
  const facts = added.data.facts;
  assert.deepEqual(
    facts.map((fact: any) => [fact.category, fact.textExact, fact.status]),
    [
      ["routine", "Rosa usually has breakfast at eight.", "suggested"],
      ["communication", "She prefers instructions written down.", "suggested"],
      ["practical", "Her spare glasses are in the bedroom drawer.", "suggested"],
      ["preference", "She likes the radio on in the morning.", "suggested"],
    ],
  );
  for (const fact of facts) {
    assert.equal(fact.version, 1);
    assert.equal(fact.supersedes, null);
    assert.equal(fact.sourceAuthor, "caregiver");
    assert.equal(fact.sourceKind, "voice");
    assert.ok(!Number.isNaN(Date.parse(fact.sourceCreatedAt)));
    assert.equal(fact.displayText, null);
    assert.equal(fact.sourceId, added.data.source.id);
  }
  const [breakfast, , glasses] = facts;
  assert.equal(breakfast.events.length, 1);
  assert.equal(breakfast.events[0].status, "suggested");
  assert.equal(breakfast.events[0].rrule, null);
  assert.match(breakfast.events[0].startsAt, /T14:00:00\.000Z$/);
  assert.equal(glasses.events.length, 0);
  sourceId = added.data.source.id;
  breakfastId = breakfast.id;
  day = albertaDay(breakfast.events[0].startsAt);

  // nothing suggested is on the timeline yet
  assert.deepEqual(await breakfastTimes(day), []);
});

test("reject leaves a suggested fact out for good, and only suggested facts can be rejected", async () => {
  const radio = (await profileFacts()).find((fact) => fact.category === "preference");
  const rejected = await post("care/facts/[id]/reject", radio.id);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.fact.id, radio.id);
  assert.equal(rejected.data.fact.status, "rejected");
  // the row is kept, not deleted
  assert.equal((await profileFacts()).find((fact) => fact.id === radio.id).status, "rejected");

  const again = await post("care/facts/[id]/reject", radio.id);
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "state_conflict");
  assert.equal((await post("care/facts/[id]/approve", radio.id)).status, 409);

  const unknown = await post("care/facts/[id]/reject", "00000000-0000-4000-8000-000000000000");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, "not_found");
  assert.equal((await post("care/facts/[id]/reject", "not-a-uuid")).status, 404);
});

test("edit saves the caregiver's wording as version 2 and keeps version 1 as superseded", async () => {
  const facts = await profileFacts();
  const glasses = facts.find((fact) => fact.category === "practical");
  const written = facts.find((fact) => fact.category === "communication");
  assert.equal((await post("care/facts/[id]/approve", glasses.id)).status, 200);

  const edited = await post("care/facts/[id]/edit", glasses.id, { text: "  Her spare glasses are in the top drawer of the bedroom dresser. " });
  assert.equal(edited.status, 200);
  const { fact, previous } = edited.data;
  assert.equal(fact.textExact, "Her spare glasses are in the top drawer of the bedroom dresser.");
  assert.equal(fact.category, "practical");
  assert.equal(fact.status, "approved");
  assert.equal(fact.version, 2);
  assert.equal(fact.supersedes, glasses.id);
  assert.equal(fact.sourceKind, "note");
  assert.equal(fact.sourceAuthor, "caregiver");
  assert.equal(fact.spanStart, 0);
  assert.equal(fact.spanEnd, fact.textExact.length);
  assert.notEqual(fact.sourceId, glasses.sourceId);
  assert.equal(previous.id, glasses.id);
  assert.equal(previous.status, "superseded");
  assert.equal(previous.version, 1);
  assert.equal(previous.textExact, "Her spare glasses are in the bedroom drawer.");

  // the original stays in the profile as history, and its source is unchanged
  const after = await profileFacts();
  assert.equal(after.find((row) => row.id === glasses.id).status, "superseded");
  const source = await call("GET", "care/sources/[id]", { params: { id: fact.sourceId } });
  assert.equal(source.data.fullText, fact.textExact);
  assert.equal(source.data.kind, "note");

  // a superseded version can't be edited again, only the current one
  const stale = await post("care/facts/[id]/edit", glasses.id, { text: "Her glasses are on the shelf." });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "state_conflict");

  // edit-and-approve straight from a suggestion
  const fromSuggestion = await post("care/facts/[id]/edit", written.id, { text: "She prefers instructions written down in large print." });
  assert.equal(fromSuggestion.status, 200);
  assert.equal(fromSuggestion.data.fact.status, "approved");
  assert.equal(fromSuggestion.data.fact.category, "communication");
  assert.equal(fromSuggestion.data.previous.status, "superseded");

  // wording is checked after normalizing, 1 to 1000 characters
  assert.equal((await post("care/facts/[id]/edit", fromSuggestion.data.fact.id, { text: "   " })).status, 400);
  assert.equal((await post("care/facts/[id]/edit", fromSuggestion.data.fact.id, { text: "x".repeat(1001) })).status, 400);
  assert.equal((await post("care/facts/[id]/edit", fromSuggestion.data.fact.id, { wording: "x" })).status, 400);

  // a written care instruction keeps its source wording
  const sheet = await call("POST", "care/sources", { body: { kind: "note", text: "Keep the incision dry for 48 hours." } });
  const instruction = sheet.data.facts[0];
  assert.equal(instruction.category, "medical_instruction");
  const locked = await post("care/facts/[id]/edit", instruction.id, { text: "Keep the incision dry for 24 hours." });
  assert.equal(locked.status, 409);
  assert.equal(locked.data.error.code, "exact_wording_locked");
});

test("a source is readable in full by its owner only", async () => {
  const source = await call("GET", "care/sources/[id]", { params: { id: sourceId } });
  assert.equal(source.status, 200);
  assert.deepEqual(Object.keys(source.data).sort(), ["author", "createdAt", "fullText", "id", "kind"]);
  assert.equal(source.data.id, sourceId);
  assert.equal(source.data.kind, "voice");
  assert.equal(source.data.author, "caregiver");
  assert.equal(source.data.fullText, PRD_NOTE);
  assert.ok(!Number.isNaN(Date.parse(source.data.createdAt)));

  assert.equal((await call("GET", "care/sources/[id]", { params: { id: "00000000-0000-4000-8000-000000000000" } })).status, 404);
  assert.equal((await call("GET", "care/sources/[id]", { params: { id: "../facts" } })).status, 404);

  // another caregiver with their own recipient gets the same 404 for Rosa's source
  const { getRuntime } = await import("../lib/mvp/runtime.ts");
  const { p } = await import("../lib/db.ts");
  const rt = await getRuntime();
  const [other] = await rt.stores.database.query<{ id: string }>(
    "INSERT INTO app_user (email) VALUES ('other.caregiver@example.test') RETURNING id::text AS id",
  );
  await rt.stores.database.execute(
    "INSERT INTO care_recipient (owner_id, alias, is_fictional) VALUES (CAST(:owner AS uuid), 'Dad', true)",
    [p.uuid("owner", other.id)],
  );
  const original = rt.auth.currentUser;
  rt.auth.currentUser = async () => ({ id: other.id, email: "other.caregiver@example.test" });
  try {
    const foreign = await call("GET", "care/sources/[id]", { params: { id: sourceId } });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.data.error.code, "not_found");
    assert.equal((await post("care/facts/[id]/reject", breakfastId)).status, 404);
    assert.equal((await post("care/facts/[id]/edit", breakfastId, { text: "Breakfast at 9:00." })).status, 404);
    assert.deepEqual((await call("GET", "care/facts")).data.facts, []);
  } finally {
    rt.auth.currentUser = original;
  }
});

test("AC5: 8:30 against an approved 08:00 breakfast is a conflict; resolving it leaves only the kept time", async () => {
  assert.equal((await post("care/facts/[id]/approve", breakfastId)).status, 200);
  assert.deepEqual(await breakfastTimes(day), ["08:00"]);

  const later = await call("POST", "care/sources", { body: { kind: "note", text: "Rosa has breakfast at 8:30." } });
  assert.equal(later.status, 200);
  assert.equal(later.data.conflicts.length, 1);
  assert.equal(later.data.conflicts[0].existingFactId, breakfastId);
  const newId = later.data.conflicts[0].factId;
  assert.equal(later.data.facts[0].status, "conflicting");
  assert.deepEqual(later.data.facts[0].conflictsWith, [breakfastId]);

  // neither time silently wins
  assert.deepEqual(await breakfastTimes(day), []);
  const old = (await profileFacts()).find((fact) => fact.id === breakfastId);
  assert.equal(old.status, "conflicting");
  assert.deepEqual(old.conflictsWith, [newId]);
  assert.equal((await post("care/facts/[id]/approve", newId)).data.error.code, "conflict_unresolved");
  assert.equal((await post("care/facts/[id]/reject", newId)).data.error.code, "conflict_unresolved");
  assert.equal((await post("care/facts/[id]/edit", newId, { text: "Rosa has breakfast at 9:00." })).data.error.code, "conflict_unresolved");

  const resolved = await call("POST", "care/conflicts/resolve", { body: { keepFactId: newId } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.kept.status, "approved");
  assert.deepEqual(resolved.data.superseded.map((fact: any) => fact.id), [breakfastId]);
  assert.deepEqual(await breakfastTimes(day), ["08:30"]);
});

test("editing a timed fact moves its event only to a time the new wording states", async () => {
  const kept = (await profileFacts()).find((fact) => fact.status === "approved" && fact.textExact === "Rosa has breakfast at 8:30.");
  const moved = await post("care/facts/[id]/edit", kept.id, { text: "Rosa has breakfast at 9:00 now." });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.fact.version, 2);
  assert.equal(moved.data.fact.events.length, 1);
  assert.equal(moved.data.fact.events[0].status, "approved");
  assert.equal(moved.data.fact.events[0].rrule, null);
  assert.ok(moved.data.previous.events.every((event: any) => event.status === "superseded"));
  assert.deepEqual(await breakfastTimes(day), ["09:00"]);

  const untimed = await post("care/facts/[id]/edit", moved.data.fact.id, { text: "Rosa has a late breakfast when she feels like it." });
  assert.equal(untimed.status, 200);
  assert.equal(untimed.data.fact.version, 3);
  assert.equal(untimed.data.fact.supersedes, moved.data.fact.id);
  assert.deepEqual(untimed.data.fact.events, []);
  assert.deepEqual(await breakfastTimes(day), []);
});

async function itemTimes(date: string, pattern: RegExp): Promise<string[]> {
  const timeline = await call("GET", "care/timeline", { query: `?date=${date}` });
  assert.equal(timeline.status, 200);
  return timeline.data.items.filter((item: any) => pattern.test(item.title)).map((item: any) => item.localTime);
}

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

test("AC5: resolving a conflict between three notes sets aside every other note, not just one", async () => {
  const first = await call("POST", "care/sources", { body: { kind: "note", text: "Rosa has lunch at 12:00." } });
  const firstId = first.data.facts[0].id;
  assert.equal((await post("care/facts/[id]/approve", firstId)).status, 200);
  const second = await call("POST", "care/sources", { body: { kind: "note", text: "Rosa has lunch at 12:30." } });
  const secondId = second.data.facts[0].id;
  assert.deepEqual(second.data.conflicts.map((conflict: any) => conflict.existingFactId), [firstId]);
  const third = await call("POST", "care/sources", { body: { kind: "voice", text: "Rosa has lunch at 12:15." } });
  const thirdId = third.data.facts[0].id;
  assert.deepEqual(third.data.conflicts.map((conflict: any) => conflict.existingFactId).sort(), [firstId, secondId].sort());
  assert.deepEqual(await itemTimes(day, /lunch/i), []);

  const resolved = await call("POST", "care/conflicts/resolve", { body: { keepFactId: thirdId } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.kept.id, thirdId);
  assert.equal(resolved.data.kept.status, "approved");
  assert.deepEqual(resolved.data.superseded.map((fact: any) => fact.id).sort(), [firstId, secondId].sort());
  // nothing is left conflicting on its own, and only the kept time is on the timeline
  const facts = await profileFacts();
  assert.deepEqual(facts.filter((fact) => fact.status === "conflicting"), []);
  assert.equal(facts.find((fact) => fact.id === secondId).status, "superseded");
  assert.deepEqual(await itemTimes(day, /lunch/i), ["12:15"]);
});

test("editing to wording that says every day makes the event repeat; a vaguer repeat is never invented", async () => {
  const added = await call("POST", "care/sources", { body: { kind: "note", text: "Rosa takes a short walk at 10:00." } });
  const walk = added.data.facts[0];
  assert.equal(walk.events.length, 1);
  assert.equal(walk.events[0].rrule, null);
  assert.equal((await post("care/facts/[id]/approve", walk.id)).status, 200);
  assert.deepEqual(await itemTimes(nextDay(day), /walk/i), []);

  const daily = await post("care/facts/[id]/edit", walk.id, { text: "Rosa takes a short walk at 10:00 every day." });
  assert.equal(daily.status, 200);
  assert.equal(daily.data.fact.events.length, 1);
  assert.equal(daily.data.fact.events[0].rrule, "FREQ=DAILY");
  assert.deepEqual(await itemTimes(day, /walk/i), ["10:00"]);
  assert.deepEqual(await itemTimes(nextDay(day), /walk/i), ["10:00"]);

  // "every other day" is not every day, so the daily rule is not kept
  const vaguer = await post("care/facts/[id]/edit", daily.data.fact.id, { text: "Rosa takes a short walk at 10:00 every other day." });
  assert.equal(vaguer.status, 200);
  assert.equal(vaguer.data.fact.events[0].rrule, null);
  assert.deepEqual(await itemTimes(nextDay(day), /walk/i), []);
  // "each morning on weekdays" names days, so no daily rule is added
  const weekdays = await post("care/facts/[id]/edit", vaguer.data.fact.id, { text: "Rosa takes a short walk at 10:00 each morning on weekdays." });
  assert.equal(weekdays.status, 200);
  assert.equal(weekdays.data.fact.events[0].rrule, null);
});

test("wording about medication or wound care stays locked whatever its category, and an edit can't introduce it", async () => {
  const meal = await call("POST", "care/sources", { body: { kind: "note", text: "Breakfast at 8:30 with medication." } });
  const routine = meal.data.facts[0];
  assert.equal(routine.category, "routine");
  const rewritten = await post("care/facts/[id]/edit", routine.id, { text: "Breakfast at 8:30." });
  assert.equal(rewritten.status, 409);
  assert.equal(rewritten.data.error.code, "exact_wording_locked");
  assert.equal((await profileFacts()).find((fact) => fact.id === routine.id).textExact, "Breakfast at 8:30 with medication.");

  const glasses = (await profileFacts()).find((fact) => fact.category === "practical" && fact.status === "approved");
  const introduced = await post("care/facts/[id]/edit", glasses.id, { text: "Her spare glasses and her pills are in the drawer." });
  assert.equal(introduced.status, 409);
  assert.equal(introduced.data.error.code, "exact_wording_locked");
  assert.equal((await profileFacts()).find((fact) => fact.id === glasses.id).status, "approved");
});
