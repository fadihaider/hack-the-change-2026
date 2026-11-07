"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpen,
  CalendarDays,
  Check,
  CircleHelp,
  Clock3,
  FileText,
  Heart,
  Leaf,
  Mail,
  MapPin,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sprout,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  actionLabels,
  approveFact,
  approveRequest,
  BASE_TIME,
  commitments,
  contacts,
  createDrafts,
  editRequest,
  expireRequests,
  healthTerms,
  initialFacts,
  reviewGroup,
  simulateSend,
  type DemoContact,
  type DemoFact,
  type DemoRequest,
  type Tier,
} from "@/lib/demo/workflow";

import First72Guide from "./First72Guide";
import SupportSidebar from "./SupportSidebar";
import dynamic from "next/dynamic";
const LiveRequests = dynamic(() => import("./LiveRequests"));

type Mode = "urgent" | "care" | "recover" | "guide";
const dateLabel = (n: number) =>
  new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Etc/GMT+6",
  }).format(n);
const statusLabel = (s: string) => s.replaceAll("_", " ");
const episodeDate = (value: string) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? "Confirm dates"
    : new Intl.DateTimeFormat("en-CA", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(date);
};

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export default function ReliefReady() {
  const [showLive, setShowLive] = useState(false);
  const [mode, setMode] = useState<Mode>("urgent");
  const [step, setStep] = useState(0);
  const [intro, setIntro] = useState(
    "My mom has surgery Tuesday. I’ll be helping her at home for a week and need a little help keeping things together.",
  );
  const [name, setName] = useState("Mom");
  const [start, setStart] = useState("2026-11-10");
  const [end, setEnd] = useState("2026-11-17");
  const [circle, setCircle] = useState<DemoContact[]>(contacts);
  const [recipientIds, setRecipientIds] = useState<Record<string, string>>(
    Object.fromEntries(commitments.map((k) => [k.id, k.contactId])),
  );
  const [actions, setActions] = useState<Record<string, string>>(
    Object.fromEntries(commitments.map((k) => [k.id, k.suggested])),
  );
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [now, setNow] = useState(BASE_TIME);
  const [jumped, setJumped] = useState(false);
  const [toast, setToast] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [facts, setFacts] = useState<DemoFact[]>(initialFacts);
  const [careTab, setCareTab] = useState<"review" | "timeline" | "ask">(
    "review",
  );
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("preference");
  const [noteTime, setNoteTime] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<DemoFact[] | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [proposing, setProposing] = useState<string | null>(null);
  const [newCommitments, setNewCommitments] = useState<
    { title: string; at: string; note: string }[]
  >([]);
  const [appointment, setAppointment] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const effectiveRequests = expireRequests(requests, now);
  const selected = effectiveRequests.find((r) => r.id === editing);
  const approved = facts.filter((f) => f.status === "approved");
  const pending = facts.filter(
    (f) => f.status === "suggested" || f.status === "conflicting",
  );
  const conflicts = facts.filter((f) => f.status === "conflicting");
  const requestCount = effectiveRequests.filter(
    (r) => r.state === "awaiting_approval",
  ).length;
  const [validation, setValidation] = useState("");
  const scanCommitments = commitments.filter(
    (k) => k.date >= start && k.date <= end,
  );
  const today = new Date(now - 6 * 3600000).toISOString().slice(0, 10);
  const dueSoon = (time: string) => {
    const due = Date.parse(`${today}T${time}:00-06:00`);
    return due >= now && due - now <= 30 * 60000;
  };

  useEffect(() => {
    const timer = setInterval(() => setNow((n) => n + 30000), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  function update(id: string, fn: (r: DemoRequest) => DemoRequest) {
    setRequests((prev) =>
      expireRequests(prev, now).map((r) => (r.id === id ? fn(r) : r)),
    );
  }
  function advance() {
    if (!intro.trim() || !name.trim() || !start || !end || start > end) {
      setValidation(
        "Add a note, a name, and a valid date range before continuing.",
      );
      return;
    }
    setValidation("");
    setStep(1);
  }
  function draftMessages() {
    if (
      effectiveRequests.some(
        (r) => !["draft", "awaiting_approval", "cancelled"].includes(r.state),
      )
    ) {
      setToast(
        "Your existing requests are preserved. Review or reset the demo before starting a new scan.",
      );
      setStep(2);
      return;
    }
    const next = createDrafts(actions, circle, now, {
      start,
      end,
      recipientIds,
    }).map((r) => ({
      ...r,
      body: r.body.replace("November 10 to 17", `${start} to ${end}`),
    }));
    setRequests(next);
    setStep(2);
    setToast(`${next.length} fixture drafts ready. Nothing has been sent.`);
  }
  function respond(
    id: string,
    state: "accepted" | "rejected" | "needs_review",
  ) {
    update(id, (r) =>
      r.state === "requested"
        ? {
            ...r,
            state,
            history: [...r.history, `Simulated recipient response: ${state}`],
          }
        : r,
    );
  }
  function addNote() {
    if (!note.trim()) return;
    const lines = note
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const stamp = Date.now();
    setFacts((prev) => [
      ...prev,
      ...lines.map((text, i) => ({
        id: `note-${stamp}-${i}`,
        text,
        category,
        source: `Typed demo note · line ${i + 1}`,
        status: "suggested" as const,
        time: noteTime || undefined,
      })),
    ]);
    setNote("");
    setToast(
      "Exact note lines added as suggestions. Review each before it joins the profile.",
    );
  }
  function ask() {
    if (!question.trim()) return;
    const words =
      question
        .toLowerCase()
        .match(/[a-z]{4,}/g)
        ?.filter(
          (w) =>
            ![
              "what",
              "does",
              "when",
              "with",
              "have",
              "should",
              "would",
              "about",
              "there",
            ].includes(w),
        ) ?? [];
    const matches = approved.filter((f) =>
      words.some((w) => f.text.toLowerCase().includes(w)),
    );
    setAnswer(matches);
    if (!matches.length)
      setQuestions((prev) =>
        prev.includes(question.trim()) ? prev : [...prev, question.trim()],
      );
  }
  function reset() {
    setRequests([]);
    setFacts(initialFacts);
    setNow(BASE_TIME);
    setJumped(false);
    setStep(0);
    setMode("urgent");
    setCircle(contacts);
    setDone([]);
    setNewCommitments([]);
    setAppointment(false);
    setQuestions([]);
    setAnswer(null);
    setIntro(
      "My mom has surgery Tuesday. I’ll be helping her at home for a week and need a little help keeping things together.",
    );
    setName("Mom");
    setStart("2026-11-10");
    setEnd("2026-11-17");
    setActions(Object.fromEntries(commitments.map((k) => [k.id, k.suggested])));
    setRecipientIds(
      Object.fromEntries(commitments.map((k) => [k.id, k.contactId])),
    );
    setNote("");
    setNoteTime("");
    setQuestion("");
    setCareTab("review");
    setToast("Demo reset. All changes existed only in this browser session.");
  }
  function nav(m: Mode) {
    setMode(m);
    setValidation("");
  }

  if (showLive) return <LiveRequests onBack={() => setShowLive(false)} />;

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
            <span>Caring for {name || "your person"}</span>
            <span className="care-context-dates">
              {episodeDate(start)} – {episodeDate(end)}
            </span>
          </div>
          <div className="header-actions">
            <span className="demo-pill">
              <span />
              Test mode · no live sends
            </span>
            <div
              className="caregiver-avatar"
              aria-label="Alex Parker, fictional demo persona"
            >
              AP
            </div>
            <span className="caregiver-name">
              Alex<small>Demo persona (fictional)</small>
            </span>
          </div>
        </div>
      </header>

      <div className="workspace">
        <div className="workspace-toolbar">
          <nav className="workspace-nav" aria-label="Main navigation">
            <button
              className={mode === "urgent" ? "nav-item active" : "nav-item"}
              aria-current={mode === "urgent" ? "page" : undefined}
              onClick={() => nav("urgent")}
            >
              <Sparkles size={19} />
              <span>Urgent</span>
              {requestCount > 0 && (
                <span className="nav-count">{requestCount}</span>
              )}
            </button>
            <button
              className={mode === "care" ? "nav-item active" : "nav-item"}
              aria-current={mode === "care" ? "page" : undefined}
              onClick={() => nav("care")}
            >
              <Heart size={19} />
              <span>Care</span>
            </button>
            <button
              className={mode === "recover" ? "nav-item active" : "nav-item"}
              aria-current={mode === "recover" ? "page" : undefined}
              onClick={() => nav("recover")}
            >
              <Leaf size={19} />
              <span>Recover</span>
            </button>
            <button
              className={mode === "guide" ? "nav-item active" : "nav-item"}
              aria-current={mode === "guide" ? "page" : undefined}
              onClick={() => nav("guide")}
            >
              <BookOpen size={19} />
              <span>Support guide</span>
            </button>
          </nav>
          <div className="workspace-tools">
            <span className="workspace-location">
              <MapPin size={14} /> Calgary, Alberta
            </span>
            <button className="text-button" onClick={() => setShowLive(true)}>
              Open live workspace <ArrowRight size={15} />
            </button>
          </div>
        </div>
        <main id="main" tabIndex={-1}>
          <div className="eyebrow">
            <span className="sun-dot" /> HERE FOR YOU, ALEX{" "}
            <span className="date">
              {dateLabel(now)} · UTC−6
              {jumped ? " · simulated time" : " · demo clock"}
            </span>
          </div>

          {mode === "urgent" && (
            <>
              <div className="page-heading">
                <div className="hero-content">
                  <span className="hero-privacy">
                    <ShieldCheck size={15} /> Nothing goes out without your say.
                  </span>
                  <h1>
                    {step === 2 && effectiveRequests.length > 0
                      ? `A little room. ${requestCount} ${requestCount === 1 ? "message" : "messages"} to review.`
                      : "A little breathing room."}
                  </h1>
                  <p>
                    {step === 2
                      ? "The words are ready. Take your time, make them yours, and approve each message when you’re comfortable."
                      : "When life changes suddenly, you don’t have to carry it all. Let’s make a little space for care, one thing at a time."}
                  </p>
                  <span className="hero-label">
                    <Heart size={14} /> Here for {name || "your person"}. Here
                    for you.
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
                {[
                  "Tell us what changed",
                  "Make a little room",
                  "Review & approve",
                ].map((s, i) => (
                  <button
                    key={s}
                    className={step === i ? "step current" : "step"}
                    onClick={() => {
                      if (i <= step) setStep(i);
                    }}
                    disabled={i > step}
                    aria-current={step === i ? "step" : undefined}
                  >
                    <span>{step > i ? <Check size={14} /> : `0${i + 1}`}</span>
                    {s}
                  </button>
                ))}
              </div>
              {step === 0 && (
                <div className="two-column intake-layout">
                  <section className="panel intake-panel">
                    <div className="section-kicker">LET’S START WITH YOU</div>
                    <h2>What’s going on?</h2>
                    <p className="muted">
                      A few words are enough. You can figure out the rest as you
                      go.
                    </p>
                    <label className="sr-only" htmlFor="intake">
                      Tell us what changed
                    </label>
                    <textarea
                      id="intake"
                      className="intake-text"
                      value={intro}
                      onChange={(e) => setIntro(e.target.value)}
                      rows={5}
                    />
                    <div className="input-toolbar">
                      <span>
                        <ShieldCheck size={14} /> Not added to the care profile
                      </span>
                      <button
                        className="text-button"
                        onClick={() =>
                          setToast(
                            "Voice transcription is not connected in test mode. You can type your note here.",
                          )
                        }
                      >
                        <AudioLines size={16} /> Voice note
                      </button>
                    </div>
                    <div className="details-divider">
                      <span>CONFIRM A FEW DETAILS</span>
                    </div>
                    <div className="episode-fields">
                      <label>
                        Who are you caring for?
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          maxLength={80}
                        />
                      </label>
                      <label>
                        From
                        <input
                          type="date"
                          value={start}
                          onChange={(e) => setStart(e.target.value)}
                        />
                      </label>
                      <label>
                        Through
                        <input
                          type="date"
                          value={end}
                          min={start}
                          onChange={(e) => setEnd(e.target.value)}
                        />
                      </label>
                    </div>
                    {validation && (
                      <p className="error" role="alert">
                        {validation}
                      </p>
                    )}
                    <div className="panel-bottom">
                      <span>Confirm the dates before we look ahead.</span>
                      <button className="primary" onClick={advance}>
                        Find what needs a little room <ArrowRight size={17} />
                      </button>
                    </div>
                  </section>
                  <SupportSidebar onOpenGuide={() => nav("guide")} />
                </div>
              )}

              {step === 1 && (
                <>
                  <div className="section-heading">
                    <div>
                      <h2>Make a little room.</h2>
                      <p className="muted">
                        Fixture calendar · {start} through {end}. Choose what
                        each commitment needs.
                      </p>
                    </div>
                    <span className="badge">Read-only calendar preview</span>
                  </div>
                  <div className="commitment-list">
                    {!scanCommitments.length && (
                      <div className="empty-state">
                        <CalendarDays size={25} />
                        <h3>No fixture events in this window.</h3>
                        <p>
                          The demo calendar contains events November 10 to 13.
                          Live Google Calendar is not connected.
                        </p>
                      </div>
                    )}
                    {scanCommitments.map((k, i) => (
                      <article className="commitment" key={k.id}>
                        <div className={`event-icon event-${i}`}>
                          {i === 0 ? (
                            <Users size={21} />
                          ) : i === 1 ? (
                            <BookOpen size={21} />
                          ) : i === 2 ? (
                            <Sprout size={21} />
                          ) : (
                            <Heart size={21} />
                          )}
                        </div>
                        <div className="commitment-main">
                          <span className="tiny-label">
                            {k.day} · {k.time} · {k.group}
                          </span>
                          <h3>{k.title}</h3>
                          <p>{k.reason}</p>
                          {k.contactId && (
                            <label className="recipient-select">
                              Confirm recipient
                              <select
                                value={recipientIds[k.id]}
                                onChange={(e) =>
                                  setRecipientIds((prev) => ({
                                    ...prev,
                                    [k.id]: e.target.value,
                                  }))
                                }
                              >
                                {circle.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name} · {c.email}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                        <label className="action-select">
                          <span>YOUR CHOICE</span>
                          <select
                            value={actions[k.id]}
                            onChange={(e) =>
                              setActions((prev) => ({
                                ...prev,
                                [k.id]: e.target.value,
                              }))
                            }
                          >
                            {Object.entries(actionLabels).map(([v, l]) => (
                              <option
                                key={v}
                                value={v}
                                disabled={
                                  !k.contactId && v !== "keep" && v !== "defer"
                                }
                              >
                                {l}
                              </option>
                            ))}
                          </select>
                        </label>
                        {i === 3 && (
                          <button
                            className="text-button"
                            onClick={() => {
                              setAppointment(true);
                              setToast(
                                "Fixture appointment added to the care timeline.",
                              );
                            }}
                          >
                            Add to care <Plus size={15} />
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                  <section className="panel circle-panel">
                    <div className="section-heading">
                      <div>
                        <h2>Your circle</h2>
                        <p className="muted">
                          Confirm who to contact, and how much you want to
                          share.
                        </p>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => setAddingContact(true)}
                      >
                        <Plus size={16} /> Add contact
                      </button>
                    </div>
                    <div className="contact-grid">
                      {circle.map((c) => (
                        <div className="contact" key={c.id}>
                          <span className="avatar small">
                            {c.name.charAt(0)}
                          </span>
                          <div>
                            <strong>{c.name}</strong>
                            <span>{c.email}</span>
                            <small>{c.group} · Gmail email</small>
                          </div>
                          <label>
                            <span className="sr-only">
                              Disclosure for {c.name}
                            </span>
                            <select
                              value={c.tier}
                              onChange={(e) =>
                                setCircle((prev) =>
                                  prev.map((p) =>
                                    p.id === c.id
                                      ? { ...p, tier: e.target.value as Tier }
                                      : p,
                                  ),
                                )
                              }
                            >
                              <option value="minimal">Minimal</option>
                              <option value="general">General</option>
                              <option value="detailed">Detailed</option>
                            </select>
                          </label>
                        </div>
                      ))}
                    </div>
                    <p className="small-note">
                      Minimal shares the caregiving situation and dates. General
                      may add the relationship. Detailed can include your exact
                      stated reason. Demo drafts start with minimal wording.
                    </p>
                  </section>
                  <div className="flow-footer">
                    <button className="text-button" onClick={() => setStep(0)}>
                      <ArrowLeft size={16} /> Back
                    </button>
                    <button className="primary" onClick={draftMessages}>
                      Confirm recipients & prepare drafts{" "}
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
                          Review the exact message and recipient before
                          approving each item.
                        </p>
                      </div>
                      <span className="badge">
                        <ShieldCheck size={14} /> Approval first, always
                      </span>
                    </div>
                    {!effectiveRequests.length && (
                      <div className="empty-state">
                        <Check size={28} />
                        <h3>Nothing to send.</h3>
                        <p>You chose to keep or defer your commitments.</p>
                      </div>
                    )}
                    <div className="request-grid approval-list">
                      {effectiveRequests.map((r, index) => (
                        <article className="panel request-card" key={r.id}>
                          <div className="request-top">
                            <span className="group-label">
                              Message {String(index + 1).padStart(2, "0")} ·{" "}
                              {r.group}
                            </span>
                            <span className={`state state-${r.state}`}>
                              {statusLabel(r.state)}
                            </span>
                          </div>
                          <div className="request-recipient">
                            <span
                              className="recipient-symbol"
                              aria-hidden="true"
                            >
                              {r.group === "Work" ? (
                                <Users size={23} />
                              ) : r.group === "School" ? (
                                <BookOpen size={23} />
                              ) : (
                                <Mail size={23} />
                              )}
                            </span>
                            <div>
                              <h3>{r.recipient}</h3>
                              <span className="request-email">{r.email}</span>
                            </div>
                          </div>
                          <div className="message-preview">
                            <span className="message-label">
                              Your message preview
                            </span>
                            <strong>{r.subject}</strong>
                            <p>{r.body}</p>
                          </div>
                          <div className="request-meta">
                            <span>
                              <ShieldCheck size={13} /> {r.tier} disclosure
                            </span>
                            <span>
                              <Clock3 size={13} /> Respond by{" "}
                              {dateLabel(Date.parse(r.deadline))}
                            </span>
                          </div>
                          {healthTerms(`${r.subject} ${r.body}`).length > 0 && (
                            <p className="warning">
                              Health terms found:{" "}
                              {healthTerms(`${r.subject} ${r.body}`).join(", ")}
                              . Review the disclosure before approval.
                            </p>
                          )}
                          <div className="request-actions">
                            {[
                              "awaiting_approval",
                              "approved",
                              "needs_review",
                            ].includes(r.state) && (
                              <button
                                className="secondary"
                                onClick={() => setEditing(r.id)}
                              >
                                {r.state === "approved"
                                  ? "Revise & reapprove"
                                  : "Edit & review"}
                              </button>
                            )}
                            {r.state === "awaiting_approval" && (
                              <button
                                className="primary"
                                disabled={
                                  r.tier !== "detailed" &&
                                  healthTerms(`${r.subject} ${r.body}`).length >
                                    0 &&
                                  !r.override
                                }
                                onClick={() => {
                                  const next = approveRequest(r);
                                  update(r.id, () => next);
                                  if (next.state !== "approved")
                                    setToast(
                                      "Check the recipient email, message content and disclosure before approval.",
                                    );
                                }}
                              >
                                <Check size={15} /> Approve exact message
                              </button>
                            )}
                            {r.state === "approved" && (
                              <button
                                className="primary"
                                onClick={() => {
                                  update(r.id, simulateSend);
                                  setToast(
                                    "Demo delivery simulated. No email was sent.",
                                  );
                                }}
                              >
                                Simulate delivery <ArrowRight size={15} />
                              </button>
                            )}
                            {r.state === "requested" && (
                              <span className="small-note">
                                Waiting for a simulated response in Recover.
                              </span>
                            )}
                          </div>
                          {[
                            "awaiting_approval",
                            "approved",
                            "needs_review",
                          ].includes(r.state) && (
                            <button
                              className="text-button cancel"
                              onClick={() =>
                                update(r.id, (q) => ({
                                  ...q,
                                  state: "cancelled",
                                  history: [
                                    ...q.history,
                                    "Cancelled by demo user",
                                  ],
                                }))
                              }
                            >
                              Cancel request
                            </button>
                          )}
                        </article>
                      ))}
                    </div>
                    <div className="flow-footer">
                      <button
                        className="text-button"
                        onClick={() => setStep(1)}
                      >
                        <ArrowLeft size={16} /> Back to commitments
                      </button>
                      <button
                        className="secondary"
                        onClick={() => nav("recover")}
                      >
                        See what’s handled <ArrowRight size={17} />
                      </button>
                    </div>
                  </section>
                  <SupportSidebar onOpenGuide={() => nav("guide")} />
                </div>
              )}
              <section className="bottom-strip">
                <span className="strip-icon">
                  <Heart size={19} />
                </span>
                <div>
                  <strong>
                    Care for {name || "your person"}. A little room for you.
                  </strong>
                  <p>
                    Keep their routines and instructions in one place, with the
                    original wording close by.
                  </p>
                </div>
                <button className="text-button" onClick={() => nav("care")}>
                  Open care profile <ArrowRight size={17} />
                </button>
              </section>
            </>
          )}

          {mode === "care" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Care, one thing at a time.</h1>
                  <p>
                    A shared picture of {name || "your person"}’s day. Always in
                    the original words.
                  </p>
                </div>
                <span className="chapter">
                  <Heart size={17} /> CARE MODE
                </span>
              </div>
              <div className="care-overview">
                <span className="recipient-avatar">M</span>
                <div>
                  <h2>{name || "Mom"}’s care profile</h2>
                  <span>
                    Fictional care recipient · {approved.length} approved facts
                    · {pending.length} to review
                  </span>
                </div>
                <span className="badge">
                  Suggested facts stay off the timeline
                </span>
              </div>
              <div className="tabs" role="tablist" aria-label="Care views">
                {(
                  [
                    ["review", "Review facts"],
                    ["timeline", "Day timeline"],
                    ["ask", "Ask the profile"],
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={v}
                    role="tab"
                    id={`tab-${v}`}
                    aria-controls={`panel-${v}`}
                    aria-selected={careTab === v}
                    tabIndex={careTab === v ? 0 : -1}
                    onClick={() => setCareTab(v)}
                    onKeyDown={(event) => {
                      const order = ["review", "timeline", "ask"] as const;
                      const index = order.indexOf(v);
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
                      setCareTab(order[next]);
                      document.getElementById(`tab-${order[next]}`)?.focus();
                    }}
                  >
                    {l}
                    {v === "review" && <span>{pending.length}</span>}
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id={`panel-${careTab}`}
                aria-labelledby={`tab-${careTab}`}
              >
                {careTab === "review" && (
                  <div className="two-column">
                    <section>
                      {conflicts.length > 0 && (
                        <div className="conflict-banner">
                          <CircleHelp size={20} />
                          <div>
                            <strong>Two sources, two different times.</strong>
                            <p>
                              Choose the breakfast instruction to keep. Both
                              stay off the timeline until you decide.
                            </p>
                          </div>
                        </div>
                      )}
                      <div className="fact-list">
                        {facts
                          .filter(
                            (f) =>
                              f.status !== "superseded" &&
                              f.status !== "rejected",
                          )
                          .map((f) => (
                            <article
                              className={`panel fact-card ${f.status === "conflicting" ? "conflicting" : ""}`}
                              key={f.id}
                            >
                              <div className="request-top">
                                <span className="group-label">
                                  {f.category}
                                </span>
                                <span className={`state state-${f.status}`}>
                                  {f.status}
                                </span>
                              </div>
                              <blockquote>{f.text}</blockquote>
                              <div className="source">
                                <FileText size={13} /> {f.source} · exact demo
                                source
                              </div>
                              {f.status !== "approved" && (
                                <div className="request-actions">
                                  <button
                                    className="primary"
                                    onClick={() =>
                                      setFacts((prev) =>
                                        approveFact(prev, f.id),
                                      )
                                    }
                                  >
                                    <Check size={15} />{" "}
                                    {f.status === "conflicting"
                                      ? "Use this version"
                                      : "Approve fact"}
                                  </button>
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      setFacts((prev) =>
                                        prev.map((p) =>
                                          p.id === f.id
                                            ? { ...p, status: "rejected" }
                                            : p,
                                        ),
                                      )
                                    }
                                  >
                                    Reject
                                  </button>
                                </div>
                              )}
                            </article>
                          ))}
                      </div>
                      {!pending.length && (
                        <div className="inline-success">
                          <Check size={18} /> All current suggestions reviewed.
                          Your approved facts are ready.
                        </div>
                      )}
                    </section>
                    <aside className="panel add-note">
                      <span className="section-kicker">
                        ADD A LITTLE CONTEXT
                      </span>
                      <h2>What should we know?</h2>
                      <p className="muted">
                        Use fictional notes only. In this demo, each line
                        becomes an exact-text suggestion; no model is called.
                      </p>
                      <label>
                        Care note
                        <textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="She likes a quiet room in the morning."
                          rows={5}
                        />
                      </label>
                      <label>
                        Category
                        <select
                          value={category}
                          onChange={(e) => setCategory(e.target.value)}
                        >
                          {[
                            "routine",
                            "preference",
                            "communication",
                            "mobility",
                            "contacts",
                            "logistics",
                            "medical instruction as written",
                          ].map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Optional time
                        <input
                          type="time"
                          value={noteTime}
                          onChange={(e) => setNoteTime(e.target.value)}
                        />
                      </label>
                      <button
                        className="primary full"
                        disabled={!note.trim()}
                        onClick={addNote}
                      >
                        <Plus size={16} /> Add suggestions
                      </button>
                      <div className="upload-row">
                        <label className="upload-button">
                          <Upload size={17} /> Choose a demo PDF
                          <input
                            type="file"
                            accept="application/pdf"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f)
                                setToast(
                                  f.size > 10 * 1024 * 1024
                                    ? "PDF must be 10 MB or smaller."
                                    : `${f.name} selected locally. Upload and extraction are not connected; no facts were created.`,
                                );
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <button
                          className="secondary"
                          onClick={() =>
                            setToast(
                              "Voice recording and transcription are not connected. Typed notes work in this demo.",
                            )
                          }
                        >
                          <AudioLines size={17} /> Voice
                        </button>
                      </div>
                      <p className="small-note">
                        PDF and voice integrations are pending. Nothing is
                        uploaded in this demo.
                      </p>
                    </aside>
                  </div>
                )}
                {careTab === "timeline" && (
                  <section className="panel timeline-panel">
                    <div className="section-heading">
                      <div>
                        <span className="section-kicker">
                          {dateLabel(now).split(",")[0]} · SIMULATED DAY
                        </span>
                        <h2>A gentler rhythm.</h2>
                      </div>
                      <CalendarDays size={25} />
                    </div>
                    {approved.filter((f) => f.time).length === 0 &&
                      !appointment && (
                        <div className="empty-state">
                          <Clock3 size={26} />
                          <h3>Your day starts with approved facts.</h3>
                          <p>
                            Resolve the breakfast conflict or approve a timed
                            note to see it here.
                          </p>
                          <button
                            className="secondary"
                            onClick={() => setCareTab("review")}
                          >
                            Review suggestions
                          </button>
                        </div>
                      )}
                    {approved
                      .filter((f) => f.time)
                      .sort((a, b) =>
                        (a.time ?? "").localeCompare(b.time ?? ""),
                      )
                      .map((f) => (
                        <article
                          className={`timeline-item ${done.includes(f.id) ? "finished" : dueSoon(f.time!) ? "due-soon" : ""}`}
                          key={f.id}
                        >
                          <time>{f.time}</time>
                          <div className="timeline-dot" />
                          <div>
                            <span className="group-label">{f.category}</span>
                            <h3>{f.text}</h3>
                            <details>
                              <summary>See original wording & source</summary>
                              <blockquote>{f.text}</blockquote>
                              <p className="source">{f.source}</p>
                            </details>
                          </div>
                          <button
                            className="secondary"
                            onClick={() =>
                              setDone((p) =>
                                p.includes(f.id)
                                  ? p.filter((id) => id !== f.id)
                                  : [...p, f.id],
                              )
                            }
                          >
                            {done.includes(f.id) ? (
                              <>
                                <Check size={15} /> Done
                              </>
                            ) : (
                              "Mark done"
                            )}
                          </button>
                        </article>
                      ))}
                    {appointment && today === "2026-11-13" && (
                      <article className="timeline-item">
                        <time>11:00</time>
                        <div className="timeline-dot" />
                        <div>
                          <span className="group-label">
                            FRIDAY NOV 13 · FIXTURE APPOINTMENT
                          </span>
                          <h3>{name}’s follow-up appointment</h3>
                          <p>
                            Location not verified. Add a Calgary address when
                            location services are connected.
                          </p>
                          <div className="logistics">
                            <MapPin size={16} />
                            <span>
                              Transit stops: unknown · Pharmacy hours: unknown ·
                              Accessibility: unknown
                            </span>
                          </div>
                        </div>
                      </article>
                    )}
                    <p className="small-note">
                      Only approved facts appear here. Timed note entries are
                      treated as daily demo routines, with a 30-minute in-app
                      reminder window. This browser demo stores completion
                      locally in memory; it does not update Google Calendar.
                    </p>
                  </section>
                )}
                {careTab === "ask" && (
                  <section className="panel ask-panel">
                    <span className="section-kicker">
                      KEEP THE ORIGINAL WORDS CLOSE
                    </span>
                    <h2>What would you like to know?</h2>
                    <p className="muted">
                      Demo keyword lookup across approved facts only. No
                      clinical advice or generated answers.
                    </p>
                    <form
                      className="ask-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        ask();
                      }}
                    >
                      <label className="sr-only" htmlFor="question">
                        Ask the approved care profile
                      </label>
                      <input
                        id="question"
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        placeholder="What does she prefer at breakfast?"
                      />
                      <button className="primary" type="submit">
                        Ask profile <ArrowRight size={17} />
                      </button>
                    </form>
                    {answer && (
                      <div className="answer" role="status">
                        {answer.length ? (
                          <>
                            <span className="group-label">
                              EXACT APPROVED FACTS
                            </span>
                            {answer.map((f) => (
                              <div key={f.id}>
                                <blockquote>{f.text}</blockquote>
                                <p className="source">
                                  [{f.id}] {f.source}
                                </p>
                                {f.category ===
                                  "medical instruction as written" && (
                                  <p className="warning">
                                    For health questions call 811. Emergencies:
                                    911.
                                  </p>
                                )}
                              </div>
                            ))}
                          </>
                        ) : (
                          <>
                            <h3>This isn’t in the approved profile.</h3>
                            <p>
                              An open question has been saved for the caregiver
                              in this demo.
                            </p>
                          </>
                        )}
                      </div>
                    )}
                    {questions.length > 0 && (
                      <div className="open-questions">
                        <h3>Open questions</h3>
                        {questions.map((q, i) => (
                          <p key={i}>
                            <CircleHelp size={15} /> {q}
                          </p>
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </div>
            </>
          )}

          {mode === "recover" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Find your way back.</h1>
                  <p>
                    A clear picture of what’s handled, what’s waiting, and what
                    comes next.
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
                      {dateLabel(now)} · simulated time · browser demo admin
                    </span>
                  </div>
                </div>
                <div className="clock-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setNow((n) => n + 86400000);
                      setJumped(true);
                    }}
                  >
                    +1 day
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setNow((n) => n + 7 * 86400000);
                      setJumped(true);
                    }}
                  >
                    +7 days
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Reset the demo"
                    onClick={reset}
                  >
                    <RotateCcw size={17} />
                  </button>
                </div>
              </section>
              <div className="recover-summary">
                {["Handled", "Waiting", "Needs follow-up", "Not sent"].map(
                  (g, i) => (
                    <div key={g}>
                      <span className={`summary-dot dot-${i}`} />
                      <strong>
                        {
                          effectiveRequests.filter(
                            (r) => reviewGroup(r.state) === g,
                          ).length
                        }
                      </strong>
                      <span>{g}</span>
                    </div>
                  ),
                )}
              </div>
              {requests.length === 0 && (
                <div className="empty-state">
                  <Mail size={28} />
                  <h3>A fresh start, with no claims made.</h3>
                  <p>
                    Prepare requests in Urgent mode to begin tracking. Sent
                    never means accepted.
                  </p>
                  <button className="primary" onClick={() => nav("urgent")}>
                    Start with Urgent <ArrowRight size={16} />
                  </button>
                </div>
              )}
              {["Handled", "Waiting", "Needs follow-up", "Not sent"].map(
                (group) => {
                  const rows = effectiveRequests
                    .filter((r) => reviewGroup(r.state) === group)
                    .sort(
                      (a, b) => Date.parse(a.deadline) - Date.parse(b.deadline),
                    );
                  if (!rows.length) return null;
                  return (
                    <section className="recover-group" key={group}>
                      <h2>
                        {group}
                        <span>{rows.length}</span>
                      </h2>
                      {rows.map((r) => (
                        <article className="panel recover-row" key={r.id}>
                          <div className="recover-row-title">
                            <span className={`state state-${r.state}`}>
                              {statusLabel(r.state)}
                            </span>
                            <h3>{r.commitment}</h3>
                            <p>
                              {r.recipient} · Respond by{" "}
                              {dateLabel(Date.parse(r.deadline))}
                            </p>
                            <details>
                              <summary>Demo activity record</summary>
                              <ul>
                                {r.history.map((h, i) => (
                                  <li key={i}>{h}</li>
                                ))}
                              </ul>
                            </details>
                          </div>
                          <div className="response-controls">
                            {r.state === "requested" && (
                              <>
                                <span className="tiny-label">
                                  SIMULATE A RECIPIENT RESPONSE
                                </span>
                                <div>
                                  <button
                                    className="secondary"
                                    onClick={() => respond(r.id, "accepted")}
                                  >
                                    Accept
                                  </button>
                                  <button
                                    className="secondary"
                                    onClick={() => respond(r.id, "rejected")}
                                  >
                                    Decline
                                  </button>
                                  <button
                                    className="secondary"
                                    onClick={() => setProposing(r.id)}
                                  >
                                    Propose time
                                  </button>
                                </div>
                              </>
                            )}
                            {r.state === "accepted" && (
                              <button
                                className="secondary"
                                onClick={() =>
                                  update(r.id, (p) => ({
                                    ...p,
                                    state: "completed",
                                    history: [
                                      ...p.history,
                                      "Marked complete by demo user",
                                    ],
                                  }))
                                }
                              >
                                <Check size={16} /> Mark completed
                              </button>
                            )}
                            {[
                              "awaiting_approval",
                              "approved",
                              "needs_review",
                            ].includes(r.state) && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  nav("urgent");
                                  setStep(2);
                                }}
                              >
                                Review request <ArrowRight size={16} />
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                    </section>
                  );
                },
              )}
              {newCommitments.length > 0 && (
                <section className="recover-group">
                  <h2>
                    New <span>{newCommitments.length}</span>
                  </h2>
                  {newCommitments.map((c, i) => (
                    <article className="panel" key={i}>
                      <h3>{c.title}</h3>
                      <p>
                        Proposed {dateLabel(Date.parse(c.at))} · awaiting your
                        review
                      </p>
                      {c.note && <p>{c.note}</p>}
                      <span className="small-note">
                        Response note is plain text and is never sent to a
                        model.
                      </span>
                    </article>
                  ))}
                </section>
              )}
              <p className="small-note">
                All delivery and response records here are simulated. A live
                send will require a real Gmail message ID. No messages are sent
                from this demo.
              </p>
            </>
          )}

          {mode === "guide" && (
            <First72Guide
              onPrepareNotice={() => {
                const contact = circle.find((c) => c.group === "Work");
                if (!contact) {
                  setToast(
                    "Add a work contact in Urgent before preparing an employer notice.",
                  );
                  return;
                }
                setRequests((previous) => [
                  ...expireRequests(previous, now),
                  {
                    id: `notice-${Date.now()}`,
                    commitment: "Employer caregiving notice",
                    recipient: contact.name,
                    email: contact.email,
                    group: "Work",
                    tier: "minimal",
                    state: "awaiting_approval",
                    subject:
                      "Request to discuss time away for family responsibilities",
                    body: `Hi ${contact.name},\n\nI need to discuss time away from ${start} through ${end} for family responsibilities. Could we confirm the leave arrangements and any coverage needed?\n\nThank you,\nAlex`,
                    deadline: new Date(now + 48 * 3600000).toISOString(),
                    history: ["Employer notice prepared for review; not sent"],
                  },
                ]);
                setMode("urgent");
                setStep(2);
                setToast(
                  "Employer notice prepared. Review and approve the exact message before simulated delivery.",
                );
              }}
            />
          )}

          <footer className="page-footer">
            <span>
              <Sprout size={14} /> A little room for care.
            </span>
            <span>
              Fictional demo · changes reset on refresh · no live integrations
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CircleHelp size={18} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {selected && (
        <Modal
          title="Review the exact message"
          onClose={() => setEditing(null)}
        >
          <p className="muted">
            Changes reset approval. Delivery stays simulated in this demo.
          </p>
          <label>
            Recipient email
            <input
              type="email"
              value={selected.email}
              onChange={(e) =>
                update(selected.id, (r) =>
                  editRequest(r, { email: e.target.value }),
                )
              }
            />
          </label>
          <label>
            Subject
            <input
              value={selected.subject}
              onChange={(e) =>
                update(selected.id, (r) =>
                  editRequest(r, { subject: e.target.value }),
                )
              }
            />
          </label>
          <label>
            Message
            <textarea
              value={selected.body}
              rows={8}
              onChange={(e) =>
                update(selected.id, (r) =>
                  editRequest(r, { body: e.target.value }),
                )
              }
            />
          </label>
          <div className="form-two">
            <label>
              Disclosure tier
              <select
                value={selected.tier}
                onChange={(e) =>
                  update(selected.id, (r) =>
                    editRequest(r, { tier: e.target.value as Tier }),
                  )
                }
              >
                <option value="minimal">Minimal</option>
                <option value="general">General</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>
            <label>
              Respond by (UTC−6)
              <input
                type="datetime-local"
                value={new Date(Date.parse(selected.deadline) - 6 * 3600000)
                  .toISOString()
                  .slice(0, 16)}
                onChange={(e) => {
                  if (e.target.value)
                    update(selected.id, (r) =>
                      editRequest(r, {
                        deadline: new Date(
                          `${e.target.value}:00-06:00`,
                        ).toISOString(),
                      }),
                    );
                }}
              />
            </label>
          </div>
          {healthTerms(`${selected.subject} ${selected.body}`).length > 0 && (
            <div className="warning">
              <strong>
                Health terms:{" "}
                {healthTerms(`${selected.subject} ${selected.body}`).join(", ")}
              </strong>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selected.override ?? false}
                  onChange={(e) =>
                    update(selected.id, (r) => ({
                      ...r,
                      override: e.target.checked,
                      history: [
                        ...r.history,
                        `Disclosure override ${e.target.checked ? "enabled" : "removed"} by demo user`,
                      ],
                    }))
                  }
                />{" "}
                I reviewed and explicitly allow this disclosure.
              </label>
            </div>
          )}
          <button className="primary full" onClick={() => setEditing(null)}>
            Done reviewing <Check size={16} />
          </button>
        </Modal>
      )}
      {addingContact && (
        <Modal
          title="Add someone to your circle"
          onClose={() => setAddingContact(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              setCircle((p) => [
                ...p,
                {
                  id: `c-${Date.now()}`,
                  name: String(data.get("name")),
                  email: String(data.get("email")),
                  group: String(data.get("group")),
                  tier: "minimal",
                },
              ]);
              setAddingContact(false);
              setToast(
                "Contact added with minimal disclosure. Choose this contact in a commitment’s recipient selector.",
              );
            }}
          >
            <label>
              Name
              <input name="name" required maxLength={80} />
            </label>
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Group
              <select name="group">
                {["Work", "School", "Family", "Volunteer"].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <p className="small-note">
              Use fictional contacts only. No email is sent.
            </p>
            <button className="primary full" type="submit">
              Add contact <Plus size={16} />
            </button>
          </form>
        </Modal>
      )}
      {proposing && (
        <Modal
          title="Simulate a proposed time"
          onClose={() => setProposing(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const request = effectiveRequests.find((r) => r.id === proposing);
              if (request?.state === "requested") {
                respond(proposing, "needs_review");
                setNewCommitments((p) => [
                  ...p,
                  {
                    title: request.commitment,
                    at: new Date(`${data.get("at")}:00-06:00`).toISOString(),
                    note: String(data.get("note")),
                  },
                ]);
              }
              setProposing(null);
            }}
          >
            <p className="muted">
              Demo controls stand in for a recipient’s response page.
            </p>
            <label>
              Proposed date and time (UTC−6)
              <input type="datetime-local" name="at" required />
            </label>
            <label>
              Optional note
              <textarea name="note" maxLength={300} rows={3} />
            </label>
            <button type="submit" className="primary full">
              Record simulated proposal <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
