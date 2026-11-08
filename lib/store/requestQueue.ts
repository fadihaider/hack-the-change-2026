// approval queue over Postgres (docs/INTEGRATIONS.md "Approval queue and clock contract", IMPLEMENTATION section 4)
import "server-only";
import { p, type Database, type SqlRunner } from "../db.ts";
import type { RequestView } from "../frontend/request-api.ts";
import { findExtraHealthTerms, findHealthTerms } from "../healthTerms.ts";
import { approvalRevision, requireApprovalRevision } from "../requests/approval-revision.ts";
import { WorkflowError, type RequestRecord } from "../requests/workflow.ts";
import { approvalHash, type DisclosureTier, type EvidenceKind, type RequestState } from "../state.ts";
import { readClock, sweepExpired } from "./clock.ts";

export type RequestAction = RequestView["action"];

/** extra: the request's own extra terms; a checker that ignores them still gets them added by the queue */
export type HealthTermChecker = (subject: string, body: string, extra?: readonly string[]) => string[] | Promise<string[]>;

/** approval blocked: health terms in a minimal or general draft without an override; routes answer HTTP 422 */
export class HealthTermsError extends Error {
  readonly code = "health_terms";
  readonly status = 422;

  constructor(readonly terms: string[]) {
    super("health_terms");
    this.name = "HealthTermsError";
  }
}

export interface DraftInput {
  commitmentId: string | null;
  contactId: string;
  action: RequestAction;
  subject: string;
  body: string;
  /** terms the drafter's own guard found; merged with the server check */
  healthTermsFound?: string[];
  /** server-only: words that also count as health terms for this request (intake reason, medical facts) */
  extraHealthTerms?: string[];
}

export interface EditInput {
  requestId: string;
  subject?: string;
  body?: string;
  contactId?: string;
  /** ISO time with Z or an offset; null clears it and the send uses the default 48 hours */
  respondBy?: string | null;
  /** the owner's choice for this request; absent keeps the current tier (a new contact takes its group's tier) */
  disclosureTier?: DisclosureTier;
  /** server-only (never from the browser): replaces the request's extra health terms, for a redraft */
  extraHealthTerms?: string[];
}

export interface RequestQueue {
  list(userId: string): Promise<RequestView[]>;
  read(userId: string, requestId: string): Promise<RequestView>;
  createDraft(userId: string, input: DraftInput): Promise<RequestView>;
  edit(userId: string, input: EditInput): Promise<RequestView>;
  /** ifMatch is the raw If-Match header; throws ApprovalPreconditionError, HealthTermsError or WorkflowError */
  approve(userId: string, requestId: string, ifMatch: string | null, healthOverride?: boolean): Promise<RequestView>;
  cancel(userId: string, requestId: string): Promise<RequestView>;
  /** owner-scoped expiry sweep in app time, then the list */
  refresh(userId: string): Promise<{ requests: RequestView[]; expiredRequestIds: string[] }>;
  /** server-only: the request's extra health terms for the send check; [] for a missing or foreign request */
  extraHealthTerms(userId: string, requestId: string): Promise<string[]>;
}

interface ViewRow {
  id: string;
  user_id: string;
  state: RequestState;
  action: RequestAction;
  health_override: boolean;
  respond_by: string | null;
  proposed_at: string | null;
  proposed_note: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  disclosure_tier: DisclosureTier;
  group_tier: DisclosureTier;
  health_terms_json: string;
  extra_terms_json: string;
  contact_id: string;
  contact_name: string;
  recipient_email: string;
}

interface EventRow {
  id: string;
  request_id: string;
  from_state: RequestState | null;
  to_state: RequestState;
  evidence_kind: EvidenceKind;
  evidence_ref: string | null;
  actor: string;
  at: string;
}

