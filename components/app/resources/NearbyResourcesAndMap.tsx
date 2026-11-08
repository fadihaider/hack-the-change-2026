"use client";
// nearby places: real calgary resource cards from GET /api/care-access/nearby, then directly below them a map of
// exactly those cards (marker n is card n). filters ask the server again. used on care (near rosa) and help nearby.
// distances are straight lines; unknown hours or access stay Unknown; nothing here rates care or availability.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  liveErrorMessage,
  NEARBY_TYPES,
  safeHref,
  type NearbyResourceView,
  type NearbyType,
  type NearbyView,
} from "@/lib/frontend/live-api.ts";
import { RequestApiError } from "@/lib/frontend/request-api.ts";
import { possessive } from "../access/access-data.ts";
import { useApis } from "../session.tsx";
import { Button, ButtonLink, ErrorNote, VisuallyHidden, useAnnounce } from "../ui.tsx";
import {
  checkedOn,
  distanceText,
  emptyText,
  hoursText,
  orderResources,
  RADIUS_CHOICES,
  summaryText,
  telHref,
  typeText,
  TYPE_WORDS,
  wheelchairText,
  type RadiusKm,
} from "./nearby-words.ts";
import { ResourceMap } from "./ResourceMap.tsx";
import s from "./NearbyResourcesAndMap.module.css";

const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const CARE_TYPES: readonly NearbyType[] = NEARBY_TYPES.filter((type) => type !== "transit");

export type NearbyResourcesAndMapProps = {
  /** the person cared for, e.g. "Rosa", for the copy */
  name: string;
  /** defaults to "Places near Rosa’s home" */
  title?: string;
  /** a class for the title, so it can match the headings around it */
  titleClassName?: string;
  /** 3 when nested under another section heading; the cards use the next level down */
  headingLevel?: 2 | 3;
  /** a typed address; leave it out to use the stored home point */
  address?: string | null;
  /** the kinds offered as filters, in this order; defaults to every kind */
  allowedTypes?: readonly NearbyType[];
  /** the kinds ticked at first; defaults to every allowed kind except transit stops */
  defaultTypes?: readonly NearbyType[];
  defaultRadiusKm?: RadiusKm;
  /** cards shown before "Show N more"; markers follow the visible cards */
  initialVisible?: number;
  /** places asked for per kind */
  perType?: number;
  /** e.g. session.appNow, so open-now by listed hours is checked again when the demo clock moves */
  refreshKey?: string | null;
  /** adds "Explore all Calgary access", a link to /care/access */
  exploreLink?: boolean;
  /** pharmacies open now by their listed hours come first, as on the urgent help list */
  openFirst?: boolean;
  /** replaces the first line under the title */
  intro?: string;
};

