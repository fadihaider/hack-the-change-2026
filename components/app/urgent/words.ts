// the urgent flow's plain wording and Alberta times (UTC-6 all year in this product), ported from variant B
import type { CommitmentView, Decision } from "@/lib/frontend/live-api.ts";
import type { RequestView } from "@/lib/frontend/request-api.ts";

export type MessageDecision = RequestView["action"];
export type Tier = RequestView["disclosureTier"];
export type Person = { contactId: string; name: string; email: string };
export type Directory = Map<string, Person>;
/** who is being cared for, as the screens name them */
export type CareName = { name: string; alias: string | null };

export function isMessageDecision(decision: Decision | null | undefined): decision is MessageDecision {
  return decision === "notify" || decision === "reschedule" || decision === "extension" || decision === "coverage";
}

// the other choices offered beside the suggested one
export const ALTERNATIVES: Record<MessageDecision, Decision[]> = {
  reschedule: ["notify", "defer"],
  extension: ["notify", "defer"],
  coverage: ["notify", "defer"],
  notify: ["reschedule", "defer"],
};

export const TIER_LABEL: Record<Tier, string> = {
  minimal: "Family matter only",
  general: "Say I’m caring for family",
  detailed: "Share more detail",
};

export const TIERS: readonly Tier[] = ["minimal", "general", "detailed"];

// the family words a "general" message can name; any other alias (a first name, say) stays "family"
const FAMILY_WORDS = new Set([
  "mom", "mum", "mother", "mama", "dad", "father", "papa", "grandma", "grandmother", "nana", "grandpa",
  "grandfather", "wife", "husband", "partner", "son", "daughter", "sister", "brother", "aunt", "uncle",
]);

/** the tier's name as the picker shows it; "Say I’m caring for my mom" only when the alias is a family word */
export function tierLabel(tier: Tier, alias: string | null) {
  if (tier !== "general") return TIER_LABEL[tier];
  const word = alias?.trim().toLowerCase().replace(/^my\s+/, "") ?? "";
  return FAMILY_WORDS.has(word) ? `Say I’m caring for my ${word}` : TIER_LABEL.general;
}

export const TIER_HINT: Record<Tier, string> = {
  minimal: "Says only that you have a family caregiving situation, and the dates.",
  general: "Adds who you’re caring for and that it’s a medical procedure, with no details.",
  detailed: "Adds what you wrote about why, word for word.",
};

// ---------------------------------------------------------------- times

const ZONE = "Etc/GMT+6";

function parts(iso: string, options: Intl.DateTimeFormatOptions) {
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return out;
  for (const part of new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, ...options }).formatToParts(ms)) {
    out[part.type] = part.value;
  }
  return out;
}

function clockParts(iso: string) {
  const p = parts(iso, { hour: "numeric", minute: "2-digit" });
  return { hm: p.minute === "00" ? (p.hour ?? "") : `${p.hour}:${p.minute}`, period: p.dayPeriod ?? "" };
}

// a non-breaking space keeps "2 p.m." on one line
export function clock(iso: string) {
  const c = clockParts(iso);
  return `${c.hm} ${c.period}`;
}

export function weekday(iso: string) {
  return parts(iso, { weekday: "long" }).weekday ?? "";
}

function dayShort(iso: string) {
  const p = parts(iso, { weekday: "long", month: "short", day: "numeric" });
  return `${p.weekday}, ${p.month} ${p.day}`;
}

/** "Sun, Nov 8, 10 a.m." */
export function stamp(iso: string) {
  const p = parts(iso, { weekday: "short", month: "short", day: "numeric" });
  return `${p.weekday}, ${p.month} ${p.day}, ${clock(iso)}`;
}

function isDeadline(c: CommitmentView) {
  return /deadline|due\b/i.test(c.title);
}

/** "Sunday, Nov 8, 10 to 11:30 a.m." or "Due Monday, Nov 9, 11 p.m." */
export function whenLine(c: CommitmentView) {
  if (!c.startsAt) return "No time set";
  if (isDeadline(c)) return `Due ${dayShort(c.startsAt)}, ${clock(c.startsAt)}`;
  const a = clockParts(c.startsAt);
  if (!c.endsAt) return `${dayShort(c.startsAt)}, ${a.hm} ${a.period}`;
  const b = clockParts(c.endsAt);
  const sameDay = weekday(c.startsAt) === weekday(c.endsAt);
  if (!sameDay) return `${dayShort(c.startsAt)}, ${a.hm} ${a.period} to ${dayShort(c.endsAt)}, ${b.hm} ${b.period}`;
  const range =
    a.period === b.period ? `${a.hm} to ${b.hm} ${b.period}` : `${a.hm} ${a.period} to ${b.hm} ${b.period}`;
  return `${dayShort(c.startsAt)}, ${range}`;
}

