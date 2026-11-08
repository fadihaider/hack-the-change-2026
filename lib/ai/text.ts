// text helpers shared by every model step: normalization, untrusted wrapping, verbatim matching

const QUOTE_MAP: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  "\u2032": "'",
  "\u2033": '"',
};

// latin ligatures from PDF text layers; NFKC is not used because it rewrites fraction and superscript doses
const LIGATURE_MAP: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

const LIGATURE_PATTERN = /[\uFB00-\uFB06]/g;
// soft hyphen, zero-width space and joiners, word joiner, byte order mark
const INVISIBLE_PATTERN = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const DASH_PATTERN = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const QUOTE_PATTERN = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033]/g;

/**
 * Normalize source text and model quotes the same way so a verbatim check is fair.
 * Idempotent: normalizeText(normalizeText(x)) === normalizeText(x).
 * care_source.full_text is stored already normalized, so spans index into the stored text.
 */
export function normalizeText(input: string): string {
  // invisible characters go before NFC, so removing one can't leave an uncomposed pair for a second pass
  return input
    .replace(LIGATURE_PATTERN, (ch) => LIGATURE_MAP[ch] ?? ch)
    .replace(INVISIBLE_PATTERN, "")
    .normalize("NFC")
    .replace(QUOTE_PATTERN, (ch) => QUOTE_MAP[ch] ?? ch)
    .replace(DASH_PATTERN, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Span {
  start: number;
  end: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
// joins two parts of one token: 1.5, 1,000, 8:30, 1-2, 11/14, follow-up, don't
const JOINER_CHAR = /[.,:/'-]/;
const NEGATION_WORD = /^(?:no|not|never|nor|cannot|avoid|without|stop|\p{L}+n't)$/iu;
// a negation that heads a list ("Do NOT: drive, drink alcohol") covers the rest of its sentence
const NEGATED_HEADER = /(?<![\p{L}'])(?:no|not|never|avoid|\p{L}+n't)\s*:/iu;
const POSSESSIVE = /^'s(?![\p{L}\p{N}])/iu;

/** true when middle joins left and right into one token; "." and "," only inside a number, so "home.Take" is two */
function joins(left: string, middle: string, right: string): boolean {
  if (!JOINER_CHAR.test(middle)) {
    return false;
  }
  return /[.,]/.test(middle) ? DIGIT.test(left) && DIGIT.test(right) : WORD_CHAR.test(left) && WORD_CHAR.test(right);
}

/** true when a cut at index falls inside a word or number ("Dis|continue", "1|5 kg", "1.|5 tablets") */
function cutsToken(text: string, index: number): boolean {
  const before = text[index - 1] ?? "";
  const after = text[index] ?? "";
  return (
    (WORD_CHAR.test(before) && WORD_CHAR.test(after)) ||
    joins(text[index - 2] ?? "", before, after) ||
    joins(before, after, text[index + 1] ?? "")
  );
}

/**
 * true when a negation comes shortly before index in the same sentence, so a quote starting there drops it:
 * one of the last `words` words ("Do not | lift", "Do not ever | take"), counted with (asides) removed,
 * or a negated list header ("Do NOT: drive, | drink alcohol")
 */
function followsNegation(text: string, index: number, words: number): boolean {
  const sentence = (text.slice(Math.max(0, index - 80), index).split(/[.!?;](?:\s|$)/).pop() ?? "").replace(/\([^()]*\)/g, " ");
  const lastWords = (sentence.match(/[\p{L}']+/gu) ?? []).slice(-words);
  return lastWords.some((word) => NEGATION_WORD.test(word)) || NEGATED_HEADER.test(sentence);
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

export interface VerbatimOptions {
  /** compare without case; never changes string length, so the span always points at the source characters */
  ignoreCase?: boolean;
  /** how many words before the quote are checked for a negation (default 3) */
  negationWords?: number;
  /**
   * accept a match followed by 's ("mom" in "mom's"); off for care facts,
   * so "Call Aunt Lucia" can't come from "Call Aunt Lucia's daughter"
   */
  allowPossessive?: boolean;
}

/**
 * Find a model-quoted fact inside normalized source text.
 * Returns the span in the normalized source, or null when the quote is not verbatim.
 * A match must start and end on a word boundary and must not follow a negation in the same sentence, so
 * "continue warfarin" can't come from "Discontinue warfarin" and "take ibuprofen" can't come from "Do not ever take ibuprofen".
 */
export function findVerbatim(normalizedSource: string, quote: string, options: VerbatimOptions = {}): Span | null {
  const needle = normalizeText(quote);
  if (needle.length === 0) {
    return null;
  }
  const pattern = new RegExp(escapeRegExp(needle), options.ignoreCase ? "giu" : "gu");
  for (let match = pattern.exec(normalizedSource); match !== null; match = pattern.exec(normalizedSource)) {
    const start = match.index;
    const end = start + match[0].length;
    const possessive = options.allowPossessive === true && POSSESSIVE.test(normalizedSource.slice(end, end + 3));
    const onBoundaries = !cutsToken(normalizedSource, start) && (possessive || !cutsToken(normalizedSource, end));
    if (onBoundaries && !followsNegation(normalizedSource, start, options.negationWords ?? 3)) {
      return { start, end };
    }
    // overlapping occurrences count too; step a whole code point, since with the u flag a lastIndex inside a
    // surrogate pair snaps back to the pair's start and the same match repeats forever
    pattern.lastIndex = start + (normalizedSource.codePointAt(start)! > 0xffff ? 2 : 1);
  }
  return null;
}

// any opening or closing tag in any case, with spaces, attributes or format characters (soft hyphen, zero-width)
// anywhere in it; full-width and small brackets count as brackets
const LT = "[<\\uFE64\\uFF1C]";
const GT = "[>\\uFE65\\uFF1E]";
const GAP = "[\\s\\p{Cf}]*";
const TAG_NAME = [..."untrusted"].join("\\p{Cf}*");
const UNTRUSTED_TAG = new RegExp(`${LT}${GAP}[/\\uFF0F]?${GAP}${TAG_NAME}(?![\\p{L}\\p{N}])[^>\\uFE65\\uFF1E]*${GT}`, "giu");

/**
 * Wrap user, document or third-party text so prompts can tell data from instructions.
 * Removes untrusted tags until none are left, since one pass turns "</untr</untrusted>usted>" into a tag.
 */
export function wrapUntrusted(text: string, maxLength?: number): string {
  let cleaned = text;
  for (let previous = ""; previous !== cleaned; ) {
    previous = cleaned;
    cleaned = cleaned.replace(UNTRUSTED_TAG, "");
  }
  if (maxLength !== undefined && cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
  }
  return `<untrusted>\n${cleaned}\n</untrusted>`;
}
