"use client";
// compare calgary communities: what to measure, a map of every community coloured by the access metric or by the two
// unordered access groups, the chosen community's places, and how it all works. the public snapshot loads here only.
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { compareAreas, type AccessSnapshot } from "@/lib/care-access/engine.ts";
import { areaIndexByName, clusterSizes } from "@/lib/care-access/home.ts";
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
  loadSnapshot,
  possessive,
  projectAreas,
  scoreFill,
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

  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    loadSnapshot(controller.signal)
      .then(setSnapshot)
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadError("The Calgary map data didn’t load. Check your connection, then try again.");
        }
      });
    return () => controller.abort();
  }, [attempt]);

  // rosa's community by name; when the name isn't in the list, the server matches her home point instead
  useEffect(() => {
    if (!snapshot) return;
    const byName = areaIndexByName(snapshot.areas, community);
    if (byName >= 0) {
      setHomeId(snapshot.areas[byName].id);
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
  }, [snapshot, community, hasRecipient]);

  const layout = useMemo(() => (snapshot ? projectAreas(snapshot.areas) : null), [snapshot]);
  const comparison = useMemo(
    () => (snapshot ? compareAreas(snapshot, { mode, threshold, categories, stepFree }) : []),
    [snapshot, mode, threshold, categories, stepFree],
  );
  const sizes = useMemo(() => (snapshot ? clusterSizes(snapshot.clusters) : []), [snapshot]);
  const groups = useMemo(() => groupNames(sizes), [sizes]);
  const sortedAreas = useMemo(
    () => (snapshot ? [...snapshot.areas].sort((a, b) => a.name.localeCompare(b.name, "en-CA")) : []),
    [snapshot],
  );

  const firstRouted = snapshot ? (snapshot.areas.find((_, i) => snapshot.drivingCoverage[i] === 1)?.id ?? null) : null;
  const shownId = selected ?? homeId ?? firstRouted;
  const shownRow = comparison.find((row) => row.area.id === shownId) ?? null;

  function rowText(id: string): string {
    const row = comparison.find((item) => item.area.id === id);
    if (!row) return "";
    const home = id === homeId ? `, ${possessive(name)} community` : "";
    const score = row.score === null ? "not scored, driving routes incomplete" : `access ${row.score} out of 100`;
    return `${row.area.name}${home}: ${score}, ${row.resources.length} ${row.resources.length === 1 ? "place" : "places"} in reach.`;
  }

  // after a filter change, read out what it did to the community on screen
  useEffect(() => {
    if (!speakAfterChange.current || !shownId) return;
    speakAfterChange.current = false;
    announce(`Map updated. ${rowText(shownId)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparison]);

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

  const homeArea = snapshot && homeId ? snapshot.areas.find((area) => area.id === homeId) : null;

  let body;
  if (!snapshot || !layout) {
    body = loadError ? (
      <div className={s.state}>
        <ErrorNote message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
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
    const unrouted = snapshot.drivingCoverage.filter((value) => value !== 1).length;
    const ungrouped = snapshot.clusters.filter((value) => value === null || value < 0).length;
    const unit = mode === "driving" ? "min" : "km";
    const confirmedStepFree = snapshot.resources.filter((resource) => resource.wheelchair === true).length;

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

            <svg
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className={s.map}
              role="group"
              aria-label={`Map of ${snapshot.areas.length} Calgary communities. Tab to a community, then press Enter to see its details.`}
            >
              <defs>
                <pattern id={hatchId} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="9" height="9" fill="#eef0f4" />
                  <line x1="0" y1="0" x2="0" y2="9" stroke="#b3b9c5" strokeWidth="3" />
                </pattern>
              </defs>
              {layout.shapes.map((shape, index) => {
                const row = comparison[index];
                const cluster = snapshot.clusters[index];
                const unknown = view === "groups" ? cluster === null || cluster < 0 : row.score === null;
                const fill = unknown
                  ? `url(#${hatchId})`
                  : view === "groups"
                    ? groupFill(cluster as number)
                    : scoreFill(row.score as number);
                const label =
                  view === "groups"
                    ? `${row.area.name}${shape.id === homeId ? `, ${possessive(name)} community` : ""}: ${
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
            {shownRow && (
              <AccessDetail
                key={`${shownRow.area.id}-${mode}-${threshold}`}
                headingRef={detailHeading}
                snapshot={snapshot}
                row={shownRow}
                mode={mode}
                threshold={threshold}
                categories={categories}
                stepFree={stepFree}
                isHome={shownRow.area.id === homeId}
                name={name}
                groups={groups}
              />
            )}
          </div>
        </div>

        <HowThisWorks snapshot={snapshot} />
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