export function NearbyResourcesAndMap({
  name,
  title,
  titleClassName,
  headingLevel = 2,
  address,
  allowedTypes = NEARBY_TYPES,
  defaultTypes,
  defaultRadiusKm = 3,
  initialVisible = 6,
  perType = 4,
  refreshKey = null,
  exploreLink = false,
  openFirst = false,
  intro,
}: NearbyResourcesAndMapProps) {
  const { live } = useApis();
  const announce = useAnnounce();
  // plain characters only, so the skip link's #fragment matches
  const uid = `rr-nearby-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const titleId = `${uid}-title`;
  const mapId = `${uid}-map`;
  const afterMapId = `${uid}-after-map`;
  const kindsHintId = `${uid}-kinds-hint`;
  const stepFreeHintId = `${uid}-stepfree-hint`;

  const firstTypes = (defaultTypes ?? allowedTypes.filter((type) => CARE_TYPES.includes(type))).filter((type) =>
    allowedTypes.includes(type),
  );
  const [types, setTypes] = useState<NearbyType[]>(firstTypes.length > 0 ? firstTypes : [...allowedTypes]);
  const [radiusKm, setRadiusKm] = useState<RadiusKm>(defaultRadiusKm);
  const [stepFree, setStepFree] = useState(false);
  const [data, setData] = useState<NearbyView | null>(null);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(initialVisible);
  const [keepOne, setKeepOne] = useState(false);
  const seq = useRef(0);
  const speak = useRef(false);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const mapRef = useRef<HTMLDivElement>(null);

  const typesKey = types.join(",");
  const query = address?.trim() || undefined;

  useEffect(() => {
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    live
      .nearby({
        types: typesKey.split(",") as NearbyType[],
        radiusKm,
        accessible: stepFree ? "yes" : "any",
        perType,
        address: query,
      })
      .then((next) => {
        if (mine !== seq.current) return;
        setData(next);
        setError(null);
        setSelectedId((old) => (old && next.resources.some((resource) => resource.id === old) ? old : null));
        if (speak.current) {
          announce(
            next.resources.length === 0
              ? emptyText(typesKey.split(",") as NearbyType[], radiusKm, stepFree)
              : summaryText(next, stepFree),
          );
        }
      })
      .catch((caught: unknown) => {
        if (mine !== seq.current) return;
        const message = liveErrorMessage(caught);
        setError({ message, retry: !(caught instanceof RequestApiError && caught.status === 422) });
        if (speak.current) announce(message);
      })
      .finally(() => {
        if (mine !== seq.current) return;
        setLoading(false);
        speak.current = false;
      });
  }, [live, typesKey, radiusKm, stepFree, perType, query, refreshKey, attempt, announce]);

  function changed() {
    speak.current = true;
    setVisibleCount(initialVisible);
  }

  function toggleType(type: NearbyType, on: boolean) {
    if (!on && types.length === 1 && types[0] === type) {
      setKeepOne(true);
      announce("Keep at least one kind of place.");
      return;
    }
    setKeepOne(false);
    changed();
    setTypes((old) =>
      on ? allowedTypes.filter((item) => item === type || old.includes(item)) : old.filter((item) => item !== type),
    );
  }

  const ordered = useMemo(() => (data ? orderResources(data.resources, { openFirst }) : []), [data, openFirst]);
  const visible = useMemo(() => ordered.slice(0, visibleCount), [ordered, visibleCount]);
  const hidden = ordered.length - visible.length;
  const nextBatch = Math.min(hidden, initialVisible);
  const numberOf = new Map(visible.map((resource, index) => [resource.id, index + 1]));
  const stale = loading && data !== null;
  const usesOsm = visible.some((resource) => /openstreetmap/i.test(`${resource.source} ${resource.sourceUrl}`));

  function scrollOptions(): ScrollIntoViewOptions {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    return { block: "nearest", behavior: reduce ? "auto" : "smooth" };
  }

  /** a card's "Show on map": highlight its marker and bring the map into view; focus stays on the button */
  function showOnMap(resource: NearbyResourceView) {
    if (selectedId === resource.id) {
      setSelectedId(null);
      announce("Map highlight cleared.");
      return;
    }
    setSelectedId(resource.id);
    announce(`Showing ${numberOf.get(resource.id) ?? ""}. ${resource.name} on the map.`);
    window.requestAnimationFrame(() => mapRef.current?.scrollIntoView(scrollOptions()));
  }

  /** a marker: highlight it and move to its card */
  function selectMarker(resourceId: string) {
    setSelectedId(resourceId);
    window.requestAnimationFrame(() => {
      const heading = headings.current.get(resourceId);
      if (!heading) return;
      heading.focus({ preventScroll: true });
      heading.closest("li")?.scrollIntoView(scrollOptions());
    });
  }

  function showMore() {
    const firstNew = ordered[visibleCount];
    setVisibleCount((n) => n + initialVisible);
    announce(`Showing ${nextBatch} more ${nextBatch === 1 ? "place" : "places"} in the list and on the map.`);
    if (firstNew) window.requestAnimationFrame(() => headings.current.get(firstNew.id)?.focus());
  }

  const Heading = headingLevel === 3 ? "h3" : "h2";

  let body;
  if (error) {
    body = (
      <div className={s.state}>
        <ErrorNote
          message={error.message}
          onRetry={
            error.retry
              ? () => {
                  speak.current = true;
                  setAttempt((n) => n + 1);
                }
              : undefined
          }
        />
      </div>
    );
  } else if (!data) {
    body = (
      <p className={s.loading} role="status">
        Finding places near {name}
      </p>
    );
  } else if (ordered.length === 0) {
    body = (
      <p className={stale ? `${s.empty} ${s.dim}` : s.empty}>{emptyText(types, radiusKm, stepFree)}</p>
    );
  } else {
    body = (
      <div className={stale ? s.dim : undefined}>
        <p className={s.summary}>
          {summaryText(data, stepFree)} The closest of each kind comes first.
        </p>

        <ol className={s.cards} role="list">
          {visible.map((resource, index) => (
            <ResourceCard
              key={resource.id}
              resource={resource}
              number={index + 1}
              selected={resource.id === selectedId}
              headingLevel={headingLevel === 3 ? 4 : 3}
              mapId={mapId}
              headingRef={(node) => {
                if (node) headings.current.set(resource.id, node);
                else headings.current.delete(resource.id);
              }}
              onShow={() => showOnMap(resource)}
            />
          ))}
        </ol>

        {hidden > 0 && (
          <div className={s.more}>
            <Button variant="quiet" onClick={showMore}>
              Show {nextBatch} more
            </Button>
          </div>
        )}

        <a className={s.skip} href={`#${afterMapId}`}>
          Skip the map
        </a>
        <div ref={mapRef} className={s.mapBlock}>
          <ResourceMap
            id={mapId}
            data={data}
            resources={visible}
            selectedId={selectedId}
            onSelect={selectMarker}
          />
        </div>

        <div id={afterMapId} tabIndex={-1} className={s.after}>
          {data.limits.length > 0 && (
            <ul className={s.limits} role="list">
              {data.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          )}
          <p className={s.credits}>
            Community outlines: City of Calgary.
            {usesOsm && (
              <>
                {" "}
                Place data{" "}
                <a href={OSM_COPYRIGHT} target="_blank" rel="noopener noreferrer">
                  © OpenStreetMap contributors
                  <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
                </a>
                , ODbL.
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className={s.section} aria-labelledby={titleId} aria-busy={loading || undefined}>
      <Heading id={titleId} className={titleClassName ?? (headingLevel === 3 ? s.titleSmall : s.title)}>
        {title ?? `Places near ${possessive(name)} home`}
      </Heading>
      <p className={s.intro}>
        {intro ??
          `From public Calgary lists. Distances are straight lines from near ${possessive(name)} home, not travel times. Transit isn’t routed.`}
      </p>

      <div className={s.filters}>
        <fieldset className={s.field} aria-describedby={keepOne ? kindsHintId : undefined}>
          <legend className={s.legend}>Kind of place</legend>
          <div className={s.chips}>
            {allowedTypes.map((type) => (
              <label key={type} className={s.chip}>
                <input
                  type="checkbox"
                  className={s.chipInput}
                  checked={types.includes(type)}
                  onChange={(event) => toggleType(type, event.target.checked)}
                />
                <span>{TYPE_WORDS[type].label}</span>
              </label>
            ))}
          </div>
          {keepOne && (
            <p id={kindsHintId} className={s.hint} role="status">
              Keep at least one kind of place.
            </p>
          )}
        </fieldset>

        <fieldset className={s.field}>
          <legend className={s.legend}>Distance (straight line)</legend>
          <div className={s.segments}>
            {RADIUS_CHOICES.map((value) => (
              <label key={value} className={s.segment}>
                <input
                  type="radio"
                  className={s.segmentInput}
                  name={`${uid}-radius`}
                  value={value}
                  checked={value === radiusKm}
                  onChange={() => {
                    changed();
                    setRadiusKm(value);
                  }}
                />
                <span>{value} km</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={s.field}>
          <label className={s.check}>
            <input
              type="checkbox"
              className={s.checkInput}
              checked={stepFree}
              aria-describedby={stepFree ? stepFreeHintId : undefined}
              onChange={(event) => {
                changed();
                setStepFree(event.target.checked);
              }}
            />
            <span>Step-free confirmed only</span>
          </label>
          {stepFree && (
            <p id={stepFreeHintId} className={s.notice}>
              Only places whose source lists wheelchair access are shown. Most sources don’t say, and unknown isn’t
              the same as not accessible.
            </p>
          )}
        </div>
      </div>

      {body}

      {exploreLink && (
        <div className={s.explore}>
          <ButtonLink href="/care/access" variant="secondary">
            Explore all Calgary access
          </ButtonLink>
        </div>
      )}
    </section>
  );
}

export type ResourceCardProps = {
  resource: NearbyResourceView;
  /** the same number as its marker on the map */
  number: number;
  selected: boolean;
  headingLevel: 3 | 4;
  /** the map's id, for the button's aria-controls */
  mapId: string;
  headingRef?: (node: HTMLHeadingElement | null) => void;
  onShow: () => void;
};

/** one place: what it is, how far in a straight line, its listed hours and access (or Unknown), and its source */
export function ResourceCard({ resource, number, selected, headingLevel, mapId, headingRef, onShow }: ResourceCardProps) {
  const CardHeading = headingLevel === 4 ? "h4" : "h3";
  const hours = hoursText(resource.hours);
  const tel = telHref(resource.phone);
  const source = safeHref(resource.sourceUrl);
  const checked = checkedOn(resource.fetchedAt);
  return (
    <li className={selected ? `${s.card} ${s.cardSelected}` : s.card}>
      <div className={s.cardHead}>
        <span className={s.cardNumber} aria-hidden="true">
          {number}
        </span>
        <CardHeading className={s.cardTitle} tabIndex={-1} ref={headingRef}>
          <VisuallyHidden>{number}. </VisuallyHidden>
          {resource.name}
        </CardHeading>
      </div>
      <p className={s.cardMeta}>
        {typeText(resource)} · <span className={s.nowrap}>{distanceText(resource.distanceKm)}</span>
        {resource.withinRadius ? "" : ", outside the chosen distance"}
      </p>
      <p className={s.cardAddress}>{resource.address?.trim() || "Address unknown"}</p>
      <dl className={s.facts}>
        <div className={s.fact}>
          <dt>Hours</dt>
          <dd>
            {hours.text}
            {hours.status && <span className={s.status}>{hours.status}</span>}
          </dd>
        </div>
        <div className={s.fact}>
          <dt>Step-free</dt>
          <dd>{wheelchairText(resource.wheelchair)}</dd>
        </div>
        {resource.phone && (
          <div className={s.fact}>
            <dt>Phone</dt>
            <dd>
              {tel ? (
                <a className={s.tel} href={tel}>
                  {resource.phone}
                </a>
              ) : (
                resource.phone
              )}
            </dd>
          </div>
        )}
      </dl>
      <p className={s.source}>
        Source:{" "}
        {source ? (
          <a href={source} target="_blank" rel="noopener noreferrer">
            {resource.source}
            <ExternalLink size={13} aria-hidden="true" className={s.external} />
            <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
          </a>
        ) : (
          resource.source
        )}
        {checked ? (
          <>
            , fetched <span className={s.nowrap}>{checked}</span>.
          </>
        ) : (
          "."
        )}
        {resource.license ? ` Licence: ${resource.license}.` : ""}
      </p>
      <button type="button" className={s.showButton} aria-pressed={selected} aria-controls={mapId} onClick={onShow}>
        Show on map<VisuallyHidden> (marker {number})</VisuallyHidden>
      </button>
    </li>
  );
}
