"use client";
// recover: what is left before things are back to normal. one question, then the recorded messages in the PRD 13
// groups (needs follow-up, not sent, new, waiting, handled), each with its evidence and a link back to urgent.
// help nearby sits at the bottom.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CalendarClock, RefreshCw, Send } from "lucide-react";
import { formatAlberta, liveErrorMessage, type RecoverView } from "@/lib/frontend/live-api.ts";
import { RequestApiError, type RequestView } from "@/lib/frontend/request-api.ts";
import { HelpNearby } from "../guide/HelpNearby.tsx";
import { recipientName, useApis, useSession } from "../session.tsx";
import {
  Actions,
  Avatar,
  Button,
  ButtonLink,
  Column,
  ErrorNote,
  Note,
  Question,
  Receipt,
  STATE_LABEL,
  StatePill,
  dayLabel,
  useAnnounce,
} from "../ui.tsx";
import {
  evidenceLine,
  namesOf,
  pillLabel,
  possessive,
  sentence,
  signature,
  sortGroups,
  statusLine,
  summaryLine,
  urgentHref,
  type MailMode,
  type NewTime,
} from "./lines.ts";
import s from "./recover.module.css";

type Busy = { id: string; kind: "send" | "cancel" } | null;
type Done = { tone: "good"; text: string; icon: "send" | "check" } | { tone: "bad"; text: string } | null;

