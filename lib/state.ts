import { createHash } from "node:crypto";

export const REQUEST_STATES = [
  "draft", "awaiting_approval", "approved", "sending", "requested", "accepted",
  "completed", "cancelled", "failed", "rejected", "expired", "needs_review",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export type DisclosureTier = "minimal" | "general" | "detailed";
export type ResponseChoice = "accept" | "decline" | "propose";
export type EvidenceKind =
  | "approval" | "gmail_message_id" | "link_click" | "user_manual" | "scheduler" | "error"
  // sms: the provider message id when the text is accepted, then each provider status change
  | "sms_message_sid" | "sms_status";

export interface ApprovedContent {
  recipientEmail: string;
  subject: string;
  body: string;
  disclosureTier: DisclosureTier;
}

// This exact encoding is the approval contract in IMPLEMENTATION section 4.
export function approvalHash(content: ApprovedContent): string {
  return createHash("sha256").update([
    content.recipientEmail, content.subject, content.body, content.disclosureTier,
  ].join("\n")).digest("hex");
}

export function appNow(realNow: Date, offsetMilliseconds: number): Date {
  if (!Number.isFinite(offsetMilliseconds) || !Number.isFinite(realNow.getTime())) {
    throw new Error("Invalid app clock");
  }
  return new Date(realNow.getTime() + offsetMilliseconds);
}

export function responseState(choice: ResponseChoice): RequestState {
  return { accept: "accepted", decline: "rejected", propose: "needs_review" }[choice] as RequestState;
}

export function recoverGroup(state: RequestState): "handled" | "waiting" | "needs_follow_up" | "not_sent" {
  if (state === "accepted" || state === "completed") return "handled";
  if (state === "requested") return "waiting";
  if (["rejected", "expired", "failed", "needs_review", "sending"].includes(state)) return "needs_follow_up";
  return "not_sent";
}
