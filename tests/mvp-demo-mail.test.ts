// the demo copy: every sent email also goes to DEMO_EMAIL_TO, and a failed copy never fails the send
import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCopyConfig, withDemoCopy, type CopySender, type MailSender } from "../lib/mvp/mail.ts";

const env = { DEMO_EMAIL_TO: "demo@example.test", DEMO_SMTP_USER: "sender@example.test", DEMO_SMTP_PASS: "abcd efgh ijkl mnop" };
const message = { userId: "u1", to: "contact@example.test", subject: "Update about volunteering", text: "Hi Sam,\n\nThanks." };
const outbox: MailSender = { send: async () => ({ id: "outbox-1" }) };

test("the copy is off unless all three settings are present and valid", () => {
  assert.deepEqual(demoCopyConfig(env), { to: "demo@example.test", user: "sender@example.test", pass: "abcdefghijklmnop" });
  assert.equal(demoCopyConfig({}), null);
  assert.equal(demoCopyConfig({ ...env, DEMO_SMTP_PASS: "short" }), null);
  assert.equal(demoCopyConfig({ ...env, DEMO_EMAIL_TO: "not an address" }), null);
  assert.equal(withDemoCopy(outbox, null), outbox);
});

test("every send also emails the demo inbox, headed with the real recipient", async () => {
  const copies: Parameters<CopySender>[0][] = [];
  const mailer = withDemoCopy(outbox, demoCopyConfig(env), async (copy) => copies.push(copy));
  assert.deepEqual(await mailer.send(message), { id: "outbox-1" });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].to, "demo@example.test");
  assert.equal(copies[0].from, "ReliefReady demo <sender@example.test>");
  assert.equal(copies[0].subject, message.subject);
  assert.match(copies[0].text, /^\[ReliefReady demo copy\. This message was sent to contact@example\.test\.\]\n\nHi Sam,/);
});

test("a failed copy keeps the send, and a failed send sends no copy", async () => {
  const failing: CopySender = async () => {
    throw new Error("smtp down");
  };
  const mailer = withDemoCopy(outbox, demoCopyConfig(env), failing);
  assert.deepEqual(await mailer.send(message), { id: "outbox-1" });

  let copied = false;
  const broken: MailSender = { send: async () => Promise.reject(new Error("outbox down")) };
  const guarded = withDemoCopy(broken, demoCopyConfig(env), async () => (copied = true));
  await assert.rejects(guarded.send(message), /outbox down/);
  assert.equal(copied, false);
});
