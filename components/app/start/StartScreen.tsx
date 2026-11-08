"use client";
// the start: a welcome back when a care week is on file, otherwise straight to the intake question
import { useState } from "react";
import { CalendarDays } from "lucide-react";
import type { LiveSession } from "@/lib/frontend/live-api.ts";
import { recipientName, useSession } from "../session.tsx";
import { Actions, Button, ButtonLink, Column, ErrorNote, Note, Question, dayLabel } from "../ui.tsx";
import { Intake } from "./Intake.tsx";
import s from "./start.module.css";

type View = "welcome" | "intake";

export function StartScreen() {
  const { session, loading, error, reload } = useSession();
  const [view, setView] = useState<View | null>(null);
  const [arrived, setArrived] = useState(false);

  // the first session decides the first screen; later reloads (a new week, the demo clock) do not switch it
  if (view === null && session) setView(session.episode ? "welcome" : "intake");

  if (!session) {
    if (loading) {
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
        <ErrorNote message={error ?? "The live service could not be reached."} onRetry={() => void reload()} />
      </Column>
    );
  }

  const episode = session.episode;
  if (view === "welcome" && episode) {
    return (
      <Welcome
        session={session}
        episode={episode}
        arrived={arrived}
        onNewWeek={() => {
          setArrived(true);
          setView("intake");
        }}
      />
    );
  }

  return (
    <Intake
      current={episode}
      arrived={arrived}
      onBack={
        episode
          ? () => {
              setArrived(true);
              setView("welcome");
            }
          : undefined
      }
    />
  );
}

function Welcome({
  session,
  episode,
  arrived,
  onNewWeek,
}: {
  session: LiveSession;
  episode: NonNullable<LiveSession["episode"]>;
  arrived: boolean;
  onNewWeek: () => void;
}) {
  const name = recipientName(session);
  let lead = `You’re caring for ${name}.`;
  if (session.today < episode.startsOn) lead = `${possessive(name)} care week starts ${dayLabel(episode.startsOn)}.`;
  if (session.today > episode.endsOn) lead = `${possessive(name)} care week ended ${dayLabel(episode.endsOn)}.`;

  return (
    <Column key="welcome" motion={arrived ? "back" : null}>
      <ul className={s.meta}>
        <li className={s.metaItem}>
          <CalendarDays size={16} aria-hidden="true" />
          <span>
            {dayLabel(episode.startsOn)} to {dayLabel(episode.endsOn)}
          </span>
        </li>
      </ul>
      <Question lead={lead} autoFocusOnMount={arrived}>
        Pick up where you left off?
      </Question>
      <Actions>
        <ButtonLink href="/urgent?from=start" variant="primary">
          Continue with this week
        </ButtonLink>
        <Button variant="secondary" onClick={onNewWeek}>
          Start a new care week
        </Button>
        <Note>A new week replaces this one once you check it.</Note>
      </Actions>
    </Column>
  );
}

function possessive(name: string) {
  return name.endsWith("s") ? `${name}’` : `${name}’s`;
}
