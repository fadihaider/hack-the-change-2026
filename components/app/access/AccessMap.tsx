"use client";
// compare calgary communities: what to measure, a map of every community coloured by the access metric or by the two
// unordered access groups, the chosen community's places, and how it all works. the slim basemap loads once; scores
// and the chosen community's places come from the server per choice. the full snapshot is only a fallback.
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { areaIndexByName, classifierLabels } from "@/lib/care-access/home.ts";
import { safeHref } from "@/lib/frontend/live-api.ts";
import { recipientName, useSession } from "../session.tsx";
import { ErrorNote, Question, VisuallyHidden, useAnnounce } from "../ui.tsx";
import { AccessDetail } from "./AccessDetail.tsx";
import { HowThisWorks } from "./HowThisWorks.tsx";
import {
  CATEGORIES,
  SCORE_STEPS,
  fetchHomeAccess,
  groupFill,
  groupNames,
  kindTitle,
  openAccessSource,
  possessive,
  projectAreas,
  scoreFill,
  type AccessQuery,
  type AccessSource,
  type Place,
  type ScoreRow,
  type TravelMode,
} from "./access-data.ts";
import s from "./AccessMap.module.css";

type View = "access" | "groups";

const MODES: { value: TravelMode | "transit"; label: string }[] = [
  { value: "driving", label: "Driving" },
  { value: "proximity", label: "Distance" },
  { value: "transit", label: "Transit" },
];

const WINDOWS: Record<TravelMode, number[]> = {
  driving: [10, 15, 20, 30, 45],
  proximity: [1, 2, 3, 5, 10],
};

const DEFAULT_WINDOW: Record<TravelMode, number> = { driving: 20, proximity: 3 };

const CREDITS = {
  boundaries: "https://data.calgary.ca/d/surr-xmvs",
  osm: "https://www.openstreetmap.org/copyright",
  odbl: "https://opendatacommons.org/licenses/odbl/",
  osrm: "https://project-osrm.org/",
};

