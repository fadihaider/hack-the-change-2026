"use client";
// how much one message shares: three native radios, the contact group's usual tier marked. a pick only marks the level;
// the letter applies it with its own button, saves it on the server, and the approval covers it, so a change always
// needs a fresh send click
import { useId } from "react";
import { TIER_HINT, TIERS, tierLabel, type Tier } from "./words.ts";
import s from "./urgent.module.css";

type Props = {
  value: Tier;
  /** the contact group's usual tier, when the server sent it */
  groupTier: Tier | undefined;
  /** the care recipient's alias, so "general" can say "my mom" only when that's the word */
  alias: string | null;
  disabled: boolean;
  onChange: (tier: Tier) => void;
};

export function TierPicker({ value, groupTier, alias, disabled, onChange }: Props) {
  const name = useId();
  return (
    <fieldset className={s.tierPick} disabled={disabled}>
      <legend className={s.privacyTitle}>How much to share</legend>
      {TIERS.map((tier) => {
        const id = `${name}-${tier}`;
        return (
          <label key={tier} htmlFor={id} className={s.tierOption}>
            <input
              id={id}
              type="radio"
              name={name}
              value={tier}
              className={s.tierRadio}
              checked={value === tier}
              onChange={() => onChange(tier)}
            />
            <span className={s.tierText}>
              <span className={s.tierName}>{tierLabel(tier, alias)}</span>
              <span className={s.tierHint}>{TIER_HINT[tier]}</span>
              {groupTier === tier && <span className={s.tierUsual}>Usual for this group</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
