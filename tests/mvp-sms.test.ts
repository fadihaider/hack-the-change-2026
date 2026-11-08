import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { p } from "../lib/db.ts";
import { checkSmsText, smsDrafterPayload } from "../lib/ai/smsDrafter.ts";
import { demoCaller } from "../lib/ai/demoCaller.ts";
import { runSmsDrafter } from "../lib/ai/smsDrafter.ts";
import { findHealthTerms } from "../lib/healthTerms.ts";
import { createPgliteDatabase, type PgliteDatabase } from "../lib/mvp/database.ts";
import { DEMO_EMAIL } from "../lib/mvp/seed.ts";
import { WorkflowError } from "../lib/requests/workflow.ts";
import { maskPhone, normalizePhone, smsParts } from "../lib/sms/phone.ts";
import {
  createDemoSmsProvider, createTwilioProvider, smsMode, SmsSendError, twilioConfig, type SmsProvider,
} from "../lib/sms/provider.ts";
import { createSmsStore, type NewSms } from "../lib/sms/workflow.ts";
import { HealthTermsError } from "../lib/store/requestQueue.ts";
import { createRequestQueue } from "../lib/store/requestQueue.ts";

let dir: string;
let db: PgliteDatabase;
let userId: string;
let keyCount = 0;

const PHONE = "+14035550123";
const SID = `SM${"a".repeat(32)}`;
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "test-token-0123456789",
  TWILIO_PHONE_NUMBER: "+15875550100",
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "rr-sms-"));
  db = await createPgliteDatabase(dir);
  const users = await db.query<{ id: string }>("SELECT id::text AS id FROM app_user WHERE email = :email", [p.text("email", DEMO_EMAIL)]);
  userId = users[0].id;
});

after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

function draft(overrides: Partial<NewSms> = {}): NewSms {
  keyCount += 1;
  return {
    userId,
    clientKey: `test-key-${String(keyCount).padStart(8, "0")}`,
    episodeId: null,
    phone: PHONE,
    label: "Test phone",
    senderName: "Rosa",
    body: "Hi Sam, I'm dealing with a family matter and won't be available this week. - Rosa",
    tier: "minimal",
    healthOverride: false,
    extraHealthTerms: [],
    findHealthTerms,
    ...overrides,
  };
}

/** a fake Twilio: records each call and answers from a script */
function fakeTwilio(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = createTwilioProvider(twilioConfig(TWILIO_ENV), async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  });
  return { provider, calls };
}

const twilioJson = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function events(requestId: string) {
  return db.query<{ from_state: string | null; to_state: string; evidence_kind: string; evidence_ref: string | null }>(
    `SELECT from_state, to_state, evidence_kind, evidence_ref FROM request_event WHERE request_id = CAST(:id AS uuid) ORDER BY id`,
    [p.uuid("id", requestId)]);
}

test("phone numbers: North American formats become E.164, everything else is refused, and masks hide the number", () => {
  for (const input of ["403-555-0123", "(403) 555 0123", "1 403 555 0123", "+1 403.555.0123", "4035550123"]) {
    assert.equal(normalizePhone(input), PHONE, input);
  }
  for (const input of ["555-0123", "+44 20 7946 0958", "123-555-0123", "403-155-0123", "call 403 555 0123", ""]) {
    assert.equal(normalizePhone(input), null, input);
  }
  assert.equal(maskPhone(PHONE), "(•••) •••-0123");
  assert.deepEqual(smsParts("a".repeat(160)), { encoding: "gsm", chars: 160, parts: 1 });
  assert.deepEqual(smsParts("a".repeat(161)), { encoding: "gsm", chars: 161, parts: 2 });
  assert.equal(smsParts("Thanks 🙏").encoding, "unicode");
});

test("RR_SMS: blank picks Twilio only with all three settings, demo otherwise", () => {
  assert.equal(smsMode({}), "demo");
  assert.equal(smsMode(TWILIO_ENV), "twilio");
  assert.equal(smsMode({ ...TWILIO_ENV, TWILIO_AUTH_TOKEN: "" }), "demo");
  assert.equal(smsMode({ ...TWILIO_ENV, RR_SMS: "demo" }), "demo");
  assert.equal(smsMode({ RR_SMS: "twilio" }), "twilio");
  assert.throws(() => smsMode({ RR_SMS: "carrier-pigeon" }));
  assert.equal(twilioConfig({ ...TWILIO_ENV, TWILIO_PHONE_NUMBER: "(587) 555-0100" }), null, "From must be E.164");
});

