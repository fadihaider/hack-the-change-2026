"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CircleHelp,
  Clock3,
  FileText,
  Heart,
  MapPin,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import { DISCHARGE_SHEET, VOICE_NOTE } from "@/lib/ai/fixtures/rosa.ts";
import {
  addDaysTo,
  categoryLabel,
  createLiveApi,
  formatAlberta,
  formatDate,
  liveErrorMessage,
  rruleLabel,
  sourceLabel,
  type AskView,
  type CareFactView,
  type CareProfileView,
  type LiveEpisode,
  type TimelineView,
} from "@/lib/frontend/live-api.ts";
import Dictation from "./Dictation.tsx";

const api = createLiveApi();
const MAX_PDF_BYTES = 10 * 1024 * 1024 - 64 * 1024; // the 10 MiB request limit includes the multipart envelope
const TABS = [
  ["review", "Review facts"],
  ["timeline", "Day timeline"],
  ["ask", "Ask the profile"],
] as const;
type Tab = (typeof TABS)[number][0];

const STATUS_ORDER: Record<CareFactView["status"], number> = {
  conflicting: 0,
  suggested: 1,
  approved: 2,
  superseded: 3,
  rejected: 4,
};

function spanLabel(fact: CareFactView): string {
  if (fact.spanStart === null || fact.spanEnd === null) return "exact text from the source";
  return `characters ${fact.spanStart + 1} to ${fact.spanEnd} · exact text from the source`;
}

