// Urgent's "Send a text": recipients, the Gemini draft, approval and send over the runtime sms adapter (lib/sms)
import "server-only";
import { z } from "zod";
import { p } from "../../../lib/db.ts";
import { findHealthTerms } from "../../../lib/healthTerms.ts";
import { runSmsDrafter, checkSmsText, SMS_LIMITS } from "../../../lib/ai/smsDrafter.ts";
import { paidProvidersAllowed, type SessionUser } from "../../../lib/mvp/auth.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { hit, LIMITS } from "../../../lib/rateLimit.ts";
import { maskPhone, normalizePhone, smsParts } from "../../../lib/sms/phone.ts";
import type { SmsView } from "../../../lib/sms/workflow.ts";
import { extraHealthTerms, MEDICAL_FACTS } from "./commitments.ts";
import { loadEpisode, loadRecipient, recipientAliases, relationshipFor, reserveModel } from "./context.ts";
import { ApiError, RateLimitedError, requireUuid } from "./http.ts";

const tier = z.enum(["minimal", "general", "detailed"]);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const shortText = (max: number) => z.string().max(max).transform((value) => value.trim());

export const smsDraftSchema = z.strictObject({
  episodeId: uuid.nullable().optional(),
  recipientName: shortText(SMS_LIMITS.nameChars).nullable().optional(),
  senderName: shortText(SMS_LIMITS.nameChars).nullable().optional(),
  note: shortText(SMS_LIMITS.noteChars).nullable().optional(),
  tier,
});

const recipient = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("demo") }),
  z.strictObject({ kind: z.literal("care_contact"), id: uuid }),
  z.strictObject({ kind: z.literal("phone"), phone: z.string().min(1).max(32), label: shortText(SMS_LIMITS.nameChars).optional() }),
]);

export const smsApproveSchema = z.strictObject({
  /** one compose session; a repeated click with the same key returns the same approved text */
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  episodeId: uuid.nullable().optional(),
  to: recipient,
  senderName: shortText(SMS_LIMITS.nameChars).nullable().optional(),
  body: z.string().min(1).max(SMS_LIMITS.maxChars),
  tier,
  healthOverride: z.boolean().optional(),
  /** the owner ticked "I approve this exact text to this number"; nothing is saved without it */
  approved: z.literal(true),
});

export const smsSendSchema = z.strictObject({ requestId: uuid });

export interface SmsRecipientOption {
  kind: "demo" | "care_contact";
  id: string | null;
  label: string;
  detail: string | null;
  phoneMasked: string;
}

const CARE_CONTACTS = `SELECT c.id::text AS id, c.name, c.relationship, c.phone FROM care_contact c
  JOIN care_recipient r ON r.id = c.care_recipient_id
  WHERE r.owner_id = CAST(:user_id AS uuid) AND c.removed_at IS NULL ORDER BY c.created_at, c.id`;

const CARE_CONTACT = `SELECT c.name, c.phone FROM care_contact c JOIN care_recipient r ON r.id = c.care_recipient_id
  WHERE c.id = CAST(:id AS uuid) AND r.owner_id = CAST(:user_id AS uuid) AND c.removed_at IS NULL`;

const SMS_EPISODE = `SELECT episode_id::text AS episode_id FROM request
  WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user_id AS uuid) AND channel = 'sms'`;

/** DEMO_SMS_TO: the live test number, kept out of the repository; never sent to the browser in full */
function demoNumber(): string | null {
  return normalizePhone(process.env.DEMO_SMS_TO ?? "");
}

/** "Alex" from alex@example.test or alex.alvarez@...; the owner can type any other name */
function defaultSender(email: string): string | null {
  const word = email.split("@")[0]?.split(/[._+-]/)[0] ?? "";
  return /^[a-z]{2,30}$/i.test(word) ? word[0].toUpperCase() + word.slice(1).toLowerCase() : null;
}

export async function smsRecipients(rt: Runtime, user: SessionUser) {
  const demo = demoNumber();
  const contacts = await rt.stores.database.query<{ id: string; name: string; relationship: string | null; phone: string }>(
    CARE_CONTACTS, [p.uuid("user_id", user.id)]);
  const options: SmsRecipientOption[] = [];
  if (demo) options.push({ kind: "demo", id: null, label: "Test phone", detail: "DEMO_SMS_TO", phoneMasked: maskPhone(demo) });
  for (const contact of contacts) {
    const phone = normalizePhone(contact.phone);
    if (phone) options.push({ kind: "care_contact", id: contact.id, label: contact.name, detail: contact.relationship, phoneMasked: maskPhone(phone) });
  }
  return { provider: rt.mode.sms, options, senderName: defaultSender(user.email) };
}

/** the intake reason and approved medical facts count as health words for this owner's texts */
async function healthTermsFor(rt: Runtime, user: SessionUser, episodeId: string | null): Promise<string[]> {
  const database = rt.stores.database;
  const recipient = await loadRecipient(database, user.id).catch(() => null);
  if (!recipient) return [];
  const reason = episodeId ? (await loadEpisode(database, user.id, episodeId)).reasonText : null;
  const medical = await database.query<{ text_exact: string }>(MEDICAL_FACTS, [p.uuid("recipient_id", recipient.id)]);
  return extraHealthTerms(reason, medical.map((fact) => fact.text_exact), recipientAliases(recipient));
}

