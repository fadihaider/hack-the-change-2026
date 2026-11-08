"use client";
// the letter: read, edit and send one message. nothing goes out without the send button that names the person.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Info, Send, ShieldAlert } from "lucide-react";
import { liveErrorMessage } from "@/lib/frontend/live-api.ts";
import { RequestApiError, type RequestView } from "@/lib/frontend/request-api.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, Sheet, SheetTitle, StatePill, STATE_LABEL, useAnnounce } from "../ui.tsx";
import { TierPicker } from "./TierPicker.tsx";
import { editFlagNote, isProposal, quoted, removeTerms, shortName, tierLabel, type Tier } from "./words.ts";
import s from "./urgent.module.css";

export type SendOutcome = { state: "requested"; messageId: string } | { state: "failed"; errorCode: string };

type Props = {
  /** the server copy of the request on screen; the sheet keeps its own typed copy */
  request: RequestView | null;
  open: boolean;
  title: string;
  /** one short line under the title */
  lead: string;
  /** the drafter's guard flags for this request (other_email, url, html) */
  flags: string[];
  senderEmail: string;
  outbox: boolean;
  onClose: () => void;
  /** every fresh server copy goes back to the screen */
  onUpdate: (request: RequestView) => void;
  /** the send finished: sent, or the mail adapter recorded a failure */
  onSent: (request: RequestView, outcome: SendOutcome) => void;
  /** reads the request again after a stale approval */
  reload: (requestId: string) => Promise<RequestView | null>;
  /** the care recipient's alias ("Mom"), for the tier names */
  careAlias?: string | null;
  /** a rewrite came back with new guard flags for this request */
  onFlags?: (requestId: string, flags: string[]) => void;
};

type Base = { id: string; revision: string; subject: string; body: string };
type Busy = "send" | "anyway" | "remove" | "tier" | null;

const EDITABLE = new Set<RequestView["state"]>(["draft", "awaiting_approval", "needs_review"]);

// typed words not yet saved to the server, kept for this tab so closing the sheet or reloading the page loses nothing
const typed = {
  key: (id: string) => `rr.letter.${id}`,
  get(id: string): Base | null {
    try {
      const raw = window.sessionStorage.getItem(typed.key(id));
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<Base>;
      if (typeof value.revision !== "string" || typeof value.subject !== "string" || typeof value.body !== "string") {
        return null;
      }
      return { id, revision: value.revision, subject: value.subject, body: value.body };
    } catch {
      return null;
    }
  },
  set(value: Base) {
    try {
      window.sessionStorage.setItem(typed.key(value.id), JSON.stringify(value));
    } catch {
      // storage blocked: the words stay only while the page is open
    }
  },
  delete(id: string) {
    try {
      window.sessionStorage.removeItem(typed.key(id));
    } catch {
      // storage blocked: nothing was kept
    }
  },
};

function sendProblem(error: unknown) {
  if (error instanceof RequestApiError && (error.status === 0 || error.status >= 500)) {
    return "The mail service didn’t answer. Try sending again in a moment.";
  }
  return liveErrorMessage(error);
}

/** health words hold the approval back for the minimal and general tiers until Alex removes them or says send anyway */
function blocks(request: RequestView, extra: string[]) {
  if (request.disclosureTier === "detailed" || request.state === "approved" || request.healthOverride) return false;
  return request.healthTermsFound.length > 0 || extra.length > 0;
}

