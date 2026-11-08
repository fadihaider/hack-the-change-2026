// Ask the Care Passport over PGlite (PRD 7.2, AC6, AC13): approved-fact retrieval, owner scoping, revision
// invalidation, the medical guard and the pgvector path with a deterministic fake embedder. demo AI, no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { Param } from "../lib/db.ts";

const BASE = "http://localhost:3000";
const dir = mkdtempSync(path.join(tmpdir(), "rr-ask-"));
process.env.RR_PGLITE_DIR = dir;
delete process.env.APP_BASE_URL;
delete process.env.RR_EMBED;

type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: Record<string, { GET?: Handler; POST?: Handler }> = {};

type Care = typeof import("../app/api/_lib/care.ts");
type Retrieval = typeof import("../app/api/_lib/careRetrieval.ts");
type Embeddings = typeof import("../lib/ai/embeddings.ts");
type RuntimeModule = typeof import("../lib/mvp/runtime.ts");
let care: Care;
let retrieval: Retrieval;
let embeddings: Embeddings;
let rt: Awaited<ReturnType<RuntimeModule["getRuntime"]>>;

before(async () => {
  for (const name of ["session", "care/sources", "care/facts/[id]/approve", "care/ask"]) {
    routes[name] = (await import(`../app/api/${name}/route.ts`)) as { GET?: Handler; POST?: Handler };
  }
  care = await import("../app/api/_lib/care.ts");
  retrieval = await import("../app/api/_lib/careRetrieval.ts");
  embeddings = await import("../lib/ai/embeddings.ts");
  rt = await (await import("../lib/mvp/runtime.ts")).getRuntime();
});

