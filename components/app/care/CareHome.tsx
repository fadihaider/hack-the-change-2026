"use client";
// the care overview (PRD 4): header with emergency help and quick add, then today, ask, the passport and help nearby.
// on phones the same single column, with "add information" after ask
import { useEffect, useId, useRef } from "react";
import { Plus } from "lucide-react";
import type { CareProfileView, LiveEpisode, LiveSession } from "@/lib/frontend/live-api.ts";
import { NearRosa } from "../access/NearRosa.tsx";
import { Button, Column, Receipt, VisuallyHidden, dayLabel, weekRange } from "../ui.tsx";
import { AskAboutRosa } from "./AskAboutRosa.tsx";
import { CarePassport } from "./CarePassport.tsx";
import { EmergencyHelp } from "./EmergencyHelp.tsx";
import { TellAbout } from "./TellAbout.tsx";
import { TodayCare } from "./TodayCare.tsx";
import { pendingSteps, plural, possessive, type ReviewStep } from "./care-data.ts";
import s from "./care.module.css";

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
  onVoice: () => void;
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
  onVoice,
  onReview,
  onChanged,
}: Props) {
  const pending = pendingSteps(profile.facts);
  const approved = profile.facts.filter((fact) => fact.status === "approved").length;
  // nothing written down yet: one calm way in, no passport or ask over an empty profile (PRD 4.3)
  const empty = approved === 0 && pending.length === 0 && profile.openQuestions.length === 0;

  return (
    <Column key="home" motion={motion} width="wide">
      <CareHeader
        name={name}
        session={session}
        episode={episode}
        arrived={arrived}
        quickAdd={!empty}
        onAdd={onAdd}
        onVoice={onVoice}
      />
      {receipt && <Receipt>{receipt}</Receipt>}

      {empty && <CareEmpty name={name} onVoice={onVoice} onNote={onAdd} />}

      <TodayCare
        name={name}
        session={session}
        episode={episode}
        version={version}
        onVoice={empty ? null : onVoice}
        onNote={empty ? null : onAdd}
      />

      {!empty && (
        <AskAboutRosa
          name={name}
          facts={profile.facts}
          openQuestions={profile.openQuestions}
          onAdd={onAdd}
          onChanged={onChanged}
        />
      )}

      {!empty && <AddInformation name={name} onVoice={onVoice} onNote={onAdd} />}

      {pending.length > 0 && <PendingReview name={name} count={pending.length} onReview={() => onReview(pending)} />}

      {!empty && <CarePassport name={name} profile={profile} onReview={onReview} onChanged={onChanged} onAdd={onAdd} />}

      <NearRosa />
    </Column>
  );
}

type HeaderProps = {
  name: string;
  session: LiveSession;
  episode: LiveEpisode;
  arrived: boolean;
  quickAdd: boolean;
  onAdd: () => void;
  onVoice: () => void;
};

function CareHeader({ name, session, episode, arrived, quickAdd, onAdd, onVoice }: HeaderProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  // back from a sub-flow: focus lands on the page title, like a new step
  useEffect(() => {
    const node = titleRef.current;
    if (!arrived || !node) return;
    const box = node.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) window.scrollTo({ top: 0 });
    node.focus({ preventScroll: true });
    // only on mount: the overview gets a new key each time it is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header className={s.careHeader}>
      <div className={s.careHeading}>
        <h1 ref={titleRef} tabIndex={-1} className={s.careTitle}>
          {possessive(name)} care
        </h1>
        <p className={s.careDates}>
          <span>Care week {weekRange(episode.startsOn, episode.endsOn)}</span>
          <span className={s.careToday}>Today: {dayLabel(session.today)}</span>
        </p>
      </div>
      <div className={s.careHeaderActions}>
        <EmergencyHelp name={name} placement="header" />
        {quickAdd && (
          <div className={s.quickAdd}>
            <QuickAddButtons onVoice={onVoice} onNote={onAdd} />
          </div>
        )}
      </div>
    </header>
  );
}

function QuickAddButtons({ onVoice, onNote }: { onVoice: () => void; onNote: () => void }) {
  return (
    <>
      <Button variant="secondary" className={s.quickButton} onClick={onVoice}>
        <Plus size={18} aria-hidden="true" />
        <VisuallyHidden>Add a </VisuallyHidden>
        Voice note
      </Button>
      <Button variant="secondary" className={s.quickButton} onClick={onNote}>
        <Plus size={18} aria-hidden="true" />
        <VisuallyHidden>Add a </VisuallyHidden>
        Note
      </Button>
    </>
  );
}

/** phones only: the quick add after ask, where the header buttons would be out of reach */
function AddInformation({ name, onVoice, onNote }: { name: string; onVoice: () => void; onNote: () => void }) {
  const titleId = useId();
  return (
    <section className={`${s.section} ${s.addInline}`} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        Add information
      </h2>
      <p className={s.sectionHint}>You check each thing before it joins {possessive(name)} passport.</p>
      <div className={s.quickRow}>
        <QuickAddButtons onVoice={onVoice} onNote={onNote} />
      </div>
    </section>
  );
}

function CareEmpty({ name, onVoice, onNote }: { name: string; onVoice: () => void; onNote: () => void }) {
  const titleId = useId();
  return (
    <section className={`${s.section} ${s.careEmpty}`} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        Nothing is written down yet
      </h2>
      <p className={s.sectionHint}>
        Routines, who to call, where things are kept. Each thing comes back to you to check before anyone helping{" "}
        {name} sees it.
      </p>
      <TellAbout name={name} onVoice={onVoice} onNote={onNote} />
    </section>
  );
}

/** suggestions stay apart from the approved passport until alex checks them (PRD 4.3) */
function PendingReview({ name, count, onReview }: { name: string; count: number; onReview: () => void }) {
  const titleId = useId();
  return (
    <section className={`${s.section} ${s.pending}`} aria-labelledby={titleId}>
      <div className={s.pendingBox}>
        <div>
          <h2 id={titleId} className={s.pendingTitle}>
            {plural(count, "suggestion", "suggestions")} to check
          </h2>
          <p className={s.pendingHint}>Not in {possessive(name)} passport yet. Helpers only see what you’ve said is right.</p>
        </div>
        <Button variant="primary" className={s.pendingButton} onClick={onReview}>
          Review {plural(count, "suggestion", "suggestions")}
        </Button>
      </div>
    </section>
  );
}
