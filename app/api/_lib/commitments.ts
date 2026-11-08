// U3 impact scan and U4 decisions: calendar events become commitments, decisions become drafted requests
import "server-only";
import { p, type SqlRunner } from "../../../lib/db.ts";
import { albertaDay, runDrafter } from "../../../lib/ai/drafter.ts";
import {
  applyImpactGuards,
  createsRequest,
  isCareRecipientEvent,
  runImpact,
  type CommitmentDecision,
  type ImpactInput,
  type ImpactResult,
} from "../../../lib/ai/impact.ts";
import { ModelCallError, NeedsReviewError } from "../../../lib/ai/model.ts";
import { addDays } from "../../../lib/ai/time.ts";
import type { CalendarEvent } from "../../../lib/google.ts";
import type { SessionUser } from "../../../lib/mvp/auth.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import type { RequestView } from "../../../lib/frontend/request-api.ts";
import {
  albertaMidnight,
  loadEpisode,
  recipientAliases,
  relationshipFor,
  reserveModel,
  type Episode,
} from "./context.ts";
import { ApiError, requireUuid } from "./http.ts";

export interface Attendee {
  email: string;
  responseStatus: string | null;
}

export interface DependencyView {
  id: string;
  toKind: string | null;
  toRef: string | null;
  /** model note, labelled as such in the UI */
  evidence: string;
  origin: "rule" | "model" | "user";
  confirmed: boolean;
  /** the owner's contact with this email, when there is one */
  contactId: string | null;
}

export interface CommitmentView {
  id: string;
  sourceId: string | null;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  organizerEmail: string | null;
  attendees: Attendee[];
  /** code-rule reason; the model can't remove it */
  conflictReason: string | null;
  ruleConflicts: string[];
  /** the saved user decision */
  decision: CommitmentDecision | null;
  /** A2 preselection only */
  suggestedAction: CommitmentDecision | null;
  /** the care recipient's own commitment: keep, and offer "Add to care timeline" */
  forCareRecipient: boolean;
  dependencies: DependencyView[];
  /** contact a request would go to when decide gets no contactId */
  suggestedContactId: string | null;
  requests: { id: string; state: string; contactId: string | null }[];
}

export interface ImpactResponse {
  episode: { id: string; startsOn: string; endsOn: string };
  commitments: CommitmentView[];
  /** "unavailable" when A2 failed; rule conflicts are still shown */
  modelStatus: "ok" | "unavailable";
}

interface OwnedContact {
  id: string;
  name: string;
  email: string;
  tier: "minimal" | "general" | "detailed";
}

const CONTACTS = `SELECT c.id::text AS id, c.name, c.email, g.disclosure_tier
  FROM contact c JOIN contact_group g ON g.id = c.group_id
  WHERE g.user_id = CAST(:user_id AS uuid)
  ORDER BY g.name, c.name`;

async function loadContacts(sql: SqlRunner, userId: string): Promise<OwnedContact[]> {
  const rows = await sql.query<{ id: string; name: string; email: string; disclosure_tier: OwnedContact["tier"] }>(
    CONTACTS,
    [p.uuid("user_id", userId)],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, email: row.email, tier: row.disclosure_tier }));
}

function byEmail(contacts: OwnedContact[]): Map<string, OwnedContact> {
  const map = new Map<string, OwnedContact>();
  for (const contact of contacts) {
    const key = contact.email.trim().toLowerCase();
    if (!map.has(key)) map.set(key, contact);
  }
  return map;
}

