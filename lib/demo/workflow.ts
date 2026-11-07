// Browser-only fixtures. These never authorize or execute a real email send.
export type DemoState =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "sending"
  | "requested"
  | "accepted"
  | "completed"
  | "cancelled"
  | "failed"
  | "rejected"
  | "expired"
  | "needs_review";
export type Tier = "minimal" | "general" | "detailed";
export type DemoRequest = {
  id: string;
  commitment: string;
  recipient: string;
  email: string;
  group: string;
  subject: string;
  body: string;
  tier: Tier;
  deadline: string;
  state: DemoState;
  approvedSnapshot?: string;
  override?: boolean;
  history: string[];
};
export type DemoContact = {
  id: string;
  name: string;
  email: string;
  group: string;
  tier: Tier;
};
export type DemoFact = {
  id: string;
  text: string;
  category: string;
  source: string;
  status: "suggested" | "approved" | "conflicting" | "superseded" | "rejected";
  time?: string;
  conflict?: string;
};
export const BASE_TIME = Date.parse("2026-11-10T14:00:00Z");
export const healthTerms = (text: string) => [
  ...new Set(
    text.match(
      /\b(surgery|diagnos(?:is|ed)|cancer|medication|treatment|hip|knee|diabetes|insulin|hospital|procedure)\b/gi,
    ) ?? [],
  ),
];
const snapshot = (r: DemoRequest) =>
  JSON.stringify([r.email, r.subject, r.body, r.tier]);