export function RecoverScreen() {
  const { session, loading: sessionLoading, error: sessionError, reload: reloadSession } = useSession();
  const { live, requests } = useApis();
  const announce = useAnnounce();
  const [data, setData] = useState<RecoverView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [done, setDone] = useState<Done>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seq = useRef(0);

  // POST runs the owner's expiry sweep first, so a passed deadline already shows as "No reply in time"
  const load = useCallback(async (): Promise<RecoverView | null> => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const next = await live.recoverRefresh();
      if (mine !== seq.current) return null;
      setData(next);
      setLoadError(null);
      return next;
    } catch (caught) {
      if (mine !== seq.current) return null;
      setLoadError(liveErrorMessage(caught));
      return null;
    }
  }, [live]);

  // a moved demo clock reloads the session; ask again so deadlines and replies match the new time
  const appNow = session?.appNow ?? null;
  useEffect(() => {
    if (appNow === null) return;
    void load();
  }, [appNow, load]);

  function focusHeading() {
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: false }));
  }

  async function check() {
    if (checking) return;
    setChecking(true);
    setChecked(null);
    const before = data ? signature(data.groups) : null;
    const next = await load();
    setChecking(false);
    if (!next) return;
    const expired = next.expiredRequestIds.length;
    let text = "Nothing new since you last looked.";
    if (before !== null && before !== signature(next.groups)) text = "The list now shows the newest replies.";
    if (expired > 0) {
      text = `${expired} ${expired === 1 ? "message" : "messages"} ran out of time for a reply.`;
    }
    setChecked(text);
    announce(text);
  }

  async function send(request: RequestView) {
    if (busy) return;
    const name = request.recipient.name;
    const outbox = session?.mode.mail === "outbox";
    setBusy({ id: request.id, kind: "send" });
    setDone(null);
    setChecked(null);
    try {
      const result = await requests.send(request.id);
      if (result.state === "requested") {
        report({
          tone: "good",
          icon: "send",
          text: outbox
            ? `Placed in the demo outbox for ${name}. Waiting for them to use a reply link.`
            : `Sent by email to ${name}. Waiting for them to use a reply link.`,
        });
      } else if (result.state === "failed") {
        report({
          tone: "bad",
          text: outbox
            ? `The message to ${name} couldn’t be placed in the demo outbox. Choose what to do in Urgent.`
            : `The mail service didn’t confirm the message to ${name}. Check your Sent folder, then choose what to do in Urgent.`,
        });
      } else {
        report({
          tone: "bad",
          text: `The message to ${name} was held back before it went. Open it in Urgent.`,
        });
      }
    } catch (caught) {
      report({ tone: "bad", text: actionMessage(caught) });
    } finally {
      setBusy(null);
      await load();
      focusHeading();
    }
  }

  async function cancel(request: RequestView) {
    if (busy) return;
    const name = request.recipient.name;
    setBusy({ id: request.id, kind: "cancel" });
    setDone(null);
    setChecked(null);
    try {
      await requests.cancel(request.id);
      report({ tone: "good", icon: "check", text: `The message to ${name} won’t be sent.` });
    } catch (caught) {
      report({ tone: "bad", text: actionMessage(caught) });
    } finally {
      setBusy(null);
      setConfirming(null);
      await load();
      focusHeading();
    }
  }

  function report(next: NonNullable<Done>) {
    setDone(next);
    announce(next.text);
  }

  // ---------------------------------------------------------------- before anything can show

  if (!session) {
    if (sessionLoading) {
      return (
        <Column>
          <p className={s.loading} role="status">
            Loading your week
          </p>
        </Column>
      );
    }
    return (
      <Column>
        <Question>Your week didn’t load.</Question>
        <ErrorNote
          message={sessionError ?? "ReliefReady couldn’t reach its server. Check your connection, then try again."}
          onRetry={() => void reloadSession()}
        />
      </Column>
    );
  }

  const name = recipientName(session);
  const episode = session.episode;

  if (!episode) {
    return (
      <Column>
        <Question lead="There’s no care week on file yet.">Start one, then come back here after it?</Question>
        <Actions>
          <ButtonLink href="/" variant="primary">
            Start a care week
          </ButtonLink>
        </Actions>
      </Column>
    );
  }

  if (!data) {
    return (
      <Column>
        {loadError ? (
          <>
            <Question>What’s left didn’t load.</Question>
            <ErrorNote message={loadError} onRetry={() => void load()} />
          </>
        ) : (
          <p className={s.loading} role="status">
            Loading what’s left
          </p>
        )}
      </Column>
    );
  }

  // ---------------------------------------------------------------- the list

  const sorted = sortGroups(data.groups);
  const mail: MailMode = session.mode.mail;
  const outbox = mail === "outbox";
  const total =
    sorted.followUp.length + sorted.notSent.length + sorted.waiting.length + sorted.handled.length + sorted.newTimes.length;

  let weekLine = `${possessive(name)} care week ends ${dayLabel(episode.endsOn)}.`;
  if (session.today < episode.startsOn) weekLine = `${possessive(name)} care week starts ${dayLabel(episode.startsOn)}.`;
  if (session.today > episode.endsOn) weekLine = `${possessive(name)} care week ended ${dayLabel(episode.endsOn)}.`;

  let heading = (
    <Question ref={headingRef} lead={weekLine}>
      What’s left before things are back to normal?
    </Question>
  );
  if (total === 0) {
    heading = (
      <Question ref={headingRef} lead={`Nothing has gone out for ${possessive(name)} care week yet.`}>
        Start with what the week affects?
      </Question>
    );
  } else if (sorted.needsYou.length === 0 && sorted.waiting.length > 0) {
    heading = (
      <Question ref={headingRef} lead="Nothing needs you right now.">
        {sentence(`Waiting for ${namesOf(sorted.waiting)} to reply`)}
      </Question>
    );
  } else if (sorted.needsYou.length === 0) {
    heading = (
      <Question ref={headingRef} lead={weekLine}>
        You’re clear to get back to normal.
      </Question>
    );
  }

  const byRequest = new Map<string, NewTime>();
  for (const time of sorted.newTimes) if (time.requestId) byRequest.set(time.requestId, time);
  const everyone = [...data.groups.handled, ...data.groups.waiting, ...data.groups.needsFollowUp, ...data.groups.notSent];

  return (
    <Column>
      {done?.tone === "good" && (
        <Receipt icon={done.icon === "send" ? <Send size={18} aria-hidden="true" /> : undefined}>{done.text}</Receipt>
      )}
      {heading}
      {total > 0 && <p className={s.summary}>{summaryLine(sorted)}</p>}
      {done?.tone === "bad" && (
        <div className={s.spaced}>
          <ErrorNote message={done.text} />
        </div>
      )}
      {loadError && (
        <div className={s.spaced}>
          <ErrorNote message={loadError} onRetry={() => void load()} />
        </div>
      )}

      {total === 0 && (
        <Actions>
          <ButtonLink href="/urgent" variant="primary">
            Go to Urgent
          </ButtonLink>
          <Note>Messages you send from Urgent show up here with who answered.</Note>
        </Actions>
      )}

      <Group title="Needs follow-up" hint="Each one needs a next step from you." rows={sorted.followUp}>
        {(request) => (
          <RequestRow request={request} mail={mail} newTime={byRequest.get(request.id) ?? null} busy={busy} />
        )}
      </Group>

      <Group title="Not sent" hint="Nothing here has gone out." rows={sorted.notSent}>
        {(request) => (
          <RequestRow
            request={request}
            mail={mail}
            newTime={null}
            busy={busy}
            confirming={confirming === request.id}
            onConfirm={(open) => setConfirming(open ? request.id : null)}
            onSend={() => void send(request)}
            onCancel={() => void cancel(request)}
          />
        )}
      </Group>

      {sorted.newTimes.length > 0 && (
        <section className={s.group} aria-labelledby="rr-recover-new" aria-describedby="rr-recover-new-hint">
          <h2 id="rr-recover-new" className={s.groupTitle}>
            New
          </h2>
          <p id="rr-recover-new-hint" className={s.groupHint}>
            Times people asked for on their reply links.
          </p>
          <ul className={s.list} role="list">
            {sorted.newTimes.map((time) => (
              <NewTimeRow key={time.id} time={time} from={everyone.find((r) => r.id === time.requestId) ?? null} />
            ))}
          </ul>
        </section>
      )}

      <Group
        title="Waiting"
        hint={outbox ? "In the demo outbox, waiting for a reply link." : "Sent by email, waiting for a reply link."}
        rows={sorted.waiting}
      >
        {(request) => <RequestRow request={request} mail={mail} newTime={null} busy={busy} />}
      </Group>
      <Group title="Handled" hint="They said yes. That isn’t the same as done." rows={sorted.handled}>
        {(request) => <RequestRow request={request} mail={mail} newTime={null} busy={busy} />}
      </Group>

      {total > 0 && (
        <div className={s.foot}>
          <Button variant="quiet" busy={checking} busyLabel="Checking for replies" onClick={() => void check()}>
            <RefreshCw size={17} aria-hidden="true" />
            Check for new replies
          </Button>
          {checked && <p className={s.checked}>{checked}</p>}
          <Note>
            {outbox
              ? "Each status comes from a record: a message placed in the demo outbox, a reply link someone used, or a deadline that passed."
              : "Each status comes from a record: an email Gmail accepted, a reply link someone used, or a deadline that passed."}{" "}
            Email replies aren’t read, so only reply links count.
          </Note>
        </div>
      )}

      <div className={s.help}>
        <HelpNearby address={session.careRecipient?.address ?? null} />
      </div>
    </Column>
  );
}

