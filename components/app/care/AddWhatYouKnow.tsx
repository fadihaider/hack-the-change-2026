"use client";
// add what you know: a typed note or a pdf. nothing is approved here; every fact comes back as a suggestion
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { ChevronLeft, FileUp, Mic } from "lucide-react";
import { liveErrorMessage, type CareSourceView } from "@/lib/frontend/live-api.ts";
import { useApis } from "../session.tsx";
import { Actions, Button, Column, ErrorNote, Note, Question, TextArea, useAnnounce } from "../ui.tsx";
import { possessive } from "./care-data.ts";
import s from "./care.module.css";

export type AddedFrom = "note" | "pdf";

const MAX_CHARS = 50000;
// the server takes up to 10 MB for the whole upload; leave room for the form wrapper
const MAX_PDF_BYTES = 10 * 1024 * 1024 - 64 * 1024;
const SLOW_AFTER_MS = 5000;

export const EXAMPLE_NOTE =
  "Mom has her breakfast at 8:00 every morning, usually oatmeal with brown sugar. She takes her walk around the block at 10 am with her cane, every day if the weather is okay. Call Aunt Lucia at 403-555-0142 if anything comes up.";

type Props = {
  name: string;
  motion: "forward" | "back" | null;
  arrived: boolean;
  /** resolves to a message when the source had nothing to check; otherwise the screen moves on */
  onAdded: (result: CareSourceView, from: AddedFrom) => Promise<string | null>;
  onBack: () => void;
  /** switch to recording a voice note instead of typing; hidden when not given */
  onVoice?: () => void;
  /** starts the field with this text, e.g. words kept from an earlier try */
  initialText?: string;
};

export function AddWhatYouKnow({ name, motion, arrived, onAdded, onBack, onVoice, initialText = "" }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState<AddedFrom | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (busy === null) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSlow(true);
      announce("Still reading. This can take a little while.");
    }, SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [busy, announce]);

  async function run(from: AddedFrom, work: () => Promise<CareSourceView>) {
    setBusy(from);
    setError(null);
    setNotice(null);
    announce(from === "pdf" ? "Reading the PDF." : "Reading your note.");
    try {
      const result = await work();
      const message = await onAdded(result, from);
      if (message) {
        setNotice(message);
        announce(message);
      }
    } catch (caught) {
      setError(liveErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const words = text.trim();
    if (!words) {
      setError(`Write something about ${possessive(name)} care first, or tap the example.`);
      fieldRef.current?.focus();
      return;
    }
    void run("note", () => live.addCareText("note", words));
  }

  function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function picked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // clear it so picking the same file again still counts
    event.target.value = "";
    if (!file || busy) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setNotice(null);
      setError("Only PDF files can be uploaded here. Pick a PDF, or type the key lines as a note.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setNotice(null);
      setError("That file is too large. Upload a PDF under 10 MB.");
      return;
    }
    void run("pdf", () => live.uploadCarePdf(file, file.name || "care-document.pdf"));
  }

  function fillExample() {
    setText(EXAMPLE_NOTE);
    setError(null);
    announce("Example added. Change anything you like, then check it.");
    window.requestAnimationFrame(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  return (
    <Column
      key="add"
      motion={motion}
      before={
        <button type="button" className={s.back} disabled={busy !== null} onClick={onBack}>
          <ChevronLeft size={18} aria-hidden="true" />
          {possessive(name)} care
        </button>
      }
    >
      <Question lead="Routines, who to call, what the nurse said." autoFocusOnMount={arrived}>
        What do you know about {possessive(name)} care?
      </Question>

      <form className={s.form} onSubmit={submit} noValidate>
        <TextArea
          ref={fieldRef}
          size="large"
          label="Write it down"
          hint="Add times where you know them. Each thing comes back to you to check before helpers see it."
          rows={5}
          value={text}
          maxLength={MAX_CHARS}
          readOnly={busy !== null}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={submitOnShortcut}
        />
        {text.trim() === "" && busy === null && (
          <button type="button" className={s.example} onClick={fillExample}>
            <span className={s.exampleLabel}>Tap to use an example</span>
            <span className={s.exampleText}>“{EXAMPLE_NOTE}”</span>
          </button>
        )}
        {error && <ErrorNote message={error} />}
        {notice && (
          <p className={s.notice} role="status">
            {notice}
          </p>
        )}
        <Actions>
          <Button
            type="submit"
            variant="primary"
            busy={busy === "note"}
            busyLabel="Reading your note"
            disabled={busy === "pdf"}
          >
            Check what I wrote
          </Button>
          {slow && <Note>Still reading. This can take a little while.</Note>}
          {onVoice && (
            <Button variant="quiet" disabled={busy !== null} onClick={onVoice}>
              <Mic size={18} aria-hidden="true" />
              Record a voice note instead
            </Button>
          )}
        </Actions>
      </form>

      <div className={s.pdf}>
        <h2 className={s.pdfTitle}>Have a discharge sheet or care plan?</h2>
        <p className={s.pdfHint}>A PDF with selectable text, under 10 MB. It’s read word for word, like a note.</p>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className={s.fileInput}
          tabIndex={-1}
          aria-hidden="true"
          onChange={picked}
        />
        <Actions>
          <Button
            variant="secondary"
            busy={busy === "pdf"}
            busyLabel="Reading the PDF"
            disabled={busy === "note"}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp size={18} aria-hidden="true" />
            Upload a PDF
          </Button>
        </Actions>
      </div>
    </Column>
  );
}
