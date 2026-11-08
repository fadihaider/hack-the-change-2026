import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseError, p, type Database, type Param, type SqlRunner } from "../lib/db.ts";
import { translateNamedParams } from "../lib/sql.ts";
import { createSupabaseDatabase, supabaseConfigFromEnv } from "../lib/supabase/database.ts";
import { createWorkflowStore } from "../lib/store/workflowStore.ts";
import { createAccountStore } from "../lib/store/accountStore.ts";
import { WorkflowError } from "../lib/requests/workflow.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";

// ---------- Supabase adapter, offline ----------

test("supabase config needs SUPABASE_DB_URL and never guesses one", () => {
  assert.throws(() => supabaseConfigFromEnv({}), (e: unknown) => e instanceof DatabaseError && e.code === "not_configured");
  const config = supabaseConfigFromEnv({ SUPABASE_DB_URL: " postgresql://u:pw@db.example.test:5432/postgres " });
  assert.equal(config.connectionString, "postgresql://u:pw@db.example.test:5432/postgres");
  assert.equal(config.caCert, null);
  assert.equal(config.poolMax, 5);
  const pem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
  const pinned = supabaseConfigFromEnv({ SUPABASE_DB_URL: "postgresql://x", SUPABASE_DB_CA_CERT: pem, SUPABASE_DB_POOL_MAX: "2" });
  assert.equal(pinned.caCert, pem);
  assert.equal(pinned.poolMax, 2);
});

test("node-postgres placeholders carry the parameter type, so both adapters resolve SQL alike", () => {
  const out = translateNamedParams(
    "SELECT CAST(:id AS uuid), :n + 1, :flag, :missing IS NULL, :id::text, ':skip' AS lit, x::int",
    [p.uuid("id", "abc"), p.int("n", 2), p.bool("flag", true), p.text("missing", null)],
    { castPlaceholders: true },
  );
  assert.equal(out.text, "SELECT CAST($1::text AS uuid), $2::int8 + 1, $3::bool, $4 IS NULL, $1::text::text, ':skip' AS lit, x::int");
  assert.deepEqual(out.values, ["abc", 2, true, null]);
});

test("an unreachable database is DatabaseError supabase_unavailable, with no URL or password in the message", async () => {
  const database: Database & { close(): Promise<void> } = createSupabaseDatabase({
    connectionString: "postgresql://postgres:hunter2-secret@127.0.0.1:1/postgres",
    caCert: null,
    poolMax: 1,
  });
  try {
    for (const attempt of [() => database.query("SELECT 1"), () => database.transaction((tx) => tx.execute("SELECT 1"))]) {
      await assert.rejects(attempt(), (e: unknown) => {
        assert.ok(e instanceof DatabaseError);
        assert.equal(e.code, "supabase_unavailable");
        assert.ok(!e.message.includes("hunter2") && !e.message.includes("127.0.0.1"));
        return true;
      });
    }
  } finally {
    await database.close();
  }
});

// ---------- WorkflowStore over a scripted SqlRunner ----------

interface Statement { sql: string; params: Param[] }

function scriptedDb(handlers: { query?: (s: Statement) => unknown[]; execute?: (s: Statement) => number }) {
  const statements: Statement[] = [];
  let committed = 0;
  let rolledBack = 0;
  const runner: SqlRunner = {
    async query<T>(sql: string, params: Param[] = []) {
      statements.push({ sql, params });
      return (handlers.query?.({ sql, params }) ?? []) as T[];
    },
    async execute(sql: string, params: Param[] = []) {
      statements.push({ sql, params });
      return handlers.execute?.({ sql, params }) ?? 0;
    },
  };
  const db: Database = {
    ...runner,
    async transaction(work) {
      try {
        const result = await work(runner);
        committed += 1;
        return result;
      } catch (error) {
        rolledBack += 1;
        throw error;
      }
    },
  };
  return { db, statements, counts: () => ({ committed, rolledBack }) };
}

const param = (s: Statement, name: string) => s.params.find((p) => p.name === name)?.value;

const requestRow = {
  id: REQUEST, user_id: USER, state: "approved", health_override: false, respond_by: null,
  draft_subject: "Coverage request", draft_body: "Could you cover my shift?", disclosure_tier: "minimal",
  recipient_email: "teammate@example.test",
};

test("withOwnedRequest locks the owner's request, maps it, and loads the latest approval", async () => {
  const { db, statements, counts } = scriptedDb({
    query: (s) => (s.sql.includes("FOR UPDATE") ? [requestRow] : s.sql.includes("evidence_kind = 'approval'") ? [{ id: "41", hash: "abc" }] : []),
  });
  const result = await createWorkflowStore(db).withOwnedRequest(USER, REQUEST, async (tx) => ({ request: tx.request, approval: tx.latestApproval }));
  assert.equal(result.request.recipientEmail, "teammate@example.test");
  assert.equal(result.request.state, "approved");
  assert.deepEqual(result.approval, { id: "41", hash: "abc" });
  const lock = statements[0];
  assert.match(lock.sql, /FOR UPDATE OF r/);
  assert.match(lock.sql, /r\.user_id = CAST\(:user_id AS uuid\) AND g\.user_id = CAST\(:user_id AS uuid\)/);
  assert.deepEqual(param(lock, "user_id"), { stringValue: USER });
  assert.deepEqual(counts(), { committed: 1, rolledBack: 0 });
});

