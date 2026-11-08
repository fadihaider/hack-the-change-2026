"use client";
// the approved profile: facts grouped by kind, each with where it came from and when
import { useId } from "react";
import { Clock, FileText } from "lucide-react";
import type { CareFactView } from "@/lib/frontend/live-api.ts";
import { approvedGroups, plural, possessive, sourceLine, timeLine } from "./care-data.ts";
import s from "./care.module.css";

type Props = {
  name: string;
  facts: CareFactView[];
  /** how many things from notes are still waiting to be checked */
  pending: number;
};

export function ProfileFacts({ name, facts, pending }: Props) {
  const titleId = useId();
  const groups = approvedGroups(facts);

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        {possessive(name)} profile
      </h2>
      <p className={s.sectionHint}>Only what you’ve said is right, word for word from your notes.</p>

      {groups.length === 0 ? (
        <p className={s.empty}>
          {pending > 0
            ? `Nothing here yet. Check the ${plural(pending, "thing", "things")} from your notes and ${
                pending === 1 ? "it shows" : "they show"
              } up here.`
            : `Nothing here yet. Add a note about ${possessive(name)} routines, or a discharge sheet, and check what it says.`}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.category} className={s.group}>
            <h3 className={s.groupTitle}>{group.title}</h3>
            <ul className={s.factList} role="list">
              {group.facts.map((fact) => {
                const when = timeLine(fact);
                return (
                  <li key={fact.id} className={s.fact}>
                    <p className={s.factText}>{fact.textExact}</p>
                    <ul className={s.factMeta} role="list">
                      {when && (
                        <li>
                          <Clock size={15} aria-hidden="true" />
                          {when}
                        </li>
                      )}
                      <li>
                        <FileText size={15} aria-hidden="true" />
                        {sourceLine(fact)}
                      </li>
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