after(async () => {
  embeddings.setEmbedder(undefined);
  const holder = globalThis as { __reliefReadyPglite?: Promise<{ close(): Promise<void> }> };
  await (await holder.__reliefReadyPglite)?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: "GET" | "POST", route: string, options: { body?: unknown; params?: Record<string, string> } = {}) {
  const handler = routes[route]?.[method];
  assert.ok(handler, `${method} ${route} is exported`);
  const headers: Record<string, string> = { Origin: BASE };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`${BASE}/api/${route}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, data: (await response.json()) as any };
}

const sql = (text: string, params: Param[] = []) => rt.stores.database.query<Record<string, any>>(text, params);
const s = (name: string, value: string): Param => ({ name, value: { stringValue: value } });

const VOICE = "Rosa usually has breakfast at eight. She prefers instructions written down. " +
  "Her spare glasses are in the bedroom drawer. She likes the radio on in the morning.";

let alex: { id: string; email: string };
let rosaId: string;
let glassesId: string;
let radioId: string;
let sam: { id: string; email: string };
let samFactId: string;

async function llmCalls(): Promise<number> {
  return Number((await sql("SELECT count(*)::int AS n FROM llm_call"))[0].n);
}

test("after approval, the glasses question cites the exact approved fact, labelled as demo rules", async () => {
  const session = await call("GET", "session");
  alex = { id: session.data.user.id, email: session.data.user.email };
  const added = await call("POST", "care/sources", { body: { kind: "voice", text: VOICE } });
  assert.equal(added.status, 200);
  assert.equal(added.data.facts.length, 4);
  for (const fact of added.data.facts) {
    const approved = await call("POST", "care/facts/[id]/approve", { params: { id: fact.id } });
    assert.equal(approved.status, 200);
  }
  glassesId = added.data.facts.find((fact: any) => fact.textExact.includes("glasses")).id;
  radioId = added.data.facts.find((fact: any) => fact.textExact.includes("radio")).id;
  rosaId = (await sql("SELECT care_recipient_id::text AS id FROM care_fact WHERE id = CAST(:id AS uuid)", [s("id", glassesId)]))[0].id;

  const ask = await call("POST", "care/ask", { body: { question: "Where are her spare glasses?" } });
  assert.equal(ask.status, 200);
  assert.equal(ask.data.notFound, false);
  assert.deepEqual(ask.data.citedFacts.map((fact: any) => fact.id), [glassesId]);
  const [cited] = ask.data.citedFacts;
  assert.equal(cited.textExact, "Her spare glasses are in the bedroom drawer.");
  assert.equal(cited.sourceId, added.data.source.id);
  assert.equal(cited.sourceKind, "voice");
  assert.equal(cited.version, 1);
  assert.ok(cited.sourceCreatedAt);
  assert.equal(ask.data.answeredBy, "demo_rules");
  assert.match(ask.data.answer, /^Demo keyword match, not AI/);
  assert.equal(ask.data.medicalRedirect, false);
  assert.deepEqual(ask.data.retrieval, { method: "keyword", considered: 4 });
  assert.equal(ask.data.openQuestionId, null);
});

test("a missing answer is Not in profile and opens one question for the asker's recipient", async () => {
  const ask = await call("POST", "care/ask", { body: { question: "What is her doctor's name?" } });
  assert.equal(ask.data.notFound, true);
  assert.equal(ask.data.answer, "Not in profile");
  assert.deepEqual(ask.data.citedFacts, []);
  assert.ok(ask.data.openQuestionId);
  const again = await call("POST", "care/ask", { body: { question: "What is her doctor's name?" } });
  assert.equal(again.data.openQuestionId, ask.data.openQuestionId);
  const rows = await sql("SELECT care_recipient_id::text AS recipient FROM open_question WHERE question = :q", [
    s("q", "What is her doctor's name?"),
  ]);
  assert.deepEqual(rows.map((row) => row.recipient), [rosaId]);
});

test("medical and emergency questions get the 811/911 pointer with no model call and no open question", async () => {
  const before = await llmCalls();
  const questions = Number((await sql("SELECT count(*)::int AS n FROM open_question"))[0].n);

  const medical = await call("POST", "care/ask", { body: { question: "Should I give her more pain medicine?" } });
  assert.equal(medical.status, 200);
  assert.equal(medical.data.medicalRedirect, true);
  assert.equal(medical.data.answeredBy, "none");
  assert.equal(medical.data.answer, "ReliefReady can’t give medical advice. For health questions call Health Link at 811. If this is an emergency, call 911.");
  assert.equal(medical.data.openQuestionId, null);

  const emergency = await call("POST", "care/ask", { body: { question: "She has chest pain and cannot breathe" } });
  assert.equal(emergency.data.medicalRedirect, true);
  assert.match(emergency.data.answer, /^If this is an emergency, call 911 now\./);
  assert.deepEqual(emergency.data.citedFacts, []);
  assert.deepEqual(emergency.data.retrieval, { method: "none", considered: 0 });

  assert.equal(await llmCalls(), before);
  assert.equal(Number((await sql("SELECT count(*)::int AS n FROM open_question"))[0].n), questions);
});

test("another owner's recipient is never retrieved or cited, in either direction", async () => {
  const users = await sql("INSERT INTO app_user (email) VALUES ('sam.owner@example.test') RETURNING id::text AS id");
  sam = { id: users[0].id, email: "sam.owner@example.test" };
  const recipients = await sql(
    "INSERT INTO care_recipient (owner_id, alias, display_name) VALUES (CAST(:o AS uuid), 'Dad', 'Sam') RETURNING id::text AS id",
    [s("o", sam.id)],
  );
  const samRecipient = recipients[0].id;
  const text = "Spare glasses are on the hall table.";
  const sources = await sql(
    `INSERT INTO care_source (care_recipient_id, kind, full_text, author) VALUES (CAST(:r AS uuid), 'note', :t, 'caregiver')
      RETURNING id::text AS id`,
    [s("r", samRecipient), s("t", text)],
  );
  const facts = await sql(
    `INSERT INTO care_fact (care_recipient_id, category, text_exact, source_id, span_start, span_end, status)
      VALUES (CAST(:r AS uuid), 'logistics', :t, CAST(:src AS uuid), 0, ${text.length}, 'approved') RETURNING id::text AS id`,
    [s("r", samRecipient), s("t", text), s("src", sources[0].id)],
  );
  samFactId = facts[0].id;

  const asSam = await care.askProfile(rt, sam, "Where are her spare glasses?");
  assert.deepEqual(asSam.citedFacts.map((fact) => fact.id), [samFactId]);
  const asAlex = await care.askProfile(rt, alex, "Where are the spare glasses on the hall table?");
  assert.ok(asAlex.citedFacts.every((fact) => fact.id !== samFactId));

  // even with the wrong recipient id, the owner join returns nothing
  assert.deepEqual(await retrieval.loadPassportFacts(rt.stores.database, { ownerId: sam.id, careRecipientId: rosaId, names: [] }), []);
  // a forced tiny context still only ranks the owner's own facts
  const forced = await retrieval.retrievePassport(rt, sam, "glasses drawer bedroom radio breakfast", { limits: { fullContextMaxFacts: 0, topK: 50 } });
  assert.deepEqual(forced.facts.map((fact) => fact.id), [samFactId]);
});

test("an edit (new approved version) replaces the old one, and a passage missing from its source is never cited", async () => {
  const note = "Her spare glasses are on the kitchen shelf now.";
  const sources = await sql(
    `INSERT INTO care_source (care_recipient_id, kind, full_text, author) VALUES (CAST(:r AS uuid), 'note', :t, 'caregiver')
      RETURNING id::text AS id`,
    [s("r", rosaId), s("t", note)],
  );
  await sql("UPDATE care_fact SET status = 'superseded' WHERE id = CAST(:id AS uuid) RETURNING id", [s("id", glassesId)]);
  const v2 = await sql(
    `INSERT INTO care_fact (care_recipient_id, category, text_exact, source_id, span_start, span_end, status, version, supersedes)
      VALUES (CAST(:r AS uuid), 'logistics', :t, CAST(:src AS uuid), 0, ${note.length}, 'approved', 2, CAST(:old AS uuid))
      RETURNING id::text AS id`,
    [s("r", rosaId), s("t", note), s("src", sources[0].id), s("old", glassesId)],
  );
  const ask = await call("POST", "care/ask", { body: { question: "Where are her spare glasses?" } });
  assert.deepEqual(ask.data.citedFacts.map((fact: any) => fact.id), [v2[0].id]);
  assert.equal(ask.data.citedFacts[0].version, 2);
  assert.ok(ask.data.citedFacts.every((fact: any) => fact.id !== glassesId));

  // a v1 fact whose text no longer appears in its retained source is dropped before the model sees it
  await sql("UPDATE care_fact SET text_exact = 'She likes loud jazz records.' WHERE id = CAST(:id AS uuid) RETURNING id", [s("id", radioId)]);
  const jazz = await call("POST", "care/ask", { body: { question: "Does she like jazz records?" } });
  assert.ok(jazz.data.citedFacts.every((fact: any) => fact.id !== radioId));
  await sql("UPDATE care_fact SET text_exact = 'She likes the radio on in the morning.' WHERE id = CAST(:id AS uuid) RETURNING id", [s("id", radioId)]);
  glassesId = v2[0].id;
});

/** bag of words hashed into 1024 dims, unit length; the same text always gives the same vector */
function fakeVector(text: string): number[] {
  const vector = new Array(1024).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const index = createHash("sha256").update(word).digest().readUInt16BE(0) % 1024;
    vector[index] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

test("the pgvector path embeds approved facts lazily, orders by cosine distance and keeps the recipient filter", async () => {
  const embedded: string[] = [];
  embeddings.setEmbedder({
    model: "fake-bow:1024",
    dims: 1024,
    async embed(texts: string[]) {
      embedded.push(...texts);
      return texts.map(fakeVector);
    },
  });
  try {
    const ask = await call("POST", "care/ask", { body: { question: "Where are her spare glasses?" } });
    assert.equal(ask.data.retrieval.method, "keyword+vector");
    assert.deepEqual(ask.data.citedFacts.map((fact: any) => fact.id), [glassesId]);

    const rows = await sql(
      `SELECT id::text AS id, embedding_model, embedded_hash, text_exact FROM care_fact
        WHERE care_recipient_id = CAST(:r AS uuid) AND status = 'approved' ORDER BY id`,
      [s("r", rosaId)],
    );
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.equal(row.embedding_model, "fake-bow:1024");
      assert.equal(row.embedded_hash, createHash("sha256").update(row.text_exact).digest("hex"));
    }
    // superseded and other owners' facts were never embedded
    const superseded = await sql("SELECT embedding_model FROM care_fact WHERE status = 'superseded'");
    assert.ok(superseded.every((row) => row.embedding_model === null));
    assert.ok(!embedded.includes("Spare glasses are on the hall table."));

    // a second ask reuses fresh vectors: only the question is embedded
    embedded.length = 0;
    await call("POST", "care/ask", { body: { question: "What does she listen to?" } });
    assert.deepEqual(embedded, ["What does she listen to?"]);

    // ORDER BY embedding <=> query puts the nearest fact first, and only the owner's recipient is searched
    const query = JSON.stringify(fakeVector("Her spare glasses are on the kitchen shelf now."));
    const hits = await sql(retrieval.VECTOR_SEARCH, [
      s("query", query), s("owner_id", alex.id), s("recipient_id", rosaId), s("model", "fake-bow:1024"),
      { name: "k", value: { longValue: 10 } },
    ]);
    assert.equal(hits[0].id, glassesId);
    assert.ok(Number(hits[0].similarity) > 0.99);
    assert.ok(hits.every((hit) => hit.id !== samFactId));
    const crossOwner = await sql(retrieval.VECTOR_SEARCH, [
      s("query", query), s("owner_id", sam.id), s("recipient_id", rosaId), s("model", "fake-bow:1024"),
      { name: "k", value: { longValue: 10 } },
    ]);
    assert.deepEqual(crossOwner, []);

    // identical vectors for every text: Sam still only ever sees Sam's fact
    embeddings.setEmbedder({ model: "flat:1024", dims: 1024, embed: async (texts) => texts.map(() => new Array(1024).fill(1 / 32)) });
    const flat = await retrievalAs(sam, "Where are the glasses in the bedroom drawer?");
    assert.deepEqual(flat, [samFactId]);
  } finally {
    embeddings.setEmbedder(undefined);
  }
});

async function retrievalAs(user: { id: string; email: string }, question: string): Promise<string[]> {
  const result = await retrieval.retrievePassport(rt, user, question, { limits: { fullContextMaxFacts: 0, topK: 50 } });
  assert.equal(result.method, "keyword+vector");
  return result.facts.map((fact) => fact.id);
}
