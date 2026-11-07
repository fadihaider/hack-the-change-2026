"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Clock3,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sprout,
} from "lucide-react";
import {
  apiErrorMessage,
  createRequestApi,
  RequestApiError,
  type RequestView,
} from "@/lib/frontend/request-api";

const api = createRequestApi();
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-CA", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Etc/GMT+6",
      }).format(new Date(value))
    : "48 hours after sending";
function group(state: RequestView["state"]) {
  if (state === "accepted" || state === "completed") return "Handled";
  if (state === "requested") return "Waiting";
  if (
    ["rejected", "failed", "expired", "needs_review", "sending"].includes(state)
  )
    return "Needs follow-up";
  return "Not sent";
}

export default function LiveRequests({ onBack }: { onBack: () => void }) {
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [appNow, setAppNow] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<"queue" | "recover">("queue");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<{
    id: string;
    subject: string;
    body: string;
    deadline: string;
  } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let disposed = false;
    api
      .list()
      .then((data) => {
        if (disposed) return;
        setRequests(data.requests);
        setAppNow(data.appNow);
        setReady(true);
      })
      .catch((e) => {
        if (!disposed) setError(apiErrorMessage(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function reload(recover = view === "recover") {
    setLoading(true);
    try {
      const data = await (recover ? api.refresh() : api.list());
      setRequests(data.requests);
      setAppNow(data.appNow);
      setReady(true);
      setError("");
    } catch (e) {
      setError(apiErrorMessage(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }
  async function action(
    id: string,
    work: () => Promise<unknown>,
    success: string,
    recoverAfter = false,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(id);
    setNotice("");
    try {
      const result = await work();
      setNotice(typeof result === "string" ? result : success);
      if (recoverAfter) setView("recover");
      await reload(recoverAfter || view === "recover");
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }
  const disabled = loading || pending !== null || Boolean(error);
  const rows =
    view === "queue"
      ? requests.filter((r) =>
          ["draft", "awaiting_approval", "approved", "needs_review"].includes(
            r.state,
          ),
        )
      : requests;
  return (
    <div className="live-workspace">
      <header className="live-header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          <Sprout size={25} /> reliefready<span className="brand-dot">.</span>
        </a>
        <button className="secondary" onClick={onBack}>
          <ArrowLeft size={15} /> Back to fictional demo
        </button>
      </header>
      <div className="page-heading">
        <div>
          <h1>Your live care workspace.</h1>
          <p>
            Signed-in account records only. Demo data never appears in this
            view.
          </p>
        </div>
        <span className="badge">
          <ShieldCheck size={14} />{" "}
          {ready
            ? "Server records"
            : loading
              ? "Checking connection"
              : "Service unavailable"}
        </span>
      </div>
      {error && (
        <div className="warning" role="alert">
          <strong>{error}</strong>
          <p>
            Actions are locked until the recorded state is refreshed. Nothing
            here sends automatically.
          </p>
        </div>
      )}
      {notice && (
        <div className="live-notice" role="status">
          {notice}
        </div>
      )}
      <div className="live-toolbar">
        <div className="tabs">
          <button
            aria-pressed={view === "queue"}
            onClick={() => {
              setView("queue");
              void reload(false).catch(() => {});
            }}
          >
            Approval queue
          </button>
          <button
            aria-pressed={view === "recover"}
            onClick={() => {
              setView("recover");
              void reload(true).catch(() => {});
            }}
          >
            Recover
          </button>
        </div>
        <button
          className="secondary"
          disabled={loading || pending !== null}
          onClick={() => void reload().catch(() => {})}
        >
          <RefreshCw size={15} /> Refresh recorded state
        </button>
      </div>
      {appNow && (
        <p className="small-note">
          <Clock3 size={13} /> App time: {time(appNow)} · UTC−6
        </p>
      )}
      {loading && (
        <div className="empty-state" role="status">
          Loading your recorded requests…
        </div>
      )}
      {!loading && !ready && (
        <div className="empty-state">
          <Mail size={28} />
          <h3>Your live workspace is not connected yet.</h3>
          <p>
            You can continue exploring the fictional demo while account access
            and services are prepared.
          </p>
          <button className="primary" onClick={onBack}>
            Return to demo <ArrowLeft size={16} />
          </button>
        </div>
      )}
      {!loading && ready && !rows.length && (
        <div className="empty-state">
          <Check size={26} />
          <h3>
            {view === "queue"
              ? "No requests need approval."
              : "No recorded requests yet."}
          </h3>
          <p>Only persisted records from your account will appear here.</p>
        </div>
      )}
      {!loading && (
        <div className="request-grid">
          {rows
            .slice()
            .sort((a, b) =>
              (a.respondBy ?? "9999").localeCompare(b.respondBy ?? "9999"),
            )
            .map((r) => (
              <article className="panel request-card" key={r.id}>
                <div className="request-top">
                  <span className="group-label">
                    {view === "recover" ? group(r.state) : r.action}
                  </span>
                  <span className={`state state-${r.state}`}>
                    {r.state.replaceAll("_", " ")}
                  </span>
                </div>
                <h2>{r.recipient.name}</h2>
                <span className="request-email">{r.recipient.email}</span>
                <div className="message-preview">
                  <strong>{r.subject}</strong>
                  <p>{r.body}</p>
                </div>
                <div className="request-meta">
                  <span>
                    <ShieldCheck size={13} /> {r.disclosureTier} disclosure ·
                    owner’s contact group
                  </span>
                  <span>
                    <Clock3 size={13} /> Respond by {time(r.respondBy)}
                  </span>
                </div>
                {r.healthTermsFound.length > 0 && (
                  <div className="warning">
                    Health terms: {r.healthTermsFound.join(", ")}
                    {r.state === "awaiting_approval" &&
                      r.disclosureTier !== "detailed" && (
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={overrides[r.id] ?? false}
                            onChange={(e) =>
                              setOverrides((p) => ({
                                ...p,
                                [r.id]: e.target.checked,
                              }))
                            }
                          />{" "}
                          I reviewed and explicitly allow this disclosure.
                        </label>
                      )}
                  </div>
                )}
                {editor?.id === r.id && (
                  <form
                    className="live-editor"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const changes = {
                        subject: editor.subject,
                        body: editor.body,
                        respondBy: editor.deadline
                          ? new Date(
                              `${editor.deadline}:00-06:00`,
                            ).toISOString()
                          : null,
                      };
                      void action(
                        r.id,
                        async () => {
                          const result = await api.edit(r.id, changes);
                          if (
                            result.request.state !== "awaiting_approval" ||
                            result.request.healthOverride
                          )
                            throw new RequestApiError("invalid_response", 502);
                          setEditor(null);
                          setOverrides((p) => ({ ...p, [r.id]: false }));
                        },
                        "Draft saved. Review the new content before approving.",
                      );
                    }}
                  >
                    <label>
                      Subject
                      <input
                        required
                        value={editor.subject}
                        onChange={(e) =>
                          setEditor({ ...editor, subject: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Message
                      <textarea
                        required
                        rows={6}
                        value={editor.body}
                        onChange={(e) =>
                          setEditor({ ...editor, body: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Response deadline (UTC−6)
                      <input
                        type="datetime-local"
                        value={editor.deadline}
                        onChange={(e) =>
                          setEditor({ ...editor, deadline: e.target.value })
                        }
                      />
                    </label>
                    <div className="request-actions">
                      <button
                        type="submit"
                        className="primary"
                        disabled={disabled}
                      >
                        Save & require approval
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEditor(null)}
                      >
                        Discard edits
                      </button>
                    </div>
                  </form>
                )}
                <div className="request-actions">
                  {["draft", "awaiting_approval", "needs_review"].includes(
                    r.state,
                  ) && (
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() =>
                        setEditor({
                          id: r.id,
                          subject: r.subject,
                          body: r.body,
                          deadline: r.respondBy
                            ? new Date(Date.parse(r.respondBy) - 6 * 3600000)
                                .toISOString()
                                .slice(0, 16)
                            : "",
                        })
                      }
                    >
                      Edit exact message
                    </button>
                  )}
                  {r.state === "awaiting_approval" && (
                    <button
                      className="primary"
                      disabled={
                        disabled ||
                        editor?.id === r.id ||
                        (r.disclosureTier !== "detailed" &&
                          r.healthTermsFound.length > 0 &&
                          !overrides[r.id])
                      }
                      onClick={() =>
                        void action(
                          r.id,
                          async () => {
                            const result = await api.approve(
                              r.id,
                              overrides[r.id],
                            );
                            if (result.request.state !== "approved")
                              throw new RequestApiError(
                                "invalid_response",
                                502,
                              );
                          },
                          "Exact saved message approved. It has not been sent.",
                        )
                      }
                    >
                      Approve exact saved message
                    </button>
                  )}
                  {r.state === "approved" && (
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={() =>
                        void action(
                          r.id,
                          async () => {
                            const result = await api.send(r.id);
                            if (result.state === "failed")
                              return "Email delivery was recorded as failed. No automatic retry will be attempted.";
                            if (result.state === "needs_review")
                              return "Nothing was sent. The request needs review before another approval.";
                          },
                          "Gmail delivery was recorded. This is still waiting for a recipient response.",
                          true,
                        )
                      }
                    >
                      Send approved email <Mail size={15} />
                    </button>
                  )}
                  {["awaiting_approval", "needs_review"].includes(r.state) && (
                    <button
                      className="text-button cancel"
                      disabled={disabled}
                      onClick={() =>
                        void action(
                          r.id,
                          async () => {
                            const result = await api.cancel(r.id);
                            if (result.request.state !== "cancelled")
                              throw new RequestApiError(
                                "invalid_response",
                                502,
                              );
                          },
                          "Request cancelled without sending.",
                        )
                      }
                    >
                      Cancel unsent request
                    </button>
                  )}
                </div>
                {r.proposedAt && (
                  <div className="message-preview">
                    <strong>Proposed time: {time(r.proposedAt)}</strong>
                    {r.proposedNote && <p>{r.proposedNote}</p>}
                  </div>
                )}
                <details className="live-evidence">
                  <summary>Recorded evidence ({r.evidence.length})</summary>
                  {r.evidence.map((event) => (
                    <div key={event.id}>
                      <strong>{event.toState.replaceAll("_", " ")}</strong> ·{" "}
                      {event.evidenceKind} · {time(event.at)}
                      {event.evidenceRef && <p>{event.evidenceRef}</p>}
                    </div>
                  ))}
                </details>
              </article>
            ))}
        </div>
      )}
      <footer className="page-footer">
        <span>
          <Sprout size={14} /> Approval first. Evidence always.
        </span>
        <span>
          Live endpoints and sign-in must be configured by the account owner.
        </span>
      </footer>
    </div>
  );
}
