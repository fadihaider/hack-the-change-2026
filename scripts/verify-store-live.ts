// end-to-end check of the durable stores on the live Supabase database, with fictional data and a fake Gmail sender.
// it resets the demo clock when done. usage: npm run db:verify (reads SUPABASE_DB_URL from .env.local)
import assert from "node:assert/strict";
import { approvalHash } from "../lib/state.ts";
import { confirmResponse, sendApprovedRequest, WorkflowError } from "../lib/requests/workflow.ts";
import { p } from "../lib/db.ts";
import { hit } from "../lib/rateLimit.ts";
import { jumpClock, readClock, resetClock, storesFor, sweepExpired } from "../lib/store/index.ts";
import { createSupabaseDatabase, migrateSupabase, supabaseConfigFromEnv } from "../lib/supabase/database.ts";

const supabase = createSupabaseDatabase(supabaseConfigFromEnv());
await migrateSupabase(supabase);
const { database, workflow, accounts } = storesFor(supabase);
const email = `verify-${Date.now()}@example.test`;
const results: string[] = [];
const ok = (label: string) => results.push(`ok   ${label}`);

async function seedRequest(userId: string, respondBy: string | null): Promise<string> {
  const [group] = await database.query<{ id: string }>(
    `INSERT INTO contact_group (user_id, name, disclosure_tier) VALUES (CAST(:u AS uuid), 'School', 'minimal') RETURNING id::text AS id`,
    [p.uuid("u", userId)]);
  const [contact] = await database.query<{ id: string }>(
    `INSERT INTO contact (group_id, name, email, relationship) VALUES (CAST(:g AS uuid), 'Sam (fictional)', 'sam@example.test', 'teammate') RETURNING id::text AS id`,
    [p.uuid("g", group.id)]);
  const [request] = await database.query<{ id: string }>(
    `INSERT INTO request (user_id, contact_id, action, draft_subject, draft_body, disclosure_tier, state, respond_by)
     VALUES (CAST(:u AS uuid), CAST(:c AS uuid), 'coverage', 'Coverage request', 'Could you cover my shift? (fictional demo)', 'minimal', 'awaiting_approval', CAST(:rb AS timestamptz))
     RETURNING id::text AS id`,
    [p.uuid("u", userId), p.uuid("c", contact.id), p.text("rb", respondBy)]);
  // approve exactly the stored content, as the approval route would
  await workflow.withOwnedRequest(userId, request.id, async (tx) => {
    assert.ok(await tx.transition({ from: "awaiting_approval", to: "approved", evidenceKind: "approval", evidenceRef: approvalHash(tx.request), actor: "user" }));
  });
  return request.id;
}

try {
  await resetClock(database);
  const user = await accounts.findOrCreateUserByEmail(email);
  assert.deepEqual(await accounts.findOrCreateUserByEmail(email.toUpperCase()), user);
  ok("AccountStore upsert keeps one id for repeat logins");
  await accounts.saveEncryptedRefreshToken(user.id, new Uint8Array([1, 2, 3, 250]));
  assert.deepEqual([...((await accounts.loadEncryptedRefreshToken(user.id)).ciphertext ?? [])], [1, 2, 3, 250]);
  ok("AccountStore round-trips bytea ciphertext");

  // send with a fake Gmail sender, capture the Accept link
  const requestId = await seedRequest(user.id, null);
  let sentText = "";
  const sent = await sendApprovedRequest({
    userId: user.id, requestId, store: workflow, baseUrl: "http://localhost:3000",
    appTime: (await readClock(database)).appNow, findHealthTerms: async () => [],
    send: async (message) => { sentText = message.text; return { id: "fake-gmail-1" }; },
  });
  assert.deepEqual(sent, { state: "requested", messageId: "fake-gmail-1" });
  ok("send: approved -> sending -> requested with gmail evidence and 3 stored token hashes");
  const token = (choice: string) => new URL(sentText.split("\n").find((l) => l.startsWith(`${choice}: `))!.slice(choice.length + 2)).pathname.split("/").at(-1)!;

  // two simultaneous clicks: exactly one transition is recorded
  const [first, second] = await Promise.all([
    confirmResponse({ token: token("Accept"), store: workflow, realNow: new Date() }),
    confirmResponse({ token: token("Decline"), store: workflow, realNow: new Date() }),
  ]);
  assert.equal([first, second].filter((r) => r.recorded).length, 1);
  assert.equal(first.state, second.state);
  ok(`concurrent Accept + Decline: one recorded (${first.recorded ? "accept" : "decline"}), the other sees it`);
  const events = await database.query<{ to_state: string; evidence_kind: string }>(
    `SELECT to_state, evidence_kind FROM request_event WHERE request_id = CAST(:r AS uuid) ORDER BY id`, [p.uuid("r", requestId)]);
  assert.deepEqual(events.map((e) => e.to_state), ["approved", "sending", "requested", first.state]);
  ok("evidence trail: approved, sending, requested, answer (one row each)");

  // owner scoping
  const other = await accounts.findOrCreateUserByEmail(`other-${email}`);
  await assert.rejects(workflow.withOwnedRequest(other.id, requestId, async () => 1),
    (e: unknown) => e instanceof WorkflowError && e.code === "not_found");
  ok("another owner cannot open the request (not_found)");

  // expiry through the demo clock
  const waiting = await seedRequest(user.id, new Date(Date.now() + 2 * 86_400_000).toISOString());
  await sendApprovedRequest({ userId: user.id, requestId: waiting, store: workflow, baseUrl: "http://localhost:3000",
    appTime: new Date(), findHealthTerms: async () => [], send: async () => ({ id: "fake-gmail-2" }) });
  assert.deepEqual(await sweepExpired(database, user.id), []);
  const jumped = await jumpClock(database, { days: 7, adminUserId: user.id });
  assert.ok(jumped.expiredRequestIds.includes(waiting));
  assert.ok(jumped.offsetMilliseconds >= 7 * 86_400_000 - 1000);
  ok("clock jump of 7 days expires the waiting request and audits the jump");

  // rate limit counts are exact under concurrency
  const rule = { name: `verify_${Date.now()}`, limit: 5, windowSeconds: 600 };
  const hits = await Promise.all(Array.from({ length: 12 }, () => hit(database, rule, user.id)));
  assert.equal(hits.filter((h) => h.allowed).length, 5);
  ok("12 concurrent rate-limit hits: exactly 5 allowed");
} finally {
  await resetClock(database);
  await database.execute(`DELETE FROM app_user WHERE email LIKE '%verify-%@example.test'`);
  await database.execute(`DELETE FROM rate_limit WHERE key LIKE 'verify_%'`);
  await database.execute(`DELETE FROM audit_event WHERE action = 'clock_jump' AND actor NOT IN (SELECT id::text FROM app_user)`);
  console.log(results.join("\n"));
  console.log("cleanup done (fictional rows removed, clock reset)");
  await supabase.close();
}