const EDITABLE = new Set<RequestState>(["draft", "awaiting_approval", "needs_review"]);
const CANCELLABLE = new Set<RequestState>(["awaiting_approval", "needs_review"]);
const ACTIONS = new Set<string>(["notify", "reschedule", "extension", "coverage"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBJECT = 300;
const MAX_BODY = 5000;
const MAX_TERM = 80;
const MAX_EXTRA_TERMS = 200;
const TIERS = new Set<string>(["minimal", "general", "detailed"]);

// every timestamp leaves the database as ISO text; arrays as JSON text (both work the same on the Data API)
const VIEW_COLUMNS = `r.id::text AS id, r.user_id::text AS user_id, r.state, r.action, r.health_override,
  to_json(r.respond_by)#>>'{}' AS respond_by, to_json(r.proposed_at)#>>'{}' AS proposed_at, r.proposed_note,
  r.draft_subject, r.draft_body, r.disclosure_tier,
  array_to_json(coalesce(r.health_terms_found, '{}'))::text AS health_terms_json,
  array_to_json(coalesce(r.extra_health_terms, '{}'))::text AS extra_terms_json, g.disclosure_tier AS group_tier,
  c.id::text AS contact_id, c.name AS contact_name, c.email AS recipient_email`;

/** owner filter covers the request and the contact's group (IMPLEMENTATION section 4, ownership) */
const OWNED = `FROM request r
  JOIN contact c ON c.id = r.contact_id
  JOIN contact_group g ON g.id = c.group_id
  WHERE r.user_id = CAST(:user_id AS uuid) AND g.user_id = CAST(:user_id AS uuid)`;

const SELECT_VIEWS = `SELECT ${VIEW_COLUMNS} ${OWNED}
  AND (CAST(:request_id AS uuid) IS NULL OR r.id = CAST(:request_id AS uuid))
  ORDER BY r.updated_at DESC, r.id`;

/** the request row is locked for the change; the contact and group are share-locked so email and tier hold still */
const LOCK_REQUEST = `SELECT ${VIEW_COLUMNS} ${OWNED} AND r.id = CAST(:request_id AS uuid)
  FOR UPDATE OF r FOR SHARE OF c, g`;

const SELECT_EVENTS = `SELECT e.id::text AS id, e.request_id::text AS request_id, e.from_state, e.to_state,
  e.evidence_kind, e.evidence_ref, e.actor, to_json(e.at)#>>'{}' AS at
  FROM request_event e JOIN request r ON r.id = e.request_id
  WHERE r.user_id = CAST(:user_id AS uuid)
    AND (CAST(:request_id AS uuid) IS NULL OR e.request_id = CAST(:request_id AS uuid))
  ORDER BY e.id DESC`;

const OWNED_CONTACT = `SELECT c.id::text AS id, g.disclosure_tier
  FROM contact c JOIN contact_group g ON g.id = c.group_id
  WHERE c.id = CAST(:contact_id AS uuid) AND g.user_id = CAST(:user_id AS uuid)
  FOR SHARE OF c, g`;

const EXTRA_TERMS = `SELECT array_to_json(coalesce(r.extra_health_terms, '{}'))::text AS extra_terms_json ${OWNED}
  AND r.id = CAST(:request_id AS uuid)`;

const OWNED_COMMITMENT = `SELECT id::text AS id FROM commitment
  WHERE id = CAST(:commitment_id AS uuid) AND user_id = CAST(:user_id AS uuid)`;

// the Data API takes no array parameters, so term lists travel as a JSON text array
const TERMS_ARRAY = `ARRAY(SELECT jsonb_array_elements_text(CAST(:terms AS jsonb)))`;
const EXTRA_ARRAY = `ARRAY(SELECT jsonb_array_elements_text(CAST(:extra AS jsonb)))`;

const INSERT_REQUEST = `INSERT INTO request (user_id, commitment_id, contact_id, action, draft_subject, draft_body,
    disclosure_tier, health_terms_found, extra_health_terms, state)
  VALUES (CAST(:user_id AS uuid), CAST(:commitment_id AS uuid), CAST(:contact_id AS uuid), :action, :subject, :body,
    :tier, ${TERMS_ARRAY}, ${EXTRA_ARRAY}, 'draft')
  RETURNING id::text AS id`;

const UPDATE_DRAFT = `UPDATE request SET draft_subject = :subject, draft_body = :body,
    contact_id = CAST(:contact_id AS uuid), disclosure_tier = :tier,
    respond_by = CASE WHEN :keep_respond_by THEN respond_by ELSE CAST(:respond_by AS timestamptz) END,
    health_terms_found = ${TERMS_ARRAY},
    extra_health_terms = CASE WHEN :keep_extra THEN extra_health_terms ELSE ${EXTRA_ARRAY} END,
    health_override = false, updated_at = now()
  WHERE id = CAST(:request_id AS uuid)`;

/** ids and tiers only; the owner chose a different tier for this one request */
const AUDIT_TIER = `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
  VALUES (:actor, 'disclosure_tier_change', 'request', :request_id,
    jsonb_build_object('from', CAST(:from_tier AS text), 'to', CAST(:to_tier AS text)))`;

const SAVE_APPROVAL_CHECK = `UPDATE request SET health_terms_found = ${TERMS_ARRAY}, health_override = :override,
    updated_at = now()
  WHERE id = CAST(:request_id AS uuid)`;

const AUDIT_OVERRIDE = `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
  VALUES (:actor, 'health_override', 'request', :request_id,
    jsonb_build_object('term_count', CAST(:term_count AS int), 'tier', :tier))`;

/** compare-and-set; the caller already holds the row lock, so a miss means the state machine was bypassed */
const TRANSITION = `UPDATE request SET state = :to_state, updated_at = now()
  WHERE id = CAST(:request_id AS uuid) AND state = :from_state`;

const INSERT_EVENT = `INSERT INTO request_event (request_id, from_state, to_state, evidence_kind, evidence_ref, actor)
  VALUES (CAST(:request_id AS uuid), :from_state, :to_state, :evidence_kind, :evidence_ref, :actor)`;

function iso(text: string | null): string | null {
  return text === null ? null : new Date(text).toISOString();
}

/** the same RequestRecord lib/store/workflowStore.ts loads, so revisions and approval hashes agree with send */
function toRecord(row: ViewRow): RequestRecord {
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

function toView(row: ViewRow, events: EventRow[]): RequestView {
  const evidence = events.map((event) => ({
    id: event.id,
    fromState: event.from_state,
    toState: event.to_state,
    evidenceKind: event.evidence_kind,
    evidenceRef: event.evidence_ref,
    actor: event.actor,
    at: iso(event.at) ?? "",
  }));
  // events are newest first; an approval counts until a later move back to awaiting_approval (an edit) replaces it
  const latest = evidence.find(
    (event) => event.toState === "awaiting_approval" || (event.evidenceKind === "approval" && event.toState === "approved"),
  );
  const approval = latest && latest.toState === "approved" && latest.evidenceRef
    ? { id: latest.id, hash: latest.evidenceRef, at: latest.at }
    : null;
  return {
    id: row.id,
    revision: approvalRevision(toRecord(row)),
    state: row.state,
    action: row.action,
    recipient: { contactId: row.contact_id, name: row.contact_name, email: row.recipient_email },
    subject: row.draft_subject ?? "",
    body: row.draft_body ?? "",
    disclosureTier: row.disclosure_tier,
    defaultDisclosureTier: row.group_tier,
    healthTermsFound: JSON.parse(row.health_terms_json) as string[],
    healthOverride: row.health_override,
    respondBy: iso(row.respond_by),
    proposedAt: iso(row.proposed_at),
    proposedNote: row.proposed_note,
    approval,
    evidence,
  };
}

async function loadViews(sql: SqlRunner, userId: string, requestId: string | null): Promise<RequestView[]> {
  const params = [p.uuid("user_id", userId), p.text("request_id", requestId)];
  const rows = await sql.query<ViewRow>(SELECT_VIEWS, params);
  const events = await sql.query<EventRow>(SELECT_EVENTS, params);
  const byRequest = new Map<string, EventRow[]>();
  for (const event of events) {
    const list = byRequest.get(event.request_id) ?? [];
    list.push(event);
    byRequest.set(event.request_id, list);
  }
  return rows.map((row) => toView(row, byRequest.get(row.id) ?? []));
}

async function transition(
  tx: SqlRunner,
  requestId: string,
  change: { from: RequestState; to: RequestState; kind: EvidenceKind; ref: string | null; actor: "user" | "system" },
): Promise<void> {
  const changed = await tx.execute(TRANSITION, [
    p.uuid("request_id", requestId),
    p.text("from_state", change.from),
    p.text("to_state", change.to),
  ]);
  if (changed !== 1) throw new WorkflowError("state_conflict");
  await tx.execute(INSERT_EVENT, [
    p.uuid("request_id", requestId),
    p.text("from_state", change.from),
    p.text("to_state", change.to),
    p.text("evidence_kind", change.kind),
    p.text("evidence_ref", change.ref),
    p.text("actor", change.actor),
  ]);
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new WorkflowError("not_found");
  return value.toLowerCase();
}

function invalid(): never {
  throw new WorkflowError("invalid_response");
}

function checkSubject(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > MAX_SUBJECT || /[\r\n]/.test(value)) invalid();
  return value;
}

function checkBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > MAX_BODY) invalid();
  return value;
}

