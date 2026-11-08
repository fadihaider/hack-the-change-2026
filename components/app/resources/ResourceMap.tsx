"use client";
// the flat svg map under the nearby cards: city community outlines as a light basemap, the chosen straight-line
// distance, an approximate home point, and one numbered marker per visible card at its real sourced coordinates.
// the map fits home and the chosen distance; a place beyond the map sits at the edge with an arrow toward it, and
// markers that would overlap are moved apart with a line to their real spot, so every card keeps its own marker.
// no tiles, no api keys, no inline styles. the card list above is the list alternative.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NearbyResourceView, NearbyView } from "@/lib/frontend/live-api.ts";
import {
  compassText,
  distanceText,
  fitProjection,
  mapBounds,
  originText,
  placeMarkers,
  ringsPath,
  scaleBarKm,
  scaleText,
  typeText,
} from "./nearby-words.ts";
import s from "./NearbyResourcesAndMap.module.css";

const DEFAULT_WIDTH = 640;
const MARKER_R = 13;
// an invisible ring around each marker so a finger has a 44px target, smaller only where markers sit close
const HIT_R = 22;
const MARKER_SIZES = { markerR: MARKER_R, hitR: HIT_R, homeR: 16, gap: 4, edge: MARKER_R + 12 };
// the arrow on a marker for a place beyond the map, drawn pointing east and then rotated
const EDGE_ARROW = `M${MARKER_R + 3} -5 L${MARKER_R + 10} 0 L${MARKER_R + 3} 5 Z`;

export type ResourceMapProps = {
  id: string;
  data: NearbyView;
  /** the visible cards, in card order; marker n is card n */
  resources: readonly NearbyResourceView[];
  selectedId: string | null;
  onSelect: (resourceId: string) => void;
};

/** the map height follows its width: taller on phones so the markers have room */
function heightFor(width: number): number {
  const ratio = width < 560 ? 0.95 : 0.58;
  return Math.round(Math.min(460, Math.max(280, width * ratio)));
}

