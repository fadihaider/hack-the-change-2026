"use client";
// how this works, in plain words: the score, the service-type model and its test results, the access groups and
// what their checks do and don't mean, where the data comes from, and what none of it can tell you
import { useId } from "react";
import type { AccessSnapshot } from "@/lib/care-access/engine.ts";
import { safeHref } from "@/lib/frontend/live-api.ts";
import { classifierLabels } from "@/lib/care-access/home.ts";
import { VisuallyHidden } from "../ui.tsx";
import { CATEGORIES, fetchedOn, joinWords, kindWord, type SnapshotExtras } from "./access-data.ts";
import s from "./AccessMap.module.css";

// landing pages for the raw downloads the snapshot lists
const SOURCE_PAGES: Record<string, { name: string; page: string }> = {
  odhf: {
    name: "Statistics Canada, Open Database of Healthcare Facilities",
    page: "https://www150.statcan.gc.ca/n1/pub/13-26-0001/132600012020001-eng.htm",
  },
  services: { name: "City of Calgary, Community Services", page: "https://data.calgary.ca/d/x34e-bcjz" },
  communities: { name: "City of Calgary, Community Boundaries", page: "https://data.calgary.ca/d/surr-xmvs" },
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ExternalText({ href, children }: { href: string | null; children: string }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
    </a>
  );
}

export function HowThisWorks({ snapshot }: { snapshot: AccessSnapshot }) {
  const uid = useId();
  const titleId = `${uid}-how`;
  const classification = snapshot.benchmark.classification;
  const clustering = snapshot.benchmark.clustering;
  const extras = snapshot.benchmark as unknown as SnapshotExtras;
  const provenance = snapshot.provenance as AccessSnapshot["provenance"] & { licences?: unknown; routingProfile?: unknown };
  const selected = classification.results.find((result) => result.model === classification.selected_model) ?? null;
  const results = [...classification.results].sort((a, b) => b.heldout_macro_f1 - a.heldout_macro_f1);
  const tested = typeof extras.classification.test_rows === "number" ? extras.classification.test_rows : null;
  const grouped = typeof extras.clustering.areas === "number" ? extras.clustering.areas : null;
  const licences = Array.isArray(provenance.licences)
    ? provenance.licences.filter((item): item is string => typeof item === "string")
    : [];
  const fetched = fetchedOn(provenance.fetchedAt);
  const labels = classifierLabels(classification);
  const untrained = labels ? CATEGORIES.filter((category) => !labels.has(category)) : [];

  return (
    <section className={s.how} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        How this works
      </h2>

      <div className={s.howGrid}>
        <div className={s.howBlock}>
          <h3 className={s.howTitle}>The score</h3>
          <p>
            The score is a plain count, not a prediction. For each kind of place you pick, a community gets full marks
            for 5 or more within the window you chose, and part marks below that. The score is the average across the
            kinds, from 0 to 100, and every kind counts the same.
          </p>
          <p className={s.formula}>As written in the data: {snapshot.scoreFormula}</p>
        </div>

        <div className={s.howBlock}>
          <h3 className={s.howTitle}>Sorting places by type</h3>
          <p>
            Every place keeps the type its source published. A {classification.selected_model} model also reads only
            the place’s name and suggests a type, shown as “Model suggestion” when it disagrees. It never changes a
            count.
            {untrained.length > 0 &&
              ` It only learned the national list’s types, so it makes no suggestion for ${joinWords(
                untrained.map((category) => kindWord(category, 2)),
              )}.`}
          </p>
          {selected && (
            <p>
              On {tested === null ? "names" : `${tested} facility names`} it hadn’t seen, from a national list, it was
              right {percent(selected.heldout_accuracy)} of the time, with a macro F1 of{" "}
              {selected.heldout_macro_f1.toFixed(3)}. Macro F1 averages how well each type is recognised, so rare types
              count as much as common ones. This isn’t a Calgary-specific test.
            </p>
          )}
          <div className={s.tableWrap}>
            <table className={s.table}>
              <caption className={s.caption}>Models compared on the same held-out names</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Accuracy</th>
                  <th scope="col">Macro F1</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.model} className={result.model === classification.selected_model ? s.chosenRow : undefined}>
                    <th scope="row">
                      {result.model}
                      {result.model === classification.selected_model && <span className={s.chosen}> (used here)</span>}
                    </th>
                    <td className={s.num}>{percent(result.heldout_accuracy)}</td>
                    <td className={s.num}>{result.heldout_macro_f1.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className={s.howBlock}>
          <h3 className={s.howTitle}>Access groups</h3>
          <p>
            A {clustering.selected.algorithm} model sorted the {grouped === null ? "" : `${grouped} `}communities with
            full driving routes into {clustering.selected.clusters} groups, by how many places of each kind are within 20
            minutes (pharmacies) or 30 minutes (everything else) by car. It ran once; the map’s choices don’t change it.
          </p>
          <p>
            Silhouette {clustering.selected.silhouette.toFixed(3)}: how cleanly the groups separate, on a scale from −1
            to 1. Perturbation ARI {clustering.selected.perturbation_ari.toFixed(3)}: whether the same groups come back
            when the counts are nudged by 1%, where 1 means identical.
          </p>
          <p>
            Neither number says the groups are right, because there’s no answer key to check them against. The groups
            have no order: one isn’t better than the other.
          </p>
        </div>

        <div className={s.howBlock}>
          <h3 className={s.howTitle}>Where the data comes from</h3>
          <ul className={s.sourceList} role="list">
            {Object.keys(snapshot.provenance.sources).map((key) => {
              const known = SOURCE_PAGES[key];
              return (
                <li key={key}>
                  <ExternalText href={known?.page ?? snapshot.provenance.sources[key]}>{known?.name ?? key}</ExternalText>
                </li>
              );
            })}
            <li>
              Drive times: <ExternalText href="https://project-osrm.org/">OSRM</ExternalText> on{" "}
              <ExternalText href="https://www.openstreetmap.org/copyright">OpenStreetMap</ExternalText> roads, with no
              live traffic
            </li>
          </ul>
          <p className={s.hint}>
            Fetched {fetched}.{licences.length > 0 ? ` Licences: ${licences.join("; ")}.` : ""}
          </p>
        </div>

        <div className={`${s.howBlock} ${s.howWide}`}>
          <h3 className={s.howTitle}>What this can’t tell you</h3>
          <ul className={s.limits}>
            {snapshot.provenance.limitations.map((text) => (
              <li key={text}>{text.replace(/\.$/, "")}.</li>
            ))}
            <li>It isn’t a measure of medical quality, who is eligible, or whether a place is open or has room today.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
