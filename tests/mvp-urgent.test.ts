// urgent repairs over the real runtime (PRD section 12; AC1, AC2): change the plan survives a reload, server names,
// one request per group member, an editable tier covered by revision and hash, extra health terms at approve and send,
// and the timeline guard. PGlite in a temp dir, demo AI, outbox mail, seed calendar
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { p } from "../lib/db.ts";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-urgent-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};

before(async () => {
  for (const name of [
    "session", "intake", "impact", "commitments/decide", "commitments/reopen", "commitments/timeline", "requests",
    "requests/[id]", "requests/approve", "requests/edit", "requests/redraft", "requests/send",
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

const approve = (requestId: string, revision: string, healthOverride = false) =>
  call("POST", "requests/approve", { body: { requestId, healthOverride }, headers: { "If-Match": `"${revision}"` } });

let episodeId = "";
let groupRequestIds: string[] = [];
let commitments: any[] = [];
const byTitle = (pattern: RegExp) => commitments.find((c) => pattern.test(c.title));

async function scan(): Promise<any[]> {
  const impact = await call("POST", "impact", { body: { episodeId } });
  assert.equal(impact.status, 200);
  commitments = impact.data.commitments;
  return commitments;
}

test("a crisis with a fall opens a care week", async () => {
  const intake = await call("POST", "intake", {
    body: { statement: "My mom Rosa had a bad fall and comes home tomorrow; I'll be helping her at home for a week." },
  });
  assert.equal(intake.status, 200);
  assert.equal(intake.data.result.status, "ready");
  episodeId = intake.data.episodeId;
  assert.ok(episodeId);
  await scan();
  assert.equal(commitments.length, 6);
});

test("recipient names come from the saved contacts, never from an email address", async () => {
  const assignment = byTitle(/assignment/i);
  assert.equal(assignment.contacts[0].name, "Dr. Avery Brooks");
  assert.equal(assignment.contacts[0].group, "School");
  assert.equal(assignment.suggestedContactId, assignment.contacts[0].contactId);
  const group = byTitle(/group project/i);
  const names = group.contacts.map((c: any) => c.name).sort();
  assert.deepEqual(names, ["Jordan Lee", "Sam Patel"]);
  assert.equal(group.suggestedContactIds.length, 2);
  assert.equal(group.suggestedContactIds[0], group.suggestedContactId);
  for (const dependency of group.dependencies) {
    if (dependency.contactId) assert.ok(["Jordan Lee", "Sam Patel"].includes(dependency.contactName));
  }
  // the owner is never a recipient
  assert.ok(group.contacts.every((c: any) => c.email !== "alex@example.test"));
});

test("a group commitment gets one request per person, each approved on its own revision", async () => {
  const group = byTitle(/group project/i);
  const both = await call("POST", "commitments/decide", {
    body: {
      commitmentId: group.id,
      decision: "reschedule",
      contactId: group.suggestedContactIds[0],
      contactIds: group.suggestedContactIds,
    },
  });
  assert.equal(both.status, 400, "contactId and contactIds together are refused");

  const decided = await call("POST", "commitments/decide", {
    body: { commitmentId: group.id, decision: "reschedule", contactIds: group.suggestedContactIds },
  });
  assert.equal(decided.status, 200);
  const [first, second] = decided.data.requests;
  assert.equal(decided.data.requests.length, 2);
  assert.equal(decided.data.drafts.length, 2);
  assert.equal(decided.data.request.id, first.id);
  groupRequestIds = [first.id, second.id];
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(
    decided.data.requests.map((r: any) => r.recipient.contactId),
    group.suggestedContactIds,
  );
  assert.ok(decided.data.requests.every((r: any) => r.state === "awaiting_approval"));
  assert.ok(first.body.startsWith(`Hi ${first.recipient.name.split(" ")[0]},`));

  const approved = await approve(first.id, first.revision);
  assert.equal(approved.status, 200);
  assert.equal(approved.data.request.state, "approved");
  const other = await call("GET", "requests/[id]", { params: { id: second.id } });
  assert.equal(other.data.request.state, "awaiting_approval");
  // the first message's revision never approves the second one
  assert.equal((await approve(second.id, first.revision)).status, 412);

  const again = await call("POST", "commitments/decide", {
    body: { commitmentId: group.id, decision: "reschedule", contactIds: group.suggestedContactIds },
  });
  assert.equal(again.status, 200);
  assert.ok(again.data.drafts.every((d: any) => d.existing === true));
  assert.deepEqual(again.data.requests.map((r: any) => r.id), [first.id, second.id]);

  // a contact that isn't the owner's is refused
  const foreign = await call("POST", "commitments/decide", {
    body: { commitmentId: group.id, decision: "reschedule", contactIds: ["00000000-0000-4000-8000-000000000000"] },
  });
  assert.equal(foreign.status, 404);
});

test("change the plan is saved on the server and survives a new scan, without touching requests", async () => {
  const group = byTitle(/group project/i);
  const statesOf = async () =>
    (await call("GET", "requests")).data.requests
      .filter((r: any) => groupRequestIds.includes(r.id))
      .map((r: any) => `${r.id}:${r.state}`)
      .sort();
  const before = await statesOf();
  assert.equal(before.length, 2);
  const foreign = await call("POST", "commitments/reopen", { body: { commitmentId: group.id }, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const missing = await call("POST", "commitments/reopen", { body: { commitmentId: "00000000-0000-4000-8000-000000000000" } });
  assert.equal(missing.status, 404);

  const reopened = await call("POST", "commitments/reopen", { body: { commitmentId: group.id } });
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.data.commitment, { id: group.id, decision: "reschedule", reopened: true });

  await scan();
  const after = byTitle(/group project/i);
  assert.equal(after.reopened, true);
  assert.equal(after.decision, "reschedule");
  assert.deepEqual(await statesOf(), before);
  assert.deepEqual(after.requests.map((l: any) => l.id).sort(), [...groupRequestIds].sort());

  // the next decision closes it again
  const kept = await call("POST", "commitments/decide", { body: { commitmentId: group.id, decision: "defer" } });
  assert.equal(kept.status, 200);
  await scan();
  assert.equal(byTitle(/group project/i).reopened, false);
});

test("the tier can be chosen per request; revision, hash and approval follow it", async () => {
  const shift = byTitle(/work shift/i);
  const decided = await call("POST", "commitments/decide", { body: { commitmentId: shift.id, decision: "coverage" } });
  const draft = decided.data.request;
  assert.equal(draft.disclosureTier, "general");
  assert.equal(draft.defaultDisclosureTier, "general");

  const bad = await call("POST", "requests/edit", { body: { requestId: draft.id, disclosureTier: "everything" } });
  assert.equal(bad.status, 400);

  const lowered = await call("POST", "requests/edit", { body: { requestId: draft.id, disclosureTier: "minimal" } });
  assert.equal(lowered.status, 200);
  assert.equal(lowered.data.request.disclosureTier, "minimal");
  assert.equal(lowered.data.request.defaultDisclosureTier, "general");
  assert.equal(lowered.data.request.state, "awaiting_approval");
  assert.notEqual(lowered.data.request.revision, draft.revision);
  assert.equal((await approve(draft.id, draft.revision)).status, 412);

  // a later body edit keeps the chosen tier instead of resetting it to the group's
  const body = `${lowered.data.request.body}\n\nThanks again.`;
  const edited = await call("POST", "requests/edit", { body: { requestId: draft.id, body } });
  assert.equal(edited.data.request.disclosureTier, "minimal");

  const ok = await approve(draft.id, edited.data.request.revision);
  assert.equal(ok.status, 200);
  const { approvalHash } = await import("../lib/state.ts");
  const view = ok.data.request;
  assert.equal(
    view.approval.hash,
    approvalHash({ recipientEmail: view.recipient.email, subject: view.subject, body: view.body, disclosureTier: "minimal" }),
  );
  const locked = await call("POST", "requests/edit", { body: { requestId: draft.id, disclosureTier: "detailed" } });
  assert.equal(locked.status, 409);

  const { getRuntime } = await import("../lib/mvp/runtime.ts");
  const rt = await getRuntime();
  const audit = await rt.stores.database.query<{ detail: string }>(
    "SELECT detail::text AS detail FROM audit_event WHERE action = 'disclosure_tier_change' AND entity_id = :id",
    [p.text("id", draft.id)],
  );
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].detail), { from: "general", to: "minimal" });
});

test("lowering the tier keeps the drafter's extra health terms enforced at approve", async () => {
  const dinner = byTitle(/family dinner/i);
  const decided = await call("POST", "commitments/decide", { body: { commitmentId: dinner.id, decision: "notify" } });
  const draft = decided.data.request;
  assert.equal(draft.disclosureTier, "detailed");
  assert.match(draft.body, /fall/);
  // the extra terms never reach the browser
  assert.equal("extraHealthTerms" in draft, false);

  const lowered = await call("POST", "requests/edit", { body: { requestId: draft.id, disclosureTier: "minimal" } });
  assert.ok(lowered.data.request.healthTermsFound.includes("fall"));
  const refused = await approve(draft.id, lowered.data.request.revision);
  assert.equal(refused.status, 422);
  assert.equal(refused.data.error.code, "health_terms");
  assert.ok(refused.data.error.terms.includes("fall"));
  const allowed = await approve(draft.id, lowered.data.request.revision, true);
  assert.equal(allowed.status, 200);
  const sent = await call("POST", "requests/send", { body: { requestId: draft.id } });
  assert.equal(sent.data.state, "requested");
});

test("a redraft writes the message for the chosen tier, and send checks the request's extra terms", async () => {
  const volunteer = byTitle(/volunteer/i);
  const decided = await call("POST", "commitments/decide", { body: { commitmentId: volunteer.id, decision: "notify" } });
  const draft = decided.data.request;
  assert.equal(draft.disclosureTier, "minimal");
  assert.doesNotMatch(draft.body, /fall/);

  const detailed = await call("POST", "requests/redraft", { body: { requestId: draft.id, disclosureTier: "detailed" } });
  assert.equal(detailed.status, 200);
  assert.equal(detailed.data.request.disclosureTier, "detailed");
  assert.equal(detailed.data.request.state, "awaiting_approval");
  assert.match(detailed.data.request.body, /fall/);
  assert.equal((await approve(draft.id, draft.revision)).status, 412);

  const minimal = await call("POST", "requests/redraft", { body: { requestId: draft.id, disclosureTier: "minimal" } });
  assert.doesNotMatch(minimal.data.request.body, /fall/);
  const ok = await approve(draft.id, minimal.data.request.revision);
  assert.equal(ok.status, 200);

  // a word that only the request's own extra list flags still stops the send
  const { getRuntime } = await import("../lib/mvp/runtime.ts");
  const rt = await getRuntime();
  await rt.stores.database.execute(
    "UPDATE request SET extra_health_terms = ARRAY['volunteer'] WHERE id = CAST(:id AS uuid)",
    [p.uuid("id", draft.id)],
  );
  const sent = await call("POST", "requests/send", { body: { requestId: draft.id } });
  assert.deepEqual(sent.data, { state: "needs_review" });
  const after = await call("GET", "requests/[id]", { params: { id: draft.id } });
  assert.equal(after.data.request.evidence[0].evidenceRef, "health term at send");

  const missing = await call("POST", "requests/redraft", {
    body: { requestId: "00000000-0000-4000-8000-000000000000", disclosureTier: "minimal" },
  });
  assert.equal(missing.status, 404);
});

test("only the care recipient's own appointments go on the care timeline", async () => {
  const shift = byTitle(/work shift/i);
  const refused = await call("POST", "commitments/timeline", { body: { commitmentId: shift.id } });
  assert.equal(refused.status, 422);
  assert.equal(refused.data.error.code, "not_care_recipient_event");
  const mom = byTitle(/mom follow-up/i);
  const added = await call("POST", "commitments/timeline", { body: { commitmentId: mom.id } });
  assert.equal(added.status, 200);
  assert.equal(added.data.created, true);
});

test("the urgent words never make a name up from an email address", async () => {
  const w = await import("../components/app/urgent/words.ts");
  const { createLiveApi } = await import("../lib/frontend/live-api.ts");
  // the browser schema parses what the server sent, so the helpers see the real shapes
  const impact = await createLiveApi(async () => Response.json({
    episode: { id: episodeId, startsOn: "2026-11-08", endsOn: "2026-11-14" },
    commitments,
    modelStatus: "ok",
  })).impact(episodeId);
  const dir = w.buildDirectory(impact.commitments, []);
  const assignment = impact.commitments.find((c) => /assignment/i.test(c.title))!;
  const person = dir.get(assignment.suggestedContactId!);
  assert.equal(person?.name, "Dr. Avery Brooks");
  assert.equal(w.shortName(person!.name), "Dr. Brooks");
  for (const entry of dir.values()) assert.ok(!entry.name.includes("@") && entry.name !== "Avery Brooks");

  const unknown = {
    ...assignment,
    contacts: [],
    dependencies: [{ ...assignment.dependencies[0], id: "d1", toRef: "pat.unknown@example.test", contactId: null, contactName: null, evidence: "", origin: "model", confirmed: false, toKind: "person" }],
  };
  assert.deepEqual(w.withNames(unknown, w.buildDirectory([unknown], [])), ["pat.unknown@example.test"]);
  assert.equal(w.shortName("pat.unknown@example.test"), "pat.unknown@example.test");
  assert.equal(w.tierLabel("general", "Mom"), "Say I’m caring for my mom");
  assert.equal(w.tierLabel("general", "Rosa"), "Say I’m caring for family");
  assert.equal(w.tierLabel("minimal", "Mom"), w.TIER_LABEL.minimal);
});
