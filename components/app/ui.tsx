"use client";
// the shared ui kit: B's one-column structure in C's colours. screens compose these and do not restyle them.
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { Check, ChevronLeft, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { Decision } from "@/lib/frontend/live-api.ts";
import type { RequestView } from "@/lib/frontend/request-api.ts";
import s from "./ui.module.css";

export type RequestState = RequestView["state"];
export type ButtonVariant = "primary" | "secondary" | "quiet";

function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- labels and dates

export const STATE_LABEL: Record<RequestState, string> = {
  draft: "Draft",
  awaiting_approval: "Needs your OK",
  approved: "Approved",
  sending: "Sending",
  requested: "Waiting for a reply",
  accepted: "Said yes",
  completed: "Done",
  cancelled: "Cancelled",
  failed: "Didn’t send",
  rejected: "Said no",
  expired: "No reply in time",
  needs_review: "Check the reply",
};

export const DECISION_LABEL: Record<Decision, string> = {
  notify: "Let them know",
  reschedule: "Ask to move it",
  extension: "Ask for more time",
  coverage: "Find someone to cover",
  defer: "Decide later",
  keep: "Keep it",
};

export type StateTone = "good" | "warn" | "bad" | "ask" | "plain";

export function stateTone(state: RequestState): StateTone {
  if (state === "accepted" || state === "completed") return "good";
  if (state === "failed") return "bad";
  if (state === "needs_review" || state === "rejected" || state === "expired") return "warn";
  if (state === "awaiting_approval") return "ask";
  return "plain";
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateParts(date: string, options: Intl.DateTimeFormatOptions) {
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  // noon utc keeps a date-only value on its own calendar day
  const ms = Date.parse(`${date}T12:00:00Z`);
  if (!DATE_ONLY.test(date) || !Number.isFinite(ms)) return out;
  for (const part of new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...options }).formatToParts(ms)) {
    out[part.type] = part.value;
  }
  return out;
}

/** "Nov 8 to 14", or "Nov 28 to Dec 3" across months, for two YYYY-MM-DD dates */
export function weekRange(startsOn: string, endsOn: string): string {
  const a = dateParts(startsOn, { month: "short", day: "numeric" });
  const b = dateParts(endsOn, { month: "short", day: "numeric" });
  if (!a.month || !b.month) return "dates to confirm";
  return a.month === b.month ? `${a.month} ${a.day} to ${b.day}` : `${a.month} ${a.day} to ${b.month} ${b.day}`;
}

/** "Sunday, Nov 8" for a YYYY-MM-DD date; pass "short" for "Sun, Nov 8" */
export function dayLabel(date: string, style: "long" | "short" = "long"): string {
  const p = dateParts(date, { weekday: style, month: "short", day: "numeric" });
  if (!p.weekday) return "a date to confirm";
  return `${p.weekday}, ${p.month} ${p.day}`;
}

// ---------------------------------------------------------------- buttons

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** shows a spinner, keeps focus, and ignores clicks until the work finishes */
  busy?: boolean;
  /** what the button says while busy, e.g. "Checking your week"; the normal label stays otherwise */
  busyLabel?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = "secondary",
  busy = false,
  busyLabel,
  className,
  children,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(s.button, s[variant], busy && s.busy, className)}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest["aria-disabled"] || undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {busy && <LoaderCircle size={18} className={s.spinner} aria-hidden="true" />}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

type ButtonLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  variant?: ButtonVariant;
};

/** a link that looks like a button, for moves to another screen */
export function ButtonLink({ href, variant = "secondary", className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link href={href} className={cx(s.button, s[variant], className)} {...rest}>
      {children}
    </Link>
  );
}

/** a plain link that looks like a button, for other apps (sms:, tel:) that next/link must not route */
export function ButtonAnchor({ href, variant = "secondary", className, children, ...rest }: ButtonLinkProps) {
  return (
    <a href={href} className={cx(s.button, s[variant], className)} {...rest}>
      {children}
    </a>
  );
}

