// dates, times and recurrence rules used by the model-step guards
// Alberta has used Alberta Time (UTC-6) all year since 2026-11-01, so a fixed offset is used instead of tz data

export const ALBERTA_OFFSET = "-06:00";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// same order as Date.getUTCDay
const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** true for a real calendar date written as YYYY-MM-DD */
export function isIsoDate(value: string | null | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_DATE.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekdayIndex(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function dayOfWeek(isoDate: string): string {
  return WEEKDAYS[weekdayIndex(isoDate)];
}

/** true for a 24-hour HH:MM time */
export function isHhMm(value: string | null | undefined): value is string {
  return typeof value === "string" && HH_MM.test(value);
}

/** UTC ISO timestamp for a wall-clock time on a date in Alberta Time */
export function albertaTimestamp(isoDate: string, hhmm: string): string {
  return new Date(`${isoDate}T${hhmm}:00${ALBERTA_OFFSET}`).toISOString();
}

const TIME_MENTION = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\w:])/gi;
// "1030 hrs", "0830h"; the suffix keeps doses like "1000 mg" and years out
const HOURS_MENTION = /(?<![\d:])([01]\d|2[0-3])([0-5]\d)\s*h(?:rs?)?\b/g;
const OCLOCK_MENTION = /(?<![\d:])(\d{1,2})\s*o'?\s?clock\b/g;

/**
 * Every HH:MM time a piece of text could mean. A bare number with neither minutes nor am/pm is ignored,
 * so doses and counts ("take 2") never count as times. "8:00" or "8 o'clock" without am/pm can mean 08:00 or 20:00;
 * "08:00" with a leading zero and "20:15" are 24-hour times and mean only that.
 */
export function timesMentioned(text: string): Set<string> {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  if (/\bnoon\b/.test(lower)) {
    found.add("12:00");
  }
  if (/\bmidnight\b/.test(lower)) {
    found.add("00:00");
  }
  for (const match of lower.matchAll(HOURS_MENTION)) {
    found.add(`${match[1]}:${match[2]}`);
  }
  for (const match of lower.matchAll(OCLOCK_MENTION)) {
    const hour = Number(match[1]);
    if (hour >= 1 && hour <= 12) {
      found.add(`${pad(hour % 12)}:00`);
      found.add(`${pad((hour % 12) + 12)}:00`);
    }
  }
  for (const match of lower.matchAll(TIME_MENTION)) {
    const hour = Number(match[1]);
    const minutes = match[2];
    const meridiem = match[3]?.replace(/[\s.]/g, "");
    if (minutes === undefined && meridiem === undefined) {
      continue;
    }
    const mm = minutes ?? "00";
    if (meridiem === "am" || meridiem === "pm") {
      if (hour < 1 || hour > 12) {
        continue;
      }
      const base = hour % 12;
      found.add(`${pad(meridiem === "pm" ? base + 12 : base)}:${mm}`);
    } else if (hour <= 23) {
      found.add(`${pad(hour)}:${mm}`);
      if (hour >= 1 && hour <= 11 && !match[1].startsWith("0")) {
        found.add(`${pad(hour + 12)}:${mm}`);
      }
    }
  }
  return found;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Accepts only FREQ=DAILY, or FREQ=WEEKLY with BYDAY, each with optional INTERVAL (1 to 14).
 * A weekly rule needs BYDAY because code can't otherwise know which weekday it repeats on.
 * Returns the rule in a canonical key order, or null when anything else is present.
 */
export function canonicalRrule(rule: string | null | undefined): string | null {
  if (typeof rule !== "string" || rule.trim() === "") {
    return null;
  }
  const parts = new Map<string, string>();
  for (const piece of rule.trim().replace(/^RRULE:/i, "").split(";")) {
    if (piece === "") {
      continue;
    }
    const [key, value, ...rest] = piece.split("=");
    if (!key || value === undefined || rest.length > 0 || parts.has(key.toUpperCase())) {
      return null;
    }
    parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY") {
    return null;
  }
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY"]);
  if ([...parts.keys()].some((key) => !allowed.has(key))) {
    return null;
  }
  const out = [`FREQ=${freq}`];
  const interval = parts.get("INTERVAL");
  if (interval !== undefined) {
    const n = Number(interval);
    if (!/^\d+$/.test(interval) || n < 1 || n > 14) {
      return null;
    }
    out.push(`INTERVAL=${n}`);
  }
  const byday = parts.get("BYDAY");
  if (byday !== undefined) {
    const days = byday.split(",");
    if (days.length === 0 || days.some((day) => !RRULE_DAYS.includes(day)) || new Set(days).size !== days.length) {
      return null;
    }
    out.push(`BYDAY=${days.join(",")}`);
  } else if (freq === "WEEKLY") {
    return null;
  }
  return out.join(";");
}

// full names ("Monday", "mondays") or abbreviations ("Mon", "Tues.", "Thurs"); lowercase "sun", "sat", "wed" and
// "mon" are ordinary words, so those abbreviations count only when capitalized
const DAY_WORD = /\b(?:(sun|mon|tues|wednes|thurs|fri|satur)days?|(sun|mon|tues?|weds?|thu(?:rs?)?|fri|sat)\.?)(?![a-z])/gi;
const DAY_RANGE_LINK = /^\s*(?:-|to|through|thru|until)\s*$/i;
const RELATIVE_DAY = /\b(?:today|tonight|tomorrow|yesterday|next (?:week|month))\b/i;
const DAILY_CUE =
  /\b(?:daily|nightly|everyday|(?:every|each) (?:other |\d+ )?(?:day|days|morning|afternoon|evening|night)|(?:once|twice|\d+ times) (?:a|per) day|per day)\b/i;
const WEEKLY_CUE = /\b(?:every|each|weekly|weekdays|weekends|(?:sun|mon|tues|wednes|thurs|fri|satur)days)\b/i;
const INTERVAL_CUE = /\bevery (?:other|second|third|fourth|\d+)\b/i;

/** RRULE day codes the text names, with ranges ("Mon-Fri", "Monday to Friday"), weekdays and weekends expanded */
function readDays(text: string): { days: Set<string>; hasRange: boolean } {
  const days = new Set<string>();
  let hasRange = false;
  let previous: { day: number; end: number } | null = null;
  for (const match of text.matchAll(DAY_WORD)) {
    const word = match[0];
    if (match[1] === undefined && !/^[A-Z]/.test(word) && !/^(?:tue|thu|fri)/i.test(word)) {
      continue;
    }
    const day = RRULE_DAYS.indexOf((match[1] ?? match[2]).slice(0, 2).toUpperCase());
    if (previous !== null && DAY_RANGE_LINK.test(text.slice(previous.end, match.index))) {
      hasRange = true;
      for (let d: number = previous.day; d !== day; d = (d + 1) % 7) {
        days.add(RRULE_DAYS[d]);
      }
    }
    days.add(RRULE_DAYS[day]);
    previous = { day, end: match.index + word.length };
  }
  if (/\bweekdays?\b/i.test(text)) {
    ["MO", "TU", "WE", "TH", "FR"].forEach((day) => days.add(day));
  }
  if (/\bweekends?\b/i.test(text)) {
    days.add("SA");
    days.add("SU");
  }
  return { days, hasRange };
}

/** true when the text names a weekday or a relative day, so code can't place it on the episode start */
export function namesDay(text: string): boolean {
  return RELATIVE_DAY.test(text) || readDays(text).days.size > 0;
}

/**
 * true when a canonical rule is written in the text: every BYDAY day is named and the text says it repeats,
 * a DAILY rule needs words like "daily" or "every morning", and INTERVAL above 1 needs "every other" or "every 2".
 */
export function isRuleGrounded(rule: string, text: string): boolean {
  const interval = Number(/INTERVAL=(\d+)/.exec(rule)?.[1] ?? "1");
  if (interval > 1 && !INTERVAL_CUE.test(text)) {
    return false;
  }
  const byDay = /BYDAY=([A-Z,]+)/.exec(rule)?.[1].split(",");
  if (byDay === undefined) {
    return rule.startsWith("FREQ=DAILY") && DAILY_CUE.test(text);
  }
  const { days, hasRange } = readDays(text);
  return (hasRange || WEEKLY_CUE.test(text)) && byDay.every((day) => days.has(day));
}

/** first date on or after the anchor that the rule allows, so starts_at is a real occurrence */
export function ruleStartDate(anchor: string, rule: string): string {
  const byDay = /BYDAY=([A-Z,]+)/.exec(rule)?.[1].split(",");
  for (let offset = 0; byDay !== undefined && offset < 7; offset += 1) {
    const day = addDays(anchor, offset);
    if (byDay.includes(RRULE_DAYS[weekdayIndex(day)])) {
      return day;
    }
  }
  return anchor;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// the lookahead keeps "5 decaf" and "2 Septra" from reading as dates
const MONTH_WORD =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])\\.?";
// a year is 19xx or 20xx and not a 24-hour time, so "November 14 1030 hrs" and "November 14 1930 hrs" keep the inferred year
const YEAR = "(?:,?\\s+((?:19|20)\\d{2})(?!\\d|\\s*h(?:rs?)?\\b))?";
const MONTH_DAY = new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b${YEAR}`, "gi");
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}${YEAR}`, "gi");
const ISO_IN_TEXT = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// "1 or 2 may be taken": after a number, "may" is the verb unless it is capitalized and no verb follows
const MAY_VERB = /^\s+(?:be|not|also|take|have|cause|need|help|feel|use|get|go|eat|drink|start|stop|continue|resume|return|increase|occur|become)\b/i;

