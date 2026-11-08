"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  CalendarPlus,
  Check,
  Heart,
  ShieldCheck,
  Sprout,
  Users,
} from "lucide-react";
import {
  createLiveApi,
  DECISIONS,
  decisionLabels,
  formatAlberta,
  formatDate,
  liveErrorMessage,
  type CommitmentView,
  type Decision,
  type DecideView,
  type ImpactView,
  type IntakeView,
  type LiveEpisode,
  type LiveSession,
} from "@/lib/frontend/live-api.ts";
import Dictation from "./Dictation.tsx";
import LiveRequests from "./LiveRequests.tsx";
import SupportSidebar from "./SupportSidebar.tsx";

const api = createLiveApi();

// fictional persona statement; "tomorrow" puts all six seeded calendar events inside the window
const DEFAULT_STATEMENT =
  "My mom Rosa has day surgery tomorrow and I’ll be helping her at home for a week. Please handle what can be postponed and keep me from losing track.";

interface Choice {
  decision: Decision;
  /** "" lets the server pick: confirmed dependency, model dependency, organizer, then attendee */
  contactId: string;
  note: string;
}
interface Outcome {
  tone: "ok" | "warn";
  text: string;
}

const STEPS = ["Tell us what changed", "Make a little room", "Review & approve"];
const ICONS = [Users, BookOpen, Sprout, Heart];

function describe(result: DecideView): Outcome {
  const label = decisionLabels[result.commitment.decision];
  if (!result.request) {
    return { tone: "ok", text: `Saved as ${label}. No message will be drafted.` };
  }
  const who = `${result.request.recipient.name} (${result.request.recipient.email})`;
  if (result.existing) {
    return {
      tone: "ok",
      text: `An open request to ${who} already exists. Review it in the approval queue.`,
    };
  }
  const notes: string[] = [];
  if (result.approvalBlocked || result.editFlags.length > 0) {
    notes.push(
      `The draft needs your edit before approval (${result.editFlags.join(", ").replaceAll("_", " ") || "check flagged"}).`,
    );
  }
  if (result.request.healthTermsFound.length > 0) {
    notes.push(
      `Health terms flagged: ${result.request.healthTermsFound.join(", ")}.`,
    );
  }
  return {
    tone: notes.length ? "warn" : "ok",
    text: [
      `${label} draft for ${who} is in the approval queue. Nothing has been sent.`,
      ...notes,
    ].join(" "),
  };
}

function contactOptions(c: CommitmentView): { id: string; label: string }[] {
  const seen = new Set<string>();
  const options: { id: string; label: string }[] = [];
  for (const d of c.dependencies) {
    if (!d.contactId || seen.has(d.contactId)) continue;
    seen.add(d.contactId);
    options.push({
      id: d.contactId,
      label: `${d.toRef ?? "Contact"}${d.confirmed ? "" : " (unconfirmed link)"}`,
    });
  }
  return options;
}

