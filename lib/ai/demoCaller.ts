// offline, deterministic stand-in for the model (RR_AI=demo): simple keyword rules, no network, no model.
// it answers with schema-valid JSON for each step, and every result still goes through the same code guards.
// it is not AI and must never be presented as AI output.
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { CARE_COMPILER_SYSTEM_PROMPT, CARE_CATEGORIES, type CareCategory, type CareCompilerOutput } from "./careCompiler.ts";
import { DRAFTER_SYSTEM_PROMPT, type DrafterOutput } from "./drafter.ts";
import { IMPACT_SYSTEM_PROMPT, type CommitmentDecision, type ImpactOutput } from "./impact.ts";
import { INTAKE_SYSTEM_PROMPT, type IntakeOutput } from "./intake.ts";
import { ModelCallError, type ModelCaller, type StepName } from "./model.ts";
import { PROFILE_QA_SYSTEM_PROMPT, type ProfileQaOutput } from "./profileQa.ts";
import { RESOURCE_SYSTEM_PROMPT, type ResourceOutput } from "./resources.ts";
import { keywordMatches } from "./retrieval.ts";
import { addDays, datesMentioned, isIsoDate, spokenClockTimes, timesMentioned } from "./time.ts";

export const DEMO_MODEL = "demo";

const STEPS: [string, StepName][] = [
  [INTAKE_SYSTEM_PROMPT, "intake"],
  [IMPACT_SYSTEM_PROMPT, "impact"],
  [DRAFTER_SYSTEM_PROMPT, "drafter"],
  [CARE_COMPILER_SYSTEM_PROMPT, "care_compiler"],
  [PROFILE_QA_SYSTEM_PROMPT, "profile_qa"],
  [RESOURCE_SYSTEM_PROMPT, "resource_composer"],
];

let messageCount = 0;