/** confirmed dependencies first, then model ones, then the organizer, then attendees; never the owner */
function pickContact(
  contacts: Map<string, OwnedContact>,
  ownerEmail: string,
  candidates: { dependencies: { toRef: string | null; confirmed: boolean }[]; organizerEmail: string | null; attendees: Attendee[] },
): OwnedContact | null {
  const ordered = [
    ...candidates.dependencies.filter((d) => d.confirmed).map((d) => d.toRef),
    ...candidates.dependencies.filter((d) => !d.confirmed).map((d) => d.toRef),
    candidates.organizerEmail,
    ...candidates.attendees.map((a) => a.email),
  ];
  const owner = ownerEmail.toLowerCase();
  for (const email of ordered) {
    const key = email?.trim().toLowerCase();
    if (!key || key === owner) continue;
    const contact = contacts.get(key);
    if (contact) return contact;
  }
  return null;
}

// ---------- impact scan ----------

interface ScannedEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  organizerEmail: string | null;
  attendees: Attendee[];
}

function eventTime(value: CalendarEvent["start"]): string | null {
  if (value?.dateTime) {
    const ms = Date.parse(value.dateTime);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  // an all-day event starts at midnight Alberta Time
  if (value?.date && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) return albertaMidnight(value.date).toISOString();
  return null;
}

function scanEvent(event: CalendarEvent): ScannedEvent | null {
  const startsAt = eventTime(event.start);
  if (!event.id || startsAt === null || event.status === "cancelled") return null;
  return {
    id: event.id.slice(0, 200),
    title: (event.summary ?? "").trim().slice(0, 300) || "(no title)",
    startsAt,
    endsAt: eventTime(event.end),
    location: event.location?.trim().slice(0, 300) || null,
    organizerEmail: event.organizer?.email?.trim() || null,
    attendees: (event.attendees ?? [])
      .filter((attendee) => attendee.email)
      .map((attendee) => ({ email: attendee.email!.trim(), responseStatus: attendee.responseStatus ?? null })),
  };
}

const FIND_COMMITMENT = `SELECT id::text AS id FROM commitment
  WHERE user_id = CAST(:user_id AS uuid) AND episode_id = CAST(:episode_id AS uuid)
    AND source = 'calendar' AND source_id = :source_id
  ORDER BY id LIMIT 1 FOR UPDATE`;

const UPDATE_COMMITMENT = `UPDATE commitment SET title = :title, starts_at = CAST(:starts_at AS timestamptz),
    ends_at = CAST(:ends_at AS timestamptz), location = :location, organizer_email = :organizer_email,
    attendees = CAST(:attendees AS jsonb), conflict_reason = :conflict_reason
  WHERE id = CAST(:id AS uuid)`;

const INSERT_COMMITMENT = `INSERT INTO commitment (user_id, episode_id, source, source_id, title, starts_at, ends_at,
    location, organizer_email, attendees, conflict_reason)
  VALUES (CAST(:user_id AS uuid), CAST(:episode_id AS uuid), 'calendar', :source_id, :title,
    CAST(:starts_at AS timestamptz), CAST(:ends_at AS timestamptz), :location, :organizer_email,
    CAST(:attendees AS jsonb), :conflict_reason)
  RETURNING id::text AS id`;

const CLEAR_MODEL_DEPENDENCIES = `DELETE FROM dependency
  WHERE from_commitment = CAST(:commitment_id AS uuid) AND origin = 'model' AND confirmed = false`;

const INSERT_DEPENDENCY = `INSERT INTO dependency (from_commitment, to_kind, to_ref, evidence, origin, confirmed)
  VALUES (CAST(:commitment_id AS uuid), :to_kind, :to_ref, :evidence, 'model', false)`;

const EPISODE_COMMITMENTS = `SELECT id::text AS id, source_id, title, to_json(starts_at)#>>'{}' AS starts_at,
    to_json(ends_at)#>>'{}' AS ends_at, location, organizer_email, attendees::text AS attendees_json,
    conflict_reason, decision
  FROM commitment
  WHERE user_id = CAST(:user_id AS uuid) AND episode_id = CAST(:episode_id AS uuid) AND source = 'calendar'
  ORDER BY starts_at, id`;

const EPISODE_DEPENDENCIES = `SELECT d.id::text AS id, d.from_commitment::text AS commitment_id, d.to_kind, d.to_ref,
    d.evidence, d.origin, d.confirmed
  FROM dependency d JOIN commitment c ON c.id = d.from_commitment
  WHERE c.user_id = CAST(:user_id AS uuid) AND c.episode_id = CAST(:episode_id AS uuid)
  ORDER BY d.confirmed DESC, d.id`;

const EPISODE_REQUESTS = `SELECT r.id::text AS id, r.commitment_id::text AS commitment_id, r.state, r.contact_id::text AS contact_id
  FROM request r JOIN commitment c ON c.id = r.commitment_id
  WHERE r.user_id = CAST(:user_id AS uuid) AND c.episode_id = CAST(:episode_id AS uuid)
  ORDER BY r.updated_at DESC`;

const GROUPS = `SELECT id::text AS id, name FROM contact_group WHERE user_id = CAST(:user_id AS uuid) ORDER BY name`;

const RECIPIENT_BY_ID = `SELECT alias, display_name FROM care_recipient
  WHERE id = CAST(:id AS uuid) AND owner_id = CAST(:user_id AS uuid)`;

interface CommitmentRow {
  id: string;
  source_id: string | null;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  organizer_email: string | null;
  attendees_json: string | null;
  conflict_reason: string | null;
  decision: CommitmentDecision | null;
}

interface DependencyRow {
  id: string;
  commitment_id: string;
  to_kind: string | null;
  to_ref: string | null;
  evidence: string;
  origin: DependencyView["origin"];
  confirmed: boolean;
}

function parseAttendees(text: string | null): Attendee[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is { email: string; responseStatus?: string | null } => typeof item?.email === "string")
      .map((item) => ({ email: item.email, responseStatus: item.responseStatus ?? null }));
  } catch {
    return [];
  }
}

