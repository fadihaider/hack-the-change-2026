// today's care: which items show first, each item's status and reminder time. pure, so it can be tested
import { formatAlberta, type TimelineItemView } from "@/lib/frontend/live-api.ts";
import { isLockedWording } from "@/lib/care/lockedWording.ts";
import { plural } from "./care-data.ts";

/** how many items the day shows before "Open full day" */
export const DAY_PREVIEW = 4;
/** how many earlier, not-yet-done items stay in the preview next to what's coming up */
const OVERDUE_IN_PREVIEW = 2;

export type ItemStatus = "done" | "reminder" | "planned";

export const STATUS_LABEL: Record<ItemStatus, string> = {
  done: "Done — recorded by you",
  reminder: "Reminder now",
  planned: "Planned",
};

type Item = Pick<TimelineItemView, "eventId" | "startsAt" | "remindMinutes" | "highlight" | "completedAt">;

export function itemKey(item: Pick<TimelineItemView, "eventId" | "startsAt">): string {
  return `${item.eventId}-${item.startsAt}`;
}

/** done only when the caregiver marked it; viewing never completes anything */
export function itemStatus(item: Item): ItemStatus {
  if (item.completedAt) return "done";
  if (item.highlight && item.remindMinutes > 0) return "reminder";
  return "planned";
}

/** when the reminder goes off, as an ISO time; null when no lead time is set */
export function reminderAt(item: Pick<TimelineItemView, "startsAt" | "remindMinutes">): string | null {
  if (!(item.remindMinutes > 0)) return null;
  const ms = Date.parse(item.startsAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - item.remindMinutes * 60_000).toISOString();
}

function startOf(item: Pick<TimelineItemView, "startsAt">): number {
  const ms = Date.parse(item.startsAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function chronological<T extends Pick<TimelineItemView, "startsAt" | "eventId">>(a: T, b: T): number {
  return startOf(a) - startOf(b) || a.eventId.localeCompare(b.eventId);
}

/**
 * the items worth seeing first, in time order. on the app's today: the latest couple of earlier items
 * not marked done, then what's next, then the rest. on any other day: the first few in time order.
 */
export function dayPreview<T extends Item>(items: T[], nowMs: number | null, limit = DAY_PREVIEW): { shown: T[]; hidden: number } {
  const sorted = [...items].sort(chronological);
  if (sorted.length <= limit) return { shown: sorted, hidden: 0 };
  if (nowMs === null) return { shown: sorted.slice(0, limit), hidden: sorted.length - limit };

  const overdue = sorted.filter((item) => !item.completedAt && startOf(item) < nowMs).reverse();
  const next = sorted.filter((item) => !item.completedAt && startOf(item) >= nowMs);
  const done = sorted.filter((item) => item.completedAt);
  const order = [...overdue.slice(0, OVERDUE_IN_PREVIEW), ...next, ...overdue.slice(OVERDUE_IN_PREVIEW), ...done];
  const picked = new Set(order.slice(0, limit));
  return { shown: sorted.filter((item) => picked.has(item)), hidden: sorted.length - picked.size };
}

export type DaySummary = {
  total: number;
  done: number;
  /** earlier today and not marked done */
  earlier: number;
  /** the next item not marked done, on the app's today only */
  next: Pick<TimelineItemView, "startsAt" | "title"> | null;
};

export function daySummary<T extends Item & Pick<TimelineItemView, "title">>(items: T[], nowMs: number | null): DaySummary {
  const sorted = [...items].sort(chronological);
  const open = sorted.filter((item) => !item.completedAt);
  return {
    total: sorted.length,
    done: sorted.length - open.length,
    earlier: nowMs === null ? 0 : open.filter((item) => startOf(item) < nowMs).length,
    next: nowMs === null ? null : (open.find((item) => startOf(item) >= nowMs) ?? null),
  };
}

/** "4 things on this day. 1 marked done. Next: 8:00 a.m." with one period after a time that already ends in "a.m." */
export function overviewLine(summary: DaySummary): string {
  const parts = [`${plural(summary.total, "thing", "things")} on this day.`];
  if (summary.done > 0) parts.push(`${summary.done} marked done.`);
  if (summary.earlier > 0) parts.push(`${plural(summary.earlier, "earlier item isn’t", "earlier items aren’t")} marked done.`);
  if (summary.next) {
    const at = formatAlberta(summary.next.startsAt, "time");
    parts.push(`Next: ${at}${at.endsWith(".") ? "" : "."}`);
  }
  return parts.join(" ");
}

/**
 * the line an item shows before it is expanded. locked wording (medication, doses, wound care, written
 * instructions) is shown whole, never the short title (PRD 15); everything else, and any urgent appointment,
 * shows its short title.
 */
export function dayItemText(item: Pick<TimelineItemView, "factId" | "category" | "fullText" | "title">): string {
  if (item.factId === null) return item.title;
  const exact = item.fullText ?? item.title;
  return isLockedWording(item.category, exact) || isLockedWording(item.category, item.title) ? exact : item.title;
}

/** replaces one occurrence's completion in a list of items */
export function withCompletion<T extends Pick<TimelineItemView, "eventId" | "completedAt">>(
  items: T[],
  eventId: string,
  completedAt: string | null,
): T[] {
  return items.map((item) => (item.eventId === eventId ? { ...item, completedAt } : item));
}
