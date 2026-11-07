import assert from "node:assert/strict";
import test from "node:test";
import type { Account, Profile } from "next-auth";
import type { JWT } from "next-auth/jwt";
import {
  createGoogleAuthCallbacks, googleAccountLoader, GOOGLE_AUTHORIZATION_PARAMS, SAFE_AUTH_LOGGER,
} from "../lib/auth/google.ts";
import type { AccountStore } from "../lib/auth/google.ts";
import { decryptRefreshToken, encryptRefreshToken } from "../lib/crypto.ts";
import { GOOGLE_SCOPES } from "../lib/google.ts";
import { WorkflowError } from "../lib/requests/workflow.ts";

const key = Buffer.alloc(32, 9).toString("base64");
const email = "fictional@example.com";
const appId = "fixture-app-user";
const profile = { sub: "google-subject", email, email_verified: true, name: "Alex (fictional)" };
const account: Account = {
  provider: "google", providerAccountId: profile.sub, type: "oauth", scope: GOOGLE_SCOPES.join(" "),
  access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", id_token: "fixture-id-secret",
};

function fixture() {
  let ciphertext: Uint8Array | null = null;
  const writes: Array<{ userId: string; ciphertext: Uint8Array }> = [];
  const lookups: string[] = [];
  const loads: string[] = [];
  const store: AccountStore = {
    async findOrCreateUserByEmail(value) { lookups.push(value); return { id: appId }; },
    async loadEncryptedRefreshToken(userId) { loads.push(userId); return { email, ciphertext }; },
    async saveEncryptedRefreshToken(userId, bytes) { ciphertext = bytes; writes.push({ userId, ciphertext: bytes }); },
  };
  const callbacks = createGoogleAuthCallbacks({ store, encryptionKey: key });
  function signin(changes: { account?: Account | null; profile?: Profile } = {}) {
    return callbacks.signIn({ user: { id: "provider-user", email }, account, profile, ...changes });
  }
  async function jwt(changes: { account?: Account | null; profile?: Profile; token?: JWT; trigger?: "update"; session?: unknown } = {}) {
    return callbacks.jwt({ token: {}, user: { id: "provider-user", email }, account, profile, ...changes });
  }
  function session(token: JWT) {
    const inputSession = { expires: "2026-11-08T17:30:00Z", user: { email: "untrusted@example.com" }, secret: "fixture-session-secret" };
    return callbacks.session({
      session: inputSession, token,
      user: { id: "provider-user", email, emailVerified: null }, newSession: {}, trigger: "update",
    });
  }
  return { store, callbacks, writes, lookups, loads, signin, jwt, session, setCiphertext(value: Uint8Array | null) { ciphertext = value; } };
}

test("Google authorization requests only the agreed identity, Calendar-read and Gmail-send scopes", () => {
  assert.deepEqual(GOOGLE_AUTHORIZATION_PARAMS, {
    scope: "openid email profile https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/gmail.send",
    access_type: "offline", prompt: "consent",
  });
});

test("sign-in requires a verified matching Google identity and all grants before persistence", async () => {
  const f = fixture();
  assert.equal(await f.signin(), true);
  for (const change of [
    { account: null }, { account: { ...account, provider: "other" } },
    { account: { ...account, providerAccountId: "other-subject" } },
    { profile: { ...profile, email_verified: false } },
    { profile: { ...profile, email_verified: "true" } },
    { profile: { ...profile, email: "victim@example.com,attacker@example.com" } },
    { profile: undefined }, { account: { ...account, scope: "openid email profile" } },
  ]) {
    assert.equal(await f.signin(change), false);
    await assert.rejects(f.jwt(change), { message: change.account === null ? "invalid_session" : "google_signin_denied" });
  }
  assert.equal(f.lookups.length + f.writes.length, 0);
});

test("Google's canonical userinfo scope aliases are accepted without broader permissions", async () => {
  const f = fixture();
  const aliased = { ...account, scope: account.scope!.replace("email profile", "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile") };
  assert.equal(await f.signin({ account: aliased }), true);
  for (const scope of GOOGLE_SCOPES) {
    assert.equal(await f.signin({ account: { ...account, scope: GOOGLE_SCOPES.filter((value) => value !== scope).join(" ") } }), false);
  }
});

test("first sign-in saves owner-bound bytea ciphertext and returns an identity-only JWT", async () => {
  const f = fixture();
  const token = await f.jwt({ profile: { ...profile, email: email.toUpperCase() }, token: { access_token: "fixture-input-secret" } });
  assert.deepEqual(f.lookups, [email]);
  assert.deepEqual(token, { sub: appId, appUserId: appId, email, name: profile.name });
  assert.equal(f.writes[0].userId, appId);
  assert.ok(f.writes[0].ciphertext instanceof Uint8Array);
  const encoded = Buffer.from(f.writes[0].ciphertext).toString("base64");
  assert.equal(decryptRefreshToken(encoded, appId, key), account.refresh_token);
  assert.throws(() => decryptRefreshToken(encoded, "other-owner", key));
  assert.equal(Buffer.from(f.writes[0].ciphertext).includes(Buffer.from(account.refresh_token!)), false);
  assert.equal(f.loads.length, 0);
});

