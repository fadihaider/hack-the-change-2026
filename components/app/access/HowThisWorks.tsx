"use client";
// how this works, in plain words: the score (a count, not machine learning), the service-type prediction from names
// and its test results, the area access groups and what their internal checks do and don't mean, where the data comes
// from, and what none of it can tell you. every number is read from the basemap, never typed in here.
import { useId } from "react";
import { safeHref } from "@/lib/frontend/live-api.ts";
import { classifierLabels } from "@/lib/care-access/home.ts";
import { VisuallyHidden } from "../ui.tsx";
import { CATEGORIES, fetchedOn, joinWords, kindWord, type AccessBasemap } from "./access-data.ts";
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

// two places, as the model reports give them (70.95%)
function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
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

function liveText(configured: boolean | null): string {
  if (configured === false) {
    return "Live prediction for new names isn’t available: it needs the optional model service set in CARE_ACCESS_INFERENCE_URL, and this server doesn’t have one.";
  }
  if (configured === true) {
    return "An optional live model service is set up on this server, but this page doesn’t call it.";
  }
  return "This page doesn’t run the model live.";
}

export function HowThisWorks({ basemap }: { basemap: AccessBasemap }) {
  const uid = useId();
  const titleId = `${uid}-how`;
  const classification = basemap.benchmark.classification;
  const clustering = basemap.benchmark.clustering;
  const provenance = basemap.provenance;
  const selected = classification.results.find((result) => result.model === classification.selected_model) ?? null;
  const results = [...classification.results].sort((a, b) => b.heldout_macro_f1 - a.heldout_macro_f1);
  const tested = classification.test_rows ?? null;
  const grouped = clustering.areas ?? null;
  const licences = provenance.licences ?? [];
  const fetched = fetchedOn(provenance.fetchedAt);
  const labels = classifierLabels(classification);
  const untrained = labels ? CATEGORIES.filter((category) => !labels.has(category)) : [];
  const communities = basemap.areas.length;
  const unscored = basemap.drivingCoverage.filter((value) => value !== 1).length;
  const daviesBouldin = clustering.selected.davies_bouldin;

  return (
    <section className={s.how} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        How this works
      </h2>

      <div className={s.howGrid}>
        <div className={s.howBlock}>
          <h3 className={s.howTitle}>The access score (not machine learning)</h3>
          <p>
            The score is a plain count of how many listed places are within reach, not a prediction. For each kind of
            place you pick, a community gets full marks for 5 or more within the window you chose, and part marks below
            that. The score is the average across the kinds, from 0 to 100, and every kind counts the same. It doesn’t
            rate care.
          </p>
          <p className={s.formula}>As written in the data: {basemap.scoreFormula}</p>
          {unscored > 0 && (
            <p>
              {unscored} of {communities} communities have no driving score, because their driving routes weren’t fully
              mapped. They’re hatched on the map. Distance still compares them in a straight line.
            </p>
          )}
          <p>Transit isn’t scored: there’s no timetable routing, so no transit times are guessed.</p>
        </div>

        <div className={s.howBlock}>
          <h3 className={s.howTitle}>Service-type prediction from place names</h3>
          <p className={s.howSub}>Not a measure of care quality.</p>
          <p>
            Every place keeps the type its source published, and every count uses that published type. A{" "}
            {classification.selected_model} model reads only a place’s name and predicts what type of service it is,
            shown as “Type predicted from the name” when it disagrees. It never changes a count.
            {untrained.length > 0 &&
              ` It only learned the national list’s types, so it makes no prediction for ${joinWords(
                untrained.map((category) => kindWord(category, 2)),
              )}.`}
          </p>
          {selected && (
            <p>
              On {tested === null ? "names" : `${tested} facility names`} it hadn’t seen, from a national list, it
              predicted the right service type {percent(selected.heldout_accuracy)} of the time (held-out accuracy), with
              a macro F1 of {selected.heldout_macro_f1.toFixed(3)}. Macro F1 averages how well each type is recognised,
              so rare types count as much as common ones. This isn’t a Calgary-specific test.
            </p>
          )}
          <p>
            The predictions were made once, when this data was prepared. {liveText(basemap.inference.configured)} So
            this page uses the published types and those saved predictions.
          </p>
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
          <h3 className={s.howTitle}>Area access groups</h3>
          <p>
            A {clustering.selected.algorithm} model with k = {clustering.selected.clusters} sorted the{" "}
            {grouped === null ? "" : `${grouped} `}communities with full driving routes into{" "}
            {clustering.selected.clusters} area access groups, by how many places of each kind are within 20 minutes
            (pharmacies) or 30 minutes (everything else) by car. It ran once; the map’s choices don’t change it. A group
            describes a community’s access pattern, never a person’s health.
          </p>
          <p>These are internal clustering checks, not accuracy:</p>
          <ul className={s.limits}>
            <li>
              Silhouette {clustering.selected.silhouette.toFixed(3)}: how cleanly the groups separate, from −1 to 1,
              where higher is cleaner.
            </li>
            {daviesBouldin !== undefined && (
              <li>
                Davies-Bouldin {daviesBouldin.toFixed(3)}: how much the groups overlap, where lower is cleaner.
              </li>
            )}
            <li>
              Perturbation ARI {clustering.selected.perturbation_ari.toFixed(3)}: whether the same groups come back when
              the scaled counts get a small random nudge (0.01 standard deviations) and the model is fitted again,
              where 1 means identical.
            </li>
          </ul>
          <p>
            None of these says the groups are right, because there’s no answer key to check them against. The groups
            have no order: one isn’t better than the other.
          </p>
        </div>

        <div className={s.howBlock}>
          <h3 className={s.howTitle}>Where the data comes from</h3>
          <ul className={s.sourceList} role="list">
            {Object.keys(provenance.sources).map((key) => {
              const known = SOURCE_PAGES[key];
              return (
                <li key={key}>
                  <ExternalText href={known?.page ?? provenance.sources[key]}>{known?.name ?? key}</ExternalText>
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
            {provenance.limitations.map((text) => (
              <li key={text}>{text.replace(/\.$/, "")}.</li>
            ))}
            {basemap.excludedCategories.map((item) => (
              <li key={item.category}>
                {item.resources} {item.resources === 1 ? "place is" : "places are"} listed as “{item.category}”, which
                isn’t one of the {CATEGORIES.length} kinds above, so no score or list on this page counts them.
              </li>
            ))}
            <li>It isn’t a measure of medical quality, who is eligible, or whether a place is open or has room today.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