/** the stack of choices under a question: primary first, then secondary, then quiet */
export function Actions({ children }: { children: ReactNode }) {
  return <div className={s.actions}>{children}</div>;
}

/** secondary choices side by side when there is room */
export function Choices({ children }: { children: ReactNode }) {
  return <div className={s.choices}>{children}</div>;
}

/** a short muted line, e.g. "You'll read the message before anything is sent." */
export function Note({ children, align = "center" }: { children: ReactNode; align?: "center" | "start" }) {
  return <p className={cx(s.note, align === "start" && s.noteStart)}>{children}</p>;
}

/** a calm confirmation of what just happened, shown above the next question */
export function Receipt({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <p className={s.receipt}>
      {icon ?? <Check size={18} aria-hidden="true" />}
      <span>{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------- the big question

type QuestionProps = {
  /** the muted context before the ask, e.g. "Your shift on Tuesday is during the care week." */
  lead?: ReactNode;
  /** the ask, in ink */
  children: ReactNode;
  /** moves focus to the heading when it mounts; give the Question a new key per step */
  autoFocusOnMount?: boolean;
  id?: string;
  ref?: Ref<HTMLHeadingElement>;
};

export function Question({ lead, children, autoFocusOnMount = false, id, ref }: QuestionProps) {
  const own = useRef<HTMLHeadingElement | null>(null);

  const setRef = useCallback(
    (node: HTMLHeadingElement | null) => {
      own.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as { current: HTMLHeadingElement | null }).current = node;
    },
    [ref],
  );

  useEffect(() => {
    const node = own.current;
    if (!autoFocusOnMount || !node) return;
    const box = node.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) window.scrollTo({ top: 0 });
    node.focus({ preventScroll: true });
    // only on mount: a new step is a new key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <h1 ref={setRef} id={id} tabIndex={-1} className={s.question}>
      {lead && (
        <>
          <span className={s.questionLead}>{lead}</span>{" "}
        </>
      )}
      {children}
    </h1>
  );
}

// ---------------------------------------------------------------- column

type ColumnProps = {
  children: ReactNode;
  /** sits above the card on wide screens, e.g. a Progress */
  before?: ReactNode;
  /** how many steps are still behind this one; draws up to two edges under the card on wide screens */
  remaining?: number;
  /** slides the card in when it mounts; give the Column a new key per step */
  motion?: "forward" | "back" | null;
  /** "wide" gives an overview screen up to 960px of content; one-question steps keep the 560px default */
  width?: "regular" | "wide";
};

/** the one centred column (560px of content); a raised card on wide screens, the whole page on phones */
export function Column({ children, before, remaining = 0, motion = null, width = "regular" }: ColumnProps) {
  return (
    <div className={s.lane}>
      <div className={cx(s.column, width === "wide" && s.columnWide)}>
        {before && <div className={s.before}>{before}</div>}
        <div className={s.deck}>
          <div className={cx(s.card, motion === "forward" && s.enterForward, motion === "back" && s.enterBack)}>
            {children}
          </div>
          {remaining > 0 && <span aria-hidden="true" className={s.edge} />}
          {remaining > 1 && <span aria-hidden="true" className={cx(s.edge, s.edgeBack)} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- progress

type ProgressProps = {
  total: number;
  /** 0-based index of the step on screen; a value of total or more means every step is behind */
  current: number;
  /** one label per step, read by screen readers */
  labels: string[];
  /** which steps are finished; defaults to every step before current */
  done?: boolean[];
  /** replaces the "2 of 6" text */
  countText?: string;
  /** shows a Back button on the left */
  onBack?: () => void;
  backLabel?: string;
  /** names the list of steps for screen readers */
  label?: string;
};

/** for real sequences only */
export function Progress({
  total,
  current,
  labels,
  done,
  countText,
  onBack,
  backLabel = "Back",
  label = "Steps",
}: ProgressProps) {
  const count = countText ?? (current >= total ? `${total} of ${total}` : `${current + 1} of ${total}`);
  return (
    <div className={s.progress}>
      <div className={s.progressRow}>
        {onBack ? (
          <button type="button" className={s.back} onClick={onBack}>
            <ChevronLeft size={18} aria-hidden="true" />
            {backLabel}
          </button>
        ) : (
          <span />
        )}
        <span className={s.count}>{count}</span>
      </div>
      <ol className={s.segments} style={{ "--rr-steps": Math.max(total, 1) } as CSSProperties} aria-label={label}>
        {Array.from({ length: total }, (_, i) => {
          const finished = done ? Boolean(done[i]) : i < current;
          const now = i === current;
          return (
            <li key={i} className={cx(s.segment, finished && s.segmentDone, now && s.segmentNow)}>
              <span className={s.srOnly}>
                {labels[i] ?? `Step ${i + 1}`}
                {now ? ", on screen now" : ""}
                {finished ? ", done" : ", not done yet"}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- small pieces

export function StatePill({ state }: { state: RequestState }) {
  return <span className={cx(s.pill, s[`pill_${stateTone(state)}`])}>{STATE_LABEL[state]}</span>;
}

/** the same pill with a tone and words of its own, for statuses that are not request states (text delivery) */
export function TonePill({ tone, children }: { tone: StateTone; children: ReactNode }) {
  return <span className={cx(s.pill, s[`pill_${tone}`])}>{children}</span>;
}

// muted tones, each 5.5:1 or more against white initials
const AVATAR_TONES = ["#46597F", "#2F6B57", "#8C4A5E", "#7A5A1E", "#5B5F6B", "#5C6630"];

function initials(name: string) {
  const words = name.split(/\s+/).filter((word) => word && !/^(dr|mr|mrs|ms|prof)\.?$/i.test(word));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

function toneFor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/** initials in a circle; decorative, so always put the name in text next to it */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      className={cx(s.avatar, size === "sm" && s.avatarSm)}
      style={{ backgroundColor: toneFor(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function ErrorNote({
  message,
  onRetry,
  retryLabel = "Try again",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={s.error} role="alert">
      <p className={s.errorText}>
        <CircleAlert size={18} aria-hidden="true" />
        <span>{message}</span>
      </p>
      {onRetry && (
        <button type="button" className={s.errorRetry} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={s.srOnly}>{children}</span>;
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode;
  /** a short line under the label */
  hint?: ReactNode;
  /** the large calm field for a first answer */
  size?: "regular" | "large";
  ref?: Ref<HTMLTextAreaElement>;
};

export function TextArea({ label, hint, size = "regular", id, className, ref, ...rest }: TextAreaProps) {
  const auto = useId();
  const fieldId = id ?? `rr-field-${auto}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <div className={s.field}>
      <label htmlFor={fieldId} className={s.label}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className={s.hint}>
          {hint}
        </p>
      )}
      <textarea
        {...rest}
        ref={ref}
        id={fieldId}
        aria-describedby={cx(hintId, rest["aria-describedby"]) || undefined}
        className={cx(s.textarea, size === "large" && s.textareaLarge, className)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- announcements

type Announcer = {
  announce: (message: string) => void;
  message: string;
  sheets: number;
  addSheet: () => () => void;
};

const AnnounceContext = createContext<Announcer | null>(null);

// how long a delivered announcement stays in the live region before it is cleared
const ANNOUNCE_CLEAR_MS = 1500;

/**
 * the polite live region. wrap the app in it once (the app layout does); call useAnnounce() anywhere inside.
 * while a Sheet is open the message is read from inside the sheet, because the page behind a modal is inert.
 */
export function LiveRegion({ children }: { children?: ReactNode }) {
  const [message, setMessage] = useState("");
  const [sheets, setSheets] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const clearTimer = useRef<number | undefined>(undefined);

  const announce = useCallback((next: string) => {
    window.clearTimeout(timer.current);
    window.clearTimeout(clearTimer.current);
    // clear first so the same sentence twice is read twice
    setMessage("");
    timer.current = window.setTimeout(() => {
      setMessage(next);
      // once read, the sentence goes, so a region that mounts or reappears later never repeats it
      clearTimer.current = window.setTimeout(() => setMessage(""), ANNOUNCE_CLEAR_MS);
    }, 80);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(clearTimer.current);
    },
    [],
  );

  // a sheet opening or closing moves where the message is read, so an earlier sentence is never re-read there.
  // a sentence still waiting on its 80ms timer is new, so it is kept and lands in whichever region is current.
  const addSheet = useCallback(() => {
    setMessage("");
    setSheets((n) => n + 1);
    return () => {
      setMessage("");
      setSheets((n) => Math.max(0, n - 1));
    };
  }, []);

  const value = useMemo(() => ({ announce, message, sheets, addSheet }), [announce, message, sheets, addSheet]);
  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <p aria-live="polite" className={s.srOnly}>
        {sheets === 0 ? message : ""}
      </p>
    </AnnounceContext.Provider>
  );
}

const silent = () => {};

/** returns announce(message): reads a short sentence to screen readers, e.g. "Sent to Dr. Brooks." */
export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext)?.announce ?? silent;
}

// ---------------------------------------------------------------- sheet

type SheetProps = {
  open: boolean;
  /** called for the close button, Escape and a tap on the backdrop */
  onClose: () => void;
  /** id of the heading inside the sheet; it gets focus when the sheet opens */
  labelledBy: string;
  children: ReactNode;
  closeLabel?: string;
};

/** a modal: a bottom sheet on phones, a centred dialog on wide screens. traps focus, closes on Escape */
export function Sheet({ open, onClose, labelledBy, children, closeLabel = "Close" }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closingFromProp = useRef(false);
  const pressedBackdrop = useRef(false);
  const announcer = useContext(AnnounceContext);
  const addSheet = announcer?.addSheet;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      document.documentElement.style.overflow = "hidden";
      const heading = document.getElementById(labelledBy);
      if (heading && dialog.contains(heading)) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }
    if (!open && dialog.open) {
      closingFromProp.current = true;
      dialog.close();
    }
    if (!open) document.documentElement.style.overflow = "";
    if (!open && returnTo.current) {
      const target = returnTo.current;
      returnTo.current = null;
      window.requestAnimationFrame(() => {
        // leave focus alone if the screen already moved it somewhere on purpose
        const active = document.activeElement;
        if (active && active !== document.body && !dialog.contains(active)) return;
        if (target.isConnected) target.focus();
        else document.querySelector<HTMLElement>("main h1[tabindex='-1']")?.focus();
      });
    }
  }, [open, labelledBy]);

  useEffect(() => {
    if (!open || !addSheet) return;
    return addSheet();
  }, [open, addSheet]);

  useEffect(() => () => void (document.documentElement.style.overflow = ""), []);

  return (
    <dialog
      ref={dialogRef}
      className={s.sheet}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (closingFromProp.current) {
          closingFromProp.current = false;
          return;
        }
        // the browser closed it on its own (for example a second Escape)
        if (open) onClose();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === dialogRef.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      {open && (
        <div className={s.sheetInner}>
          <button type="button" className={s.sheetClose} aria-label={closeLabel} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
          {children}
          <p aria-live="polite" className={s.srOnly}>
            {announcer?.message ?? ""}
          </p>
        </div>
      )}
    </dialog>
  );
}

/** the heading for a Sheet; give it the id you pass as labelledBy */
export function SheetTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} tabIndex={-1} className={s.sheetTitle}>
      {children}
    </h2>
  );
}