export const demoCaller: ModelCaller = async (params) => {
  const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((block) => block.text).join("\n");
  const step = STEPS.find(([prompt]) => prompt === system)?.[1];
  if (step === undefined) {
    throw new ModelCallError(null, "demo_unknown_step");
  }
  const content = userText(params);
  const output = respond(step, content);
  const text = JSON.stringify(output);
  messageCount += 1;
  const message: Message = {
    id: `msg_demo_${messageCount}`,
    type: "message",
    role: "assistant",
    model: params.model,
    container: null,
    diagnostics: null,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      // rough size estimate (4 characters per token) so the spend view has numbers to show
      input_tokens: Math.ceil((system.length + content.length) / 4),
      output_tokens: Math.ceil(text.length / 4),
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
  return message;
};

function respond(step: StepName, content: string): unknown {
  switch (step) {
    case "intake":
      return demoIntake(content);
    case "impact":
      return demoImpact(content);
    case "drafter":
      return demoDraft(content);
    case "care_compiler":
      return demoCare(content);
    case "profile_qa":
      return demoProfileQa(content);
    case "resource_composer":
      return demoResources(content);
    default: {
      const unreachable: never = step;
      throw new ModelCallError(null, `demo_${String(unreachable)}`);
    }
  }
}

/** all text blocks of the user turn; document blocks (PDF) are skipped, the extracted text follows them */
function userText(params: MessageCreateParamsNonStreaming): string {
  const content = params.messages[0]?.content ?? "";
  if (typeof content === "string") {
    return content;
  }
  return content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** the text inside each <untrusted> block, in order */
function untrustedBlocks(content: string): string[] {
  return [...content.matchAll(/<untrusted>\n([\s\S]*?)\n<\/untrusted>/g)].map((match) => match[1]);
}

function parseJson<T>(text: string | undefined, fallback: T): T {
  try {
    return text === undefined ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- A1 intake

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, few: 3, couple: 2,
};
const ALIAS = /\b(?:mom|mum|mother|mama|dad|father|papa|grandma|grandmother|grandpa|grandfather|nana|oma|opa|wife|husband|partner|son|daughter|sister|brother|aunt|uncle)\b/i;
const REASONS = [
  /\b(?:(?:day|hip|knee|heart|eye|back|minor|major)\s+)?(?:surgery|operation|procedure)\b/i,
  /\b(?:hip|knee|joint)\s+replacement\b/i,
  /\b(?:a\s+)?(?:bad\s+)?fall\b/i,
  /\bstroke\b/i,
  /\bchemo(?:therapy)?\b/i,
];

function demoIntake(content: string): IntakeOutput {
  const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(content)?.[1] ?? "";
  const statement = untrustedBlocks(content)[0] ?? "";
  const lower = statement.toLowerCase();

  let startDate: string | null = null;
  let endDate: string | null = null;
  if (isIsoDate(today)) {
    const written = [...datesMentioned(statement, today)].sort();
    const { start: startDay, end: endDay } = weekdayMentions(lower);
    if (written.length > 0) {
      startDate = written[0];
    } else if (/\btomorrow\b/.test(lower)) {
      startDate = addDays(today, 1);
    } else if (/\b(?:today|tonight|from now|right now|starting now)\b/.test(lower)) {
      startDate = today;
    } else if (startDay !== null) {
      startDate = nextWeekday(today, startDay, false);
    }
    const days = durationDays(lower);
    if (startDate !== null && days !== null) {
      endDate = addDays(startDate, days - 1);
    } else if (startDate !== null && written.length > 1) {
      endDate = written[written.length - 1];
    } else if (startDate !== null && endDay !== null) {
      endDate = nextWeekday(startDate, endDay, true);
    }
  }

  const clarifyingQuestions: string[] = [];
  if (startDate === null) {
    clarifyingQuestions.push("What day does the caregiving start?");
  }
  if (endDate === null) {
    clarifyingQuestions.push("How long do you expect to be caregiving? Please give an end date.");
  }
  const reason = REASONS.map((pattern) => pattern.exec(statement)?.[0]).find((value) => value !== undefined);
  return {
    startDate,
    endDate,
    recipientAlias: ALIAS.exec(statement)?.[0] ?? null,
    reasonText: reason ?? null,
    helpRequested: helpRequests(statement),
    clarifyingQuestions,
  };
}

/** weekday indexes in statement order: the first plain mention is the start, one after "until" is the end */
function weekdayMentions(lower: string): { start: number | null; end: number | null } {
  let start: number | null = null;
  let end: number | null = null;
  for (const match of lower.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const day = WEEKDAYS.indexOf(match[1]);
    if (/\b(?:until|till|through|thru|to)\s+(?:next\s+)?$/.test(lower.slice(0, match.index))) {
      end ??= day;
    } else {
      start ??= day;
    }
  }
  return { start, end };
}

/** the next date with that weekday after `from` (or on it, when sameDayCounts) */
function nextWeekday(from: string, weekday: number, sameDayCounts: boolean): string {
  const fromIndex = new Date(`${from}T00:00:00Z`).getUTCDay();
  const ahead = (weekday - fromIndex + 7) % 7;
  return addDays(from, ahead === 0 && !sameDayCounts ? 7 : ahead);
}

const COUNT = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|few|couple)";

/** "for a week" is 7 days, "for 3 days" is 3, "two weeks" is 14; null when no duration is written */
function durationDays(lower: string): number | null {
  // "for a week" needs "for", so "a day surgery" is never read as one day
  const match =
    new RegExp(`\\bfor\\s+(?:the\\s+next\\s+)?(?:a\\s+)?(a|an|${COUNT.slice(1, -1)})\\s+(?:of\\s+)?(days?|weeks?)\\b`).exec(lower) ??
    new RegExp(`\\b${COUNT}\\s+(?:of\\s+)?(days?|weeks?)\\b`).exec(lower);
  if (match === null) {
    return /\b(?:for|all) (?:the|this|next) week\b/.test(lower) ? 7 : null;
  }
  const count = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
  const total = match[2].startsWith("week") ? count * 7 : count;
  return total >= 1 ? total : null;
}

/** sentences that ask for something: "Please handle ..." or "Can you help me ..." */
function helpRequests(statement: string): string[] {
  return splitSentences(statement)
    .map((sentence) => /^(?:please|can you|could you|would you)\s+(.+?)[.?!]*$/i.exec(sentence)?.[1] ?? null)
    .filter((item): item is string => item !== null)
    .slice(0, 5);
}

// ---------------------------------------------------------------- A2 impact

interface DemoEvent {
  id: string;
  title: string;
  organizerEmail: string | null;
  attendees: { email: string | null }[];
}

function demoImpact(content: string): ImpactOutput {
  const payload = parseJson<{ recipientAliases?: string[]; events?: DemoEvent[] }>(untrustedBlocks(content)[0], {});
  const aliases = (payload.recipientAliases ?? []).map((alias) => alias.toLowerCase().replace(/^my\s+/, ""));
  return {
    events: (payload.events ?? []).map((event) => {
      const title = event.title.toLowerCase();
      const attendees = event.attendees.map((attendee) => attendee.email).filter((email): email is string => email !== null);
      const targets =
        attendees.length > 0
          ? attendees.map((email) => ({ toKind: "attendee", toRef: email, evidenceText: "Listed as an attendee of this event." }))
          : event.organizerEmail
            ? [{ toKind: "organizer", toRef: event.organizerEmail, evidenceText: "Organizes this event." }]
            : [];
      return { eventId: event.id, suggestedAction: actionFor(title, aliases), candidateDependencies: targets };
    }),
  };
}

function actionFor(title: string, aliases: string[]): CommitmentDecision {
  const words = new Set(title.split(/[^\p{L}\p{N}]+/u));
  if (aliases.some((alias) => alias.length > 1 && words.has(alias)) || /\b(?:mom|mum|mother|dad|father|appointment)\b/.test(title)) {
    return "keep";
  }
  if (/\bshift\b/.test(title)) {
    return "coverage";
  }
  if (/\b(?:deadline|due|assignment|submission)\b/.test(title)) {
    return "extension";
  }
  if (/\b(?:meeting|call|sync|standup|session)\b/.test(title)) {
    return "reschedule";
  }
  return "notify";
}

// ---------------------------------------------------------------- A3 drafter

interface DemoDraftPayload {
  tier?: string;
  action?: string;
  recipientFirstName?: string | null;
  relationship?: string | null;
  commitmentTitle?: string | null;
  commitmentStartLocal?: string | null;
  unavailableFrom?: string;
  unavailableUntil?: string;
  reasonText?: string | null;
  userNote?: string | null;
}

function demoDraft(content: string): DrafterOutput {
  const p = parseJson<DemoDraftPayload>(untrustedBlocks(content)[0], {});
  const title = p.commitmentTitle ?? "our plans";
  const when = p.commitmentStartLocal ? ` on ${p.commitmentStartLocal}` : "";
  const window = p.unavailableFrom && p.unavailableUntil ? ` from ${p.unavailableFrom} to ${p.unavailableUntil}` : "";
  const relationship = p.relationship ?? "a family member";

  // tier-correct opening; minimal and general never name a condition
  let situation = `I'm dealing with a family caregiving situation and will have limited availability${window}.`;
  if (p.tier === "general") {
    situation = `I'm helping ${relationship}, who is recovering from a medical procedure, and will have limited availability${window}.`;
  } else if (p.tier === "detailed") {
    situation = p.reasonText
      ? `I'm caring for ${relationship} (${p.reasonText}) and will have limited availability${window}.`
      : `I'm caring for ${relationship} and will have limited availability${window}.`;
  }

  const asks: Record<string, [string, string]> = {
    notify: [`Update about ${title}`, `I wanted to let you know that I won't be able to make ${title}${when}.`],
    reschedule: [`Request to reschedule ${title}`, `Could we reschedule ${title}${when} to a time after that?`],
    extension: [`Extension request: ${title}`, `Would it be possible to get an extension on ${title}${when}?`],
    coverage: [`Coverage request: ${title}`, `Would you be able to cover ${title}${when} for me?`],
  };
  const [subject, ask] = asks[p.action ?? "notify"] ?? asks.notify;
  const note = p.userNote ? `\n\n${p.userNote}` : "";
  const body = `Hi ${p.recipientFirstName ?? "there"},\n\n${situation} ${ask}${note}\n\nThank you for understanding.`;
  return { subject, body };
}

// ---------------------------------------------------------------- A4 care compiler

interface DemoExistingFact {
  id: string;
  category: string;
  textExact: string;
  time: string | null;
}

// checked in order; meals and naps first, so "Breakfast at 8:30 with medication." stays a routine. belongings come
// before contacts so "her phone is in the drawer" is practical; the loose "is in" rule runs after logistics, so
// "the appointment is in the afternoon" stays logistics
const CATEGORY_RULES: [CareCategory, RegExp][] = [
  ["routine", /\b(?:breakfast|lunch|dinner|supper|meals?|naps?|bedtime|wakes? up)\b/i],
  [
    "medical_instruction",
    /\b(?:medications?|medicines?|pills?|tablets?|inhalers?|insulin|incisions?|pain|wounds?|dressings?|fever|emergency|dose|mg|lift|stitches)\b/i,
  ],
  ["practical", /\b(?:glasses|keys?|drawers?|wallet|purse|remote|charger|spare|cupboard|closet|shelf|kept in)\b/i],
  ["contacts", /\b(?:call|phone|text)\b/i],
  ["mobility", /\b(?:walks?|walking|cane|walker|wheelchair|stairs|transfers?)\b/i],
  [
    "communication",
    /\b(?:speak|speaks|talk|face|lips|hearing|hard of hearing|listen|written down|in writing|write (?:it|things) down|languages?|interpreter|slowly)\b/i,
  ],
  ["logistics", /\b(?:appointments?|pharmacy|pick ?up|drop ?off|deliver(?:s|y)?|ride|parking)\b/i],
  ["practical", /\b(?:is|are) (?:kept )?in\b/i],
  ["preference", /\b(?:likes?|prefers?|loves?|enjoys?|dislikes?|favou?rite|radio|music|songs?)\b/i],
];
// greetings, labels and text addressed to a machine are skipped, as the real prompt asks
const SKIP = /^(?:okay|ok|so|um|hi|hello|hey|thanks|thank you)\b|\b(?:fictional|demo)\b|\b(?:ai|assistant|system note|ignore (?:all|previous))\b/i;
const DAILY = /\b(?:daily|every ?day|each day|every (?:morning|afternoon|evening|night))\b/i;
const DAY_NAME = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(s?)\b/gi;
const STOPWORDS = new Set([
  "with", "that", "this", "from", "have", "your", "their", "them", "they", "then", "than", "until", "into", "over",
  "also", "just", "only", "some", "very", "every", "each", "about", "after", "before", "when", "will", "what",
  "where", "which", "while", "does", "should", "would", "could", "there", "here", "usually", "around", "please",
]);

function demoCare(content: string): CareCompilerOutput {
  const episodeStart = /Episode start date: (\d{4}-\d{2}-\d{2})/.exec(content)?.[1] ?? "";
  const [source = "", existingJson] = untrustedBlocks(content);
  const existing = parseJson<DemoExistingFact[]>(existingJson, []);
  const facts: CareCompilerOutput["facts"] = [];
  const conflicts: CareCompilerOutput["conflicts"] = [];

  for (const sentence of splitSentences(source)) {
    if (SKIP.test(sentence) || sentence.split(" ").length < 3 || facts.length >= 100) {
      continue;
    }
    const category = CATEGORY_RULES.find(([, pattern]) => pattern.test(sentence))?.[0] ?? "routine";
    const time = firstTime(sentence);
    const date = isIsoDate(episodeStart) ? ([...datesMentioned(sentence, episodeStart)][0] ?? null) : null;
    const index = facts.length;
    facts.push({ category, textExact: sentence, date, time, rrule: recurrence(sentence) });

    // a conflict: an existing fact of the same category about the same thing at a different time
    if (time !== null) {
      for (const fact of existing) {
        if (fact.category === category && fact.time !== null && fact.time !== time && sharesTopic(fact.textExact, sentence)) {
          conflicts.push({
            newFactIndex: index,
            existingFactId: fact.id,
            reason: `Times differ: ${fact.time} in the profile and ${time} in this source.`,
          });
        }
      }
    }
  }
  return { facts, conflicts };
}

// a time without am or pm ("6:00", "at six") can mean morning or evening; these words say the sentence means the later
// half, each with the clock hours (1 to 11) where that reading is plausible, so "a walk at 10:00 before dinner" is
// never read as 22:00. "nap" can be either half, so a nap time with no other cue is left for a person
const LATER_IN_DAY: [RegExp, number, number][] = [
  [/\b(?:dinner|supper)\b/i, 4, 9],
  [/\b(?:bed|bedtime|night|nightly)\b/i, 7, 11],
  [/\b(?:evening|tonight)\b/i, 4, 11],
  [/\bafternoon\b/i, 1, 5],
];
const EARLY_IN_DAY = /\b(?:breakfast|morning|wakes?|waking)\b/i;
const EITHER_HALF = /\bnaps?\b/i;

/**
 * the first clock time written in the text as HH:MM, digits ("8:30") or words ("at eight", "half past eight"); null
 * when none. without am or pm it is the evening reading when the sentence speaks only of the evening or afternoon at a
 * plausible hour ("dinner at 6:00" is 18:00), the morning reading when it gives no such cue, and null when it names
 * both halves, a later-half cue at an unlikely hour, or only a nap. never a time the guard would not find in the text.
 */
function firstTime(text: string): string | null {
  const lower = text.toLowerCase();
  const mentioned = timesMentioned(text);
  // a spoken time with no am or pm comes back as its morning reading; both readings are then in mentioned
  const candidates: { index: number; time: string; bare: boolean }[] = spokenClockTimes(text).map((spoken) => ({
    ...spoken,
    bare: mentioned.has(laterReading(spoken.time) ?? ""),
  }));
  const match = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\w:])/g;
  for (const found of lower.matchAll(match)) {
    const [, hourText, minutes, meridiem] = found;
    if (minutes === undefined && meridiem === undefined) {
      continue;
    }
    let hour = Number(hourText);
    const pm = meridiem?.startsWith("p") ?? false;
    if (meridiem !== undefined) {
      if (hour < 1 || hour > 12) {
        continue;
      }
      hour = (hour % 12) + (pm ? 12 : 0);
    } else if (hour > 23) {
      continue;
    }
    // "08:00" with a leading zero is a 24-hour time; "8:00" can be either half of the day
    const bare = meridiem === undefined && hour >= 1 && hour <= 11 && !hourText.startsWith("0");
    candidates.push({ index: found.index, time: `${String(hour).padStart(2, "0")}:${minutes ?? "00"}`, bare });
  }
  const first = candidates.sort((a, b) => a.index - b.index).find((candidate) => mentioned.has(candidate.time));
  if (first !== undefined) {
    return first.bare ? halfOfDay(text, first.time, mentioned) : first.time;
  }
  return /\b(?:noon|midday)\b/.test(lower) ? "12:00" : null;
}

