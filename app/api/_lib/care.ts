// care mode: A4 sources to suggested facts, approvals, conflict resolution, the day timeline and A5 questions
import "server-only";
import { p, type SqlRunner } from "../../../lib/db.ts";
import { CARE_LIMITS, runCareCompiler, type CareCategory, type ExistingFact } from "../../../lib/ai/careCompiler.ts";
import { classifyQuestion } from "../../../lib/ai/medicalGuard.ts";
import { redirectProfileQa, runProfileQa, type ProfileQaResult } from "../../../lib/ai/profileQa.ts";
import { normalizeText } from "../../../lib/ai/text.ts";
import type { SessionUser } from "../../../lib/mvp/auth.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { retrievePassport } from "./careRetrieval.ts";
import { albertaDate, loadActiveEpisode, loadRecipient, reserveModel } from "./context.ts";
import { ApiError, requireUuid } from "./http.ts";
import { occurrenceOn } from "./rrule.ts";

export type FactStatus = "suggested" | "approved" | "superseded" | "conflicting" | "rejected";
export type SourceKind = "voice" | "document" | "note";

export interface CareEventView {
  id: string;
  title: string;
  startsAt: string | null;
  rrule: string | null;
  remindMinutes: number;
  locationText: string | null;
  status: string;
}

export interface CareFactView {
  id: string;
  category: CareCategory;
  /** exact text from the source; the UI labels medical_instruction "medical instruction as written" */
  textExact: string;
  status: FactStatus;
  sourceId: string | null;
  sourceKind: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  /** for a conflicting fact: the other facts it conflicts with */
  conflictsWith: string[];
  events: CareEventView[];
  createdAt: string;
}

interface FactRow {
  id: string;
  category: CareCategory;
  text_exact: string;
  status: FactStatus;
  source_id: string | null;
  source_kind: string | null;
  span_start: number | null;
  span_end: number | null;
  supersedes: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  fact_id: string | null;
  title: string;
  starts_at: string | null;
  rrule: string | null;
  remind_minutes: number | null;
  location_text: string | null;
  status: string;
}

const FACTS = `SELECT f.id::text AS id, f.category, f.text_exact, f.status, f.source_id::text AS source_id,
    s.kind AS source_kind, f.span_start, f.span_end, f.supersedes::text AS supersedes,
    to_json(f.created_at)#>>'{}' AS created_at
  FROM care_fact f LEFT JOIN care_source s ON s.id = f.source_id
  WHERE f.care_recipient_id = CAST(:recipient_id AS uuid)
    AND (CAST(:fact_id AS uuid) IS NULL OR f.id = CAST(:fact_id AS uuid))
  ORDER BY f.created_at, f.id`;

const EVENTS = `SELECT id::text AS id, fact_id::text AS fact_id, title, to_json(starts_at)#>>'{}' AS starts_at, rrule,
    remind_minutes, location_text, status
  FROM care_event WHERE care_recipient_id = CAST(:recipient_id AS uuid)
  ORDER BY starts_at NULLS LAST, id`;

function toEvent(row: EventRow): CareEventView {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
    rrule: row.rrule,
    remindMinutes: row.remind_minutes ?? 15,
    locationText: row.location_text,
    status: row.status,
  };
}

/** every fact for the recipient (or one), with its events and its open conflict partners */
export async function listFacts(sql: SqlRunner, recipientId: string, factId: string | null = null): Promise<CareFactView[]> {
  const facts = await sql.query<FactRow>(FACTS, [p.uuid("recipient_id", recipientId), p.text("fact_id", factId)]);
  const events = await sql.query<EventRow>(EVENTS, [p.uuid("recipient_id", recipientId)]);
  // conflicts are linked through supersedes while both facts are conflicting (see addCareSource)
  const all = factId === null ? facts : await sql.query<FactRow>(FACTS, [p.uuid("recipient_id", recipientId), p.text("fact_id", null)]);
  const conflicting = all.filter((fact) => fact.status === "conflicting");
  return facts.map((fact) => ({
    id: fact.id,
    category: fact.category,
    textExact: fact.text_exact,
    status: fact.status,
    sourceId: fact.source_id,
    sourceKind: fact.source_kind,
    spanStart: fact.span_start,
    spanEnd: fact.span_end,
    conflictsWith:
      fact.status === "conflicting"
        ? conflicting
          .filter((other) => other.id !== fact.id && (other.supersedes === fact.id || other.id === fact.supersedes))
          .map((other) => other.id)
        : [],
    events: events.filter((event) => event.fact_id === fact.id).map(toEvent),
    createdAt: new Date(fact.created_at).toISOString(),
  }));
}

