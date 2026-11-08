"use client";
// checking suggestions one at a time: approve, edit and approve, reject, or leave for later.
// when two notes disagree: keep one, or decide later. a summary of what changed comes at the end.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Clock, FileText, LoaderCircle, Tag } from "lucide-react";
import { liveErrorMessage, type CareFactView, type CareSourceDetailView } from "@/lib/frontend/live-api.ts";
import { isLockedWording } from "@/lib/care/lockedWording.ts";
import { useApis, useSession } from "../session.tsx";
import { Actions, Button, Choices, Column, ErrorNote, Note, Progress, Question, Receipt, TextArea, VisuallyHidden, useAnnounce } from "../ui.tsx";
import { possessive, timeLine, type ReviewStep } from "./care-data.ts";
import {
  consequenceLine,
  contextLabel,
  noteLabel,
  quoteOf,
  reviewSourceLine,
  sectionTitle,
  sourceContext,
  stepLabel,
  summarize,
  summaryRows,
  summarySentence,
  wholeSourceLabel,
  type Outcome,
  type ReviewSummary,
} from "./review-data.ts";
import s from "./care.module.css";
import r from "./review.module.css";

export type { ReviewSummary } from "./review-data.ts";

type Props = {
  name: string;
  /** fixed when checking starts, so the count does not move under alex */
  steps: ReviewStep[];
  /** the latest profile facts */
  facts: CareFactView[];
  /** what just happened, shown above the first question */
  intro: string | null;
  /** model notes for conflict steps, by step key; labelled by the provider that wrote them */
  notes: Record<string, string>;
  onChanged: () => Promise<unknown>;
  onDone: (summary: ReviewSummary) => void;
};

// a short fact sits inside the big question; a long one gets its own quote under it
const INLINE_MAX = 150;
// the server keeps exact text up to this length
const EDIT_MAX = 1000;

type Busy = "approve" | "edit" | "reject" | { keep: string } | null;
// a source that failed to load is not retried in this check
type SourceState = CareSourceDetailView | "failed" | "loading";