function Group({
  title,
  hint,
  rows,
  children,
}: {
  title: string;
  hint: string;
  rows: RequestView[];
  children: (request: RequestView) => ReactNode;
}) {
  const id = useId();
  if (rows.length === 0) return null;
  return (
    <section className={s.group} aria-labelledby={id} aria-describedby={`${id}-hint`}>
      <h2 id={id} className={s.groupTitle}>
        {title}
      </h2>
      <p id={`${id}-hint`} className={s.groupHint}>
        {hint}
      </p>
      <ul className={s.list} role="list">
        {rows.map((request) => (
          <li key={request.id} className={s.row}>
            {children(request)}
          </li>
        ))}
      </ul>
    </section>
  );
}

type RowProps = {
  request: RequestView;
  mail: MailMode;
  newTime: NewTime | null;
  busy: Busy;
  confirming?: boolean;
  onConfirm?: (open: boolean) => void;
  onSend?: () => void;
  onCancel?: () => void;
};

// states with a next step get a clear link; every other row still links back to urgent quietly
const URGENT_STEP: Partial<Record<RequestView["state"], string>> = {
  draft: "Review and send in Urgent",
  awaiting_approval: "Review and send in Urgent",
  needs_review: "Open it in Urgent",
  sending: "Open it in Urgent",
  rejected: "Choose what to do in Urgent",
  expired: "Choose what to do in Urgent",
  failed: "Choose what to do in Urgent",
};

