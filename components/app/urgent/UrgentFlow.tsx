"use client";
// urgent: clear the care week one commitment at a time (variant B), then see who you asked and find help nearby
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Check, Clock, LoaderCircle, MapPin, RefreshCw, Send, Users } from "lucide-react";
import {
  liveErrorMessage,
  type CommitmentView,
  type Decision,
  type ImpactView,
  type LiveSession,
} from "@/lib/frontend/live-api.ts";
import type { RequestView } from "@/lib/frontend/request-api.ts";
import { HelpNearby } from "../guide/HelpNearby.tsx";
import { recipientName, useApis, useSession } from "../session.tsx";
import {
  Actions,
  Avatar,
  Button,
  ButtonLink,
  Choices,
  Column,
  DECISION_LABEL,
  ErrorNote,
  Note,
  Progress,
  Question,
  Receipt,
  StatePill,
  useAnnounce,
  type RequestState,
} from "../ui.tsx";
import { LetterSheet, type SendOutcome } from "./LetterSheet.tsx";
import * as w from "./words.ts";
import s from "./urgent.module.css";

// kept for the whole tab, so coming back to Urgent does not scan the calendar (a model call) again
const memory = {
  impact: new Map<string, ImpactView>(),
  pending: new Map<string, Promise<ImpactView>>(),
  timeline: new Set<string>(),
  flags: new Map<string, string[]>(),
};

/** states the letter can open on: it edits, approves and sends from here */
const REVIEWABLE = new Set<RequestState>(["draft", "awaiting_approval", "approved", "needs_review"]);

const GROUPS: { title: string; hint: string | null; states: RequestState[] }[] = [
  {
    title: "Needs you",
    hint: "Read these and send them, or choose again.",
    states: ["awaiting_approval", "draft", "approved", "needs_review", "failed", "expired"],
  },
  { title: "Waiting", hint: null, states: ["sending", "requested"] },
  { title: "Answered", hint: null, states: ["accepted", "completed", "rejected"] },
];

type Status =
  | { kind: "open"; requests: RequestView[] }
  | { kind: "decided"; decision: "keep" | "defer"; requests: RequestView[] }
  | { kind: "asked"; requests: RequestView[]; lead: RequestView };

type ReceiptIcon = "check" | "send" | "calendar" | "refresh";

// where Alex was in this tab (the step or the summary, and an open letter), so a reload picks up there
type Place = { at: string; sheet: string | null };
const SUMMARY = "summary";

function placeKey(episodeId: string) {
  return `rr.urgent.${episodeId}`;
}