const OPEN_QUESTIONS = `SELECT id::text AS id, question, asked_by FROM open_question
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'open'
  ORDER BY id`;

export async function careProfile(rt: Runtime, user: SessionUser) {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const facts = await listFacts(database, recipient.id);
  const openQuestions = await database.query<{ id: string; question: string; asked_by: string | null }>(OPEN_QUESTIONS, [
    p.uuid("recipient_id", recipient.id),
  ]);
  return {
    careRecipient: { id: recipient.id, alias: recipient.alias, displayName: recipient.displayName },
    facts,
    openQuestions: openQuestions.map((row) => ({ id: row.id, question: row.question, askedBy: row.asked_by })),
  };
}

// ---------- sources (C2, C3) ----------

const EXISTING_FACTS = `SELECT f.id::text AS id, f.category, f.text_exact,
    (SELECT to_json(e.starts_at)#>>'{}' FROM care_event e WHERE e.fact_id = f.id AND e.starts_at IS NOT NULL
      ORDER BY e.starts_at LIMIT 1) AS first_start
  FROM care_fact f
  WHERE f.care_recipient_id = CAST(:recipient_id AS uuid) AND f.status IN ('suggested','approved','conflicting')
  ORDER BY f.created_at, f.id
  LIMIT 200`;

const INSERT_SOURCE = `INSERT INTO care_source (care_recipient_id, kind, s3_key, full_text, author)
  VALUES (CAST(:recipient_id AS uuid), :kind, NULL, :full_text, 'caregiver')
  RETURNING id::text AS id`;

const INSERT_FACT = `INSERT INTO care_fact (care_recipient_id, category, text_exact, source_id, span_start, span_end, status, supersedes)
  VALUES (CAST(:recipient_id AS uuid), :category, :text_exact, CAST(:source_id AS uuid), CAST(:span_start AS int),
    CAST(:span_end AS int), :status, CAST(:supersedes AS uuid))
  RETURNING id::text AS id`;

const INSERT_EVENT = `INSERT INTO care_event (care_recipient_id, fact_id, title, starts_at, rrule, status)
  VALUES (CAST(:recipient_id AS uuid), CAST(:fact_id AS uuid), :title, CAST(:starts_at AS timestamptz), :rrule, 'suggested')`;

const MARK_CONFLICTING = `UPDATE care_fact SET status = 'conflicting'
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid)
    AND status IN ('suggested','approved','conflicting')`;

const LINK_EXTRA_CONFLICT = `UPDATE care_fact SET supersedes = CAST(:other AS uuid)
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid) AND supersedes IS NULL`;

const EVENTS_BACK_TO_SUGGESTED = `UPDATE care_event SET status = 'suggested'
  WHERE fact_id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'approved'`;

/** HH:MM in Alberta Time of an event start, so A4 can compare times with existing facts */
function albertaClock(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms - 6 * 60 * 60 * 1000).toISOString().slice(11, 16) : null;
}

export interface SourceInput {
  kind: SourceKind;
  text: string;
  pdfBase64?: string;
}

/**
 * runs A4 over one source and saves it: care_source.full_text is result.normalizedText, every fact is suggested
 * (conflicting when A4 found a conflict), and timed facts get suggested care_events. Nothing is approved here.
 */
