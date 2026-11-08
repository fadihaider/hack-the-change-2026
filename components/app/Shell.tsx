"use client";
// the slim top bar: brand, the three areas, whose care week it is, and the demo/admin menu.
// the menu shows only in a demo run or for an admin, and says honestly what runs behind each feature (PRD 14, AC13).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, FastForward, RotateCcw } from "lucide-react";
import { formatAlberta, liveErrorMessage, modeLabels, type LiveMode } from "@/lib/frontend/live-api.ts";
import { recipientName, useApis, useSession } from "./session.tsx";
import { useAnnounce, weekRange } from "./ui.tsx";
import s from "./Shell.module.css";

const AREAS = [
  { href: "/urgent", label: "Urgent" },
  { href: "/care", label: "Care" },
  { href: "/recover", label: "Recover" },
] as const;

/** true when any adapter is a demo stand-in: rule-based ai, the local outbox, the seeded calendar or demo sign-in */
function isDemoRun(mode: LiveMode): boolean {
  return mode.ai === "demo" || mode.mail === "outbox" || mode.calendar === "seed" || mode.auth === "demo";
}

export function Shell({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const pathname = usePathname() ?? "/";
  const episode = session?.episode ?? null;
  const demo = session ? isDemoRun(session.mode) : false;
  const showMenu = session !== null && (session.admin || demo);

  return (
    <div className={s.shell}>
      <a className={s.skip} href="#main">
        Skip to content
      </a>
      <header className={s.bar}>
        <div className={`${s.barInner} ${episode ? "" : s.barBare}`}>
          <Link href="/" className={s.brand}>
            ReliefReady
          </Link>
          {episode && (
            <nav aria-label="Sections" className={s.nav}>
              {AREAS.map((area) => {
                const current = pathname === area.href || pathname.startsWith(`${area.href}/`);
                return (
                  <Link
                    key={area.href}
                    href={area.href}
                    className={s.navItem}
                    aria-current={current ? "page" : undefined}
                  >
                    {area.label}
                  </Link>
                );
              })}
            </nav>
          )}
          {episode && (
            <p className={s.dates}>
              <span className={s.datesLead}>Caring for </span>
              {recipientName(session)}, {weekRange(episode.startsOn, episode.endsOn)}
            </p>
          )}
          {showMenu && <DemoMenu demo={demo} />}
        </div>
      </header>
      <main id="main" tabIndex={-1} className={s.main}>
        {children}
      </main>
    </div>
  );
}

function DemoMenu({ demo }: { demo: boolean }) {
  const { session, reload } = useSession();
  const { live } = useApis();
  const announce = useAnnounce();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"jump" | "reset" | null>(null);
  const [status, setStatus] = useState("");
  // null until GET /api/clock answers; true when the demo clock has been moved away from real time
  const [simulated, setSimulated] = useState<boolean | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const statusHeadingId = useId();

  const appNow = session?.appNow ?? null;
  const admin = session?.admin ?? false;
  const outbox = session?.mode.mail === "outbox";

  // a moved clock reloads the session, so asking again on each new appNow keeps the marker true
  useEffect(() => {
    if (appNow === null) return;
    let active = true;
    live
      .clock()
      .then((clock) => {
        if (active) setSimulated(clock.offsetMilliseconds !== 0);
      })
      .catch(() => {
        if (active) setSimulated(null);
      });
    return () => {
      active = false;
    };
  }, [appNow, live]);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled])");
    (first ?? menuRef.current)?.focus();
    function onPointer(event: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function report(text: string) {
    setStatus(text);
    announce(text);
  }

  async function jump() {
    if (busy) return;
    setBusy("jump");
    try {
      const result = await live.jump(1);
      await reload();
      const expired = result.expiredRequestIds.length;
      const extra =
        expired === 0
          ? ""
          : ` ${expired} ${expired === 1 ? "message" : "messages"} ran out of time for a reply.`;
      report(`Moved forward a day. It’s now ${sentence(formatAlberta(result.appNow))}${extra}`);
    } catch (error) {
      report(liveErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (busy) return;
    setBusy("reset");
    try {
      const result = await live.resetClock();
      await reload();
      report(`Clock is back to real time. It’s ${sentence(formatAlberta(result.appNow))}`);
    } catch (error) {
      report(liveErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const labels = session ? modeLabels(session.mode, session.providers) : [];
  const timeLabel = simulated === true ? "Simulated time" : simulated === false ? "Real time" : "App time";

  return (
    <div className={s.demo} ref={wrapRef}>
      <button
        ref={toggleRef}
        type="button"
        className={`${s.demoToggle} ${simulated ? s.demoToggleSim : ""}`}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setStatus("");
          setOpen((value) => !value);
        }}
      >
        {demo ? "Demo" : "Admin"}
        {simulated && <span className={s.simText}>, simulated time</span>}
        <ChevronDown size={16} aria-hidden="true" className={s.demoChevron} />
      </button>
      <div id={menuId} ref={menuRef} tabIndex={-1} className={s.menu} hidden={!open}>
        {session && (
          <p className={s.menuTime}>
            {timeLabel} <time dateTime={session.appNow}>{formatAlberta(session.appNow)}</time>
          </p>
        )}
        {labels.length > 0 && (
          <div className={s.statusBlock}>
            <p id={statusHeadingId} className={s.menuHeading}>
              What’s running
            </p>
            <dl className={s.statusList} aria-labelledby={statusHeadingId}>
              {labels.map((label) => (
                <div key={label.key} className={s.statusRow}>
                  <dt>{label.name}</dt>
                  <dd>{label.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {(outbox || admin) && (
          <ul className={s.menuList} role="list">
            {outbox && (
              <li>
                <a
                  className={s.menuItem}
                  href="/outbox"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => report("The outbox opened in a new tab.")}
                >
                  <ExternalLink size={18} aria-hidden="true" />
                  Open the outbox
                </a>
              </li>
            )}
            {admin && (
              <li>
                <button type="button" className={s.menuItem} aria-busy={busy === "jump" || undefined} onClick={jump}>
                  <FastForward size={18} aria-hidden="true" />
                  {busy === "jump" ? "Moving time forward" : "Move time forward a day"}
                </button>
              </li>
            )}
            {admin && (
              <li>
                <button type="button" className={s.menuItem} aria-busy={busy === "reset" || undefined} onClick={reset}>
                  <RotateCcw size={18} aria-hidden="true" />
                  {busy === "reset" ? "Resetting the clock" : "Reset the clock"}
                </button>
              </li>
            )}
          </ul>
        )}
        {status && <p className={s.menuStatus}>{status}</p>}
      </div>
    </div>
  );
}

// "p.m." already ends a sentence; never write "p.m.."
function sentence(text: string) {
  return text.endsWith(".") ? text : `${text}.`;
}