export function ResourceMap({ id, data, resources, selectedId, onSelect }: ResourceMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  // draw at the real pixel width so markers and numbers keep their size on a phone
  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = Math.round(node.clientWidth);
      if (next > 0) setWidth((old) => (Math.abs(old - next) > 1 ? next : old));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const height = heightFor(width);
  const layout = useMemo(() => {
    const bounds = mapBounds(data.origin, data.radiusKm, resources) ?? data.bounds;
    const projection = fitProjection(bounds, width, height);
    const home = (data.origin.community ?? "").trim().toLowerCase();
    const outlines = data.outlines
      .map((outline, index) => ({
        key: `${outline.name}-${index}`,
        d: ringsPath(outline.rings, projection),
        home: home !== "" && outline.name.trim().toLowerCase() === home,
      }))
      .filter((outline) => outline.d !== "");
    const homeX = projection.x(data.origin.lon);
    const homeY = projection.y(data.origin.lat);
    const placed = placeMarkers(
      resources.map((resource) => ({ x: projection.x(resource.lon), y: projection.y(resource.lat) })),
      { x: homeX, y: homeY },
      { width, height },
      MARKER_SIZES,
    );
    const markers = resources.map((resource, index) => ({
      ...placed[index],
      resource,
      number: index + 1,
      // where a place beyond the map lies, seen from home
      toward: compassText(placed[index].trueX - homeX, placed[index].trueY - homeY),
    }));
    return {
      projection,
      outlines,
      markers,
      homeX,
      homeY,
      radius: data.radiusKm * projection.pxPerKm,
      scaleKm: scaleBarKm(projection),
    };
  }, [data, resources, width, height]);

  function onMarkerKey(event: KeyboardEvent<SVGGElement>, resourceId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(resourceId);
    }
  }

  const count = resources.length;
  const label =
    `Map of the ${count === 1 ? "place" : `${count} places`} listed above, numbered as in the list, with ` +
    `a marker for ${originText(data.origin)} and a ${data.radiusKm} km straight-line circle. ` +
    "Tab to a numbered marker and press Enter to find it in the list.";
  // paint order only (aria-hidden): the selected marker last so it sits on top, lower numbers above higher ones.
  // the buttons further down stay in card order 1..N for the keyboard and screen readers.
  const painted = [...layout.markers]
    .reverse()
    .sort((a, b) => Number(a.resource.id === selectedId) - Number(b.resource.id === selectedId));
  const selected = layout.markers.find((marker) => marker.resource.id === selectedId) ?? null;
  const anyClamped = layout.markers.some((marker) => marker.clamped);
  const anyMoved = layout.markers.some((marker) => marker.moved);
  const scalePx = layout.scaleKm * layout.projection.pxPerKm;

  return (
    <div ref={wrapRef} className={s.mapWrap}>
      <svg
        id={id}
        className={s.map}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="group"
        aria-label={label}
      >
        <g aria-hidden="true">
          <rect className={s.mapGround} x={0} y={0} width={width} height={height} />
          {layout.outlines.map((outline) => (
            <path key={outline.key} className={outline.home ? s.outlineHome : s.outline} d={outline.d} />
          ))}
          <circle className={s.radius} cx={layout.homeX} cy={layout.homeY} r={layout.radius} />
          <g className={s.scale} transform={`translate(16 ${height - 18})`}>
            <path className={s.scaleLine} d={`M0 -5 V0 H${scalePx.toFixed(1)} V-5`} />
            <text className={s.scaleText} x={scalePx + 6} y={0}>
              {scaleText(layout.scaleKm)}
            </text>
          </g>
          {layout.markers
            .filter((marker) => marker.moved)
            .map((marker) => (
              <g key={marker.resource.id}>
                <line
                  className={s.leaderLine}
                  x1={marker.trueX.toFixed(1)}
                  y1={marker.trueY.toFixed(1)}
                  x2={marker.x.toFixed(1)}
                  y2={marker.y.toFixed(1)}
                />
                <circle className={s.leaderDot} cx={marker.trueX.toFixed(1)} cy={marker.trueY.toFixed(1)} r={3} />
              </g>
            ))}
          {painted.map(({ resource, number, x, y, clamped, angle }) => (
            <g
              key={resource.id}
              className={resource.id === selectedId ? `${s.marker} ${s.markerSelected}` : s.marker}
              transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
            >
              {clamped && <path className={s.edgeArrow} transform={`rotate(${angle.toFixed(1)})`} d={EDGE_ARROW} />}
              <circle className={s.markerRing} r={MARKER_R + 5} />
              <circle className={s.markerDot} r={MARKER_R} />
              <text className={s.markerNumber} y={0.5} textAnchor="middle" dominantBaseline="central">
                {number}
              </text>
            </g>
          ))}
          {/* home is drawn after the markers so it is never hidden; markers are also kept clear of it */}
          <g className={s.home} transform={`translate(${layout.homeX.toFixed(1)} ${layout.homeY.toFixed(1)})`}>
            <rect className={s.homeHalo} x={-11} y={-11} width={22} height={22} rx={5} />
            <path className={s.homeGlyph} d="M-6 1 L0 -5 L6 1 L6 6 L-6 6 Z" />
          </g>
        </g>

        {layout.markers.map(({ resource, number, x, y, hitR, clamped, toward }) => {
          const isSelected = resource.id === selectedId;
          const where = clamped ? `, beyond the map edge to the ${toward}` : "";
          return (
            <g
              key={resource.id}
              className={s.markerButton}
              transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`${number}. ${resource.name}, ${typeText(resource)}, ${distanceText(resource.distanceKm)}${where}`}
              onClick={() => onSelect(resource.id)}
              onKeyDown={(event) => onMarkerKey(event, resource.id)}
            >
              <circle className={s.markerHit} r={hitR.toFixed(1)} />
              <circle className={s.markerFocus} r={MARKER_R + 5} />
            </g>
          );
        })}
      </svg>
      <p className={s.mapCaption} aria-hidden="true">
        {selected
          ? `${selected.number}. ${selected.resource.name} · ${typeText(selected.resource)} · ${distanceText(selected.resource.distanceKm)}` +
            (selected.clamped
              ? ` · beyond the map edge to the ${selected.toward}`
              : selected.moved
                ? " · moved a little so it doesn’t cover another marker"
                : "")
          : "Choose a marker or a place in the list to match them up."}
      </p>
      <ul className={s.mapLegend} role="list">
        <li className={s.legendItem}>
          <svg className={s.swatch} viewBox="-10 -10 20 20" aria-hidden="true">
            <circle className={s.markerDot} r={8} />
          </svg>
          A listed place, numbered as in the list
        </li>
        <li className={s.legendItem}>
          <svg className={s.swatch} viewBox="-10 -10 20 20" aria-hidden="true">
            <rect className={s.homeHalo} x={-9} y={-9} width={18} height={18} rx={4} />
            <path className={s.homeGlyph} d="M-5 1 L0 -4 L5 1 L5 5 L-5 5 Z" />
          </svg>
          {originText(data.origin)}
        </li>
        <li className={s.legendItem}>
          <svg className={s.swatch} viewBox="-10 -10 20 20" aria-hidden="true">
            <circle className={s.radius} r={7} />
          </svg>
          {data.radiusKm} km in a straight line
        </li>
        {anyClamped && (
          <li className={s.legendItem}>
            <svg className={s.swatch} viewBox="-10 -10 20 20" aria-hidden="true">
              <path className={s.edgeArrow} d="M-6 -7 L7 0 L-6 7 Z" />
            </svg>
            An arrow at the edge points to a place beyond the map
          </li>
        )}
        {anyMoved && (
          <li className={s.legendItem}>
            <svg className={s.swatch} viewBox="-10 -10 20 20" aria-hidden="true">
              <line className={s.leaderLine} x1={-7} y1={6} x2={6} y2={-5} />
              <circle className={s.leaderDot} cx={-7} cy={6} r={2.5} />
            </svg>
            A line leads from a moved marker to its exact spot
          </li>
        )}
      </ul>
    </div>
  );
}