function RequestRow({ request, mail, newTime, busy, confirming = false, onConfirm, onSend, onCancel }: RowProps) {
  const name = request.recipient.name;
  const askId = useId();
  const askRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const urgent = URGENT_STEP[request.state];
  const canSend = request.state === "approved" && onSend;
  const canCancel = request.state === "awaiting_approval" && onCancel && onConfirm;
  const mine = busy?.id === request.id;

  useEffect(() => {
    if (confirming) askRef.current?.focus();
  }, [confirming]);

  return (
    <>
      <div className={s.rowHead}>
        <Avatar name={name} size="sm" />
        <span className={s.name}>{name}</span>
        <RowPill request={request} />
      </div>
      <p className={s.subject}>{request.subject}</p>
      <p className={s.when}>{statusLine(request, mail)}</p>
      {request.state === "needs_review" && request.proposedNote && (
        <blockquote className={s.quote}>
          <p>“{request.proposedNote}”</p>
        </blockquote>
      )}
      {newTime && (
        <p className={s.when}>
          <CalendarClock size={16} aria-hidden="true" />
          <span>The new time is under New below.</span>
        </p>
      )}
      <OnRecord request={request} mail={mail} />

      {confirming && canCancel ? (
        <div className={s.confirm} role="group" aria-labelledby={askId}>
          <p id={askId} ref={askRef} tabIndex={-1} className={s.confirmAsk}>
            Cancel the message to {name}? It won’t be sent, and this can’t be undone.
          </p>
          <div className={s.rowActions}>
            <Button
              variant="secondary"
              busy={mine && busy?.kind === "cancel"}
              busyLabel="Cancelling"
              onClick={onCancel}
            >
              Yes, don’t send it
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                onConfirm?.(false);
                window.requestAnimationFrame(() => triggerRef.current?.focus());
              }}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className={s.rowActions}>
          {canSend && (
            <Button
              variant="secondary"
              busy={mine && busy?.kind === "send"}
              busyLabel={`Sending to ${name}`}
              onClick={onSend}
            >
              <Send size={17} aria-hidden="true" />
              Send to {name}
            </Button>
          )}
          <ButtonLink href={urgentHref(request.id)} variant={urgent ? "secondary" : "quiet"}>
            {urgent ?? "See it in Urgent"}
          </ButtonLink>
          {canCancel && (
            <Button ref={triggerRef} variant="quiet" onClick={() => onConfirm?.(true)}>
              Don’t send it
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/** the state pill; a message the server held back at send time says so, never "check the reply" */
function RowPill({ request }: { request: RequestView }) {
  const label = pillLabel(request);
  if (label) return <span className={s.heldPill}>{label}</span>;
  return <StatePill state={request.state} />;
}

/** opening a row shows the recorded state and every evidence row behind it, oldest first */
function OnRecord({ request, mail }: { request: RequestView; mail: MailMode }) {
  const events = [...request.evidence].reverse();
  return (
    <details className={s.record}>
      <summary className={s.recordSummary}>What’s on record</summary>
      <p className={s.recordState}>
        Recorded state: {STATE_LABEL[request.state]} <code className={s.recordCode}>{request.state}</code>
      </p>
      {events.length === 0 ? (
        <p className={s.recordState}>No events recorded yet.</p>
      ) : (
        <ol className={s.recordList}>
          {events.map((event) => (
            <li key={event.id} className={s.recordItem}>
              <time dateTime={event.at} className={s.recordTime}>
                {formatAlberta(event.at)}
              </time>
              <span>{evidenceLine(event, request, mail)}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function NewTimeRow({ time, from }: { time: NewTime; from: RequestView | null }) {
  const title = (time.title ?? "").replace(/^Proposed:\s*/i, "").trim() || "A new time";
  const name = from?.recipient.name ?? null;
  return (
    <li className={s.row}>
      <div className={s.rowHead}>
        <span className={s.timeIcon} aria-hidden="true">
          <CalendarClock size={17} />
        </span>
        <span className={s.name}>{title}</span>
      </div>
      <p className={s.when}>
        {time.startsAt ? (
          <time dateTime={time.startsAt}>{formatAlberta(time.startsAt)}</time>
        ) : (
          "No time given yet"
        )}
      </p>
      <p className={s.subject}>{name ? `${name} asked for this time on their reply link.` : "From a reply link."}</p>
      {time.requestId && (
        <div className={s.rowActions}>
          <ButtonLink href={urgentHref(time.requestId)} variant="quiet">
            {name ? `See the message to ${name} in Urgent` : "See the message in Urgent"}
          </ButtonLink>
        </div>
      )}
    </li>
  );
}

/** plain words for a failed send or cancel; the list reloads right after, so it always says where things stand */
function actionMessage(error: unknown): string {
  if (error instanceof RequestApiError) {
    if (error.status === 409) return "This message changed somewhere else. The list now shows where it stands.";
    if (error.status === 404) return "This message isn’t on file anymore. The list is up to date now.";
    if (error.status === 0) return "ReliefReady couldn’t reach its server. Check your connection, then try again.";
  }
  return liveErrorMessage(error);
}
