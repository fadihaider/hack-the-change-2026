// texts through the request state machine (docs/INTEGRATIONS.md "SMS"): approve exact words and number, then send.
// awaiting_approval -> approved (approval hash) -> sending -> requested (submitted, sms_message_sid evidence)
//   -> completed (delivered) | failed (undelivered, failed or refused). a timeout stays sending, never re-sent.
// every query is owner-scoped; email queries join contact, which an sms row never has, so they never see these rows.
import "server-only";
import { p, type Database, type SqlRunner } from "../db.ts";
import { WorkflowError } from "../requests/workflow.ts";
import { approvalHash, type DisclosureTier, type EvidenceKind, type RequestState } from "../state.ts";
import { HealthTermsError } from "../store/requestQueue.ts";
import { maskPhone } from "./phone.ts";
import { FINAL_STATUSES, SmsSendError, type SmsMode, type SmsProvider } from "./provider.ts";

/** what the browser shows; the full number never leaves the server once it is saved */
export type SmsDelivery =
  | "not_sent" | "needs_review" | "sending" | "unconfirmed" | "submitted" | "sent" | "delivered" | "failed" | "simulated";

export interface SmsView {
  id: string;
  episodeId: string | null;
  state: RequestState;
  delivery: SmsDelivery;
  recipient: { label: string; phoneMasked: string };
  senderName: string | null;
  body: string;
  disclosureTier: DisclosureTier;
  healthTermsFound: string[];
  healthOverride: boolean;
  provider: SmsMode | null;
  /** Twilio's message SID, or demo_<id> for a simulated text */
  providerMessageId: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  submittedAt: string | null;
  statusAt: string | null;
  approvedAt: string | null;
  updatedAt: string;
}

export interface NewSms {
  userId: string;
  /** one compose session in the browser; the same key again returns the row it made */
  clientKey: string;
  episodeId: string | null;
  phone: string;
  label: string;
  senderName: string | null;
  body: string;
  tier: DisclosureTier;
  healthOverride: boolean;
  /** the intake reason and medical facts as extra health words; never sent to the browser */
  extraHealthTerms: readonly string[];
  findHealthTerms(subject: string, body: string, extra?: readonly string[]): string[] | Promise<string[]>;
}

interface SmsRow {
  id: string;
  user_id: string;
  episode_id: string | null;
  state: RequestState;
  recipient_phone: string;
  recipient_label: string | null;
  sender_name: string | null;
  draft_body: string;
  disclosure_tier: DisclosureTier;
  health_terms_json: string;
  health_override: boolean;
  sms_provider: SmsMode | null;
  sms_sid: string | null;
  sms_status: string | null;
  sms_error_code: string | null;
  sms_submitted_at: string | null;
  sms_status_at: string | null;
  sms_client_key: string | null;
  updated_at: string;
  approval_id: string | null;
  approval_hash: string | null;
  approved_at: string | null;
}

const COLUMNS = `r.id::text AS id, r.user_id::text AS user_id, r.episode_id::text AS episode_id, r.state,
  r.recipient_phone, r.recipient_label, r.sender_name, r.draft_body, r.disclosure_tier,
  array_to_json(coalesce(r.health_terms_found, '{}'))::text AS health_terms_json, r.health_override,
  r.sms_provider, r.sms_sid, r.sms_status, r.sms_error_code, r.sms_client_key,
  to_json(r.sms_submitted_at)#>>'{}' AS sms_submitted_at, to_json(r.sms_status_at)#>>'{}' AS sms_status_at,
  to_json(r.updated_at)#>>'{}' AS updated_at,
  a.id AS approval_id, a.evidence_ref AS approval_hash, to_json(a.at)#>>'{}' AS approved_at`;

// the approval that moved the request to approved most recently, as in lib/store/workflowStore.ts
const LATEST_APPROVAL = `LEFT JOIN LATERAL (SELECT e.id::text AS id, e.evidence_ref, e.at FROM request_event e
    WHERE e.request_id = r.id AND e.evidence_kind = 'approval' AND e.to_state = 'approved'
    ORDER BY e.id DESC LIMIT 1) a ON true`;

const OWNED = `FROM request r ${LATEST_APPROVAL}
  WHERE r.user_id = CAST(:user_id AS uuid) AND r.channel = 'sms'`;

const LIST = `SELECT ${COLUMNS} ${OWNED}
  AND (CAST(:episode_id AS uuid) IS NULL OR r.episode_id = CAST(:episode_id AS uuid))
  ORDER BY r.updated_at DESC, r.id LIMIT 50`;

