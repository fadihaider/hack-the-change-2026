import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encryptRefreshToken, decryptRefreshToken } from "../lib/crypto.ts";
import { googleClient, GOOGLE_SCOPES } from "../lib/google.ts";

test("refresh tokens use random IVs, authenticated encryption and owner-bound AAD", () => {
  const key = randomBytes(32).toString("base64");
  const first = encryptRefreshToken("fixture-refresh-token", "user-1", key);
  const second = encryptRefreshToken("fixture-refresh-token", "user-1", key);
  assert.notEqual(first, second);
  assert.equal(decryptRefreshToken(first, "user-1", key), "fixture-refresh-token");
  assert.throws(() => decryptRefreshToken(first, "other-user", key));
  assert.throws(() => decryptRefreshToken(first, "user-1", randomBytes(32).toString("base64")));
  const tampered = Buffer.from(first, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptRefreshToken(tampered.toString("base64"), "user-1", key));
  assert.throws(() => encryptRefreshToken("fixture", "user-1", "bad-key"));
});

test("Google scopes stay send-only and Calendar read-only", () => {
  assert.deepEqual(GOOGLE_SCOPES, [
    "openid", "email", "profile",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
});

function googleFixture(replies: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const owners: string[] = [];
  const client = googleClient({
    clientId: "fixture-client-id", clientSecret: "fixture-client-secret",
    async loadAccount(userId) { owners.push(userId); return { email: "sender@example.test", refreshToken: "fixture-refresh-token" }; },
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      const response = replies.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    }) as typeof fetch,
  });
  return { client, calls, owners };
}

test("Gmail composes text MIME through the patched Nodemailer version", async () => {
  const f = googleFixture([Response.json({ access_token: "fixture-access-token" }), Response.json({ id: "gmail-123" })]);
  assert.deepEqual(await f.client.send({ userId: "user-1", to: "recipient@example.test", subject: "Coverage", text: "Please confirm:\nhttps://app.example.test/r/fixture" }), { id: "gmail-123" });
  assert.deepEqual(f.owners, ["user-1"]);
  assert.equal(f.calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal((f.calls[0].init?.body as URLSearchParams).get("grant_type"), "refresh_token");
  assert.equal(f.calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(f.calls[1].init?.method, "POST");
  const payload = JSON.parse(f.calls[1].init?.body as string);
  const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
  assert.match(mime, /From: sender@example.test/i);
  assert.match(mime, /To: recipient@example.test/i);
  assert.match(mime, /Content-Type: text\/plain/i);
  assert.doesNotMatch(mime, /Content-Type: text\/html/i);
  assert.match(mime, /https:\/\/app.example.test\/r\/fixture/);
  assert.equal(new Headers(f.calls[1].init?.headers).get("Authorization"), "Bearer fixture-access-token");
});

test("recipient/header injection cannot create additional recipients", async () => {
  for (const to of ["recipient@example.test,other@example.test", "recipient@example.test\r\nBcc: other@example.test"]) {
    const f = googleFixture([]);
    await assert.rejects(f.client.send({ userId: "user-1", to, subject: "Coverage", text: "fixture" }), /Invalid recipient/);
    assert.equal(f.calls.length, 0);
  }
});

test("revoked tokens and failed Gmail requests expose only stable error codes", async () => {
  const revoked = googleFixture([Response.json({ error: "invalid_grant", error_description: "fixture-secret" }, { status: 400 })]);
  await assert.rejects(revoked.client.send({ userId: "user-1", to: "recipient@example.test", subject: "Coverage", text: "fixture" }), { message: "google_reauth_required" });
  assert.equal(revoked.calls.length, 1);
  const failed = googleFixture([Response.json({ access_token: "fixture-access-token" }), new Response("fixture-secret", { status: 503 })]);
  await assert.rejects(failed.client.send({ userId: "user-1", to: "recipient@example.test", subject: "Coverage", text: "fixture" }), { message: "google_request_failed" });
  assert.equal(failed.calls.length, 2);
});

test("Calendar expands recurring events, paginates and preserves incomplete attendees", async () => {
  const first = { id: "event-1", location: "Public building", attendeesOmitted: true, attendees: [{ email: "other@example.test", responseStatus: "accepted" }] };
  const second = { id: "event-2", start: { date: "2026-11-09" } };
  const f = googleFixture([
    Response.json({ access_token: "fixture-access-token" }),
    Response.json({ items: [first], nextPageToken: "page-2" }), Response.json({ items: [second] }),
  ]);
  const events = await f.client.listEvents({ userId: "user-1", startsAt: new Date("2026-11-07T00:00:00Z"), endsAt: new Date("2026-11-14T00:00:00Z"), calendarId: "team@example.test" });
  assert.deepEqual(events, [first, second]);
  assert.equal(f.calls.length, 3);
  const url = new URL(f.calls[1].url);
  assert.match(url.pathname, /team%40example.test\/events$/);
  assert.equal(url.searchParams.get("singleEvents"), "true");
  assert.equal(url.searchParams.get("orderBy"), "startTime");
  assert.equal(new URL(f.calls[2].url).searchParams.get("pageToken"), "page-2");
});