function readPlace(episodeId: string): Place | null {
  try {
    const raw = window.sessionStorage.getItem(placeKey(episodeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Place>;
    if (typeof parsed.at !== "string") return null;
    return { at: parsed.at, sheet: typeof parsed.sheet === "string" ? parsed.sheet : null };
  } catch {
    // storage blocked or a bad value: start from the first open step
    return null;
  }
}

function writePlace(episodeId: string, place: Place) {
  try {
    window.sessionStorage.setItem(placeKey(episodeId), JSON.stringify(place));
  } catch {
    // storage blocked: a reload starts from the first open step instead
  }
}

/** requests that cannot be reviewed again; their commitment needs a new choice */
const CHOOSE_AGAIN = new Set<RequestState>(["failed", "expired", "rejected"]);
type ReceiptView = { text: string; icon: ReceiptIcon };

function byStart(a: CommitmentView, b: CommitmentView) {
  if (a.startsAt === b.startsAt) return a.id.localeCompare(b.id);
  if (a.startsAt === null) return 1;
  if (b.startsAt === null) return -1;
  return Date.parse(a.startsAt) - Date.parse(b.startsAt);
}

function newestFirst(a: RequestView, b: RequestView) {
  return Date.parse(w.changedAt(b) ?? "") - Date.parse(w.changedAt(a) ?? "");
}

function receiptIcon(icon: ReceiptIcon) {
  if (icon === "send") return <Send size={18} aria-hidden="true" />;
  if (icon === "calendar") return <CalendarPlus size={18} aria-hidden="true" />;
  if (icon === "refresh") return <RefreshCw size={18} aria-hidden="true" />;
  return <Check size={18} aria-hidden="true" />;
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <p className={s.loading} role="status">
      <LoaderCircle size={18} className={s.spin} aria-hidden="true" />
      {children}
    </p>
  );
}

/** requestId: from /urgent?request=<id>; opens the summary with that message (or its step to choose again) */
export function UrgentFlow({ requestId = null }: { requestId?: string | null }) {
  const { session, loading, error, reload } = useSession();

  if (!session) {
    if (loading) {
      return (
        <Column>
          <Loading>Loading your week</Loading>
        </Column>
      );
    }
    return (
      <Column>
        <Question>Your week didn’t load.</Question>
        <ErrorNote message={error ?? "ReliefReady couldn’t reach its server."} onRetry={() => void reload()} />
      </Column>
    );
  }

  if (!session.episode) {
    return (
      <Column>
        <Question lead="There’s no care week yet.">Start by telling ReliefReady what’s happening.</Question>
        <Actions>
          <ButtonLink href="/" variant="primary">
            Tell us what’s happening
          </ButtonLink>
          <Note>It takes a sentence or two. Nothing is sent without your OK.</Note>
        </Actions>
      </Column>
    );
  }

  return <Week key={session.episode.id} session={session} episodeId={session.episode.id} requestId={requestId} />;
}

function Week({ session, episodeId, requestId }: { session: LiveSession; episodeId: string; requestId: string | null }) {
  const { live, requests: requestApi } = useApis();
  const announce = useAnnounce();
  const care: w.CareName = { name: recipientName(session), alias: session.careRecipient?.alias ?? null };
  const carePossessive = w.possessive(care.name);
  const outbox = session.mode.mail === "outbox";

  const [impact, setImpact] = useState<ImpactView | null>(() => memory.impact.get(episodeId) ?? null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [all, setAll] = useState<RequestView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [motion, setMotion] = useState<"forward" | "back" | null>(null);
  const [moved, setMoved] = useState(false);
  const [reopened, setReopened] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stepError, setStepError] = useState<{ at: string; message: string } | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(() => new Set(memory.timeline));
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const focusSummary = useRef(false);
  // one api action at a time, even when a double click lands before the next render
  const lock = useRef(false);
  // the step on screen now; a slow save only moves Alex on if Alex is still on the step it was made from
  const where = useRef<number | null>(null);

  // one impact scan per care week per tab; a second mount while it runs shares the same call
  useEffect(() => {
    const cached = memory.impact.get(episodeId);
    if (cached) {
      setImpact(cached);
      return;
    }
    let current = true;
    setImpactError(null);
    let pending = memory.pending.get(episodeId);
    if (!pending) {
      pending = live.impact(episodeId);
      memory.pending.set(episodeId, pending);
      pending
        .then((result) => memory.impact.set(episodeId, result))
        .catch(() => {})
        .finally(() => memory.pending.delete(episodeId));
    }
    pending.then(
      (result) => {
        if (current) setImpact(result);
      },
      (caught: unknown) => {
        if (current) setImpactError(liveErrorMessage(caught));
      },
    );
    return () => {
      current = false;
    };
  }, [episodeId, attempt, live]);

  const loadList = useCallback(async (): Promise<RequestView[] | null> => {
    try {
      const result = await requestApi.list();
      setAll(result.requests);
      setListError(null);
      return result.requests;
    } catch (caught) {
      setListError(liveErrorMessage(caught));
      return null;
    }
  }, [requestApi]);

  // a moved demo clock can expire requests, so the list follows the app time
  const appNow = session.appNow;
  useEffect(() => {
    void loadList();
  }, [loadList, appNow]);

  // once the letter closes: after a send from the summary its heading takes the focus; otherwise, when the button
  // that opened the letter is gone (the step now shows the outcome), the step's question does
  const hadSheet = useRef(false);
  useEffect(() => {
    if (sheetId !== null) {
      hadSheet.current = true;
      return;
    }
    if (!hadSheet.current) return;
    hadSheet.current = false;
    if (focusSummary.current) {
      focusSummary.current = false;
      summaryHeading.current?.focus();
      return;
    }
    // the sheet puts focus back in a frame of its own; this one runs after it
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      document.querySelector<HTMLElement>("main h1[tabindex='-1']")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sheetId]);

  const commitments = useMemo(() => (impact ? impact.commitments.slice().sort(byStart) : []), [impact]);
  const byId = useMemo(() => new Map((all ?? []).map((r) => [r.id, r])), [all]);
  const dir = useMemo(
    () => w.buildDirectory(commitments, all ?? [], session.user.email),
    [commitments, all, session.user.email],
  );
  const total = commitments.length;

  function requestsOf(c: CommitmentView): RequestView[] {
    return c.requests
      .map((link) => byId.get(link.id))
      .filter((r): r is RequestView => Boolean(r))
      .sort(newestFirst);
  }

  function statusOf(c: CommitmentView): Status {
    const list = requestsOf(c);
    if (reopened[c.id]) return { kind: "open", requests: list };
    if (c.decision === "keep" || c.decision === "defer") return { kind: "decided", decision: c.decision, requests: list };
    const active = list.filter((r) => r.state !== "cancelled");
    if (active.length > 0) return { kind: "asked", requests: list, lead: active[0] };
    return { kind: "open", requests: list };
  }

  function commitmentOf(requestId: string) {
    return commitments.find((c) => c.requests.some((link) => link.id === requestId)) ?? null;
  }

  // the first screen: a message named in the link, else where Alex was in this tab, else the first step still to decide
  const ready = impact !== null && (all !== null || listError !== null);
  if (ready && requestId && all !== null && linked !== requestId) {
    setLinked(requestId);
    openLinked(requestId);
  } else if (index === null && ready) {
    const first = commitments.findIndex((c) => statusOf(c).kind === "open");
    const place = readPlace(episodeId);
    let start = first < 0 ? total : first;
    if (place) {
      const at = place.at === SUMMARY ? total : commitments.findIndex((c) => c.id === place.at);
      if (at >= 0) start = at;
      const open = place.sheet ? byId.get(place.sheet) : undefined;
      if (open && REVIEWABLE.has(open.state)) setSheetId(open.id);
    }
    setIndex(start);
  }

  function openLinked(id: string) {
    const target = byId.get(id);
    const c = target ? commitmentOf(id) : null;
    setReceipt(null);
    setStepError(null);
    setLinkProblem(null);
    if (target && c && CHOOSE_AGAIN.has(target.state)) {
      setReopened((prev) => ({ ...prev, [c.id]: true }));
      setIndex(commitments.indexOf(c));
      setReceipt({ text: `${w.outcomeLine(target)} Choose what to do now.`, icon: "check" });
    } else if (target && REVIEWABLE.has(target.state)) {
      setIndex(total);
      setSheetId(target.id);
    } else if (target) {
      setIndex(total);
      setReceipt({ text: w.outcomeLine(target), icon: "check" });
    } else {
      setIndex(total);
      setLinkProblem("That message isn’t in your list any more. Everyone you asked is below.");
    }
    // the link did its job; a reload now picks up from where Alex is, not from the link
    try {
      window.history.replaceState(window.history.state, "", "/urgent");
    } catch {
      // history blocked: the link opens the same message again on reload, which is harmless
    }
  }

  // remember the step and the open letter for this tab
  useEffect(() => {
    if (index === null || !impact) return;
    const at = index >= commitments.length ? SUMMARY : commitments[index].id;
    writePlace(episodeId, { at, sheet: sheetId });
  }, [index, sheetId, impact, commitments, episodeId]);

  function upsert(next: RequestView) {
    setAll((prev) => {
      const list = prev ?? [];
      const at = list.findIndex((r) => r.id === next.id);
      if (at < 0) return [next, ...list];
      const copy = list.slice();
      copy[at] = next;
      return copy;
    });
  }

  function saveDecision(commitmentId: string, decision: Decision, request: RequestView | null) {
    setImpact((prev) => {
      if (!prev) return prev;
      const next: ImpactView = {
        ...prev,
        commitments: prev.commitments.map((k) => {
          if (k.id !== commitmentId) return k;
          const linked = request && !k.requests.some((link) => link.id === request.id);
          return {
            ...k,
            decision,
            requests: linked
              ? [{ id: request.id, state: request.state, contactId: request.recipient.contactId }, ...k.requests]
              : k.requests,
          };
        }),
      };
      memory.impact.set(episodeId, next);
      return next;
    });
  }

  where.current = index;

  /** moves on after a save, unless Alex already went to another step while it ran */
  function advanceFrom(at: number) {
    if (where.current === at) go(at + 1, "forward");
  }

  function go(next: number, direction: "forward" | "back") {
    setLinkProblem(null);
    setMoved(true);
    setMotion(direction);
    setStepError(null);
    setIndex(Math.max(0, Math.min(total, next)));
  }

  function say(text: string, icon: ReceiptIcon = "check") {
    setReceipt({ text, icon });
    announce(text);
  }

  async function choose(c: CommitmentView, decision: Decision) {
    if (busy || lock.current) return;
    lock.current = true;
    const here = index ?? 0;
    setBusy(`${c.id}:${decision}`);
    setStepError(null);
    try {
      // a new plan withdraws messages for this commitment that were never sent
      const unsent = requestsOf(c).filter((r) => r.state === "awaiting_approval" || r.state === "needs_review");
      const withdraw = w.isMessageDecision(decision) ? unsent.filter((r) => r.action !== decision) : unsent;
      for (const r of withdraw) upsert((await requestApi.cancel(r.id)).request);
      const contactId = c.suggestedContactId ?? undefined;
      const result = await live.decide({ commitmentId: c.id, decision, ...(contactId ? { contactId } : {}) });
      saveDecision(c.id, result.commitment.decision, result.request);
      setReopened((prev) => ({ ...prev, [c.id]: false }));

      const request = result.request;
      if (request) {
        upsert(request);
        if (result.editFlags.length > 0) memory.flags.set(request.id, result.editFlags);
        if (REVIEWABLE.has(request.state)) {
          setReceipt(null);
          setSheetId(request.id);
          return;
        }
        say(`${w.outcomeLine(request)} No new message was written.`);
        return;
      }
      const ref = w.refTitle(c, care);
      const names = w.joinNames(withdraw.map((r) => w.shortName(r.recipient.name)));
      const lead = result.commitment.decision === "defer" ? `You’ll decide about ${ref} later.` : `Keeping ${ref}.`;
      say(withdraw.length > 0 ? `${lead} The unsent message to ${names} was withdrawn.` : lead);
      advanceFrom(here);
    } catch (caught) {
      setStepError({ at: c.id, message: liveErrorMessage(caught) });
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function addTimeline(c: CommitmentView, advance: boolean) {
    if (busy || lock.current) return;
    lock.current = true;
    const here = index ?? 0;
    setBusy(`${c.id}:timeline`);
    setStepError(null);
    try {
      const result = await live.addToTimeline(c.id);
      memory.timeline.add(c.id);
      setAdded(new Set(memory.timeline));
      if (c.decision !== "keep") {
        const kept = await live.decide({ commitmentId: c.id, decision: "keep" });
        saveDecision(c.id, kept.commitment.decision, null);
      }
      say(
        result.created ? `Added to ${carePossessive} timeline in Care.` : `It was already on ${carePossessive} timeline.`,
        "calendar",
      );
      if (advance) advanceFrom(here);
    } catch (caught) {
      setStepError({ at: c.id, message: liveErrorMessage(caught) });
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function checkReplies() {
    if (busy || lock.current) return;
    lock.current = true;
    setBusy("refresh");
    setStepError(null);
    const before = new Map(episodeRequests.map((r) => [r.id, r.state]));
    try {
      const result = await requestApi.refresh();
      setAll(result.requests);
      setListError(null);
      setCheckedAt(result.appNow);
      const changed = result.requests.filter((r) => before.has(r.id) && before.get(r.id) !== r.state);
      say(changed.length === 0 ? "No new replies yet." : changed.map((r) => w.outcomeLine(r)).join(" "), "refresh");
    } catch (caught) {
      setStepError({ at: "summary", message: liveErrorMessage(caught) });
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  function reopen(c: CommitmentView) {
    setMoved(true);
    setReceipt(null);
    setStepError(null);
    setReopened((prev) => ({ ...prev, [c.id]: true }));
  }

  function chooseAgain(c: CommitmentView) {
    const at = commitments.indexOf(c);
    if (at < 0) return;
    setReceipt(null);
    setReopened((prev) => ({ ...prev, [c.id]: true }));
    go(at, "back");
  }

  function sent(request: RequestView, outcome: SendOutcome) {
    const who = w.shortName(request.recipient.name);
    const c = commitmentOf(request.id);
    const at = c ? commitments.indexOf(c) : -1;
    const fromStep = index !== null && index < total && at === index;
    setSheetId(null);
    void loadList();
    if (outcome.state === "failed") {
      setReceipt(null);
      setStepError({
        at: fromStep && c ? c.id : "summary",
        message: `The message to ${who} didn’t send, and it won’t retry on its own. Choose again to write a new one.`,
      });
      return;
    }
    say(`Sent to ${who}. Waiting for a reply.`, "send");
    if (fromStep) go((index ?? 0) + 1, "forward");
    else focusSummary.current = true;
  }

  const reloadOne = useCallback(
    async (requestId: string) => (await loadList())?.find((r) => r.id === requestId) ?? null,
    [loadList],
  );

  // ---------------------------------------------------------------- what the screen shows

  const episodeIds = new Set(commitments.flatMap((c) => c.requests.map((link) => link.id)));
  const episodeRequests = (all ?? []).filter((r) => episodeIds.has(r.id));
  const sheetRequest = sheetId ? (byId.get(sheetId) ?? null) : null;
  const sheetWho = sheetRequest ? w.shortName(sheetRequest.recipient.name) : "";
  const sheetProposal = sheetRequest ? w.isProposal(sheetRequest) : false;

  const letter = (
    <LetterSheet
      request={sheetRequest}
      open={sheetRequest !== null}
      title={
        sheetRequest
          ? sheetProposal
            ? `Write back to ${sheetWho}`
            : w.sheetTitle(sheetRequest.action, sheetWho)
          : ""
      }
      lead={
        sheetRequest && sheetProposal
          ? sheetRequest.proposedAt
            ? `${sheetWho} suggested ${w.endSentence(w.stamp(sheetRequest.proposedAt))} Change the message to answer, then send it.`
            : `${sheetWho} asked for another time. Change the message to answer, then send it.`
          : "Change any words you like. Nothing goes out until you send it."
      }
      flags={sheetRequest ? (memory.flags.get(sheetRequest.id) ?? []) : []}
      senderEmail={session.user.email}
      outbox={outbox}
      onClose={() => setSheetId(null)}
      onUpdate={upsert}
      onSent={sent}
      reload={reloadOne}
    />
  );

  if (impactError && !impact) {
    return (
      <Column>
        <Question>Your week didn’t load.</Question>
        <ErrorNote message={impactError} onRetry={() => setAttempt((n) => n + 1)} />
      </Column>
    );
  }

  if (!impact || index === null) {
    return (
      <Column>
        <Loading>Checking your week</Loading>
      </Column>
    );
  }

  if (total === 0) {
    return (
      <Column>
        <Question lead={`Nothing in your calendar clashes with ${carePossessive} care week.`}>
          No one needs a message.
        </Question>
        <div className={s.help}>
          <HelpNearby address={session.careRecipient?.address ?? null} />
        </div>
      </Column>
    );
  }

  const onSummary = index >= total;
  const current = onSummary ? null : commitments[index];
  const statuses = commitments.map((c) => statusOf(c));
  const decidedCount = statuses.filter((status) => status.kind !== "open").length;

  const progress = (
    <Progress
      total={total}
      current={index}
      labels={commitments.map((c) => c.title)}
      done={statuses.map((status) => status.kind !== "open")}
      countText={onSummary ? `${decidedCount} of ${total} decided` : undefined}
      label="Your week, in order"
      onBack={
        index > 0
          ? () => {
              setReceipt(null);
              go(index - 1, "back");
            }
          : undefined
      }
    />
  );

  const listProblem = listError && (
    <div className={s.spaceBelow}>
      <ErrorNote message={`Your messages didn’t load. ${listError}`} onRetry={() => void loadList()} />
    </div>
  );

  const receiptView = receipt && <Receipt icon={receiptIcon(receipt.icon)}>{receipt.text}</Receipt>;

  function errorFor(at: string) {
    if (stepError?.at !== at) return null;
    return (
      <div className={s.space}>
        <ErrorNote message={stepError.message} />
      </div>
    );
  }

  function meta(c: CommitmentView) {
    const people = w.withNames(c, dir);
    return (
      <ul className={s.meta}>
        <li className={s.metaItem}>
          <Clock size={16} aria-hidden="true" />
          <span className={s.time}>{w.whenLine(c)}</span>
        </li>
        {c.location && (
          <li className={s.metaItem}>
            <MapPin size={16} aria-hidden="true" />
            <span>{c.location}</span>
          </li>
        )}
        {people.length > 0 && (
          <li className={s.metaItem}>
            <Users size={16} aria-hidden="true" />
            <span>With {w.joinNames(people)}</span>
          </li>
        )}
      </ul>
    );
  }

  function proposalView(r: RequestView) {
    if (!w.isProposal(r)) return null;
    return (
      <div className={s.proposal}>
        <span className={s.proposalWhen}>
          {r.proposedAt ? (
            <>
              Suggested <time dateTime={r.proposedAt}>{w.stamp(r.proposedAt)}</time>
            </>
          ) : (
            "Asked for another time"
          )}
        </span>
        {r.proposedNote && <span className={s.proposalNote}>“{r.proposedNote}”</span>}
      </div>
    );
  }

  function messagesSoFar(c: CommitmentView, list: RequestView[]) {
    if (list.length === 0) return null;
    const id = `ur-earlier-${c.id}`;
    return (
      <section className={s.earlier} aria-labelledby={id}>
        <h2 id={id} className={s.earlierTitle}>
          Messages so far
        </h2>
        <ul className={s.reqList} role="list">
          {list.map((r) => {
            const at = w.changedAt(r);
            return (
              <li key={r.id} className={s.reqRow}>
                <span className={s.reqName}>{r.recipient.name}</span>
                <span className={s.reqPill}>
                  <StatePill state={r.state} />
                </span>
                {at && (
                  <time className={s.reqTime} dateTime={at}>
                    {w.stamp(at)}
                  </time>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  function nextLabel(at: number) {
    const next = commitments[at + 1];
    return next ? `Next: ${w.buttonTitle(next, care)}` : "See who you asked";
  }

  function next(at: number) {
    setReceipt(null);
    go(at + 1, "forward");
  }

  function stepView(c: CommitmentView, status: Status, at: number) {
    const fact = w.factLine(c, care, appNow);
    const key = `${c.id}:${status.kind}`;

    if (status.kind === "decided") {
      const onTimeline = added.has(c.id);
      let outcome = "You’ll decide later.";
      if (status.decision === "keep") {
        outcome = c.forCareRecipient && onTimeline ? `You’re keeping it. It’s on ${carePossessive} timeline.` : "You’re keeping it.";
      }
      return (
        <div key={key}>
          {receiptView}
          {meta(c)}
          <Question lead={fact} autoFocusOnMount={moved}>
            {outcome}
          </Question>
          <Actions>
            <Button variant="primary" onClick={() => next(at)}>
              {nextLabel(at)}
            </Button>
            {c.forCareRecipient && !onTimeline && (
              <Button
                variant="secondary"
                busy={busy === `${c.id}:timeline`}
                busyLabel="Adding it"
                onClick={() => void addTimeline(c, false)}
              >
                <CalendarPlus size={18} aria-hidden="true" />
                Add to {carePossessive} timeline
              </Button>
            )}
            {!c.forCareRecipient && (
              <Button variant="quiet" onClick={() => reopen(c)}>
                Change the plan
              </Button>
            )}
          </Actions>
          {errorFor(c.id)}
          {messagesSoFar(c, status.requests)}
        </div>
      );
    }

    if (status.kind === "asked") {
      const lead = status.lead;
      const who = w.shortName(lead.recipient.name);
      const reviewable = REVIEWABLE.has(lead.state);
      return (
        <div key={key}>
          {receiptView}
          {meta(c)}
          <Question lead={fact} autoFocusOnMount={moved}>
            {w.outcomeLine(lead)}
          </Question>
          {proposalView(lead)}
          <Actions>
            {reviewable && (
              <Button variant="primary" onClick={() => setSheetId(lead.id)}>
                {w.isProposal(lead) ? `Write back to ${who}` : "Review and send"}
              </Button>
            )}
            <Button variant={reviewable ? "secondary" : "primary"} onClick={() => next(at)}>
              {nextLabel(at)}
            </Button>
            <Button variant="quiet" onClick={() => reopen(c)}>
              Change the plan
            </Button>
          </Actions>
          {errorFor(c.id)}
          {messagesSoFar(c, status.requests)}
        </div>
      );
    }

    if (c.forCareRecipient) {
      return (
        <div key={key}>
          {receiptView}
          {meta(c)}
          <Question lead={fact} autoFocusOnMount={moved}>
            You’re keeping it. Add it to {carePossessive} timeline?
          </Question>
          <Actions>
            <Button
              variant="primary"
              busy={busy === `${c.id}:timeline`}
              busyLabel="Adding it"
              disabled={busy !== null && busy !== `${c.id}:timeline`}
              onClick={() => void addTimeline(c, true)}
            >
              <CalendarPlus size={18} aria-hidden="true" />
              Add to {carePossessive} timeline
            </Button>
            <Note>It’s {carePossessive} own appointment, so no message goes out.</Note>
            <Button
              variant="quiet"
              busy={busy === `${c.id}:keep`}
              busyLabel="Saving"
              disabled={busy !== null && busy !== `${c.id}:keep`}
              onClick={() => void choose(c, "keep")}
            >
              {DECISION_LABEL.keep}
            </Button>
          </Actions>
          {errorFor(c.id)}
        </div>
      );
    }

    // open: the suggested decision first, the sensible others beside it, keeping it last
    // a saved message decision leads; after keeping or deferring, changing the plan starts from the suggestion again
    const suggested = w.isMessageDecision(c.decision) ? c.decision : c.suggestedAction;
    const person = c.suggestedContactId ? dir.get(c.suggestedContactId) : undefined;
    const who = person ? w.shortName(person.name) : "them";
    let primary: Decision = w.isMessageDecision(suggested) ? suggested : "notify";
    let ask = w.isMessageDecision(primary) ? w.askLine(primary, who) : "";
    let others: Decision[] = w.isMessageDecision(primary) ? w.ALTERNATIVES[primary] : [];
    let quiet: Decision = "keep";
    if (suggested === "keep" || suggested === "defer") {
      primary = suggested;
      ask = suggested === "keep" ? "Keep it as planned?" : "Decide about it later?";
      others = ["notify", "reschedule"];
      quiet = suggested === "keep" ? "defer" : "keep";
    }
    const button = (decision: Decision, variant: "primary" | "secondary" | "quiet") => {
      const id = `${c.id}:${decision}`;
      return (
        <Button
          key={decision}
          variant={variant}
          busy={busy === id}
          busyLabel={w.isMessageDecision(decision) ? "Writing the message" : "Saving"}
          disabled={busy !== null && busy !== id}
          onClick={() => void choose(c, decision)}
        >
          {DECISION_LABEL[decision]}
        </Button>
      );
    };
    return (
      <div key={key}>
        {receiptView}
        {impact?.modelStatus === "unavailable" && (
          <p className={s.stepNote}>Suggestions aren’t available right now, so pick what fits.</p>
        )}
        {meta(c)}
        <Question lead={fact} autoFocusOnMount={moved}>
          {ask}
        </Question>
        <Actions>
          {button(primary, "primary")}
          {w.isMessageDecision(primary) && <Note>You’ll read the message before anything is sent.</Note>}
          <Choices>{others.map((decision) => button(decision, "secondary"))}</Choices>
          {button(quiet, "quiet")}
        </Actions>
        {errorFor(c.id)}
        {messagesSoFar(c, status.requests)}
      </div>
    );
  }

  function rowTime(r: RequestView) {
    const at = w.changedAt(r);
    if (r.state === "requested") {
      return (
        <span className={s.reqTime}>
          {at && (
            <>
              Sent <time dateTime={at}>{w.stamp(at)}</time>
              {w.stamp(at).endsWith(".") ? " " : ". "}
            </>
          )}
          {r.respondBy && (
            <>
              Reply by <time dateTime={r.respondBy}>{w.stamp(r.respondBy)}</time>
              {w.stamp(r.respondBy).endsWith(".") ? "" : "."}
            </>
          )}
        </span>
      );
    }
    if (!at) return null;
    let word = "Changed";
    if (r.state === "accepted" || r.state === "completed" || r.state === "rejected" || w.isProposal(r)) word = "Answered";
    else if (r.state === "awaiting_approval" || r.state === "draft") word = "Written";
    else if (r.state === "approved") word = "Approved";
    else if (r.state === "expired") word = "Ran out of time";
    else if (r.state === "failed") word = "Tried";
    return (
      <span className={s.reqTime}>
        {word} <time dateTime={at}>{w.stamp(at)}</time>
      </span>
    );
  }

  function summaryView() {
    const visible = episodeRequests.filter((r) => r.state !== "cancelled");
    const waiting = visible.some((r) => r.state === "requested");
    return (
      <div key="summary">
        {receiptView}
        {listProblem}
        {linkProblem && (
          <div className={s.spaceBelow}>
            <ErrorNote message={linkProblem} />
          </div>
        )}
        <Question ref={summaryHeading} autoFocusOnMount={moved} lead={visible.length === 0 ? "Nothing has gone out yet." : undefined}>
          {visible.length === 0 ? "You haven’t asked anyone." : "Here’s who you asked"}
        </Question>
        {visible.length === 0 && <Note align="start">Go back to a step and choose who to ask.</Note>}
        {GROUPS.map((group) => {
          const rows = visible.filter((r) => group.states.includes(r.state)).sort(newestFirst);
          if (rows.length === 0) return null;
          const id = `ur-group-${group.title.replace(/\W+/g, "-").toLowerCase()}`;
          return (
            <section key={group.title} className={s.group} aria-labelledby={id}>
              <h2 id={id} className={s.groupTitle}>
                {group.title}
              </h2>
              {group.hint && <p className={s.groupHint}>{group.hint}</p>}
              <ul className={s.reqList} role="list">
                {rows.map((r) => {
                  const c = commitmentOf(r.id);
                  const who = w.shortName(r.recipient.name);
                  const reviewable = REVIEWABLE.has(r.state);
                  const again = c && (r.state === "failed" || r.state === "expired" || r.state === "rejected");
                  return (
                    <li key={r.id} className={`${s.reqRow} ${s.reqRowLarge}`}>
                      <span className={s.reqWho}>
                        <Avatar name={r.recipient.name} size="sm" />
                        <span className={s.reqName}>{r.recipient.name}</span>
                      </span>
                      <span className={s.reqPill}>
                        <StatePill state={r.state} />
                      </span>
                      <span className={s.reqSubject}>{r.subject}</span>
                      {rowTime(r)}
                      {w.isProposal(r) && <div className={s.reqExtra}>{proposalView(r)}</div>}
                      {(reviewable || again) && (
                        <span className={s.rowActions}>
                          {reviewable && (
                            <Button variant="secondary" className={s.rowButton} onClick={() => setSheetId(r.id)}>
                              {w.isProposal(r) ? `Write back to ${who}` : "Review and send"}
                            </Button>
                          )}
                          {again && (
                            <Button variant="quiet" className={s.rowButton} onClick={() => chooseAgain(c)}>
                              Choose again
                            </Button>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        <div className={s.summaryActions}>
          {visible.length > 0 && (
            <Button
              variant="secondary"
              busy={busy === "refresh"}
              busyLabel="Checking"
              onClick={() => void checkReplies()}
            >
              <RefreshCw size={18} aria-hidden="true" />
              Check for replies
            </Button>
          )}
          {checkedAt && (
            <p className={s.checked}>
              Checked <time dateTime={checkedAt}>{w.stamp(checkedAt)}</time>
            </p>
          )}
          {outbox && waiting && (
            <Note>Replies come through the links in each email. In this demo, answer as them from the outbox.</Note>
          )}
          {errorFor("summary")}
          <Button
            variant="quiet"
            onClick={() => {
              setReceipt(null);
              go(0, "back");
            }}
          >
            Start again from {commitments[0].startsAt ? w.weekday(commitments[0].startsAt) : "the first one"}
          </Button>
        </div>
        <div className={s.help}>
          <HelpNearby address={session.careRecipient?.address ?? null} />
        </div>
      </div>
    );
  }

  const remaining = onSummary ? 0 : total - 1 - index;
  return (
    <>
      {letter}
      <Column key={current ? current.id : "summary"} before={progress} remaining={remaining} motion={moved ? motion : null}>
        {!onSummary && listProblem}
        {current ? stepView(current, statuses[index], index) : summaryView()}
      </Column>
    </>
  );
}
