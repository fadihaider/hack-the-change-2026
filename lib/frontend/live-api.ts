import { z } from "zod";
import {
  apiErrorMessage,
  createCaller,
  RequestApiError,
  requestViewSchema,
} from "./request-api.ts";

// browser client for the local mvp routes (docs/MVP.md, app/api/**). every read is validated before display,
// and every text field is rendered as plain text by the components, never as html.

const timestamp = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string();
const maybe = z.string().nullable();

// model calls can take a while with a real provider; plain reads stay short
const MODEL_TIMEOUT_MS = 90000;
const UPLOAD_TIMEOUT_MS = 120000;
const SESSION_TIMEOUT_MS = 6000;

export const sessionSchema = z.object({
  user: z.object({ id: text, email: text }),
  mode: z.object({
    db: text,
    ai: text,
    mail: text,
    calendar: text,
    auth: text,
  }),
  admin: z.boolean(),
  appNow: timestamp,
  today: isoDate,
  careRecipient: z
    .object({
      id: text,
      alias: text,
      displayName: maybe,
      address: maybe,
      community: maybe,
    })
    .nullable(),
  episode: z
    .object({ id: text, startsOn: isoDate, endsOn: isoDate, status: text })
    .nullable(),
  // which optional providers actually handle requests right now; never secrets (PRD 14, AC13)
  providers: z
    .object({
      /** "elevenlabs" only when /api/stt has a configured key and paid providers are allowed */
      speech: z.enum(["elevenlabs", "off"]),
      /** "vector" only when an embedding adapter is configured; otherwise keyword retrieval over approved facts */
      retrieval: z.enum(["keyword", "vector"]),
    })
    .default({ speech: "off", retrieval: "keyword" }),
});
export type LiveSession = z.infer<typeof sessionSchema>;
export type LiveMode = LiveSession["mode"];
export type LiveEpisode = { id: string; startsOn: string; endsOn: string };

const intakeFields = {
  recipientAlias: maybe,
  reasonText: maybe,
  helpRequested: z.array(text),
};
const intakeResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    startDate: isoDate,
    endDate: isoDate,
    clarifyingQuestions: z.array(text).optional(),
    ...intakeFields,
  }),
  z.object({
    status: z.literal("needs_clarification"),
    clarifyingQuestions: z.array(text),
    partial: z.object({
      startDate: isoDate.nullable(),
      endDate: isoDate.nullable(),
      ...intakeFields,
    }),
  }),
]);
const intakeSchema = z.object({
  result: intakeResultSchema,
  episodeId: maybe,
});
export type IntakeView = z.infer<typeof intakeResultSchema>;

export const DECISIONS = [
  "notify",
  "reschedule",
  "extension",
  "coverage",
  "defer",
  "keep",
] as const;
export type Decision = (typeof DECISIONS)[number];
const decision = z.enum(DECISIONS);

export const decisionLabels: Record<Decision, string> = {
  notify: "Notify",
  reschedule: "Request reschedule",
  extension: "Request extension",
  coverage: "Ask for coverage",
  defer: "Defer",
  keep: "Keep",
};

const commitmentSchema = z.object({
  id: text,
  sourceId: maybe,
  title: text,
  startsAt: timestamp.nullable(),
  endsAt: timestamp.nullable(),
  location: maybe,
  organizerEmail: maybe,
  attendees: z.array(z.object({ email: text, responseStatus: maybe })),
  conflictReason: maybe,
  ruleConflicts: z.array(text),
  decision: decision.nullable(),
  suggestedAction: decision.nullable(),
  forCareRecipient: z.boolean(),
  dependencies: z.array(
    z.object({
      id: text,
      toKind: maybe,
      toRef: maybe,
      evidence: text,
      origin: text,
      confirmed: z.boolean(),
      contactId: maybe,
    }),
  ),
  suggestedContactId: maybe,
  requests: z.array(z.object({ id: text, state: text, contactId: maybe })),
});
export type CommitmentView = z.infer<typeof commitmentSchema>;

