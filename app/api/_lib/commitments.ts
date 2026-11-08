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
  /** that contact's saved name; null when no contact matches (the UI then shows the address, never a guess) */
  contactName: string | null;
}

/** one of the owner's contacts a request for this commitment could go to, with the saved name */
export interface CommitmentContactView {
  contactId: string;
  name: string;
  email: string;
  group: string;
  tier: "minimal" | "general" | "detailed";
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
  /** "Change the plan" opened this step again; the next decision clears it */
  reopened: boolean;
  /** A2 preselection only */
  suggestedAction: CommitmentDecision | null;
  /** the care recipient's own commitment: keep, and offer "Add to care timeline" */
  forCareRecipient: boolean;
  dependencies: DependencyView[];
  /** contact a request would go to when decide gets no contactId */
  suggestedContactId: string | null;
  /** every matched contact, in the same order (the first is suggestedContactId); a group event can have several */
  suggestedContactIds: string[];
  contacts: CommitmentContactView[];
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
  group: string;
  tier: "minimal" | "general" | "detailed";
}

const CONTACTS = `SELECT c.id::text AS id, c.name, c.email, g.name AS group_name, g.disclosure_tier
  FROM contact c JOIN contact_group g ON g.id = c.group_id
  WHERE g.user_id = CAST(:user_id AS uuid)
  ORDER BY g.name, c.name`;

/** a request is written to at most this many people at once (each one still approved and sent separately) */
const MAX_RECIPIENTS = 10;

async function loadContacts(sql: SqlRunner, userId: string): Promise<OwnedContact[]> {
  const rows = await sql.query<{
    id: string;
    name: string;
    email: string;
    group_name: string;
    disclosure_tier: OwnedContact["tier"];
  }>(CONTACTS, [p.uuid("user_id", userId)]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    group: row.group_name,
    tier: row.disclosure_tier,
  }));
}

function contactView(contact: OwnedContact): CommitmentContactView {
  return { contactId: contact.id, name: contact.name, email: contact.email, group: contact.group, tier: contact.tier };
}

function byEmail(contacts: OwnedContact[]): Map<string, OwnedContact> {
  const map = new Map<string, OwnedContact>();
  for (const contact of contacts) {
    const key = contact.email.trim().toLowerCase();
    if (!map.has(key)) map.set(key, contact);
  }
  return map;
}

type ContactCandidates = {
  dependencies: { toRef: string | null; confirmed: boolean }[];
  organizerEmail: string | null;
  attendees: Attendee[];
};

/** confirmed dependencies first, then model ones, then the organizer, then attendees; never the owner; each once */
function matchContacts(contacts: Map<string, OwnedContact>, ownerEmail: string, candidates: ContactCandidates): OwnedContact[] {
  const ordered = [
    ...candidates.dependencies.filter((d) => d.confirmed).map((d) => d.toRef),
    ...candidates.dependencies.filter((d) => !d.confirmed).map((d) => d.toRef),
    candidates.organizerEmail,
    ...candidates.attendees.map((a) => a.email),
  ];
  const owner = ownerEmail.toLowerCase();
  const matched: OwnedContact[] = [];
  for (const email of ordered) {
    const key = email?.trim().toLowerCase();
    if (!key || key === owner) continue;
    const contact = contacts.get(key);
    if (contact && !matched.some((m) => m.id === contact.id)) matched.push(contact);
    if (matched.length >= MAX_RECIPIENTS) break;
  }
  return matched;
}

