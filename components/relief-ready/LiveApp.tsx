"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CircleHelp,
  Clock3,
  Heart,
  Leaf,
  MapPin,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import {
  albertaDateOf,
  createLiveApi,
  formatAlberta,
  formatDate,
  modeLabels,
  type ClockView,
  type LiveEpisode,
  type LiveSession,
} from "@/lib/frontend/live-api.ts";
import LiveCare from "./LiveCare.tsx";
import LiveGuide from "./LiveGuide.tsx";
import LiveRecover from "./LiveRecover.tsx";
import LiveUrgent from "./LiveUrgent.tsx";

type Mode = "urgent" | "care" | "recover" | "guide";
const api = createLiveApi();
const DAY_MS = 86400000;

const NAV: { mode: Mode; label: string; icon: typeof Sparkles }[] = [
  { mode: "urgent", label: "Urgent", icon: Sparkles },
  { mode: "care", label: "Care", icon: Heart },
  { mode: "recover", label: "Recover", icon: Leaf },
  { mode: "guide", label: "Support guide", icon: BookOpen },
];

// live (local) mode: every screen reads and writes the local api; nothing here is a fixture
export default function LiveApp({
  session,
  onUseDemo,
}: {
  session: LiveSession;
  onUseDemo: () => void;
}) {
  const [mode, setMode] = useState<Mode>("urgent");
  const [visited, setVisited] = useState<Set<Mode>>(() => new Set(["urgent"]));
  const [urgentStep, setUrgentStep] = useState(0);
  const [episode, setEpisode] = useState<LiveEpisode | null>(session.episode);
  // display offset: app time minus this browser's clock; simulated: the server's demo clock offset
  const [displayOffset, setDisplayOffset] = useState(
    () => Date.parse(session.appNow) - Date.now(),
  );
  const [simulatedMs, setSimulatedMs] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [toast, setToast] = useState("");

  const appNow = tick + displayOffset;
  const today = albertaDateOf(appNow);
  const simulated = simulatedMs > 0;
  const recipientName =
    session.careRecipient?.displayName ??
    session.careRecipient?.alias ??
    "your person";
  const outbox = session.mode.mail === "outbox";

  function applyClock(clock: ClockView) {
    setDisplayOffset(Date.parse(clock.appNow) - Date.now());
    setSimulatedMs(clock.offsetMilliseconds);
    setTick(Date.now());
  }

  useEffect(() => {
    let disposed = false;
    api
      .clock()
      .then((clock) => {
        if (!disposed) applyClock(clock);
      })
      .catch(() => {
        // the session time still drives the display; the banner just stays hidden
      });
    const timer = setInterval(() => setTick(Date.now()), 30000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  function nav(next: Mode) {
    setMode(next);
    setVisited((previous) => new Set(previous).add(next));
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a
            href="#"
            className="brand"
            onClick={(e) => {
              e.preventDefault();
              nav("urgent");
            }}
          >
            <span className="brand-mark">
              R
              <span className="brand-dot" aria-hidden="true">
                •
              </span>
            </span>
            ReliefReady
          </a>
          <div className="care-context">
            <span className="context-dot" aria-hidden="true" />
            <span>Caring for {recipientName}</span>
            <span className="care-context-dates">
              {episode
                ? `${formatDate(episode.startsOn)} to ${formatDate(episode.endsOn)}`
                : "No care period yet"}
            </span>
          </div>
          <div className="header-actions">
            <span className="demo-pill live-pill">
              <span />
              Live (local) · {outbox ? "no real email" : "real email"}
            </span>
            <div
              className="caregiver-avatar"
              aria-label={
                session.mode.auth === "demo"
                  ? "Alex Parker, fictional demo persona"
                  : `Signed in as ${session.user.email}`
              }
            >
              AP
            </div>
            <span className="caregiver-name">
              Alex
              <small>
                {session.mode.auth === "demo"
                  ? "Demo persona (fictional)"
                  : session.user.email}
              </small>
            </span>
          </div>
        </div>
      </header>

      <div className="workspace">
        <div className="workspace-toolbar">
          <nav className="workspace-nav" aria-label="Main navigation">
            {NAV.map(({ mode: m, label, icon: Icon }) => (
              <button
                key={m}
                className={mode === m ? "nav-item active" : "nav-item"}
                aria-current={mode === m ? "page" : undefined}
                onClick={() => nav(m)}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="workspace-tools">
            <span className="workspace-location">
              <MapPin size={14} /> Calgary, Alberta
            </span>
            <button className="text-button" onClick={onUseDemo}>
              Switch to fictional demo <ArrowRight size={15} />
            </button>
          </div>
        </div>
        <section className="live-mode-strip" aria-label="Connected services">
          <span className="live-mode-title">
            <Server size={14} /> Live (local) mode
          </span>
          {modeLabels(session.mode).map((label) => (
            <span className="badge" key={label}>
              {label}
            </span>
          ))}
        </section>
        {simulated && (
          <div className="sim-banner" role="status">
            <Clock3 size={18} />
            <span>
              <strong>Simulated time.</strong> The demo clock is{" "}
              {Math.round(simulatedMs / DAY_MS)}{" "}
              {Math.round(simulatedMs / DAY_MS) === 1 ? "day" : "days"} ahead of
              real time. Deadlines, expiry and reminders use this app time.
            </span>
          </div>
        )}
        <main id="main" tabIndex={-1}>
          <div className="eyebrow">
            <span className="sun-dot" /> HERE FOR YOU, ALEX{" "}
            <span className="date">
              {formatAlberta(appNow)} · UTC−6 ·{" "}
              {simulated ? "simulated time" : "app time"}
            </span>
          </div>

          <div hidden={mode !== "urgent"}>
            <LiveUrgent
              session={session}
              episode={episode}
              onEpisode={setEpisode}
              step={urgentStep}
              setStep={setUrgentStep}
              onOpenGuide={() => nav("guide")}
              onOpenRecover={() => nav("recover")}
              onOpenCare={() => nav("care")}
              notify={setToast}
            />
          </div>
          {visited.has("care") && (
            <div hidden={mode !== "care"}>
              <LiveCare
                active={mode === "care"}
                today={today}
                episode={episode}
                recipientName={recipientName}
                notify={setToast}
              />
            </div>
          )}
          {visited.has("recover") && (
            <div hidden={mode !== "recover"}>
              <LiveRecover
                active={mode === "recover"}
                admin={session.admin}
                appNow={appNow}
                simulated={simulated}
                onClock={applyClock}
                onReview={() => {
                  setUrgentStep(2);
                  nav("urgent");
                }}
                notify={setToast}
              />
            </div>
          )}
          {visited.has("guide") && (
            <div hidden={mode !== "guide"}>
              <LiveGuide session={session} />
            </div>
          )}

          <footer className="page-footer">
            <span>
              <Heart size={14} /> A little room for care.
            </span>
            <span>
              Live (local) · fictional persona ·{" "}
              {outbox
                ? "messages stay in the local outbox"
                : "approved messages are sent by email"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CircleHelp size={18} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