function checkTerms(value: unknown, max = 50): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid();
  return value.map((term) => {
    if (typeof term !== "string" || !term.trim() || [...term].length > MAX_TERM) invalid();
    return term;
  });
}

function checkTier(value: unknown): DisclosureTier {
  if (typeof value !== "string" || !TIERS.has(value)) invalid();
  return value as DisclosureTier;
}

function parseTerms(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((term): term is string => typeof term === "string") : [];
  } catch {
    return [];
  }
}

async function ownedContact(tx: SqlRunner, userId: string, contactId: string): Promise<{ id: string; tier: DisclosureTier }> {
  const rows = await tx.query<{ id: string; disclosure_tier: DisclosureTier }>(OWNED_CONTACT, [
    p.uuid("contact_id", requireId(contactId)),
    p.uuid("user_id", userId),
  ]);
  if (rows.length !== 1) throw new WorkflowError("not_found");
  return { id: rows[0].id, tier: rows[0].disclosure_tier };
}

export function createRequestQueue(database: Database, options: { findHealthTerms?: HealthTermChecker } = {}): RequestQueue {
  // the injected checker covers the base list; the request's extra terms are always added here (A3 guards)
  const check = async (subject: string, body: string, extra: readonly string[] = []) => [
    ...new Set([
      ...await (options.findHealthTerms ?? findHealthTerms)(subject, body, extra),
      ...findExtraHealthTerms(subject, body, extra),
    ]),
  ];

  /** one transaction holding the owner-scoped row lock; returns the view read after the writes */
  async function withLockedRequest(
    userId: string,
    requestId: string,
    work: (tx: SqlRunner, row: ViewRow) => Promise<void>,
  ): Promise<RequestView> {
    const id = requireId(requestId);
    return database.transaction(async (tx) => {
      const rows = await tx.query<ViewRow>(LOCK_REQUEST, [p.uuid("user_id", userId), p.uuid("request_id", id)]);
      if (rows.length !== 1) throw new WorkflowError("not_found");
      await work(tx, rows[0]);
      return (await loadViews(tx, userId, id))[0];
    });
  }

  async function list(userId: string): Promise<RequestView[]> {
    return loadViews(database, userId, null);
  }

  return {
    list,

    async read(userId, requestId) {
      const [view] = await loadViews(database, userId, requireId(requestId));
      if (!view) throw new WorkflowError("not_found");
      return view;
    },

    async createDraft(userId, input) {
      if (!ACTIONS.has(input.action)) invalid();
      const subject = checkSubject(input.subject);
      const body = checkBody(input.body);
      const extra = checkTerms(input.extraHealthTerms, MAX_EXTRA_TERMS);
      const terms = [...new Set([...checkTerms(input.healthTermsFound), ...await check(subject, body, extra)])];
      return database.transaction(async (tx) => {
        if (input.commitmentId !== null) {
          const owned = await tx.query<{ id: string }>(OWNED_COMMITMENT, [
            p.uuid("commitment_id", requireId(input.commitmentId)),
            p.uuid("user_id", userId),
          ]);
          if (owned.length !== 1) throw new WorkflowError("not_found");
        }
        const contact = await ownedContact(tx, userId, input.contactId);
        const rows = await tx.query<{ id: string }>(INSERT_REQUEST, [
          p.uuid("user_id", userId),
          p.text("commitment_id", input.commitmentId),
          p.uuid("contact_id", contact.id),
          p.text("action", input.action),
          p.text("subject", subject),
          p.text("body", body),
          p.text("tier", contact.tier),
          p.text("terms", JSON.stringify(terms)),
          p.text("extra", JSON.stringify(extra)),
        ]);
        const id = rows[0].id;
        // the user picked the action, so the draft goes straight to the queue (section 4 transition table)
        await transition(tx, id, { from: "draft", to: "awaiting_approval", kind: "user_manual", ref: null, actor: "user" });
        return (await loadViews(tx, userId, id))[0];
      });
    },

    async edit(userId, input) {
      return withLockedRequest(userId, input.requestId, async (tx, row) => {
        if (!EDITABLE.has(row.state)) throw new WorkflowError("state_conflict");
        const subject = input.subject === undefined ? row.draft_subject ?? "" : checkSubject(input.subject);
        const body = input.body === undefined ? row.draft_body ?? "" : checkBody(input.body);
        // the tier starts as the contact group's; the owner may choose another one for this request, and the revision
        // and the approval hash both cover it, so any change needs a fresh approval
        const contact = await ownedContact(tx, userId, input.contactId ?? row.contact_id);
        const contactChanged = contact.id !== row.contact_id;
        const tier = input.disclosureTier !== undefined
          ? checkTier(input.disclosureTier)
          : contactChanged ? contact.tier : row.disclosure_tier;
        const keepExtra = input.extraHealthTerms === undefined;
        const extra = keepExtra ? parseTerms(row.extra_terms_json) : checkTerms(input.extraHealthTerms, MAX_EXTRA_TERMS);
        let respondBy: Date | null = null;
        if (typeof input.respondBy === "string") {
          const at = input.respondBy;
          if (!/(Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) invalid();
          respondBy = new Date(at);
          if (respondBy <= (await readClock(tx)).appNow) invalid();
        } else if (input.respondBy !== undefined && input.respondBy !== null) {
          invalid();
        }
        await tx.execute(UPDATE_DRAFT, [
          p.text("subject", subject),
          p.text("body", body),
          p.uuid("contact_id", contact.id),
          p.text("tier", tier),
          p.bool("keep_respond_by", input.respondBy === undefined),
          p.ts("respond_by", respondBy),
          p.text("terms", JSON.stringify(await check(subject, body, extra))),
          p.bool("keep_extra", keepExtra),
          p.text("extra", JSON.stringify(extra)),
          p.uuid("request_id", row.id),
        ]);
        if (tier !== row.disclosure_tier) {
          await tx.execute(AUDIT_TIER, [
            p.text("actor", userId),
            p.text("request_id", row.id),
            p.text("from_tier", row.disclosure_tier),
            p.text("to_tier", tier),
          ]);
        }
        // the move back to awaiting_approval is what invalidates any earlier approval
        await transition(tx, row.id, { from: row.state, to: "awaiting_approval", kind: "user_manual", ref: null, actor: "user" });
      });
    },

    async approve(userId, requestId, ifMatch, healthOverride = false) {
      return withLockedRequest(userId, requestId, async (tx, row) => {
        const record = toRecord(row);
        // revision first, inside the lock, before any write (approval-revision.ts)
        requireApprovalRevision(record, ifMatch);
        if (record.state !== "awaiting_approval") throw new WorkflowError("state_conflict");
        const terms = await check(record.subject, record.body, parseTerms(row.extra_terms_json));
        const blocked = record.disclosureTier !== "detailed" && terms.length > 0;
        if (blocked && !healthOverride) throw new HealthTermsError(terms);
        await tx.execute(SAVE_APPROVAL_CHECK, [
          p.text("terms", JSON.stringify(terms)),
          p.bool("override", healthOverride),
          p.uuid("request_id", record.id),
        ]);
        if (healthOverride) {
          // ids and counts only; the terms themselves stay on the request row
          await tx.execute(AUDIT_OVERRIDE, [
            p.text("actor", userId),
            p.text("request_id", record.id),
            p.int("term_count", terms.length),
            p.text("tier", record.disclosureTier),
          ]);
        }
        // the hash covers server-loaded recipient, subject, body and tier only (lib/state.ts)
        await transition(tx, record.id, {
          from: "awaiting_approval", to: "approved", kind: "approval", ref: approvalHash(record), actor: "user",
        });
      });
    },

    async cancel(userId, requestId) {
      return withLockedRequest(userId, requestId, async (tx, row) => {
        if (!CANCELLABLE.has(row.state)) throw new WorkflowError("state_conflict");
        await transition(tx, row.id, { from: row.state, to: "cancelled", kind: "user_manual", ref: null, actor: "user" });
      });
    },

    async refresh(userId) {
      const expiredRequestIds = await sweepExpired(database, userId);
      return { requests: await list(userId), expiredRequestIds };
    },

    async extraHealthTerms(userId, requestId) {
      if (typeof requestId !== "string" || !UUID.test(requestId)) return [];
      const rows = await database.query<{ extra_terms_json: string }>(EXTRA_TERMS, [
        p.uuid("user_id", userId),
        p.uuid("request_id", requestId.toLowerCase()),
      ]);
      return parseTerms(rows[0]?.extra_terms_json);
    },
  };
}