/**
 * Every calendar date a piece of text spells out ("November 14", "14 Nov", "2026-11-14").
 * Numeric forms like 11/14 are ignored because day and month order is ambiguous.
 * A date without a year takes the reference year, or the next year if it would fall more than 30 days before the
 * reference or does not exist in the reference year (February 29).
 */
export function datesMentioned(text: string, referenceIso: string): Set<string> {
  const found = new Set<string>();
  const referenceYear = Number(referenceIso.slice(0, 4));
  const earliest = addDays(referenceIso, -30);
  const add = (year: number | undefined, monthIndex: number, day: number): void => {
    for (const candidateYear of year === undefined ? [referenceYear, referenceYear + 1] : [year]) {
      const iso = toIso(candidateYear, monthIndex, day);
      if (iso !== null && (year !== undefined || iso >= earliest)) {
        found.add(iso);
        return;
      }
    }
  };
  for (const match of text.matchAll(MONTH_DAY)) {
    add(match[3] ? Number(match[3]) : undefined, monthIndex(match[1]), Number(match[2]));
  }
  for (const match of text.matchAll(DAY_MONTH)) {
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (match[2].toLowerCase() === "may" && (match[2] !== "May" || MAY_VERB.test(after))) {
      continue;
    }
    add(match[3] ? Number(match[3]) : undefined, monthIndex(match[2]), Number(match[1]));
  }
  for (const match of text.matchAll(ISO_IN_TEXT)) {
    if (isIsoDate(match[0])) {
      found.add(match[0]);
    }
  }
  return found;
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.toLowerCase().slice(0, 3));
}

function toIso(year: number, monthIndex: number, day: number): string | null {
  if (monthIndex < 0) {
    return null;
  }
  const iso = `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
  return isIsoDate(iso) ? iso : null;
}
