"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, Square } from "lucide-react";

// optional browser dictation (web speech api). it is shown only where the browser offers it;
// typing always works. the transcript goes into the text box for the user to review before anything is sent.

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export default function Dictation({
  onText,
  label = "Dictate",
}: {
  onText: (text: string) => void;
  label?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [failed, setFailed] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const callback = useRef(onText);
  callback.current = onText;

  useEffect(() => {
    setAvailable(recognitionClass() !== null);
    return () => recognition.current?.stop();
  }, []);

  if (!available) return null;

  function start() {
    const Klass = recognitionClass();
    if (!Klass) return;
    const r = new Klass();
    r.lang = "en-CA";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) {
        parts.push(event.results[i][0]?.transcript ?? "");
      }
      const said = parts.join(" ").trim();
      if (said) callback.current(said);
    };
    r.onerror = () => setFailed(true);
    r.onend = () => setListening(false);
    recognition.current = r;
    setFailed(false);
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
      setFailed(true);
    }
  }

  return (
    <span className="dictation">
      <button
        type="button"
        className="text-button"
        aria-pressed={listening}
        onClick={() => (listening ? recognition.current?.stop() : start())}
      >
        {listening ? <Square size={14} /> : <AudioLines size={16} />}{" "}
        {listening ? "Stop dictation" : label}
      </button>
      <span className="sr-only" role="status">
        {listening ? "Listening" : failed ? "Dictation stopped" : ""}
      </span>
      {failed && (
        <span className="small-note">Dictation is unavailable. Type instead.</span>
      )}
    </span>
  );
}