test("repeat sign-in preserves existing refresh credentials when Google omits one", async () => {
  const f = fixture();
  const first = await f.jwt();
  const saved = f.writes[0].ciphertext;
  assert.deepEqual(await f.jwt({ account: { ...account, refresh_token: undefined } }), first);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.loads, [appId]);
  assert.equal(f.writes[0].ciphertext, saved);
});

test("missing, corrupted or differently bound saved tokens require reauthentication", async () => {
  for (const ciphertext of [
    null, new Uint8Array([1, 2, 3]),
    new Uint8Array(Buffer.from(encryptRefreshToken("fixture-saved-secret", "other-owner", key), "base64")),
  ]) {
    const f = fixture();
    f.setCiphertext(ciphertext);
    await assert.rejects(f.jwt({ account: { ...account, refresh_token: undefined } }), { message: "google_reauth_required" });
    assert.equal(f.writes.length, 0);
  }
});

test("fresh consent rotates encryption with a new IV while retaining the stable user id", async () => {
  const f = fixture();
  assert.deepEqual(await f.jwt(), await f.jwt());
  assert.equal(f.writes.length, 2);
  assert.notDeepEqual(f.writes[0].ciphertext, f.writes[1].ciphertext);
  assert.deepEqual(f.lookups, [email, email]);
});

test("persistence errors are sanitized and failed saves cannot yield a connected JWT", async () => {
  for (const method of ["findOrCreateUserByEmail", "saveEncryptedRefreshToken", "loadEncryptedRefreshToken"] as const) {
    const f = fixture();
    f.store[method] = async () => { throw new Error("fixture-database-secret/fictional@example.com"); };
    await assert.rejects(f.jwt({ account: method === "loadEncryptedRefreshToken" ? { ...account, refresh_token: undefined } : account }), { message: "auth_store_failed" });
  }
});

test("client session updates cannot replace the signed identity or add Google tokens", async () => {
  const f = fixture();
  const original = await f.jwt();
  const token = await f.jwt({
    account: null, token: { ...original, access_token: "fixture-poisoned-secret", picture: "fixture-url" }, trigger: "update",
    session: { sub: "other-owner", appUserId: "other-owner", email: "attacker@example.com", refresh_token: "fixture-update-secret" },
  });
  assert.deepEqual(token, original);
  assert.deepEqual(await f.session(token), { expires: "2026-11-08T17:30:00Z", user: { id: appId, email, name: profile.name } });
  assert.equal(f.lookups.length, 1);
});

test("a default provider token or mismatched app identity cannot become an app session", async () => {
  const f = fixture();
  for (const token of [{ sub: profile.sub, email }, { sub: "other-owner", appUserId: appId, email }, { sub: appId, appUserId: appId }]) {
    await assert.rejects(f.jwt({ account: null, token }), { message: "invalid_session" });
    assert.throws(() => f.session(token), { message: "invalid_session" });
  }
});

test("server-only account loader decrypts the same bytea ciphertext for Google transport", async () => {
  const f = fixture();
  await f.jwt();
  const load = googleAccountLoader({ store: f.store, encryptionKey: key });
  assert.deepEqual(await load(appId), { email, refreshToken: account.refresh_token });
  await assert.rejects(load("other-owner"), { message: "google_reauth_required" });
  f.setCiphertext(null);
  await assert.rejects(load(appId), { message: "google_reauth_required" });
});

test("account lookup failures and auth diagnostics never expose raw provider or database metadata", async () => {
  const f = fixture();
  const load = googleAccountLoader({ store: f.store, encryptionKey: key });
  f.store.loadEncryptedRefreshToken = async () => { throw new WorkflowError("not_found"); };
  await assert.rejects(load(appId), { message: "google_reauth_required" });
  f.store.loadEncryptedRefreshToken = async () => { throw new Error("fixture-store-secret"); };
  await assert.rejects(load(appId), { message: "google_request_failed" });
  const logged: unknown[][] = [];
  const original = { error: console.error, warn: console.warn };
  try {
    console.error = (...args) => { logged.push(args); };
    console.warn = (...args) => { logged.push(args); };
    SAFE_AUTH_LOGGER.error!("OAUTH_CALLBACK_ERROR", { error: new Error("fixture-provider-secret"), secret: "fixture-provider-secret" });
    SAFE_AUTH_LOGGER.warn!("NO_SECRET");
    SAFE_AUTH_LOGGER.debug!("fixture-debug-secret", { secret: "fixture-provider-secret" });
  } finally { console.error = original.error; console.warn = original.warn; }
  assert.deepEqual(logged, [["auth_failed"], ["auth_warning"]]);
});

test("an absent encryption key fails before any account storage operation", () => {
  const f = fixture();
  assert.throws(() => createGoogleAuthCallbacks({ store: f.store, encryptionKey: "" }), { message: "auth_not_configured" });
  assert.equal(f.lookups.length, 0);
});
