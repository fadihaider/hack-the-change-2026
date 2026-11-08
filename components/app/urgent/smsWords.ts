// plain words for a text's delivery, from the server's delivery field (lib/sms/workflow.ts deliveryOf)
import type { SmsDelivery, SmsView } from "@/lib/frontend/sms-api.ts";
import type { StateTone } from "../ui.tsx";

export const DELIVERY_LABEL: Record<SmsDelivery, string> = {
  not_sent: "Not sent yet",
  needs_review: "Held for review",
  sending: "Sending",
  unconfirmed: "Not confirmed",
  submitted: "Submitted",
  sent: "Sent to carrier",
  delivered: "Delivered",
  failed: "Failed",
  simulated: "Simulated · not delivered",
};

export const DELIVERY_TONE: Record<SmsDelivery, StateTone> = {
  not_sent: "plain",
  needs_review: "warn",
  sending: "ask",
  unconfirmed: "warn",
  submitted: "ask",
  sent: "ask",
  delivered: "good",
  failed: "bad",
  simulated: "warn",
};

/** one line under the text: what the status means, in the owner's terms */
export function deliveryNote(text: SmsView): string {
  switch (text.delivery) {
    case "submitted":
      return "Twilio accepted it and is passing it to the phone carrier.";
    case "sent":
      return "The phone carrier has it. Waiting for the carrier to confirm delivery.";
    case "delivered":
      return "The carrier confirmed it reached the phone.";
    case "failed":
      return failureNote(text.errorCode);
    case "unconfirmed":
      return "Twilio didn’t answer, so it may or may not have gone out. Check with them before sending another.";
    case "simulated":
      return "Demo text outbox only. Nothing was sent to a phone.";
    case "needs_review":
      return "It changed after you approved it, so it was held back. Nothing was sent.";
    case "sending":
      return "Handing it to Twilio now.";
    default:
      return "Approved, not sent yet.";
  }
}

// Twilio error codes the demo is most likely to meet; anything else shows its number
const KNOWN_ERRORS: Record<string, string> = {
  twilio_21211: "Twilio says the number isn’t a valid phone number.",
  twilio_21608: "A Twilio trial account can only text numbers verified in the Twilio console.",
  twilio_572002: "On a Twilio trial, texts must come from the trial number Twilio assigned to this verified recipient. Set TWILIO_PHONE_NUMBER to it.",
  twilio_21610: "This number replied STOP to the app’s number, so Twilio won’t text it.",
  twilio_21614: "Twilio says this number can’t receive texts.",
  twilio_20003: "Twilio rejected the app’s credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
  twilio_30003: "The phone was unreachable (off or out of coverage).",
  twilio_30006: "The number is a landline or can’t receive texts.",
  twilio_30007: "The carrier filtered the message.",
};

export function failureNote(code: string | null): string {
  if (!code) return "It didn’t go out.";
  return KNOWN_ERRORS[code] ?? `It didn’t go out (${code.replace(/^twilio_/, "Twilio error ")}).`;
}

/** the time that matters for each status */
export function deliveryTime(text: SmsView): { word: string; at: string } | null {
  if (text.delivery === "delivered" && text.statusAt) return { word: "Delivered", at: text.statusAt };
  if (text.delivery === "failed" && text.statusAt) return { word: "Updated", at: text.statusAt };
  if (text.submittedAt) return { word: text.delivery === "simulated" ? "Saved" : "Submitted", at: text.submittedAt };
  if (text.approvedAt) return { word: "Approved", at: text.approvedAt };
  return null;
}