export async function addCareSource(rt: Runtime, user: SessionUser, input: SourceInput) {
  const database = rt.stores.database;
  const normalized = normalizeText(input.text);
  if (normalized.length === 0) throw new ApiError(input.kind === "document" ? 422 : 400, input.kind === "document" ? "no_text_layer" : "invalid_input");
  if (normalized.length > CARE_LIMITS.maxSourceChars) throw new ApiError(422, "source_too_long");

  const recipient = await loadRecipient(database, user.id);
  const episode = await loadActiveEpisode(database, user.id);
  const episodeStart = episode?.startsOn ?? albertaDate(await rt.stores.appNow(user.id));
  const existingRows = await database.query<{ id: string; category: CareCategory; text_exact: string; first_start: string | null }>(
    EXISTING_FACTS,
    [p.uuid("recipient_id", recipient.id)],
  );
  const existingFacts: ExistingFact[] = existingRows.map((row) => ({
    id: row.id,
    category: row.category,
    textExact: row.text_exact,
    time: albertaClock(row.first_start),
  }));

  const deps = await reserveModel(rt, user.id, "care_compiler");
  const result = await runCareCompiler({ fullText: input.text, pdfBase64: input.pdfBase64, existingFacts, episodeStart }, deps);

  const byFact = new Map<number, string[]>();
  for (const conflict of result.conflicts) {
    byFact.set(conflict.factIndex, [...(byFact.get(conflict.factIndex) ?? []), conflict.existingFactId]);
  }

  const saved = await database.transaction(async (tx) => {
    const sources = await tx.query<{ id: string }>(INSERT_SOURCE, [
      p.uuid("recipient_id", recipient.id),
      p.text("kind", input.kind),
      p.text("full_text", result.normalizedText),
    ]);
    const sourceId = sources[0].id;
    const factIds: string[] = [];
    for (const [index, fact] of result.facts.entries()) {
      const partners = byFact.get(index) ?? [];
      const rows = await tx.query<{ id: string }>(INSERT_FACT, [
        p.uuid("recipient_id", recipient.id),
        p.text("category", fact.category),
        p.text("text_exact", fact.textExact),
        p.uuid("source_id", sourceId),
        p.int("span_start", fact.spanStart),
        p.int("span_end", fact.spanEnd),
        p.text("status", partners.length > 0 ? "conflicting" : "suggested"),
        // while both are conflicting, supersedes links the pair; resolving it makes the kept fact the superseding one
        p.text("supersedes", partners[0] ?? null),
      ]);
      const factId = rows[0].id;
      factIds.push(factId);
      if (fact.event) {
        await tx.execute(INSERT_EVENT, [
          p.uuid("recipient_id", recipient.id),
          p.uuid("fact_id", factId),
          p.text("title", fact.event.title),
          p.text("starts_at", fact.event.startsAt),
          p.text("rrule", fact.event.rrule),
        ]);
      }
      for (const [position, existingId] of partners.entries()) {
        const params = [p.uuid("id", existingId), p.uuid("recipient_id", recipient.id)];
        await tx.execute(MARK_CONFLICTING, params);
        // a conflicting fact stays off the timeline until the caregiver picks one (PRD C3)
        await tx.execute(EVENTS_BACK_TO_SUGGESTED, params);
        if (position > 0) await tx.execute(LINK_EXTRA_CONFLICT, [...params, p.uuid("other", factId)]);
      }
    }
    return { sourceId, factIds };
  });

  const facts = await listFacts(database, recipient.id);
  const created = new Set(saved.factIds);
  return {
    source: { id: saved.sourceId, kind: input.kind },
    facts: facts.filter((fact) => created.has(fact.id)),
    conflicts: result.conflicts.map((conflict) => ({
      factId: saved.factIds[conflict.factIndex],
      existingFactId: conflict.existingFactId,
      /** model text written after reading untrusted sources: show only as a labelled model note */
      modelNote: conflict.modelReason,
    })),
    droppedCount: result.dropped.length,
  };
}

// ---------- approve and resolve (C1, C3) ----------

const APPROVE_FACT = `UPDATE care_fact SET status = 'approved'
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'suggested'`;

const APPROVE_EVENTS = `UPDATE care_event SET status = 'approved'
  WHERE fact_id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'suggested'`;

const FACT_STATE = `SELECT status, supersedes::text AS supersedes FROM care_fact
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid) FOR UPDATE`;

/** approving a fact approves its events; only suggested facts can be approved (conflicts go through resolve) */
export async function approveFact(rt: Runtime, user: SessionUser, factId: string) {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const params = [p.uuid("id", requireUuid(factId)), p.uuid("recipient_id", recipient.id)];
  await database.transaction(async (tx) => {
    const rows = await tx.query<{ status: FactStatus }>(FACT_STATE, params);
    if (!rows[0]) throw new ApiError(404, "not_found");
    if (rows[0].status === "conflicting") throw new ApiError(409, "conflict_unresolved");
    if (rows[0].status !== "suggested") throw new ApiError(409, "state_conflict");
    await tx.execute(APPROVE_FACT, params);
    await tx.execute(APPROVE_EVENTS, params);
  });
  const [fact] = await listFacts(database, recipient.id, factId.toLowerCase());
  return { fact };
}

const PARTNERS = `SELECT id::text AS id FROM care_fact
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'conflicting' AND id <> CAST(:id AS uuid)
    AND (supersedes = CAST(:id AS uuid) OR id = CAST(:supersedes AS uuid))
  ORDER BY created_at, id FOR UPDATE`;

const KEEP_FACT = `UPDATE care_fact SET status = 'approved', supersedes = CAST(:supersedes AS uuid)
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid)`;

const SUPERSEDE_FACT = `UPDATE care_fact SET status = 'superseded',
    supersedes = CASE WHEN supersedes = CAST(:keep AS uuid) THEN NULL ELSE supersedes END
  WHERE id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid)`;