function iso(text: string | null): string | null {
  return text === null ? null : new Date(text).toISOString();
}

async function aliasesFor(sql: SqlRunner, userId: string, episode: Episode): Promise<string[]> {
  const rows = await sql.query<{ alias: string; display_name: string | null }>(RECIPIENT_BY_ID, [
    p.uuid("id", episode.careRecipientId),
    p.uuid("user_id", userId),
  ]);
  return rows[0] ? recipientAliases({ alias: rows[0].alias, displayName: rows[0].display_name }) : [];
}

/** reads calendar events in the window, upserts commitments, adds rule conflicts, runs A2 and saves its dependencies */
export async function scanImpact(rt: Runtime, user: SessionUser, episodeId: string): Promise<ImpactResponse> {
  const database = rt.stores.database;
  const episode = await loadEpisode(database, user.id, episodeId);
  const windowStart = albertaMidnight(episode.startsOn);
  const windowEnd = albertaMidnight(addDays(episode.endsOn, 1));
  const raw = await rt.calendar.listEvents(user.id, windowStart, windowEnd);
  const events = raw
    .map(scanEvent)
    .filter((event): event is ScannedEvent => event !== null)
    .filter((event) => Date.parse(event.startsAt) < windowEnd.getTime() &&
      Date.parse(event.endsAt ?? event.startsAt) >= windowStart.getTime())
    .slice(0, 50);
  const reason = `Overlaps the care period, ${albertaDay(episode.startsOn)} to ${albertaDay(episode.endsOn)}.`;

  // code rules first: every event in the window conflicts with the care period
  const commitmentIds = await database.transaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const event of events) {
      const fields = [
        p.text("title", event.title),
        p.text("starts_at", event.startsAt),
        p.text("ends_at", event.endsAt),
        p.text("location", event.location),
        p.text("organizer_email", event.organizerEmail),
        p.text("attendees", JSON.stringify(event.attendees)),
        p.text("conflict_reason", reason),
      ];
      const found = await tx.query<{ id: string }>(FIND_COMMITMENT, [
        p.uuid("user_id", user.id),
        p.uuid("episode_id", episode.id),
        p.text("source_id", event.id),
      ]);
      if (found[0]) {
        await tx.execute(UPDATE_COMMITMENT, [...fields, p.uuid("id", found[0].id)]);
        ids.set(event.id, found[0].id);
      } else {
        const rows = await tx.query<{ id: string }>(INSERT_COMMITMENT, [
          ...fields,
          p.uuid("user_id", user.id),
          p.uuid("episode_id", episode.id),
          p.text("source_id", event.id),
        ]);
        ids.set(event.id, rows[0].id);
      }
    }
    return ids;
  });

  const groups = await database.query<{ id: string; name: string }>(GROUPS, [p.uuid("user_id", user.id)]);
  const aliases = await aliasesFor(database, user.id, episode);
  const input: ImpactInput = {
    events: events.map(({ id, title, startsAt, endsAt, organizerEmail, attendees }) => ({
      id, title, startsAt, endsAt, organizerEmail, attendees,
    })),
    ruleConflicts: events.map((event) => ({ eventId: event.id, reason })),
    contactGroups: groups,
    episodeStart: episode.startsOn,
    episodeEnd: episode.endsOn,
    recipientAliases: aliases,
    userEmail: user.email,
  };

  let result: ImpactResult;
  let modelStatus: ImpactResponse["modelStatus"] = "ok";
  if (events.length === 0) {
    result = { events: [], droppedDependencies: 0 };
  } else {
    const deps = await reserveModel(rt, user.id, "impact");
    try {
      result = await runImpact(input, deps);
    } catch (error) {
      if (!(error instanceof NeedsReviewError) && !(error instanceof ModelCallError)) throw error;
      // the rule conflicts stand on their own; suggestions are simply missing
      result = applyImpactGuards({ events: [] }, input);
      modelStatus = "unavailable";
    }
  }

  if (modelStatus === "ok") {
    await database.transaction(async (tx) => {
      for (const suggestion of result.events) {
        const commitmentId = commitmentIds.get(suggestion.eventId);
        if (!commitmentId) continue;
        await tx.execute(CLEAR_MODEL_DEPENDENCIES, [p.uuid("commitment_id", commitmentId)]);
        for (const dependency of suggestion.candidateDependencies) {
          await tx.execute(INSERT_DEPENDENCY, [
            p.uuid("commitment_id", commitmentId),
            p.text("to_kind", dependency.toKind),
            p.text("to_ref", dependency.toRef),
            p.text("evidence", dependency.evidenceText || "No reason given."),
          ]);
        }
      }
    });
  }

  const suggestions = new Map(result.events.map((suggestion) => [suggestion.eventId, suggestion]));
  const scanned = new Set(commitmentIds.values());
  const commitments = (await listEpisodeCommitments(database, user, episode, aliases)).filter((c) => scanned.has(c.id));
  for (const commitment of commitments) {
    const suggestion = commitment.sourceId ? suggestions.get(commitment.sourceId) : undefined;
    commitment.suggestedAction = suggestion?.suggestedAction ?? (commitment.forCareRecipient ? "keep" : null);
    commitment.ruleConflicts = suggestion?.ruleConflicts ?? (commitment.conflictReason ? [commitment.conflictReason] : []);
  }
  return {
    episode: { id: episode.id, startsOn: episode.startsOn, endsOn: episode.endsOn },
    commitments,
    modelStatus,
  };
}

