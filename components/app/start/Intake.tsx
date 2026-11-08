"use client";
// intake: one big question, Alex's own words, then either the care week or the details still missing
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CalendarDays, HeartPulse, UserRound } from "lucide-react";
import { liveErrorMessage, type IntakeView, type LiveEpisode } from "@/lib/frontend/live-api.ts";
import { useApis, useSession } from "../session.tsx";
import {
  Actions,
  Button,
  ButtonLink,
  Column,
  ErrorNote,
  Note,
  Question,
  Receipt,
  TextArea,
  dayLabel,
  useAnnounce,
  weekRange,
} from "../ui.tsx";
import s from "./start.module.css";

export const EXAMPLE_STATEMENT = "My mom Rosa has hip surgery on Sunday and I’m caring for her until Saturday.";
const MAX_CHARS = 2000;
const SHOW_COUNT_FROM = 1700;
const SLOW_AFTER_MS = 5000;

type Clarify = Extract<IntakeView, { status: "needs_clarification" }>;
type Ready = Extract<IntakeView, { status: "ready" }>;
type Stage =
  | { kind: "write" }
  | { kind: "clarify"; statement: string; questions: string[]; partial: Clarify["partial"]; round: number }
  | { kind: "confirm"; result: Ready };

const FALLBACK_QUESTION = "When does the care start, and when does it end?";

type Props = {
  /** the care week already on file; a new intake replaces it */
  current: LiveEpisode | null;
  /** back to the welcome screen, only when a week is on file */
  onBack?: () => void;
  /** true when this screen replaced another one, so the heading should take focus */
  arrived: boolean;
};

