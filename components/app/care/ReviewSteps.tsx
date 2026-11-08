"use client";
// checking notes, one question at a time: is this right? or, when two notes disagree, which one is right?
import { useState, type ReactNode } from "react";
import { Clock, FileText, LoaderCircle, Tag } from "lucide-react";
import { liveErrorMessage, type CareFactView } from "@/lib/frontend/live-api.ts";
import { useApis } from "../session.tsx";
import { Actions, Button, Column, ErrorNote, Note, Progress, Question, Receipt, VisuallyHidden, useAnnounce } from "../ui.tsx";
import { categoryTitle, possessive, shorten, sourceLine, timeLine, type ReviewStep } from "./care-data.ts";
import s from "./care.module.css";

type Outcome = { kind: "approved" } | { kind: "skipped" } | { kind: "kept"; factId: string };

export type ReviewSummary = { approved: number; kept: number; skipped: number };

type Props = {
  name: string;
  /** fixed when checking starts, so the count does not move under alex */
  steps: ReviewStep[];
  /** the latest profile facts */
  facts: CareFactView[];
  /** what just happened, shown above the first question */
  intro: string | null;
  /** labelled model notes for conflict steps, by step key */
  notes: Record<string, string>;
  onChanged: () => Promise<unknown>;
  onDone: (summary: ReviewSummary) => void;
};

// a short fact sits inside the big question; a long one gets its own quote under it
const INLINE_MAX = 150;

