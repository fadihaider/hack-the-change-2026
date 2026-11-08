"use client";
// the one explicit confirm step for a response link; the GET page never records anything (docs/INTEGRATIONS.md)
import { useId, useState, type FormEvent } from "react";
import { Clock } from "lucide-react";
import { Actions, Button, ErrorNote, Note, Question, TextArea } from "@/components/app/ui.tsx";
import s from "./respond.module.css";

type Choice = "accept" | "decline" | "propose";

const NOTE_MAX = 300;

// what the person answering sees; these are their words, not the sender's
const STATE_LABELS: Record<string, string> = {
  accepted: "Accepted",
  rejected: "Declined",
  needs_review: "Another time was proposed",
  completed: "Completed",
};

// closed without an answer: these read as a full sentence, not as "a recorded answer"
const CLOSED_MESSAGES: Record<string, string> = {
  expired: "This request expired before an answer was recorded.",
  cancelled: "The sender cancelled this request.",
};

const ASK: Record<Choice, { lead: string; ask: string; button: string }> = {
  accept: {
    lead: "Nothing is recorded until you confirm.",
    ask: "Accept this request?",
    button: "Accept the request",
  },
  decline: {
    lead: "Nothing is recorded until you confirm.",
    ask: "Decline this request?",
    button: "Decline the request",
  },
  propose: {
    lead: "Nothing is recorded until you send it.",
    ask: "Which time would work better?",
    button: "Send this time",
  },
};

function errorMessage(status: number, code: string): string {
  if (status === 404) return "This link is invalid or has expired.";
  if (status === 429) return "Too many tries from this network. Wait a few minutes, then try again.";
  if (status === 400) return code === "invalid_response" || code === "invalid_input"
    ? "Check the date and time, and keep the note to 300 characters."
    : "This answer couldn’t be read. Try again.";
  if (status === 403) return "Open this page from the link in the email, then try again.";
  if (status === 409) return "This request changed while you were answering. Reload the page to see where it stands.";
  return "Your answer wasn’t recorded. Nothing was saved, so try again.";
}

function closedMessage(state: string): string {
  return CLOSED_MESSAGES[state] ?? `This request already has a recorded answer: ${STATE_LABELS[state] ?? state}.`;
}

export default function ResponseForm({
  token,
  choice,
  state,
  subject,
  body: message,
  respondBy,
}: {
  token: string;
  choice: Choice;
  state: string;
  subject: string;
  body: string;
  /** already formatted in Alberta time, or null */
  respondBy: string | null;
}) {
  const [at, setAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ state: string; recorded: boolean } | null>(null);
  const uid = useId();
  const atId = `${uid}-at`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    let body: object = {};
    if (choice === "propose") {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) {
        setError("Pick a date and time.");
        return;
      }
      // the picker has no zone; the request is in Alberta Time (UTC-6 all year)
      body = { proposal: { at: `${at}:00-06:00`, ...(note.trim() ? { note: note.trim() } : {}) } };
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/responses/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as
        | { state?: string; recorded?: boolean; error?: { code?: string } }
        | null;
      if (!response.ok || typeof data?.state !== "string") {
        setError(errorMessage(response.status, data?.error?.code ?? ""));
        return;
      }
      setDone({ state: data.state, recorded: data.recorded === true });
    } catch {
      setError("The connection dropped before your answer was recorded. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const letter = (
    <>
      <article className={s.letter} aria-labelledby={`${uid}-subject`}>
        <p className={s.letterLabel}>A request sent to you</p>
        <h2 id={`${uid}-subject`} className={s.subject}>
          {subject}
        </h2>
        <p className={s.body}>{message}</p>
      </article>
      {respondBy && !done && state === "requested" && (
        <p className={s.due}>
          <Clock size={16} aria-hidden="true" />
          <span>Please answer by {respondBy}, Alberta time.</span>
        </p>
      )}
    </>
  );

  const about = (
    <p className={s.about}>
      ReliefReady helps someone who suddenly has to care for family let people know and rearrange their week. Your
      answer is recorded for the person who sent this request.
    </p>
  );

  if (done) {
    const label = STATE_LABELS[done.state] ?? done.state;
    return (
      <>
        {/* focus moves to the new heading, so a screen reader reads the outcome */}
        {done.recorded ? (
          <Question key="done" lead="Thank you." autoFocusOnMount>
            Your answer was recorded: {label}.
          </Question>
        ) : (
          <Question key="done" autoFocusOnMount>
            {closedMessage(done.state)}
          </Question>
        )}
        <Note align="start">You can close this page now.</Note>
        <div className={s.after}>{letter}</div>
        {about}
      </>
    );
  }

  // already answered, expired or cancelled: say so, and show what it was about
  if (state !== "requested") {
    return (
      <>
        <Question>{closedMessage(state)}</Question>
        {letter}
        {about}
      </>
    );
  }

  const copy = ASK[choice];
  return (
    <>
      <Question lead={copy.lead}>{copy.ask}</Question>
      {letter}
      <form onSubmit={submit} className={s.form}>
        {choice === "propose" && (
          <div className={s.fields}>
            <div className={s.field}>
              <label htmlFor={atId} className={s.label}>
                Date and time (Alberta time)
              </label>
              <input
                id={atId}
                type="datetime-local"
                required
                value={at}
                onChange={(e) => setAt(e.target.value)}
                className={s.input}
              />
            </div>
            <TextArea
              label="A note (optional)"
              hint={`${NOTE_MAX - [...note].length} characters left`}
              value={note}
              maxLength={NOTE_MAX}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
        <Actions>
          <Button type="submit" variant="primary" busy={busy} busyLabel="Recording your answer">
            {copy.button}
          </Button>
          <Note>Meant to choose something else? Use the other links in the email.</Note>
        </Actions>
        {error && (
          <div className={s.error}>
            <ErrorNote message={error} />
          </div>
        )}
      </form>
      {about}
    </>
  );
}