test("the sms drafter sees the reason only at detailed, and its checks flag health words, links and numbers", async () => {
  const base = {
    senderName: "Rosa", recipientName: "Sam", note: "Back on the 15th.", unavailableFrom: "2026-11-09",
    unavailableUntil: "2026-11-15", relationship: "my mother", reasonText: "mom has hip surgery",
  };
  assert.equal(smsDrafterPayload({ ...base, tier: "minimal" }).reasonText, null);
  assert.equal(smsDrafterPayload({ ...base, tier: "minimal" }).relationship, null);
  assert.equal(smsDrafterPayload({ ...base, tier: "detailed" }).reasonText, "mom has hip surgery");
  assert.equal(smsDrafterPayload({ ...base, tier: "general" }).unavailableFrom, "Monday, November 9");

  const demo = await runSmsDrafter({ ...base, tier: "minimal" }, { caller: demoCaller, model: "demo" });
  assert.match(demo.text, /^Hi Sam, .*family matter.*Monday, November 9.*- Rosa$/);
  assert.deepEqual(demo.healthTermsFound, []);

  const checked = checkSmsText("Mom has surgery, see https://x.example.com or call 403 555 0123", "minimal", []);
  assert.ok(checked.approvalBlocked);
  assert.ok(checked.editFlags.includes("url") && checked.editFlags.includes("phone"));
  assert.equal(checkSmsText("Mom has surgery", "detailed", []).approvalBlocked, false, "detailed only warns");
});

test("approval records the exact text and number; a repeat click with the same key returns the same row", async () => {
  const store = createSmsStore(db);
  const input = draft();
  const first = await store.createApproved(input);
  const again = await store.createApproved(input);
  assert.equal(again.id, first.id);
  assert.equal(first.state, "approved");
  assert.equal(first.delivery, "not_sent");
  assert.equal(first.recipient.phoneMasked, "(•••) •••-0123");
  assert.ok(!JSON.stringify(first).includes("5550123"), "the full number never goes back to the browser");
  // the same key with different words is refused rather than silently approving them
  await assert.rejects(store.createApproved({ ...input, body: "different words" }), (e: unknown) => e instanceof WorkflowError && e.code === "state_conflict");
  const trail = await events(first.id);
  assert.deepEqual(trail.map((e) => `${e.from_state}->${e.to_state}:${e.evidence_kind}`), [
    "draft->awaiting_approval:user_manual",
    "awaiting_approval->approved:approval",
  ]);
  assert.match(trail[1].evidence_ref ?? "", /^[a-f0-9]{64}$/);
  // email lists never include texts (they join contact)
  const emails = await createRequestQueue(db).list(userId);
  assert.ok(!emails.some((r) => r.id === first.id));
});

test("health words hold a minimal text back unless the owner sends it anyway", async () => {
  const store = createSmsStore(db);
  await assert.rejects(store.createApproved(draft({ body: "Mom is having hip surgery this week." })), (e: unknown) => e instanceof HealthTermsError);
  const anyway = await store.createApproved(draft({ body: "Mom is having hip surgery this week.", healthOverride: true }));
  assert.equal(anyway.state, "approved");
  assert.ok(anyway.healthOverride);
});

test("twilio send: submitted with the message SID as evidence, then delivered from the status check", async () => {
  const store = createSmsStore(db);
  const text = await store.createApproved(draft());
  let status = "queued";
  const { provider, calls } = fakeTwilio((url, init) => {
    if (init.method === "POST") return twilioJson({ sid: SID, status: "queued" });
    return twilioJson({ sid: SID, status, error_code: null }, 200);
  });
  const sent = await store.send({ userId, requestId: text.id, provider, extraHealthTerms: [], findHealthTerms });
  assert.equal(sent.state, "requested");
  assert.equal(sent.delivery, "submitted");
  assert.equal(sent.providerMessageId, SID);
  assert.ok(sent.submittedAt);
  const post = calls[0];
  assert.match(post.url, /\/Accounts\/AC0{32}\/Messages\.json$/);
  const form = new URLSearchParams(String(post.init.body));
  assert.equal(form.get("To"), PHONE);
  assert.equal(form.get("From"), "+15875550100");
  assert.equal(form.get("Body"), text.body);
  assert.match(String((post.init.headers as Record<string, string>).Authorization), /^Basic /);

  // a second click: no longer approved, and Twilio is not called again
  await assert.rejects(store.send({ userId, requestId: text.id, provider, extraHealthTerms: [], findHealthTerms }),
    (e: unknown) => e instanceof WorkflowError && e.code === "state_conflict");
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);

  status = "sent";
  await db.execute("UPDATE request SET sms_status_at = now() - interval '1 minute' WHERE id = CAST(:id AS uuid)", [p.uuid("id", text.id)]);
  await store.refresh(userId, provider);
  assert.equal((await store.list(userId, null)).find((t) => t.id === text.id)?.delivery, "sent");

  status = "delivered";
  await db.execute("UPDATE request SET sms_status_at = now() - interval '1 minute' WHERE id = CAST(:id AS uuid)", [p.uuid("id", text.id)]);
  assert.equal(await store.refresh(userId, provider), 1);
  const done = (await store.list(userId, null)).find((t) => t.id === text.id)!;
  assert.equal(done.state, "completed");
  assert.equal(done.delivery, "delivered");
  const trail = (await events(text.id)).map((e) => `${e.to_state}:${e.evidence_kind}:${e.evidence_ref}`);
  assert.ok(trail.includes(`requested:sms_message_sid:${SID}`));
  assert.ok(trail.includes("requested:sms_status:sent"));
  assert.ok(trail.includes("completed:sms_status:delivered"));
});

