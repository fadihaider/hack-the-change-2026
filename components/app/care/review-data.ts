// pure helpers for checking suggestions one at a time (PRD 4.3, 5.2): labels, source context, the end summary.
// no react here so the node test runner can load it.
import { albertaDateOf, formatAlberta, formatDate, rruleLabel, sourceLabel, type CareFactView } from "@/lib/frontend/live-api.ts";
import { PASSPORT_SECTIONS, sectionOf } from "@/lib/frontend/passport.ts";
import { isLockedWording } from "@/lib/care/lockedWording.ts";
import { possessive, shorten, type ReviewStep } from "./care-data.ts";

/** what alex decided on one step */
export type Outcome =
  | { kind: "approved" }
  | { kind: "edited"; factId: string; text: string; original: string }
  | { kind: "rejected"; text: string }
  | { kind: "skipped" }
  | { kind: "kept"; factId: string };

/**
 * counts for the end of a check. approved counts every fact step now on the profile, edited ones included,
 * so older callers that add approved + kept still get the right total. edited is the part of approved saved
 * in alex's own wording. skipped is everything still waiting: left for later, or never reached.
 */
export type ReviewSummary = {
  approved: number;
  kept: number;
  skipped: number;
  edited: number;
  rejected: number;
};

/** the passport section a suggestion would go under, e.g. "Practical needs & belongings" */
export function sectionTitle(category: string | null): string {
  if (!category) return "Contacts & logistics";
  const id = sectionOf(category);
  return PASSPORT_SECTIONS.find((section) => section.id === id)?.title ?? "Practical needs & belongings";
}

/** "Voice note from you, Nov 7"; the source date when known, else when the fact was saved */
export function reviewSourceLine(
  fact: Pick<CareFactView, "sourceKind" | "createdAt"> & Partial<Pick<CareFactView, "sourceAuthor" | "sourceCreatedAt">>,
): string {
  const by = fact.sourceAuthor === "caregiver" ? " from you" : "";
  const ms = Date.parse(fact.sourceCreatedAt ?? fact.createdAt);
  const source = `${sourceLabel(fact.sourceKind)}${by}`;
  return Number.isFinite(ms) ? `${source}, ${formatDate(albertaDateOf(ms))}` : source;
}

/** "In your voice note", used above the sentence the suggestion came from */
export function contextLabel(kind: string | null): string {
  if (kind === "voice") return "In your voice note";
  if (kind === "note") return "In your typed note";
  if (kind === "document") return "In the PDF";
  return "In the source";
}

/** "Show the whole note" */
export function wholeSourceLabel(kind: string | null): string {
  if (kind === "voice") return "Show the whole transcript";
  if (kind === "document") return "Show the whole PDF text";
  return "Show the whole note";
}

/**
 * what approving a timed suggestion does, e.g. "Approving adds it to Rosa’s day at 8:00 a.m. every day, with a
 * reminder at 7:45 a.m." the reminder is named so approving covers it too (AC7). a consequence of the caregiver's
 * choice, never an instruction. null when the suggestion has no time.
 */
export function consequenceLine(name: string, fact: Pick<CareFactView, "events">): string | null {
  const event = fact.events.find((item) => item.startsAt !== null);
  if (!event?.startsAt) return null;
  const time = formatAlberta(event.startsAt, "time");
  const day = `${possessive(name)} day`;
  let line: string;
  if (!event.rrule) {
    line = `Approving adds it to ${day} on ${formatAlberta(event.startsAt, "day")} at ${time}`;
  } else {
    const repeat = rruleLabel(event.rrule);
    line =
      repeat === "Repeats"
        ? `Approving adds it to ${day} at ${time}, repeating`
        : `Approving adds it to ${day} at ${time} ${repeat.charAt(0).toLowerCase()}${repeat.slice(1)}`;
  }
  const remind = reminderTime(event.startsAt, event.remindMinutes);
  if (remind) line = `${line}, with a reminder at ${remind}`;
  // "8:00 a.m." already ends the sentence
  return line.endsWith(".") ? line : `${line}.`;
}

/** "7:45 a.m.": when the reminder goes off; null when no lead time is set */
function reminderTime(startsAt: string, remindMinutes: number | null): string | null {
  if (remindMinutes === null || !(remindMinutes > 0)) return null;
  const ms = Date.parse(startsAt);
  if (!Number.isFinite(ms)) return null;
  return formatAlberta(ms - remindMinutes * 60_000, "time");
}

/** the step label in the progress list; a written care instruction is named, never cut short (PRD 15) */
export function stepLabel(fact: Pick<CareFactView, "category" | "textExact" | "displayText">, max = 60): string {
  if (isLockedWording(fact.category, fact.textExact)) return "Written care instruction";
  return shorten(fact.displayText ?? fact.textExact, max);
}

/** a fact quoted in a receipt or heading: shortened, unless its wording is locked (PRD 15) */
export function quoteOf(fact: Pick<CareFactView, "category" | "textExact">, max: number): string {
  return isLockedWording(fact.category, fact.textExact) ? fact.textExact : shorten(fact.textExact, max);
}

/**
 * the honest label for a conflict note: whoever actually wrote it. demo mode is keyword rules, never "the AI".
 * null when the provider is not known, so the note is not shown.
 */
export function noteLabel(aiMode: string | null | undefined): string | null {
  if (aiMode === "demo") return "Demo rules note";
  if (aiMode === "anthropic") return "Claude’s note";
  if (aiMode === "bedrock") return "Claude’s note, via Amazon Bedrock";
  return null;
}