// ---------------------------------------------------------------- people

/**
 * contact names by id, only as the server saved them: request recipients, then the contacts the impact scan matched.
 * a name is never made up from an email address.
 */
export function buildDirectory(commitments: CommitmentView[], requests: RequestView[]): Directory {
  const dir: Directory = new Map();
  for (const r of requests) dir.set(r.recipient.contactId, r.recipient);
  for (const c of commitments) {
    for (const contact of c.contacts) {
      if (!dir.has(contact.contactId)) {
        dir.set(contact.contactId, { contactId: contact.contactId, name: contact.name, email: contact.email });
      }
    }
    for (const d of c.dependencies) {
      if (d.contactId && d.contactName && d.toRef && !dir.has(d.contactId)) {
        dir.set(d.contactId, { contactId: d.contactId, name: d.contactName, email: d.toRef });
      }
    }
  }
  return dir;
}

const TITLES = /^(?:dr|mr|mrs|ms|mx|prof)\.?$/i;

/** "Jordan" from "Jordan Lee"; a titled name keeps its title and surname ("Dr. Brooks"); an address stays whole */
export function shortName(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "them";
  if (name.includes("@")) return name.trim();
  if (words.length > 1 && TITLES.test(words[0])) return `${words[0]} ${words[words.length - 1]}`;
  return words[0];
}