const impactSchema = z.object({
  episode: z.object({ id: text, startsOn: isoDate, endsOn: isoDate }),
  commitments: z.array(commitmentSchema),
  modelStatus: z.enum(["ok", "unavailable"]),
});
export type ImpactView = z.infer<typeof impactSchema>;

const decideSchema = z.object({
  commitment: z.object({ id: text, decision }),
  request: requestViewSchema.nullable(),
  existing: z.boolean(),
  editFlags: z.array(text),
  approvalBlocked: z.boolean(),
});
export type DecideView = z.infer<typeof decideSchema>;

const guideCardSchema = z.object({
  id: text,
  kind: text,
  title: text,
  body: text,
  details: z.array(z.object({ label: text, value: text })),
  links: z.array(z.object({ label: text, url: text })),
  draftNotice: text.optional(),
  source: text,
  sourceUrl: text,
  license: maybe,
  fetchedAt: text,
});
export type GuideCardView = z.infer<typeof guideCardSchema>;
const guideSchema = z.object({
  ok: z.literal(true),
  location: z.object({
    address: maybe,
    point: z.object({ lat: z.number(), lng: z.number() }),
    community: text,
  }),
  tenure: text,
  cards: z.array(guideCardSchema),
  attribution: z.object({ text, url: text }),
});
export type GuideView = z.infer<typeof guideSchema>;
export type Tenure = "yes" | "no" | "not_sure";

const factStatus = z.enum([
  "suggested",
  "approved",
  "superseded",
  "conflicting",
  "rejected",
]);
const careEventSchema = z.object({
  id: text,
  title: text,
  startsAt: timestamp.nullable(),
  rrule: maybe,
  remindMinutes: z.number().nullable(),
  locationText: maybe,
  status: text,
});
const careFactSchema = z.object({
  id: text,
  category: text,
  textExact: text,
  status: factStatus,
  sourceId: maybe,
  sourceKind: maybe,
  spanStart: z.number().nullable(),
  spanEnd: z.number().nullable(),
  conflictsWith: z.array(text),
  events: z.array(careEventSchema),
  createdAt: text,
  /** 1 for an original fact; an edit creates a new approved version that supersedes the previous one */
  version: z.number().int().default(1),
  /** the previous version (status superseded) for an edited fact, or the conflict partner while conflicting */
  supersedes: maybe.default(null),
  /** who provided the source, e.g. "caregiver" */
  sourceAuthor: maybe.default(null),
  sourceCreatedAt: maybe.default(null),
  /** optional short label; the UI falls back to textExact */
  displayText: maybe.default(null),
});
export type CareFactView = z.infer<typeof careFactSchema>;
const careProfileSchema = z.object({
  careRecipient: z.object({ id: text, alias: text, displayName: maybe }),
  facts: z.array(careFactSchema),
  openQuestions: z.array(
    z.object({ id: text, question: text, askedBy: maybe }),
  ),
});
export type CareProfileView = z.infer<typeof careProfileSchema>;
const careSourceSchema = z.object({
  source: z.object({ id: text, kind: text }),
  facts: z.array(careFactSchema),
  conflicts: z.array(
    z.object({
      factId: text,
      existingFactId: text,
      modelNote: maybe.optional(),
    }),
  ),
  droppedCount: z.number(),
});
export type CareSourceView = z.infer<typeof careSourceSchema>;
const timelineItemSchema = z.object({
  eventId: text,
  factId: maybe,
  title: text,
  startsAt: timestamp,
  localTime: text,
  rrule: maybe,
  remindMinutes: z.number(),
  locationText: maybe,
  fullText: maybe,
  category: maybe,
  highlight: z.boolean(),
  /** set only when the caregiver tapped "Done" for this occurrence (user-recorded, not verified) */
  completedAt: maybe.default(null),
});
export type TimelineItemView = z.infer<typeof timelineItemSchema>;
const timelineSchema = z.object({
  date: isoDate,
  appNow: timestamp,
  reminders: z.array(timelineItemSchema),
  items: z.array(timelineItemSchema),
});
export type TimelineView = z.infer<typeof timelineSchema>;
const citedFactSchema = z.object({
  id: text,
  category: text,
  textExact: text,
  sourceId: maybe.default(null),
  sourceKind: maybe.default(null),
  sourceCreatedAt: maybe.default(null),
  version: z.number().int().default(1),
});
export type CitedFactView = z.infer<typeof citedFactSchema>;
const askSchema = z.object({
  notFound: z.boolean(),
  answer: maybe,
  citedFacts: z.array(citedFactSchema),
  createOpenQuestion: z.boolean(),
  healthNotice: maybe,
  openQuestionId: maybe,
  /** "demo_rules" is the offline keyword provider and must be labelled as such; "none" means no model call */
  answeredBy: z.enum(["demo_rules", "anthropic", "bedrock", "gemini", "none"]).default("none"),
  /** true when the question asks for medical judgment: the answer is a non-diagnostic 811/911 pointer */
  medicalRedirect: z.boolean().default(false),
  retrieval: z
    .object({
      method: z.enum(["keyword", "keyword+vector", "none"]),
      /** approved current facts that passed owner scoping and were sent as context */
      considered: z.number().int(),
    })
    .default({ method: "none", considered: 0 }),
});
export type AskView = z.infer<typeof askSchema>;