const LOCK = `SELECT ${COLUMNS} ${OWNED} AND r.id = CAST(:request_id AS uuid) FOR UPDATE OF r`;

const BY_CLIENT_KEY = `SELECT ${COLUMNS} ${OWNED} AND r.sms_client_key = :client_key`;

const OWNED_EPISODE = `SELECT id::text AS id FROM care_episode WHERE id = CAST(:episode_id AS uuid) AND user_id = CAST(:user_id AS uuid)`;

const INSERT = `INSERT INTO request (user_id, channel, episode_id, recipient_phone, recipient_label, sender_name, action,
    draft_subject, draft_body, disclosure_tier, health_terms_found, health_override, state, sms_client_key)
  VALUES (CAST(:user_id AS uuid), 'sms', CAST(:episode_id AS uuid), :phone, :label, :sender_name, 'notify', '', :body,
    :tier, ARRAY(SELECT jsonb_array_elements_text(CAST(:terms AS jsonb))), :override, 'draft', :client_key)
  ON CONFLICT (user_id, sms_client_key) WHERE sms_client_key IS NOT NULL DO NOTHING
  RETURNING id::text AS id`;

const TRANSITION = `UPDATE request SET state = :to_state, updated_at = now()
  WHERE id = CAST(:request_id AS uuid) AND state = :from_state AND channel = 'sms'`;

const INSERT_EVENT = `INSERT INTO request_event (request_id, from_state, to_state, evidence_kind, evidence_ref, actor)
  VALUES (CAST(:request_id AS uuid), :from_state, :to_state, :evidence_kind, :evidence_ref, :actor)`;

const SAVE_PROVIDER = `UPDATE request SET sms_provider = :provider, sms_sid = COALESCE(:sid, sms_sid),
    sms_status = :status, sms_error_code = :error_code, sms_status_at = now(),
    sms_submitted_at = CASE WHEN :submitted THEN now() ELSE sms_submitted_at END, updated_at = now()
  WHERE id = CAST(:request_id AS uuid) AND channel = 'sms'`;

const AUDIT_OVERRIDE = `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
  VALUES (:actor, 'health_override', 'request', :request_id,
    jsonb_build_object('term_count', CAST(:term_count AS int), 'tier', :tier, 'channel', 'sms'))`;

// texts still moving at the provider, checked again only if the last check is a few seconds old
const PENDING = `SELECT r.id::text AS id, r.sms_sid FROM request r
  WHERE r.user_id = CAST(:user_id AS uuid) AND r.channel = 'sms' AND r.state = 'requested' AND r.sms_provider = 'twilio'
    AND r.sms_sid IS NOT NULL AND (r.sms_status_at IS NULL OR r.sms_status_at < now() - interval '3 seconds')
  ORDER BY r.sms_submitted_at DESC NULLS LAST LIMIT 10`;

/** the approval hash input for a text: the "sms:" prefix keeps a phone number apart from any email address */
export function smsApprovedContent(row: { recipient_phone: string; draft_body: string; disclosure_tier: DisclosureTier }) {
  return { recipientEmail: `sms:${row.recipient_phone}`, subject: "", body: row.draft_body, disclosureTier: row.disclosure_tier };
}

const QUEUED = new Set(["queued", "accepted", "scheduled", "sending"]);

export function deliveryOf(row: Pick<SmsRow, "state" | "sms_provider" | "sms_status">): SmsDelivery {
  switch (row.state) {
    case "completed":
      return "delivered";
    case "failed":
      return "failed";
    case "needs_review":
      return "needs_review";
    case "sending":
      return row.sms_status === "unconfirmed" ? "unconfirmed" : "sending";
    case "requested":
      if (row.sms_provider === "demo") return "simulated";
      if (row.sms_status === "sent") return "sent";
      return QUEUED.has(row.sms_status ?? "queued") ? "submitted" : "sent";
    default:
      return "not_sent";
  }
}

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

