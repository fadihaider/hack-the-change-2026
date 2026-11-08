"use client";
// the one explicit confirm step for a response link; the GET page never records anything (docs/INTEGRATIONS.md)
import { useState, type CSSProperties, type FormEvent } from "react";

type Choice = "accept" | "decline" | "propose";

const NOTE_MAX = 300;

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

const BUTTON_LABELS: Record<Choice, string> = {
  accept: "Confirm: Accept",
  decline: "Confirm: Decline",
  propose: "Send the proposed time",
};

const button: CSSProperties = {
  background: "var(--ink, #1c1917)",
  color: "var(--white, #fff)",
  borderRadius: 999,
  padding: "12px 22px",
  fontWeight: 700,
};

const field: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid var(--line, #e9e3db)",
  background: "var(--white, #fff)",
};

function errorMessage(status: number, code: string): string {
  if (status === 404) return "This link is invalid or has expired.";
  if (status === 429) return "Too many attempts from this network. Please wait a few minutes and try again.";
  if (status === 400) return code === "invalid_response" || code === "invalid_input"
    ? "Please check the date and time, and keep the note to 300 characters."
    : "This response could not be read.";
  if (status === 403) return "This page must be opened from the link in the email.";
  if (status === 409) return "This request changed while you were answering. Reload the page to see its recorded state.";
  return "The response could not be recorded. Nothing was saved; please try again.";
}

export default function ResponseForm({ token, choice }: { token: string; choice: Choice }) {
  const [at, setAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ state: string; recorded: boolean } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
      setError("The network failed before an answer was recorded. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const label = STATE_LABELS[done.state] ?? done.state;
    return (
      <p role="status" style={{ fontWeight: 600 }}>
        {done.recorded
          ? `Thank you. Your answer was recorded: ${label}.`
          : (CLOSED_MESSAGES[done.state] ?? `This request already has a recorded answer: ${label}.`)}
      </p>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
      {choice === "propose" && (
        <>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Proposed date and time (Alberta Time)</span>
            <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} style={field} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Optional note ({NOTE_MAX - [...note].length} characters left)</span>
            <textarea
              value={note}
              maxLength={NOTE_MAX}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              style={field}
            />
          </label>
        </>
      )}
      <div>
        <button type="submit" disabled={busy} style={button}>
          {busy ? "Recording..." : BUTTON_LABELS[choice]}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--clay, #9a442d)" }}>
          {error}
        </p>
      )}
    </form>
  );
}