/** the episode's calendar commitments with dependencies, matching contacts and existing requests */
async function listEpisodeCommitments(
  sql: SqlRunner,
  user: SessionUser,
  episode: Episode,
  aliases: string[],
): Promise<CommitmentView[]> {
  const params = [p.uuid("user_id", user.id), p.uuid("episode_id", episode.id)];
  const rows = await sql.query<CommitmentRow>(EPISODE_COMMITMENTS, params);
  const dependencyRows = await sql.query<DependencyRow>(EPISODE_DEPENDENCIES, params);
  const requestRows = await sql.query<{ id: string; commitment_id: string; state: string; contact_id: string | null }>(
    EPISODE_REQUESTS,
    params,
  );
  const contacts = byEmail(await loadContacts(sql, user.id));

  return rows.map((row) => {
    const attendees = parseAttendees(row.attendees_json);
    const dependencies = dependencyRows
      .filter((dependency) => dependency.commitment_id === row.id)
      .map((dependency) => ({
        id: dependency.id,
        toKind: dependency.to_kind,
        toRef: dependency.to_ref,
        evidence: dependency.evidence,
        origin: dependency.origin,
        confirmed: dependency.confirmed,
        contactId: contacts.get(dependency.to_ref?.trim().toLowerCase() ?? "")?.id ?? null,
      }));
    const title = row.title ?? "(no title)";
    return {
      id: row.id,
      sourceId: row.source_id,
      title,
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      location: row.location,
      organizerEmail: row.organizer_email,
      attendees,
      conflictReason: row.conflict_reason,
      ruleConflicts: row.conflict_reason ? [row.conflict_reason] : [],
      decision: row.decision,
      suggestedAction: null,
      forCareRecipient: isCareRecipientEvent({ title, attendees }, aliases),
      dependencies,
      suggestedContactId: pickContact(contacts, user.email, { dependencies, organizerEmail: row.organizer_email, attendees })?.id ?? null,
      requests: requestRows
        .filter((request) => request.commitment_id === row.id)
        .map((request) => ({ id: request.id, state: request.state, contactId: request.contact_id })),
    };
  });
}