export default function LiveCare({
  active,
  today,
  episode,
  recipientName,
  notify,
}: {
  active: boolean;
  today: string;
  episode: LiveEpisode | null;
  recipientName: string;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("review");
  const [profile, setProfile] = useState<CareProfileView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"note" | "voice">("note");
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState("");
  const [modelNotes, setModelNotes] = useState<Record<string, string>>({});
  // a care period that starts later opens on its first day, where the routines begin
  const [date, setDate] = useState(() =>
    episode && episode.startsOn > today ? episode.startsOn : today,
  );
  const [timeline, setTimeline] = useState<TimelineView | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskView | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api.careProfile());
      setError("");
    } catch (e) {
      setError(liveErrorMessage(e));
    }
  }, []);
  const loadTimeline = useCallback(async (day: string) => {
    try {
      setTimeline(await api.timeline(day));
      setError("");
    } catch (e) {
      setError(liveErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) void loadProfile();
  }, [active, loadProfile]);
  // reminders are recomputed on load and every 30 seconds while the timeline is open (PRD C4)
  useEffect(() => {
    if (!active || tab !== "timeline") return;
    void loadTimeline(date);
    const timer = setInterval(() => void loadTimeline(date), 30000);
    return () => clearInterval(timer);
  }, [active, tab, date, loadTimeline]);

  const facts = (profile?.facts ?? [])
    .filter((f) => f.status !== "superseded" && f.status !== "rejected")
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const approved = facts.filter((f) => f.status === "approved").length;
  const pending = facts.filter(
    (f) => f.status === "suggested" || f.status === "conflicting",
  ).length;
  const conflicts = facts.filter((f) => f.status === "conflicting").length;
  const superseded = (profile?.facts ?? []).filter(
    (f) => f.status === "superseded",
  ).length;

  async function run(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(liveErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function afterSource(result: Awaited<ReturnType<typeof api.addCareText>>) {
    const notes: Record<string, string> = {};
    for (const c of result.conflicts) {
      if (c.modelNote) notes[c.factId] = c.modelNote;
    }
    setModelNotes((previous) => ({ ...previous, ...notes }));
    const parts = [
      `${result.facts.length} suggested ${result.facts.length === 1 ? "fact" : "facts"} added.`,
    ];
    if (result.conflicts.length)
      parts.push(
        `${result.conflicts.length} ${result.conflicts.length === 1 ? "conflict needs" : "conflicts need"} your choice.`,
      );
    if (result.droppedCount)
      parts.push(
        `${result.droppedCount} dropped because the wording was not in the source word for word.`,
      );
    parts.push("Nothing joins the profile until you approve it.");
    setSummary(parts.join(" "));
  }

  const addText = () =>
    run("note", async () => {
      const result = await api.addCareText(kind, note.trim());
      afterSource(result);
      setNote("");
      await loadProfile();
    });

  const upload = (file: File) =>
    run("pdf", async () => {
      if (file.type && file.type !== "application/pdf") {
        setError("Only PDF files can be uploaded here.");
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        setError("That file is too large. Upload a PDF under 10 MB.");
        return;
      }
      const result = await api.uploadCarePdf(file, file.name || "care-document.pdf");
      afterSource(result);
      await loadProfile();
    });

  const approve = (fact: CareFactView) =>
    run(fact.id, async () => {
      await api.approveFact(fact.id);
      notify("Fact approved. It now appears in the profile and timeline.");
      await loadProfile();
    });

  const keep = (fact: CareFactView) =>
    run(fact.id, async () => {
      const result = await api.resolveConflict(fact.id);
      notify(
        `Kept this version. ${result.superseded.length} other ${result.superseded.length === 1 ? "version was" : "versions were"} superseded.`,
      );
      await loadProfile();
    });

  const ask = () =>
    run("ask", async () => {
      const result = await api.ask(question.trim());
      setAnswer(result);
      if (result.openQuestionId) await loadProfile();
    });

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Care, one thing at a time.</h1>
          <p>
            A shared picture of {recipientName}’s day. Always in the original
            words.
          </p>
        </div>
        <span className="chapter">
          <Heart size={17} /> CARE MODE
        </span>
      </div>
      <div className="care-overview">
        <span className="recipient-avatar">
          {recipientName.charAt(0).toUpperCase()}
        </span>
        <div>
          <h2>{recipientName}’s care profile</h2>
          <span>
            Fictional care recipient · {approved} approved facts · {pending} to
            review
          </span>
        </div>
        <span className="badge">Suggested facts stay off the timeline</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="Care views">
        {TABS.map(([v, l], index) => (
          <button
            key={v}
            role="tab"
            id={`live-tab-${v}`}
            aria-controls={`live-panel-${v}`}
            aria-selected={tab === v}
            tabIndex={tab === v ? 0 : -1}
            onClick={() => setTab(v)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % 3
                  : event.key === "ArrowLeft"
                    ? (index + 2) % 3
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(TABS[next][0]);
              document.getElementById(`live-tab-${TABS[next][0]}`)?.focus();
            }}
          >
            {l}
            {v === "review" && <span>{pending}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`live-panel-${tab}`} aria-labelledby={`live-tab-${tab}`}>
        {tab === "review" && (
          <div className="two-column">
            <section>
              {conflicts > 0 && (
                <div className="conflict-banner">
                  <CircleHelp size={20} />
                  <div>
                    <strong>Two sources, two different instructions.</strong>
                    <p>
                      Choose the version to keep. Both stay off the timeline
                      until you decide.
                    </p>
                  </div>
                </div>
              )}
              {!profile && !error && (
                <div className="empty-state" role="status">
                  Loading the care profile…
                </div>
              )}
              {profile && facts.length === 0 && (
                <div className="empty-state">
                  <FileText size={26} />
                  <h3>No facts yet.</h3>
                  <p>
                    Add a note, a voice note transcript or a PDF. Each fact keeps
                    its exact wording and source.
                  </p>
                </div>
              )}
              <div className="fact-list">
                {facts.map((f) => (
                  <article
                    className={`panel fact-card ${f.status === "conflicting" ? "conflicting" : ""}`}
                    key={f.id}
                  >
                    <div className="request-top">
                      <span className="group-label">{categoryLabel(f.category)}</span>
                      <span className={`state state-${f.status}`}>{f.status}</span>
                    </div>
                    <blockquote>{f.textExact}</blockquote>
                    <div className="source">
                      <FileText size={13} /> {sourceLabel(f.sourceKind)} ·{" "}
                      {spanLabel(f)}
                    </div>
                    {f.events.map((e) => (
                      <p className="small-note" key={e.id}>
                        <Clock3 size={12} /> {e.title} ·{" "}
                        {formatAlberta(e.startsAt, "time")} · {rruleLabel(e.rrule)}{" "}
                        · timeline item {e.status}
                      </p>
                    ))}
                    {modelNotes[f.id] && (
                      <p className="small-note">
                        Model note (not verified): {modelNotes[f.id]}
                      </p>
                    )}
                    {f.status !== "approved" && (
                      <div className="request-actions">
                        <button
                          className="primary"
                          disabled={busy !== null}
                          onClick={() =>
                            void (f.status === "conflicting" ? keep(f) : approve(f))
                          }
                        >
                          <Check size={15} />{" "}
                          {f.status === "conflicting"
                            ? "Keep this version"
                            : "Approve fact"}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {profile && facts.length > 0 && pending === 0 && (
                <div className="inline-success">
                  <Check size={18} /> All current suggestions reviewed. Your
                  approved facts are ready.
                </div>
              )}
              {superseded > 0 && (
                <p className="small-note">
                  {superseded} superseded {superseded === 1 ? "fact is" : "facts are"}{" "}
                  kept for the record and stay off the timeline.
                </p>
              )}
            </section>
            <aside className="panel add-note">
              <span className="section-kicker">ADD A LITTLE CONTEXT</span>
              <h2>What should we know?</h2>
              <p className="muted">
                Use fictional notes only. The AI suggests facts; code keeps only
                wording found word for word in your source.
              </p>
              <fieldset className="kind-choice">
                <legend>Source type</legend>
                <label>
                  <input
                    type="radio"
                    name="care-kind"
                    checked={kind === "note"}
                    onChange={() => setKind("note")}
                  />{" "}
                  Typed note
                </label>
                <label>
                  <input
                    type="radio"
                    name="care-kind"
                    checked={kind === "voice"}
                    onChange={() => setKind("voice")}
                  />{" "}
                  Voice note transcript
                </label>
              </fieldset>
              <label>
                Care note
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="She likes a quiet room in the morning."
                  rows={6}
                />
              </label>
              <div className="sample-row">
                <Dictation
                  label="Dictate a voice note"
                  onText={(said) => {
                    setKind("voice");
                    setNote((previous) =>
                      previous.trim() ? `${previous.trim()} ${said}` : said,
                    );
                  }}
                />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setKind("voice");
                    setNote(VOICE_NOTE);
                  }}
                >
                  Sample voice note
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setKind("note");
                    setNote(DISCHARGE_SHEET);
                  }}
                >
                  Sample discharge text
                </button>
              </div>
              <button
                className="primary full"
                disabled={!note.trim() || busy !== null}
                onClick={() => void addText()}
              >
                <Plus size={16} />{" "}
                {busy === "note" ? "Reading the source…" : "Add suggestions"}
              </button>
              <div className="upload-row">
                <label className="upload-button">
                  <Upload size={17} />{" "}
                  {busy === "pdf" ? "Reading the PDF…" : "Upload a PDF"}
                  <input
                    type="file"
                    accept="application/pdf"
                    disabled={busy !== null}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void upload(file);
                    }}
                  />
                </label>
              </div>
              <p className="small-note">
                PDFs need a text layer and must be under 10 MB. Samples are
                fictional.
              </p>
              {summary && (
                <p className="live-notice" role="status">
                  {summary}
                </p>
              )}
            </aside>
          </div>
        )}

        {tab === "timeline" && (
          <section className="panel timeline-panel">
            <div className="section-heading">
              <div>
                <span className="section-kicker">
                  {formatDate(date).toUpperCase()} · ALBERTA TIME
                </span>
                <h2>A gentler rhythm.</h2>
              </div>
              <CalendarDays size={25} />
            </div>
            <div className="timeline-controls">
              <label>
                Day
                <input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value);
                  }}
                />
              </label>
              <button className="secondary" onClick={() => setDate(today)}>
                Today
              </button>
              <button
                className="secondary"
                onClick={() => setDate(addDaysTo(today, 1))}
              >
                Tomorrow
              </button>
              {episode && (
                <button
                  className="secondary"
                  onClick={() => setDate(episode.startsOn)}
                >
                  Care period start
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Refresh the timeline"
                onClick={() => void loadTimeline(date)}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            {timeline && timeline.reminders.length > 0 && (
              <div className="reminder-box" role="status">
                <strong>Due soon:</strong>{" "}
                {timeline.reminders
                  .map((r) => `${r.localTime} ${r.title}`)
                  .join(" · ")}
              </div>
            )}
            {timeline && timeline.items.length === 0 && (
              <div className="empty-state">
                <Clock3 size={26} />
                <h3>Nothing approved for this day.</h3>
                <p>
                  Approve a timed fact, resolve a conflict, or add an appointment
                  from Urgent to see it here.
                </p>
                <button className="secondary" onClick={() => setTab("review")}>
                  Review suggestions
                </button>
              </div>
            )}
            {timeline?.items.map((item) => {
              const key = `${item.eventId}-${item.startsAt}`;
              return (
                <article
                  className={`timeline-item ${done.includes(key) ? "finished" : item.highlight ? "due-soon" : ""}`}
                  key={key}
                >
                  <time dateTime={item.startsAt}>{item.localTime}</time>
                  <div className="timeline-dot" />
                  <div>
                    <span className="group-label">
                      {categoryLabel(item.category)} · {rruleLabel(item.rrule)}
                    </span>
                    <h3>{item.title}</h3>
                    {item.fullText && (
                      <details>
                        <summary>See original wording & source</summary>
                        <blockquote>{item.fullText}</blockquote>
                      </details>
                    )}
                    {item.locationText && (
                      <div className="logistics">
                        <MapPin size={16} />
                        <span>
                          {item.locationText} · Transit stops: unknown ·
                          Pharmacy hours: unknown · Accessibility: unknown
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    className="secondary"
                    onClick={() =>
                      setDone((p) =>
                        p.includes(key) ? p.filter((k) => k !== key) : [...p, key],
                      )
                    }
                  >
                    {done.includes(key) ? (
                      <>
                        <Check size={15} /> Done
                      </>
                    ) : (
                      "Mark done"
                    )}
                  </button>
                </article>
              );
            })}
            <p className="small-note">
              Only approved items appear here. Reminders are in-app only and use
              app time; items inside their reminder window are highlighted.
              Done marks stay in this browser.
            </p>
          </section>
        )}

        {tab === "ask" && (
          <section className="panel ask-panel">
            <span className="section-kicker">KEEP THE ORIGINAL WORDS CLOSE</span>
            <h2>What would you like to know?</h2>
            <p className="muted">
              Answers come only from approved facts, with their exact text. No
              clinical advice.
            </p>
            <form
              className="ask-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim()) void ask();
              }}
            >
              <label className="sr-only" htmlFor="live-question">
                Ask the approved care profile
              </label>
              <input
                id="live-question"
                value={question}
                maxLength={500}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Where are her spare glasses?"
              />
              <button
                className="primary"
                type="submit"
                disabled={!question.trim() || busy !== null}
              >
                {busy === "ask" ? "Checking…" : "Ask profile"} <ArrowRight size={17} />
              </button>
            </form>
            {answer && (
              <div className="answer" role="status">
                {answer.notFound ? (
                  <>
                    <h3>Not in profile.</h3>
                    <p>
                      {answer.openQuestionId
                        ? "An open question was saved for the caregiver."
                        : "Nothing in the approved profile answers this yet."}
                    </p>
                  </>
                ) : (
                  <>
                    {answer.answer && (
                      <>
                        <span className="group-label">
                          ANSWER FROM APPROVED FACTS
                        </span>
                        <p>{answer.answer}</p>
                      </>
                    )}
                    <span className="group-label">EXACT APPROVED FACTS</span>
                    {answer.citedFacts.map((f) => (
                      <div key={f.id}>
                        <blockquote>{f.textExact}</blockquote>
                        <p className="source">{categoryLabel(f.category)}</p>
                      </div>
                    ))}
                    {answer.healthNotice && (
                      <p className="warning">{answer.healthNotice}</p>
                    )}
                  </>
                )}
              </div>
            )}
            {profile && profile.openQuestions.length > 0 && (
              <div className="open-questions">
                <h3>Open questions</h3>
                {profile.openQuestions.map((q) => (
                  <p key={q.id}>
                    <CircleHelp size={15} /> {q.question}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