/** the 13:00 to 23:59 reading of a morning HH:MM, or null */
function laterReading(time: string): string | null {
  const hour = Number(time.slice(0, 2));
  return hour >= 1 && hour <= 11 ? `${String(hour + 12).padStart(2, "0")}${time.slice(2)}` : null;
}

/** the reading of a time without am or pm that the sentence supports, or null when it does not say which */
function halfOfDay(text: string, morning: string, mentioned: Set<string>): string | null {
  const cues = LATER_IN_DAY.filter(([pattern]) => pattern.test(text));
  const early = EARLY_IN_DAY.test(text);
  if (cues.length > 0 && early) {
    return null;
  }
  if (cues.length > 0) {
    const hour = Number(morning.slice(0, 2));
    const evening = laterReading(morning);
    const plausible = cues.some(([, from, to]) => hour >= from && hour <= to);
    return plausible && evening !== null && mentioned.has(evening) ? evening : null;
  }
  return !early && EITHER_HALF.test(text) ? null : morning;
}

/** FREQ=DAILY for "every morning", FREQ=WEEKLY;BYDAY=MO,TH for "Every Monday and Thursday"; otherwise null */
function recurrence(text: string): string | null {
  const days: string[] = [];
  let plural = false;
  for (const match of text.matchAll(DAY_NAME)) {
    const code = match[1].slice(0, 2).toUpperCase();
    if (!days.includes(code)) {
      days.push(code);
    }
    plural ||= match[2] === "s";
  }
  if (days.length > 0 && (plural || /\b(?:every|each)\b/i.test(text))) {
    return `FREQ=WEEKLY;BYDAY=${days.join(",")}`;
  }
  return DAILY.test(text) ? "FREQ=DAILY" : null;
}