function toView(row: SmsRow): SmsView {
  return {
    id: row.id,
    episodeId: row.episode_id,
    state: row.state,
    delivery: deliveryOf(row),
    recipient: { label: row.recipient_label || "Text", phoneMasked: maskPhone(row.recipient_phone) },
    senderName: row.sender_name,
    body: row.draft_body,
    disclosureTier: row.disclosure_tier,
    healthTermsFound: JSON.parse(row.health_terms_json) as string[],
    healthOverride: row.health_override,
    provider: row.sms_provider,
    providerMessageId: row.sms_sid,
    providerStatus: row.sms_status,
    errorCode: row.sms_error_code,
    submittedAt: iso(row.sms_submitted_at),
    statusAt: iso(row.sms_status_at),
    approvedAt: iso(row.approved_at),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

async function move(
  tx: SqlRunner,
  requestId: string,
  change: { from: RequestState; to: RequestState; kind: EvidenceKind; ref: string | null; actor: "user" | "system" },
): Promise<void> {
  if (change.from !== change.to) {
    const changed = await tx.execute(TRANSITION, [
      p.uuid("request_id", requestId), p.text("from_state", change.from), p.text("to_state", change.to),
    ]);
    if (changed !== 1) throw new WorkflowError("state_conflict");
  }
  await tx.execute(INSERT_EVENT, [
    p.uuid("request_id", requestId), p.text("from_state", change.from), p.text("to_state", change.to),
    p.text("evidence_kind", change.kind), p.text("evidence_ref", change.ref), p.text("actor", change.actor),
  ]);
}

async function lockOwned(tx: SqlRunner, userId: string, requestId: string): Promise<SmsRow> {
  const rows = await tx.query<SmsRow>(LOCK, [p.uuid("user_id", userId), p.uuid("request_id", requestId)]);
  if (!rows[0]) throw new WorkflowError("not_found");
  return rows[0];
}

export interface SmsStore {
  list(userId: string, episodeId: string | null): Promise<SmsView[]>;
  /** saves the exact text and number and records the approval in one transaction; a repeat key returns the same row */
  createApproved(input: NewSms): Promise<SmsView>;
  /** approved -> sending -> requested | failed; a second call finds it no longer approved (409 state_conflict) */
  send(input: {
    userId: string;
    requestId: string;
    provider: SmsProvider;
    extraHealthTerms: readonly string[];
    findHealthTerms: NewSms["findHealthTerms"];
  }): Promise<SmsView>;
  /** asks Twilio about texts still moving and records any change; provider errors leave the rows as they are */
  refresh(userId: string, provider: SmsProvider): Promise<number>;
}

export function createSmsStore(database: Database): SmsStore {
  async function read(sql: SqlRunner, userId: string, requestId: string): Promise<SmsView> {
    const rows = await sql.query<SmsRow>(`SELECT ${COLUMNS} ${OWNED} AND r.id = CAST(:request_id AS uuid)`, [
      p.uuid("user_id", userId), p.uuid("request_id", requestId),
    ]);
    if (!rows[0]) throw new WorkflowError("not_found");
    return toView(rows[0]);
  }

  return {
    async list(userId, episodeId) {
      const rows = await database.query<SmsRow>(LIST, [p.uuid("user_id", userId), p.text("episode_id", episodeId)]);
      return rows.map(toView);
    },

    async createApproved(input) {
      const terms = [...new Set(await input.findHealthTerms("", input.body, input.extraHealthTerms))];
      // the same privacy rule as email: health words need detailed sharing or an explicit "send anyway"
      if (input.tier !== "detailed" && terms.length > 0 && !input.healthOverride) throw new HealthTermsError(terms);
      return database.transaction(async (tx) => {
        const owner = p.uuid("user_id", input.userId);
        if (input.episodeId) {
          const episode = await tx.query(OWNED_EPISODE, [owner, p.uuid("episode_id", input.episodeId)]);
          if (episode.length === 0) throw new WorkflowError("not_found");
        }
        const inserted = await tx.query<{ id: string }>(INSERT, [
          owner, p.text("episode_id", input.episodeId), p.text("phone", input.phone), p.text("label", input.label),
          p.text("sender_name", input.senderName), p.text("body", input.body), p.text("tier", input.tier),
          p.text("terms", JSON.stringify(terms)), p.bool("override", input.healthOverride && terms.length > 0),
          p.text("client_key", input.clientKey),
        ]);
        if (!inserted[0]) {
          // a repeated click: the first one already approved this; anything else under the same key is refused
          const [existing] = await tx.query<SmsRow>(BY_CLIENT_KEY, [owner, p.text("client_key", input.clientKey)]);
          if (!existing || existing.recipient_phone !== input.phone || existing.draft_body !== input.body
            || existing.disclosure_tier !== input.tier) {
            throw new WorkflowError("state_conflict");
          }
          return toView(existing);
        }
        const id = inserted[0].id;
        await move(tx, id, { from: "draft", to: "awaiting_approval", kind: "user_manual", ref: "sms written", actor: "user" });
        const hash = approvalHash(smsApprovedContent({ recipient_phone: input.phone, draft_body: input.body, disclosure_tier: input.tier }));
        await move(tx, id, { from: "awaiting_approval", to: "approved", kind: "approval", ref: hash, actor: "user" });
        if (input.healthOverride && terms.length > 0) {
          await tx.execute(AUDIT_OVERRIDE, [
            p.text("actor", input.userId), p.text("request_id", id), p.int("term_count", terms.length), p.text("tier", input.tier),
          ]);
        }
        return read(tx, input.userId, id);
      });
    },

    async send(input) {
      const prepared = await database.transaction(async (tx) => {
        const row = await lockOwned(tx, input.userId, input.requestId);
        if (row.state !== "approved") throw new WorkflowError("state_conflict");
        const hits = await input.findHealthTerms("", row.draft_body, input.extraHealthTerms);
        const hashMatches = row.approval_hash !== null && row.approval_hash === approvalHash(smsApprovedContent(row));
        if (!hashMatches || (row.disclosure_tier !== "detailed" && hits.length > 0 && !row.health_override)) {
          await move(tx, row.id, {
            from: "approved", to: "needs_review", kind: "error",
            ref: hashMatches ? "health term at send" : "approval hash mismatch", actor: "system",
          });
          return null;
        }
        await move(tx, row.id, { from: "approved", to: "sending", kind: "approval", ref: row.approval_id, actor: "system" });
        await tx.execute(SAVE_PROVIDER, [
          p.uuid("request_id", row.id), p.text("provider", input.provider.mode), p.text("sid", null),
          p.text("status", null), p.text("error_code", null), p.bool("submitted", false),
        ]);
        return { to: row.recipient_phone, body: row.draft_body };
      });
      if (!prepared) return read(database, input.userId, input.requestId);

      const mode = input.provider.mode;
      try {
        const sent = await input.provider.submit({ userId: input.userId, requestId: input.requestId, ...prepared });
        await database.transaction(async (tx) => {
          await lockOwned(tx, input.userId, input.requestId);
          await move(tx, input.requestId, { from: "sending", to: "requested", kind: "sms_message_sid", ref: sent.sid, actor: "system" });
          await tx.execute(SAVE_PROVIDER, [
            p.uuid("request_id", input.requestId), p.text("provider", mode), p.text("sid", sent.sid),
            p.text("status", sent.status), p.text("error_code", null), p.bool("submitted", true),
          ]);
        });
      } catch (error) {
        const failure = error instanceof SmsSendError ? error : new SmsSendError("sms_send_failed", true);
        await database.transaction(async (tx) => {
          await lockOwned(tx, input.userId, input.requestId);
          if (failure.definite) {
            await move(tx, input.requestId, { from: "sending", to: "failed", kind: "error", ref: failure.code, actor: "system" });
          } else {
            // it may have gone out: stays sending so nobody sends it twice by accident
            await move(tx, input.requestId, { from: "sending", to: "sending", kind: "error", ref: failure.code, actor: "system" });
          }
          await tx.execute(SAVE_PROVIDER, [
            p.uuid("request_id", input.requestId), p.text("provider", mode), p.text("sid", null),
            p.text("status", failure.definite ? "failed" : "unconfirmed"), p.text("error_code", failure.code),
            p.bool("submitted", false),
          ]);
        });
      }
      return read(database, input.userId, input.requestId);
    },

    async refresh(userId, provider) {
      if (provider.mode !== "twilio") return 0;
      const pending = await database.query<{ id: string; sms_sid: string }>(PENDING, [p.uuid("user_id", userId)]);
      let changed = 0;
      for (const { id, sms_sid: sid } of pending) {
        let reading;
        try {
          reading = await provider.status(sid);
        } catch {
          // Twilio unreachable: keep what is stored and try again on the next check
          continue;
        }
        if (!reading) continue;
        await database.transaction(async (tx) => {
          const row = await lockOwned(tx, userId, id);
          if (row.state !== "requested" || row.sms_sid !== sid) return;
          const status = reading.status;
          const delivered = status === "delivered" || status === "read";
          const failed = FINAL_STATUSES.has(status) && !delivered;
          const errorCode = failed ? `twilio_${reading.errorCode ?? status}` : null;
          if (status !== row.sms_status) {
            const to: RequestState = delivered ? "completed" : failed ? "failed" : "requested";
            await move(tx, id, {
              from: "requested", to, kind: "sms_status",
              ref: errorCode ? `${status}:${reading.errorCode ?? ""}` : status, actor: "system",
            });
            changed += 1;
          }
          await tx.execute(SAVE_PROVIDER, [
            p.uuid("request_id", id), p.text("provider", "twilio"), p.text("sid", null), p.text("status", status),
            p.text("error_code", errorCode), p.bool("submitted", false),
          ]);
        });
      }
      return changed;
    },
  };
}
