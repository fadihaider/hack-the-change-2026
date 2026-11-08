"use client";
// ask the profile: answers come only from approved facts, shown word for word; a miss is saved as a question
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CircleHelp, FileText, Phone, Tag } from "lucide-react";
import { liveErrorMessage, type AskView, type CareFactView, type CareProfileView } from "@/lib/frontend/live-api.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, TextArea, useAnnounce } from "../ui.tsx";
import { categoryTitle, possessive, sourceLine } from "./care-data.ts";
import s from "./care.module.css";

const MAX_CHARS = 500;

type Props = {
  name: string;
  facts: CareFactView[];
  openQuestions: CareProfileView["openQuestions"];
  onAdd: () => void;
  onChanged: () => Promise<unknown>;
};

export function AskAboutRosa({ name, facts, openQuestions, onAdd, onChanged }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<{ question: string; result: AskView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const words = question.trim();
    if (!words) {
      setError("Write a question first, for example: what time is breakfast?");
      fieldRef.current?.focus();
      return;
    }
    if (words.length > MAX_CHARS) {
      setError("That question is longer than 500 characters. Shorten it, then ask again.");
      return;
    }
    setBusy(true);
    setError(null);
    announce(`Looking in ${possessive(name)} profile.`);
    try {
      const result = await live.ask(words);
      setAsked({ question: words, result });
      announce(result.notFound ? `That’s not in ${possessive(name)} profile yet.` : "The answer is below the question.");
      if (result.openQuestionId) void onChanged();
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const result = asked?.result ?? null;
  // asking the same thing twice saves it twice; list each question once
  const seen = new Set<string>();
  const stillOpen = openQuestions.filter((item) => {
    const key = item.question.trim().toLowerCase().replace(/[\s?.]+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const factById = new Map(facts.map((fact) => [fact.id, fact]));

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.sectionTitle}>
        Ask about {name}
      </h2>
      <p className={s.sectionHint}>Answers come only from {possessive(name)} profile, never from a guess.</p>

      <form className={s.askForm} onSubmit={ask} noValidate>
        <TextArea
          ref={fieldRef}
          label="Your question"
          hint="For example: what time is breakfast?"
          rows={2}
          value={question}
          maxLength={MAX_CHARS}
          readOnly={busy}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={submitOnEnter}
        />
        {error && <ErrorNote message={error} />}
        <div className={s.askActions}>
          <Button type="submit" variant="secondary" busy={busy} busyLabel="Looking it up">
            Ask
          </Button>
        </div>
      </form>

      {asked && result && (
        <div className={result.notFound ? `${s.answer} ${s.answerMissing}` : s.answer}>
          <p className={s.answerAsked}>
            You asked: “{asked.question}”
          </p>
          {result.notFound ? (
            <>
              <p className={s.answerLead}>
                <CircleHelp size={20} aria-hidden="true" />
                <span>That’s not in {possessive(name)} profile yet.</span>
              </p>
              <p className={s.answerBody}>
                Nothing you’ve checked answers it.
                {result.openQuestionId ? " It’s saved under “Still to find out”, so you can add the answer later." : ""}
              </p>
              <div className={s.answerActions}>
                <Button variant="secondary" onClick={onAdd}>
                  Add what you know
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className={s.answerText}>
                {result.answer ?? `Here’s what ${possessive(name)} profile says, word for word.`}
              </p>
              {result.citedFacts.length > 0 && (
                <>
                  <h3 className={s.basedTitle}>Based on</h3>
                  <ul className={s.cited} role="list">
                    {result.citedFacts.map((cited) => {
                      const fact = factById.get(cited.id);
                      return (
                        <li key={cited.id} className={s.citedItem}>
                          <p className={s.citedText}>{cited.textExact}</p>
                          <ul className={s.factMeta} role="list">
                            <li>
                              <Tag size={15} aria-hidden="true" />
                              {categoryTitle(cited.category)}
                            </li>
                            {fact && (
                              <li>
                                <FileText size={15} aria-hidden="true" />
                                {sourceLine(fact)}
                              </li>
                            )}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {result.healthNotice && (
                <p className={s.health}>
                  <Phone size={18} aria-hidden="true" />
                  <span>{result.healthNotice}</span>
                </p>
              )}
            </>
          )}
        </div>
      )}

      {stillOpen.length > 0 && (
        <div className={s.open}>
          <h3 className={s.groupTitle}>Still to find out</h3>
          <ul className={s.openList}>
            {stillOpen.map((item) => (
              <li key={item.id}>{item.question}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