function pickContact(contacts: Map<string, OwnedContact>, ownerEmail: string, candidates: ContactCandidates): OwnedContact | null {
  return matchContacts(contacts, ownerEmail, candidates)[0] ?? null;
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
    conflict_reason, decision, (reopened_at IS NOT NULL) AS reopened
  FROM commitment
  WHERE user_id = CAST(:user_id AS uuid) AND episode_id = CAST(:episode_id AS uuid) AND source = 'calendar'
  ORDER BY starts_at, id`;

const EPISODE_DEPENDENCIES = `SELECT d.id::text AS id, d.from_commitment::text AS commitment_id, d.to_kind, d.to_ref,
    d.evidence, d.origin, d.confirmed
  FROM dependency d JOIN commitment c ON c.id = d.from_commitment
  WHERE c.user_id = CAST(:user_id AS uuid) AND c.episode_id = CAST(:episode_id AS uuid)
  ORDER BY d.confirmed DESC, lower(d.to_ref), d.id`;

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
  reopened: boolean;
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
      .map((dependency) => {
        const contact = contacts.get(dependency.to_ref?.trim().toLowerCase() ?? "");
        return {
          id: dependency.id,
          toKind: dependency.to_kind,
          toRef: dependency.to_ref,
          evidence: dependency.evidence,
          origin: dependency.origin,
          confirmed: dependency.confirmed,
          contactId: contact?.id ?? null,
          contactName: contact?.name ?? null,
        };
      });
    const title = row.title ?? "(no title)";
    const matched = matchContacts(contacts, user.email, { dependencies, organizerEmail: row.organizer_email, attendees });
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
      reopened: row.reopened === true,
      suggestedAction: null,
      forCareRecipient: isCareRecipientEvent({ title, attendees }, aliases),
      dependencies,
      suggestedContactId: matched[0]?.id ?? null,
      suggestedContactIds: matched.map((contact) => contact.id),
      contacts: matched.map(contactView),
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
  /** several people for a group commitment; each gets a separate request, approved and sent on its own */
  contactIds?: string[];
  note?: string;
}

export interface DraftOutcome {
  requestId: string;
  /** true when an open request for this commitment and contact already existed (double click guard) */
  existing: boolean;
  /** A3 guard flags: the user must edit the draft before approving */
  editFlags: string[];
  approvalBlocked: boolean;
}

export interface DecideResponse {
  commitment: { id: string; decision: CommitmentDecision };
  /** the first request (same as requests[0]); kept for single-recipient callers */
  request: RequestView | null;
  existing: boolean;
  editFlags: string[];
  approvalBlocked: boolean;
  /** one request per contact, in the order the contacts were chosen */
  requests: RequestView[];
  drafts: DraftOutcome[];
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

// a new decision also closes a reopened step
const SAVE_DECISION = `UPDATE commitment SET decision = :decision, reopened_at = NULL
  WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user_id AS uuid)`;

// an open request for this person, or a yes to the same ask: either comes back as it is, so someone who already
// accepted is never written to again for the same thing
const OPEN_REQUEST = `SELECT id::text AS id FROM request
  WHERE user_id = CAST(:user_id AS uuid) AND commitment_id = CAST(:commitment_id AS uuid)
    AND contact_id = CAST(:contact_id AS uuid)
    AND (state IN ('draft','awaiting_approval','approved','sending','requested','needs_review')
      OR (state IN ('accepted','completed') AND action = :action))
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

/** "Jordan" from "Jordan Lee"; a titled name keeps its title and surname ("Dr. Brooks"); never an email address */
function firstName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part.includes("@"))) return "there";
  if (parts.length > 1 && TITLES.test(parts[0])) return `${parts[0]} ${parts[parts.length - 1]}`;
  return parts[0];
}

async function loadDecideRow(rt: Runtime, user: SessionUser, commitmentId: string): Promise<DecideRow> {
  const rows = await rt.stores.database.query<DecideRow>(DECIDE_COMMITMENT, [
    p.uuid("id", requireUuid(commitmentId)),
    p.uuid("user_id", user.id),
  ]);
  if (!rows[0]) throw new ApiError(404, "not_found");
  return rows[0];
}

/** the request's extra health terms: the intake reason and the recipient's approved medical_instruction facts */
async function draftTermsFor(rt: Runtime, row: DecideRow): Promise<string[]> {
  const aliases = recipientAliases({ alias: row.alias, displayName: row.display_name });
  const medical = await rt.stores.database.query<{ text_exact: string }>(MEDICAL_FACTS, [
    p.uuid("recipient_id", row.recipient_id),
  ]);
  return extraHealthTerms(row.reason_text, medical.map((fact) => fact.text_exact), aliases);
}

/** one A3 draft for one contact at one tier; counts against the owner's model quota first */
async function draftFor(
  rt: Runtime,
  user: SessionUser,
  row: DecideRow,
  contact: OwnedContact,
  action: RequestView["action"],
  tier: OwnedContact["tier"],
  note: string | null,
  extra: string[],
) {
  const deps = await reserveModel(rt, user.id, "drafter");
  const draft = await runDrafter(
    {
      recipientFirstName: firstName(contact.name),
      recipientEmail: contact.email,
      relationship: relationshipFor(row.alias),
      commitmentTitle: row.title ?? "(no title)",
      commitmentStart: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
      action,
      episodeStart: row.starts_on,
      episodeEnd: row.ends_on,
      tier,
      reasonText: row.reason_text,
      userNote: note,
      extraHealthTerms: extra,
    },
    deps,
  );
  if (draft.editFlags.includes("empty")) throw new ApiError(422, "draft_empty");
  return draft;
}