export function ReviewSteps({ name, steps, facts, intro, notes, onChanged, onDone }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back" | null>("forward");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [receipt, setReceipt] = useState<string | null>(intro);
  // "approve" while a fact is being saved, or the id of the fact being kept
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const step = steps[index];
  const last = index >= steps.length - 1;

  function summary(from: Record<string, Outcome>): ReviewSummary {
    const list = Object.values(from);
    return {
      approved: list.filter((item) => item.kind === "approved").length,
      kept: list.filter((item) => item.kind === "kept").length,
      skipped: list.filter((item) => item.kind === "skipped").length,
    };
  }

  function go(next: number, dir: "forward" | "back") {
    setError(null);
    setDirection(dir);
    setIndex(next);
  }

  function advance(from: Record<string, Outcome>) {
    if (last) onDone(summary(from));
    else go(index + 1, "forward");
  }

  function record(key: string, outcome: Outcome, text: string) {
    const next = { ...outcomes, [key]: outcome };
    setOutcomes(next);
    setReceipt(text);
    announce(text);
    advance(next);
  }

  async function approve(key: string, fact: CareFactView) {
    if (busy) return;
    setBusy("approve");
    setError(null);
    try {
      await live.approveFact(fact.id);
      void onChanged();
      const where = timeLine(fact) ? `${possessive(name)} profile and day` : `${possessive(name)} profile`;
      record(key, { kind: "approved" }, `Added to ${where}.`);
    } catch (caught) {
      setError(liveErrorMessage(caught));
      void onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function keep(stepKey: string, fact: CareFactView) {
    if (busy) return;
    setBusy(fact.id);
    setError(null);
    try {
      await live.resolveConflict(fact.id);
      void onChanged();
      const quoted = shorten(fact.textExact, 70);
      const stop = /[.!?…]$/.test(quoted) ? "" : ".";
      record(stepKey, { kind: "kept", factId: fact.id }, `Kept “${quoted}”${stop} The other is set aside.`);
    } catch (caught) {
      setError(liveErrorMessage(caught));
      void onChanged();
    } finally {
      setBusy(null);
    }
  }

  function skip(item: ReviewStep) {
    if (busy) return;
    const text =
      item.kind === "conflict"
        ? "Left for later. Neither note is on the profile until you pick one."
        : "Left for later. It stays off the profile until you check it.";
    record(item.key, { kind: "skipped" }, text);
  }

  if (!step) {
    // nothing to check (another tab got there first)
    return (
      <Column key="review-empty" motion={direction}>
        <Question autoFocusOnMount>There’s nothing left to check.</Question>
        <Actions>
          <Button variant="primary" onClick={() => onDone(summary(outcomes))}>
            Back to {possessive(name)} care
          </Button>
        </Actions>
      </Column>
    );
  }

  const labels = steps.map((item) => {
    if (item.kind === "conflict") return "Notes that disagree";
    const fact = byId.get(item.factId);
    return fact ? shorten(fact.textExact, 60) : "A note";
  });
  const done = steps.map((item) => {
    const outcome = outcomes[item.key];
    return outcome !== undefined && outcome.kind !== "skipped";
  });
  const outcome = outcomes[step.key];
  const nextLabel = last ? "Finish checking" : "Next";
  const finishLater = (
    <Button variant="quiet" disabled={busy !== null} onClick={() => onDone(summary(outcomes))}>
      Finish later
    </Button>
  );

  let body: ReactNode;
  if (step.kind === "fact") {
    const fact = byId.get(step.factId);
    if (outcome?.kind === "approved" && fact) {
      body = (
        <>
          <FactMeta fact={fact} />
          <FactQuestion fact={fact} ask="You said it’s right." />
          <Actions>
            <Button variant="primary" onClick={() => advance(outcomes)}>
              {nextLabel}
            </Button>
          </Actions>
        </>
      );
    } else if (fact && fact.status === "suggested") {
      body = (
        <>
          <FactMeta fact={fact} />
          <FactQuestion fact={fact} ask="Is that right?" />
          {error && <div className={s.stepError}><ErrorNote message={error} /></div>}
          <Actions>
            <Button variant="primary" busy={busy === "approve"} busyLabel="Saving" onClick={() => void approve(step.key, fact)}>
              That’s right
            </Button>
            <Note>Only what you say is right goes on {possessive(name)} profile.</Note>
            <Button variant="secondary" disabled={busy !== null} onClick={() => skip(step)}>
              Skip for now
            </Button>
            {finishLater}
          </Actions>
        </>
      );
    } else {
      body = (
        <Changed
          fact={fact ?? null}
          name={name}
          error={error}
          nextLabel={nextLabel}
          onNext={() => advance(outcomes)}
        />
      );
    }
  } else {
    const group = step.factIds.map((id) => byId.get(id)).filter((fact): fact is CareFactView => fact !== undefined);
    const kept = outcome?.kind === "kept" ? byId.get(outcome.factId) : undefined;
    const open = group.length > 0 && group.every((fact) => fact.status === "conflicting");
    const note = notes[step.key];
    if (kept) {
      body = (
        <>
          <Question lead={group.length > 2 ? "These notes disagreed." : "Two notes disagreed."} autoFocusOnMount>
            You kept this one.
          </Question>
          <blockquote className={s.quote}>
            <p>{kept.textExact}</p>
            <footer className={s.quoteMeta}>{sourceLine(kept)}</footer>
          </blockquote>
          <Actions>
            <Button variant="primary" onClick={() => advance(outcomes)}>
              {nextLabel}
            </Button>
          </Actions>
        </>
      );
    } else if (open) {
      body = (
        <>
          <Question
            lead={group.length === 1 ? "This note disagreed with one that has changed." : group.length > 2 ? `${group.length} notes disagree.` : "Two notes disagree."}
            autoFocusOnMount
          >
            {group.length === 1 ? "Keep it?" : "Which one is right?"}
          </Question>
          {note && (
            <p className={s.modelNote}>
              <span className={s.modelNoteLabel}>The AI’s note on why: </span>
              {note}
            </p>
          )}
          <ul className={s.options} role="list">
            {group.map((fact) => {
              const when = timeLine(fact);
              const working = busy === fact.id;
              return (
                <li key={fact.id}>
                  <button
                    type="button"
                    className={s.option}
                    aria-busy={working || undefined}
                    aria-disabled={busy !== null || undefined}
                    onClick={() => void keep(step.key, fact)}
                  >
                    <VisuallyHidden>Keep: </VisuallyHidden>
                    <span className={s.optionText}>{fact.textExact}</span>
                    <span className={s.optionMeta}>
                      <span>
                        <FileText size={15} aria-hidden="true" />
                        {sourceLine(fact)}
                      </span>
                      {when && (
                        <span>
                          <Clock size={15} aria-hidden="true" />
                          {when}
                        </span>
                      )}
                    </span>
                    <span className={s.optionKeep} aria-hidden="true">
                      {working ? (
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
          {error && <div className={s.stepError}><ErrorNote message={error} /></div>}
          <Actions>
            <Note>The other {group.length > 2 ? "notes are" : "note is"} set aside, not deleted.</Note>
            <Button variant="secondary" disabled={busy !== null} onClick={() => skip(step)}>
              Skip for now
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
          {error && <div className={s.stepError}><ErrorNote message={error} /></div>}
          <Actions>
            <Button variant="primary" onClick={() => advance(outcomes)}>
              {nextLabel}
            </Button>
          </Actions>
        </>
      );
    }
  }

  return (
    <Column
      key={`step-${index}`}
      motion={direction}
      remaining={steps.length - 1 - index}
      before={
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
      }
    >
      {receipt && <Receipt>{receipt}</Receipt>}
      {body}
    </Column>
  );
}

function FactMeta({ fact }: { fact: CareFactView }) {
  const when = timeLine(fact);
  return (
    <ul className={s.meta} role="list">
      <li className={s.metaItem}>
        <FileText size={16} aria-hidden="true" />
        <span>{sourceLine(fact)}</span>
      </li>
      <li className={s.metaItem}>
        <Tag size={16} aria-hidden="true" />
        <span>{categoryTitle(fact.category)}</span>
      </li>
      {when && (
        <li className={s.metaItem}>
          <Clock size={16} aria-hidden="true" />
          <span>{when}</span>
        </li>
      )}
    </ul>
  );
}

function FactQuestion({ fact, ask }: { fact: CareFactView; ask: string }) {
  if (fact.textExact.length <= INLINE_MAX) {
    return (
      <Question lead={`“${fact.textExact}”`} autoFocusOnMount>
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
        <p>{fact.textExact}</p>
      </blockquote>
    </>
  );
}

function Changed({
  fact,
  name,
  error,
  nextLabel,
  onNext,
}: {
  fact: CareFactView | null;
  name: string;
  error: string | null;
  nextLabel: string;
  onNext: () => void;
}) {
  let ask = "It changed while you were checking.";
  if (fact?.status === "approved") ask = `It’s already on ${possessive(name)} profile.`;
  if (fact?.status === "conflicting") ask = "It now disagrees with another note. Pick one the next time you check.";
  return (
    <>
      {fact ? (
        <Question lead={`“${shorten(fact.textExact, INLINE_MAX)}”`} autoFocusOnMount>
          {ask}
        </Question>
      ) : (
        <Question autoFocusOnMount>This one was removed while you were checking.</Question>
      )}
      {error && <div className={s.stepError}><ErrorNote message={error} /></div>}
      <Actions>
        <Button variant="primary" onClick={onNext}>
          {nextLabel}
        </Button>
      </Actions>
    </>
  );
}
