// timeline recurrence: FREQ=DAILY, or FREQ=WEEKLY with BYDAY, each with optional INTERVAL (IMPLEMENTATION section 4)
import "server-only";
import { ALBERTA_OFFSET, canonicalRrule } from "../../../lib/ai/time.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALBERTA_OFFSET_MS = 6 * 60 * 60 * 1000;
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function utcDay(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

/** days since the monday of that week (RFC 5545 default WKST=MO) */
function mondayOffset(isoDate: string): number {
  return (new Date(utcDay(isoDate)).getUTCDay() + 6) % 7;
}

/**
 * the occurrence start (UTC ISO) of an event on an Alberta calendar date, or null when it does not occur that day.
 * startsAt is the first occurrence. an rrule outside the allowed set counts as a one-off event.
 */
export function occurrenceOn(startsAt: string, rrule: string | null, date: string): string | null {
  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(utcDay(date))) return null;
  const local = new Date(startMs - ALBERTA_OFFSET_MS).toISOString();
  const startDate = local.slice(0, 10);
  const clock = local.slice(11, 19);
  if (date < startDate) return null;
  const at = () => new Date(`${date}T${clock}${ALBERTA_OFFSET}`).toISOString();

  const rule = canonicalRrule(rrule);
  if (rule === null) return date === startDate ? at() : null;
  const parts = new Map(rule.split(";").map((piece) => piece.split("=") as [string, string]));
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const byDay = parts.get("BYDAY")?.split(",") ?? null;
  const weekday = RRULE_DAYS[new Date(utcDay(date)).getUTCDay()];
  const days = Math.round((utcDay(date) - utcDay(startDate)) / DAY_MS);

  if (parts.get("FREQ") === "DAILY") {
    if (byDay !== null && !byDay.includes(weekday)) return null;
    return days % interval === 0 ? at() : null;
  }
  if (byDay === null || !byDay.includes(weekday)) return null;
  const weeks = Math.round((days - mondayOffset(date) + mondayOffset(startDate)) / 7);
  return weeks % interval === 0 ? at() : null;
}
