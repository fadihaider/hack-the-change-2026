// plain lines for the recover list: what happened to each message, said from Alex's side
import { formatAlberta, type RecoverView } from "@/lib/frontend/live-api.ts";
import type { RequestView } from "@/lib/frontend/request-api.ts";

export type Groups = RecoverView["groups"];
export type NewTime = Groups["new"][number];

/** the states in the api's not-sent group that still need Alex; cancelled ones do not */
const UNSENT_OPEN = new Set<RequestView["state"]>(["draft", "awaiting_approval", "approved"]);

export type Sorted = {
  needsYou: RequestView[];
  waiting: RequestView[];
  handled: RequestView[];
  closed: RequestView[];
  newTimes: NewTime[];
};

/** B's grouping on the api's groups: everything that needs Alex first, in the api's deadline order */
export function sortGroups(groups: Groups): Sorted {
  const unsentOpen = groups.notSent.filter((r) => UNSENT_OPEN.has(r.state));
  return {
    needsYou: [...groups.needsFollowUp, ...unsentOpen],
    waiting: groups.waiting,
    handled: groups.handled,
    closed: groups.notSent.filter((r) => !UNSENT_OPEN.has(r.state)),
    newTimes: groups.new,
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

/** one line saying where the message stands, with its time */
export function statusLine(request: RequestView): string {
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
    case "sending":
      return changed ? sentence(`Started sending ${at(changed)}`) : "Sending now.";
    case "requested": {
      const sent = reachedAt(request, "requested");
      const first = sent ? sentence(`Sent ${at(sent)}`) : "Sent.";
      return request.respondBy ? `${first} ${sentence(`Reply due by ${at(request.respondBy)}`)}` : first;
    }
    case "accepted":
      return changed ? sentence(`Said yes ${at(changed)}`) : "Said yes.";
    case "completed":
      return changed ? sentence(`Done ${at(changed)}`) : "Done.";
    case "rejected":
      return changed ? sentence(`Said no ${at(changed)}`) : "Said no.";
    case "expired":
      return request.respondBy ? sentence(`No reply by ${at(request.respondBy)}`) : "No reply in time.";
    case "failed":
      return changed ? sentence(`Tried to send it ${at(changed)}, but it didn’t go out`) : "It didn’t go out.";
    case "needs_review":
      return request.proposedAt
        ? sentence(`Asked for ${at(request.proposedAt)} instead`)
        : changed
          ? sentence(`Replied ${at(changed)}. Check what they said`)
          : "Replied. Check what they said.";
    case "cancelled":
      return changed ? sentence(`Cancelled ${at(changed)}`) : "Cancelled.";
    default:
      return "";
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

/** "2 need you, 1 is waiting for a reply and 1 is handled." */
export function summaryLine(sorted: Sorted): string {
  const parts: string[] = [];
  if (sorted.needsYou.length) parts.push(`${sorted.needsYou.length} ${sorted.needsYou.length === 1 ? "needs" : "need"} you`);
  if (sorted.newTimes.length) parts.push(count(sorted.newTimes.length, "new time came in", "new times came in"));
  if (sorted.waiting.length) parts.push(`${sorted.waiting.length} ${sorted.waiting.length === 1 ? "is" : "are"} waiting for a reply`);
  if (sorted.handled.length) parts.push(`${sorted.handled.length} ${sorted.handled.length === 1 ? "is" : "are"} handled`);
  if (sorted.closed.length) parts.push(`${sorted.closed.length} ${sorted.closed.length === 1 ? "wasn’t" : "weren’t"} sent`);
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