export function Intake({ current, onBack, arrived }: Props) {
  const router = useRouter();
  const { live } = useApis();
  const { reload } = useSession();
  const announce = useAnnounce();
  const [stage, setStage] = useState<Stage>({ kind: "write" });
  const [direction, setDirection] = useState<"forward" | "back" | null>(null);
  const [statement, setStatement] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<"checking" | "opening" | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moved = useRef(arrived);
  // the week on file when this screen opened; saving a new one must not change the copy mid-way
  const [replacing] = useState(current);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    router.prefetch("/urgent?from=intake");
  }, [router]);

  useEffect(() => {
    if (busy !== "checking") {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSlow(true);
      announce("Still reading what you wrote.");
    }, SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [busy, announce]);

  function go(next: Stage, dir: "forward" | "back") {
    moved.current = true;
    setDirection(dir);
    setError(null);
    setStage(next);
  }

  async function check(text: string) {
    if (busy) return;
    const words = text.trim();
    if (!words) {
      setError("Write a sentence about what’s happening, or tap the example.");
      (stage.kind === "clarify" ? answerRef : fieldRef).current?.focus();
      return;
    }
    if (words.length > MAX_CHARS) {
      setError("That’s longer than 2,000 characters. Shorten it, then check again.");
      return;
    }
    setBusy("checking");
    setError(null);
    announce("Checking your week.");
    let opening = false;
    try {
      const { result, episodeId } = await live.intake(words);
      if (result.status === "needs_clarification") {
        const questions = result.clarifyingQuestions.length > 0 ? result.clarifyingQuestions : [FALLBACK_QUESTION];
        setAnswer("");
        const round = stage.kind === "clarify" ? stage.round + 1 : 1;
        go({ kind: "clarify", statement: words, questions, partial: result.partial, round }, "forward");
        announce(questions.length === 1 ? "One more detail is needed." : `${questions.length} more details are needed.`);
        return;
      }
      if (!episodeId) {
        setError("Your dates were understood but the care week wasn’t saved. Check your week again.");
        return;
      }
      setStatement(words);
      await reload();
      const extra = result.clarifyingQuestions ?? [];
      if (extra.length > 0) {
        go({ kind: "confirm", result }, "forward");
        announce(`Care week saved, ${weekRange(result.startDate, result.endDate)}.`);
        return;
      }
      opening = true;
      setBusy("opening");
      announce(`Care week saved, ${weekRange(result.startDate, result.endDate)}. Opening what it affects.`);
      router.push("/urgent?from=intake");
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      if (!opening) setBusy(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.kind === "clarify") {
      if (!answer.trim()) {
        setError("Answer the question above, or edit what you wrote.");
        answerRef.current?.focus();
        return;
      }
      void check(`${stage.statement} ${answer.trim()}`);
      return;
    }
    void check(statement);
  }

  function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function fillExample() {
    setStatement(EXAMPLE_STATEMENT);
    setError(null);
    announce("Example added. Change anything you like, then check your week.");
    window.requestAnimationFrame(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  const replaces = replacing
    ? `This replaces your current week, ${weekRange(replacing.startsOn, replacing.endsOn)}.`
    : null;
  const waitNote = slow ? "Still reading what you wrote. This can take a little while." : null;
  const busyLabel = busy === "opening" ? "Opening your week" : "Checking your week";

  if (stage.kind === "confirm") {
    const { result } = stage;
    return (
      <Column key="confirm" motion={direction}>
        <Receipt>
          Care week saved: {dayLabel(result.startDate)} to {dayLabel(result.endDate)}.
        </Receipt>
        <Question lead="Your week is set." autoFocusOnMount={moved.current}>
          Next, see what it affects.
        </Question>
        <div className={s.worth}>
          <h2 className={s.worthTitle}>Worth thinking about</h2>
          <ul className={s.worthList}>
            {(result.clarifyingQuestions ?? []).map((question, i) => (
              <li key={i}>{question}</li>
            ))}
          </ul>
        </div>
        <Actions>
          <ButtonLink href="/urgent?from=intake" variant="primary">
            See what it affects
          </ButtonLink>
        </Actions>
      </Column>
    );
  }

  if (stage.kind === "clarify") {
    const { partial, questions } = stage;
    const [first, ...rest] = questions;
    const room = Math.max(0, MAX_CHARS - stage.statement.length - 1);
    return (
      <Column key={`clarify-${stage.round}`} motion={direction}>
        <Understood partial={partial} />
        <Question
          lead={questions.length === 1 ? "One more detail." : "A couple more details."}
          autoFocusOnMount={moved.current}
        >
          {first}
        </Question>
        {rest.length > 0 && (
          <ul className={s.moreQuestions}>
            {rest.map((question, i) => (
              <li key={i}>{question}</li>
            ))}
          </ul>
        )}
        <form className={s.form} onSubmit={submit} noValidate>
          <TextArea
            ref={answerRef}
            label="Your answer"
            hint="It’s added to what you already wrote."
            rows={3}
            value={answer}
            maxLength={room}
            readOnly={busy !== null}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={submitOnShortcut}
          />
          {error && <ErrorNote message={error} />}
          <Actions>
            <Button type="submit" variant="primary" busy={busy !== null} busyLabel={busyLabel}>
              Check my week
            </Button>
            {waitNote && <Note>{waitNote}</Note>}
            <Button
              variant="quiet"
              disabled={busy !== null}
              onClick={() => {
                setStatement(stage.statement);
                go({ kind: "write" }, "back");
              }}
            >
              Edit what I wrote
            </Button>
          </Actions>
        </form>
      </Column>
    );
  }

  const length = statement.length;
  return (
    <Column key="write" motion={direction}>
      <Question lead="Your week just changed." autoFocusOnMount={moved.current}>
        What’s happening with your family?
      </Question>
      <form className={s.form} onSubmit={submit} noValidate>
        <TextArea
          ref={fieldRef}
          size="large"
          label="In your own words"
          hint="Who you’re caring for, why, and from when until when."
          rows={4}
          value={statement}
          maxLength={MAX_CHARS}
          readOnly={busy !== null}
          onChange={(event) => setStatement(event.target.value)}
          onKeyDown={submitOnShortcut}
        />
        {length >= SHOW_COUNT_FROM && (
          <p className={s.count}>
            {length.toLocaleString("en-CA")} of {MAX_CHARS.toLocaleString("en-CA")} characters
          </p>
        )}
        {statement.trim() === "" && (
          <button type="button" className={s.example} onClick={fillExample}>
            <span className={s.exampleLabel}>Tap to use an example</span>
            <span className={s.exampleText}>“{EXAMPLE_STATEMENT}”</span>
          </button>
        )}
        {error && <ErrorNote message={error} />}
        <Actions>
          <Button type="submit" variant="primary" busy={busy !== null} busyLabel={busyLabel}>
            Check my week
          </Button>
          <Note>{waitNote ?? replaces ?? "Nothing is sent without your OK."}</Note>
          {onBack && replacing && (
            <Button variant="quiet" disabled={busy !== null} onClick={onBack}>
              Back to this week
            </Button>
          )}
        </Actions>
      </form>
    </Column>
  );
}

/** what the first answer already made clear, in the muted lines above the question */
function Understood({ partial }: { partial: Clarify["partial"] }) {
  const lines: { key: string; icon: typeof UserRound; text: string }[] = [];
  if (partial.recipientAlias) lines.push({ key: "who", icon: UserRound, text: `Caring for ${partial.recipientAlias}` });
  if (partial.reasonText) lines.push({ key: "why", icon: HeartPulse, text: capitalise(partial.reasonText) });
  if (partial.startDate && partial.endDate) {
    lines.push({
      key: "when",
      icon: CalendarDays,
      text: `${dayLabel(partial.startDate)} to ${dayLabel(partial.endDate)}`,
    });
  } else if (partial.startDate) {
    lines.push({ key: "when", icon: CalendarDays, text: `Starts ${dayLabel(partial.startDate)}` });
  } else if (partial.endDate) {
    lines.push({ key: "when", icon: CalendarDays, text: `Until ${dayLabel(partial.endDate)}` });
  }
  if (lines.length === 0) return null;
  return (
    <ul className={s.meta} aria-label="What you wrote so far">
      {lines.map(({ key, icon: Icon, text }) => (
        <li key={key} className={s.metaItem}>
          <Icon size={16} aria-hidden="true" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
