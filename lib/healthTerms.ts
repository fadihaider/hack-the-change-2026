// health-term check for outgoing drafts (PRD U5, IMPLEMENTATION section 6, A3 guards)
// it flags; it does not guarantee. The user still reviews every draft.

/**
 * Conditions, procedures, body parts, medications and care settings. Words the "general" tier allows
 * ("medical procedure", "recovering") are deliberately absent, and so are everyday words like "back" or "heart".
 */
export const BASE_HEALTH_TERMS: readonly string[] = [
  // procedures and care settings
  "surgery", "surgical", "operation", "post-op", "postop", "pre-op", "hospital", "hospitalized", "hospitalised",
  "icu", "intensive care", "emergency room", "er visit", "ambulance", "admitted", "discharge", "discharged",
  "biopsy", "transplant", "replacement", "amputation", "chemo", "chemotherapy", "radiation therapy", "dialysis",
  "physiotherapy", "rehab", "rehabilitation", "palliative", "hospice", "anesthesia", "anaesthesia", "incision",
  // conditions
  "diagnosis", "diagnosed", "cancer", "tumor", "tumour", "stroke", "heart attack", "cardiac", "diabetes",
  "dementia", "alzheimer's", "alzheimers", "parkinson's", "parkinsons", "fracture", "fractured", "seizure",
  "epilepsy", "pneumonia", "covid", "infection", "sepsis", "copd", "asthma", "arthritis", "osteoporosis",
  "depression", "anxiety", "psychiatric", "schizophrenia", "bipolar", "overdose", "suicidal", "addiction",
  "pregnant", "pregnancy", "miscarriage", "disability", "blindness", "deafness", "paralysis", "concussion",
  // body parts
  "hip", "knee", "shoulder", "spine", "spinal", "lung", "kidney", "liver", "brain", "bowel", "colon",
  "prostate", "breast", "pelvis", "pelvic", "bladder", "uterus", "cervix", "thyroid", "pancreas",
  // medications and treatment
  "medication", "prescription", "insulin", "morphine", "opioid", "opioids", "antibiotic", "chemotherapy",
  "painkiller", "steroid", "steroids", "blood thinner", "oxygen tank", "catheter", "wound", "stitches",
];

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "post-op" also matches "post op" and "postop"; every term also matches a simple plural */
function pattern(term: string): RegExp {
  const lower = term.toLowerCase();
  // surgery also matches surgeries; everything else takes an optional s or es
  const consonantY = /[^aeiou]y$/.test(lower);
  const stem = consonantY ? lower.slice(0, -1) : lower;
  const suffix = consonantY ? "(?:y|ies)" : "(?:s|es)?";
  const body = escape(stem)
    .replace(/-|\s+/g, "[\\s-]?")
    .replace(/'/g, "['\\u2019]?");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${suffix}(?![\\p{L}\\p{N}])`, "iu");
}

const BASE_PATTERNS = BASE_HEALTH_TERMS.map((term) => ({ term, regex: pattern(term) }));

/**
 * Health terms found in a draft's subject and body. extraTerms are distinctive words from this recipient's approved
 * medical_instruction facts and the A1 crisis statement (for example "hip", "replacement"). Returns each term once.
 */
export function findHealthTerms(subject: string, body: string, extraTerms: readonly string[] = []): string[] {
  return matchTerms(subject, body, [...BASE_PATTERNS, ...extraPatterns(extraTerms)]);
}

/**
 * only the per-request extra terms (no base list), for a checker that already covers the base list, so the server
 * check at edit, approve and send can add the words the drafter guarded against
 */
export function findExtraHealthTerms(subject: string, body: string, extraTerms: readonly string[]): string[] {
  return matchTerms(subject, body, extraPatterns(extraTerms));
}

function extraPatterns(extraTerms: readonly string[]): { term: string; regex: RegExp }[] {
  return extraTerms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 3)
    .map((term) => ({ term, regex: pattern(term) }));
}

function matchTerms(subject: string, body: string, patterns: { term: string; regex: RegExp }[]): string[] {
  const text = `${subject}\n${body}`.normalize("NFKC");
  const found = new Set<string>();
  for (const { term, regex } of patterns) {
    if (regex.test(text)) {
      found.add(term);
    }
  }
  return [...found];
}
