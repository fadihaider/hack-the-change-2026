"use client";
// one community up close: its access metric in plain words, counts per kind, its access group, and the places behind
// the numbers with their published category, the model's suggestion when it differs, and a link to the source
import { useMemo, useState, type Ref } from "react";
import type { AccessSnapshot, compareAreas } from "@/lib/care-access/engine.ts";
import { classifierLabels, modelSuggestion } from "@/lib/care-access/home.ts";
import { safeHref } from "@/lib/frontend/live-api.ts";
import { Button, VisuallyHidden } from "../ui.tsx";
import { costText, kindLabel, kindTitle, possessive, type GroupName, type TravelMode } from "./access-data.ts";
import s from "./AccessMap.module.css";

type Row = ReturnType<typeof compareAreas>[number];

type Props = {
  headingRef: Ref<HTMLHeadingElement>;
  snapshot: AccessSnapshot;
  row: Row;
  mode: TravelMode;
  threshold: number;
  categories: string[];
  stepFree: boolean;
  isHome: boolean;
  name: string;
  groups: Map<number, GroupName>;
};

// the first few places show at once; the rest wait behind one quiet button
const PLACES_SHOWN = 8;

export function AccessDetail({ headingRef, snapshot, row, mode, threshold, categories, stepFree, isHome, name, groups }: Props) {
  const [all, setAll] = useState(false);
  const labels = useMemo(() => classifierLabels(snapshot.benchmark.classification), [snapshot]);
  const area = row.area;
  const cluster = snapshot.clusters[row.index];
  const group = cluster === null || cluster < 0 ? null : (groups.get(cluster) ?? null);
  const groupSize = cluster === null ? 0 : snapshot.clusters.filter((value) => value === cluster).length;
  const reach = mode === "driving" ? `${threshold} minutes by car` : `${threshold} km in a straight line`;
  const how = mode === "driving" ? "by car" : "in a straight line";
  const kinds = categories.length === 1 ? "the 1 kind" : `the ${categories.length} kinds`;
  const places = row.resources;
  const shown = all ? places : places.slice(0, PLACES_SHOWN);
  const hidden = places.length - shown.length;
  const firstExtraId = `place-${area.id}-${PLACES_SHOWN}`;

  return (
    <section className={s.detail} aria-labelledby={`detail-${area.id}`}>
      <h2 id={`detail-${area.id}`} ref={headingRef} tabIndex={-1} className={s.detailTitle}>
        {area.name}
      </h2>
      {isHome && <p className={s.tag}>{possessive(name)} community</p>}

      <div className={s.metric}>
        {row.score === null ? (
          <p className={s.metricValue}>Not scored</p>
        ) : (
          <p className={s.metricValue}>
            <span className={s.metricNumber}>{row.score}</span>
            <span className={s.metricOf}>out of 100</span>
          </p>
        )}
        <p className={s.metricText}>
          {row.score === null
            ? `Driving routes from ${area.name} weren’t fully mapped, so there’s no score. That doesn’t mean care is far away. Choose Distance to compare it by straight-line distance.`
            : `Each of ${kinds} you picked counts in full at 5 or more places within ${reach}, and in part below that. The score is the average. It counts listed places; it doesn’t rate care.`}
        </p>
      </div>

      {row.score !== null && (
        <dl className={s.counts}>
          {categories.map((category) => (
            <div key={category} className={s.countRow}>
              <dt>{kindTitle(category)}</dt>
              <dd className={s.num}>{row.counts[category] ?? 0}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className={s.groupNote}>
        <span className={s.groupLead}>Access group: </span>
        {group
          ? `${area.name} is in ${group.phrase}, with ${groupSize} communities. Groups put communities with similar counts together; neither one is better.`
          : "none, because the driving routes weren’t fully mapped."}
      </p>

      {row.score !== null && (
        <>
          <h3 className={s.placesTitle}>
            {places.length === 0
              ? "No places in reach"
              : `${places.length} ${places.length === 1 ? "place" : "places"} in reach`}
          </h3>
          {places.length === 0 ? (
            <p className={s.hint}>
              {stepFree
                ? "Nothing is left once places without confirmed step-free access are taken out."
                : `Nothing you picked is within ${reach}. Try a longer window or more kinds of place.`}
            </p>
          ) : (
            <ul className={s.places} role="list">
              {shown.map(({ resource, cost }, index) => {
                const source = safeHref(resource.sourceUrl);
                const suggestion = modelSuggestion(resource, labels);
                return (
                  <li key={resource.id} className={s.place}>
                    <p id={`place-${area.id}-${index}`} tabIndex={-1} className={s.placeName}>
                      {resource.name}
                    </p>
                    <p className={s.placeMeta}>
                      {kindLabel(resource.category)}, {costText(cost, mode)} {how}
                    </p>
                    <p className={s.placeAddress}>{resource.address}</p>
                    {suggestion && (
                      <p className={s.placeModel}>Model suggestion: {suggestion} (published category kept)</p>
                    )}
                    <p className={s.placeSource}>
                      Source:{" "}
                      {source ? (
                        <a href={source} target="_blank" rel="noopener noreferrer">
                          {resource.source}
                          <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
                        </a>
                      ) : (
                        resource.source
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {hidden > 0 && (
            <div className={s.more}>
              <Button
                variant="quiet"
                onClick={() => {
                  setAll(true);
                  window.requestAnimationFrame(() => document.getElementById(firstExtraId)?.focus());
                }}
              >
                Show {hidden} more
              </Button>
            </div>
          )}
          {places.length > 0 && (
            <p className={s.hint}>
              Opening hours, step-free access and whether each place can see {name} today aren’t known for any of these.
              Call ahead.
            </p>
          )}
        </>
      )}
    </section>
  );
}
