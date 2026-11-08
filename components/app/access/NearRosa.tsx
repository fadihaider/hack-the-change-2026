"use client";
// near rosa: which care places are within a short drive of her community, from the public calgary access snapshot.
// counts and the closest of each kind, a drive-time choice that asks again, her access group in plain words, sources.
import { useEffect, useId, useRef, useState } from "react";
import { safeHref } from "@/lib/frontend/live-api.ts";
import { recipientName, useSession } from "../session.tsx";
import { Actions, ButtonLink, ErrorNote, VisuallyHidden, useAnnounce } from "../ui.tsx";
import {
  CATEGORIES,
  costText,
  fetchedOn,
  fetchHomeAccess,
  groupNames,
  homeErrorMessage,
  joinWords,
  kindTitle,
  kindWord,
  possessive,
  typicalText,
  windowText,
  type HomeAccess,
  type TravelMode,
} from "./access-data.ts";
import s from "./NearRosa.module.css";

const DRIVE_CHOICES = [10, 20, 30] as const;
const DEFAULT_MINUTES = 20;
// the kinds named in the access-group line; the full profile is on the compare page
const GROUP_KINDS = ["Pharmacy", "Health Centre", "Hospital"];
const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

/** one plain sentence about what is in reach */
function summaryOf(data: HomeAccess): string {
  const mode: TravelMode = data.mode;
  const from = data.matchedBy === "nearest" ? `${data.area.name}, the community closest to the home address` : data.area.name;
  const total = data.resourcesWithin;
  if (total === 0) return `Nothing on this list is within ${windowText(data.threshold, mode)} of ${from}.`;
  const missing = CATEGORIES.filter((category) => (data.counts[category] ?? 0) === 0);
  const places = total === 1 ? "1 place is" : `${total} places are`;
  if (missing.length === 0) return `From ${from}, ${places} in reach, with at least one of each kind below.`;
  return `From ${from}, ${places} in reach, but no ${joinWords(
    missing.map((category) => kindWord(category, 2)),
    "or",
  )}.`;
}

function groupLine(data: HomeAccess): string {
  const area = data.area.name;
  if (data.cluster === null || !data.clusterProfile) {
    return `${area} isn’t in an access group, because its driving routes weren’t fully mapped. That says nothing about how close care is.`;
  }
  const group = groupNames(data.clusterSizes).get(data.cluster);
  const typical = typicalText(data.clusterProfile.typical, GROUP_KINDS);
  const where = group ? `in ${group.phrase}` : "in one of the groups";
  return `${area} is one of ${data.clusterProfile.areas} communities ${where}. On average, a community there has ${typical}. The groups put communities with similar counts together; neither one is better.`;
}

