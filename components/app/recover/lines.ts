// plain lines for the recover list: what happened to each message, said from Alex's side.
// every line is built from the recorded state and its evidence rows; nothing here claims more than they show.
import { formatAlberta, type RecoverView } from "@/lib/frontend/live-api.ts";
import type { RequestView } from "@/lib/frontend/request-api.ts";

export type Groups = RecoverView["groups"];
export type NewTime = Groups["new"][number];
export type Evidence = RequestView["evidence"][number];
/** the mail adapter from GET /api/session: "outbox" never emails anyone, "gmail" sends real email */
export type MailMode = string;

/** the states in the api's not-sent group that still need Alex; cancelled ones do not */
const UNSENT_OPEN = new Set<RequestView["state"]>(["draft", "awaiting_approval", "approved"]);

/** the PRD 13 groups, straight from the api's groups, plus the rows that need Alex for the heading */
export type Sorted = {
  followUp: RequestView[];
  notSent: RequestView[];
  newTimes: NewTime[];
  waiting: RequestView[];
  handled: RequestView[];
  /** needs follow-up plus the not-sent rows that still need a decision; drives the heading only */
  needsYou: RequestView[];
};

/** keeps the api's grouping (lib/state.ts recoverGroup); not-sent rows that need Alex come before cancelled ones */
export function sortGroups(groups: Groups): Sorted {
  const unsentOpen = groups.notSent.filter((r) => UNSENT_OPEN.has(r.state));
  const unsentClosed = groups.notSent.filter((r) => !UNSENT_OPEN.has(r.state));
  return {
    followUp: groups.needsFollowUp,
    notSent: [...unsentOpen, ...unsentClosed],
    newTimes: groups.new,
    waiting: groups.waiting,
    handled: groups.handled,
    needsYou: [...groups.needsFollowUp, ...unsentOpen],
  };
}

/** when a request last reached a state, from its evidence (newest first) */
function reachedAt(request: RequestView, state: RequestView["state"]): string | null {
  return request.evidence.find((row) => row.toState === state)?.at ?? null;
}

function lastChange(request: RequestView): string | null {
  return request.evidence[0]?.at ?? null;
}

function at(iso: string | null): string {
  return formatAlberta(iso);
}

// "p.m." already ends a sentence; never write "p.m.."
export function sentence(text: string): string {
  return /[.?]$/.test(text) ? text : `${text}.`;
}

/** the fixed reasons the server writes when it holds a message back at send time (lib/requests/workflow.ts) */
const HELD_REASON: Record<string, string> = {
  "approval hash mismatch": "the message changed after you approved it",
  "health term at send": "a health word was found just before it went",
};

/**
 * true when the server held the message back at send time. that needs_review has an error row from the system,
 * not a reply, so it must never read as "they replied".
 */
export function heldBack(request: RequestView): boolean {
  const latest = request.evidence[0];
  return request.state === "needs_review" && request.proposedAt === null && latest?.evidenceKind === "error";
}

/** a pill label that overrides the state's own label, or undefined to use it */
export function pillLabel(request: RequestView): string | undefined {
  return heldBack(request) ? "Held back" : undefined;
}

/** one line saying where the message stands, with its time */
export function statusLine(request: RequestView, mail: MailMode = "gmail"): string {
  const outbox = mail === "outbox";
  const changed = lastChange(request);
  switch (request.state) {
    case "draft":
      return "Still a draft. Nothing has been sent.";
    case "awaiting_approval":
      return "Nothing has been sent. It’s waiting for your OK.";
    case "approved": {
      const when = request.approval?.at ?? reachedAt(request, "approved");
      return when ? `You approved it ${at(when)}, but it hasn’t gone out yet.` : "Approved, but it hasn’t gone out yet.";
    }
    case "sending": {
      const check = outbox ? "the demo outbox" : "your Gmail Sent folder";
      const started = changed ? sentence(`Sending started ${at(changed)}`) : "Sending started.";
      return `${started} No result came back, so check ${check} before sending again.`;
    }
    case "requested": {
      const sent = reachedAt(request, "requested");
      const verb = outbox ? "Placed in the demo outbox" : "Sent by email";
      const first = sent ? sentence(`${verb} ${at(sent)}`) : `${verb}.`;
      const due = request.respondBy ? ` ${sentence(`Reply due by ${at(request.respondBy)}`)}` : "";
      return `${first}${due}`;
    }
    case "accepted":
      return changed ? sentence(`Said yes ${at(changed)}`) : "Said yes.";
    case "completed":
      return changed ? sentence(`Marked done ${at(changed)}`) : "Marked done.";
    case "rejected":
      return changed ? sentence(`Said no ${at(changed)}`) : "Said no.";
    case "expired":
      return request.respondBy ? sentence(`No reply by ${at(request.respondBy)}`) : "No reply in time.";
    case "failed":
      if (outbox) {
        return changed
          ? sentence(`It couldn’t be placed in the demo outbox ${at(changed)}`)
          : "It couldn’t be placed in the demo outbox.";
      }
      return changed
        ? `Tried to send it ${at(changed)}, but the mail service didn’t confirm it. Check your Sent folder before trying again.`
        : "The mail service didn’t confirm it. Check your Sent folder before trying again.";
    case "needs_review": {
      if (request.proposedAt) return sentence(`Asked for ${at(request.proposedAt)} instead`);
      if (heldBack(request)) {
        const reason = HELD_REASON[request.evidence[0]?.evidenceRef ?? ""] ?? "it needs another look";
        return changed ? `Held back before sending ${at(changed)}: ${reason}.` : `Held back before sending: ${reason}.`;
      }
      if (request.evidence[0]?.evidenceKind === "link_click") return "Answered through their reply link. Check what they asked.";
      return "Needs another look before anything else happens.";
    }
    case "cancelled":
      return changed ? sentence(`Cancelled ${at(changed)}`) : "Cancelled.";
    default:
      return "";
  }
}