const recoverSchema = z.object({
  groups: z.object({
    handled: z.array(requestViewSchema),
    waiting: z.array(requestViewSchema),
    needsFollowUp: z.array(requestViewSchema),
    notSent: z.array(requestViewSchema),
    new: z.array(
      z.object({
        id: text,
        title: maybe,
        startsAt: timestamp.nullable(),
        requestId: maybe,
      }),
    ),
  }),
  appNow: timestamp,
  expiredRequestIds: z.array(text),
});
export type RecoverView = z.infer<typeof recoverSchema>;

const careSourceDetailSchema = z.object({
  id: text,
  kind: text,
  author: text,
  createdAt: text,
  /** the retained source text; plain text only */
  fullText: text,
});
export type CareSourceDetailView = z.infer<typeof careSourceDetailSchema>;
const careContactSchema = z.object({
  id: text,
  name: text,
  relationship: maybe,
  phone: text,
  /** emergency: call first in an emergency after 911; trusted: can help or take a shift */
  kind: z.enum(["emergency", "trusted"]),
  createdAt: text,
});
export type CareContactView = z.infer<typeof careContactSchema>;
const factEditSchema = z.object({ fact: careFactSchema, previous: careFactSchema.nullable() });
const completionSchema = z.object({ eventId: text, date: isoDate, completedAt: maybe });

const clockSchema = z.object({
  appNow: timestamp,
  realNow: timestamp,
  offsetMilliseconds: z.number().finite(),
});
export type ClockView = z.infer<typeof clockSchema>;
const jumpSchema = clockSchema.extend({ expiredRequestIds: z.array(text) });

