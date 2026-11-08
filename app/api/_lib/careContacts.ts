// care mode: trusted contacts the caregiver typed in (PRD 9) and user-recorded timeline completions (PRD 8)
import "server-only";
import { z } from "zod";
import { p } from "../../../lib/db.ts";
import { isIsoDate } from "../../../lib/ai/time.ts";
import type { SessionUser } from "../../../lib/mvp/auth.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { loadRecipient } from "./context.ts";
import { ApiError, requireUuid } from "./http.ts";
import { occurrenceOn } from "./rrule.ts";

// ---------- trusted contacts ----------

export type CareContactKind = "emergency" | "trusted";

export interface CareContactView {
  id: string;
  name: string;
  relationship: string | null;
  phone: string;
  kind: CareContactKind;
  createdAt: string;
}

interface ContactRow {
  id: string;
  name: string;
  relationship: string | null;
  phone: string;
  kind: CareContactKind;
  created_at: string;
}

/** active contacts a recipient may have; a guard against runaway inserts, far above any real household */
export const MAX_CARE_CONTACTS = 50;

const PHONE_CHARS = /^[0-9 +\-().]+$/;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

/** trims and collapses runs of spaces; text with control or format characters is refused, not cleaned */
const plainText = (max: number, min: number) =>
  z
    .string()
    .max(max * 2)
    .refine((value) => !CONTROL.test(value))
    .transform((value) => value.trim().replace(/ {2,}/g, " "))
    .pipe(z.string().min(min).max(max));

/** POST /api/care/contacts body; the phone keeps the caregiver's own formatting */
export const contactInputSchema = z.strictObject({
  name: plainText(80, 1),
  relationship: plainText(60, 0)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null)),
  phone: z
    .string()
    .max(40)
    .transform((value) => value.trim().replace(/ {2,}/g, " "))
    .pipe(
      z
        .string()
        .regex(PHONE_CHARS)
        .refine((value) => digitCount(value) >= 3 && digitCount(value) <= 20),
    ),
  kind: z.enum(["emergency", "trusted"]),
});
export type CareContactInput = z.output<typeof contactInputSchema>;

const CONTACT_COLUMNS = `id::text AS id, name, relationship, phone, kind, to_json(created_at)#>>'{}' AS created_at`;

const LIST_CONTACTS = `SELECT ${CONTACT_COLUMNS} FROM care_contact
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND removed_at IS NULL
  ORDER BY CASE kind WHEN 'emergency' THEN 0 ELSE 1 END, created_at, id`;

const COUNT_CONTACTS = `SELECT count(*)::int AS n FROM care_contact
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND removed_at IS NULL`;

const INSERT_CONTACT = `INSERT INTO care_contact (care_recipient_id, name, relationship, phone, kind)
  VALUES (CAST(:recipient_id AS uuid), :name, :relationship, :phone, :kind)
  RETURNING ${CONTACT_COLUMNS}`;

const REMOVE_CONTACT = `UPDATE care_contact SET removed_at = now()
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid) AND removed_at IS NULL
  RETURNING id::text AS id, kind`;

// the phone number and name never go into the audit detail
const AUDIT_CONTACT = `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
  VALUES (:actor, :action, 'care_contact', :contact_id,
    jsonb_build_object('kind', CAST(:kind AS text), 'care_recipient_id', CAST(:recipient_id AS text)))`;

