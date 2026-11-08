// owner-scoped retrieval of approved passport facts for A5 (PRD 7.2, section 15). every statement filters by the
// session owner's care recipient and status 'approved' before ranking or vector search; nothing here reads the public
// resource table. an optional pgvector path (RR_EMBED=bedrock) lazily embeds approved facts and merges cosine ranks
// with keyword ranks; any embedding problem falls back to keyword ranking.
import "server-only";
import { createHash } from "node:crypto";
import { p, type SqlRunner } from "../../../lib/db.ts";
import type { CareCategory } from "../../../lib/ai/careCompiler.ts";
import { currentEmbedder, toVectorLiteral, type Embedder } from "../../../lib/ai/embeddings.ts";
import {
  RETRIEVAL_LIMITS,
  selectContext,
  type RetrievalLimits,
  type RetrievalMethod,
  type VectorHit,
} from "../../../lib/ai/retrieval.ts";
import { normalizeText } from "../../../lib/ai/text.ts";
import { paidProvidersAllowed, type SessionUser } from "../../../lib/mvp/auth.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { reserveCall } from "../../../lib/rateLimit.ts";
import { loadRecipient, recipientAliases } from "./context.ts";

/** an approved, current fact with its provenance; text is the stored text_exact, never model wording */
export interface PassportFact {
  id: string;
  category: CareCategory;
  textExact: string;
  version: number;
  sourceId: string | null;
  sourceKind: string | null;
  sourceCreatedAt: string | null;
  createdAt: string;
}

export interface PassportScope {
  ownerId: string;
  careRecipientId: string;
  /** alias and display name, ignored as search words */
  names: string[];
}

interface PassportRow {
  id: string;
  category: CareCategory;
  text_exact: string;
  version: number | null;
  source_id: string | null;
  source_kind: string | null;
  source_created_at: string | null;
  created_at: string;
  embedding_model: string | null;
  embedded_hash: string | null;
  has_embedding: boolean;
}

// the strpos clause checks the passage in code at ask time: an original fact whose exact text is no longer in its own
// retained source never reaches the model. edited versions (version > 1) are caregiver-written text approved as is.
export const PASSPORT_FACTS = `SELECT f.id::text AS id, f.category, f.text_exact, f.version, f.source_id::text AS source_id,
    s.kind AS source_kind, to_json(s.created_at)#>>'{}' AS source_created_at, to_json(f.created_at)#>>'{}' AS created_at,
    f.embedding_model, f.embedded_hash, (f.embedding IS NOT NULL) AS has_embedding
  FROM care_fact f
  JOIN care_recipient r ON r.id = f.care_recipient_id AND r.owner_id = CAST(:owner_id AS uuid)
  LEFT JOIN care_source s ON s.id = f.source_id AND s.care_recipient_id = f.care_recipient_id
  WHERE f.care_recipient_id = CAST(:recipient_id AS uuid) AND f.status = 'approved'
    AND (f.source_id IS NULL OR f.version > 1 OR COALESCE(strpos(s.full_text, f.text_exact) > 0, false))
  ORDER BY f.created_at DESC, f.id
  LIMIT 500`;

// exact cosine scan behind the owner, recipient and status filter, in the same statement
export const VECTOR_SEARCH = `SELECT f.id::text AS id, (1 - (f.embedding <=> CAST(:query AS vector)))::float8 AS similarity
  FROM care_fact f
  JOIN care_recipient r ON r.id = f.care_recipient_id AND r.owner_id = CAST(:owner_id AS uuid)
  WHERE f.care_recipient_id = CAST(:recipient_id AS uuid) AND f.status = 'approved'
    AND f.embedding IS NOT NULL AND f.embedding_model = :model
  ORDER BY f.embedding <=> CAST(:query AS vector), f.id
  LIMIT CAST(:k AS int)`;

// the text guard makes the write a no-op if the fact changed or left approved while the vector was being made
const STORE_EMBEDDING = `UPDATE care_fact f SET embedding = CAST(:embedding AS vector), embedding_model = :model,
    embedded_hash = :hash
  FROM care_recipient r
  WHERE f.id = CAST(:id AS uuid) AND f.care_recipient_id = CAST(:recipient_id AS uuid)
    AND r.id = f.care_recipient_id AND r.owner_id = CAST(:owner_id AS uuid)
    AND f.status = 'approved' AND f.text_exact = :text_exact`;

/** most facts embedded per ask; the rest are picked up by later questions */
const INDEX_BATCH = 50;

export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function ownerScope(sql: SqlRunner, user: SessionUser): Promise<PassportScope> {
  const recipient = await loadRecipient(sql, user.id);
  return { ownerId: user.id, careRecipientId: recipient.id, names: recipientAliases(recipient) };
}

async function loadRows(sql: SqlRunner, scope: PassportScope): Promise<PassportRow[]> {
  return sql.query<PassportRow>(PASSPORT_FACTS, [p.uuid("owner_id", scope.ownerId), p.uuid("recipient_id", scope.careRecipientId)]);
}

