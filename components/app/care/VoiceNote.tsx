"use client";
// voice note panel on Care (PRD 6). stub with the agreed props; the voice integration replaces the body.
import { Button, Note } from "../ui.tsx";

export type VoiceNoteProps = {
  /** the care recipient's name, for copy */
  name: string;
  /** from GET /api/session providers.speech; "off" means no live transcription, so offer typing instead */
  speech: "elevenlabs" | "off";
  /**
   * called with the transcript the caregiver reviewed and confirmed. the parent saves it as a voice source
   * (POST /api/care/sources kind "voice") and opens the review; it returns a message to show here, or null
   */
  onUseTranscript: (text: string) => Promise<string | null>;
  /** switch to the typed-note input */
  onTypeInstead: () => void;
  onClose: () => void;
};

export function VoiceNote({ onTypeInstead, onClose }: VoiceNoteProps) {
  return (
    <div>
      <Note align="start">Voice notes aren’t connected yet. Type the note instead.</Note>
      <Button variant="primary" onClick={onTypeInstead}>
        Type a note
      </Button>
      <Button variant="quiet" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