export function NearRosa() {
  const { session } = useSession();
  const announce = useAnnounce();
  const uid = useId();
  const titleId = `${uid}-title`;
  const driveId = `${uid}-drive`;
  const name = recipientName(session);
  const recipient = session?.careRecipient ?? null;
  const recipientKey = recipient ? `${recipient.id}|${recipient.community ?? ""}` : null;

  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [data, setData] = useState<HomeAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const speak = useRef(false);

  useEffect(() => {
    if (!recipientKey) return;
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    fetchHomeAccess(minutes)
      .then((next) => {
        if (mine !== seq.current) return;
        setData(next);
        setError(null);
        if (speak.current) announce(summaryOf(next));
      })
      .catch((caught: unknown) => {
        if (mine !== seq.current) return;
        const message = homeErrorMessage(caught, name);
        setError(message);
        if (speak.current) announce(message);
      })
      .finally(() => {
        if (mine !== seq.current) return;
        setLoading(false);
        speak.current = false;
      });
  }, [recipientKey, minutes, attempt, announce, name]);

  if (!recipient) return null;

  const mode: TravelMode = data?.mode ?? "driving";
  const fallback = data?.mode === "proximity";
  const shownWindow = fallback && data ? windowText(data.threshold, "proximity") : windowText(minutes, "driving");
  const stale = loading && data !== null;
  const short = mode === "driving" ? `${data?.threshold ?? minutes} min` : `${data?.threshold ?? 3} km`;

  function choose(next: number) {
    if (next === minutes) return;
    speak.current = true;
    setMinutes(next);
  }

  const sources = data ? uniqueSources(data) : [];

  return (
    <section className={s.section} aria-labelledby={titleId} aria-busy={loading || undefined}>
      <h2 id={titleId} className={s.title}>
        What’s within {shownWindow} of {possessive(name)} home?
      </h2>

      {!fallback && (
        <div className={s.drive}>
          <span id={driveId} className={s.driveLabel}>
            Drive time
          </span>
          <div className={s.toggles} role="group" aria-labelledby={driveId}>
            {DRIVE_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={s.toggle}
                aria-pressed={minutes === choice}
                onClick={() => choose(choice)}
              >
                {choice} min
              </button>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <div className={s.problem}>
          <ErrorNote
            message={error}
            onRetry={() => {
              speak.current = true;
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      ) : !data ? (
        <p className={s.loading} role="status">
          Finding care places near {name}
        </p>
      ) : (
        <div className={stale ? s.dim : undefined}>
          {fallback && data.fallbackReason && (
            <p className={s.fallback}>
              Driving routes for {data.area.name} weren’t fully mapped, so this counts places within {data.threshold} km
              in a straight line instead. Real trips are longer.
            </p>
          )}
          <p className={s.summary}>{summaryOf(data)}</p>

          <ul className={s.list} role="list">
            {CATEGORIES.map((category) => {
              const count = data.counts[category] ?? 0;
              const closest = data.nearest[category] ?? null;
              const cost = closest ? (closest.minutes ?? closest.km ?? null) : null;
              const how = mode === "driving" ? "by car" : "in a straight line";
              return (
                <li key={category} className={s.item}>
                  <div className={s.itemHead}>
                    <p className={s.kind}>{kindTitle(category)}</p>
                    <p className={s.count}>
                      <strong>{count === 0 ? "None" : count}</strong> within {short}
                    </p>
                  </div>
                  {closest && cost !== null ? (
                    <>
                      <p className={s.closest}>
                        {closest.within ? "Closest: " : "Closest, outside this window: "}
                        <span className={s.placeName}>{closest.name}</span>,{" "}
                        <span className={s.nowrap}>
                          {costText(cost, mode)} {how}
                        </span>
                      </p>
                      <p className={s.address}>{closest.address}</p>
                    </>
                  ) : (
                    <p className={s.address}>
                      No {kindWord(category, 2)} with a known {mode === "driving" ? "drive time" : "distance"}.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <p className={s.group}>
            <span className={s.groupLead}>Access group: </span>
            {groupLine(data)}
          </p>

          <p className={s.quiet}>
            Counted from a central point in {data.area.name}, not {possessive(name)} door,{" "}
            {mode === "driving" ? "by car with no traffic" : "in a straight line"}. Opening hours, step-free access and
            whether a place can see {name} today aren’t known, so call ahead.
          </p>

          <p className={s.sources}>
            Sources:{" "}
            {sources.map((source, index) => (
              <span key={source.name}>
                {index === 0 ? "" : index === sources.length - 1 ? " and " : ", "}
                <SourceLink name={source.name} url={source.url} />
                {source.via ?? ""}
              </span>
            ))}
            . Prepared {fetchedOn(data.fetchedAt)}.
          </p>
        </div>
      )}

      <div className={s.actions}>
        <Actions>
          <ButtonLink href="/care/access" variant="secondary">
            Compare Calgary communities
          </ButtonLink>
        </Actions>
      </div>
    </section>
  );
}

type Source = { name: string; url: string | null; via?: string };

/** the publishers of the places shown, then the routing credit when times are drive times */
function uniqueSources(data: HomeAccess): Source[] {
  const seen = new Map<string, string | null>();
  for (const category of CATEGORIES) {
    const place = data.nearest[category];
    if (place && !seen.has(place.source)) seen.set(place.source, safeHref(place.sourceUrl));
  }
  const list: Source[] = [...seen.entries()].map(([name, url]) => ({ name, url }));
  if (data.mode === "driving") list.push({ name: "OpenStreetMap contributors", url: OSM_COPYRIGHT, via: " via OSRM" });
  return list;
}

function SourceLink({ name, url }: { name: string; url: string | null }) {
  const href = safeHref(url);
  if (!href) return <>{name}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {name}
      <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
    </a>
  );
}