function keywords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word.length >= 4 && !STOPWORDS.has(word)).map(stem),
  );
}

function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** words written capitalized in a text, such as names ("Rosa", "Mom"), lowercased and stemmed like keywords */
function capitalized(text: string): Set<string> {
  return new Set((text.match(/\p{Lu}\p{L}*/gu) ?? []).map((word) => stem(word.toLowerCase())));
}

/**
 * true when two facts share a topic word. a word capitalized in both that no category rule knows, like the person's
 * name, is not a topic, so "Rosa has lunch at noon." never conflicts with "Rosa has breakfast at 8:00." just because
 * both name Rosa, while "Breakfast at 8:30." and "Breakfast at 8:00." still do
 */
function sharesTopic(a: string, b: string): boolean {
  const capitalizedInA = capitalized(a);
  const isName = (word: string): boolean =>
    capitalizedInA.has(word) && capitalized(b).has(word) && !CATEGORY_RULES.some(([, pattern]) => pattern.test(word));
  const left = keywords(a);
  return [...keywords(b)].some((word) => left.has(word) && !isName(word));
}

// ---------------------------------------------------------------- A5 profile Q&A

// exact-fact lookup by shared words and a small synonym list (lib/ai/retrieval.ts); the wording says it is not AI
function demoProfileQa(content: string): ProfileQaOutput {
  const [question = "", factsJson] = untrustedBlocks(content);
  const facts = parseJson<{ id: string; category: string; textExact: string }[]>(factsJson, []).filter(
    (fact) => typeof fact?.id === "string" && typeof fact.textExact === "string",
  );
  const cited = keywordMatches(question, facts, 3);
  if (cited.length === 0) {
    return { answer: "unknown", citedFactIds: [], notFound: true };
  }
  const count = cited.length === 1 ? "1 approved fact shares words" : `${cited.length} approved facts share words`;
  return {
    answer: `Demo keyword match, not AI: ${count} with this question. The exact text is below.`,
    citedFactIds: cited.map((fact) => fact.id),
    notFound: false,
  };
}

