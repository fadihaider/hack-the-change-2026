// deterministic ranking of approved care facts for A5 (PRD 7.2): tokens, stopwords, a small synonym map and category
// cues, fused with optional vector ranks. pure: no database, no network, no server-only import. the caller has already
// scoped the facts to one owner's care recipient and to status approved, so nothing here can widen access.
import { normalizeText } from "./text.ts";

/** the least a fact needs to be ranked; extra fields ride along untouched */
export interface RankableFact {
  id: string;
  category: string;
  textExact: string;
}

export const RETRIEVAL_LIMITS = {
  /** at or below this many approved facts, every fact goes to the model (full context), ranked */
  fullContextMaxFacts: 60,
  /** above it, only the best this many */
  topK: 20,
  /** a ranked selection is padded with unsignalled facts up to this many, so a vague question still has context */
  minContext: 8,
  /** reciprocal rank fusion constant */
  rrfK: 60,
  /** vector hits below this cosine similarity are ignored */
  vectorMinSimilarity: 0.2,
  /** weight of the category cue list in the fusion, below lexical and vector */
  categoryWeight: 0.5,
} as const;

export type RetrievalLimits = { [K in keyof typeof RETRIEVAL_LIMITS]: number };

export type RetrievalMethod = "keyword" | "keyword+vector" | "none";

// question words that say nothing about which fact answers it
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for", "from", "with", "by", "about", "into",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "have", "has", "had",
  "what", "where", "when", "who", "whom", "whose", "which", "why", "how", "whats", "wheres", "whens", "hows",
  "she", "her", "hers", "herself", "he", "him", "his", "himself", "they", "them", "their", "theirs", "it", "its",
  "i", "me", "my", "we", "us", "our", "you", "your", "this", "that", "these", "those", "there", "here",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must", "s", "t", "d", "ll", "re", "ve", "m",
  "any", "some", "usually", "normally", "please", "tell", "know", "kind", "sort", "thing", "things", "get", "got",
  "if", "so", "then", "than", "just", "also", "very", "really", "keep", "kept",
]);

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12",
};

// each group is one idea; any member in the question matches any member in a fact, below an exact word match
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["glasses", "glass", "spectacles", "spectacle", "eyeglasses", "eyeglass", "specs", "readers"],
  ["breakfast", "eat", "eats", "eating", "ate", "meal", "meals", "food", "lunch", "dinner", "supper", "snack"],
  ["breakfast", "morning", "mornings", "wake", "wakes", "waking"],
  ["radio", "music", "song", "songs", "listen", "listens", "listening", "station"],
  ["hear", "hears", "hearing", "deaf", "ear", "ears", "loud", "louder", "aid", "aids"],
  ["sleep", "sleeps", "sleeping", "bed", "bedtime", "night", "nap", "naps", "rest", "tired"],
  ["key", "keys", "lock", "locked", "door"],
  ["appointment", "appointments", "doctor", "doctors", "clinic", "visit", "checkup", "followup"],
  ["medication", "medications", "medicine", "medicines", "meds", "pill", "pills", "tablet", "tablets", "prescription",
    "pharmacy"],
  ["walk", "walks", "walking", "cane", "walker", "stairs", "stair", "steps", "wheelchair", "move", "mobility"],
  ["phone", "call", "number", "contact", "contacts", "reach", "text"],
  ["write", "written", "writing", "note", "notes", "instructions", "instruction", "read", "explain"],
  ["shower", "bath", "bathe", "wash", "washing"],
  ["tv", "television", "show", "shows", "program", "news"],
  ["drink", "drinks", "tea", "coffee", "water", "juice"],
  ["daughter", "son", "family", "neighbour", "neighbor", "friend", "sister", "brother"],
  ["pickup", "pick", "ride", "drive", "driver", "bus", "transport"],
  ["like", "likes", "love", "loves", "enjoy", "enjoys", "favourite", "favorite", "prefer", "prefers", "preference"],
];

/** word -> group ids; built once */
const GROUP_OF = (() => {
  const map = new Map<string, number[]>();
  SYNONYM_GROUPS.forEach((group, index) => {
    for (const word of group) {
      const key = stem(word);
      for (const form of new Set([word, key])) {
        const ids = map.get(form) ?? [];
        if (!ids.includes(index)) ids.push(index);
        map.set(form, ids);
      }
    }
  });
  return map;
})();