const SUPERSEDE_EVENTS = `UPDATE care_event SET status = 'superseded'
  WHERE fact_id = CAST(:id AS uuid) AND care_recipient_id = CAST(:recipient_id AS uuid)`;

/** the kept fact becomes approved with its events; its conflict partners become superseded (PRD C3) */
export async function resolveConflict(rt: Runtime, user: SessionUser, keepFactId: string) {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const keep = requireUuid(keepFactId);
  const params = [p.uuid("id", keep), p.uuid("recipient_id", recipient.id)];
  const supersededIds = await database.transaction(async (tx) => {
    const rows = await tx.query<{ status: FactStatus; supersedes: string | null }>(FACT_STATE, params);
    if (!rows[0]) throw new ApiError(404, "not_found");
    if (rows[0].status !== "conflicting") throw new ApiError(409, "state_conflict");
    const partners = (await tx.query<{ id: string }>(PARTNERS, [...params, p.text("supersedes", rows[0].supersedes)])).map(
      (row) => row.id,
    );
    const supersedes = rows[0].supersedes !== null && partners.includes(rows[0].supersedes) ? rows[0].supersedes : partners[0] ?? null;
    await tx.execute(KEEP_FACT, [...params, p.text("supersedes", supersedes)]);
    await tx.execute(APPROVE_EVENTS, params);
    for (const partner of partners) {
      const partnerParams = [p.uuid("id", partner), p.uuid("recipient_id", recipient.id)];
      await tx.execute(SUPERSEDE_FACT, [...partnerParams, p.uuid("keep", keep)]);
      await tx.execute(SUPERSEDE_EVENTS, partnerParams);
    }
    return partners;
  });
  const facts = await listFacts(database, recipient.id);
  return {
    kept: facts.find((fact) => fact.id === keep) ?? null,
    superseded: facts.filter((fact) => supersededIds.includes(fact.id)),
  };
}

// ---------- timeline (C4) ----------

const TIMELINE = `SELECT e.id::text AS id, e.fact_id::text AS fact_id, e.title, to_json(e.starts_at)#>>'{}' AS starts_at,
    e.rrule, e.remind_minutes, e.location_text, f.text_exact, f.category
  FROM care_event e LEFT JOIN care_fact f ON f.id = e.fact_id
  WHERE e.care_recipient_id = CAST(:recipient_id AS uuid) AND e.status = 'approved'
    AND (e.fact_id IS NULL OR f.status = 'approved') AND e.starts_at IS NOT NULL
  ORDER BY e.starts_at`;

export interface TimelineItem {
  eventId: string;
  factId: string | null;
  title: string;
  /** this occurrence, UTC ISO */
  startsAt: string;
  /** HH:MM in Alberta Time */
  localTime: string;
  rrule: string | null;
  remindMinutes: number;
  locationText: string | null;
  /** the full original wording, one tap away */
  fullText: string | null;
  category: CareCategory | null;
  /** inside its reminder window at app time */
  highlight: boolean;
}

/** approved events for one Alberta day, recurrences expanded, reminders highlighted by app time */
export async function timelineFor(rt: Runtime, user: SessionUser, date: string | null) {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id);
  const appNow = await rt.stores.appNow(user.id);
  const day = date ?? albertaDate(appNow);
  const rows = await database.query<{
    id: string;
    fact_id: string | null;
    title: string;
    starts_at: string;
    rrule: string | null;
    remind_minutes: number | null;
    location_text: string | null;
    text_exact: string | null;
    category: CareCategory | null;
  }>(TIMELINE, [p.uuid("recipient_id", recipient.id)]);
  const items: TimelineItem[] = [];
  for (const row of rows) {
    const startsAt = occurrenceOn(row.starts_at, row.rrule, day);
    if (startsAt === null) continue;
    const remindMinutes = row.remind_minutes ?? 15;
    const startMs = Date.parse(startsAt);
    items.push({
      eventId: row.id,
      factId: row.fact_id,
      title: row.title,
      startsAt,
      localTime: albertaClock(startsAt) ?? "",
      rrule: row.rrule,
      remindMinutes,
      locationText: row.location_text,
      fullText: row.text_exact,
      category: row.category,
      highlight: appNow.getTime() >= startMs - remindMinutes * 60_000 && appNow.getTime() <= startMs,
    });
  }
  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { date: day, appNow: appNow.toISOString(), reminders: items.filter((item) => item.highlight), items };
}

// ---------- ask (C6) ----------