// ---------------------------------------------------------------- A6 resources

function demoResources(content: string): ResourceOutput {
  const rows = parseJson<{ id: string; kind: string; meters: number | null }[]>(untrustedBlocks(content)[1], []);
  const ordered = [...rows].sort((a, b) => (a.meters ?? Number.POSITIVE_INFINITY) - (b.meters ?? Number.POSITIVE_INFINITY));
  return {
    cards: ordered.map((row) => ({
      resourceId: row.id,
      why:
        row.meters === null
          ? `A ${row.kind.replace(/_/g, " ")} listed in the Calgary data.`
          : `A ${row.kind.replace(/_/g, " ")} about ${distance(row.meters)} from the address.`,
      caveats: "Hours and services can change, so call ahead to confirm.",
    })),
  };
}

function distance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

// ---------------------------------------------------------------- shared

const ABBREVIATION = /\b(?:dr|mr|mrs|ms|st|ave|approx|e\.g|i\.e|vs|no)\.$/i;

/** sentences split on . ! or ? followed by a space; "38.5" and "Dr. Lee" stay whole */
function splitSentences(text: string): string[] {
  const pieces = text.split(/(?<=[.!?])\s+/);
  const sentences: string[] = [];
  for (const piece of pieces) {
    const previous = sentences[sentences.length - 1];
    if (previous !== undefined && ABBREVIATION.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${piece}`;
    } else if (piece.trim().length > 0) {
      sentences.push(piece.trim());
    }
  }
  return sentences;
}
