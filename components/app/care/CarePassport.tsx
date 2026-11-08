"use client";
// the care passport (PRD 5): seven collapsed sections of approved facts with provenance.
// stub with the agreed props; the passport work replaces the body.
import type { CareProfileView } from "@/lib/frontend/live-api.ts";
import type { ReviewStep } from "./care-data.ts";

export type CarePassportProps = {
  name: string;
  profile: CareProfileView;
  /** open the one-at-a-time review for these pending steps */
  onReview: (steps: ReviewStep[]) => void;
  /** reload the profile after an edit, reject or conflict resolution */
  onChanged: () => Promise<unknown>;
  /** open the add-a-note flow (used by the empty state and open questions) */
  onAdd: () => void;
};

export function CarePassport({ name }: CarePassportProps) {
  return <section aria-label={`${name}'s care passport`} />;
}