/** saves the user's decision; notify, reschedule, extension and coverage get an A3 draft per contact in the queue */
export async function decideCommitment(rt: Runtime, user: SessionUser, input: DecideInput): Promise<DecideResponse> {
  const database = rt.stores.database;
  const row = await loadDecideRow(rt, user, input.commitmentId);
  const attendees = parseAttendees(row.attendees_json);
  const aliases = recipientAliases({ alias: row.alias, displayName: row.display_name });
  const title = row.title ?? "(no title)";
  // the care recipient's own commitments are kept and go to the care timeline, never to a request (A2 guards)
  const decision: CommitmentDecision = isCareRecipientEvent({ title, attendees }, aliases) ? "keep" : input.decision;

  const saveDecision = () =>
    database.execute(SAVE_DECISION, [p.text("decision", decision), p.uuid("id", row.id), p.uuid("user_id", user.id)]);
  const saved = { id: row.id, decision };
  if (!createsRequest(decision)) {
    await saveDecision();
    return { commitment: saved, request: null, existing: false, editFlags: [], approvalBlocked: false, requests: [], drafts: [] };
  }

  const contacts = await loadContacts(database, user.id);
  const chosen = input.contactIds ?? (input.contactId !== undefined ? [input.contactId] : null);
  let targets: OwnedContact[];
  if (chosen) {
    targets = [];
    for (const raw of chosen.slice(0, MAX_RECIPIENTS)) {
      const id = requireUuid(raw);
      const contact = contacts.find((candidate) => candidate.id === id);
      if (!contact) throw new ApiError(404, "not_found");
      if (!targets.some((target) => target.id === contact.id)) targets.push(contact);
    }
  } else {
    const dependencies = await database.query<{ to_ref: string | null; confirmed: boolean }>(COMMITMENT_DEPENDENCIES, [
      p.uuid("id", row.id),
    ]);
    const contact = pickContact(byEmail(contacts), user.email, {
      dependencies: dependencies.map((d) => ({ toRef: d.to_ref, confirmed: d.confirmed })),
      organizerEmail: row.organizer_email,
      attendees,
    });
    if (!contact) throw new ApiError(422, "contact_required");
    targets = [contact];
  }

  // open requests come back as they are; every new draft is written before any is queued, so a model failure
  // queues nothing new
  const slots: ({ request: RequestView; outcome: DraftOutcome } | { contact: OwnedContact })[] = [];
  for (const contact of targets) {
    const open = await database.query<{ id: string }>(OPEN_REQUEST, [
      p.uuid("user_id", user.id),
      p.uuid("commitment_id", row.id),
      p.uuid("contact_id", contact.id),
      p.text("action", decision),
    ]);
    if (open[0]) {
      const request = await rt.queue.read(user.id, open[0].id);
      slots.push({ request, outcome: { requestId: request.id, existing: true, editFlags: [], approvalBlocked: false } });
    } else {
      slots.push({ contact });
    }
  }
  const extra = slots.some((slot) => "contact" in slot) ? await draftTermsFor(rt, row) : [];
  const written = new Map<string, Awaited<ReturnType<typeof draftFor>>>();
  for (const slot of slots) {
    if (!("contact" in slot)) continue;
    written.set(slot.contact.id, await draftFor(rt, user, row, slot.contact, decision, slot.contact.tier, input.note ?? null, extra));
  }
  // only now is the decision saved and a reopened step closed: a bad contact, a refused or failed draft or a rate
  // limit above leaves the step as it was
  await saveDecision();
  const requests: RequestView[] = [];
  const drafts: DraftOutcome[] = [];
  for (const slot of slots) {
    if (!("contact" in slot)) {
      requests.push(slot.request);
      drafts.push(slot.outcome);
      continue;
    }
    const draft = written.get(slot.contact.id)!;
    const request = await rt.queue.createDraft(user.id, {
      commitmentId: row.id,
      contactId: slot.contact.id,
      action: decision,
      subject: draft.subject,
      body: draft.body,
      healthTermsFound: draft.healthTermsFound,
      extraHealthTerms: extra,
    });
    requests.push(request);
    drafts.push({ requestId: request.id, existing: false, editFlags: draft.editFlags, approvalBlocked: draft.approvalBlocked });
  }
  const first = drafts[0];
  return {
    commitment: saved,
    request: requests[0] ?? null,
    existing: first?.existing ?? false,
    editFlags: first?.editFlags ?? [],
    approvalBlocked: first?.approvalBlocked ?? false,
    requests,
    drafts,
  };
}

// ---------- change the plan ----------