// the same open question asked twice stays one row
const OPEN_QUESTION_LIKE = `SELECT id::text AS id FROM open_question
  WHERE care_recipient_id = CAST(:recipient_id AS uuid) AND status = 'open' AND lower(question) = lower(:question)
  ORDER BY id LIMIT 1`;

const INSERT_QUESTION = `INSERT INTO open_question (care_recipient_id, asked_by, question, status)
  VALUES (CAST(:recipient_id AS uuid), 'caregiver', :question, 'open')
  RETURNING id::text AS id`;

/** who produced the answer wording: demo keyword rules are never presented as AI; "none" means no model call */
export type AnsweredBy = "demo_rules" | "anthropic" | "bedrock" | "gemini" | "none";

export interface AskCitedFact {
  id: string;
  category: CareCategory;
  /** stored text_exact, shown verbatim */
  textExact: string;
  sourceId: string | null;
  sourceKind: string | null;
  sourceCreatedAt: string | null;
  version: number;
}

export type AskResult = Omit<ProfileQaResult, "citedFacts"> & {
  citedFacts: AskCitedFact[];
  openQuestionId: string | null;
  answeredBy: AnsweredBy;
  /** the question asked for medical judgment or described an emergency: the answer is a fixed 811/911 pointer */
  medicalRedirect: boolean;
  retrieval: { method: "keyword" | "keyword+vector" | "none"; considered: number };
};

function answeredByFor(mode: string): AnsweredBy {
  if (mode === "demo") return "demo_rules";
  if (mode === "anthropic" || mode === "bedrock" || mode === "gemini") return mode;
  return "none";
}

type Provenance = Pick<AskCitedFact, "sourceId" | "sourceKind" | "sourceCreatedAt" | "version">;

/**
 * A5 over the owner's approved, current facts only (PRD 7.2). approved facts come from careRetrieval.ts (owner-scoped,
 * passage-checked, ranked). a medical or emergency question gets a fixed 811/911 pointer before any model call;
 * otherwise retrieval picks the context and the A5 guards check every citation. no answer creates an open question.
 */
export async function askProfile(rt: Runtime, user: SessionUser, question: string): Promise<AskResult> {
  const database = rt.stores.database;
  const kind = classifyQuestion(question);
  let result: ProfileQaResult;
  let answeredBy: AnsweredBy = "none";
  let retrieval: AskResult["retrieval"] = { method: "none", considered: 0 };
  let byId = new Map<string, Provenance>();
  let recipientId: string;

  if (kind === "emergency") {
    // nothing from the passport is shown next to an emergency, and nothing is read or sent to a model
    recipientId = (await loadRecipient(database, user.id)).id;
    result = redirectProfileQa({ question, facts: [] }, kind);
  } else {
    // medical questions never reach a model, so they skip the paid embedding call too
    const retrieved = await retrievePassport(rt, user, question, { useVector: kind === "profile" });
    recipientId = retrieved.scope.careRecipientId;
    byId = retrieved.byId;
    retrieval = { method: retrieved.method, considered: retrieved.considered };
    if (kind === "medical") {
      result = redirectProfileQa({ question, facts: retrieved.facts }, kind);
    } else {
      // runProfileQa makes no model call for an empty profile, so nothing is reserved then
      const deps = retrieved.facts.length > 0 ? await reserveModel(rt, user.id, "profile_qa") : rt.ai;
      result = await runProfileQa({ question, facts: retrieved.facts }, deps);
      if (retrieved.facts.length > 0) answeredBy = answeredByFor(rt.mode.ai);
    }
  }

  let openQuestionId: string | null = null;
  if (result.createOpenQuestion) {
    const params = [p.uuid("recipient_id", recipientId), p.text("question", normalizeText(question).slice(0, 500))];
    const existing = await database.query<{ id: string }>(OPEN_QUESTION_LIKE, params);
    openQuestionId = existing[0]?.id ?? (await database.query<{ id: string }>(INSERT_QUESTION, params))[0].id;
  }
  // every citation was in the retrieved, approved set (applyProfileQaGuards); provenance comes from the same rows
  const citedFacts = result.citedFacts.map((fact) => {
    const known = byId.get(fact.id);
    return {
      id: fact.id,
      category: fact.category,
      textExact: fact.textExact,
      sourceId: known?.sourceId ?? null,
      sourceKind: known?.sourceKind ?? null,
      sourceCreatedAt: known?.sourceCreatedAt ?? null,
      version: known?.version ?? 1,
    };
  });
  return { ...result, citedFacts, openQuestionId, answeredBy, medicalRedirect: kind !== "profile", retrieval };
}
