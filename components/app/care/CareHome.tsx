"use client";
// the care overview: the one question, the next thing to do, then the profile, the day and a place to ask
import type { CareProfileView, LiveEpisode, LiveSession } from "@/lib/frontend/live-api.ts";
import { Actions, Button, Column, Note, Question, Receipt } from "../ui.tsx";
import { AskAboutRosa } from "./AskAboutRosa.tsx";
import { ProfileFacts } from "./ProfileFacts.tsx";
import { RosaDay } from "./RosaDay.tsx";
import { pendingSteps, plural, type ReviewStep } from "./care-data.ts";

type Props = {
  name: string;
  session: LiveSession;
  episode: LiveEpisode;
  profile: CareProfileView;
  /** goes up each time the profile reloads, so the day refreshes after an approval */
  version: number;
  receipt: string | null;
  motion: "forward" | "back" | null;
  arrived: boolean;
  onAdd: () => void;
  onReview: (steps: ReviewStep[]) => void;
  onChanged: () => Promise<unknown>;
};

export function CareHome({
  name,
  session,
  episode,
  profile,
  version,
  receipt,
  motion,
  arrived,
  onAdd,
  onReview,
  onChanged,
}: Props) {
  const pending = pendingSteps(profile.facts);
  const approved = profile.facts.filter((fact) => fact.status === "approved").length;
  const empty = approved === 0 && pending.length === 0;

  return (
    <Column key="home" motion={motion}>
      {receipt && <Receipt>{receipt}</Receipt>}
      <Question lead={empty ? "Nothing is written down yet." : undefined} autoFocusOnMount={arrived}>
        What should anyone helping {name} know?
      </Question>
      <Actions>
        {pending.length > 0 ? (
          <>
            <Button variant="primary" onClick={() => onReview(pending)}>
              Check {plural(pending.length, "thing", "things")} from your notes
            </Button>
            <Note>Helpers only see what you’ve said is right.</Note>
            <Button variant="secondary" onClick={onAdd}>
              Add what you know
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={onAdd}>
              Add what you know
            </Button>
            <Note>A note or a discharge sheet. You check each thing before helpers see it.</Note>
          </>
        )}
      </Actions>

      <ProfileFacts name={name} facts={profile.facts} pending={pending.length} />
      <RosaDay name={name} session={session} episode={episode} version={version} />
      <AskAboutRosa
        name={name}
        facts={profile.facts}
        openQuestions={profile.openQuestions}
        onAdd={onAdd}
        onChanged={onChanged}
      />
    </Column>
  );
}
