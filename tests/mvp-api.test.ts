// mvp route handlers over the real runtime: PGlite in a temp dir, demo AI, outbox mail, seed calendar
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-api-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};

before(async () => {
  const load = async (name: string) => {
    routes[name] = (await import(`../app/api/${name}/route.ts`)) as { GET?: Handler; POST?: Handler };
  };
  for (const name of [
    "session", "intake", "impact", "commitments/decide", "requests", "requests/approve", "requests/send",
    "responses/[token]", "outbox", "recover", "care/sources", "care/facts/[id]/approve", "care/conflicts/resolve",
    "care/timeline", "care/ask",
  ]) {
    await load(name);
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
  options: { body?: unknown; query?: string; params?: Record<string, string>; headers?: Record<string, string>; origin?: string } = {},
): Promise<{ status: number; data: any }> {
  const handler = routes[route]?.[method];
  assert.ok(handler, `${method} ${route} is exported`);
  const url = `${BASE}/api/${route}${options.query ?? ""}`;
  const headers: Record<string, string> = { Origin: options.origin ?? BASE, ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, data: await response.json() };
}

test("intake, impact, decide, approve, send, accept from the outbox, then recover groups", async () => {
  const session = await call("GET", "session");
  assert.equal(session.status, 200);
  assert.equal(session.data.user.email, "alex@example.test");
  assert.equal(session.data.mode.db, "pglite");

  const intake = await call("POST", "intake", {
    body: { statement: "My mom Rosa has day surgery tomorrow and I'll be helping her at home for a week." },
  });
  assert.equal(intake.status, 200);
  assert.equal(intake.data.result.status, "ready");
  assert.ok(intake.data.episodeId);

  const impact = await call("POST", "impact", { body: { episodeId: intake.data.episodeId } });
  assert.equal(impact.status, 200);
  assert.equal(impact.data.commitments.length, 6);
  const mom = impact.data.commitments.find((c: any) => c.title === "Mom follow-up appointment");
  assert.equal(mom.forCareRecipient, true);
  assert.equal(mom.suggestedAction, "keep");
  const shift = impact.data.commitments.find((c: any) => /work shift/i.test(c.title));
  assert.ok(shift.ruleConflicts[0].startsWith("Overlaps the care period"));

  // a foreign origin is refused before anything is read
  const foreign = await call("POST", "commitments/decide", {
    body: { commitmentId: shift.id, decision: "coverage" }, origin: "https://evil.example",
  });
  assert.equal(foreign.status, 403);

  const decided = await call("POST", "commitments/decide", { body: { commitmentId: shift.id, decision: "coverage" } });
  assert.equal(decided.status, 200);
  const draft = decided.data.request;
  assert.equal(draft.state, "awaiting_approval");
  assert.equal(draft.recipient.email, "morgan.chen@example.test");
  assert.equal(draft.disclosureTier, "general");
  const again = await call("POST", "commitments/decide", { body: { commitmentId: shift.id, decision: "coverage" } });
  assert.equal(again.data.existing, true);
  assert.equal(again.data.request.id, draft.id);
  const keep = await call("POST", "commitments/decide", { body: { commitmentId: mom.id, decision: "notify" } });
  assert.equal(keep.data.commitment.decision, "keep");
  assert.equal(keep.data.request, null);

  const noHeader = await call("POST", "requests/approve", { body: { requestId: draft.id } });
  assert.equal(noHeader.status, 428);
  const approved = await call("POST", "requests/approve", {
    body: { requestId: draft.id }, headers: { "If-Match": `"${draft.revision}"` },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.request.state, "approved");

  const sent = await call("POST", "requests/send", { body: { requestId: draft.id } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.state, "requested");

  const outbox = await call("GET", "outbox");
  const message = outbox.data.messages[0];
  assert.equal(message.to, "morgan.chen@example.test");
  const token = /Accept: \S+\/r\/([A-Za-z0-9_-]{43})/.exec(message.body)?.[1];
  assert.ok(token);
  const accepted = await call("POST", "responses/[token]", { body: {}, params: { token: token! } });
  assert.deepEqual(accepted.data, { state: "accepted", recorded: true });
  const repeat = await call("POST", "responses/[token]", { body: {}, params: { token: token! } });
  assert.deepEqual(repeat.data, { state: "accepted", recorded: false });

  const recover = await call("POST", "recover", { body: {} });
  assert.equal(recover.status, 200);
  assert.deepEqual(recover.data.groups.handled.map((r: any) => r.id), [draft.id]);
});

test("care sources, conflict resolution, approval, timeline and a question not in the profile", async () => {
  const voice = await call("POST", "care/sources", {
    body: {
      kind: "voice",
      text: "Mom has her breakfast at 8:00 every morning, usually oatmeal with brown sugar. " +
        "She takes her walk around the block at 10 am with her cane, every day if the weather is okay.",
    },
  });
  assert.equal(voice.status, 200);
  assert.equal(voice.data.facts.length, 2);
  const walk = voice.data.facts.find((f: any) => f.textExact.includes("walk"));
  assert.equal(walk.status, "suggested");

  const sheet = await call("POST", "care/sources", {
    body: { kind: "note", text: "Discharge notes (fictional demo). Breakfast at 8:30 with medication. Keep the incision dry for 48 hours." },
  });
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data.conflicts.length, 1);
  const keepId = sheet.data.conflicts[0].factId;

  // a conflicting fact can't be approved directly, only through resolve
  const blocked = await call("POST", "care/facts/[id]/approve", { params: { id: keepId } });
  assert.equal(blocked.status, 409);
  const resolved = await call("POST", "care/conflicts/resolve", { body: { keepFactId: keepId } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.kept.status, "approved");
  assert.equal(resolved.data.superseded.length, 1);

  const approved = await call("POST", "care/facts/[id]/approve", { params: { id: walk.id } });
  assert.equal(approved.data.fact.status, "approved");

  const session = await call("GET", "session");
  const timeline = await call("GET", "care/timeline", { query: `?date=${session.data.episode.startsOn}` });
  assert.equal(timeline.status, 200);
  assert.deepEqual(timeline.data.items.map((item: any) => item.localTime), ["08:30", "10:00"]);
  assert.ok(timeline.data.items[0].fullText.startsWith("Breakfast at 8:30"));

  const ask = await call("POST", "care/ask", { body: { question: "Where are her spare glasses?" } });
  assert.equal(ask.status, 200);
  assert.equal(ask.data.notFound, true);
  assert.equal(ask.data.answer, "Not in profile");
  assert.ok(ask.data.openQuestionId);
});

test("weekly and daily rules expand on the right Alberta days", async () => {
  const { occurrenceOn } = await import("../app/api/_lib/rrule.ts");
  // 2026-11-09 is a Monday; 08:00 Alberta Time is 14:00 UTC
  const start = "2026-11-09T14:00:00.000Z";
  assert.equal(occurrenceOn(start, "FREQ=WEEKLY;BYDAY=MO,TH", "2026-11-12"), "2026-11-12T14:00:00.000Z");
  assert.equal(occurrenceOn(start, "FREQ=WEEKLY;BYDAY=MO,TH", "2026-11-11"), null);
  assert.equal(occurrenceOn(start, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-11-16"), null);
  assert.equal(occurrenceOn(start, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-11-23"), "2026-11-23T14:00:00.000Z");
  assert.equal(occurrenceOn(start, "FREQ=DAILY", "2026-11-08"), null);
  assert.equal(occurrenceOn(start, null, "2026-11-09"), start);
});