export function LetterSheet({
  request,
  open,
  title,
  lead,
  flags,
  senderEmail,
  outbox,
  onClose,
  onUpdate,
  onSent,
  reload,
  careAlias = null,
  onFlags,
}: Props) {
  const { requests: api } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const [base, setBase] = useState<Base | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // terms the server named when it refused an approval
  const [refused, setRefused] = useState<string[]>([]);
  // a tier Alex picked over typed words; nothing is rewritten or sent until Alex chooses below the picker
  const [askTier, setAskTier] = useState<Tier | null>(null);
  // the tier being written right now, so the picker holds Alex's pick while the new words load
  const [changingTo, setChangingTo] = useState<Tier | null>(null);
  // one action at a time, even when a double click lands before the next render
  const lock = useRef(false);
  const subjectRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const warnRef = useRef<HTMLParagraphElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const privacyRef = useRef<HTMLDivElement>(null);
  const wasBusy = useRef(false);
  const lastBusy = useRef<Busy>(null);

  const dirty = base !== null && (subject !== base.subject || body !== base.body);

  function load(next: RequestView) {
    setBase({ id: next.id, revision: next.revision, subject: next.subject, body: next.body });
    setSubject(next.subject);
    setBody(next.body);
  }

  // a fresh opening starts without the last visit's problem
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setError(null);
      setRefused([]);
      setAskTier(null);
    }
  }

  // follow the server copy: a different request, or a new revision while nothing is typed
  if (open && request) {
    if (!base || base.id !== request.id) {
      const kept = typed.get(request.id);
      setBase({ id: request.id, revision: request.revision, subject: request.subject, body: request.body });
      if (kept && kept.revision === request.revision) {
        setSubject(kept.subject);
        setBody(kept.body);
      } else {
        setSubject(request.subject);
        setBody(request.body);
      }
      setError(null);
      setRefused([]);
      setAskTier(null);
    } else if (base.revision !== request.revision && !dirty) {
      load(request);
    }
  }

  // the fields grow with their text, so the sheet has one scroll
  function fit() {
    for (const el of [subjectRef.current, bodyRef.current]) {
      if (!el) continue;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    }
  }

  useLayoutEffect(() => {
    if (open) fit();
  }, [open, subject, body]);

  useEffect(() => {
    if (!open) return;
    // the dialog is laid out only after it opens
    const frame = window.requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, [open, request?.id]);

  // a new problem scrolls into view inside the sheet; role=alert reads it
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // when the work is done and the button that had focus is gone, focus lands on what to do next
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      lastBusy.current = busy;
      return;
    }
    if (!wasBusy.current || !open) return;
    wasBusy.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    // after a tier change, back to the level now set, so the new words come before the send button
    if (lastBusy.current === "tier") {
      const chosen = privacyRef.current?.querySelector<HTMLInputElement>("input[type='radio']:checked");
      if (chosen) {
        chosen.focus();
        return;
      }
    }
    (warnRef.current ?? sendRef.current)?.focus();
  }, [busy, open]);

  if (!request) {
    return (
      <Sheet open={false} onClose={onClose} labelledBy={titleId}>
        {null}
      </Sheet>
    );
  }

  const current = request;
  const name = shortName(current.recipient.name);
  const editable = EDITABLE.has(current.state);
  const terms = [...new Set([...current.healthTermsFound, ...refused])];
  const blocked = blocks(current, refused);
  // a picked level that differs from the saved one; once the server copy matches it there is nothing left to apply
  const pendingTier = askTier !== null && askTier !== current.disclosureTier ? askTier : null;
  const flagNotes = flags.map((flag) => editFlagNote(flag, name)).filter((note): note is string => Boolean(note));

  async function close() {
    if (busy || lock.current) return;
    onClose();
    if (!dirty || !editable) {
      announce("Closed. Nothing was sent.");
      return;
    }
    const words = { id: current.id, revision: current.revision, subject, body };
    if (!subject.trim() || !body.trim()) {
      typed.set(words);
      announce("Closed. Your changes are kept here. Nothing was sent.");
      return;
    }
    try {
      const saved = await api.edit(current.id, { subject: subject.replace(/\s*\n\s*/g, " "), body });
      typed.delete(current.id);
      onUpdate(saved.request);
      load(saved.request);
      announce("Your changes are saved. Nothing was sent.");
    } catch (caught) {
      typed.set(words);
      announce(`Your changes are kept here but weren’t saved. ${liveErrorMessage(caught)}`);
    }
  }

  async function staleAgain(requestId: string) {
    const fresh = await reload(requestId);
    if (fresh) {
      typed.delete(requestId);
      load(fresh);
    }
    setRefused([]);
    setError("This message changed. Review it again.");
  }

  async function send(override: boolean) {
    if (busy || lock.current) return;
    // the picker shows a level that isn't saved yet; approving now would approve the old one
    if (pendingTier !== null) {
      setError("Finish changing how much it shares, or cancel it, before you send.");
      return;
    }
    if (!subject.trim() || !body.trim()) {
      setError("Add a subject and a message before sending.");
      return;
    }
    lock.current = true;
    setBusy(override ? "anyway" : "send");
    setError(null);
    let working = current;
    let sending = false;
    try {
      // typed changes, a draft or a reply to review go back to the approval queue first
      if (EDITABLE.has(working.state) && (dirty || working.state !== "awaiting_approval")) {
        const edited = await api.edit(working.id, dirty ? { subject: subject.replace(/\s*\n\s*/g, " "), body } : {});
        working = edited.request;
        typed.delete(working.id);
        onUpdate(working);
        load(working);
        setRefused([]);
        if (!override && blocks(working, [])) {
          announce(`The message mentions ${quoted(working.healthTermsFound)}. Choose what to do before it goes.`);
          return;
        }
      }
      if (working.state === "awaiting_approval") {
        // the approval names the exact revision on screen; the client sends it as If-Match
        const approved = await api.approve(working.id, working.revision, override);
        working = approved.request;
        onUpdate(working);
      }
      if (working.state !== "approved") {
        setError(`This message is now “${STATE_LABEL[working.state]}”, so it can’t be sent from here.`);
        return;
      }
      sending = true;
      const result = await api.send(working.id);
      if (result.state === "needs_review") {
        const fresh = await reload(working.id);
        if (fresh) load(fresh);
        setError("Nothing was sent. The message changed after you approved it. Review it again.");
        return;
      }
      onSent(working, result);
    } catch (caught) {
      if (caught instanceof RequestApiError && (caught.status === 412 || caught.status === 428)) {
        await staleAgain(working.id);
      } else if (caught instanceof RequestApiError && caught.status === 409) {
        // changed in another tab or screen (sent, withdrawn, answered): show what it is now
        const fresh = await reload(working.id);
        if (fresh && !EDITABLE.has(fresh.state)) typed.delete(fresh.id);
        if (fresh) load(fresh);
        setError(
          fresh
            ? `This message changed somewhere else. It’s now “${STATE_LABEL[fresh.state]}”.`
            : "This message changed somewhere else. Close this and check your list.",
        );
      } else if (caught instanceof RequestApiError && caught.code === "health_terms") {
        const named = caught.terms.length > 0 ? caught.terms : working.healthTermsFound;
        setRefused(named);
        announce(`The message mentions ${quoted(named)}. Choose what to do before it goes.`);
      } else if (sending) {
        // approved, but the send itself failed before anything went out; the same button tries again
        setError(`It’s approved but didn’t go out. ${sendProblem(caught)}`);
      } else {
        setError(liveErrorMessage(caught));
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function strip() {
    if (busy || lock.current) return;
    const words = terms;
    const nextSubject = removeTerms(subject, words).replace(/\s*\n\s*/g, " ").trim();
    const nextBody = removeTerms(body, words);
    if (!nextSubject || !nextBody.trim()) {
      setError("Removing those words would leave the message empty. Change it by hand instead.");
      return;
    }
    lock.current = true;
    setBusy("remove");
    setError(null);
    try {
      const edited = await api.edit(current.id, { subject: nextSubject, body: nextBody });
      typed.delete(current.id);
      onUpdate(edited.request);
      load(edited.request);
      setRefused([]);
      const left = edited.request.healthTermsFound;
      announce(
        left.length > 0
          ? `Removed ${quoted(words)}. It still mentions ${quoted(left)}.`
          : `Removed ${quoted(words)} from the message.`,
      );
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  /**
   * a different tier for this one message. the message is written again at that level right away, so the words on
   * screen always match the level picked; typed words are never lost, so with typed words Alex chooses first. either
   * way it goes back for a fresh approval, so the send button is needed again
   */
  function pickTier(next: Tier) {
    if (busy || lock.current || !editable) return;
    setError(null);
    if (next === current.disclosureTier) {
      setAskTier(null);
      return;
    }
    if (!dirty) {
      void changeTier(next, !isProposal(current));
      return;
    }
    if (pendingTier === null) {
      announce("You’ve changed the words. Choose whether to write it again or keep your words.");
    }
    setAskTier(next);
  }

  async function changeTier(next: Tier, rewrite: boolean) {
    if (busy || lock.current) return;
    lock.current = true;
    setBusy("tier");
    setAskTier(null);
    setChangingTo(next);
    setError(null);
    const label = tierLabel(next, careAlias);
    let note = "Your words are kept.";
    try {
      let saved: RequestView | null = null;
      if (rewrite) {
        try {
          const redrafted = await api.redraft(current.id, next);
          saved = redrafted.request;
          onFlags?.(saved.id, redrafted.editFlags);
          note = "It was written again at this level.";
        } catch (caught) {
          // a changed or missing request stops here; any other failure keeps Alex's words at the new level
          if (caught instanceof RequestApiError && (caught.status === 409 || caught.status === 404)) throw caught;
          note = "It couldn’t be written again, so your words are kept.";
        }
      }
      if (!saved) {
        const changes = dirty ? { subject: subject.replace(/\s*\n\s*/g, " "), body } : {};
        saved = (await api.edit(current.id, { ...changes, disclosureTier: next })).request;
      }
      typed.delete(saved.id);
      onUpdate(saved);
      load(saved);
      setRefused([]);
      announce(`Now set to “${label}”. ${note} Read the message again before you send.`);
    } catch (caught) {
      if (caught instanceof RequestApiError && caught.status === 409) {
        const fresh = await reload(current.id);
        if (fresh) load(fresh);
        setError("This message changed somewhere else. Review it again.");
      } else {
        setError(liveErrorMessage(caught));
      }
    } finally {
      lock.current = false;
      setChangingTo(null);
      setBusy(null);
    }
  }

  // every keystroke is kept for this tab until it is saved or sent
  function keep(next: { subject?: string; body?: string }) {
    typed.set({
      id: current.id,
      revision: current.revision,
      subject: next.subject ?? subject,
      body: next.body ?? body,
    });
  }

  return (
    <Sheet
      open={open}
      onClose={() => void close()}
      labelledBy={titleId}
      closeLabel={dirty && editable ? "Close and save your changes" : "Close"}
    >
      <div className={s.sheetHead}>
        <StatePill state={current.state} />
        <SheetTitle id={titleId}>{title}</SheetTitle>
      </div>
      <p className={s.sheetLead}>
        {editable ? lead : "You approved these exact words. Send them when you’re ready."}
      </p>

      <div className={s.paper}>
        <div className={s.letterRow}>
          <span className={s.letterLabel}>To</span>
          <div className={s.letterValue}>
            <span className={s.toName}>{current.recipient.name}</span>
            <span className={s.toEmail}>{current.recipient.email}</span>
          </div>
        </div>
        <div className={s.letterRow}>
          <label htmlFor={subjectId} className={s.letterLabel}>
            Subject
          </label>
          <textarea
            id={subjectId}
            ref={subjectRef}
            className={s.subject}
            value={subject}
            rows={1}
            maxLength={300}
            readOnly={!editable}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            onChange={(event) => {
              const next = event.target.value.replace(/\n/g, " ");
              setSubject(next);
              keep({ subject: next });
            }}
          />
        </div>
        <div className={s.bodyBlock}>
          <label htmlFor={bodyId} className={s.letterLabel}>
            Message
          </label>
          <textarea
            id={bodyId}
            ref={bodyRef}
            className={s.body}
            value={body}
            rows={8}
            maxLength={5000}
            readOnly={!editable}
            onChange={(event) => {
              setBody(event.target.value);
              keep({ body: event.target.value });
            }}
          />
        </div>
      </div>

      <div className={s.privacy} ref={privacyRef}>
        <TierPicker
          value={changingTo ?? pendingTier ?? current.disclosureTier}
          groupTier={current.defaultDisclosureTier}
          alias={careAlias}
          disabled={!editable || busy !== null}
          onChange={pickTier}
        />
        {pendingTier && (
          <div className={s.tierAsk} role="group" aria-labelledby={`${titleId}-tier`}>
            <p id={`${titleId}-tier`} className={s.tierAskText}>
              {dirty
                ? `You’ve changed the words. Write it again as “${tierLabel(pendingTier, careAlias)}”, or keep your words?`
                : isProposal(current)
                  ? `Share it as “${tierLabel(pendingTier, careAlias)}”? Your words stay as they are.`
                  : `Share it as “${tierLabel(pendingTier, careAlias)}”? The message is written again at this level.`}
            </p>
            <div className={s.tierAskActions}>
              {dirty ? (
                <>
                  <Button variant="primary" onClick={() => void changeTier(pendingTier, true)}>
                    Write it again
                  </Button>
                  <Button variant="secondary" onClick={() => void changeTier(pendingTier, false)}>
                    Keep my words
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => void changeTier(pendingTier, !isProposal(current))}>
                  Use this level
                </Button>
              )}
              <Button variant="quiet" onClick={() => setAskTier(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <p className={s.tierNote} aria-live="polite">
          {busy === "tier"
            ? `Writing it again as “${tierLabel(changingTo ?? current.disclosureTier, careAlias)}”`
            : editable
              ? "Changing this needs your OK again before it goes."
              : "Shared at this level when you approved it."}
        </p>
      </div>

      {error && (
        <div className={s.space} ref={errorRef}>
          <ErrorNote message={error} />
        </div>
      )}

      {flagNotes.length > 0 && (
        <ul className={s.flags} role="list">
          {flagNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {blocked ? (
        <div className={s.warn} role="group" aria-labelledby={`${titleId}-warn`}>
          <p id={`${titleId}-warn`} ref={warnRef} tabIndex={-1} className={s.warnTitle}>
            <ShieldAlert size={20} aria-hidden="true" />
            <span>This message mentions {quoted(terms)}.</span>
          </p>
          <p className={s.warnText}>Health details stay private unless you choose to share them.</p>
          <div className={s.sendArea}>
            <Button
              variant="primary"
              busy={busy === "remove"}
              busyLabel="Removing them"
              disabled={busy !== null && busy !== "remove"}
              onClick={() => void strip()}
            >
              Remove them
            </Button>
            <Button
              variant="secondary"
              busy={busy === "anyway"}
              busyLabel={`Sending to ${name}`}
              disabled={(busy !== null && busy !== "anyway") || pendingTier !== null}
              onClick={() => void send(true)}
            >
              Send anyway to {name}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {terms.length > 0 && (
            <p className={s.info}>
              <Info size={18} aria-hidden="true" />
              <span>
                {current.disclosureTier === "detailed"
                  ? current.defaultDisclosureTier !== undefined && current.defaultDisclosureTier !== "detailed"
                    ? `It mentions ${quoted(terms)}. You chose to share more detail with ${name}, so it can go as written.`
                    : `It mentions ${quoted(terms)}. ${name}’s group is set to hear more detail, so it can go as written.`
                  : `It mentions ${quoted(terms)}. You chose to send it anyway.`}
              </span>
            </p>
          )}
          <div className={s.sendArea}>
            <Button
              ref={sendRef}
              variant="primary"
              busy={busy === "send"}
              busyLabel={`Sending to ${name}`}
              disabled={(busy !== null && busy !== "send") || pendingTier !== null}
              onClick={() => void send(false)}
            >
              <Send size={18} aria-hidden="true" />
              Send to {name}
            </Button>
            {terms.length > 0 && editable && (
              <Button
                variant="quiet"
                busy={busy === "remove"}
                busyLabel="Removing them"
                disabled={busy !== null && busy !== "remove"}
                onClick={() => void strip()}
              >
                Remove them
              </Button>
            )}
          </div>
        </>
      )}

      <p className={s.sendNote}>
        {outbox
          ? `Goes to the demo outbox from ${senderEmail}.`
          : `Sends by email from ${senderEmail}.`}
      </p>
    </Sheet>
  );
}