// ---------- decide ----------

export interface DecideInput {
  commitmentId: string;
  decision: CommitmentDecision;
  contactId?: string;
  note?: string;
}

export interface DecideResponse {
  commitment: { id: string; decision: CommitmentDecision };
  request: RequestView | null;
  /** true when an open request for this commitment and contact already existed (double click guard) */
  existing: boolean;
  /** A3 guard flags: the user must edit the draft before approving */
  editFlags: string[];
  approvalBlocked: boolean;
}

interface DecideRow {
  id: string;
  title: string | null;
  starts_at: string | null;
  organizer_email: string | null;
  attendees_json: string | null;
  episode_id: string;
  starts_on: string;
  ends_on: string;
  reason_text: string | null;
  recipient_id: string;
  alias: string;
  display_name: string | null;
}

const DECIDE_COMMITMENT = `SELECT c.id::text AS id, c.title, to_json(c.starts_at)#>>'{}' AS starts_at, c.organizer_email,
    c.attendees::text AS attendees_json, e.id::text AS episode_id, e.starts_on::text AS starts_on,
    e.ends_on::text AS ends_on, e.reason_text, r.id::text AS recipient_id, r.alias, r.display_name
  FROM commitment c
  JOIN care_episode e ON e.id = c.episode_id AND e.user_id = c.user_id
  JOIN care_recipient r ON r.id = e.care_recipient_id AND r.owner_id = c.user_id
  WHERE c.id = CAST(:id AS uuid) AND c.user_id = CAST(:user_id AS uuid)`;

const SAVE_DECISION = `UPDATE commitment SET decision = :decision
  WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user_id AS uuid)`;

const OPEN_REQUEST = `SELECT id::text AS id FROM request
  WHERE user_id = CAST(:user_id AS uuid) AND commitment_id = CAST(:commitment_id AS uuid)
    AND contact_id = CAST(:contact_id AS uuid)
    AND state IN ('draft','awaiting_approval','approved','sending','requested','needs_review')
  ORDER BY updated_at DESC LIMIT 1`;

const COMMITMENT_DEPENDENCIES = `SELECT to_ref, confirmed FROM dependency
  WHERE from_commitment = CAST(:id AS uuid) ORDER BY confirmed DESC, id`;