function toFact(row: PassportRow): PassportFact {
  return {
    id: row.id,
    category: row.category,
    textExact: row.text_exact,
    version: Number(row.version ?? 1),
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    sourceCreatedAt: row.source_created_at === null ? null : new Date(row.source_created_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** approved facts for the scope, newest first (the passage check applies) */
export async function loadPassportFacts(sql: SqlRunner, scope: PassportScope): Promise<PassportFact[]> {
  return (await loadRows(sql, scope)).map(toFact);
}

function isFresh(row: PassportRow, embedder: Embedder): boolean {
  return row.has_embedding && row.embedding_model === embedder.model && row.embedded_hash === textHash(row.text_exact);
}

/** counts one embedding call against the owner's embed quota; false means skip vectors this time */
async function reserveEmbed(rt: Runtime, user: SessionUser, step: "embed_fact" | "embed_query", embedder: Embedder): Promise<boolean> {
  const reservation = await reserveCall(rt.stores.database, { userId: user.id, step, model: embedder.model });
  return reservation.allowed;
}

/**
 * embeds approved facts that have no vector, or whose model or text changed, then searches by cosine similarity.
 * returns null when vectors could not be used (off, not allowed, over quota or a provider error).
 */
async function vectorSearch(
  rt: Runtime,
  user: SessionUser,
  scope: PassportScope,
  rows: PassportRow[],
  question: string,
  embedder: Embedder,
  k: number,
): Promise<VectorHit[] | null> {
  const database = rt.stores.database;
  try {
    const fresh = new Set(rows.filter((row) => isFresh(row, embedder)).map((row) => row.id));
    const stale = rows.filter((row) => !fresh.has(row.id)).slice(0, INDEX_BATCH);
    if (stale.length > 0 && (await reserveEmbed(rt, user, "embed_fact", embedder))) {
      const vectors = await embedder.embed(stale.map((row) => row.text_exact));
      for (const [index, row] of stale.entries()) {
        const vector = vectors[index];
        if (!vector) continue;
        const changed = await database.execute(STORE_EMBEDDING, [
          p.text("embedding", toVectorLiteral(vector)),
          p.text("model", embedder.model),
          p.text("hash", textHash(row.text_exact)),
          p.uuid("id", row.id),
          p.uuid("recipient_id", scope.careRecipientId),
          p.uuid("owner_id", scope.ownerId),
          p.text("text_exact", row.text_exact),
        ]);
        if (changed > 0) fresh.add(row.id);
      }
    }
    if (fresh.size === 0) return null;
    if (!(await reserveEmbed(rt, user, "embed_query", embedder))) return null;
    const [query] = await embedder.embed([normalizeText(question).slice(0, 500)]);
    if (!query) return null;
    const hits = await database.query<{ id: string; similarity: number }>(VECTOR_SEARCH, [
      p.text("query", toVectorLiteral(query)),
      p.uuid("owner_id", scope.ownerId),
      p.uuid("recipient_id", scope.careRecipientId),
      p.text("model", embedder.model),
      p.int("k", k),
    ]);
    // a vector whose text changed after it was made is never trusted, even if a refresh was missed
    return hits.filter((hit) => fresh.has(hit.id)).map((hit) => ({ id: hit.id, similarity: Number(hit.similarity) }));
  } catch {
    // retrieval still works on keywords; provider and database details stay out of the response
    return null;
  }
}

export interface Retrieval {
  scope: PassportScope;
  /** the context for A5, best first */
  facts: PassportFact[];
  byId: Map<string, PassportFact>;
  method: RetrievalMethod;
  /** approved facts that passed owner scoping and were sent as context */
  considered: number;
  /** every approved fact in scope */
  approvedTotal: number;
}

/** the approved, owner-scoped context for one question; vectors only when an embedder is set and allowed */
export async function retrievePassport(
  rt: Runtime,
  user: SessionUser,
  question: string,
  options: { useVector?: boolean; limits?: Partial<RetrievalLimits>; embedder?: Embedder | null } = {},
): Promise<Retrieval> {
  const database = rt.stores.database;
  const scope = await ownerScope(database, user);
  const rows = await loadRows(database, scope);
  const facts = rows.map(toFact);
  const embedder = options.embedder === undefined ? currentEmbedder() : options.embedder;
  const limits = { ...RETRIEVAL_LIMITS, ...options.limits };
  let vectorHits: VectorHit[] | null = null;
  // demo AI with a live embedder still needs the paid-provider gate, since embeddings call a paid service
  if ((options.useVector ?? true) && embedder !== null && rows.length > 0 && paidProvidersAllowed(rt.auth.mode, rt.baseUrl)) {
    vectorHits = await vectorSearch(rt, user, scope, rows, question, embedder, limits.topK);
  }
  const selection = selectContext({ question, facts, names: scope.names, vectorHits, limits });
  return {
    scope,
    facts: selection.facts,
    byId: new Map(facts.map((fact) => [fact.id, fact])),
    method: selection.method,
    considered: selection.facts.length,
    approvedTotal: facts.length,
  };
}