test("withOwnedRequest throws not_found for another owner's request and rolls back", async () => {
  const { db, counts } = scriptedDb({ query: () => [] });
  await assert.rejects(
    createWorkflowStore(db).withOwnedRequest(USER, REQUEST, async () => "never"),
    (e: unknown) => e instanceof WorkflowError && e.code === "not_found",
  );
  assert.deepEqual(counts(), { committed: 0, rolledBack: 1 });
});

test("transition is compare-and-set and writes exactly one evidence row on success", async () => {
  let casRows = 1;
  const { db, statements } = scriptedDb({
    query: (s) => (s.sql.includes("FOR UPDATE") ? [requestRow] : []),
    execute: (s) => (s.sql.startsWith("UPDATE request") ? casRows : 1),
  });
  const store = createWorkflowStore(db);
  const deadline = new Date("2026-11-10T17:00:00Z");
  const ok = await store.withOwnedRequest(USER, REQUEST, (tx) =>
    tx.transition({ from: "approved", to: "requested", evidenceKind: "gmail_message_id", evidenceRef: "gmail-1", actor: "system", respondBy: deadline }),
  );
  assert.equal(ok, true);
  const update = statements.find((s) => s.sql.startsWith("UPDATE request"))!;
  assert.match(update.sql, /WHERE id = CAST\(:request_id AS uuid\) AND state = :from_state/);
  assert.deepEqual(param(update, "respond_by"), { stringValue: "2026-11-10T17:00:00.000Z" });
  assert.equal(statements.filter((s) => s.sql.startsWith("INSERT INTO request_event")).length, 1);

  casRows = 0;
  statements.length = 0;
  const lost = await store.withOwnedRequest(USER, REQUEST, (tx) =>
    tx.transition({ from: "approved", to: "sending", evidenceKind: "approval", evidenceRef: "41", actor: "system" }),
  );
  assert.equal(lost, false);
  assert.equal(statements.filter((s) => s.sql.startsWith("INSERT INTO request_event")).length, 0);
});

test("withResponseToken checks expiry in SQL, locks the request, and saves a proposal with its commitment", async () => {
  const { db, statements } = scriptedDb({
    query: (s) =>
      s.sql.includes("FROM response_token")
        ? [{ token_hash: "h", choice: "propose", expires_at: "2026-11-20T00:00:00Z", request_id: REQUEST }]
        : s.sql.includes("FOR UPDATE") ? [{ ...requestRow, state: "requested" }] : [],
    execute: () => 1,
  });
  await createWorkflowStore(db).withResponseToken("h", new Date(), async (tx) => {
    assert.equal(tx.token.choice, "propose");
    assert.equal(tx.request.state, "requested");
    await tx.saveProposal({ at: new Date("2026-11-12T16:00:00Z"), note: "Thursday works" });
    await tx.consumeAllTokens();
  });
  assert.match(statements[0].sql, /expires_at > now\(\)/);
  assert.match(statements[1].sql, /FOR UPDATE OF r/);
  assert.ok(statements.some((s) => s.sql.includes("INSERT INTO commitment") && s.sql.includes("'response'")));
  assert.ok(statements.some((s) => s.sql.includes("UPDATE response_token SET used_at")));
});

test("withResponseToken rejects an unknown or expired token", async () => {
  const { db } = scriptedDb({ query: () => [] });
  await assert.rejects(createWorkflowStore(db).withResponseToken("nope", new Date(), async () => 1),
    (e: unknown) => e instanceof WorkflowError && e.code === "not_found");
});

// ---------- AccountStore ----------

test("AccountStore upserts by lowercased email and round-trips ciphertext as bytes", async () => {
  const saved: Param[][] = [];
  const { db } = scriptedDb({
    query: (s) =>
      s.sql.startsWith("INSERT INTO app_user") ? [{ id: USER }]
        : s.sql.includes("encode(google_refresh_token_enc") ? [{ email: "alex@example.test", ciphertext_b64: "AQID\nBA==" }] : [],
    execute: (s) => { saved.push(s.params); return 1; },
  });
  const store = createAccountStore(db);
  assert.deepEqual(await store.findOrCreateUserByEmail(" Alex@Example.test "), { id: USER });
  const loaded = await store.loadEncryptedRefreshToken(USER);
  assert.deepEqual([...(loaded.ciphertext ?? [])], [1, 2, 3, 4]);
  await store.saveEncryptedRefreshToken(USER, new Uint8Array([9, 9]));
  assert.deepEqual(saved[0].find((p) => p.name === "ciphertext")?.value, { blobValue: new Uint8Array([9, 9]) });
});

test("AccountStore never creates a user when saving, and rejects malformed ids", async () => {
  const { db } = scriptedDb({ query: () => [], execute: () => 0 });
  const store = createAccountStore(db);
  await assert.rejects(store.saveEncryptedRefreshToken(USER, new Uint8Array([1])), (e: unknown) => e instanceof WorkflowError);
  await assert.rejects(store.loadEncryptedRefreshToken("not-a-uuid"), (e: unknown) => e instanceof WorkflowError);
  await assert.rejects(store.loadEncryptedRefreshToken(USER), (e: unknown) => e instanceof WorkflowError);
});