const REOPEN = `UPDATE commitment SET reopened_at = now()
  WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user_id AS uuid) AND source = 'calendar'
  RETURNING id::text AS id, decision`;

/** "Change the plan": the step shows its choices again after a reload; requests are not touched */
export async function reopenCommitment(
  rt: Runtime,
  user: SessionUser,
  commitmentId: string,
): Promise<{ commitment: { id: string; decision: CommitmentDecision | null; reopened: true } }> {
  const rows = await rt.stores.database.query<{ id: string; decision: CommitmentDecision | null }>(REOPEN, [
    p.uuid("id", requireUuid(commitmentId)),
    p.uuid("user_id", user.id),
  ]);
  if (!rows[0]) throw new ApiError(404, "not_found");
  return { commitment: { id: rows[0].id, decision: rows[0].decision, reopened: true } };
}

// ---------- redraft at another tier ----------

const REDRAFT_REQUEST = `SELECT r.commitment_id::text AS commitment_id, r.contact_id::text AS contact_id, r.action, r.state
  FROM request r WHERE r.id = CAST(:id AS uuid) AND r.user_id = CAST(:user_id AS uuid)`;

const REDRAFTABLE = new Set(["draft", "awaiting_approval", "needs_review"]);

/**
 * a fresh A3 draft written for the tier the owner chose for this request. it is saved through the queue's edit, so the
 * request goes back to awaiting approval and the tier change is audited; nothing is approved or sent here
 */
export async function redraftRequest(
  rt: Runtime,
  user: SessionUser,
  input: { requestId: string; disclosureTier: OwnedContact["tier"] },
): Promise<{ request: RequestView; editFlags: string[]; approvalBlocked: boolean }> {
  const database = rt.stores.database;
  const requestId = requireUuid(input.requestId);
  const rows = await database.query<{ commitment_id: string | null; contact_id: string; action: RequestView["action"]; state: string }>(
    REDRAFT_REQUEST,
    [p.uuid("id", requestId), p.uuid("user_id", user.id)],
  );
  const found = rows[0];
  if (!found) throw new ApiError(404, "not_found");
  if (found.commitment_id === null) {
    throw new ApiError(422, "redraft_unavailable", { message: "This message can’t be rewritten. Change the words by hand." });
  }
  // advisory: the queue's edit checks the state again under the row lock
  if (!REDRAFTABLE.has(found.state)) throw new ApiError(409, "state_conflict");
  const row = await loadDecideRow(rt, user, found.commitment_id);
  const contact = (await loadContacts(database, user.id)).find((candidate) => candidate.id === found.contact_id);
  if (!contact) throw new ApiError(404, "not_found");
  const extra = await draftTermsFor(rt, row);
  const draft = await draftFor(rt, user, row, contact, found.action, input.disclosureTier, null, extra);
  const request = await rt.queue.edit(user.id, {
    requestId,
    subject: draft.subject,
    body: draft.body,
    disclosureTier: input.disclosureTier,
    extraHealthTerms: extra,
  });
  return { request, editFlags: draft.editFlags, approvalBlocked: draft.approvalBlocked };
}

// ---------- add to care timeline (PRD C9, A2 guards) ----------

const TIMELINE_COMMITMENT = `SELECT c.title, to_json(c.starts_at)#>>'{}' AS starts_at, c.location, r.id::text AS recipient_id,
    c.attendees::text AS attendees_json, r.alias, r.display_name
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

interface TimelineRow {
  title: string | null;
  starts_at: string | null;
  location: string | null;
  recipient_id: string;
  attendees_json: string | null;
  alias: string;
  display_name: string | null;
}

/**
 * one click puts the care recipient's appointment on the timeline as an approved event; repeats return the same one.
 * only the care recipient's own appointments qualify, so the caregiver's work and school stay out of care data
 */
export async function addToTimeline(rt: Runtime, user: SessionUser, commitmentId: string): Promise<{ eventId: string; created: boolean }> {
  const database = rt.stores.database;
  const rows = await database.query<TimelineRow>(TIMELINE_COMMITMENT, [
    p.uuid("id", requireUuid(commitmentId)),
    p.uuid("user_id", user.id),
  ]);
  const row = rows[0];
  if (!row) throw new ApiError(404, "not_found");
  const aliases = recipientAliases({ alias: row.alias, displayName: row.display_name });
  if (!isCareRecipientEvent({ title: row.title ?? "", attendees: parseAttendees(row.attendees_json) }, aliases)) {
    throw new ApiError(422, "not_care_recipient_event", {
      message: "Only the care recipient’s own appointments can go on their timeline.",
    });
  }
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