export function AccessMap() {
  const { session } = useSession();
  const announce = useAnnounce();
  const uid = useId();
  const safeId = uid.replace(/[^a-zA-Z0-9_-]/g, "");
  const hatchId = `hatch-${safeId}`;
  const name = recipientName(session);
  const community = session?.careRecipient?.community ?? null;
  const hasRecipient = Boolean(session?.careRecipient);

  const [source, setSource] = useState<AccessSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scores, setScores] = useState<{ key: string; rows: ScoreRow[] } | null>(null);
  const [scoresFailed, setScoresFailed] = useState(false);
  const [scoresAttempt, setScoresAttempt] = useState(0);
  const [places, setPlaces] = useState<{ key: string; list: Place[] } | null>(null);
  const [placesFailed, setPlacesFailed] = useState<string | null>(null);
  const [placesAttempt, setPlacesAttempt] = useState(0);
  const [mode, setMode] = useState<TravelMode>("driving");
  const [threshold, setThreshold] = useState(DEFAULT_WINDOW.driving);
  const [categories, setCategories] = useState<string[]>([...CATEGORIES]);
  const [keepOne, setKeepOne] = useState(false);
  const [stepFree, setStepFree] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("access");
  const [homeId, setHomeId] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const speakAfterChange = useRef(false);

  const basemap = source?.basemap ?? null;
  const query = useMemo<AccessQuery>(
    () => ({ mode, threshold, categories, stepFree }),
    [mode, threshold, categories, stepFree],
  );
  const queryKey = `${mode}|${threshold}|${categories.join(",")}|${stepFree}`;

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    openAccessSource(controller.signal)
      .then(setSource)
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadError("The Calgary map data didn’t load. Check your connection, then try again.");
        }
      });
    return () => controller.abort();
  }, [attempt]);

  // scores for every community under the current choices; an older answer never replaces a newer one
  useEffect(() => {
    if (!source) return;
    let current = true;
    setScoresFailed(false);
    source
      .scores(query)
      .then((rows) => {
        if (current) setScores({ key: queryKey, rows });
      })
      .catch(() => {
        if (current) setScoresFailed(true);
      });
    return () => {
      current = false;
    };
    // queryKey stands for query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, queryKey, scoresAttempt]);

  // rosa's community by name; when the name isn't in the list, the server matches her home point instead
  useEffect(() => {
    if (!basemap) return;
    const byName = areaIndexByName(basemap.areas, community);
    if (byName >= 0) {
      setHomeId(basemap.areas[byName].id);
      return;
    }
    if (!hasRecipient) return;
    let current = true;
    fetchHomeAccess(DEFAULT_WINDOW.driving)
      .then((home) => {
        if (current) setHomeId(home.area.id);
      })
      .catch(() => {
        // no home community: the map still works, with the first routed community chosen
      });
    return () => {
      current = false;
    };
  }, [basemap, community, hasRecipient]);

  const layout = useMemo(() => (basemap ? projectAreas(basemap.areas) : null), [basemap]);
  const rowsById = useMemo(() => new Map((scores?.rows ?? []).map((row) => [row.id, row])), [scores]);
  const areaById = useMemo(() => new Map((basemap?.areas ?? []).map((area) => [area.id, area])), [basemap]);
  const sizes = useMemo(() => basemap?.clusterSizes ?? [], [basemap]);
  const groups = useMemo(() => groupNames(sizes), [sizes]);
  const labels = useMemo(() => (basemap ? classifierLabels(basemap.benchmark.classification) : null), [basemap]);
  const sortedAreas = useMemo(
    () => (basemap ? [...basemap.areas].sort((a, b) => a.name.localeCompare(b.name, "en-CA")) : []),
    [basemap],
  );

  const firstRouted = basemap ? (basemap.areas.find((_, i) => basemap.drivingCoverage[i] === 1)?.id ?? null) : null;
  const shownId = selected ?? homeId ?? firstRouted;
  const shownRow = shownId ? (rowsById.get(shownId) ?? null) : null;
  const shownArea = shownId ? (areaById.get(shownId) ?? null) : null;
  // the map keeps the last answer, dimmed, until the scores for the new choices arrive
  const stale = scores !== null && scores.key !== queryKey;
  const placesKey = shownId ? `${shownId}|${queryKey}` : null;

  // the chosen community's places for the current choices
  useEffect(() => {
    if (!source || !shownId || !placesKey) return;
    let current = true;
    setPlacesFailed(null);
    source
      .places(query, shownId)
      .then((list) => {
        if (current) setPlaces({ key: placesKey, list });
      })
      .catch(() => {
        if (current) setPlacesFailed(placesKey);
      });
    return () => {
      current = false;
    };
    // placesKey stands for shownId and query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, placesKey, placesAttempt]);

  function rowText(id: string): string {
    const row = rowsById.get(id);
    const area = areaById.get(id);
    if (!row || !area) return "";
    const home = id === homeId ? `, ${possessive(name)} community` : "";
    const score = row.score === null ? "not scored, driving routes incomplete" : `access ${row.score} out of 100`;
    return `${area.name}${home}: ${score}, ${row.inReach} ${row.inReach === 1 ? "place" : "places"} in reach.`;
  }

  // after a filter change, read out what it did to the community on screen, once its new scores are in
  useEffect(() => {
    if (!speakAfterChange.current || !shownId || stale) return;
    speakAfterChange.current = false;
    announce(`Map updated. ${rowText(shownId)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scores]);

  function select(id: string) {
    setSelected(id);
    announce(rowText(id));
  }

  function chooseMode(next: TravelMode) {
    if (next === mode) return;
    speakAfterChange.current = true;
    setMode(next);
    setThreshold(DEFAULT_WINDOW[next]);
  }

  function toggleCategory(category: string, on: boolean) {
    if (!on && categories.length === 1 && categories[0] === category) {
      setKeepOne(true);
      announce("Keep at least one kind of place.");
      return;
    }
    setKeepOne(false);
    speakAfterChange.current = true;
    setCategories((old) => (on ? CATEGORIES.filter((item) => item === category || old.includes(item)) : old.filter((item) => item !== category)));
  }

  function onAreaKey(event: KeyboardEvent<SVGPathElement>, id: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(id);
    }
  }

  const homeArea = homeId ? (areaById.get(homeId) ?? null) : null;

  let body;
  if (!basemap || !layout || !scores) {
    body = loadError ? (
      <div className={s.state}>
        <ErrorNote message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    ) : scoresFailed ? (
      <div className={s.state}>
        <ErrorNote
          message="The Calgary access scores didn’t load. Check your connection, then try again."
          onRetry={() => setScoresAttempt((n) => n + 1)}
        />
      </div>
    ) : (
      <p className={s.loading} role="status">
        Loading the Calgary map
      </p>
    );
  } else {
    const byId = new Map(layout.shapes.map((shape) => [shape.id, shape]));
    const homeShape = homeId ? byId.get(homeId) : undefined;
    const shownShape = shownId ? byId.get(shownId) : undefined;
    const focusShape = focused ? byId.get(focused) : undefined;
    const unrouted = basemap.drivingCoverage.filter((value) => value !== 1).length;
    const ungrouped = basemap.clusters.filter((value) => value === null || value < 0).length;
    const unit = mode === "driving" ? "min" : "km";
    const confirmedStepFree = basemap.resources.stepFreeConfirmed;
    const shownCluster = shownRow?.cluster ?? null;
    const groupSize = shownCluster === null ? 0 : (sizes.find((size) => size.cluster === shownCluster)?.areas ?? 0);

    body = (
      <>
        <div className={s.controls}>
          <div className={s.controlCol}>
            <fieldset className={s.field}>
              <legend className={s.legend}>How to measure</legend>
              <div className={s.segments}>
                {MODES.map((item) => (
                  <label key={item.value} className={s.segment}>
                    <input
                      type="radio"
                      className={s.radio}
                      name={`${safeId}-mode`}
                      value={item.value}
                      checked={item.value === mode}
                      disabled={item.value === "transit"}
                      aria-describedby={`${safeId}-mode-hint`}
                      onChange={() => {
                        if (item.value !== "transit") chooseMode(item.value);
                      }}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
              <p id={`${safeId}-mode-hint`} className={s.hint}>
                {mode === "driving"
                  ? "Drive times along roads, with no traffic."
                  : "Straight-line distance. Real trips are longer."}{" "}
                Transit isn’t available: there’s no timetable routing, so no times are guessed.
              </p>
            </fieldset>

            <fieldset className={s.field}>
              <legend className={s.legend}>{mode === "driving" ? "Drive time" : "Distance"}</legend>
              <div className={s.segments}>
                {WINDOWS[mode].map((value) => (
                  <label key={value} className={s.segment}>
                    <input
                      type="radio"
                      className={s.radio}
                      name={`${safeId}-window`}
                      value={value}
                      checked={value === threshold}
                      onChange={() => {
                        speakAfterChange.current = true;
                        setThreshold(value);
                      }}
                    />
                    <span className={s.num}>
                      {value} {unit}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div className={s.controlCol}>
            <fieldset className={s.field}>
              <legend className={s.legend}>Kinds of place</legend>
              <div className={s.checks}>
                {CATEGORIES.map((category) => (
                  <label key={category} className={s.check}>
                    <input
                      type="checkbox"
                      className={s.checkbox}
                      checked={categories.includes(category)}
                      onChange={(event) => toggleCategory(category, event.target.checked)}
                    />
                    <span>{kindTitle(category)}</span>
                  </label>
                ))}
              </div>
              {keepOne && (
                <p className={s.hint} role="status">
                  Keep at least one kind of place, so there’s something to count.
                </p>
              )}
            </fieldset>
          </div>

          <div className={s.controlCol}>
            <div className={s.field}>
              <label className={s.check}>
                <input
                  type="checkbox"
                  className={s.checkbox}
                  checked={stepFree}
                  onChange={(event) => {
                    speakAfterChange.current = true;
                    setStepFree(event.target.checked);
                  }}
                />
                <span>Only places with confirmed step-free access</span>
              </label>
              {stepFree && (
                <p className={s.notice}>
                  {confirmedStepFree === 0
                    ? "None of the source lists confirm step-free access, so every place is left out and the counts drop to zero."
                    : "Places without confirmed step-free access are left out."}{" "}
                  Unknown isn’t the same as not accessible.
                </p>
              )}
            </div>

            <div className={s.field}>
              <label htmlFor={`${safeId}-community`} className={s.legend}>
                Community
              </label>
              <div className={s.selectWrap}>
                <select
                  id={`${safeId}-community`}
                  className={s.select}
                  value={shownId ?? ""}
                  onChange={(event) => select(event.target.value)}
                >
                  {sortedAreas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                      {area.id === homeId ? ` (${possessive(name)})` : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={18} className={s.selectIcon} aria-hidden="true" />
              </div>
            </div>

            <p className={s.hint}>Not a measure of medical quality, eligibility or whether a place is open today.</p>
          </div>
        </div>

        <div className={s.workspace}>
          <section className={s.mapPane} aria-labelledby={`${safeId}-map-title`}>
            <div className={s.mapHead}>
              <h2 id={`${safeId}-map-title`} className={s.sectionTitle}>
                {view === "access" ? "Access across Calgary" : "Access groups across Calgary"}
              </h2>
              <div className={s.viewToggle} role="group" aria-label="Colour the map by">
                <button
                  type="button"
                  className={s.viewButton}
                  aria-pressed={view === "access"}
                  onClick={() => setView("access")}
                >
                  Access
                </button>
                <button
                  type="button"
                  className={s.viewButton}
                  aria-pressed={view === "groups"}
                  onClick={() => setView("groups")}
                >
                  Access groups
                </button>
              </div>
            </div>

            <a
              href={`#${safeId}-detail`}
              className={s.skip}
              onClick={(event) => {
                event.preventDefault();
                detailHeading.current?.focus();
              }}
            >
              Skip the map, go to the details
            </a>

            {scoresFailed && (
              <div className={s.state}>
                <ErrorNote
                  message="The map didn’t update for your latest choices, so it still shows the last ones."
                  onRetry={() => setScoresAttempt((n) => n + 1)}
                />
              </div>
            )}

            <svg
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className={stale ? `${s.map} ${s.stale}` : s.map}
              role="group"
              aria-busy={stale}
              aria-label={`Map of ${basemap.areas.length} Calgary communities. Tab to a community, then press Enter to see its details.`}
            >
              <defs>
                <pattern id={hatchId} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="9" height="9" fill="#eef0f4" />
                  <line x1="0" y1="0" x2="0" y2="9" stroke="#b3b9c5" strokeWidth="3" />
                </pattern>
              </defs>
              {layout.shapes.map((shape, index) => {
                const score = rowsById.get(shape.id)?.score ?? null;
                const area = basemap.areas[index];
                const cluster = basemap.clusters[index];
                const unknown = view === "groups" ? cluster === null || cluster < 0 : score === null;
                const fill = unknown
                  ? `url(#${hatchId})`
                  : view === "groups"
                    ? groupFill(cluster as number)
                    : scoreFill(score as number);
                const label =
                  view === "groups"
                    ? `${area.name}${shape.id === homeId ? `, ${possessive(name)} community` : ""}: ${
                        unknown ? "no group, driving routes incomplete" : (groups.get(cluster as number)?.label ?? "a group")
                      }`
                    : rowText(shape.id);
                return (
                  <path
                    key={shape.id}
                    d={shape.d}
                    fill={fill}
                    className={s.area}
                    tabIndex={0}
                    role="button"
                    aria-pressed={shape.id === shownId}
                    aria-label={label}
                    onClick={() => select(shape.id)}
                    onKeyDown={(event) => onAreaKey(event, shape.id)}
                    onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible") ? shape.id : null)}
                    onBlur={() => setFocused((current) => (current === shape.id ? null : current))}
                  >
                    <title>{label}</title>
                  </path>
                );
              })}
              {homeShape && <path d={homeShape.d} className={s.homeLine} />}
              {shownShape && (
                <>
                  <path d={shownShape.d} className={s.halo} />
                  <path d={shownShape.d} className={s.selectedLine} />
                </>
              )}
              {focusShape && (
                <>
                  <path d={focusShape.d} className={s.halo} />
                  <path d={focusShape.d} className={s.focusLine} />
                </>
              )}
              {homeShape && <circle cx={homeShape.x} cy={homeShape.y} r="9" className={s.homeDot} />}
            </svg>

            {view === "access" ? (
              <div className={s.key}>
                <p className={s.keyTitle}>Access, out of 100</p>
                <ul className={s.keyList} role="list">
                  {SCORE_STEPS.map((step) => (
                    <li key={step.from} className={s.keyItem}>
                      <span className={s.swatch} style={{ background: step.fill }} aria-hidden="true" />
                      <span className={s.num}>
                        {step.from} to {step.to}
                      </span>
                    </li>
                  ))}
                  {mode === "driving" && unrouted > 0 && (
                    <li className={s.keyItem}>
                      <span className={`${s.swatch} ${s.swatchHatch}`} aria-hidden="true" />
                      Not scored ({unrouted})
                    </li>
                  )}
                </ul>
                <p className={s.keyNote}>
                  Darker means more of the places you picked are within reach.
                  {mode === "driving" && unrouted > 0 && " Hatching means the driving routes weren’t fully mapped, not that access is low."}
                </p>
              </div>
            ) : (
              <div className={s.key}>
                <p className={s.keyTitle}>Access groups</p>
                <ul className={s.keyList} role="list">
                  {sizes.map((size) => (
                    <li key={size.cluster} className={s.keyItem}>
                      <span className={s.swatch} style={{ background: groupFill(size.cluster) }} aria-hidden="true" />
                      {groups.get(size.cluster)?.label ?? "Group"}, {size.areas} communities
                    </li>
                  ))}
                  {ungrouped > 0 && (
                    <li className={s.keyItem}>
                      <span className={`${s.swatch} ${s.swatchHatch}`} aria-hidden="true" />
                      No group ({ungrouped})
                    </li>
                  )}
                </ul>
                <p className={s.keyNote}>
                  The groups were made once, from counts of pharmacies within 20 minutes and other places within 30
                  minutes by car. The choices above don’t change them, and neither group is better. Hatched communities
                  had incomplete driving routes.
                </p>
              </div>
            )}

            <ul className={s.marks} role="list">
              {homeArea && (
                <li className={s.keyItem}>
                  <span className={s.markHome} aria-hidden="true" />
                  {possessive(name)} community, {homeArea.name}
                </li>
              )}
              <li className={s.keyItem}>
                <span className={s.markSelected} aria-hidden="true" />
                The community shown in the details
              </li>
            </ul>

            <p className={s.credit}>
              Boundaries: <CreditLink href={CREDITS.boundaries}>City of Calgary</CreditLink>. Routing:{" "}
              <CreditLink href={CREDITS.osm}>OpenStreetMap contributors</CreditLink> (
              <CreditLink href={CREDITS.odbl}>ODbL</CreditLink>) via <CreditLink href={CREDITS.osrm}>OSRM</CreditLink>.
            </p>
          </section>

          <div id={`${safeId}-detail`} className={s.detailPane}>
            {shownRow && shownArea && (
              <AccessDetail
                key={`${shownArea.id}-${mode}-${threshold}`}
                headingRef={detailHeading}
                area={shownArea}
                row={shownRow}
                places={places && places.key === placesKey ? places.list : null}
                placesFailed={placesFailed !== null && placesFailed === placesKey}
                onRetryPlaces={() => setPlacesAttempt((n) => n + 1)}
                labels={labels}
                groupSize={groupSize}
                mode={mode}
                threshold={threshold}
                categories={categories}
                stepFree={stepFree}
                isHome={shownArea.id === homeId}
                name={name}
                groups={groups}
              />
            )}
          </div>
        </div>

        <HowThisWorks basemap={basemap} />
      </>
    );
  }

  return (
    <div className={s.lane}>
      <div className={s.page}>
        <div className={s.card}>
          <Link href="/care" className={s.back}>
            <ChevronLeft size={18} aria-hidden="true" />
            Back to Care
          </Link>
          <Question lead={homeArea ? `${name} lives in ${homeArea.name}.` : undefined} autoFocusOnMount>
            How do other Calgary communities compare?
          </Question>
          <p className={s.intro}>
            Each community is measured from one central point, using public lists of care places. Pick what matters to
            you, then choose a community on the map or from the list to see what’s close.
          </p>
          {body}
        </div>
      </div>
    </div>
  );
}

function CreditLink({ href, children }: { href: string; children: string }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
    </a>
  );
}