export async function draftSms(rt: Runtime, user: SessionUser, input: z.infer<typeof smsDraftSchema>) {
  const database = rt.stores.database;
  const episodeId = input.episodeId ?? null;
  const episode = episodeId ? await loadEpisode(database, user.id, episodeId) : null;
  const recipient = await loadRecipient(database, user.id).catch(() => null);
  const extra = await healthTermsFor(rt, user, episodeId);
  const deps = await reserveModel(rt, user.id, "sms_drafter");
  const draft = await runSmsDrafter(
    {
      senderName: input.senderName || null,
      recipientName: input.recipientName || null,
      note: input.note || null,
      unavailableFrom: episode?.startsOn ?? null,
      unavailableUntil: episode?.endsOn ?? null,
      tier: input.tier,
      relationship: relationshipFor(recipient?.alias ?? null),
      reasonText: episode?.reasonText ?? null,
      extraHealthTerms: extra,
    },
    deps,
  );
  if (draft.editFlags.includes("empty")) throw new ApiError(422, "draft_empty");
  return { ...draft, parts: smsParts(draft.text), drafter: rt.mode.ai };
}

async function resolveRecipient(rt: Runtime, user: SessionUser, to: z.infer<typeof recipient>): Promise<{ phone: string; label: string }> {
  if (to.kind === "demo") {
    const phone = demoNumber();
    if (!phone) throw new ApiError(503, "demo_number_not_configured");
    return { phone, label: "Test phone" };
  }
  if (to.kind === "care_contact") {
    const [contact] = await rt.stores.database.query<{ name: string; phone: string }>(CARE_CONTACT, [
      p.uuid("id", requireUuid(to.id)), p.uuid("user_id", user.id),
    ]);
    const phone = contact ? normalizePhone(contact.phone) : null;
    if (!contact) throw new ApiError(404, "not_found");
    if (!phone) throw new ApiError(422, "invalid_phone");
    return { phone, label: contact.name };
  }
  const phone = normalizePhone(to.phone);
  if (!phone) throw new ApiError(422, "invalid_phone");
  return { phone, label: to.label || "Text" };
}

export async function approveSms(rt: Runtime, user: SessionUser, input: z.infer<typeof smsApproveSchema>): Promise<SmsView> {
  const episodeId = input.episodeId ?? null;
  const { phone, label } = await resolveRecipient(rt, user, input.to);
  const extra = await healthTermsFor(rt, user, episodeId);
  const checked = checkSmsText(input.body, input.tier, extra);
  // the approved words are the words on screen; a text that is blank or HTML once cleaned is sent back for editing
  if (checked.editFlags.includes("empty") || checked.editFlags.includes("html")) throw new ApiError(422, "edit_needed");
  if (checked.text !== input.body.trim()) throw new ApiError(422, "edit_needed", { text: checked.text });
  return rt.smsStore.createApproved({
    userId: user.id,
    clientKey: input.clientKey,
    episodeId,
    phone,
    label,
    senderName: input.senderName || null,
    body: checked.text,
    tier: input.tier,
    healthOverride: input.healthOverride === true,
    extraHealthTerms: extra,
    findHealthTerms,
  });
}

export async function sendSms(rt: Runtime, user: SessionUser, requestId: string): Promise<SmsView> {
  // real texts cost money and reach real phones: same owner rule as the paid model providers
  if (rt.sms.mode === "twilio" && !paidProvidersAllowed(rt.auth.mode, rt.baseUrl)) {
    throw new ApiError(403, "verified_owner_required");
  }
  const database = rt.stores.database;
  const [row] = await database.query<{ episode_id: string | null }>(SMS_EPISODE, [p.uuid("id", requestId), p.uuid("user_id", user.id)]);
  if (!row) throw new ApiError(404, "not_found");
  const limit = await hit(database, LIMITS.smsPerUser, user.id);
  if (!limit.allowed) throw new RateLimitedError(limit);
  return rt.smsStore.send({
    userId: user.id,
    requestId,
    provider: rt.sms,
    extraHealthTerms: await healthTermsFor(rt, user, row.episode_id),
    findHealthTerms,
  });
}

const SMS_PHONE = `SELECT recipient_phone FROM request
  WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user_id AS uuid) AND channel = 'sms'`;

/**
 * the full number for a simulated text, so the owner's own phone can send it from Messages (sms: link on the web,
 * the Messages sheet on iOS). only after a demo send, only to the owner; real (twilio) sends never return it
 */
export async function smsHandoffPhone(rt: Runtime, user: SessionUser, text: SmsView): Promise<string | null> {
  if (text.delivery !== "simulated") return null;
  const [row] = await rt.stores.database.query<{ recipient_phone: string }>(
    SMS_PHONE,
    [p.uuid("id", text.id), p.uuid("user_id", user.id)],
  );
  return row?.recipient_phone ?? null;
}

/** the owner's texts for one care week (or all), after asking Twilio about any still on their way */
export async function listSms(rt: Runtime, user: SessionUser, episodeId: string | null) {
  await rt.smsStore.refresh(user.id, rt.sms).catch(() => 0);
  return { provider: rt.mode.sms, texts: await rt.smsStore.list(user.id, episodeId) };
}
