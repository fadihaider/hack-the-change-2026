// care helpers: which facts still need alex, how they group, and the plain lines shown next to them
import {
  albertaDateOf,
  categoryLabel,
  formatAlberta,
  formatDate,
  rruleLabel,
  sourceLabel,
  type CareFactView,
} from "@/lib/frontend/live-api.ts";

export type ReviewStep =
  | { kind: "fact"; key: string; factId: string }
  | { kind: "conflict"; key: string; factIds: string[] };

// the order helpers most need things in
const CATEGORY_ORDER = [
  "medical_instruction",
  "routine",
  "mobility",
  "communication",
  "contacts",
  "logistics",
  "preference",
];

/** "Medical instruction as written", "Routine" */
export function categoryTitle(category: string | null): string {
  const label = categoryLabel(category);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "Typed note, added Nov 7" */
export function sourceLine(fact: Pick<CareFactView, "sourceKind" | "createdAt">): string {
  const ms = Date.parse(fact.createdAt);
  const source = sourceLabel(fact.sourceKind);
  return Number.isFinite(ms) ? `${source}, added ${formatDate(albertaDateOf(ms))}` : source;
}

/** "Every day at 10:00 a.m.", or "Sat, Nov 14 at 10:00 a.m." for a one-off; null when the fact has no time */
export function timeLine(fact: Pick<CareFactView, "events">): string | null {
  const event = fact.events.find((item) => item.startsAt !== null);
  if (!event?.startsAt) return null;
  const time = formatAlberta(event.startsAt, "time");
  const when = event.rrule ? rruleLabel(event.rrule) : formatAlberta(event.startsAt, "day");
  return `${when} at ${time}`;
}

export function possessive(name: string): string {
  return name.endsWith("s") ? `${name}’` : `${name}’s`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/** keeps a YYYY-MM-DD date inside the care week */
export function clampDate(date: string, start: string, end: string): string {
  if (date < start) return start;
  if (date > end) return end;
  return date;
}

function newestFirst(a: CareFactView, b: CareFactView) {
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return (a.spanStart ?? 0) - (b.spanStart ?? 0);
}

/**
 * what still needs alex: each set of facts that disagree is one question, then each suggested fact.
 * facts from `firstSourceId` (the note just added) come first, in the order they were written.
 */
export function pendingSteps(facts: CareFactView[], firstSourceId: string | null = null): ReviewStep[] {
  const fresh = (fact: CareFactView) => (firstSourceId !== null && fact.sourceId === firstSourceId ? 0 : 1);
  const order = (a: CareFactView, b: CareFactView) => fresh(a) - fresh(b) || newestFirst(a, b);

  // conflicting facts linked by conflictsWith form one group
  const conflicting = facts.filter((fact) => fact.status === "conflicting");
  const ids = new Set(conflicting.map((fact) => fact.id));
  const parent = new Map(conflicting.map((fact) => [fact.id, fact.id]));
  const root = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at) ?? at;
    return at;
  };
  for (const fact of conflicting) {
    for (const other of fact.conflictsWith) {
      if (ids.has(other)) parent.set(root(other), root(fact.id));
    }
  }
  const groups = new Map<string, CareFactView[]>();
  for (const fact of conflicting) {
    const key = root(fact.id);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  const conflictSteps = [...groups.values()]
    .map((group) => [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.spanStart ?? 0) - (b.spanStart ?? 0)))
    .sort((a, b) => order(newestOf(a), newestOf(b)))
    .map<ReviewStep>((group) => ({
      kind: "conflict",
      key: `conflict:${group.map((fact) => fact.id).sort().join(",")}`,
      factIds: group.map((fact) => fact.id),
    }));

  const factSteps = facts
    .filter((fact) => fact.status === "suggested")
    .sort(order)
    .map<ReviewStep>((fact) => ({ kind: "fact", key: `fact:${fact.id}`, factId: fact.id }));

  return [...conflictSteps, ...factSteps];
}

function newestOf(group: CareFactView[]): CareFactView {
  return group.reduce((best, fact) => (newestFirst(fact, best) < 0 ? fact : best), group[0]);
}

export type FactGroup = { category: string; title: string; facts: CareFactView[] };

/** approved facts by category, in the order helpers most need them */
export function approvedGroups(facts: CareFactView[]): FactGroup[] {
  const groups = new Map<string, CareFactView[]>();
  for (const fact of facts) {
    if (fact.status !== "approved") continue;
    groups.set(fact.category, [...(groups.get(fact.category) ?? []), fact]);
  }
  const rank = (category: string) => {
    const at = CATEGORY_ORDER.indexOf(category);
    return at === -1 ? CATEGORY_ORDER.length : at;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      title: categoryTitle(category),
      facts: [...list].sort((a, b) => (firstStart(a) ?? "~").localeCompare(firstStart(b) ?? "~") || newestFirst(a, b)),
    }));
}

// timed facts read in time-of-day order inside a group: HH:MM in alberta time (utc-6 all year)
function firstStart(fact: CareFactView): string | null {
  const event = fact.events.find((item) => item.startsAt !== null);
  const ms = event?.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 6 * 3600000).toISOString().slice(11, 16);
}
