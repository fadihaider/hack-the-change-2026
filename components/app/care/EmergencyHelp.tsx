"use client";
// Emergency / Help control at the top of Care (PRD 9): 911, 811 and the caregiver's own trusted contacts.
// stub with the agreed props; the emergency work replaces the body.

export type EmergencyHelpProps = {
  /** the care recipient's name, for copy */
  name: string;
  /** "header": the compact button at the top of Care; "inline": the block inside the passport Contacts section */
  placement?: "header" | "inline";
};

export function EmergencyHelp({ name }: EmergencyHelpProps) {
  return (
    <a href="tel:911" aria-label={`Emergency help for ${name}: call 911`}>
      Emergency / Help
    </a>
  );
}