export function ReviewSteps({ name, steps, facts, intro, notes, onChanged, onDone }: Props) {
  const { live } = useApis();
  const { session } = useSession();
  const announce = useAnnounce();
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back" | null>("forward");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [receipt, setReceipt] = useState<string | null>(intro);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // the wording being edited for the fact step on screen, or null when not editing
  const [draft, setDraft] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const editButton = useRef<HTMLButtonElement | null>(null);
  const editField = useRef<HTMLTextAreaElement | null>(null);
  const editing = draft !== null;
  const wasEditing = useRef(false);

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const atSummary = steps.length > 0 && index >= steps.length;
  const step = atSummary ? undefined : steps[index];
  const last = index >= steps.length - 1;
  const working = busy !== null;

  // the source behind the suggestion on screen, for its sentence in context
  const sourceId = step?.kind === "fact" ? (byId.get(step.factId)?.sourceId ?? null) : null;
  useEffect(() => {
    if (!sourceId || sources[sourceId]) return;
    setSources((all) => ({ ...all, [sourceId]: "loading" }));
    live
      .careSource(sourceId)
      .then((detail) => setSources((all) => ({ ...all, [sourceId]: detail })))
      .catch(() => setSources((all) => ({ ...all, [sourceId]: "failed" })));
  }, [live, sourceId, sources]);

  // opening the editor moves focus into it; closing it returns focus to the button that opened it
  useEffect(() => {
    if (editing) editField.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function go(next: number, dir: "forward" | "back") {
    setError(null);
    setDraft(null);
    wasEditing.current = false;
    setDirection(dir);
    setIndex(next);
  }

  function advance(from: Record<string, Outcome>, said: string | null = null) {
    if (last) {
      const end = summarySentence(summarize(steps, from, facts));
      announce(said ? `${said} ${end}` : end);
    } else if (said) {
      announce(said);
    }
    go(index + 1, "forward");
  }

  function record(key: string, outcome: Outcome, text: string) {
    const next = { ...outcomes, [key]: outcome };
    setOutcomes(next);
    setReceipt(text);
    advance(next, text);
  }

  async function run(kind: Exclude<Busy, null>, work: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(liveErrorMessage(caught));
      void onChanged();
    } finally {
      setBusy(null);
    }
  }

  function approve(key: string, fact: CareFactView) {
    return run("approve", async () => {
      await live.approveFact(fact.id);
      void onChanged();
      const where = timeLine(fact) ? `${possessive(name)} profile and day` : `${possessive(name)} profile`;
      record(key, { kind: "approved" }, `Added to ${where}.`);
    });
  }

  function saveEdit(key: string, fact: CareFactView, value: string) {
    const wording = value.trim();
    if (!wording) {
      setError("Type the wording you want kept, or cancel.");
      editField.current?.focus();
      return;
    }
    // unchanged wording is a plain approval
    if (wording === fact.textExact.trim()) {
      void approve(key, fact);
      return;
    }
    void run("edit", async () => {
      const result = await live.editFact(fact.id, wording);
      void onChanged();
      record(
        key,
        { kind: "edited", factId: result.fact.id, text: result.fact.textExact, original: fact.textExact },
        `Added your wording to ${possessive(name)} profile. The original wording is kept as an earlier version.`,
      );
    });
  }

  function reject(key: string, fact: CareFactView) {
    return run("reject", async () => {
      await live.rejectFact(fact.id);
      void onChanged();
      record(key, { kind: "rejected", text: fact.textExact }, `Rejected. It won’t go on ${possessive(name)} profile.`);
    });
  }

  function keep(stepKey: string, fact: CareFactView) {
    return run({ keep: fact.id }, async () => {
      await live.resolveConflict(fact.id);
      void onChanged();
      const quoted = quoteOf(fact, 70);
      const stop = /[.!?…]$/.test(quoted) ? "" : ".";
      record(stepKey, { kind: "kept", factId: fact.id }, `Kept “${quoted}”${stop} The other is set aside.`);
    });
  }

  function skip(item: ReviewStep) {
    if (busy) return;
    const text =
      item.kind === "conflict"
        ? "Left for later. Neither note is on the profile until you pick one."
        : "Left for later. It stays off the profile until you check it.";
    record(item.key, { kind: "skipped" }, text);
  }

  function finish() {
    onDone(summarize(steps, outcomes, facts));
  }

  if (steps.length === 0) {
    // nothing to check (another tab got there first)
    return (
      <Column key="review-empty" motion={direction}>
        <Question autoFocusOnMount>There’s nothing left to check.</Question>
        <Actions>
          <Button variant="primary" onClick={finish}>
            Back to {possessive(name)} care
          </Button>
        </Actions>
      </Column>
    );
  }

  const labels = steps.map((item) => {
    if (item.kind === "conflict") return "Notes that disagree";
    const fact = byId.get(item.factId);
    return fact ? stepLabel(fact) : "A suggestion";
  });
  const done = steps.map((item) => {
    const outcome = outcomes[item.key];
    return outcome !== undefined && outcome.kind !== "skipped";
  });
  const progress = (
    <Progress
      total={steps.length}
      current={index}
      labels={labels}
      done={done}
      label="Things to check"
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

  if (atSummary || !step) {
    const summary = summarize(steps, outcomes, facts);
    const firstLeft = steps.findIndex((item) => {
      const outcome = outcomes[item.key];
      return outcome === undefined || outcome.kind === "skipped";
    });
    return (
      <Column key="review-summary" motion={direction} before={progress}>
        {receipt && <Receipt>{receipt}</Receipt>}
        <Question lead="That’s everything for now." autoFocusOnMount>
          Here’s what you decided.
        </Question>
        <dl className={r.summary}>
          {summaryRows(summary).map((row) => (
            <div key={row.key} className={r.summaryRow}>
              <dt>{row.label}</dt>
              <dd className={r.summaryCount}>{row.count}</dd>
            </div>
          ))}
        </dl>
        <Actions>
          <Button variant="primary" onClick={() => onDone(summary)}>
            Back to {possessive(name)} care
          </Button>
          {summary.skipped > 0 && firstLeft !== -1 && (
            <Button
              variant="secondary"
              onClick={() => {
                setReceipt(null);
                go(firstLeft, "back");
              }}
            >
              Check the ones left for later
            </Button>
          )}
          <Note>Only what you approved is on {possessive(name)} profile. The rest waits for you.</Note>
        </Actions>
      </Column>
    );
  }

  const outcome = outcomes[step.key];
  const nextLabel = last ? "See what changed" : "Next";
  const finishLater = (
    <Button variant="quiet" disabled={working} onClick={finish}>
      Finish later
    </Button>
  );
  const errorNote = error && (
    <div className={s.stepError}>
      <ErrorNote message={error} />
    </div>
  );
  const nextButton = (
    <Actions>
      <Button variant="primary" onClick={() => advance(outcomes)}>
        {nextLabel}
      </Button>
    </Actions>
  );

  let body: ReactNode;
  if (step.kind === "fact") {
    const fact = byId.get(step.factId);
    if (outcome?.kind === "edited") {
      body = (
        <>
          <FactQuestion text={outcome.text} ask="You approved your wording." />
          <p className={r.original}>
            <span className={r.originalLabel}>Original wording, kept as an earlier version: </span>“{outcome.original}”
          </p>
          {nextButton}
        </>
      );
    } else if (outcome?.kind === "rejected") {
      body = (
        <>
          <FactQuestion text={outcome.text} ask={`You rejected this. It stays off ${possessive(name)} profile.`} />
          {nextButton}
        </>
      );
    } else if (outcome?.kind === "approved" && fact) {
      body = (
        <>
          <FactMeta fact={fact} />
          <FactQuestion text={fact.textExact} ask="You said it’s right." />
          {nextButton}
        </>
      );
    } else if (fact && fact.status === "suggested") {
      const consequence = consequenceLine(name, fact);
      const source = fact.sourceId ? sources[fact.sourceId] : undefined;
      // written care instructions stay word for word (PRD 15), so they are never reworded here
      const locked = isLockedWording(fact.category, fact.textExact);
      body = (
        <>
          <FactMeta fact={fact} />
          <FactQuestion text={fact.textExact} ask={editing ? "What should it say?" : "Is that right?"} />
          {source && typeof source !== "string" && <SourceContextView fact={fact} source={source} />}
          {draft !== null ? (
            <form
              className={r.editor}
              onSubmit={(event) => {
                event.preventDefault();
                saveEdit(step.key, fact, draft);
              }}
            >
              <TextArea
                ref={editField}
                label="Your wording"
                hint="It’s saved as a new version and approved. The original wording stays in its history."
                value={draft}
                maxLength={EDIT_MAX}
                rows={3}
                onChange={(event) => setDraft(event.target.value)}
              />
              {errorNote}
              <Actions>
                <Button type="submit" variant="primary" busy={busy === "edit" || busy === "approve"} busyLabel="Saving">
                  Approve this wording
                </Button>
                <Button
                  variant="quiet"
                  disabled={working}
                  onClick={() => {
                    setError(null);
                    setDraft(null);
                  }}
                >
                  Cancel
                </Button>
              </Actions>
            </form>
          ) : (
            <>
              {consequence && (
                <p className={r.consequence}>
                  <CalendarPlus size={16} aria-hidden="true" />
                  <span>{consequence}</span>
                </p>
              )}
              {errorNote}
              <Actions>
                <Button
                  variant="primary"
                  busy={busy === "approve"}
                  busyLabel="Saving"
                  disabled={working && busy !== "approve"}
                  onClick={() => void approve(step.key, fact)}
                >
                  Approve
                </Button>
                <Choices>
                  {!locked && (
                    <Button
                      ref={editButton}
                      variant="secondary"
                      disabled={working}
                      onClick={() => {
                        setError(null);
                        setDraft(fact.textExact);
                      }}
                    >
                      Edit and approve
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    busy={busy === "reject"}
                    busyLabel="Rejecting"
                    disabled={working && busy !== "reject"}
                    onClick={() => void reject(step.key, fact)}
                  >
                    Reject
                  </Button>
                </Choices>
                <Button variant="secondary" disabled={working} onClick={() => skip(step)}>
                  Leave for later
                </Button>
                <Note>
                  {locked
                    ? "Written care instructions stay word for word. Approve or reject them as written."
                    : `Only what you approve goes on ${possessive(name)} profile.`}
                </Note>
                {finishLater}
              </Actions>
            </>
          )}
        </>
      );
    } else {
      body = <Changed fact={fact ?? null} name={name} error={errorNote} next={nextButton} />;
    }
  } else {
    const group = step.factIds.map((id) => byId.get(id)).filter((fact): fact is CareFactView => fact !== undefined);
    const kept = outcome?.kind === "kept" ? byId.get(outcome.factId) : undefined;
    const open = group.length > 0 && group.every((fact) => fact.status === "conflicting");
    const note = notes[step.key];
    const label = noteLabel(session?.mode.ai);
    if (kept) {
      body = (
        <>
          <Question lead={group.length > 2 ? "These notes disagreed." : "Two notes disagreed."} autoFocusOnMount>
            You kept this one.
          </Question>
          <blockquote className={s.quote}>
            <p>{kept.textExact}</p>
            <footer className={s.quoteMeta}>{reviewSourceLine(kept)}</footer>
          </blockquote>
          {nextButton}
        </>
      );
    } else if (open) {
      const keeping = busy !== null && typeof busy === "object" ? busy.keep : null;
      body = (
        <>
          <Question
            lead={
              group.length === 1
                ? "This note disagreed with one that has changed."
                : group.length > 2
                  ? `${group.length} notes disagree.`
                  : "Two notes disagree."
            }
            autoFocusOnMount
          >
            {group.length === 1 ? "Keep it?" : "Which one is right?"}
          </Question>
          {note && label && (
            <p className={s.modelNote}>
              <span className={s.modelNoteLabel}>{label}: </span>
              {note}
            </p>
          )}
          <ul className={s.options} role="list">
            {group.map((fact) => {
              const when = timeLine(fact);
              const mine = keeping === fact.id;
              return (
                <li key={fact.id}>
                  <button
                    type="button"
                    className={s.option}
                    aria-busy={mine || undefined}
                    aria-disabled={working || undefined}
                    onClick={() => void keep(step.key, fact)}
                  >
                    <VisuallyHidden>Keep: </VisuallyHidden>
                    <span className={s.optionText}>“{fact.textExact}”</span>
                    <span className={s.optionMeta}>
                      <span>
                        <FileText size={15} aria-hidden="true" />
                        {reviewSourceLine(fact)}
                      </span>
                      {when && (
                        <span>
                          <Clock size={15} aria-hidden="true" />
                          {when}
                        </span>
                      )}
                    </span>
                    <span className={s.optionKeep} aria-hidden="true">
                      {mine ? (
                        <>
                          <LoaderCircle size={16} className={s.spin} />
                          Keeping it
                        </>
                      ) : (
                        "Keep this one"
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {errorNote}
          <Actions>
            <Note>
              The other {group.length > 2 ? "notes are" : "note is"} set aside, not deleted. Until you pick, neither time is on{" "}
              {possessive(name)} day.
            </Note>
            <Button variant="secondary" disabled={working} onClick={() => skip(step)}>
              Decide later
            </Button>
            {finishLater}
          </Actions>
        </>
      );
    } else {
      body = (
        <>
          <Question lead="These notes were sorted out while you were checking." autoFocusOnMount>
            Nothing to do here.
          </Question>
          {errorNote}
          {nextButton}
        </>
      );
    }
  }

  return (
    <Column key={`step-${index}`} motion={direction} remaining={steps.length - 1 - index} before={progress}>
      {receipt && <Receipt>{receipt}</Receipt>}
      {body}
    </Column>
  );
}

function FactMeta({ fact }: { fact: CareFactView }) {
  return (
    <ul className={s.meta} role="list">
      <li className={s.metaItem}>
        <FileText size={16} aria-hidden="true" />
        <span>{reviewSourceLine(fact)}</span>
      </li>
      <li className={s.metaItem}>
        <Tag size={16} aria-hidden="true" />
        <span>
          <VisuallyHidden>Passport section: </VisuallyHidden>
          {sectionTitle(fact.category)}
        </span>
      </li>
    </ul>
  );
}

function FactQuestion({ text, ask }: { text: string; ask: string }) {
  if (text.length <= INLINE_MAX) {
    return (
      <Question lead={`“${text}”`} autoFocusOnMount>
        {ask}
      </Question>
    );
  }
  return (
    <>
      <Question lead="Your note says this." autoFocusOnMount>
        {ask}
      </Question>
      <blockquote className={s.quote}>
        <p>{text}</p>
      </blockquote>
    </>
  );
}

/** the sentence the suggestion came from, with the quoted part marked; plain text only */
function SourceContextView({ fact, source }: { fact: CareFactView; source: CareSourceDetailView }) {
  const context = sourceContext(source.fullText, fact);
  if (!context) return null;
  return (
    <figure className={r.context}>
      <figcaption className={r.contextLabel}>{contextLabel(source.kind)}</figcaption>
      <p className={r.contextText}>
        {context.cutStart && "… "}
        {context.before}
        <mark className={r.mark}>{context.quote}</mark>
        {context.after}
        {context.cutEnd && " …"}
      </p>
      {(context.cutStart || context.cutEnd) && (
        <details className={r.whole}>
          <summary className={r.wholeToggle}>{wholeSourceLabel(source.kind)}</summary>
          <p className={r.wholeText}>{source.fullText}</p>
        </details>
      )}
    </figure>
  );
}

function Changed({
  fact,
  name,
  error,
  next,
}: {
  fact: CareFactView | null;
  name: string;
  error: ReactNode;
  next: ReactNode;
}) {
  let ask = "It changed while you were checking.";
  if (fact?.status === "approved") ask = `It’s already on ${possessive(name)} profile.`;
  if (fact?.status === "rejected") ask = "It was rejected while you were checking.";
  if (fact?.status === "superseded") ask = "A newer version replaced it while you were checking.";
  if (fact?.status === "conflicting") ask = "It now disagrees with another note. Pick one the next time you check.";
  return (
    <>
      {fact ? (
        <Question lead={`“${quoteOf(fact, INLINE_MAX)}”`} autoFocusOnMount>
          {ask}
        </Question>
      ) : (
        <Question autoFocusOnMount>This one was removed while you were checking.</Question>
      )}
      {error}
      {next}
    </>
  );
}
