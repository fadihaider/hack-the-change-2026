"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Clock3, Leaf, Mail, RefreshCw, RotateCcw } from "lucide-react";
import type { RequestView } from "@/lib/frontend/request-api.ts";
import {
  createLiveApi,
  formatAlberta,
  liveErrorMessage,
  type ClockView,
  type RecoverView,
} from "@/lib/frontend/live-api.ts";

const api = createLiveApi();

const GROUPS = [
  ["handled", "Handled"],
  ["waiting", "Waiting"],
  ["needsFollowUp", "Needs follow-up"],
  ["notSent", "Not sent"],
] as const;

const EVIDENCE: Record<RequestView["evidence"][number]["evidenceKind"], string> = {
  approval: "approval",
  gmail_message_id: "delivery record",
  link_click: "response link",
  user_manual: "manual update",
  scheduler: "deadline check",
  error: "error",
};

export default function LiveRecover({
  active,
  admin,
  appNow,
  simulated,
  onClock,
  onReview,
  notify,
}: {
  active: boolean;
  admin: boolean;
  appNow: number;
  simulated: boolean;
  onClock: (clock: ClockView) => void;
  onReview: () => void;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<RecoverView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // POST runs the owner's expiry sweep first, so a passed deadline shows as expired (PRD U6b)
  const load = useCallback(async () => {
    try {
      const result = await api.recoverRefresh();
      setData(result);
      setError("");
      return result;
    } catch (e) {
      setError(liveErrorMessage(e));
      return null;
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  async function run(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (e) {
      setError(liveErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const jump = (days: number) =>
    run(`jump-${days}`, async () => {
      const result = await api.jump(days);
      onClock(result);
      await load();
      const expired = result.expiredRequestIds.length;
      notify(
        `Simulated time moved ${days} ${days === 1 ? "day" : "days"} ahead. ${expired} ${expired === 1 ? "request" : "requests"} expired.`,
      );
    });

  const reset = () =>
    run("reset", async () => {
      onClock(await api.resetClock());
      await load();
      notify("The demo clock is back to real time.");
    });

  const groups = data?.groups;
  const total = groups
    ? GROUPS.reduce((sum, [key]) => sum + groups[key].length, 0)
    : 0;

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Find your way back.</h1>
          <p>
            A clear picture of what’s handled, what’s waiting, and what comes
            next.
          </p>
        </div>
        <span className="chapter">
          <Leaf size={17} /> RECOVER MODE
        </span>
      </div>
      <section className="clock-panel">
        <div>
          <Clock3 size={20} />
          <div>
            <strong>Demo clock</strong>
            <span>
              {formatAlberta(appNow)} · UTC−6 ·{" "}
              {simulated ? "simulated time" : "real time"}
            </span>
          </div>
        </div>
        <div className="clock-actions">
          {admin ? (
            <>
              <button
                className="secondary"
                disabled={busy !== null}
                onClick={() => void jump(1)}
              >
                +1 day
              </button>
              <button
                className="secondary"
                disabled={busy !== null}
                onClick={() => void jump(7)}
              >
                +7 days
              </button>
              <button
                className="icon-button"
                aria-label="Return the demo clock to real time"
                disabled={busy !== null || !simulated}
                onClick={() => void reset()}
              >
                <RotateCcw size={17} />
              </button>
            </>
          ) : (
            <span className="small-note">
              Only an admin account can move the demo clock.
            </span>
          )}
          <button
            className="icon-button"
            aria-label="Refresh recorded state"
            disabled={busy !== null}
            onClick={() => void run("refresh", async () => void (await load()))}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <div className="empty-state" role="status">
          Loading recorded requests…
        </div>
      )}
      {groups && (
        <div className="recover-summary">
          {GROUPS.map(([key, label], i) => (
            <div key={key}>
              <span className={`summary-dot dot-${i}`} />
              <strong>{groups[key].length}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
      {groups && total === 0 && groups.new.length === 0 && (
        <div className="empty-state">
          <Mail size={28} />
          <h3>A fresh start, with no claims made.</h3>
          <p>
            Prepare requests in Urgent to begin tracking. Sent never means
            accepted.
          </p>
          <button className="primary" onClick={onReview}>
            Start with Urgent <ArrowRight size={16} />
          </button>
        </div>
      )}
      {groups &&
        GROUPS.map(([key, label]) => {
          const rows = groups[key];
          if (!rows.length) return null;
          return (
            <section className="recover-group" key={key}>
              <h2>
                {label}
                <span>{rows.length}</span>
              </h2>
              {rows.map((r) => (
                <article className="panel recover-row" key={r.id}>
                  <div className="recover-row-title">
                    <span className={`state state-${r.state}`}>
                      {r.state.replaceAll("_", " ")}
                    </span>
                    <h3>{r.subject}</h3>
                    <p>
                      {r.recipient.name} · {r.recipient.email} · Respond by{" "}
                      {r.respondBy
                        ? formatAlberta(r.respondBy)
                        : "48 hours after sending"}
                    </p>
                    {r.proposedAt && (
                      <p>
                        Proposed time: {formatAlberta(r.proposedAt)}
                        {r.proposedNote ? ` · “${r.proposedNote}”` : ""}
                      </p>
                    )}
                    <details>
                      <summary>Recorded evidence ({r.evidence.length})</summary>
                      <ul>
                        {r.evidence.map((event) => (
                          <li key={event.id}>
                            {event.toState.replaceAll("_", " ")} ·{" "}
                            {EVIDENCE[event.evidenceKind]} ·{" "}
                            {formatAlberta(event.at)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                  {key === "notSent" &&
                    ["draft", "awaiting_approval", "approved"].includes(r.state) && (
                      <div className="response-controls">
                        <button className="text-button" onClick={onReview}>
                          Review request <ArrowRight size={16} />
                        </button>
                      </div>
                    )}
                </article>
              ))}
            </section>
          );
        })}
      {groups && groups.new.length > 0 && (
        <section className="recover-group">
          <h2>
            New <span>{groups.new.length}</span>
          </h2>
          {groups.new.map((c) => (
            <article className="panel" key={c.id}>
              <h3>{c.title ?? "Proposed time"}</h3>
              <p>
                {c.startsAt ? formatAlberta(c.startsAt) : "No time given"} ·
                created from a recipient’s response, awaiting your review
              </p>
            </article>
          ))}
        </section>
      )}
      <p className="small-note">
        States change only on recorded evidence: a delivery record, a response
        link, or a passed deadline in app time. Sent never means accepted.
      </p>
    </>
  );
}
