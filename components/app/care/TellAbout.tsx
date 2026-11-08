"use client";
// the one way in when nothing is written down yet: tell reliefready about the person, by voice or by typing
import { Mic, PenLine } from "lucide-react";
import { Button } from "../ui.tsx";
import s from "./care.module.css";

type Props = {
  name: string;
  onVoice: () => void;
  onNote: () => void;
};

export function TellAbout({ name, onVoice, onNote }: Props) {
  return (
    <div className={s.tell} role="group" aria-label={`Tell ReliefReady about ${name}`}>
      <p className={s.tellTitle}>Tell ReliefReady about {name}</p>
      <div className={s.tellChoices}>
        <Button variant="secondary" onClick={onVoice}>
          <Mic size={18} aria-hidden="true" />
          Record a voice note
        </Button>
        <Button variant="secondary" onClick={onNote}>
          <PenLine size={18} aria-hidden="true" />
          Type a note
        </Button>
      </div>
    </div>
  );
}