/** the fixed error codes the server records, in plain words; anything else stays generic */
function errorLine(ref: string | null, outbox: boolean): string {
  if (ref === "approval hash mismatch") return "Held back: the message changed after you approved it.";
  if (ref === "health term at send") return "Held back: a health word was found just before it went.";
  if (ref === "gmail_send_failed") {
    return outbox ? "It couldn’t be placed in the demo outbox." : "The mail service didn’t confirm it went out.";
  }
  return "Something stopped it.";
}

/**
 * one evidence row in plain words. raw refs (token hashes, message ids, approval hashes) are never shown;
 * only the fixed codes above are mapped to text.
 */
export function evidenceLine(event: Evidence, request: RequestView, mail: MailMode = "gmail"): string {
  const outbox = mail === "outbox";
  const name = request.recipient.name;
  switch (event.evidenceKind) {
    case "approval":
      if (event.toState === "approved") return "You approved this exact message.";
      if (event.toState === "sending") {
        return outbox ? "Placing it in the demo outbox started from your approval." : "Sending started from your approval.";
      }
      return "Recorded from your approval.";
    case "gmail_message_id":
      return outbox ? "Placed in the demo outbox." : "Sent by email. Gmail accepted it.";
    case "link_click":
      if (event.toState === "accepted") return `${name} chose Accept on their reply link.`;
      if (event.toState === "rejected") return `${name} chose Decline on their reply link.`;
      if (event.toState === "needs_review") return `${name} asked for another time on their reply link.`;
      return `${name} used their reply link.`;
    case "scheduler":
      return "The reply deadline passed with no answer.";
    case "user_manual":
      if (event.toState === "awaiting_approval") {
        return event.fromState === "draft" ? "You chose this message to review." : "You changed it, so it needs your OK again.";
      }
      if (event.toState === "cancelled") return "You chose not to send it.";
      if (event.toState === "completed") return "You marked it done.";
      return "You changed it.";
    case "error":
      return errorLine(event.evidenceRef, outbox);
    default:
      return "Recorded by ReliefReady.";
  }
}

/** "Jordan Lee", "Jordan Lee and Morgan Chen", or "3 people" */
export function namesOf(requests: RequestView[]): string {
  const names = [...new Set(requests.map((r) => r.recipient.name))];
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} people`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 need follow-up, 1 isn’t sent, 1 is waiting for a reply and 1 is handled." */
export function summaryLine(sorted: Sorted): string {
  const parts: string[] = [];
  if (sorted.followUp.length) parts.push(`${sorted.followUp.length} ${sorted.followUp.length === 1 ? "needs" : "need"} follow-up`);
  if (sorted.notSent.length) parts.push(`${sorted.notSent.length} ${sorted.notSent.length === 1 ? "isn’t" : "aren’t"} sent`);
  if (sorted.newTimes.length) parts.push(count(sorted.newTimes.length, "new time came in", "new times came in"));
  if (sorted.waiting.length) parts.push(`${sorted.waiting.length} ${sorted.waiting.length === 1 ? "is" : "are"} waiting for a reply`);
  if (sorted.handled.length) parts.push(`${sorted.handled.length} ${sorted.handled.length === 1 ? "is" : "are"} handled`);
  if (parts.length === 0) return "";
  const last = parts.pop();
  const text = parts.length ? `${parts.join(", ")} and ${last}` : (last ?? "");
  return sentence(text.charAt(0).toUpperCase() + text.slice(1));
}

/** a stable picture of the list, to tell whether a check changed anything */
export function signature(groups: Groups): string {
  const all = [...groups.handled, ...groups.waiting, ...groups.needsFollowUp, ...groups.notSent];
  return [...all.map((r) => `${r.id}:${r.state}`).sort(), ...groups.new.map((c) => `new:${c.id}`).sort()].join("|");
}

export function possessive(name: string): string {
  return name.endsWith("s") ? `${name}’` : `${name}’s`;
}

/** the urgent link for a request; urgent opens any state (app/(app)/urgent/page.tsx) */
export function urgentHref(requestId: string): string {
  return `/urgent?request=${encodeURIComponent(requestId)}`;
}
