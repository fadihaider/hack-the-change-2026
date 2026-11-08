// end-to-end smoke run over HTTP against a running local mvp (npm run dev), using the fictional Rosa persona
// usage: npx tsx scripts/mvp-smoke.ts            (SMOKE_BASE_URL defaults to http://localhost:3000)
// prints one line per step with ok or FAIL; exits 1 when any step fails. it resets the demo clock at start and end.
import { DISCHARGE_SHEET, VOICE_NOTE } from "../lib/ai/fixtures/rosa.ts";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const STATEMENT =
  "My mom Rosa has day surgery tomorrow and I'll be helping her at home for a week. " +
  "Please handle what can be postponed and keep me from losing track.";

interface Result {
  status: number;
  data: any;
}

async function api(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Origin: ORIGIN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectOk(result: Result, what: string): void {
  expect(result.status === 200, `${what}: HTTP ${result.status} ${result.data?.error?.code ?? ""}`.trim());
}

let failures = 0;

async function step(name: string, work: () => Promise<string | void>): Promise<void> {
  const started = Date.now();
  try {
    const detail = (await work()) ?? "";
    console.log(`ok   ${name.padEnd(28)} ${detail} (${Date.now() - started} ms)`.trimEnd());
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name.padEnd(28)} ${error instanceof Error ? error.message : String(error)}`);
  }
}

// values later steps depend on; a missing one makes those steps fail with a clear message
const state: {
  session?: any;
  episodeId?: string;
  episodeStart?: string;
  commitments?: any[];
  requestIds: Record<string, string>;
  token?: string;
} = { requestIds: {} };

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`skipped: no ${what} from an earlier step`);
  return value;
}

const PICKS: { key: string; title: RegExp; decision: string }[] = [
  { key: "meeting", title: /group project meeting/i, decision: "reschedule" },
  { key: "shift", title: /work shift/i, decision: "coverage" },
  { key: "assignment", title: /assignment/i, decision: "extension" },
];

async function main(): Promise<void> {
  console.log(`ReliefReady mvp smoke against ${BASE}`);

  await step("session", async () => {
    const result = await api("GET", "/api/session");
    expectOk(result, "session");
    state.session = result.data;
    return `${result.data.user.email}, ai=${result.data.mode.ai}, mail=${result.data.mode.mail}`;
  });

  await step("clock reset", async () => {
    const result = await api("POST", "/api/clock/reset", {});
    expectOk(result, "clock reset");
    return `offset ${result.data.offsetMilliseconds} ms`;
  });

  await step("intake", async () => {
    const result = await api("POST", "/api/intake", { statement: STATEMENT });
    expectOk(result, "intake");
    expect(result.data.result.status === "ready", `intake status ${result.data.result.status}`);
    expect(result.data.episodeId, "no episodeId");
    state.episodeId = result.data.episodeId;
    state.episodeStart = result.data.result.startDate;
    return `${result.data.result.startDate} to ${result.data.result.endDate}, reason "${result.data.result.reasonText}"`;
  });

  await step("impact", async () => {
    const result = await api("POST", "/api/impact", { episodeId: need(state.episodeId, "episode") });
    expectOk(result, "impact");
    const commitments = result.data.commitments as any[];
    expect(commitments.length > 0, "no commitments in the window");
    const mom = commitments.find((c) => c.forCareRecipient);
    expect(!mom || mom.suggestedAction === "keep", "the care recipient's appointment is not suggested as keep");
    state.commitments = commitments;
    return `${commitments.length} commitments, model ${result.data.modelStatus}, mom appointment ${mom ? "keep" : "absent"}`;
  });

  for (const pick of PICKS) {
    await step(`decide ${pick.key}`, async () => {
      const commitment = need(state.commitments, "commitments").find((c) => pick.title.test(c.title));
      expect(commitment, `no commitment matching ${pick.title}`);
      const result = await api("POST", "/api/commitments/decide", { commitmentId: commitment.id, decision: pick.decision });
      expectOk(result, "decide");
      const request = result.data.request;
      expect(request?.state === "awaiting_approval", `request state ${request?.state}`);
      state.requestIds[pick.key] = request.id;
      return `${pick.decision} to ${request.recipient.email} (${request.disclosureTier})`;
    });
  }

  await step("list requests", async () => {
    const result = await api("GET", "/api/requests");
    expectOk(result, "list");
    const ids = new Set((result.data.requests as any[]).map((r) => r.id));
    for (const id of Object.values(state.requestIds)) expect(ids.has(id), `request ${id} missing from the list`);
    return `${result.data.requests.length} requests, appNow ${result.data.appNow}`;
  });

  for (const pick of PICKS) {
    await step(`approve ${pick.key}`, async () => {
      const id = need(state.requestIds[pick.key], `${pick.key} request`);
      const read = await api("GET", `/api/requests/${id}`);
      expectOk(read, "read");
      const result = await api("POST", "/api/requests/approve", { requestId: id }, { "If-Match": `"${read.data.request.revision}"` });
      expectOk(result, "approve");
      expect(result.data.request.state === "approved", `state ${result.data.request.state}`);
      return "approved with If-Match revision";
    });
  }

  for (const pick of PICKS) {
    await step(`send ${pick.key}`, async () => {
      const result = await api("POST", "/api/requests/send", { requestId: need(state.requestIds[pick.key], `${pick.key} request`) });
      expectOk(result, "send");
      expect(result.data.state === "requested", `send state ${result.data.state}`);
      return `message ${result.data.messageId}`;
    });
  }

  await step("outbox accept link", async () => {
    const shiftId = need(state.requestIds.shift, "shift request");
    const read = await api("GET", `/api/requests/${shiftId}`);
    expectOk(read, "read");
    const result = await api("GET", "/api/outbox");
    expectOk(result, "outbox");
    // newest first, so the first message to this recipient is the one just sent
    const message = (result.data.messages as any[]).find((m) => m.to === read.data.request.recipient.email);
    expect(message, "no outbox message for the shift request");
    const token = /Accept: \S+\/r\/([A-Za-z0-9_-]{43})/.exec(message.body)?.[1];
    expect(token, "no Accept link in the message");
    state.token = token;
    return `${result.data.messages.length} messages in the outbox`;
  });

  await step("response page (GET)", async () => {
    const response = await fetch(`${BASE}/r/${need(state.token, "token")}`, { signal: AbortSignal.timeout(120_000) });
    const html = await response.text();
    expect(response.status === 200, `HTTP ${response.status}`);
    expect(html.includes("Accept the request"), "no confirm button on the page");
    return "preview only, nothing recorded";
  });

  await step("POST accept", async () => {
    const result = await api("POST", `/api/responses/${need(state.token, "token")}`, {});
    expectOk(result, "accept");
    expect(result.data.state === "accepted" && result.data.recorded === true, `got ${JSON.stringify(result.data)}`);
    return "accepted, recorded";
  });

  await step("refresh", async () => {
    const result = await api("POST", "/api/requests/refresh", {});
    expectOk(result, "refresh");
    return `${result.data.expiredRequestIds.length} expired`;
  });

  await step("clock jump 7 days", async () => {
    const result = await api("POST", "/api/clock/jump", { days: 7 });
    expectOk(result, "jump");
    const mine = Object.values(state.requestIds).filter((id) => result.data.expiredRequestIds.includes(id));
    expect(mine.length === 2, `expected 2 of this run's requests to expire, got ${mine.length}`);
    return `appNow ${result.data.appNow}, ${result.data.expiredRequestIds.length} expired`;
  });

  await step("recover groups", async () => {
    const result = await api("GET", "/api/recover");
    expectOk(result, "recover");
    const groups = result.data.groups;
    const ids = (list: any[]) => new Set(list.map((r) => r.id));
    expect(ids(groups.handled).has(state.requestIds.shift), "the accepted request is not under Handled");
    expect(ids(groups.needsFollowUp).has(state.requestIds.meeting), "an expired request is not under Needs follow-up");
    return `handled ${groups.handled.length}, waiting ${groups.waiting.length}, follow-up ${groups.needsFollowUp.length}, ` +
      `not sent ${groups.notSent.length}, new ${groups.new.length}`;
  });

  await step("care note (voice)", async () => {
    const result = await api("POST", "/api/care/sources", { kind: "voice", text: VOICE_NOTE });
    expectOk(result, "care note");
    return `${result.data.facts.length} suggested facts, ${result.data.conflicts.length} conflicts`;
  });

  await step("care discharge text", async () => {
    const result = await api("POST", "/api/care/sources", { kind: "note", text: DISCHARGE_SHEET });
    expectOk(result, "discharge");
    expect(!result.data.facts.some((f: any) => f.status === "approved"), "a fact was approved without a click");
    return `${result.data.facts.length} suggested facts, ${result.data.conflicts.length} conflicts`;
  });

  await step("approve a fact", async () => {
    const result = await api("GET", "/api/care/facts");
    expectOk(result, "facts");
    const facts = result.data.facts as any[];
    const fact = facts.find((f) => f.status === "suggested" && /walk/i.test(f.textExact)) ?? facts.find((f) => f.status === "suggested");
    if (!fact) {
      expect(facts.some((f) => f.status === "approved"), "no suggested or approved fact");
      return "nothing new to approve (earlier run)";
    }
    const approved = await api("POST", `/api/care/facts/${fact.id}/approve`);
    expectOk(approved, "approve fact");
    expect(approved.data.fact.status === "approved", `fact status ${approved.data.fact.status}`);
    return `"${fact.textExact.slice(0, 50)}"`;
  });

  await step("resolve breakfast conflict", async () => {
    const result = await api("GET", "/api/care/facts");
    expectOk(result, "facts");
    const conflicting = (result.data.facts as any[]).filter((f) => f.status === "conflicting");
    expect(conflicting.length > 0, "no conflicting facts");
    const keep = conflicting.find((f) => f.textExact.includes("8:30")) ?? conflicting[0];
    const resolved = await api("POST", "/api/care/conflicts/resolve", { keepFactId: keep.id });
    expectOk(resolved, "resolve");
    return `kept "${keep.textExact.slice(0, 40)}", superseded ${resolved.data.superseded.length}`;
  });

  await step("timeline", async () => {
    const date = need(state.episodeStart, "episode start");
    const result = await api("GET", `/api/care/timeline?date=${date}`);
    expectOk(result, "timeline");
    expect(result.data.items.length > 0, "no timeline items");
    return `${date}: ${result.data.items.map((item: any) => item.localTime).join(", ")}`;
  });

  await step("ask spare glasses", async () => {
    const result = await api("POST", "/api/care/ask", { question: "Where are her spare glasses?" });
    expectOk(result, "ask");
    expect(result.data.notFound === true && result.data.answer === "Not in profile", `answer ${result.data.answer}`);
    expect(result.data.openQuestionId, "no open question was created");
    return "Not in profile, open question created";
  });

  await step("guide", async () => {
    const address = need(state.session, "session").careRecipient?.address as string | undefined;
    expect(address, "no care recipient address");
    const result = await api("GET", `/api/guide?address=${encodeURIComponent(address)}&tenure=not_sure`);
    expectOk(result, "guide");
    const cards = result.data.cards as any[];
    expect(cards.every((card) => card.sourceUrl && card.fetchedAt), "a card is missing its source or fetch date");
    return `${result.data.location.community}: ${cards.length} cards (${[...new Set(cards.map((c) => c.kind))].join(", ")})`;
  });

  await step("clock reset", async () => {
    const result = await api("POST", "/api/clock/reset", {});
    expectOk(result, "clock reset");
    return "back to real time";
  });

  console.log(failures === 0 ? "all steps ok" : `${failures} step(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.log(`FAIL smoke run stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