test("twilio refusal is failed with a safe code; undelivered is failed; a timeout stays sending and is not re-sent", async () => {
  const store = createSmsStore(db);

  const refused = await store.createApproved(draft());
  const bad = fakeTwilio(() => twilioJson({ code: 21211, message: "The 'To' number +14035550123 is not valid", status: 400 }, 400));
  const failed = await store.send({ userId, requestId: refused.id, provider: bad.provider, extraHealthTerms: [], findHealthTerms });
  assert.equal(failed.state, "failed");
  assert.equal(failed.delivery, "failed");
  assert.equal(failed.errorCode, "twilio_21211");
  assert.ok(!JSON.stringify(await events(refused.id)).includes("not valid"), "provider text is never stored");

  const lost = await store.createApproved(draft());
  const undelivered = fakeTwilio((url, init) =>
    init.method === "POST" ? twilioJson({ sid: SID.replace("a", "b"), status: "queued" }) : twilioJson({ status: "undelivered", error_code: 30003 }, 200));
  await store.send({ userId, requestId: lost.id, provider: undelivered.provider, extraHealthTerms: [], findHealthTerms });
  await db.execute("UPDATE request SET sms_status_at = now() - interval '1 minute' WHERE id = CAST(:id AS uuid)", [p.uuid("id", lost.id)]);
  await store.refresh(userId, undelivered.provider);
  const lostView = (await store.list(userId, null)).find((t) => t.id === lost.id)!;
  assert.equal(lostView.delivery, "failed");
  assert.equal(lostView.errorCode, "twilio_30003");

  const timeout = await store.createApproved(draft());
  const hung = fakeTwilio(() => { throw new DOMException("timed out", "TimeoutError"); });
  const unsure = await store.send({ userId, requestId: timeout.id, provider: hung.provider, extraHealthTerms: [], findHealthTerms });
  assert.equal(unsure.state, "sending");
  assert.equal(unsure.delivery, "unconfirmed");
  await assert.rejects(store.send({ userId, requestId: timeout.id, provider: hung.provider, extraHealthTerms: [], findHealthTerms }),
    (e: unknown) => e instanceof WorkflowError);
  assert.equal(hung.calls.length, 1);
});

test("demo sends go to the sms outbox and are reported as simulated, never delivered", async () => {
  const store = createSmsStore(db);
  const text = await store.createApproved(draft());
  const demo: SmsProvider = createDemoSmsProvider(db);
  const sent = await store.send({ userId, requestId: text.id, provider: demo, extraHealthTerms: [], findHealthTerms });
  assert.equal(sent.state, "requested");
  assert.equal(sent.delivery, "simulated");
  assert.equal(sent.provider, "demo");
  assert.match(sent.providerMessageId ?? "", /^demo_/);
  const [stored] = await db.query<{ to_phone: string; body: string }>(
    "SELECT to_phone, body FROM sms_outbox WHERE request_id = CAST(:id AS uuid)", [p.uuid("id", text.id)]);
  assert.equal(stored.to_phone, PHONE);
  assert.equal(stored.body, text.body);
  assert.equal(await store.refresh(userId, demo), 0);
});

test("a changed text after approval is held for review instead of sent", async () => {
  const store = createSmsStore(db);
  const text = await store.createApproved(draft());
  await db.execute("UPDATE request SET draft_body = 'swapped words' WHERE id = CAST(:id AS uuid)", [p.uuid("id", text.id)]);
  const { provider, calls } = fakeTwilio(() => twilioJson({ sid: SID, status: "queued" }));
  const held = await store.send({ userId, requestId: text.id, provider, extraHealthTerms: [], findHealthTerms });
  assert.equal(held.state, "needs_review");
  assert.equal(calls.length, 0);
});

test("another owner cannot read, approve into or send someone else's text", async () => {
  const store = createSmsStore(db);
  const text = await store.createApproved(draft());
  const [other] = await db.query<{ id: string }>(
    "INSERT INTO app_user (email) VALUES ('other-sms@example.test') RETURNING id::text AS id");
  assert.equal((await store.list(other.id, null)).length, 0);
  await assert.rejects(store.send({ userId: other.id, requestId: text.id, provider: createDemoSmsProvider(db), extraHealthTerms: [], findHealthTerms }),
    (e: unknown) => e instanceof WorkflowError && e.code === "not_found");
  assert.ok(new SmsSendError("x", true) instanceof Error);
});