function toContact(row: ContactRow): CareContactView {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    phone: row.phone,
    kind: row.kind,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** the owner's active contacts: emergency first, then trusted, each oldest first */
export async function listCareContacts(rt: Runtime, user: SessionUser): Promise<{ contacts: CareContactView[] }> {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const rows = await database.query<ContactRow>(LIST_CONTACTS, [p.uuid("recipient_id", recipient.id)]);
  return { contacts: rows.map(toContact) };
}

/** saves exactly what the caregiver typed; nothing here is inferred from notes or a model */
export async function addCareContact(rt: Runtime, user: SessionUser, input: CareContactInput): Promise<{ contact: CareContactView }> {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const row = await database.transaction(async (tx) => {
    const counted = await tx.query<{ n: number }>(COUNT_CONTACTS, [p.uuid("recipient_id", recipient.id)]);
    if ((counted[0]?.n ?? 0) >= MAX_CARE_CONTACTS) throw new ApiError(409, "contact_limit");
    const inserted = await tx.query<ContactRow>(INSERT_CONTACT, [
      p.uuid("recipient_id", recipient.id),
      p.text("name", input.name),
      p.text("relationship", input.relationship),
      p.text("phone", input.phone),
      p.text("kind", input.kind),
    ]);
    await tx.execute(AUDIT_CONTACT, [
      p.text("actor", user.id),
      p.text("action", "care_contact_added"),
      p.text("contact_id", inserted[0].id),
      p.text("kind", input.kind),
      p.text("recipient_id", recipient.id),
    ]);
    return inserted[0];
  });
  return { contact: toContact(row) };
}

/** soft delete; a foreign, unknown or already removed id is a 404 */
export async function removeCareContact(rt: Runtime, user: SessionUser, contactId: string): Promise<{ removed: true }> {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const id = requireUuid(contactId);
  await database.transaction(async (tx) => {
    const rows = await tx.query<{ id: string; kind: CareContactKind }>(REMOVE_CONTACT, [
      p.uuid("id", id),
      p.uuid("recipient_id", recipient.id),
    ]);
    if (!rows[0]) throw new ApiError(404, "not_found");
    await tx.execute(AUDIT_CONTACT, [
      p.text("actor", user.id),
      p.text("action", "care_contact_removed"),
      p.text("contact_id", rows[0].id),
      p.text("kind", rows[0].kind),
      p.text("recipient_id", recipient.id),
    ]);
  });
  return { removed: true };
}

// ---------- timeline completions ----------

/** POST /api/care/events/[id]/complete body */
export const completionInputSchema = z.strictObject({
  date: z.string().refine((value) => isIsoDate(value)),
  done: z.boolean(),
});
export type CompletionInput = z.output<typeof completionInputSchema>;

export interface CompletionView {
  eventId: string;
  date: string;
  /** when the caregiver marked this occurrence done (app clock), or null; never inferred from viewing */
  completedAt: string | null;
}

// same visibility rule as the timeline: approved events whose fact (if any) is approved, Urgent appointments included
const COMPLETION_EVENT = `SELECT e.id::text AS id, e.status, to_json(e.starts_at)#>>'{}' AS starts_at, e.rrule,
    e.fact_id IS NULL OR f.status = 'approved' AS fact_approved
  FROM care_event e LEFT JOIN care_fact f ON f.id = e.fact_id
  WHERE e.id = CAST(:event_id AS uuid) AND e.care_recipient_id = CAST(:recipient_id AS uuid)
  FOR UPDATE OF e`;

const INSERT_COMPLETION = `INSERT INTO usage_signal (care_event_id, kind, value, at)
  SELECT CAST(:event_id AS uuid), 'completed', CAST(:day AS text), CAST(:at AS timestamptz)
  WHERE NOT EXISTS (SELECT 1 FROM usage_signal
    WHERE care_event_id = CAST(:event_id AS uuid) AND kind = 'completed' AND value = :day)
  ON CONFLICT DO NOTHING`;

const DELETE_COMPLETION = `DELETE FROM usage_signal
  WHERE care_event_id = CAST(:event_id AS uuid) AND kind = 'completed' AND value = :day`;

const READ_COMPLETION = `SELECT to_json(min(at))#>>'{}' AS at FROM usage_signal
  WHERE care_event_id = CAST(:event_id AS uuid) AND kind = 'completed' AND value = :day`;

/**
 * records (done=true) or clears (done=false) the caregiver's own "done" for one occurrence. the event must be the
 * owner's, approved and scheduled on that Alberta date; repeating a call changes nothing.
 */
export async function completeCareEvent(
  rt: Runtime,
  user: SessionUser,
  eventId: string,
  input: CompletionInput,
): Promise<CompletionView> {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const id = requireUuid(eventId);
  const appNow = await rt.stores.appNow(user.id);
  const params = [p.uuid("event_id", id), p.text("day", input.date)];
  const completedAt = await database.transaction(async (tx) => {
    const rows = await tx.query<{ id: string; status: string; starts_at: string | null; rrule: string | null; fact_approved: boolean }>(
      COMPLETION_EVENT,
      [p.uuid("event_id", id), p.uuid("recipient_id", recipient.id)],
    );
    const event = rows[0];
    if (!event) throw new ApiError(404, "not_found");
    if (event.status !== "approved" || !event.fact_approved) throw new ApiError(409, "state_conflict");
    if (event.starts_at === null || occurrenceOn(event.starts_at, event.rrule, input.date) === null) {
      throw new ApiError(409, "not_scheduled");
    }
    if (input.done) {
      await tx.execute(INSERT_COMPLETION, [...params, p.ts("at", appNow)]);
    } else {
      await tx.execute(DELETE_COMPLETION, params);
    }
    const found = await tx.query<{ at: string | null }>(READ_COMPLETION, params);
    return found[0]?.at ?? null;
  });
  return { eventId: id, date: input.date, completedAt: completedAt === null ? null : new Date(completedAt).toISOString() };
}
