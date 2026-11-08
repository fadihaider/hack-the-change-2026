"use client";
// today's care: the approved times and urgent appointments for one day, what matters now first, the rest a tap away
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { BellRing, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, MapPin, Repeat } from "lucide-react";
import {
  addDaysTo,
  formatAlberta,
  liveErrorMessage,
  rruleLabel,
  type LiveEpisode,
  type LiveSession,
  type TimelineItemView,
  type TimelineView,
} from "@/lib/frontend/live-api.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, VisuallyHidden, dayLabel, useAnnounce } from "../ui.tsx";
import { categoryTitle, clampDate, plural, possessive } from "./care-data.ts";
import { TellAbout } from "./TellAbout.tsx";
import {
  STATUS_LABEL,
  dayItemText,
  dayPreview,
  daySummary,
  itemKey,
  itemStatus,
  overviewLine,
  reminderAt,
  withCompletion,
} from "./today-data.ts";
import s from "./care.module.css";

type Props = {
  name: string;
  session: LiveSession;
  episode: LiveEpisode;
  /** changes after each profile reload, so a new approval shows up */
  version: number;
  /** the empty day offers to tell reliefready about the person; null when the page already shows that action */
  onVoice: (() => void) | null;
  onNote: (() => void) | null;
};

export function TodayCare({ name, session, episode, version, onVoice, onNote }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const listId = useId();
  const start = episode.startsOn;
  const end = episode.endsOn;
  const todayInWeek = clampDate(session.today, start, end);
  const [date, setDate] = useState(todayInWeek);
  // once alex picks a day, a moving demo clock no longer changes it
  const [picked, setPicked] = useState(false);
  const [day, setDay] = useState<TimelineView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [itemError, setItemError] = useState<{ key: string; message: string } | null>(null);
  const seq = useRef(0);
  const speak = useRef(false);
  // days already seen stay on screen while they refresh, so moving between days never blanks the list
  const seen = useRef(new Map<string, TimelineView>());

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
      const cached = seen.current.get(target);
      if (cached) setDay(cached);
      try {
        const next = await live.timeline(target);
        if (mine !== seq.current) return;
        seen.current.set(target, next);
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
    setFull(false);
    setItemError(null);
    setDate(next);
  }

  async function mark(item: TimelineItemView, done: boolean) {
    const key = itemKey(item);
    if (busy || !day) return;
    const on = day.date;
    setBusy(key);
    setItemError(null);
    try {
      const result = await live.completeEvent(item.eventId, on, done);
      const update = (view: TimelineView): TimelineView => ({
        ...view,
        items: withCompletion(view.items, result.eventId, result.completedAt),
        reminders: withCompletion(view.reminders, result.eventId, result.completedAt),
      });
      const cached = seen.current.get(on);
      if (cached) seen.current.set(on, update(cached));
      setDay((current) => (current && current.date === on ? update(current) : current));
      announce(
        result.completedAt
          ? `Marked done: ${item.title}. Recorded by you.`
          : `Marked not done: ${item.title}.`,
      );
    } catch (caught) {
      setItemError({ key, message: liveErrorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  function toggleFull(hidden: number) {
    const next = !full;
    setFull(next);
    announce(next ? `Showing the full day, ${plural(hidden, "more thing", "more things")}.` : "Showing what matters now.");
  }

  const isToday = date === session.today;
  const atStart = date <= start;
  const atEnd = date >= end;
  const previous = addDaysTo(date, -1);
  const following = addDaysTo(date, 1);
  const shown = day;
  const items = shown?.items ?? [];
  const stale = loading || (shown !== null && shown.date !== date);
  const nowMs = isToday && shown ? Date.parse(shown.appNow) : null;
  const now = nowMs !== null && Number.isFinite(nowMs) ? nowMs : null;
  const preview = dayPreview(items, now);
  const listed = full ? [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)) : preview.shown;
  const summary = daySummary(items, now);

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        {isToday ? "Today’s care" : `${possessive(name)} care, ${dayLabel(date, "short")}`}
      </h2>
      <p className={s.sectionHint}>Approved times and appointments, in Alberta time.</p>

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
          {isToday && <span className={s.today}>Today</span>}
        </p>
        <span className={atEnd ? s.navOff : undefined}>
          <Button variant="secondary" aria-disabled={atEnd || undefined} onClick={() => move(1)}>
            <ChevronRight size={20} aria-hidden="true" />
            <VisuallyHidden>{atEnd ? "No later day in the care week" : `Next day, ${dayLabel(following)}`}</VisuallyHidden>
          </Button>
        </span>
      </div>

      {/* a failed refresh keeps the last list on screen with the error above it */}
      {error && <ErrorNote message={error} onRetry={() => void load(date)} />}
      {error && shown === null ? null : shown === null ? (
        <p className={s.empty} role="status">
          Loading {possessive(name)} day
        </p>
      ) : items.length === 0 ? (
        <div className={`${s.dayEmpty} ${stale ? s.dim : ""}`}>
          <p className={s.dayEmptyText}>Nothing on {possessive(name)} day yet.</p>
          {onVoice && onNote ? (
            <TellAbout name={name} onVoice={onVoice} onNote={onNote} />
          ) : (
            <p className={s.dayEmptyHint}>Times from notes you’ve checked show up here.</p>
          )}
        </div>
      ) : (
        <>
          <p className={s.overview}>{overviewLine(summary)}</p>
          <ol
            id={listId}
            className={`${s.dayList} ${stale ? s.dim : ""}`}
            role="list"
            aria-busy={stale || undefined}
          >
            {listed.map((item) => {
              const key = itemKey(item);
              return (
                <DayItem
                  key={key}
                  item={item}
                  busy={busy === key}
                  locked={busy !== null && busy !== key}
                  error={itemError?.key === key ? itemError.message : null}
                  onMark={(done) => void mark(item, done)}
                />
              );
            })}
          </ol>
          {(preview.hidden > 0 || full) && (
            <div className={s.fullDay}>
              <Button
                variant="secondary"
                aria-expanded={full}
                aria-controls={listId}
                onClick={() => toggleFull(preview.hidden)}
              >
                {full ? "Show what matters now" : `Open full day (${preview.hidden} more)`}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type DayItemProps = {
  item: TimelineItemView;
  busy: boolean;
  /** another item is saving */
  locked: boolean;
  error: string | null;
  onMark: (done: boolean) => void;
};

function DayItem({ item, busy, locked, error, onMark }: DayItemProps) {
  const status = itemStatus(item);
  const remind = reminderAt(item);
  const appointment = item.factId === null;
  // locked wording is never shortened (PRD 15); other items show the short title with the exact words on expand
  const shortText = dayItemText(item);
  const statusClass = status === "done" ? s.statusDone : status === "reminder" ? s.statusNow : s.statusPlanned;

  return (
    <li className={`${s.dayItem} ${status === "reminder" ? s.dayItemSoon : ""}`}>
      <time className={s.dayTime} dateTime={item.startsAt}>
        {formatAlberta(item.startsAt, "time")}
      </time>
      <div className={s.dayBody}>
        <div className={s.dayHead}>
          <p className={s.dayText}>{shortText}</p>
          <span className={`${s.status} ${statusClass}`}>
            {status === "done" && <Check size={14} aria-hidden="true" />}
            {status === "reminder" && <BellRing size={14} aria-hidden="true" />}
            {STATUS_LABEL[status]}
          </span>
        </div>
        {(remind || item.rrule || appointment || item.locationText) && (
          <ul className={s.dayMeta} role="list">
            {remind && (
              <li>
                <BellRing size={15} aria-hidden="true" />
                Reminder {formatAlberta(remind, "time")}
              </li>
            )}
            {item.rrule && (
              <li>
                <Repeat size={15} aria-hidden="true" />
                {rruleLabel(item.rrule)}
              </li>
            )}
            {appointment && (
              <li>
                <CalendarClock size={15} aria-hidden="true" />
                Appointment from Urgent
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

        <details className={s.dayDetails}>
          <summary className={s.daySummary}>
            {appointment ? "Full details" : "Exact approved wording"}
            <VisuallyHidden>{`, ${item.title}`}</VisuallyHidden>
            <ChevronDown size={16} aria-hidden="true" className={s.dayChevron} />
          </summary>
          <div className={s.dayDetailsBody}>
            <p className={s.dayCategory}>{appointment ? "Appointment" : categoryTitle(item.category)}</p>
            {item.fullText ? (
              <p className={s.dayExact}>“{item.fullText}”</p>
            ) : (
              <p className={s.dayExact}>{item.title}</p>
            )}
            {appointment && (
              <p className={s.dayLink}>
                <Link href="/urgent">See it in Urgent</Link>
              </p>
            )}
          </div>
        </details>

        <div className={s.dayActions}>
          <Button
            variant="secondary"
            className={s.markButton}
            busy={busy}
            busyLabel="Saving"
            aria-disabled={locked || undefined}
            onClick={() => {
              if (!locked) onMark(status !== "done");
            }}
          >
            {status === "done" ? "Undo" : "Mark done"}
            <VisuallyHidden>{`: ${item.title}`}</VisuallyHidden>
          </Button>
        </div>
        {error && <ErrorNote message={error} />}
      </div>
    </li>
  );
}
