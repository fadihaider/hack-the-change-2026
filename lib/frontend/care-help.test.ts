import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMERGENCY_LINES,
  answeredByLabel,
  checkContactDraft,
  orderContacts,
  redirectText,
  retrievalLine,
  sourcePhrase,
  telHref,
  uniqueQuestions,
} from "./care-help.ts";
import type { CareContactView } from "./live-api.ts";

test("911 and 811 are static tel links that need no data", () => {
  assert.equal(EMERGENCY_LINES.emergency.href, "tel:911");
  assert.equal(EMERGENCY_LINES.healthLink.href, "tel:811");
});

test("telHref keeps digits and a leading plus, and refuses anything else", () => {
  assert.equal(telHref("403-555-0142"), "tel:4035550142");
  assert.equal(telHref("(403) 555.0142"), "tel:4035550142");
  assert.equal(telHref(" +1 403 555 0142 "), "tel:+14035550142");
  assert.equal(telHref("911"), "tel:911");
  assert.equal(telHref("12"), null);
  assert.equal(telHref("abc"), null);
  assert.equal(telHref("403-555-0142 ext 4"), null);
  assert.equal(telHref("javascript:alert(1)"), null);
  assert.equal(telHref("1234567890123456"), null);
  assert.equal(telHref("40+3"), null);
});

test("emergency contacts come first, then trusted helpers, each in the order added", () => {
  const rows: CareContactView[] = [
    { id: "a", name: "Sam", relationship: null, phone: "403-555-0101", kind: "trusted", createdAt: "2026-11-08T10:00:00Z" },
    { id: "b", name: "Lucia", relationship: "Sister", phone: "403-555-0142", kind: "emergency", createdAt: "2026-11-08T11:00:00Z" },
    { id: "c", name: "Priya", relationship: "Neighbour", phone: "403-555-0199", kind: "trusted", createdAt: "2026-11-08T09:00:00Z" },
    { id: "d", name: "Jordan", relationship: null, phone: "403-555-0177", kind: "emergency", createdAt: "2026-11-08T08:00:00Z" },
  ];
  assert.deepEqual(
    orderContacts(rows).map((row) => row.id),
    ["d", "b", "c", "a"],
  );
  assert.equal(rows[0].id, "a", "the input list is not reordered in place");
});

test("contact drafts are trimmed and checked before they are sent", () => {
  assert.deepEqual(checkContactDraft({ name: "  Aunt  Lucia ", relationship: " ", phone: "403-555-0142", kind: "emergency" }), {
    ok: true,
    value: { name: "Aunt Lucia", relationship: null, phone: "403-555-0142", kind: "emergency" },
  });
  const noName = checkContactDraft({ name: " ", relationship: "", phone: "403-555-0142", kind: "trusted" });
  assert.equal(noName.ok, false);
  assert.equal(!noName.ok && noName.field, "name");
  const badPhone = checkContactDraft({ name: "Sam", relationship: "", phone: "call me", kind: "trusted" });
  assert.equal(!badPhone.ok && badPhone.field, "phone");
  const noPhone = checkContactDraft({ name: "Sam", relationship: "", phone: "", kind: "trusted" });
  assert.equal(!noPhone.ok && noPhone.field, "phone");
  const longRelationship = checkContactDraft({ name: "Sam", relationship: "x".repeat(61), phone: "4035550101", kind: "trusted" });
  assert.equal(!longRelationship.ok && longRelationship.field, "relationship");
});

test("the provider label never calls demo rules ai, and says nothing when no model ran", () => {
  assert.equal(answeredByLabel("demo_rules"), "Answered by demo rules (offline), exact facts only");
  assert.equal(answeredByLabel("anthropic"), "Answered by Claude from approved facts only");
  assert.equal(answeredByLabel("bedrock"), "Answered by Claude on Bedrock from approved facts only");
  assert.equal(answeredByLabel("gemini"), "Answered by Gemini from approved facts only");
  assert.equal(answeredByLabel("none"), null);
  assert.doesNotMatch(answeredByLabel("demo_rules") ?? "", /\b(ai|claude|gemini)\b/i);
});

test("the retrieval line counts approved facts and is silent when nothing was searched", () => {
  assert.equal(retrievalLine({ method: "keyword", considered: 6 }), "Looked through 6 approved facts, matched by words");
  assert.equal(retrievalLine({ method: "keyword", considered: 1 }), "Looked through 1 approved fact, matched by words");
  assert.equal(
    retrievalLine({ method: "keyword+vector", considered: 3 }),
    "Looked through 3 approved facts, matched by words and meaning",
  );
  assert.equal(retrievalLine({ method: "keyword", considered: 0 }), "No approved facts to look through yet");
  assert.equal(retrievalLine({ method: "none", considered: 0 }), null);
});

test("source phrases cover the stored kinds and leave unknown kinds out", () => {
  assert.equal(sourcePhrase("voice"), "a voice note");
  assert.equal(sourcePhrase("document"), "a PDF document");
  assert.equal(sourcePhrase("note"), "a typed note");
  assert.equal(sourcePhrase(null), null);
  assert.equal(sourcePhrase("email"), null);
});

test("a medical redirect uses the server wording, never the not-in-profile marker", () => {
  assert.equal(redirectText({ healthNotice: "Call Health Link at 811.", answer: null }), "Call Health Link at 811.");
  assert.equal(redirectText({ healthNotice: null, answer: "Ask a nurse at 811." }), "Ask a nurse at 811.");
  const fallback = redirectText({ healthNotice: null, answer: "Not in profile" });
  assert.match(fallback, /811/);
  assert.match(fallback, /911/);
});

test("open questions are listed once however many times they were asked", () => {
  const rows = [
    { id: "1", question: "What time is lunch?" },
    { id: "2", question: "what time is lunch" },
    { id: "3", question: "Where is the walker?" },
  ];
  assert.deepEqual(
    uniqueQuestions(rows).map((row) => row.id),
    ["1", "3"],
  );
});
