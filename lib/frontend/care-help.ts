// pure helpers for the ask bar and the emergency / help control (PRD 7.2, 9).
// no react, no network: the care components and tests share them.
import type { AskView, CareContactView } from "./live-api.ts";

/** the two public lines; static so they show with no data and no model call */
export const EMERGENCY_LINES = {
  emergency: { number: "911", href: "tel:911" },
  healthLink: { number: "811", href: "tel:811" },
} as const;

/**
 * a tel: link for a typed phone number, or null when it is not a plain number.
 * keeps digits and one leading +; spaces, dashes, dots and brackets are dropped.
 */
export function telHref(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 3 || digits.length > 15) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** emergency contacts first, then trusted helpers, each in the order they were added */
export function orderContacts(contacts: readonly CareContactView[]): CareContactView[] {
  const rank = (kind: CareContactView["kind"]) => (kind === "emergency" ? 0 : 1);
  return contacts
    .map((contact, index) => ({ contact, index }))
    .sort((a, b) => {
      const byKind = rank(a.contact.kind) - rank(b.contact.kind);
      if (byKind !== 0) return byKind;
      const byTime = a.contact.createdAt.localeCompare(b.contact.createdAt);
      return byTime !== 0 ? byTime : a.index - b.index;
    })
    .map((item) => item.contact);
}

export const CONTACT_LIMITS = { name: 80, relationship: 60, phone: 30 } as const;

export type ContactDraft = {
  name: string;
  relationship: string;
  phone: string;
  kind: "emergency" | "trusted";
};

export type ContactDraftResult =
  | { ok: true; value: { name: string; relationship: string | null; phone: string; kind: "emergency" | "trusted" } }
  | { ok: false; field: "name" | "relationship" | "phone"; message: string };

/** checks a typed contact before it is sent; the server checks again */
export function checkContactDraft(draft: ContactDraft): ContactDraftResult {
  const name = draft.name.trim().replace(/\s+/g, " ");
  const relationship = draft.relationship.trim().replace(/\s+/g, " ");
  const phone = draft.phone.trim();
  if (!name) return { ok: false, field: "name", message: "Add their name." };
  if (name.length > CONTACT_LIMITS.name) {
    return { ok: false, field: "name", message: `Shorten the name to ${CONTACT_LIMITS.name} characters or fewer.` };
  }
  if (relationship.length > CONTACT_LIMITS.relationship) {
    return {
      ok: false,
      field: "relationship",
      message: `Shorten the relationship to ${CONTACT_LIMITS.relationship} characters or fewer.`,
    };
  }
  if (!phone) return { ok: false, field: "phone", message: "Add a phone number." };
  if (phone.length > CONTACT_LIMITS.phone || telHref(phone) === null) {
    return { ok: false, field: "phone", message: "Use digits only, for example 403-555-0142." };
  }
  return { ok: true, value: { name, relationship: relationship || null, phone, kind: draft.kind } };
}

const PROVIDER_NAME: Record<Exclude<AskView["answeredBy"], "demo_rules" | "none">, string> = {
  anthropic: "Claude",
  bedrock: "Claude on Bedrock",
  gemini: "Gemini",
};

/** who answered, said honestly; demo keyword rules are never called ai. null when no model ran */
export function answeredByLabel(answeredBy: AskView["answeredBy"]): string | null {
  if (answeredBy === "none") return null;
  if (answeredBy === "demo_rules") return "Answered by demo rules (offline), exact facts only";
  return `Answered by ${PROVIDER_NAME[answeredBy]} from approved facts only`;
}

/** "Looked through 6 approved facts", or null when nothing was searched */
export function retrievalLine(retrieval: AskView["retrieval"]): string | null {
  if (retrieval.method === "none") return null;
  if (retrieval.considered === 0) return "No approved facts to look through yet";
  const count = `${retrieval.considered} approved ${retrieval.considered === 1 ? "fact" : "facts"}`;
  return retrieval.method === "keyword+vector"
    ? `Looked through ${count}, matched by words and meaning`
    : `Looked through ${count}, matched by words`;
}

/** "a voice note", "a PDF document", "a typed note"; null when the kind is not known */
export function sourcePhrase(kind: string | null): string | null {
  if (kind === "voice") return "a voice note";
  if (kind === "document") return "a PDF document";
  if (kind === "note") return "a typed note";
  return null;
}

const NOT_IN_PROFILE = "Not in profile";

/** the redirect sentence for a medical question: the server's wording, else a plain pointer to 811 and 911 */
export function redirectText(result: Pick<AskView, "healthNotice" | "answer">): string {
  const notice = result.healthNotice?.trim();
  if (notice) return notice;
  const answer = result.answer?.trim();
  if (answer && answer !== NOT_IN_PROFILE) return answer;
  return "ReliefReady can’t answer health questions. For health advice, call Health Link at 811. In an emergency, call 911.";
}

/** the open questions, each listed once however many times it was asked */
export function uniqueQuestions<T extends { question: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.question.trim().toLowerCase().replace(/[\s?.!]+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
