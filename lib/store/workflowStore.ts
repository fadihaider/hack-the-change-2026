// durable WorkflowStore for lib/requests/workflow.ts on PGlite or Supabase Postgres (docs/INTEGRATIONS.md "Store boundary")
import "server-only";
import { p, type Database, type SqlRunner } from "../db.ts";
import {
  WorkflowError,
  type Approval,
  type RequestRecord,
  type RequestTransaction,
  type ResponseTransaction,
  type StoredToken,
  type Transition,
  type WorkflowStore,
} from "../requests/workflow.ts";
import type { DisclosureTier, RequestState, ResponseChoice } from "../state.ts";

interface RequestRow {
  id: string;
  user_id: string;
  state: RequestState;
  health_override: boolean;
  respond_by: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  disclosure_tier: DisclosureTier;
  recipient_email: string;
}

interface TokenRow {
  token_hash: string;
  choice: ResponseChoice;
  expires_at: string;
  request_id: string;
}

// every timestamp leaves the database as ISO 8601 text (lib/sql.ts RESULT_PARSERS)
const REQUEST_COLUMNS = `r.id, r.user_id, r.state, r.health_override, to_json(r.respond_by)#>>'{}' AS respond_by,
  r.draft_subject, r.draft_body, r.disclosure_tier, c.email AS recipient_email`;

/** loads and row-locks one request with its contact; the owner filter covers the request and the contact's group */
const LOCK_OWNED_REQUEST = `SELECT ${REQUEST_COLUMNS}
  FROM request r
  JOIN contact c ON c.id = r.contact_id
  JOIN contact_group g ON g.id = c.group_id
  WHERE r.id = CAST(:request_id AS uuid) AND r.user_id = CAST(:user_id AS uuid) AND g.user_id = CAST(:user_id AS uuid)
  FOR UPDATE OF r`;

/** same lock for a response link; the token is the authority, so there is no owner filter */
const LOCK_REQUEST_BY_ID = `SELECT ${REQUEST_COLUMNS}
  FROM request r
  JOIN contact c ON c.id = r.contact_id
  WHERE r.id = CAST(:request_id AS uuid)
  FOR UPDATE OF r`;

/** the approval that moved the request to approved most recently; an edit forces a new one before any send */
const LATEST_APPROVAL = `SELECT id::text AS id, evidence_ref AS hash
  FROM request_event
  WHERE request_id = CAST(:request_id AS uuid) AND evidence_kind = 'approval' AND to_state = 'approved'
  ORDER BY id DESC
  LIMIT 1`;

/** used tokens stay readable until expiry so a repeat click shows the first recorded answer; expiry uses real time */
const FIND_TOKEN = `SELECT token_hash, choice, to_json(expires_at)#>>'{}' AS expires_at, request_id::text AS request_id
  FROM response_token
  WHERE token_hash = :hash AND expires_at > now()`;

/** compare-and-set; respond_by is kept when already set (the approval queue may have set it) */
const TRANSITION = `UPDATE request
  SET state = :to_state, updated_at = now(),
      respond_by = CASE WHEN :to_state = 'requested' THEN COALESCE(respond_by, CAST(:respond_by AS timestamptz)) ELSE respond_by END
  WHERE id = CAST(:request_id AS uuid) AND state = :from_state`;

const INSERT_EVENT = `INSERT INTO request_event (request_id, from_state, to_state, evidence_kind, evidence_ref, actor)
  VALUES (CAST(:request_id AS uuid), :from_state, :to_state, :evidence_kind, :evidence_ref, :actor)`;

const INSERT_TOKEN = `INSERT INTO response_token (token_hash, request_id, choice, expires_at)
  VALUES (:hash, CAST(:request_id AS uuid), :choice, CAST(:expires_at AS timestamptz))`;

const CONSUME_TOKENS = `UPDATE response_token SET used_at = COALESCE(used_at, now()) WHERE request_id = CAST(:request_id AS uuid)`;

const SAVE_PROPOSAL = `UPDATE request SET proposed_at = CAST(:at AS timestamptz), proposed_note = :note, updated_at = now()
  WHERE id = CAST(:request_id AS uuid)`;