// question words that hint at a category; a cue only reorders, it never makes a fact match on its own
const CATEGORY_CUES: Record<string, readonly string[]> = {
  routine: ["breakfast", "lunch", "dinner", "supper", "meal", "eat", "wake", "bed", "bedtime", "sleep", "nap", "morning",
    "evening", "night", "routine", "day", "daily", "time", "walk"],
  preference: ["like", "enjoy", "love", "favourite", "favorite", "prefer", "music", "radio", "tv", "hate", "dislike"],
  communication: ["hear", "hearing", "speak", "talk", "language", "write", "written", "understand", "explain", "read"],
  mobility: ["walk", "cane", "walker", "stair", "wheelchair", "transfer", "move", "fall"],
  contacts: ["who", "contact", "call", "phone", "number", "daughter", "son", "neighbour", "neighbor", "friend", "family"],
  logistics: ["appointment", "pharmacy", "pickup", "pick", "ride", "drive", "bus", "when", "where"],
  practical: ["where", "glasses", "key", "keys", "drawer", "find", "kept", "belongings", "remote", "wallet", "purse"],
  medical_instruction: ["medication", "medicine", "pill", "tablet", "dose", "mg", "incision", "wound", "dressing",
    "instruction"],
};

/** light suffix stripping, applied the same way to questions and facts */
export function stem(word: string): string {
  if (/^\d/.test(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

/** lowercase words of the text, possessives dropped, number words as digits; times keep "8:30" and add the hour */
export function words(text: string): string[] {
  const lower = normalizeText(text).toLowerCase();
  const out: string[] = [];
  for (const match of lower.matchAll(/[\p{L}\p{N}]+(?:[:'][\p{L}\p{N}]+)*/gu)) {
    let word = match[0].replace(/'s$/, "").replace(/'/g, "");
    word = NUMBER_WORDS[word] ?? word;
    const time = /^(\d{1,2}):([0-5]\d)$/.exec(word);
    if (time) {
      out.push(word, time[1]);
      continue;
    }
    out.push(word);
  }
  return out;
}

/** content words after stopwords and the ignore set (the recipient's own name and alias) */
export function tokenize(text: string, ignore: ReadonlySet<string> = new Set()): string[] {
  return words(text).filter((word) => !STOPWORDS.has(word) && !ignore.has(word));
}

/** "w:<stem>" for every word plus "g:<n>" for every synonym group it belongs to */
function terms(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) {
    const key = stem(token);
    out.add(`w:${key}`);
    for (const id of [...(GROUP_OF.get(token) ?? []), ...(GROUP_OF.get(key) ?? [])]) out.add(`g:${id}`);
  }
  return out;
}

/** the recipient's alias and display name as ignorable words ("mom", "rosa") */
export function ignoreSet(names: readonly string[]): Set<string> {
  return new Set(names.flatMap((name) => words(name)));
}

export interface RankedFact<T extends RankableFact> {
  fact: T;
  /** keyword score (exact words and synonyms, BM25 weighted); 0 means no shared word */
  lexical: number;
  /** categories this question hints at contain the fact */
  cued: boolean;
}

const SYNONYM_WEIGHT = 0.6;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25-style keyword scores of every fact for the question, best first; ties keep the input order.
 * document frequencies come only from the facts passed in, which are one recipient's, so statistics never mix people.
 */
export function rankFacts<T extends RankableFact>(question: string, facts: readonly T[], names: readonly string[] = []): RankedFact<T>[] {
  const ignore = ignoreSet(names);
  const queryTokens = tokenize(question, ignore);
  const query = terms(queryTokens);
  const docs = facts.map((fact) => {
    const tokens = tokenize(fact.textExact, ignore);
    return { fact, tokens, terms: terms(tokens) };
  });
  const count = docs.length;
  const averageLength = count === 0 ? 1 : Math.max(1, docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / count);
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const cues = new Set<string>();
  for (const token of queryTokens.concat(words(question))) {
    for (const [category, cueWords] of Object.entries(CATEGORY_CUES)) {
      if (cueWords.includes(token) || cueWords.includes(stem(token))) cues.add(category);
    }
  }
  const scored = docs.map((doc, index) => {
    let lexical = 0;
    const lengthNorm = 1 - BM25_B + (BM25_B * doc.tokens.length) / averageLength;
    for (const term of query) {
      if (!doc.terms.has(term)) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      const weight = term.startsWith("g:") ? SYNONYM_WEIGHT : 1;
      lexical += (weight * idf * (BM25_K1 + 1)) / (1 + BM25_K1 * lengthNorm);
    }
    return { fact: doc.fact, lexical, cued: cues.has(doc.fact.category), index };
  });
  scored.sort((a, b) => b.lexical - a.lexical || a.index - b.index);
  return scored.map(({ fact, lexical, cued }) => ({ fact, lexical, cued }));
}

export interface VectorHit {
  id: string;
  similarity: number;
}

export interface ContextSelection<T extends RankableFact> {
  /** the facts to send to the model, best first */
  facts: T[];
  method: RetrievalMethod;
  /** "full" sends every approved fact; "top_k" a ranked subset */
  scope: "full" | "top_k" | "none";
  /** ids with a keyword match, best first, for the demo lookup and tests */
  keywordHits: string[];
}

/**
 * picks the A5 context: every approved fact when the passport is small, otherwise the top K by reciprocal rank fusion
 * of keyword ranks, vector ranks (ids not in `facts` are ignored) and category cues.
 */
export function selectContext<T extends RankableFact>(input: {
  question: string;
  facts: readonly T[];
  names?: readonly string[];
  vectorHits?: readonly VectorHit[] | null;
  limits?: Partial<RetrievalLimits>;
}): ContextSelection<T> {
  const limits: RetrievalLimits = { ...RETRIEVAL_LIMITS, ...input.limits };
  const usedVector = input.vectorHits !== undefined && input.vectorHits !== null;
  if (input.facts.length === 0) return { facts: [], method: "none", scope: "none", keywordHits: [] };

  const ranked = rankFacts(input.question, input.facts, input.names ?? []);
  const known = new Set(input.facts.map((fact) => fact.id));
  const score = new Map<string, number>();
  const add = (id: string, value: number) => score.set(id, (score.get(id) ?? 0) + value);

  const lexicalHits = ranked.filter((entry) => entry.lexical > 0);
  lexicalHits.forEach((entry, rank) => add(entry.fact.id, 1 / (limits.rrfK + rank + 1)));
  const vectorHits = (input.vectorHits ?? [])
    .filter((hit) => known.has(hit.id) && Number.isFinite(hit.similarity) && hit.similarity >= limits.vectorMinSimilarity)
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
  vectorHits.forEach((hit, rank) => add(hit.id, 1 / (limits.rrfK + rank + 1)));
  ranked
    .filter((entry) => entry.cued)
    .forEach((entry, rank) => add(entry.fact.id, limits.categoryWeight / (limits.rrfK + rank + 1)));

  const order = new Map(input.facts.map((fact, index) => [fact.id, index]));
  const fused = [...input.facts].sort(
    (a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  const method: RetrievalMethod = usedVector ? "keyword+vector" : "keyword";
  const keywordHits = lexicalHits.map((entry) => entry.fact.id);
  if (input.facts.length <= limits.fullContextMaxFacts) {
    return { facts: fused, method, scope: "full", keywordHits };
  }
  const signalled = fused.filter((fact) => (score.get(fact.id) ?? 0) > 0).slice(0, limits.topK);
  const padding = fused.filter((fact) => !score.has(fact.id)).slice(0, Math.max(0, limits.minContext - signalled.length));
  return { facts: [...signalled, ...padding], method, scope: "top_k", keywordHits };
}

/**
 * exact-fact lookup without a model (demo rules and the medical path): facts sharing a word or synonym with the
 * question, best first, keeping only those close to the best score
 */
export function keywordMatches<T extends RankableFact>(question: string, facts: readonly T[], max = 3, names: readonly string[] = []): T[] {
  const hits = rankFacts(question, facts, names).filter((entry) => entry.lexical > 0);
  if (hits.length === 0) return [];
  const best = hits[0].lexical;
  return hits
    .filter((entry) => entry.lexical >= best * 0.5)
    .slice(0, max)
    .map((entry) => entry.fact);
}