export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** the people on the event besides Alex, for the "With" line: saved names, or the address itself when unknown */
export function withNames(c: CommitmentView, dir: Directory) {
  const names: string[] = [];
  for (const d of c.dependencies) {
    const person = d.contactId ? dir.get(d.contactId) : undefined;
    const name = person?.name ?? d.contactName ?? d.toRef?.trim() ?? null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------- commitments in sentences

function lowerFirst(title: string) {
  const first = title.split(" ")[0] ?? "";
  // keep codes and names that are all caps, like "ENGG 513"
  if (first.length > 1 && first === first.toUpperCase()) return title;
  return title.charAt(0).toLowerCase() + title.slice(1);
}

function curly(text: string) {
  return text.replace(/'/g, "’");
}

/** "Rosa’s", "James’" */
export function possessive(name: string) {
  return name.endsWith("s") ? `${name}’` : `${name}’s`;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** how a sentence names a commitment: "the food bank volunteer shift", "Rosa's follow-up appointment" */
export function refTitle(c: CommitmentView, care: CareName) {
  if (c.forCareRecipient) {
    const names = [care.alias, care.name].filter((n): n is string => Boolean(n)).map(escapeRegExp);
    const lead = names.length ? new RegExp(`^(?:${names.join("|")})(?:['’]s)?\\s+`, "i") : null;
    const rest = lead ? c.title.replace(lead, "") : c.title;
    return curly(`${possessive(care.name)} ${lowerFirst(rest)}`);
  }
  return curly(`the ${lowerFirst(c.title)}`);
}

/** how a button names it: "Food bank volunteer shift" */
export function buttonTitle(c: CommitmentView, care: CareName) {
  const ref = refTitle(c, care);
  if (c.forCareRecipient) return ref;
  const plain = ref.replace(/^the /, "");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

// "10 a.m." already ends with a full stop
export function endSentence(text: string) {
  return text.endsWith(".") ? text : `${text}.`;
}

/** the muted fact before the ask: "Your group project meeting is Sunday at 10 a.m." */
export function factLine(c: CommitmentView, care: CareName, appNow: string) {
  const subject = c.forCareRecipient ? refTitle(c, care) : `Your ${refTitle(c, care).replace(/^the /, "")}`;
  if (!c.startsAt) return endSentence(`${subject} is during the care week`);
  const over = Date.parse(c.endsAt ?? c.startsAt) < Date.parse(appNow);
  return endSentence(`${subject} ${over ? "was" : "is"} ${weekday(c.startsAt)} at ${clock(c.startsAt)}`);
}

export function askLine(decision: MessageDecision, name: string) {
  switch (decision) {
    case "reschedule":
      return `Ask ${name} to move it?`;
    case "extension":
      return `Ask ${name} for more time?`;
    case "coverage":
      return `Ask ${name} to find someone to cover it?`;
    case "notify":
      return `Let ${name} know you might miss it?`;
  }
}

export function sheetTitle(decision: MessageDecision, name: string) {
  switch (decision) {
    case "reschedule":
      return `Ask ${name} to move it`;
    case "extension":
      return `Ask ${name} for more time`;
    case "coverage":
      return `Ask ${name} to find cover`;
    case "notify":
      return `Let ${name} know`;
  }
}

function sentLine(decision: MessageDecision, name: string) {
  switch (decision) {
    case "reschedule":
      return `You asked ${name} to move it.`;
    case "extension":
      return `You asked ${name} for more time.`;
    case "coverage":
      return `You asked ${name} to find someone to cover it.`;
    case "notify":
      return `You let ${name} know.`;
  }
}

function answeredLine(r: RequestView, name: string) {
  switch (r.action) {
    case "coverage":
      return `${name} said yes to covering it.`;
    case "reschedule":
      return `${name} said yes to moving it.`;
    case "extension":
      return `${name} gave you more time.`;
    case "notify":
      return `${name} got your message.`;
  }
}

/** a recipient answered with another time; the other needs_review cause is a send the server stopped */
export function isProposal(r: RequestView) {
  return r.state === "needs_review" && (r.proposedAt !== null || r.evidence[0]?.evidenceKind === "link_click");
}

/** what has happened with this request, as the ask of the step */
export function outcomeLine(r: RequestView) {
  const who = shortName(r.recipient.name);
  switch (r.state) {
    case "draft":
    case "awaiting_approval":
      return `Your message to ${who} is ready for your OK.`;
    case "approved":
      return `You approved the message to ${who}. It hasn’t gone out yet.`;
    case "sending":
      return `Your message to ${who} is on its way.`;
    case "requested":
      return sentLine(r.action, who);
    case "accepted":
    case "completed":
      return answeredLine(r, who);
    case "rejected":
      return `${who} said no.`;
    case "expired":
      return `${who} didn’t reply in time.`;
    case "failed":
      return `Your message to ${who} didn’t send.`;
    case "needs_review":
      return isProposal(r) ? `${who} suggested another time.` : `Your message to ${who} needs another look.`;
    case "cancelled":
      return `You withdrew the message to ${who}.`;
  }
}

/** the step's heading when it wrote to several people, each message approved and sent on its own */
export function outcomeLineMany(requests: RequestView[]) {
  if (requests.length === 1) return outcomeLine(requests[0]);
  const ready = requests.filter(
    (r) => r.state === "draft" || r.state === "awaiting_approval" || r.state === "approved" ||
      (r.state === "needs_review" && !isProposal(r)),
  );
  const names = joinNames(requests.map((r) => shortName(r.recipient.name)));
  if (ready.length === requests.length) return `Your messages to ${names} are ready for your OK.`;
  if (ready.length === 0) return `You wrote to ${names}.`;
  return `You wrote to ${names}. ${ready.length === 1 ? "One message is" : `${ready.length} messages are`} ready for your OK.`;
}

/** when the request last changed state, from its evidence (newest first) */
export function changedAt(r: RequestView) {
  const row = r.evidence.find((e) => e.toState === r.state) ?? r.evidence[0];
  return row?.at ?? null;
}

/** "“hip” and “surgery”" */
export function quoted(terms: string[]) {
  const q = terms.map((t) => `“${t}”`);
  return joinNames(q);
}

/** the same shape lib/healthTerms.ts matches: simple plurals, "post op" for "post-op", either apostrophe */
function termPattern(term: string) {
  const lower = term.toLowerCase();
  const consonantY = /[^aeiou]y$/.test(lower);
  const stem = consonantY ? lower.slice(0, -1) : lower;
  const suffix = consonantY ? "(?:y|ies)" : "(?:s|es)?";
  const body = escapeRegExp(stem)
    .replace(/-|\s+/g, "[\\s-]?")
    .replace(/'/g, "['\u2019]?");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${suffix}(?![\\p{L}\\p{N}])`, "giu");
}

/** drops the flagged words and tidies the spaces they leave behind */
export function removeTerms(text: string, terms: string[]) {
  let out = text;
  for (const term of terms) out = out.replace(termPattern(term), "");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.?!;:])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

export function editFlagNote(flag: string, name: string) {
  if (flag === "other_email") return `It has an email address that isn’t ${name}’s. Check it before sending.`;
  if (flag === "url") return "It has a web link. Check it before sending.";
  if (flag === "html") return "It has formatting code in it. Check how it reads before sending.";
  return null;
}