const MEDICAL_FACTS = `SELECT text_exact FROM care_fact
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'approved' AND category = 'medical_instruction'
  ORDER BY created_at LIMIT 200`;

// everyday words that would flag ordinary drafts; the base list in lib/healthTerms.ts covers real health terms
const COMMON_WORDS = new Set([
  "about", "after", "again", "also", "anything", "around", "before", "being", "between", "could", "daily", "doctor",
  "during", "every", "first", "follow", "going", "having", "heavier", "helping", "home", "hours", "least", "minutes",
  "morning", "needed", "needs", "night", "other", "please", "should", "since", "something", "still", "their", "there",
  "these", "thing", "things", "those", "through", "under", "until", "upon", "week", "weeks", "where", "which",
  "while", "with", "within", "without", "would", "your",
]);

/** distinctive words from the intake reason and approved medical_instruction facts, for the draft check (A3 guards) */
function extraHealthTerms(reasonText: string | null, medicalFacts: string[], aliases: string[]): string[] {
  const skip = new Set(aliases.map((alias) => alias.toLowerCase()));
  const words = new Set<string>();
  const add = (text: string, minLength: number) => {
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      if (word.length >= minLength && !COMMON_WORDS.has(word) && !skip.has(word)) words.add(word);
    }
  };
  if (reasonText) add(reasonText, 4);
  for (const fact of medicalFacts) add(fact, 6);
  return [...words].slice(0, 200);
}

const TITLES = /^(?:dr|mr|mrs|ms|mx|prof)\.?$/i;

/** "Jordan" from "Jordan Lee"; a titled name keeps its title and surname ("Dr. Brooks") */
function firstName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1 && TITLES.test(parts[0])) return `${parts[0]} ${parts[parts.length - 1]}`;
  return parts[0] || "there";
}

/** saves the user's decision; notify, reschedule, extension and coverage get an A3 draft in the approval queue */
export async function decideCommitment(rt: Runtime, user: SessionUser, input: DecideInput): Promise<DecideResponse> {
  const database = rt.stores.database;
  const commitmentId = requireUuid(input.commitmentId);
  const rows = await database.query<DecideRow>(DECIDE_COMMITMENT, [p.uuid("id", commitmentId), p.uuid("user_id", user.id)]);
  const row = rows[0];
  if (!row) throw new ApiError(404, "not_found");
  const attendees = parseAttendees(row.attendees_json);
  const aliases = recipientAliases({ alias: row.alias, displayName: row.display_name });
  const title = row.title ?? "(no title)";
  // the care recipient's own commitments are kept and go to the care timeline, never to a request (A2 guards)
  const decision: CommitmentDecision = isCareRecipientEvent({ title, attendees }, aliases) ? "keep" : input.decision;

  await database.execute(SAVE_DECISION, [p.text("decision", decision), p.uuid("id", row.id), p.uuid("user_id", user.id)]);
  const saved = { id: row.id, decision };
  if (!createsRequest(decision)) {
    return { commitment: saved, request: null, existing: false, editFlags: [], approvalBlocked: false };
  }

  const contacts = await loadContacts(database, user.id);
  let contact: OwnedContact | null;
  if (input.contactId !== undefined) {
    const id = requireUuid(input.contactId);
    contact = contacts.find((candidate) => candidate.id === id) ?? null;
    if (!contact) throw new ApiError(404, "not_found");
  } else {
    const dependencies = await database.query<{ to_ref: string | null; confirmed: boolean }>(COMMITMENT_DEPENDENCIES, [
      p.uuid("id", row.id),
    ]);
    contact = pickContact(byEmail(contacts), user.email, {
      dependencies: dependencies.map((d) => ({ toRef: d.to_ref, confirmed: d.confirmed })),
      organizerEmail: row.organizer_email,
      attendees,
    });
    if (!contact) throw new ApiError(422, "contact_required");
  }

  const open = await database.query<{ id: string }>(OPEN_REQUEST, [
    p.uuid("user_id", user.id),
    p.uuid("commitment_id", row.id),
    p.uuid("contact_id", contact.id),
  ]);
  if (open[0]) {
    return { commitment: saved, request: await rt.queue.read(user.id, open[0].id), existing: true, editFlags: [], approvalBlocked: false };
  }

  const medical = await database.query<{ text_exact: string }>(MEDICAL_FACTS, [p.uuid("recipient_id", row.recipient_id)]);
  const deps = await reserveModel(rt, user.id, "drafter");
  const draft = await runDrafter(
    {
      recipientFirstName: firstName(contact.name),
      recipientEmail: contact.email,
      relationship: relationshipFor(row.alias),
      commitmentTitle: title,
      commitmentStart: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
      action: decision,
      episodeStart: row.starts_on,
      episodeEnd: row.ends_on,
      tier: contact.tier,
      reasonText: row.reason_text,
      userNote: input.note ?? null,
      extraHealthTerms: extraHealthTerms(row.reason_text, medical.map((fact) => fact.text_exact), aliases),
    },
    deps,
  );
  if (draft.editFlags.includes("empty")) throw new ApiError(422, "draft_empty");
  const request = await rt.queue.createDraft(user.id, {
    commitmentId: row.id,
    contactId: contact.id,
    action: decision,
    subject: draft.subject,
    body: draft.body,
    healthTermsFound: draft.healthTermsFound,
  });
  return { commitment: saved, request, existing: false, editFlags: draft.editFlags, approvalBlocked: draft.approvalBlocked };
}