export function createLiveApi(transport: typeof fetch = fetch) {
  const call = createCaller(transport);
  const model = { timeoutMs: MODEL_TIMEOUT_MS };
  return {
    session: () =>
      call("/api/session", sessionSchema, { timeoutMs: SESSION_TIMEOUT_MS }),
    intake: (statement: string) =>
      call("/api/intake", intakeSchema, { body: { statement }, ...model }),
    impact: (episodeId: string) =>
      call("/api/impact", impactSchema, { body: { episodeId }, ...model }),
    decide: (input: {
      commitmentId: string;
      decision: Decision;
      contactId?: string;
      note?: string;
    }) => call("/api/commitments/decide", decideSchema, { body: input, ...model }),
    addToTimeline: (commitmentId: string) =>
      call(
        "/api/commitments/timeline",
        z.object({ eventId: text, created: z.boolean() }),
        { body: { commitmentId } },
      ),
    guide: (address: string, tenure: Tenure) => {
      const query = new URLSearchParams({ tenure });
      if (address.trim()) query.set("address", address.trim());
      return call(`/api/guide?${query}`, guideSchema, model);
    },
    careProfile: () => call("/api/care/facts", careProfileSchema),
    addCareText: (kind: "note" | "voice", value: string) =>
      call("/api/care/sources", careSourceSchema, {
        body: { kind, text: value },
        ...model,
      }),
    uploadCarePdf: (file: Blob, name = "care-document.pdf") => {
      const form = new FormData();
      form.append("file", file, name);
      return call("/api/care/sources", careSourceSchema, {
        body: form,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
    },
    approveFact: (factId: string) =>
      call(
        `/api/care/facts/${encodeURIComponent(factId)}/approve`,
        z.object({ fact: careFactSchema }),
        { body: {} },
      ),
    resolveConflict: (keepFactId: string) =>
      call(
        "/api/care/conflicts/resolve",
        z.object({
          kept: careFactSchema.nullable(),
          superseded: z.array(careFactSchema),
        }),
        { body: { keepFactId } },
      ),
    timeline: (date: string) =>
      call(
        `/api/care/timeline?${new URLSearchParams({ date })}`,
        timelineSchema,
      ),
    ask: (question: string) =>
      call("/api/care/ask", askSchema, { body: { question }, ...model }),
    rejectFact: (factId: string) =>
      call(
        `/api/care/facts/${encodeURIComponent(factId)}/reject`,
        z.object({ fact: careFactSchema }),
        { body: {} },
      ),
    /** approves the caregiver's corrected wording as a new version; the old fact is kept as superseded */
    editFact: (factId: string, value: string) =>
      call(`/api/care/facts/${encodeURIComponent(factId)}/edit`, factEditSchema, {
        body: { text: value },
      }),
    careSource: (sourceId: string) =>
      call(
        `/api/care/sources/${encodeURIComponent(sourceId)}`,
        careSourceDetailSchema,
      ),
    careContacts: () =>
      call("/api/care/contacts", z.object({ contacts: z.array(careContactSchema) })),
    addCareContact: (input: {
      name: string;
      relationship?: string | null;
      phone: string;
      kind: "emergency" | "trusted";
    }) =>
      call("/api/care/contacts", z.object({ contact: careContactSchema }), {
        body: input,
      }),
    removeCareContact: (contactId: string) =>
      call(
        `/api/care/contacts/${encodeURIComponent(contactId)}/remove`,
        z.object({ removed: z.boolean() }),
        { body: {} },
      ),
    /** records (or clears) that the caregiver marked one occurrence done; never inferred from viewing */
    completeEvent: (eventId: string, date: string, done: boolean) =>
      call(
        `/api/care/events/${encodeURIComponent(eventId)}/complete`,
        completionSchema,
        { body: { date, done } },
      ),
    recover: () => call("/api/recover", recoverSchema),
    recoverRefresh: () => call("/api/recover", recoverSchema, { body: {} }),
    clock: () => call("/api/clock", clockSchema),
    jump: (days: number) => call("/api/clock/jump", jumpSchema, { body: { days } }),
    resetClock: () => call("/api/clock/reset", clockSchema, { body: {} }),
  };
}
export type LiveApi = ReturnType<typeof createLiveApi>;

const ERROR_TEXT: Record<string, string> = {
  rate_limited:
    "Too many AI requests in a short time. Wait a few minutes, then try again.",
  contact_required:
    "No contact matches this commitment yet. Choose who should receive the request.",
  draft_empty:
    "The draft came back empty, so nothing was queued. Try again or choose another action.",
  model_needs_review:
    "The AI result did not pass its checks, so nothing was saved. Try again or reword it.",
  model_unavailable:
    "The AI provider is unavailable right now. Nothing was saved; try again shortly.",
  no_text_layer:
    "This PDF has no text layer, so no fact can be checked word for word. Type the key lines as a note instead.",
  unreadable_pdf:
    "This PDF could not be read. Try another file or type the key lines as a note.",
  source_too_long:
    "This source is too long to check word for word. Split it into shorter notes.",
  payload_too_large: "That file is too large. Upload a PDF under 10 MB.",
  unsupported_media_type: "Only PDF files can be uploaded here.",
  conflict_unresolved:
    "This fact conflicts with another one. Choose which version to keep first.",
  state_conflict:
    "This item changed elsewhere. Refresh to see its recorded state.",
  forbidden: "Only an admin account can move the demo clock.",
  care_recipient_not_found:
    "No care recipient is set up for this account yet.",
  start_time_required:
    "This commitment has no start time, so it cannot join the care timeline.",
  invalid_input: "Some details were not accepted. Check them and try again.",
};

/** plain-language text for a failed live call; never shows provider or database wording */
export function liveErrorMessage(error: unknown): string {
  if (error instanceof RequestApiError) {
    if (error.detail && error.status === 422) return error.detail;
    const known = ERROR_TEXT[error.code];
    if (known) return known;
  }
  return apiErrorMessage(error);
}

/** the adapter badges shown in live mode, so nobody mistakes the local outbox for real email */
export function modeLabels(mode: LiveMode): string[] {
  const ai: Record<string, string> = {
    demo: "Demo AI provider (offline rules)",
    anthropic: "Claude API",
    bedrock: "Claude on Amazon Bedrock",
  };
  const mail: Record<string, string> = {
    outbox: "Local outbox, no real email",
    gmail: "Gmail: real email is sent",
  };
  const calendar: Record<string, string> = {
    seed: "Seeded demo calendar",
    google: "Google Calendar, read-only",
  };
  const db: Record<string, string> = {
    pglite: "Local database",
    aurora: "Aurora database",
  };
  const auth: Record<string, string> = {
    demo: "Demo sign-in (fictional Alex)",
    google: "Google sign-in",
  };
  return [
    ai[mode.ai] ?? `AI: ${mode.ai}`,
    mail[mode.mail] ?? `Mail: ${mode.mail}`,
    calendar[mode.calendar] ?? `Calendar: ${mode.calendar}`,
    db[mode.db] ?? `Database: ${mode.db}`,
    auth[mode.auth] ?? `Sign-in: ${mode.auth}`,
  ];
}

/** only http and https links become clickable; anything else stays plain text */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

// alberta time is utc-6 all year in this app (PRD section 14), matching the server
const ALBERTA_ZONE = "Etc/GMT+6";
const ALBERTA_OFFSET_MS = 6 * 3600000;

export function albertaDateOf(ms: number): string {
  return new Date(ms - ALBERTA_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDaysTo(date: string, days: number): string {
  const ms = Date.parse(`${date}T12:00:00Z`) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatAlberta(
  iso: string | number | null,
  style: "full" | "day" | "time" = "full",
): string {
  if (iso === null) return "No time set";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "No time set";
  const options: Intl.DateTimeFormatOptions =
    style === "day"
      ? { weekday: "short", month: "short", day: "numeric" }
      : style === "time"
        ? { hour: "numeric", minute: "2-digit" }
        : {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          };
  return new Intl.DateTimeFormat("en-CA", {
    ...options,
    timeZone: ALBERTA_ZONE,
  }).format(ms);
}

/** "Nov 10" for a YYYY-MM-DD date */
export function formatDate(date: string): string {
  const ms = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(ms)) return "Confirm dates";
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(ms);
}

export function categoryLabel(category: string | null): string {
  if (!category) return "appointment";
  if (category === "medical_instruction") return "medical instruction as written";
  return category.replaceAll("_", " ");
}

export function sourceLabel(kind: string | null): string {
  if (kind === "voice") return "Voice note";
  if (kind === "document") return "PDF document";
  if (kind === "note") return "Typed note";
  return "Unknown source";
}

const DAY_NAMES: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

/** a short plain description of the rrule subset A4 produces */
export function rruleLabel(rrule: string | null): string {
  if (!rrule) return "Once";
  const parts = new Map(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const days = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((day) => DAY_NAMES[day.trim().toUpperCase()])
    .filter(Boolean);
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq === "DAILY") return interval > 1 ? `Every ${interval} days` : "Every day";
  if (freq === "WEEKLY") {
    const list =
      days.length > 1
        ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`
        : (days[0] ?? "");
    const on = list ? ` on ${list}` : "";
    return interval > 1 ? `Every ${interval} weeks${on}` : `Every week${on}`;
  }
  return "Repeats";
}
