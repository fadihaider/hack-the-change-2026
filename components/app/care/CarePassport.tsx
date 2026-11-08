"use client";
// the care passport (PRD 5): seven collapsed sections of approved facts with provenance.
// only approved facts read as settled; suggestions, conflicts and open questions live in the last section.
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, CircleHelp, Clock, FileText, History } from "lucide-react";
import { liveErrorMessage, type CareFactView, type CareProfileView } from "@/lib/frontend/live-api.ts";
import { PASSPORT_SECTIONS, sectionOf, type PassportSectionId } from "@/lib/frontend/passport.ts";
import { isLockedWording } from "@/lib/care/lockedWording.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, Note, TextArea, VisuallyHidden, useAnnounce } from "../ui.tsx";
import { EmergencyHelp } from "./EmergencyHelp.tsx";
import { SourceSheet } from "./SourceSheet.tsx";
import {
  factSummary,
  openItems,
  passportGroups,
  plural,
  possessive,
  provenanceLine,
  shorten,
  timeLine,
  uniqueOpenQuestions,
  versionLabel,
  type ReviewStep,
} from "./care-data.ts";
import s from "./passport.module.css";

// matches the server's limit on one fact's wording
const MAX_FACT_CHARS = 1000;

export type CarePassportProps = {
  name: string;
  profile: CareProfileView;
  /** open the one-at-a-time review for these pending steps */
  onReview: (steps: ReviewStep[]) => void;
  /** reload the profile after an edit, reject or conflict resolution */
  onChanged: () => Promise<unknown>;
  /** open the add-a-note flow (used by the empty state and open questions) */
  onAdd: () => void;
};