// ---------- add to care timeline (PRD C9, A2 guards) ----------

const TIMELINE_COMMITMENT = `SELECT c.title, to_json(c.starts_at)#>>'{}' AS starts_at, c.location, r.id::text AS recipient_id
  FROM commitment c
  JOIN care_episode e ON e.id = c.episode_id AND e.user_id = c.user_id
  JOIN care_recipient r ON r.id = e.care_recipient_id AND r.owner_id = c.user_id
  WHERE c.id = CAST(:id AS uuid) AND c.user_id = CAST(:user_id AS uuid)`;

const FIND_TIMELINE_EVENT = `SELECT id::text AS id FROM care_event
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND fact_id IS NULL AND title = :title
    AND starts_at = CAST(:starts_at AS timestamptz)
  LIMIT 1`;

const INSERT_TIMELINE_EVENT = `INSERT INTO care_event (care_recipient_id, title, starts_at, location_text, status)
  VALUES (CAST(:recipient_id AS uuid), :title, CAST(:starts_at AS timestamptz), :location, 'approved')
  RETURNING id::text AS id`;

/** one click puts the care recipient's appointment on the timeline as an approved event; repeats return the same one */
export async function addToTimeline(rt: Runtime, user: SessionUser, commitmentId: string): Promise<{ eventId: string; created: boolean }> {
  const database = rt.stores.database;
  const rows = await database.query<{ title: string | null; starts_at: string | null; location: string | null; recipient_id: string }>(
    TIMELINE_COMMITMENT,
    [p.uuid("id", requireUuid(commitmentId)), p.uuid("user_id", user.id)],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "not_found");
  if (row.starts_at === null) throw new ApiError(422, "start_time_required");
  const params = [
    p.uuid("recipient_id", row.recipient_id),
    p.text("title", (row.title ?? "Appointment").slice(0, 200)),
    p.text("starts_at", new Date(row.starts_at).toISOString()),
  ];
  return database.transaction(async (tx) => {
    const found = await tx.query<{ id: string }>(FIND_TIMELINE_EVENT, params);
    if (found[0]) return { eventId: found[0].id, created: false };
    const inserted = await tx.query<{ id: string }>(INSERT_TIMELINE_EVENT, [...params, p.text("location", row.location)]);
    return { eventId: inserted[0].id, created: true };
  });
}