export function editRequest(
  r: DemoRequest,
  changes: Partial<
    Pick<DemoRequest, "email" | "subject" | "body" | "tier" | "deadline">
  >,
): DemoRequest {
  if (
    !["draft", "awaiting_approval", "needs_review", "approved"].includes(
      r.state,
    )
  )
    return r;
  return {
    ...r,
    ...changes,
    state: "awaiting_approval",
    approvedSnapshot: undefined,
    override: false,
    history: [...r.history, "Draft edited; approval reset (demo)"],
  };
}
export function approveRequest(r: DemoRequest): DemoRequest {
  if (r.state !== "awaiting_approval") return r;
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) ||
    !r.subject.trim() ||
    !r.body.trim() ||
    !Number.isFinite(Date.parse(r.deadline))
  )
    return r;
  if (
    r.tier !== "detailed" &&
    healthTerms(`${r.subject} ${r.body}`).length &&
    !r.override
  )
    return r;
  return {
    ...r,
    state: "approved",
    approvedSnapshot: snapshot(r),
    history: [...r.history, "Exact message approved (demo)"],
  };
}
export function simulateSend(r: DemoRequest): DemoRequest {
  if (r.state !== "approved") return r;
  if (
    r.approvedSnapshot !== snapshot(r) ||
    (r.tier !== "detailed" &&
      healthTerms(`${r.subject} ${r.body}`).length &&
      !r.override)
  ) {
    return {
      ...r,
      state: "needs_review",
      history: [
        ...r.history,
        "Send blocked: approval no longer matches (demo)",
      ],
    };
  }
  return {
    ...r,
    state: "requested",
    history: [...r.history, "Simulated delivery only; no Gmail message ID"],
  };
}
export function expireRequests(requests: DemoRequest[], now: number) {
  return requests.map((r) =>
    r.state === "requested" && Date.parse(r.deadline) <= now
      ? {
          ...r,
          state: "expired" as const,
          history: [...r.history, "Response deadline passed in simulated time"],
        }
      : r,
  );
}
export function reviewGroup(state: DemoState) {
  if (["accepted", "completed"].includes(state)) return "Handled";
  if (state === "requested") return "Waiting";
  if (
    ["rejected", "failed", "expired", "needs_review", "sending"].includes(state)
  )
    return "Needs follow-up";
  return "Not sent";
}
export const contacts: DemoContact[] = [
  {
    id: "c1",
    name: "Jordan Lee",
    email: "jordan@example.com",
    group: "Work",
    tier: "minimal",
  },
  {
    id: "c2",
    name: "Dr. Morgan Chen",
    email: "morgan@example.com",
    group: "School",
    tier: "minimal",
  },
  {
    id: "c3",
    name: "Sara Ahmed",
    email: "sara@example.com",
    group: "Volunteer",
    tier: "general",
  },
];
export const commitments = [
  {
    id: "k1",
    title: "Weekly team check-in",
    date: "2026-11-10",
    day: "TUE 10",
    time: "10:00 AM",
    group: "Work",
    contactId: "c1",
    icon: "work",
    reason: "Overlaps your caregiving window",
    suggested: "request_reschedule",
  },
  {
    id: "k2",
    title: "Research paper deadline",
    date: "2026-11-11",
    day: "WED 11",
    time: "5:00 PM",
    group: "School",
    contactId: "c2",
    icon: "school",
    reason: "Due during your caregiving window",
    suggested: "request_extension",
  },
  {
    id: "k3",
    title: "Community kitchen shift",
    date: "2026-11-12",
    day: "THU 12",
    time: "4:30 PM",
    group: "Volunteer",
    contactId: "c3",
    icon: "volunteer",
    reason: "Your shift needs a named replacement",
    suggested: "ask_coverage",
  },
  {
    id: "k4",
    title: "Mom’s follow-up appointment",
    date: "2026-11-13",
    day: "FRI 13",
    time: "11:00 AM",
    group: "Care",
    contactId: "",
    icon: "care",
    reason: "Care appointment: suggested keep",
    suggested: "keep",
  },
];
export const actionLabels: Record<string, string> = {
  notify: "Notify",
  request_reschedule: "Request reschedule",
  request_extension: "Request extension",
  ask_coverage: "Ask for coverage",
  defer: "Defer",
  keep: "Keep",
};
export function createDrafts(
  actions: Record<string, string>,
  circle: DemoContact[],
  now: number,
  options?: {
    start: string;
    end: string;
    recipientIds: Record<string, string>;
  },
): DemoRequest[] {
  return commitments
    .filter(
      (k) => !options || (k.date >= options.start && k.date <= options.end),
    )
    .flatMap((k) => {
      const action = actions[k.id] ?? k.suggested;
      if (action === "keep" || action === "defer" || !k.contactId) return [];
      const c = circle.find(
        (c) => c.id === (options?.recipientIds[k.id] ?? k.contactId),
      );
      if (!c) return [];
      const request =
        action === "request_extension"
          ? "Could we discuss an extension?"
          : action === "ask_coverage"
            ? "Would you be able to cover this commitment?"
            : action === "notify"
              ? "I wanted to let you know I may be unavailable."
              : "Could we find another time that works?";
      return [
        {
          id: `r-${k.id}`,
          commitment: k.title,
          recipient: c.name,
          email: c.email,
          group: c.group,
          subject: `${actionLabels[action]}: ${k.title}`,
          body: `Hi ${c.name.split(" ")[0]},\n\nI’m managing a family caregiving situation from November 10 to 17 and need to make an adjustment to ${k.title.toLowerCase()}. ${request}\n\nThank you for understanding,\nAlex`,
          tier: c.tier,
          deadline: new Date(now + 48 * 3600000).toISOString(),
          state: "awaiting_approval" as const,
          history: ["Fixture draft created; not sent"],
        },
      ];
    });
}
export const initialFacts: DemoFact[] = [
  {
    id: "f1",
    text: "Breakfast is at 8:00 AM.",
    category: "routine",
    source: "Alex’s demo note · line 1",
    status: "conflicting",
    time: "08:00",
    conflict: "breakfast",
  },
  {
    id: "f2",
    text: "Breakfast is at 8:30 AM.",
    category: "routine",
    source: "Demo discharge note · page 1",
    status: "conflicting",
    time: "08:30",
    conflict: "breakfast",
  },
  {
    id: "f3",
    text: "She prefers tea with her breakfast.",
    category: "preference",
    source: "Alex’s demo note · line 2",
    status: "suggested",
  },
  {
    id: "f4",
    text: "Call Sara before leaving for an appointment.",
    category: "logistics",
    source: "Family demo note · line 1",
    status: "suggested",
    time: "10:30",
  },
];
export function approveFact(facts: DemoFact[], id: string): DemoFact[] {
  const chosen = facts.find((f) => f.id === id);
  if (!chosen || !["suggested", "conflicting"].includes(chosen.status))
    return facts;
  return facts.map((f) =>
    f.id === id
      ? { ...f, status: "approved" as const }
      : chosen.conflict && f.conflict === chosen.conflict
        ? { ...f, status: "superseded" as const }
        : f,
  );
}
