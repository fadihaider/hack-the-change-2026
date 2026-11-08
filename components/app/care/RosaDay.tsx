"use client";
// one day of the care week: approved times from the profile, in order, with repeats spelled out
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BellRing, ChevronLeft, ChevronRight, MapPin, Repeat } from "lucide-react";
import {
  addDaysTo,
  formatAlberta,
  liveErrorMessage,
  rruleLabel,
  type LiveEpisode,
  type LiveSession,
  type TimelineView,
} from "@/lib/frontend/live-api.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, VisuallyHidden, dayLabel, useAnnounce } from "../ui.tsx";
import { clampDate, plural, possessive } from "./care-data.ts";
import s from "./care.module.css";

type Props = {
  name: string;
  session: LiveSession;
  episode: LiveEpisode;
  /** changes after each profile reload, so a new approval shows up */
  version: number;
};

export function RosaDay({ name, session, episode, version }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const start = episode.startsOn;
  const end = episode.endsOn;
  const todayInWeek = clampDate(session.today, start, end);
  const [date, setDate] = useState(todayInWeek);
  // once alex picks a day, a moving demo clock no longer changes it
  const [picked, setPicked] = useState(false);
  const [day, setDay] = useState<TimelineView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const speak = useRef(false);

  useEffect(() => {
    if (!picked) setDate(todayInWeek);
  }, [todayInWeek, picked]);

  useEffect(() => {
    setDate((current) => clampDate(current, start, end));
  }, [start, end]);

  const load = useCallback(
    async (target: string) => {
      seq.current += 1;
      const mine = seq.current;
      setLoading(true);
      try {
        const next = await live.timeline(target);
        if (mine !== seq.current) return;
        setDay(next);
        setError(null);
        if (speak.current) {
          speak.current = false;
          announce(
            next.items.length === 0
              ? `${dayLabel(target)}: nothing planned yet.`
              : `${dayLabel(target)}: ${plural(next.items.length, "thing", "things")} on ${possessive(name)} day.`,
          );
        }
      } catch (caught) {
        if (mine === seq.current) setError(liveErrorMessage(caught));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [live, announce, name],
  );

  // the day reloads when the date, the profile or the demo clock changes
  useEffect(() => {
    void load(date);
  }, [load, date, version, session.appNow]);

  function move(days: number) {
    const next = clampDate(addDaysTo(date, days), start, end);
    if (next === date) return;
    speak.current = true;
    setPicked(true);
    setDate(next);
  }

  const atStart = date <= start;
  const atEnd = date >= end;
  const previous = addDaysTo(date, -1);
  const following = addDaysTo(date, 1);
  const shown = day;
  const items = shown?.items ?? [];
  const stale = loading || (shown !== null && shown.date !== date);

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        {possessive(name)} day
      </h2>
      <p className={s.sectionHint}>Times from what you’ve checked, in Alberta time.</p>

      <div className={s.dayNav}>
        {/* aria-disabled, not disabled, so focus stays put when alex reaches the first day */}
        <span className={atStart ? s.navOff : undefined}>
          <Button variant="secondary" aria-disabled={atStart || undefined} onClick={() => move(-1)}>
            <ChevronLeft size={20} aria-hidden="true" />
            <VisuallyHidden>{atStart ? "No earlier day in the care week" : `Previous day, ${dayLabel(previous)}`}</VisuallyHidden>
          </Button>
        </span>
        <p className={s.dayName}>
          <span>{dayLabel(date)}</span>
          {date === session.today && <span className={s.today}>Today</span>}
        </p>
        <span className={atEnd ? s.navOff : undefined}>
          <Button variant="secondary" aria-disabled={atEnd || undefined} onClick={() => move(1)}>
            <ChevronRight size={20} aria-hidden="true" />
            <VisuallyHidden>{atEnd ? "No later day in the care week" : `Next day, ${dayLabel(following)}`}</VisuallyHidden>
          </Button>
        </span>
      </div>

      {error ? (
        <ErrorNote message={error} onRetry={() => void load(date)} />
      ) : shown === null ? (
        <p className={s.empty} role="status">
          Loading {possessive(name)} day
        </p>
      ) : items.length === 0 ? (
        <p className={`${s.empty} ${stale ? s.dim : ""}`}>
          Nothing planned for {dayLabel(date)} yet. Times from notes you’ve checked show up here.
        </p>
      ) : (
        <ol className={`${s.dayList} ${stale ? s.dim : ""}`} role="list" aria-busy={stale || undefined}>
          {items.map((item) => (
            <li key={`${item.eventId}-${item.startsAt}`} className={`${s.dayItem} ${item.highlight ? s.dayItemSoon : ""}`}>
              <time className={s.dayTime} dateTime={item.startsAt}>
                {formatAlberta(item.startsAt, "time")}
              </time>
              <div className={s.dayBody}>
                <p className={s.dayText}>{item.fullText ?? item.title}</p>
                {(item.highlight || item.rrule || item.locationText) && (
                  <ul className={s.dayMeta} role="list">
                    {item.highlight && (
                      <li className={s.soon}>
                        <BellRing size={15} aria-hidden="true" />
                        Coming up
                      </li>
                    )}
                    {item.rrule && (
                      <li>
                        <Repeat size={15} aria-hidden="true" />
                        {rruleLabel(item.rrule)}
                      </li>
                    )}
                    {item.locationText && (
                      <li>
                        <MapPin size={15} aria-hidden="true" />
                        {item.locationText}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