export type SourceContext = {
  before: string;
  quote: string;
  after: string;
  /** text was left out before or after */
  cutStart: boolean;
  cutEnd: boolean;
};

const CONTEXT_MAX = 240;

function isBreak(text: string, at: number): boolean {
  const char = text[at];
  if (char === "\n") return true;
  if (char !== "." && char !== "!" && char !== "?") return false;
  return at + 1 >= text.length || /\s/.test(text[at + 1]);
}

function sentenceStart(text: string, at: number): number {
  let start = at;
  while (start > 0 && !isBreak(text, start - 1)) start -= 1;
  while (start < at && /\s/.test(text[start])) start += 1;
  return start;
}

function scanEnd(text: string, at: number): number {
  let end = at;
  while (end < text.length && !isBreak(text, end)) end += 1;
  return Math.min(text.length, end + 1);
}

function sentenceEnd(text: string, at: number): number {
  if (at > 0 && isBreak(text, at - 1)) return at;
  return scanEnd(text, at);
}

/**
 * the sentence a suggestion came from, with one neighbour each side when they fit, so alex sees it in context.
 * uses the stored span when it matches the quote word for word, else the first exact match; null when neither does.
 */
export function sourceContext(
  fullText: string,
  fact: Pick<CareFactView, "textExact" | "spanStart" | "spanEnd">,
  max = CONTEXT_MAX,
): SourceContext | null {
  const quote = fact.textExact;
  if (!quote || !fullText) return null;
  let start = fact.spanStart ?? -1;
  let end = fact.spanEnd ?? -1;
  if (start < 0 || end > fullText.length || start >= end || fullText.slice(start, end) !== quote) {
    start = fullText.indexOf(quote);
    if (start === -1) return null;
    end = start + quote.length;
  }

  let from = sentenceStart(fullText, start);
  let to = sentenceEnd(fullText, end);
  // one sentence before and after, while the whole stays short
  if (from > 0) {
    let back = from;
    while (back > 0 && /\s/.test(fullText[back - 1])) back -= 1;
    const earlier = back > 0 ? sentenceStart(fullText, back - 1) : from;
    if (to - earlier <= max) from = earlier;
  }
  if (to < fullText.length) {
    let ahead = to;
    while (ahead < fullText.length && /\s/.test(fullText[ahead])) ahead += 1;
    const later = ahead < fullText.length ? scanEnd(fullText, ahead) : to;
    if (later - from <= max) to = later;
  }
  // a very long sentence: keep the quote and trim what is around it
  if (to - from > max) {
    const room = Math.max(0, max - quote.length);
    from = Math.max(from, start - Math.floor(room / 2));
    to = Math.min(to, end + Math.ceil(room / 2));
    // whole words only at the cut edges
    while (from > 0 && from < start && !/\s/.test(fullText[from - 1])) from += 1;
    while (to < fullText.length && to > end && !/\s/.test(fullText[to])) to -= 1;
  }

  const before = fullText.slice(from, start).replace(/^\s+/, "");
  const after = fullText.slice(end, to).replace(/\s+$/, "");
  if (!before.trim() && !after.trim()) return null;
  return { before, quote, after, cutStart: from > 0, cutEnd: to < fullText.length };
}

/** a step still waiting on alex, judged from the latest facts */
function stillOpen(step: ReviewStep, byId: Map<string, CareFactView>): boolean {
  if (step.kind === "fact") return byId.get(step.factId)?.status === "suggested";
  return step.factIds.some((id) => byId.get(id)?.status === "conflicting");
}

export function summarize(steps: ReviewStep[], outcomes: Record<string, Outcome>, facts: CareFactView[]): ReviewSummary {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const summary: ReviewSummary = { approved: 0, kept: 0, skipped: 0, edited: 0, rejected: 0 };
  for (const step of steps) {
    const outcome = outcomes[step.key];
    if (outcome?.kind === "approved") summary.approved += 1;
    else if (outcome?.kind === "edited") {
      summary.approved += 1;
      summary.edited += 1;
    } else if (outcome?.kind === "rejected") summary.rejected += 1;
    else if (outcome?.kind === "kept") summary.kept += 1;
    else if (outcome?.kind === "skipped" || stillOpen(step, byId)) summary.skipped += 1;
  }
  return summary;
}

export type SummaryRow = { key: string; label: string; count: number };

/** the rows on the last screen; "kept" appears only when there were notes that disagreed */
export function summaryRows(summary: ReviewSummary): SummaryRow[] {
  const rows: SummaryRow[] = [
    { key: "approved", label: "Approved as written", count: summary.approved - summary.edited },
    { key: "edited", label: "Edited and approved", count: summary.edited },
  ];
  if (summary.kept > 0) rows.push({ key: "kept", label: "Picked from notes that disagreed", count: summary.kept });
  rows.push(
    { key: "rejected", label: "Rejected", count: summary.rejected },
    { key: "skipped", label: "Left for later", count: summary.skipped },
  );
  return rows;
}

/** one sentence for screen readers, e.g. "2 approved, 1 edited and approved, 1 rejected, 0 left for later." */
export function summarySentence(summary: ReviewSummary): string {
  return `${summaryRows(summary)
    .map((row) => `${row.count} ${row.label.charAt(0).toLowerCase()}${row.label.slice(1)}`)
    .join(", ")}.`;
}
