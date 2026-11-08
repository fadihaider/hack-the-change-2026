// browser client for Urgent's "Send a text" (app/api/sms/*); every response is validated before display
import { z } from "zod";
import { createCaller } from "./request-api.ts";

const timestamp = z.string().datetime({ offset: true });
const tier = z.enum(["minimal", "general", "detailed"]);
const state = z.enum([
  "draft", "awaiting_approval", "approved", "sending", "requested", "accepted",
  "completed", "cancelled", "failed", "rejected", "expired", "needs_review",
]);
export const smsDelivery = z.enum([
  "not_sent", "needs_review", "sending", "unconfirmed", "submitted", "sent", "delivered", "failed", "simulated",
]);
export type SmsDelivery = z.infer<typeof smsDelivery>;

export const smsViewSchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().nullable(),
  state,
  delivery: smsDelivery,
  recipient: z.object({ label: z.string(), phoneMasked: z.string() }),
  senderName: z.string().nullable(),
  body: z.string(),
  disclosureTier: tier,
  healthTermsFound: z.array(z.string()),
  healthOverride: z.boolean(),
  provider: z.enum(["twilio", "demo"]).nullable(),
  providerMessageId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  errorCode: z.string().nullable(),
  submittedAt: timestamp.nullable(),
  statusAt: timestamp.nullable(),
  approvedAt: timestamp.nullable(),
  updatedAt: timestamp,
});
export type SmsView = z.infer<typeof smsViewSchema>;

const provider = z.enum(["twilio", "demo"]);
const listSchema = z.object({ provider, texts: z.array(smsViewSchema) });
const oneSchema = z.object({ text: smsViewSchema });
const recipientsSchema = z.object({
  provider,
  options: z.array(z.object({
    kind: z.enum(["demo", "care_contact"]),
    id: z.string().nullable(),
    label: z.string(),
    detail: z.string().nullable(),
    phoneMasked: z.string(),
  })),
  senderName: z.string().nullable(),
});
export type SmsRecipients = z.infer<typeof recipientsSchema>;
const draftSchema = z.object({
  text: z.string(),
  healthTermsFound: z.array(z.string()),
  approvalBlocked: z.boolean(),
  editFlags: z.array(z.string()),
  parts: z.object({ encoding: z.enum(["gsm", "unicode"]), parts: z.number(), chars: z.number() }),
  drafter: z.string(),
});
export type SmsDraft = z.infer<typeof draftSchema>;

export type SmsRecipientChoice = { kind: "demo" } | { kind: "care_contact"; id: string } | { kind: "phone"; phone: string; label?: string };
export type SmsTier = z.infer<typeof tier>;

/** texts that can still change at the provider, so the summary keeps checking */
export const SMS_MOVING = new Set<SmsDelivery>(["sending", "submitted", "sent"]);

export function createSmsApi(transport: typeof fetch = fetch) {
  const call = createCaller(transport);
  return {
    list: (episodeId: string | null) =>
      call(`/api/sms${episodeId ? `?episodeId=${encodeURIComponent(episodeId)}` : ""}`, listSchema),
    recipients: () => call("/api/sms/recipients", recipientsSchema),
    draft: (input: { episodeId: string | null; recipientName: string | null; senderName: string | null; note: string | null; tier: SmsTier }) =>
      call("/api/sms/draft", draftSchema, { body: input, timeoutMs: 45_000 }),
    approve: (input: {
      clientKey: string;
      episodeId: string | null;
      to: SmsRecipientChoice;
      senderName: string | null;
      body: string;
      tier: SmsTier;
      healthOverride: boolean;
    }) => call("/api/sms", oneSchema, { body: { ...input, approved: true } }),
    send: (requestId: string) => call("/api/sms/send", oneSchema, { body: { requestId }, timeoutMs: 30_000 }),
  };
}
export type SmsApi = ReturnType<typeof createSmsApi>;
