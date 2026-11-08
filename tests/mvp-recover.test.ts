// recover truthfulness (PRD 13, AC11), honest adapter labels (PRD 14, AC13) and global security headers (PRD 15).
// the route test runs over the real runtime: PGlite in a temp dir, demo AI, outbox mail, seed calendar.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match.js";
import nextConfig from "../next.config.ts";
import { evidenceLine, heldBack, pillLabel, sortGroups, statusLine, summaryLine, urgentHref } from "../components/app/recover/lines.ts";
import { p, type Database } from "../lib/db.ts";
import { modeLabels } from "../lib/frontend/live-api.ts";
import type { RequestView } from "../lib/frontend/request-api.ts";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-recover-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};

before(async () => {
  for (const name of [
    "intake", "impact", "commitments/decide", "requests/approve", "requests/send", "responses/[token]", "outbox", "recover",
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
  options: { body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; origin?: string } = {},
): Promise<{ status: number; data: any }> {
  const handler = routes[route]?.[method];
  assert.ok(handler, `${method} ${route} is exported`);
  const headers: Record<string, string> = { Origin: options.origin ?? BASE, ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`${BASE}/api/${route}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, data: await response.json() };
}

// ---------------------------------------------------------------- fixtures for the pure line builders

const T0 = "2026-11-07T18:00:00.000Z";
const T1 = "2026-11-07T19:00:00.000Z";
const T2 = "2026-11-07T20:00:00.000Z";
const SECRET_REF = "f".repeat(64);

function view(overrides: Partial<RequestView>): RequestView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    revision: "a".repeat(64),
    state: "requested",
    action: "coverage",
    recipient: { contactId: "c1", name: "Morgan Chen", email: "morgan.chen@example.test" },
    subject: "Cover my shift?",
    body: "Hi Morgan",
    disclosureTier: "general",
    healthTermsFound: [],
    healthOverride: false,
    respondBy: null,
    proposedAt: null,
    proposedNote: null,
    approval: null,
    evidence: [],
    ...overrides,
  };
}

function event(
  kind: RequestView["evidence"][number]["evidenceKind"],
  from: RequestView["state"] | null,
  to: RequestView["state"],
  ref: string | null,
  at = T1,
): RequestView["evidence"][number] {
  return { id: `${kind}-${to}`, fromState: from, toState: to, evidenceKind: kind, evidenceRef: ref, actor: "system", at };
}

test("a message held back at send time never reads as a reply", () => {
  for (const ref of ["approval hash mismatch", "health term at send"]) {
    const held = view({
      state: "needs_review",
      evidence: [event("error", "approved", "needs_review", ref, T2), event("approval", "awaiting_approval", "approved", SECRET_REF, T1)],
    });
    assert.equal(heldBack(held), true);
    assert.equal(pillLabel(held), "Held back");
    const line = statusLine(held, "outbox");
    assert.match(line, /^Held back before sending/);
    assert.doesNotMatch(line, /repl/i);
    assert.match(evidenceLine(held.evidence[0], held, "outbox"), /^Held back:/);
  }
  // a proposal through the reply link is a real reply and keeps the normal pill
  const proposed = view({
    state: "needs_review",
    proposedAt: T2,
    evidence: [event("link_click", "requested", "needs_review", SECRET_REF, T2)],
  });
  assert.equal(heldBack(proposed), false);
  assert.equal(pillLabel(proposed), undefined);
  assert.match(statusLine(proposed), /^Asked for /);
});

test("sent copy follows the mail adapter: demo outbox never says sent by email", () => {
  const sent = view({ evidence: [event("gmail_message_id", "sending", "requested", "outbox-123", T1)] });
  const outboxLine = statusLine(sent, "outbox");
  assert.match(outboxLine, /^Placed in the demo outbox/);
  assert.doesNotMatch(outboxLine, /Sent by email/);
  assert.match(statusLine(sent, "gmail"), /^Sent by email/);
  assert.equal(evidenceLine(sent.evidence[0], sent, "outbox"), "Placed in the demo outbox.");
  assert.equal(evidenceLine(sent.evidence[0], sent, "gmail"), "Sent by email. Gmail accepted it.");
  const sending = view({ state: "sending", evidence: [event("approval", "approved", "sending", SECRET_REF, T1)] });
  assert.match(statusLine(sending, "outbox"), /check the demo outbox before sending again/);
  assert.match(statusLine(sending, "gmail"), /check your Gmail Sent folder/);
});

test("evidence lines never echo token hashes, message ids or approval hashes", () => {
  const request = view({ state: "accepted" });
  const rows = [
    event("approval", "awaiting_approval", "approved", SECRET_REF),
    event("approval", "approved", "sending", SECRET_REF),
    event("gmail_message_id", "sending", "requested", SECRET_REF),
    event("link_click", "requested", "accepted", SECRET_REF),
    event("link_click", "requested", "rejected", SECRET_REF),
    event("scheduler", "requested", "expired", "respond_by passed"),
    event("user_manual", "draft", "awaiting_approval", null),
    event("user_manual", "awaiting_approval", "cancelled", null),
    event("error", "sending", "failed", SECRET_REF),
  ];
  for (const row of rows) {
    for (const mail of ["outbox", "gmail"]) {
      const line = evidenceLine(row, request, mail);
      assert.ok(line.length > 0);
      assert.ok(!line.includes(SECRET_REF), `${row.evidenceKind} leaks its ref`);
      assert.ok(!line.includes("respond_by"), "raw scheduler ref stays hidden");
    }
  }
  assert.equal(evidenceLine(rows[3], request), "Morgan Chen chose Accept on their reply link.");
  assert.equal(evidenceLine(rows[8], request), "Something stopped it.");
});

test("groups keep the PRD names: follow-up, not sent (open first), new, waiting, handled", () => {
  const draft = view({ id: "d", state: "draft" });
  const cancelled = view({ id: "c", state: "cancelled" });
  const approved = view({ id: "a", state: "approved" });
  const expired = view({ id: "e", state: "expired" });
  const waiting = view({ id: "w", state: "requested" });
  const handled = view({ id: "h", state: "accepted", evidence: [event("link_click", "requested", "accepted", SECRET_REF)] });
  const sorted = sortGroups({
    handled: [handled],
    waiting: [waiting],
    needsFollowUp: [expired],
    notSent: [cancelled, draft, approved],
    new: [{ id: "n", title: "Proposed: shift", startsAt: T2, requestId: "x" }],
  });
  assert.deepEqual(sorted.followUp.map((r) => r.id), ["e"]);
  assert.deepEqual(sorted.notSent.map((r) => r.id), ["d", "a", "c"]);
  assert.deepEqual(sorted.waiting.map((r) => r.id), ["w"]);
  assert.deepEqual(sorted.handled.map((r) => r.id), ["h"]);
  assert.deepEqual(sorted.needsYou.map((r) => r.id), ["e", "d", "a"]);
  assert.equal(
    summaryLine(sorted),
    "1 needs follow-up, 3 aren’t sent, 1 new time came in, 1 is waiting for a reply and 1 is handled.",
  );
  // said yes is handled, but it is never presented as done
  assert.match(statusLine(handled), /^Said yes/);
  assert.doesNotMatch(statusLine(handled), /done/i);
  assert.equal(urgentHref("11111111-1111-4111-8111-111111111111"), "/urgent?request=11111111-1111-4111-8111-111111111111");
});

// ---------------------------------------------------------------- adapter labels

test("adapter labels say what runs, and demo rules are never called Claude", () => {
  const demo = modeLabels({ db: "pglite", ai: "demo", mail: "outbox", calendar: "seed", auth: "demo" });
  const byKey = Object.fromEntries(demo.map((label) => [label.key, label.value]));
  assert.deepEqual(byKey, {
    ai: "Demo rules (offline)",
    mail: "Demo outbox",
    calendar: "Seeded demo calendar",
    speech: "Off",
    retrieval: "Keyword",
    db: "Local PGlite",
    auth: "Demo (fictional Alex)",
  });
  assert.ok(!demo.some((label) => /claude/i.test(label.value)));

  const live = modeLabels(
    { db: "supabase", ai: "bedrock", mail: "gmail", calendar: "google", auth: "google" },
    { speech: "elevenlabs", retrieval: "vector" },
  );
  const liveByKey = Object.fromEntries(live.map((label) => [label.key, label.value]));
  assert.equal(liveByKey.ai, "Claude on Bedrock");
  assert.equal(liveByKey.mail, "Gmail");
  assert.equal(liveByKey.speech, "ElevenLabs Scribe");
  assert.equal(liveByKey.retrieval, "Keyword + vectors");
  assert.equal(liveByKey.db, "Supabase");
  // an unknown mode word is shown as-is, not dressed up as a known provider
  const odd = modeLabels({ db: "pglite", ai: "mystery", mail: "outbox", calendar: "seed", auth: "demo" });
  assert.equal(odd.find((label) => label.key === "ai")?.value, "mystery");
});

// ---------------------------------------------------------------- security headers

test("global security headers apply everywhere and the strict routes still win", async () => {
  assert.ok(nextConfig.headers, "next.config exports headers()");
  const entries = await nextConfig.headers();
  const global = entries[0];
  assert.equal(global.source, "/(.*)");
  // next matches header sources with these options at runtime (server/lib/router-utils/filesystem.js); "/:path*" misses "/"
  const matches = getPathMatch(global.source, { strict: true, removeUnnamedParams: true });
  for (const pathname of ["/", "/care", "/recover", "/api/session", "/r/abc"]) {
    assert.notEqual(matches(pathname), false, `global headers reach ${pathname}`);
  }
  const value = (key: string, list = global.headers) => list.find((h) => h.key === key)?.value;
  assert.equal(value("X-Content-Type-Options"), "nosniff");
  assert.equal(value("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(value("X-Frame-Options"), "DENY");
  assert.match(value("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  assert.doesNotMatch(value("Content-Security-Policy") ?? "", /script-src/);
  const permissions = value("Permissions-Policy") ?? "";
  assert.match(permissions, /microphone=\(self\)/);
  assert.match(permissions, /camera=\(\)/);
  assert.match(permissions, /geolocation=\(\)/);
  // next applies matches in order and a later duplicate key overrides, so the strict routes keep no-referrer
  for (const source of ["/r/:path*", "/api/responses/:path*", "/outbox"]) {
    const index = entries.findIndex((entry) => entry.source === source);
    assert.ok(index > 0, `${source} comes after the global entry`);
    assert.equal(value("Referrer-Policy", entries[index].headers), "no-referrer");
    assert.equal(value("Cache-Control", entries[index].headers), "no-store");
  }
});

// ---------------------------------------------------------------- the routes, end to end

test("recover over the real routes: sent waits, held back needs follow-up, accepted is handled", async () => {
  const foreign = await call("POST", "recover", { body: {}, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);

  const intake = await call("POST", "intake", {
    body: { statement: "My mom Rosa has day surgery tomorrow and I'll be helping her at home for a week." },
  });
  assert.equal(intake.status, 200);
  const impact = await call("POST", "impact", { body: { episodeId: intake.data.episodeId } });
  assert.equal(impact.status, 200);
  const shift = impact.data.commitments.find((c: any) => /work shift/i.test(c.title));
  const others = impact.data.commitments.filter((c: any) => c.id !== shift.id && c.suggestedContactId && !c.forCareRecipient);
  assert.ok(others.length > 0, "a second commitment with a contact exists");

  async function approvedRequest(commitmentId: string, decision: string) {
    const decided = await call("POST", "commitments/decide", { body: { commitmentId, decision } });
    assert.equal(decided.status, 200);
    const draft = decided.data.request;
    assert.ok(draft, `${decision} queued a request`);
    const approved = await call("POST", "requests/approve", {
      body: { requestId: draft.id }, headers: { "If-Match": `"${draft.revision}"` },
    });
    assert.equal(approved.status, 200);
    return draft.id as string;
  }

  // 1. sent to the demo outbox: waiting, never handled
  const sentId = await approvedRequest(shift.id, "coverage");
  const sent = await call("POST", "requests/send", { body: { requestId: sentId } });
  assert.equal(sent.data.state, "requested");
  let recover = await call("POST", "recover", { body: {} });
  assert.equal(recover.status, 200);
  assert.deepEqual(Object.keys(recover.data.groups).sort(), ["handled", "needsFollowUp", "new", "notSent", "waiting"]);
  const waiting: RequestView = recover.data.groups.waiting.find((r: RequestView) => r.id === sentId);
  assert.ok(waiting, "a sent request waits");
  assert.ok(!recover.data.groups.handled.some((r: RequestView) => r.id === sentId), "sent is not handled");
  assert.equal(waiting.evidence[0].evidenceKind, "gmail_message_id");
  assert.match(statusLine(waiting, "outbox"), /^Placed in the demo outbox/);

  // 2. the message changes after approval: the server holds it back, and recover says so instead of "replied"
  const heldId = await approvedRequest(others[0].id, "notify");
  const holder = globalThis as { __reliefReadyPglite?: Promise<Pick<Database, "execute">> };
  const database = await holder.__reliefReadyPglite;
  assert.ok(database);
  const changed = await database.execute(
    "UPDATE request SET draft_body = draft_body || ' (changed)' WHERE id = CAST(:id AS uuid)",
    [p.uuid("id", heldId)],
  );
  assert.equal(changed, 1);
  const held = await call("POST", "requests/send", { body: { requestId: heldId } });
  assert.equal(held.data.state, "needs_review");
  recover = await call("POST", "recover", { body: {} });
  const followUp: RequestView = recover.data.groups.needsFollowUp.find((r: RequestView) => r.id === heldId);
  assert.ok(followUp, "a held-back request needs follow-up");
  assert.equal(heldBack(followUp), true);
  assert.equal(statusLine(followUp, "outbox").includes("the message changed after you approved it"), true);
  assert.doesNotMatch(statusLine(followUp, "outbox"), /repl/i);

  // 3. accepted through the reply link: handled, said yes, not done
  const outbox = await call("GET", "outbox");
  const message = outbox.data.messages.find((m: any) => m.to === "morgan.chen@example.test");
  const token = /Accept: \S+\/r\/([A-Za-z0-9_-]{43})/.exec(message.body)?.[1];
  assert.ok(token);
  const accepted = await call("POST", "responses/[token]", { body: {}, params: { token: token! } });
  assert.deepEqual(accepted.data, { state: "accepted", recorded: true });
  recover = await call("POST", "recover", { body: {} });
  const handled: RequestView = recover.data.groups.handled.find((r: RequestView) => r.id === sentId);
  assert.equal(handled.state, "accepted");
  assert.match(statusLine(handled, "outbox"), /^Said yes/);
  const lines = [...handled.evidence].reverse().map((row) => evidenceLine(row, handled, "outbox"));
  assert.deepEqual(lines, [
    "You chose this message to review.",
    "You approved this exact message.",
    "Placing it in the demo outbox started from your approval.",
    "Placed in the demo outbox.",
    "Morgan Chen chose Accept on their reply link.",
  ]);
});
