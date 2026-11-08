"use client";
// the ask bar: answers come only from approved facts, cited word for word; a miss is saved as an open question
import { useId, useRef, useState, type FormEvent } from "react";
import { BookOpen, Check, ChevronDown, CircleHelp, Phone, Search } from "lucide-react";
import {
  albertaDateOf,
  formatDate,
  liveErrorMessage,
  type AskView,
  type CareFactView,
  type CareProfileView,
  type CitedFactView,
} from "@/lib/frontend/live-api.ts";
import {
  EMERGENCY_LINES,
  answeredByLabel,
  redirectText,
  retrievalLine,
  sourcePhrase,
  uniqueQuestions,
} from "@/lib/frontend/care-help.ts";
import { PASSPORT_SECTIONS, sectionOf } from "@/lib/frontend/passport.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, useAnnounce } from "../ui.tsx";
import { possessive } from "./care-data.ts";
import a from "./ask.module.css";

const MAX_CHARS = 500;

type Props = {
  name: string;
  facts: CareFactView[];
  openQuestions: CareProfileView["openQuestions"];
  onAdd: () => void;
  onChanged: () => Promise<unknown>;
};

type Asked = { key: number; question: string; result: AskView };

export function AskAboutRosa({ name, facts, openQuestions, onAdd, onChanged }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const fieldId = useId();
  const hintId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const asks = useRef(0);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<Asked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const words = question.trim();
    if (!words) {
      setInvalid(true);
      setError("Write a question first, for example: where are her glasses?");
      fieldRef.current?.focus();
      return;
    }
    if (words.length > MAX_CHARS) {
      setInvalid(true);
      setError("That question is longer than 500 characters. Shorten it, then ask again.");
      fieldRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(false);
    announce(`Looking in ${possessive(name)} approved passport.`);
    try {
      const result = await live.ask(words);
      asks.current += 1;
      setAsked({ key: asks.current, question: words, result });
      if (result.openQuestionId) void onChanged();
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const stillOpen = uniqueQuestions(openQuestions);
  const factById = new Map(facts.map((fact) => [fact.id, fact]));

  return (
    <section className={a.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={a.title}>
        Ask about {name}
      </h2>

      <form className={a.bar} onSubmit={ask} noValidate role="search" aria-labelledby={titleId}>
        <label htmlFor={fieldId} className={a.srOnly}>
          Your question about {name}
        </label>
        <span className={a.inputWrap}>
          <Search size={18} aria-hidden="true" className={a.inputIcon} />
          <input
            ref={fieldRef}
            id={fieldId}
            type="text"
            enterKeyHint="search"
            autoComplete="off"
            className={a.input}
            placeholder="Ask where her glasses are, what her routine is…"
            aria-describedby={hintId}
            aria-invalid={invalid || undefined}
            value={question}
            maxLength={MAX_CHARS}
            readOnly={busy}
            onChange={(event) => {
              setQuestion(event.target.value);
              if (invalid) setInvalid(false);
            }}
          />
        </span>
        <Button type="submit" variant="primary" className={a.askButton} busy={busy} busyLabel="Looking">
          Ask
        </Button>
      </form>
      <p id={hintId} className={a.hint}>
        Answers come only from {possessive(name)} approved passport, never from a guess.
      </p>
      {error && (
        <div className={a.error}>
          <ErrorNote message={error} />
        </div>
      )}

      {/* the lead sentence of each answer is read aloud; citations and notes stay quiet below it */}
      <div aria-live="polite" className={a.live}>
        {asked && <AnswerLead key={asked.key} name={name} asked={asked} />}
      </div>
      {asked && (
        <AnswerDetails key={asked.key} name={name} result={asked.result} factById={factById} onAdd={onAdd} />
      )}

      {stillOpen.length > 0 && (
        <details className={a.openQuestions}>
          <summary className={a.summary}>
            <span>Still to find out ({stillOpen.length})</span>
            <ChevronDown size={18} aria-hidden="true" className={a.chevron} />
          </summary>
          <ul className={a.openList}>
            {stillOpen.map((item) => (
              <li key={item.id}>{item.question}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function AnswerLead({ name, asked }: { name: string; asked: Asked }) {
  const { result } = asked;
  return (
    <div
      className={
        result.medicalRedirect ? `${a.answer} ${a.answerRedirect}` : result.notFound ? `${a.answer} ${a.answerMissing}` : a.answer
      }
    >
      <p className={a.asked}>You asked: “{asked.question}”</p>
      {result.medicalRedirect ? (
        <p className={a.redirectText}>
          <Phone size={20} aria-hidden="true" />
          <span>{redirectText(result)}</span>
        </p>
      ) : result.notFound ? (
        <p className={a.missingText}>
          <CircleHelp size={20} aria-hidden="true" />
          <span>I don’t have that in {possessive(name)} approved passport.</span>
        </p>
      ) : (
        <p className={a.answerText}>
          {result.answer ?? `Here’s what ${possessive(name)} passport says, word for word.`}
        </p>
      )}
    </div>
  );
}

type DetailsProps = {
  name: string;
  result: AskView;
  factById: Map<string, CareFactView>;
  onAdd: () => void;
};

function AnswerDetails({ name, result, factById, onAdd }: DetailsProps) {
  // a medical question gets the redirect and the two numbers, then any matching approved fact word for word
  if (result.medicalRedirect) {
    return (
      <div className={a.calls}>
        <div className={a.callGrid}>
          <a className={`${a.call} ${a.callEmergency}`} href={EMERGENCY_LINES.emergency.href}>
            <Phone size={18} aria-hidden="true" />
            <span>
              Call 911
              <span className={a.callNote}>Emergency</span>
            </span>
          </a>
          <a className={a.call} href={EMERGENCY_LINES.healthLink.href}>
            <Phone size={18} aria-hidden="true" />
            <span>
              Call 811
              <span className={a.callNote}>Health Link, 24/7 nurse advice</span>
            </span>
          </a>
        </div>
        <CitedList name={name} cited={result.citedFacts} factById={factById} />
      </div>
    );
  }

  const provider = answeredByLabel(result.answeredBy);
  const searched = retrievalLine(result.retrieval);

  return (
    <div className={result.notFound ? `${a.details} ${a.detailsMissing}` : a.details}>
      {result.notFound ? (
        <>
          {result.openQuestionId && (
            <p className={a.saved}>
              <Check size={18} aria-hidden="true" />
              <span>Saved as an open question</span>
            </p>
          )}
          <div className={a.answerActions}>
            <Button variant="secondary" onClick={onAdd}>
              Add the answer
            </Button>
          </div>
          {/* a missed health question still shows where to call */}
          <p className={a.missingHelp}>
            For health advice, call <a href={EMERGENCY_LINES.healthLink.href}>Health Link at 811</a>. In an
            emergency, call <a href={EMERGENCY_LINES.emergency.href}>911</a>.
          </p>
        </>
      ) : (
        <CitedList name={name} cited={result.citedFacts} factById={factById} />
      )}
      {result.healthNotice && (
        <p className={a.health}>
          <Phone size={18} aria-hidden="true" />
          <span>{result.healthNotice}</span>
        </p>
      )}
      {(provider || searched) && (
        <ul className={a.provenance} role="list">
          {provider && <li>{provider}</li>}
          {searched && <li>{searched}</li>}
        </ul>
      )}
    </div>
  );
}

type CitedListProps = {
  name: string;
  cited: CitedFactView[];
  factById: Map<string, CareFactView>;
};

/** the approved facts behind an answer, word for word; nothing when there are none */
function CitedList({ name, cited, factById }: CitedListProps) {
  if (cited.length === 0) return null;
  return (
    <>
      <h3 className={a.basedTitle}>
        Based on {cited.length === 1 ? "this approved fact" : `these ${cited.length} approved facts`}
      </h3>
      <ul className={a.cited} role="list">
        {cited.map((item) => (
          <Citation key={item.id} name={name} cited={item} fact={factById.get(item.id) ?? null} />
        ))}
      </ul>
    </>
  );
}

function sectionTitle(category: string): string {
  const id = sectionOf(category);
  return PASSPORT_SECTIONS.find((section) => section.id === id)?.title ?? "Care passport";
}

/** "From a voice note, Nov 8", from the citation first and the loaded fact second */
function fromLine(cited: CitedFactView, fact: CareFactView | null): string {
  const kind = sourcePhrase(cited.sourceKind ?? fact?.sourceKind ?? null);
  const at = cited.sourceCreatedAt ?? fact?.sourceCreatedAt ?? fact?.createdAt ?? null;
  const ms = at ? Date.parse(at) : Number.NaN;
  const day = Number.isFinite(ms) ? formatDate(albertaDateOf(ms)) : null;
  if (kind && day) return `From ${kind}, ${day}`;
  if (kind) return `From ${kind}`;
  if (day) return `Added ${day}`;
  return "Source not recorded";
}

/**
 * opens the passport section holding this fact and moves focus to it; false when it is not on the page.
 * passport sections are react accordions, so this goes through the passport's own #fact-{id} handler,
 * which expands the section first and then focuses the row.
 */
function revealFact(factId: string): boolean {
  if (!document.getElementById(`fact-${factId}`)) return false;
  const hash = `#fact-${encodeURIComponent(factId)}`;
  // replace rather than push, so a citation tap does not add a back-button step; keep the router's state
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  return true;
}

function Citation({ name, cited, fact }: { name: string; cited: CitedFactView; fact: CareFactView | null }) {
  const [inPassport, setInPassport] = useState(false);
  const version = Math.max(cited.version, fact?.version ?? 1);
  return (
    <li className={a.citedItem}>
      <details
        className={a.citation}
        onToggle={(event) => {
          if (event.currentTarget.open) setInPassport(Boolean(document.getElementById(`fact-${cited.id}`)));
        }}
      >
        <summary className={a.citationSummary}>
          <span className={a.citationBody}>
            <span className={a.chip}>{sectionTitle(cited.category)}</span>
            <span className={a.citedText}>{cited.textExact}</span>
          </span>
          <ChevronDown size={18} aria-hidden="true" className={a.chevron} />
        </summary>
        <div className={a.citationMore}>
          <ul className={a.meta} role="list">
            <li>{fromLine(cited, fact)}</li>
            {version > 1 && <li>Version {version}</li>}
            <li>Approved</li>
          </ul>
          {inPassport && (
            <button type="button" className={a.passportLink} onClick={() => revealFact(cited.id)}>
              <BookOpen size={16} aria-hidden="true" />
              Show in {possessive(name)} passport
            </button>
          )}
        </div>
      </details>
    </li>
  );
}