export function CarePassport({ name, profile, onReview, onChanged, onAdd }: CarePassportProps) {
  const titleId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<PassportSectionId>>(() => new Set());
  const [sourceFact, setSourceFact] = useState<CareFactView | null>(null);

  const groups = passportGroups(profile.facts);
  const open = openItems(profile.facts);
  const questions = uniqueOpenQuestions(profile.openQuestions);
  const approved = groups.reduce((sum, group) => sum + group.facts.length, 0);
  const openCount = questions.length + open.conflicts.length + open.suggested;
  const empty = approved === 0 && open.steps.length === 0 && questions.length === 0;

  // a link to #fact-{id} (an Ask citation, for example) opens that fact's section and moves focus to it
  const factsRef = useRef(profile.facts);
  const focusFact = useRef<string | null>(null);
  useEffect(() => {
    factsRef.current = profile.facts;
  }, [profile.facts]);
  useEffect(() => {
    function follow() {
      const match = /^#fact-(.+)$/.exec(window.location.hash);
      if (!match) return;
      const id = decodeURIComponent(match[1]);
      const fact = factsRef.current.find((item) => item.id === id && item.status === "approved");
      if (!fact) return;
      focusFact.current = id;
      setExpanded((current) => new Set(current).add(sectionOf(fact.category)));
    }
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  // focus waits until the section holding the fact is open
  useEffect(() => {
    const id = focusFact.current;
    if (!id) return;
    focusFact.current = null;
    const row = document.getElementById(`fact-${id}`);
    row?.focus();
    row?.scrollIntoView({ block: "center" });
  }, [expanded]);

  function toggle(id: PassportSectionId) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const reviewLabel =
    open.conflicts.length > 0
      ? `Review ${plural(open.steps.length, "item", "items")}`
      : `Review ${plural(open.steps.length, "suggestion", "suggestions")}`;

  if (empty) {
    return (
      <section className={s.passport} aria-labelledby={titleId}>
        <h2 id={titleId} className={s.title}>
          Care passport
        </h2>
        <p className={s.empty}>
          Nothing is in {possessive(name)} passport yet. Start with what a helper would need to know on day one.
        </p>
        <div className={s.emptyAction}>
          <Button variant="primary" onClick={onAdd}>
            Tell ReliefReady about {name}
          </Button>
        </div>
      </section>
    );
  }

  const openSection = PASSPORT_SECTIONS.find((section) => section.id === "open");

  return (
    <section className={s.passport} aria-labelledby={titleId}>
      <div className={s.header}>
        <div className={s.headerText}>
          <h2 id={titleId} className={s.title}>
            Care passport
          </h2>
          <p className={s.hint}>Only what you’ve approved about {name}, word for word from your notes.</p>
        </div>
        {open.steps.length > 0 && (
          <Button variant="secondary" className={s.headerButton} onClick={() => onReview(open.steps)}>
            {reviewLabel}
          </Button>
        )}
      </div>

      <div className={s.list}>
        {groups.map(({ section, facts }) => (
          <Accordion
            key={section.id}
            id={section.id}
            title={section.title}
            count={`${facts.length} approved`}
            hint={section.hint}
            expanded={expanded.has(section.id)}
            onToggle={() => toggle(section.id)}
          >
            {section.id === "contacts" && (
              <div className={s.inlineHelp}>
                <EmergencyHelp name={name} placement="inline" level={4} />
              </div>
            )}
            {facts.length === 0 ? (
              <p className={s.none}>Nothing approved here yet.</p>
            ) : (
              <ul className={s.facts} role="list">
                {facts.map((fact) => (
                  <PassportFact
                    key={fact.id}
                    fact={fact}
                    earlier={earlierVersions(fact, profile.facts)}
                    onSource={setSourceFact}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            )}
          </Accordion>
        ))}

        {openSection && (
          <Accordion
            id="open"
            title={openSection.title}
            count={openCount === 0 ? "nothing open" : `${openCount} open`}
            hint={openSection.hint}
            expanded={expanded.has("open")}
            onToggle={() => toggle("open")}
          >
            <OpenItemsPanel
              name={name}
              questions={questions}
              conflicts={open.conflicts}
              suggested={open.suggested}
              onReviewSuggested={() => onReview(open.steps.filter((step) => step.kind === "fact"))}
              onAdd={onAdd}
              onChanged={onChanged}
            />
          </Accordion>
        )}
      </div>

      <SourceSheet fact={sourceFact} onClose={() => setSourceFact(null)} />
    </section>
  );
}

// ---------------------------------------------------------------- one section

type AccordionProps = {
  id: PassportSectionId;
  title: string;
  count: string;
  hint: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
};

function Accordion({ id, title, count, hint, expanded, onToggle, children }: AccordionProps) {
  const auto = useId();
  const buttonId = `${auto}-button`;
  const panelId = `passport-${id}`;
  return (
    <div className={s.accordion}>
      <h3 className={s.accordionHeading}>
        <button
          type="button"
          id={buttonId}
          className={s.accordionButton}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className={s.accordionTitle}>
            {title} <span className={s.count}>({count})</span>
          </span>
          <ChevronDown size={20} className={s.chevron} aria-hidden="true" />
        </button>
      </h3>
      <div id={panelId} className={s.panel} hidden={!expanded} aria-labelledby={buttonId} role="group">
        <p className={s.panelHint}>{hint}</p>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one approved fact

type FactProps = {
  fact: CareFactView;
  /** the versions this fact replaced, newest first; empty for an original */
  earlier: CareFactView[];
  onSource: (fact: CareFactView) => void;
  onChanged: () => Promise<unknown>;
};

/** the earlier versions an edited fact replaced, newest first, by following supersedes back to the original */
function earlierVersions(fact: CareFactView, facts: CareFactView[]): CareFactView[] {
  if (fact.version <= 1 || !fact.supersedes) return [];
  const byId = new Map(facts.map((item) => [item.id, item]));
  const chain: CareFactView[] = [];
  const seen = new Set([fact.id]);
  let previous = byId.get(fact.supersedes);
  while (previous && previous.status === "superseded" && !seen.has(previous.id)) {
    chain.push(previous);
    seen.add(previous.id);
    previous = previous.supersedes ? byId.get(previous.supersedes) : undefined;
  }
  return chain;
}

function PassportFact({ fact, earlier, onSource, onChanged }: FactProps) {
  const { live } = useApis();
  const announce = useAnnounce();
  const fullId = useId();
  const editRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [showFull, setShowFull] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const earlierId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.textExact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // medication, dose and wound wording is locked whatever its category (PRD 15): never shortened, never edited here
  const written = isLockedWording(fact.category, fact.textExact);
  const summary = written ? fact.textExact : factSummary(fact);
  const when = timeLine(fact);
  const version = versionLabel(fact);
  const named = shorten(summary, 48);

  useEffect(() => {
    if (editing) fieldRef.current?.focus();
  }, [editing]);

  function startEdit() {
    setDraft(fact.textExact);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
    window.requestAnimationFrame(() => editRef.current?.focus());
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const value = draft.trim();
    if (!value) {
      setError("Write the wording first, or cancel.");
      fieldRef.current?.focus();
      return;
    }
    if (value.length > MAX_FACT_CHARS) {
      setError(`Keep it under ${MAX_FACT_CHARS} characters. Split longer notes into separate facts.`);
      fieldRef.current?.focus();
      return;
    }
    if (value === fact.textExact) {
      setError("Nothing changed yet. Change the wording, or cancel.");
      fieldRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { fact: saved } = await live.editFact(fact.id, value);
      announce(`Saved as version ${saved.version}. The earlier wording is kept.`);
      setEditing(false);
      await onChanged();
      window.requestAnimationFrame(() => document.getElementById(`fact-${saved.id}`)?.focus());
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li id={`fact-${fact.id}`} className={s.fact} tabIndex={-1}>
      {written && <p className={s.factLabel}>Written care instruction, exact wording</p>}
      <p className={written ? s.factExact : s.factText}>{summary}</p>

      {!written && summary !== fact.textExact && (
        <div className={s.full}>
          <button
            type="button"
            className={s.linkButton}
            aria-expanded={showFull}
            aria-controls={fullId}
            onClick={() => setShowFull((value) => !value)}
          >
            Full wording
            <ChevronDown size={16} className={s.chevron} aria-hidden="true" />
          </button>
          <blockquote id={fullId} className={s.fullWording} hidden={!showFull}>
            {fact.textExact}
          </blockquote>
        </div>
      )}

      <ul className={s.meta} role="list">
        {when && (
          <li>
            <Clock size={15} aria-hidden="true" />
            {when}
          </li>
        )}
        <li>
          <FileText size={15} aria-hidden="true" />
          {provenanceLine(fact)}
        </li>
        {version && (
          <li>
            <History size={15} aria-hidden="true" />
            {version}
          </li>
        )}
      </ul>

      {earlier.length > 0 && (
        <div className={s.full}>
          <button
            type="button"
            className={s.linkButton}
            aria-expanded={showEarlier}
            aria-controls={earlierId}
            onClick={() => setShowEarlier((value) => !value)}
          >
            Earlier wording
            <ChevronDown size={16} className={s.chevron} aria-hidden="true" />
          </button>
          <ul id={earlierId} className={s.earlier} role="list" hidden={!showEarlier}>
            {earlier.map((previous, at) => (
              <li key={previous.id} className={s.earlierItem}>
                <blockquote className={s.fullWording}>{previous.textExact}</blockquote>
                <p className={s.earlierMeta}>
                  {previous.version > 1 ? `Version ${previous.version}` : "Original"}. {provenanceLine(previous)}
                </p>
                {previous.sourceId && (
                  <button type="button" className={s.smallButton} onClick={() => onSource(previous)}>
                    {at === earlier.length - 1 ? "View original source" : "View its source"}
                    <VisuallyHidden>{previous.version > 1 ? ` for version ${previous.version}` : ""}</VisuallyHidden>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && !written ? (
        <form className={s.editForm} onSubmit={(event) => void save(event)} noValidate>
          <TextArea
            ref={fieldRef}
            label="Change the wording"
            hint="Saving makes a new approved version. The earlier wording is kept."
            value={draft}
            rows={4}
            maxLength={MAX_FACT_CHARS}
            onChange={(event) => setDraft(event.target.value)}
          />
          {error && <ErrorNote message={error} />}
          <div className={s.editActions}>
            <Button type="submit" variant="primary" busy={busy} busyLabel="Saving">
              Save as new version
            </Button>
            <Button variant="secondary" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className={s.actions}>
          {fact.sourceId && (
            <button type="button" className={s.smallButton} onClick={() => onSource(fact)}>
              View source
              <VisuallyHidden> for “{named}”</VisuallyHidden>
            </button>
          )}
          {!written && (
            <button type="button" ref={editRef} className={s.smallButton} onClick={startEdit}>
              Edit
              <VisuallyHidden> “{named}”</VisuallyHidden>
            </button>
          )}
        </div>
      )}
      {written && (
        <p className={s.lockedNote}>Written care instructions stay word for word. Add the corrected document instead.</p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- open questions & conflicts

type OpenProps = {
  name: string;
  questions: CareProfileView["openQuestions"];
  conflicts: CareFactView[][];
  suggested: number;
  /** the one-at-a-time review of just the suggested facts; conflicts are settled right here */
  onReviewSuggested: () => void;
  onAdd: () => void;
  onChanged: () => Promise<unknown>;
};

function OpenItemsPanel({ name, questions, conflicts, suggested, onReviewSuggested, onAdd, onChanged }: OpenProps) {
  if (questions.length === 0 && conflicts.length === 0 && suggested === 0) {
    return <p className={s.none}>Nothing open. Questions asked about {name} that the passport can’t answer show up here.</p>;
  }
  return (
    <>
      {conflicts.length > 0 && (
        <div className={s.openGroup}>
          <h4 className={s.openTitle}>Notes that disagree</h4>
          <ul className={s.conflicts} role="list">
            {conflicts.map((group) => (
              <ConflictGroup key={group.map((fact) => fact.id).join(",")} group={group} onChanged={onChanged} />
            ))}
          </ul>
        </div>
      )}

      {suggested > 0 && (
        <div className={s.openGroup}>
          <h4 className={s.openTitle}>Waiting for your check</h4>
          <p className={s.openText}>
            {plural(suggested, "suggestion is", "suggestions are")} waiting. Nothing is part of the passport until you
            approve it.
          </p>
          <div className={s.openAction}>
            <Button variant="secondary" onClick={onReviewSuggested}>
              Review {plural(suggested, "suggestion", "suggestions")}
            </Button>
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div className={s.openGroup}>
          <h4 className={s.openTitle}>Still to find out</h4>
          <ul className={s.questions} role="list">
            {questions.map((item) => (
              <li key={item.id} className={s.question}>
                <p className={s.questionText}>
                  <CircleHelp size={17} aria-hidden="true" />
                  <span>{item.question}</span>
                </p>
                <button type="button" className={s.smallButton} onClick={onAdd}>
                  Answer by adding a note
                  <VisuallyHidden>: {shorten(item.question, 48)}</VisuallyHidden>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ConflictGroup({ group, onChanged }: { group: CareFactView[]; onChanged: () => Promise<unknown> }) {
  const { live } = useApis();
  const announce = useAnnounce();
  const leadRef = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [later, setLater] = useState(false);

  async function keep(fact: CareFactView) {
    if (busy) return;
    setBusy(fact.id);
    setError(null);
    try {
      await live.resolveConflict(fact.id);
      announce(
        group.length > 1
          ? `Kept. The other ${group.length > 2 ? "notes are" : "note is"} set aside, not deleted.`
          : "Kept.",
      );
      await onChanged();
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const lead =
    group.length === 1
      ? "This note disagreed with one that has changed. Keep it?"
      : group.length > 2
        ? `${group.length} notes disagree. Which one is right?`
        : "Two notes disagree. Which one is right?";

  return (
    <li className={s.conflict}>
      <p ref={leadRef} className={s.conflictLead} tabIndex={-1}>
        {lead}
      </p>
      <ul className={s.conflictOptions} role="list">
        {group.map((fact) => {
          const when = timeLine(fact);
          return (
            <li key={fact.id} className={s.conflictOption}>
              <blockquote className={s.quote}>{fact.textExact}</blockquote>
              <ul className={s.meta} role="list">
                <li>
                  <FileText size={15} aria-hidden="true" />
                  {provenanceLine(fact)}
                </li>
                {when && (
                  <li>
                    <Clock size={15} aria-hidden="true" />
                    {when}
                  </li>
                )}
              </ul>
              <Button
                variant="secondary"
                busy={busy === fact.id}
                busyLabel="Keeping it"
                aria-disabled={(busy !== null && busy !== fact.id) || undefined}
                onClick={() => void keep(fact)}
              >
                Keep this one
                <VisuallyHidden>: “{shorten(fact.textExact, 48)}”</VisuallyHidden>
              </Button>
            </li>
          );
        })}
      </ul>
      {error && <ErrorNote message={error} />}
      {later ? (
        <Note align="start">Left for later. Neither note is used in the day or in answers until you choose.</Note>
      ) : (
        <div className={s.laterAction}>
          <Button
            variant="quiet"
            disabled={busy !== null}
            onClick={() => {
              setLater(true);
              announce("Left for later. Neither note is used until you choose.");
              window.requestAnimationFrame(() => leadRef.current?.focus());
            }}
          >
            Decide later
          </Button>
        </div>
      )}
    </li>
  );
}
