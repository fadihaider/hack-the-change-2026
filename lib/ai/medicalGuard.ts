// deterministic check that runs before any A5 model call (PRD 7.2, section 15): a question asking for medical
// judgment, or describing an emergency, gets a fixed non-diagnostic pointer to 811 or 911 instead of model wording.
// this is a safety net, not triage. a false positive only adds the notice; a miss still meets the medical_instruction
// guard in profileQa.ts. pure: no network, no model.
import { normalizeText } from "./text.ts";

export type QuestionKind = "profile" | "medical" | "emergency";

export const MEDICAL_REDIRECT =
  "ReliefReady can’t give medical advice. For health questions call Health Link at 811. If this is an emergency, call 911.";
export const EMERGENCY_REDIRECT =
  "If this is an emergency, call 911 now. ReliefReady can’t give medical advice. For other health questions call Health Link at 811.";

// any one of these means the question may describe an emergency happening now
const EMERGENCY: readonly RegExp[] = [
  /\b(?:not|isnt|isn't|cant|can't|cannot|can not|wont|won't|stopped|stops|struggling to|trouble|hard to|difficulty) breath(?:e|ing)?\b/,
  /\bshort(?:ness)? of breath\b/,
  /\bchest (?:pain|pains|pressure|tightness|hurts?)\b/,
  /\b(?:unconscious|unresponsive|passed out|fainted|collapsed|blacked out)\b/,
  /\b(?:wont|won't|will not|cant|can't|cannot) wake(?: up)?\b/,
  /\bstroke\b/,
  /\bface (?:is )?droop/,
  /\bslurr(?:ed|ing) (?:speech|words)\b/,
  /\b(?:severe|heavy|heavily|serious|a lot of) (?:bleeding|blood)\b/,
  /\bbleeding (?:wont|won't|will not|doesnt|doesn't|does not|hasnt|hasn't|has not) stop/,
  /\b(?:fell|fallen|falls) (?:down )?and (?:cant|can't|cannot|can not) get up\b/,
  /\boverdos/,
  /\btook too (?:much|many)\b/,
  /\bseizure|\bconvuls/,
  /\bchoking\b/,
  /\bsuicid/,
  /\bblue lips\b|\blips (?:are |look |turning )?blue\b/,
];

const MEDICINE = String.raw`(?:medication|medications|medicine|medicines|meds|pills?|tablets?|dose|doses|dosage|painkillers?|acetaminophen|tylenol|ibuprofen|advil|aspirin|insulin|prescription|antibiotics?|drug|drugs)`;

// questions that ask ReliefReady to judge health, treatment or symptoms
const MEDICAL: readonly RegExp[] = [
  /\bdos(?:e|es|age|ages|ing)\b/,
  new RegExp(String.raw`\b(?:increase|decrease|raise|lower|double|halve|stop|stopping|skip|skipping|change|adjust|reduce|cut|miss|missed|combine|mix)\b.*\b${MEDICINE}`),
  new RegExp(String.raw`\b${MEDICINE}\b.*\b(?:increase|decrease|double|stop|skip|missed|change|adjust|reduce|combine|mix)\b`),
  new RegExp(String.raw`\b(?:more|extra|another|less|stronger)\b(?:\s+\w+){0,2}\s+${MEDICINE}`),
  new RegExp(String.raw`\b(?:can|could|may|should|is it ok(?:ay)? to|is it safe to)\b(?:\s+\w+){0,3}\s+(?:give|take|have|use)\b(?:\s+\w+){0,3}\s+${MEDICINE}`),
  /\bis (?:it|this|that) (?:normal|safe|okay|ok|serious|bad|dangerous|infected|a problem|a concern)\b/,
  /\b(?:should|do|must) (?:i|we) (?:be )?(?:worr|concern)/,
  /\bworr(?:y|ied|ying) (?:about|that)\b/,
  /\bsymptoms?\b/,
  /\bside effects?\b/,
  /\bpain(?:s|ful)?\b|\bache[sd]?\b|\baching\b|\bhurts?\b|\bhurting\b|\bsore\b/,
  /\bswell(?:ing|ed|s)?\b|\bswollen\b/,
  /\bfever(?:ish)?\b|\b(?:has|have|running|got) a (?:high |low )?temperature\b|\bher temperature\b|\bhis temperature\b/,
  /\b(?:wound|incision|stitches|scar|cut|dressing)\b.*\b(?:look|looks|looking|red|redness|oozing|ooze|leak|leaking|smell|smells|open|opened|hot|warm|pus|bleed|bleeding)\b/,
  /\b(?:rash|dizzy|dizziness|nausea|nauseous|vomit|vomiting|throwing up|diarrh|constipat|confused|confusion|infection|infected)\b/,
  /\bdiagnos/,
  /\bwhat(?:'s| is) wrong with\b/,
];

/** lowercase, straight quotes, single spaces, so the patterns stay simple */
function prepare(question: string): string {
  return normalizeText(question).toLowerCase();
}

/** emergency is checked first, then medical judgment; everything else is an ordinary passport lookup */
export function classifyQuestion(question: string): QuestionKind {
  const text = prepare(question);
  if (EMERGENCY.some((pattern) => pattern.test(text))) return "emergency";
  if (MEDICAL.some((pattern) => pattern.test(text))) return "medical";
  return "profile";
}

/** the fixed notice for a question kind; null for an ordinary lookup */
export function redirectFor(kind: QuestionKind): string | null {
  if (kind === "emergency") return EMERGENCY_REDIRECT;
  if (kind === "medical") return MEDICAL_REDIRECT;
  return null;
}
