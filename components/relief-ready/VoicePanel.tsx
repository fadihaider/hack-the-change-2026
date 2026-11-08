"use client";

import { useEffect, useRef, useState } from "react";

function failure(status: number): string {
  if (status === 401) return "Sign in before using live voice features.";
  if (status === 429) return "The voice limit has been reached. Try again later.";
  if (status === 413) return "The recording is too large. Record a shorter note.";
  if (status === 503) return "Voice setup or sign-in is not available on this server yet.";
  return "The voice request failed. Your text is still available; you can try again.";
}

/** Isolated testing entry. No fixture transcripts, automatic sends or profile writes. */
export default function VoicePanel() {
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<Blob | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [playback, setPlayback] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversation = useRef<{ endSession(): Promise<void> } | null>(null);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (timer.current) clearTimeout(timer.current);
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state !== "inactive") recorder.current.stop();
      }
      stream.current?.getTracks().forEach((track) => track.stop());
      void conversation.current?.endSession();
    };
  }, []);
  useEffect(() => () => { if (playback) URL.revokeObjectURL(playback); }, [playback]);

  async function record() {
    if (!consent || busy || connected) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("Recording is unavailable in this browser. You can still type and use read aloud.");
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((value) => MediaRecorder.isTypeSupported(value));
      const next = new MediaRecorder(media, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      let size = 0;
      setRecorded(null);
      next.ondataavailable = ({ data }) => {
        if (!data.size) return;
        size += data.size;
        chunks.push(data);
        if (size > 9 * 1024 * 1024 && next.state !== "inactive") next.stop();
      };
      next.onstop = () => {
        if (timer.current) clearTimeout(timer.current);
        media.getTracks().forEach((track) => track.stop());
        if (disposed.current) return;
        setRecording(false);
        if (size > 9 * 1024 * 1024) { setStatus("Recording is too large. Record a shorter note."); return; }
        setRecorded(new Blob(chunks, { type: next.mimeType }));
        setStatus("Recording is in memory. Choose Transcribe to send it to ElevenLabs.");
      };
      recorder.current = next;
      next.start(1000);
      setRecording(true);
      setStatus("Recording. This stops after one minute; nothing has been uploaded yet.");
      timer.current = setTimeout(() => { if (next.state !== "inactive") next.stop(); }, 60_000);
    } catch { setStatus("Microphone access was unavailable. You can type instead."); }
  }

  async function transcribe() {
    if (!recorded || !consent) return;
    setBusy(true);
    setStatus("Transcribing…");
    try {
      const form = new FormData();
      form.set("file", recorded, "recording");
      const response = await fetch("/api/stt", { method: "POST", credentials: "same-origin", body: form });
      if (!response.ok) { setStatus(failure(response.status)); return; }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("transcript" in result) || typeof result.transcript !== "string") throw new Error("invalid_response");
      setText(result.transcript);
      setRecorded(null);
      setStatus("Review and edit the transcript below. It has not been added to a care profile or sent to anyone.");
    } catch { setStatus("Transcription failed. You can type the note below instead."); }
    finally { setBusy(false); }
  }

  async function readAloud() {
    if (!consent || !text.trim()) return;
    setBusy(true);
    setStatus("Generating read-aloud audio…");
    try {
      const response = await fetch("/api/tts", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!response.ok) { setStatus(failure(response.status)); return; }
      if (!response.headers.get("Content-Type")?.startsWith("audio/mpeg")) throw new Error("invalid_audio");
      setPlayback(URL.createObjectURL(await response.blob()));
      setStatus("Audio is ready. Use the player to listen; your text remains below.");
    } catch { setStatus("Read aloud failed. Your text is still available."); }
    finally { setBusy(false); }
  }

  async function connect() {
    if (!consent) return;
    setBusy(true);
    setStatus("Connecting to the private AI voice companion…");
    try {
      const response = await fetch("/api/voice-agent/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true, fictionalData: true }) });
      if (!response.ok) { setStatus(failure(response.status)); return; }
      const session = await response.json();
      if (typeof session.signedUrl !== "string") throw new Error("invalid_session");
      const { Conversation } = await import("@elevenlabs/client");
      conversation.current = await Conversation.startSession({
        signedUrl: session.signedUrl,
        onMessage: ({ message }) => setMessages((previous) => [...previous.slice(-29), message]),
        onDisconnect: () => { setConnected(false); setStatus("Voice companion disconnected."); },
        onError: () => { setStatus("Voice companion connection failed. Text and batch speech remain available."); },
      });
      setConnected(true);
      setStatus("Connected to the AI companion. Use fictional information; app actions require their own review screens.");
    } catch { setStatus("Voice companion could not connect. Typed input and batch speech remain available."); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    await conversation.current?.endSession();
    conversation.current = null;
    setConnected(false);
  }

  return (
    <section aria-labelledby="voice-title" style={{ display: "grid", gap: 20 }}>
      <h1 id="voice-title">ElevenLabs voice</h1>
      <p>Record a short fictional note, review its transcript, or read text aloud. These live features use ElevenLabs credits. The AI companion explains the app&apos;s care workflows and cannot send messages or approve care facts.</p>
      <label style={{ display: "flex", alignItems: "start", gap: 10 }}>
        <input type="checkbox" checked={consent} disabled={recording || busy || connected} onChange={(event) => setConsent(event.target.checked)} />
        I am using fictional information and consent to sending my selected audio and text to ElevenLabs. Provider deletion does not guarantee removal from all logs or backups.
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={record} disabled={!consent || recording || busy || connected}>Record note</button>
        <button onClick={() => recorder.current?.stop()} disabled={!recording}>Stop recording</button>
        <button onClick={transcribe} disabled={!consent || !recorded || recording || busy || connected}>Transcribe recording</button>
      </div>
      <label htmlFor="voice-text">Text or transcript — review before use</label>
      <textarea id="voice-text" rows={7} value={text} onChange={(event) => setText(event.target.value)} placeholder="Type a fictional note or transcribe one above." style={{ width: "100%", padding: 12, font: "inherit" }} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={readAloud} disabled={!consent || !text.trim() || [...text].length > 4000 || recording || busy || connected}>Generate read-aloud audio</button>
        <button onClick={async () => { try { await navigator.clipboard.writeText(text); setStatus("Copied. Paste into Urgent intake or a Care note, then review it there."); } catch { setStatus("Select and copy the text manually."); } }} disabled={!text}>Copy reviewed text</button>
      </div>
      {playback && <audio controls src={playback} aria-label="Read-aloud audio" />}
      <p>For care instructions, keep the exact approved wording. Health questions: 811. Emergencies: 911.</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={connect} disabled={!consent || busy || recording || connected}>Start private AI companion</button>
        <button onClick={disconnect} disabled={!connected}>End conversation</button>
      </div>
      {messages.length > 0 && <div aria-label="Conversation text equivalent">{messages.map((message, index) => <p key={index}>{message}</p>)}</div>}
      <p role="status" aria-live="polite">{status}</p>
      <p><a href="/api/auth/signin">Sign in</a> · <a href="/">Return to ReliefReady</a></p>
    </section>
  );
}