export default function LiveUrgent({
  session,
  episode,
  onEpisode,
  step,
  setStep,
  onOpenGuide,
  onOpenRecover,
  onOpenCare,
  notify,
}: {
  session: LiveSession;
  episode: LiveEpisode | null;
  onEpisode: (episode: LiveEpisode) => void;
  step: number;
  setStep: (step: number) => void;
  onOpenGuide: () => void;
  onOpenRecover: () => void;
  onOpenCare: () => void;
  notify: (message: string) => void;
}) {
  const [statement, setStatement] = useState(DEFAULT_STATEMENT);
  const [intake, setIntake] = useState<IntakeView | null>(null);
  const [impact, setImpact] = useState<ImpactView | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [queueKey, setQueueKey] = useState(0);
  const outbox = session.mode.mail === "outbox";
  const recipientName =
    session.careRecipient?.displayName ??
    session.careRecipient?.alias ??
    "your person";

  async function runIntake() {
    if (!statement.trim()) {
      setError("Add a few words about what changed before continuing.");
      return;
    }
    setBusy("intake");
    setError("");
    try {
      const { result, episodeId } = await api.intake(statement.trim());
      setIntake(result);
      if (result.status === "ready" && episodeId) {
        onEpisode({
          id: episodeId,
          startsOn: result.startDate,
          endsOn: result.endDate,
        });
        setImpact(null);
        setChoices({});
        setOutcomes({});
      }
    } catch (e) {
      setError(liveErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function scan() {
    if (!episode) return;
    setBusy("impact");
    setError("");
    try {
      const result = await api.impact(episode.id);
      setImpact(result);
      setChoices(
        Object.fromEntries(
          result.commitments.map((c) => [
            c.id,
            {
              decision: c.forCareRecipient
                ? "keep"
                : (c.decision ?? c.suggestedAction ?? "keep"),
              contactId: "",
              note: "",
            },
          ]),
        ),
      );
      setOutcomes({});
      setStep(1);
    } catch (e) {
      setError(liveErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** one decision; the caller holds the busy flag */
  async function decide(c: CommitmentView): Promise<boolean> {
    const choice = choices[c.id];
    if (!choice) return false;
    try {
      const result = await api.decide({
        commitmentId: c.id,
        decision: choice.decision,
        ...(choice.contactId ? { contactId: choice.contactId } : {}),
        ...(choice.note.trim() ? { note: choice.note.trim() } : {}),
      });
      setOutcomes((previous) => ({
        ...previous,
        [c.id]: describe(result),
      }));
      const request = result.request;
      setImpact((previous) =>
        previous
          ? {
              ...previous,
              commitments: previous.commitments.map((k) =>
                k.id !== c.id
                  ? k
                  : {
                      ...k,
                      decision: result.commitment.decision,
                      requests:
                        request && !k.requests.some((r) => r.id === request.id)
                          ? [
                              {
                                id: request.id,
                                state: request.state,
                                contactId: request.recipient.contactId,
                              },
                              ...k.requests,
                            ]
                          : k.requests,
                    },
              ),
            }
          : previous,
      );
      return true;
    } catch (e) {
      setOutcomes((previous) => ({
        ...previous,
        [c.id]: { tone: "warn", text: liveErrorMessage(e) },
      }));
      return false;
    }
  }

  async function decideOne(c: CommitmentView) {
    setBusy(c.id);
    await decide(c);
    setBusy(null);
  }

  async function decideAll() {
    if (!impact) return;
    setBusy("all");
    let failed = 0;
    // one at a time, so the model quota and the double-click guard see a calm sequence
    for (const c of impact.commitments) {
      if (outcomes[c.id]?.tone === "ok" && c.decision === choices[c.id]?.decision) continue;
      if (!(await decide(c))) failed += 1;
    }
    setBusy(null);
    if (failed > 0) {
      setError(
        `${failed} ${failed === 1 ? "choice needs" : "choices need"} attention before drafts are ready.`,
      );
      return;
    }
    setError("");
    setQueueKey((k) => k + 1);
    setStep(2);
    notify("Drafts are ready for review. Nothing has been sent.");
  }

  async function addToTimeline(c: CommitmentView) {
    setBusy(c.id);
    try {
      const result = await api.addToTimeline(c.id);
      setOutcomes((previous) => ({
        ...previous,
        [c.id]: {
          tone: "ok",
          text: result.created
            ? `Added to ${recipientName}’s care timeline.`
            : `Already on ${recipientName}’s care timeline.`,
        },
      }));
    } catch (e) {
      setOutcomes((previous) => ({
        ...previous,
        [c.id]: { tone: "warn", text: liveErrorMessage(e) },
      }));
    } finally {
      setBusy(null);
    }
  }

  function setChoice(id: string, change: Partial<Choice>) {
    setChoices((previous) => ({
      ...previous,
      [id]: { ...previous[id], ...change },
    }));
  }

  const locked = busy !== null;
  const stepEnabled = (i: number) =>
    i === 0 || i === 2 || (i === 1 && impact !== null);

  return (
    <>
      <div className="page-heading">
        <div className="hero-content">
          <span className="hero-privacy">
            <ShieldCheck size={15} /> Nothing goes out without your say.
          </span>
          <h1>
            {step === 2 ? "A little room. Review each message." : "A little breathing room."}
          </h1>
          <p>
            {step === 2
              ? "The words are ready. Take your time, make them yours, and approve each message when you’re comfortable."
              : "When life changes suddenly, you don’t have to carry it all. Let’s make a little space for care, one thing at a time."}
          </p>
          <span className="hero-label">
            <Heart size={14} /> Here for {recipientName}. Here for you.
          </span>
        </div>
        <div className="hero-illustration" aria-hidden="true">
          <span className="hero-orbit" />
          <span className="hero-orbit second" />
          <span className="hero-heart">
            <Heart size={48} strokeWidth={1.2} />
          </span>
          <span className="hero-leaf">
            <Sprout size={24} strokeWidth={1.5} />
          </span>
        </div>
      </div>
      <div className="steps" aria-label="Urgent workflow">
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={step === i ? "step current" : "step"}
            onClick={() => {
              if (stepEnabled(i)) {
                if (i === 2) setQueueKey((k) => k + 1);
                setStep(i);
              }
            }}
            disabled={!stepEnabled(i) || locked}
            aria-current={step === i ? "step" : undefined}
          >
            <span>{step > i ? <Check size={14} /> : `0${i + 1}`}</span>
            {s}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {step === 0 && (
        <div className="two-column intake-layout">
          <section className="panel intake-panel">
            <div className="section-kicker">LET’S START WITH YOU</div>
            <h2>What’s going on?</h2>
            <p className="muted">
              A few words are enough. We’ll find the dates and ask if anything
              is unclear.
            </p>
            <label className="sr-only" htmlFor="live-intake">
              Tell us what changed
            </label>
            <textarea
              id="live-intake"
              className="intake-text"
              value={statement}
              maxLength={2000}
              onChange={(e) => setStatement(e.target.value)}
              rows={5}
            />
            <div className="input-toolbar">
              <span>
                <ShieldCheck size={14} /> Not added to the care profile
              </span>
              <Dictation
                label="Voice note (browser dictation)"
                onText={(said) =>
                  setStatement((previous) =>
                    previous.trim() ? `${previous.trim()} ${said}` : said,
                  )
                }
              />
            </div>
            {intake?.status === "needs_clarification" && (
              <div className="warning" role="alert">
                <strong>A quick question before we look ahead:</strong>
                <ul className="plain-list">
                  {intake.clarifyingQuestions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
                <p>Add the answer to your note above, then check again.</p>
              </div>
            )}
            {intake?.status === "ready" && episode && (
              <div className="intake-result" role="status">
                <div className="details-divider">
                  <span>WHAT WE UNDERSTOOD</span>
                </div>
                <dl className="fact-pairs">
                  <div>
                    <dt>Care period</dt>
                    <dd>
                      {formatDate(intake.startDate)} to{" "}
                      {formatDate(intake.endDate)}
                    </dd>
                  </div>
                  {intake.recipientAlias && (
                    <div>
                      <dt>Caring for</dt>
                      <dd>{intake.recipientAlias}</dd>
                    </div>
                  )}
                  {intake.reasonText && (
                    <div>
                      <dt>In your words</dt>
                      <dd>
                        “{intake.reasonText}” · shared only with contacts set
                        to detailed disclosure
                      </dd>
                    </div>
                  )}
                  {intake.helpRequested.length > 0 && (
                    <div>
                      <dt>You asked for</dt>
                      <dd>{intake.helpRequested.join("; ")}</dd>
                    </div>
                  )}
                </dl>
                {intake.clarifyingQuestions &&
                  intake.clarifyingQuestions.length > 0 && (
                    <p className="small-note">
                      Also worth checking: {intake.clarifyingQuestions.join(" ")}
                    </p>
                  )}
              </div>
            )}
            {!intake && episode && (
              <p className="small-note">
                Current care period: {formatDate(episode.startsOn)} to{" "}
                {formatDate(episode.endsOn)}. You can continue with it or
                describe a new change.
              </p>
            )}
            <div className="panel-bottom">
              <button
                className="secondary"
                onClick={() => void runIntake()}
                disabled={locked}
              >
                {busy === "intake"
                  ? "Reading your note…"
                  : intake
                    ? "Check again"
                    : "Check what changed"}
              </button>
              <button
                className="primary"
                onClick={() => void scan()}
                disabled={
                  locked ||
                  !episode ||
                  intake?.status === "needs_clarification"
                }
              >
                {busy === "impact"
                  ? "Looking at your calendar…"
                  : "Find what needs a little room"}{" "}
                <ArrowRight size={17} />
              </button>
            </div>
          </section>
          <SupportSidebar onOpenGuide={onOpenGuide} />
        </div>
      )}

      {step === 1 && impact && (
        <>
          <div className="section-heading">
            <div>
              <h2>Make a little room.</h2>
              <p className="muted">
                {session.mode.calendar === "seed"
                  ? "Seeded demo calendar"
                  : "Google Calendar"}{" "}
                · {formatDate(impact.episode.startsOn)} to{" "}
                {formatDate(impact.episode.endsOn)}. Choose what each commitment
                needs.
              </p>
            </div>
            <span className="badge">Read-only calendar</span>
          </div>
          {impact.modelStatus === "unavailable" && (
            <p className="warning" role="status">
              Suggestions are unavailable right now. The flags below come from
              calendar rules; choose each action yourself.
            </p>
          )}
          <div className="commitment-list">
            {!impact.commitments.length && (
              <div className="empty-state">
                <CalendarDays size={25} />
                <h3>No calendar events in this window.</h3>
                <p>Nothing needs a request. You can still open the care profile.</p>
              </div>
            )}
            {impact.commitments.map((c, i) => {
              const Icon = ICONS[i % ICONS.length];
              const choice = choices[c.id];
              const outcome = outcomes[c.id];
              const options = contactOptions(c);
              return (
                <article className="commitment live-commitment" key={c.id}>
                  <div className={`event-icon event-${i % 4}`}>
                    <Icon size={21} />
                  </div>
                  <div className="commitment-main">
                    <span className="tiny-label">
                      {formatAlberta(c.startsAt)}
                      {c.location ? ` · ${c.location}` : ""}
                    </span>
                    <h3>{c.title}</h3>
                    {c.ruleConflicts.map((reason) => (
                      <p key={reason}>Flagged by a calendar rule: {reason}</p>
                    ))}
                    <div className="badge-row">
                      {c.suggestedAction && !c.forCareRecipient && (
                        <span className="badge">
                          Suggested: {decisionLabels[c.suggestedAction]}
                        </span>
                      )}
                      {c.requests.map((r) => (
                        <span className={`state state-${r.state}`} key={r.id}>
                          Request {r.state.replaceAll("_", " ")}
                        </span>
                      ))}
                    </div>
                    {c.dependencies.length > 0 && (
                      <ul className="dependency-list" aria-label="People who may depend on this">
                        {c.dependencies.map((d) => (
                          <li key={d.id}>
                            <span
                              className={
                                d.confirmed ? "badge" : "badge badge-unconfirmed"
                              }
                            >
                              {d.confirmed ? "Confirmed" : "Unconfirmed"}
                            </span>{" "}
                            <strong>{d.toRef ?? "Someone"}</strong>
                            {d.toKind ? ` · ${d.toKind.replaceAll("_", " ")}` : ""}
                            <span className="small-note">
                              {d.origin === "model" ? "Model note" : "Note"}:{" "}
                              {d.evidence}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.forCareRecipient ? (
                      <p className="small-note">
                        This is {recipientName}’s own appointment, so it is kept.
                      </p>
                    ) : (
                      choice &&
                      ["notify", "reschedule", "extension", "coverage"].includes(
                        choice.decision,
                      ) && (
                        <>
                          <label className="recipient-select">
                            Who should receive it?
                            <select
                              value={choice.contactId}
                              onChange={(e) =>
                                setChoice(c.id, { contactId: e.target.value })
                              }
                            >
                              <option value="">
                                Suggested from the calendar
                              </option>
                              {options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <details className="draft-note">
                            <summary>Add a note for the draft</summary>
                            <label>
                              Note (optional, plain text)
                              <textarea
                                rows={2}
                                maxLength={500}
                                value={choice.note}
                                onChange={(e) =>
                                  setChoice(c.id, { note: e.target.value })
                                }
                              />
                            </label>
                          </details>
                        </>
                      )
                    )}
                    {outcome && (
                      <p
                        className={outcome.tone === "ok" ? "live-notice" : "warning"}
                        role="status"
                      >
                        {outcome.text}
                      </p>
                    )}
                  </div>
                  <div className="live-commitment-actions">
                    <label className="action-select">
                      <span>YOUR CHOICE</span>
                      <select
                        value={choice?.decision ?? "keep"}
                        disabled={c.forCareRecipient}
                        onChange={(e) =>
                          setChoice(c.id, {
                            decision: e.target.value as Decision,
                          })
                        }
                      >
                        {DECISIONS.map((d) => (
                          <option key={d} value={d}>
                            {decisionLabels[d]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="secondary"
                      disabled={locked}
                      onClick={() => void decideOne(c)}
                    >
                      {busy === c.id ? "Saving…" : "Save choice"}
                    </button>
                    {c.forCareRecipient && (
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => void addToTimeline(c)}
                      >
                        Add to care timeline <CalendarPlus size={15} />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="small-note">
            Notify, reschedule, extension and coverage each become a draft in
            your approval queue. Defer and keep create no message. Unconfirmed
            links are model suggestions; check them before you rely on them.
          </p>
          <div className="flow-footer">
            <button className="text-button" onClick={() => setStep(0)} disabled={locked}>
              <ArrowLeft size={16} /> Back
            </button>
            <button className="primary" onClick={() => void decideAll()} disabled={locked}>
              {busy === "all"
                ? "Preparing drafts…"
                : "Save every choice & prepare drafts"}{" "}
              <ArrowRight size={17} />
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <div className="approval-layout">
          <section aria-label="Messages for your approval">
            <div className="section-heading">
              <div>
                <h2>Your approval queue</h2>
                <p className="muted">
                  Review the exact message and recipient before approving each
                  item.
                </p>
              </div>
              {outbox && (
                <a
                  className="secondary link-button"
                  href="/outbox"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open demo outbox <ArrowUpRight size={15} />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </div>
            {outbox && (
              <p className="small-note">
                Sending saves the message in the local demo outbox; no real
                email leaves this machine. Open the outbox, click a response
                link as the recipient, then choose Refresh recorded state here
                to see Waiting, Accepted or Declined.
              </p>
            )}
            <LiveRequests key={queueKey} embedded mail={session.mode.mail} />
            <div className="flow-footer">
              <button
                className="text-button"
                onClick={() => setStep(impact ? 1 : 0)}
              >
                <ArrowLeft size={16} /> Back to commitments
              </button>
              <button className="secondary" onClick={onOpenRecover}>
                See what’s handled <ArrowRight size={17} />
              </button>
            </div>
          </section>
          <SupportSidebar onOpenGuide={onOpenGuide} />
        </div>
      )}

      <section className="bottom-strip">
        <span className="strip-icon">
          <Heart size={19} />
        </span>
        <div>
          <strong>Care for {recipientName}. A little room for you.</strong>
          <p>
            Keep their routines and instructions in one place, with the original
            wording close by.
          </p>
        </div>
        <button className="text-button" onClick={onOpenCare}>
          Open care profile <ArrowRight size={17} />
        </button>
      </section>
    </>
  );
}