/** the proposed time becomes a new commitment (PRD R1 "New"), owned by the request's owner and in the same episode */
const INSERT_PROPOSED_COMMITMENT = `INSERT INTO commitment (user_id, episode_id, source, source_id, title, starts_at)
  SELECT r.user_id, c.episode_id, 'response', r.id::text, left('Proposed: ' || coalesce(c.title, 'request'), 200), CAST(:at AS timestamptz)
  FROM request r LEFT JOIN commitment c ON c.id = r.commitment_id
  WHERE r.id = CAST(:request_id AS uuid)`;

function toRecord(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    userId: row.user_id,
    recipientEmail: row.recipient_email,
    subject: row.draft_subject ?? "",
    body: row.draft_body ?? "",
    disclosureTier: row.disclosure_tier,
    state: row.state,
    healthOverride: row.health_override,
    respondBy: row.respond_by === null ? null : new Date(row.respond_by),
  };
}

async function latestApproval(tx: SqlRunner, requestId: string): Promise<Approval | null> {
  const rows = await tx.query<{ id: string; hash: string | null }>(LATEST_APPROVAL, [p.uuid("request_id", requestId)]);
  const row = rows[0];
  return row && row.hash ? { id: row.id, hash: row.hash } : null;
}

function requestTransaction(tx: SqlRunner, request: RequestRecord, approval: Approval | null): RequestTransaction {
  return {
    request,
    latestApproval: approval,
    async transition(change: Transition): Promise<boolean> {
      const changed = await tx.execute(TRANSITION, [
        p.uuid("request_id", request.id),
        p.text("from_state", change.from),
        p.text("to_state", change.to),
        p.ts("respond_by", change.respondBy ?? null),
      ]);
      if (changed !== 1) {
        return false;
      }
      await tx.execute(INSERT_EVENT, [
        p.uuid("request_id", request.id),
        p.text("from_state", change.from),
        p.text("to_state", change.to),
        p.text("evidence_kind", change.evidenceKind),
        p.text("evidence_ref", change.evidenceRef),
        p.text("actor", change.actor),
      ]);
      // keep the in-transaction view consistent with the row for later checks in the same work function
      request.state = change.to;
      if (change.to === "requested" && request.respondBy === null && change.respondBy) {
        request.respondBy = change.respondBy;
      }
      return true;
    },
    async saveTokens(tokens: StoredToken[]): Promise<void> {
      for (const token of tokens) {
        await tx.execute(INSERT_TOKEN, [
          p.text("hash", token.hash),
          p.uuid("request_id", request.id),
          p.text("choice", token.choice),
          p.ts("expires_at", token.expiresAt),
        ]);
      }
    },
  };
}

export function createWorkflowStore(database: Database): WorkflowStore {
  return {
    async withOwnedRequest<T>(userId: string, requestId: string, work: (tx: RequestTransaction) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        const rows = await tx.query<RequestRow>(LOCK_OWNED_REQUEST, [p.uuid("request_id", requestId), p.uuid("user_id", userId)]);
        if (rows.length !== 1) {
          throw new WorkflowError("not_found");
        }
        const request = toRecord(rows[0]);
        return work(requestTransaction(tx, request, await latestApproval(tx, request.id)));
      });
    },

    async withResponseToken<T>(hash: string, _realNow: Date, work: (tx: ResponseTransaction) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        const tokens = await tx.query<TokenRow>(FIND_TOKEN, [p.text("hash", hash)]);
        if (tokens.length !== 1) {
          throw new WorkflowError("not_found");
        }
        const tokenRow = tokens[0];
        const rows = await tx.query<RequestRow>(LOCK_REQUEST_BY_ID, [p.uuid("request_id", tokenRow.request_id)]);
        if (rows.length !== 1) {
          throw new WorkflowError("not_found");
        }
        const request = toRecord(rows[0]);
        const base = requestTransaction(tx, request, await latestApproval(tx, request.id));
        const token: StoredToken = { hash: tokenRow.token_hash, choice: tokenRow.choice, expiresAt: new Date(tokenRow.expires_at) };
        return work({
          ...base,
          token,
          async consumeAllTokens(): Promise<void> {
            await tx.execute(CONSUME_TOKENS, [p.uuid("request_id", request.id)]);
          },
          async saveProposal(proposal: { at: Date; note: string }): Promise<void> {
            await tx.execute(SAVE_PROPOSAL, [p.ts("at", proposal.at), p.text("note", proposal.note), p.uuid("request_id", request.id)]);
            await tx.execute(INSERT_PROPOSED_COMMITMENT, [p.ts("at", proposal.at), p.uuid("request_id", request.id)]);
          },
        });
      });
    },
  };
}
