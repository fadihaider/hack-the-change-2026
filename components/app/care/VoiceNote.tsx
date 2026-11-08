"use client";
// voice note panel on Care (PRD 6): record, listen back, send the audio once to /api/stt, then check and edit the
// words before the parent saves them as a voice source. the audio stays in this panel and is dropped as soon as a
// transcript comes back; nothing is transcribed or saved without a click, and no transcript is ever made up here.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Keyboard, Mic, RotateCcw, Square } from "lucide-react";
import {
  durationWords,
  formatElapsed,
  isLastingMicProblem,
  MAX_RECORDING_SECONDS,
  MAX_TRANSCRIPT_CHARS,
  micProblemMessage,
  micProblemOf,
  normalizeRecordedType,
  pickRecorderMime,
  RECORDER_TIMESLICE_MS,
  recorderSupportProblem,
  recordingProblem,
  recordingProblemMessage,
  shouldStopForSize,
  WARN_BEFORE_LIMIT_SECONDS,
} from "@/lib/frontend/recorder.ts";
import {
  canRetrySameRecording,
  createSpeechApi,
  isSpeechUnavailable,
  SPEECH_OFF_MESSAGE,
  speechErrorMessage,
} from "@/lib/frontend/speech-api.ts";
import { Actions, Button, ErrorNote, Note, TextArea, useAnnounce } from "../ui.tsx";
import { possessive } from "./care-data.ts";
import s from "./voice.module.css";

export type VoiceNoteProps = {
  /** the care recipient's name, for copy */
  name: string;
  /** from GET /api/session providers.speech; "off" means no live transcription, so offer typing instead */
  speech: "elevenlabs" | "off";
  /**
   * called with the transcript the caregiver reviewed and confirmed. the parent saves it as a voice source
   * (POST /api/care/sources kind "voice") and opens the review; it returns a message to show here, or null
   */
  onUseTranscript: (text: string) => Promise<string | null>;
  /** switch to the typed-note input */
  onTypeInstead: () => void;
  onClose: () => void;
};

type Recording = { audio: Blob; url: string; seconds: number };

type Phase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording" }
  | { kind: "stopped"; take: Recording; hitLimit: boolean }
  | { kind: "transcribing"; take: Recording }
  | { kind: "review" }
  | { kind: "saving" }
  /** this browser or server cannot record or transcribe; typing is the only way on */
  | { kind: "blocked"; message: string }
  /** something went wrong; take is kept when the same audio can be sent again */
  | { kind: "error"; message: string; take: Recording | null };

type StopReason = "user" | "time" | "size";

const SLOW_AFTER_MS = 5000;
const LIMIT_TEXT = formatElapsed(MAX_RECORDING_SECONDS);

export function VoiceNote({ name, speech, onUseTranscript, onTypeInstead, onClose }: VoiceNoteProps) {
  const announce = useAnnounce();
  const api = useMemo(() => createSpeechApi(), []);
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [slow, setSlow] = useState(false);
  // the transcript lives outside the phase so no error can wipe it
  const [transcript, setTranscript] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const stopReasonRef = useRef<StopReason>("user");
  const tickRef = useRef<number | undefined>(undefined);
  const limitRef = useRef<number | undefined>(undefined);
  const urlRef = useRef<string | null>(null);
  const focusedPhase = useRef<Phase["kind"] | null>(null);
  // bumped whenever a recording is abandoned, so a late microphone grant is let go
  const attemptRef = useRef(0);

  const clearTimers = useCallback(() => {
    window.clearInterval(tickRef.current);
    window.clearTimeout(limitRef.current);
    tickRef.current = undefined;
    limitRef.current = undefined;
  }, []);

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const dropAudio = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  /** stops any recording without keeping it: used by unmount, re-record, type instead and close */
  const abandonRecording = useCallback(() => {
    attemptRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // already stopped by the browser; the tracks are released below either way
        }
      }
    }
    chunksRef.current = [];
    bytesRef.current = 0;
    clearTimers();
    releaseMic();
  }, [clearTimers, releaseMic]);

  // mount and unmount: free the microphone, timers and the audio url
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abandonRecording();
      dropAudio();
    };
  }, [abandonRecording, dropAudio]);

  // say up front when this browser cannot record at all (checked on the client only)
  useEffect(() => {
    if (speech === "off") return;
    const problem = recorderSupportProblem({
      secureContext: window.isSecureContext,
      getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
      mediaRecorder: typeof window.MediaRecorder === "function",
    });
    if (problem) setPhase({ kind: "blocked", message: micProblemMessage(problem) });
  }, [speech]);

  // the server switched speech off while the panel was open: stop listening
  useEffect(() => {
    if (speech !== "off") return;
    abandonRecording();
    dropAudio();
  }, [speech, abandonRecording, dropAudio]);

  // move focus to the control that matters in each step; the heading on first open
  useEffect(() => {
    const before = focusedPhase.current;
    if (before === phase.kind) return;
    focusedPhase.current = phase.kind;
    if (before === null) headingRef.current?.focus({ preventScroll: true });
    else if (phase.kind === "review") fieldRef.current?.focus();
    else primaryRef.current?.focus();
  }, [phase.kind]);

  // a calm "still working" line when the provider or the parent takes a while
  const working = phase.kind === "transcribing" || phase.kind === "saving";
  useEffect(() => {
    if (!working) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSlow(true);
      announce("Still working. This can take a little while.");
    }, SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [working, announce]);

  function keep(audio: Blob, seconds: number): Recording {
    dropAudio();
    const url = URL.createObjectURL(audio);
    urlRef.current = url;
    return { audio, url, seconds };
  }

  function fail(message: string, take: Recording | null = null) {
    if (!take) dropAudio();
    setPhase({ kind: "error", message, take });
  }

  function stopRecording(reason: StopReason) {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    stopReasonRef.current = reason;
    clearTimers();
    try {
      recorder.stop();
    } catch {
      abandonRecording();
      fail("The recording stopped unexpectedly. Try again, or type the note instead.");
    }
  }

  async function startRecording() {
    if (phase.kind === "requesting" || phase.kind === "recording" || working) return;
    abandonRecording();
    dropAudio();
    // a transcript already on screen stays until a new one replaces it, so a failed re-record loses nothing
    const attempt = attemptRef.current;
    setSaveError(null);
    setSaveNotice(null);

    const support = recorderSupportProblem({
      secureContext: window.isSecureContext,
      getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
      mediaRecorder: typeof window.MediaRecorder === "function",
    });
    if (support) {
      setPhase({ kind: "blocked", message: micProblemMessage(support) });
      return;
    }

    setPhase({ kind: "requesting" });
    announce("Your browser will ask to use the microphone.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (!mounted.current || attempt !== attemptRef.current) return;
      const problem = micProblemOf(error);
      const message = micProblemMessage(problem);
      if (isLastingMicProblem(problem)) setPhase({ kind: "blocked", message });
      else fail(message);
      return;
    }
    if (!mounted.current || attempt !== attemptRef.current) {
      // closed or switched to typing while the browser was asking
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;

    const requested = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, requested ? { mimeType: requested } : undefined);
    } catch {
      releaseMic();
      setPhase({ kind: "blocked", message: micProblemMessage("unsupported") });
      return;
    }

    const startedAt = Date.now();
    let warned = false;
    chunksRef.current = [];
    bytesRef.current = 0;
    stopReasonRef.current = "user";

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return;
      chunksRef.current.push(event.data);
      bytesRef.current += event.data.size;
      if (shouldStopForSize(bytesRef.current)) stopRecording("size");
    };
    recorder.onerror = () => {
      abandonRecording();
      if (mounted.current) fail("The recording stopped unexpectedly. Try again, or type the note instead.");
    };
    recorder.onstop = () => {
      const chunks = chunksRef.current;
      const reason = stopReasonRef.current;
      recorderRef.current = null;
      chunksRef.current = [];
      bytesRef.current = 0;
      clearTimers();
      releaseMic();
      if (!mounted.current) return;
      const type = normalizeRecordedType(recorder.mimeType || chunks[0]?.type || requested || "");
      const audio = new Blob(chunks, { type });
      const problem = recordingProblem(audio);
      if (problem) {
        fail(recordingProblemMessage(problem));
        return;
      }
      const seconds = Math.min(MAX_RECORDING_SECONDS, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      const hitLimit = reason !== "user";
      setPhase({ kind: "stopped", take: keep(audio, seconds), hitLimit });
      announce(
        hitLimit
          ? `Recording stopped at the ${durationWords(MAX_RECORDING_SECONDS)} limit. Listen back, or transcribe it.`
          : "Recording stopped. Listen back, or transcribe it.",
      );
    };

    recorderRef.current = recorder;
    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch {
      abandonRecording();
      setPhase({ kind: "blocked", message: micProblemMessage("unsupported") });
      return;
    }

    setElapsed(0);
    setPhase({ kind: "recording" });
    announce("Recording. Press Stop when you’re done.");
    tickRef.current = window.setInterval(() => {
      const seconds = Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - startedAt) / 1000));
      setElapsed(seconds);
      if (!warned && MAX_RECORDING_SECONDS - seconds <= WARN_BEFORE_LIMIT_SECONDS) {
        warned = true;
        announce(`${durationWords(MAX_RECORDING_SECONDS - seconds)} left.`);
      }
    }, 250);
    limitRef.current = window.setTimeout(() => stopRecording("time"), MAX_RECORDING_SECONDS * 1000);
  }

  async function transcribe(take: Recording) {
    if (working) return;
    setPhase({ kind: "transcribing", take });
    announce("Transcribing your recording.");
    try {
      const result = await api.transcribe(take.audio);
      if (!mounted.current) return;
      const words = result.transcript.trim();
      if (!words) {
        fail("Nothing was heard in that recording. Record again closer to the microphone, or type the note instead.");
        return;
      }
      // the words are back: the audio is no longer needed anywhere
      dropAudio();
      setTranscript(words);
      setSaveError(null);
      setSaveNotice(null);
      setPhase({ kind: "review" });
      announce("Transcript ready. Check it and fix anything it misheard.");
    } catch (error) {
      if (!mounted.current) return;
      const message = speechErrorMessage(error);
      if (isSpeechUnavailable(error)) {
        dropAudio();
        setPhase({ kind: "blocked", message });
        return;
      }
      fail(message, canRetrySameRecording(error) ? take : null);
    }
  }

  async function confirmTranscript() {
    if (phase.kind !== "review") return;
    const words = (transcript ?? "").trim();
    if (!words) {
      setSaveError("The transcript is empty. Add the words, or record again.");
      fieldRef.current?.focus();
      return;
    }
    if (words.length > MAX_TRANSCRIPT_CHARS) {
      setSaveError("This note is too long to check word for word. Shorten it, or split it into two notes.");
      fieldRef.current?.focus();
      return;
    }
    setSaveError(null);
    setSaveNotice(null);
    setPhase({ kind: "saving" });
    announce("Reading your note.");
    try {
      const message = await onUseTranscript(words);
      if (!mounted.current) return;
      setPhase({ kind: "review" });
      if (message) {
        setSaveNotice(message);
        announce(message);
      }
    } catch {
      if (!mounted.current) return;
      setPhase({ kind: "review" });
      setSaveError("Your note couldn’t be saved. The transcript is still here, so you can try again.");
    }
  }

  function leave(next: () => void) {
    abandonRecording();
    dropAudio();
    // a recording in progress is let go; a transcript on screen stays where it is
    if (phase.kind === "requesting" || phase.kind === "recording") setPhase({ kind: "idle" });
    next();
  }

  function backToTranscript() {
    abandonRecording();
    dropAudio();
    setPhase({ kind: "review" });
  }

  const typeInstead = (
    <Button variant="quiet" disabled={working} onClick={() => leave(onTypeInstead)}>
      <Keyboard size={18} aria-hidden="true" />
      Type instead
    </Button>
  );
  const close = (
    <Button variant="quiet" disabled={working} onClick={() => leave(onClose)}>
      Close
    </Button>
  );
  // after a re-record, the earlier transcript is still one click away until a new one replaces it
  const backButton = transcript !== null && (
    <Button variant="secondary" disabled={working} onClick={backToTranscript}>
      Back to my transcript
    </Button>
  );
  const errorTake = phase.kind === "error" ? phase.take : null;

  const header = (
    <>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className={s.title}>
        Voice note
      </h2>
      <p className={s.lead}>
        Say what you know about {possessive(name)} care in your own words. You’ll check the words before anything is
        saved.
      </p>
    </>
  );

  // no live provider on this server: say so plainly and never offer a record button
  if (speech === "off") {
    return (
      <section className={s.panel} aria-labelledby={headingId}>
        {header}
        <p className={s.unavailable}>{SPEECH_OFF_MESSAGE}</p>
        <Actions>
          <Button variant="primary" onClick={onTypeInstead}>
            <Keyboard size={18} aria-hidden="true" />
            Type a note
          </Button>
          {close}
        </Actions>
      </section>
    );
  }

  return (
    <section className={s.panel} aria-labelledby={headingId}>
      {header}

      {phase.kind === "blocked" && (
        <>
          <p className={s.unavailable}>{phase.message}</p>
          <Actions>
            <Button ref={primaryRef} variant="primary" onClick={() => leave(onTypeInstead)}>
              <Keyboard size={18} aria-hidden="true" />
              Type a note
            </Button>
            {backButton}
            {close}
          </Actions>
        </>
      )}

      {(phase.kind === "idle" || phase.kind === "requesting") && (
        <>
          <p className={s.disclosure}>
            Up to {durationWords(MAX_RECORDING_SECONDS)}. Your recording is sent to ElevenLabs to turn it into text.
            ReliefReady keeps only the words you confirm, never the audio.
          </p>
          <Actions>
            <Button
              ref={primaryRef}
              variant="primary"
              busy={phase.kind === "requesting"}
              busyLabel="Waiting for the microphone"
              onClick={() => void startRecording()}
            >
              <Mic size={20} aria-hidden="true" />
              Record
            </Button>
            {phase.kind === "requesting" && <Note>Your browser will ask to use the microphone.</Note>}
            {backButton}
            {typeInstead}
            {close}
          </Actions>
        </>
      )}

      {phase.kind === "recording" && (
        <>
          <p className={`${s.status} ${s.recording}`}>
            <span className={s.dot} aria-hidden="true" />
            <span>Recording</span>
            <span className={s.clock}>
              {formatElapsed(elapsed)} <span className={s.limit}>of {LIMIT_TEXT}</span>
            </span>
          </p>
          <Actions>
            <Button ref={primaryRef} variant="primary" onClick={() => stopRecording("user")}>
              <Square size={18} aria-hidden="true" />
              Stop
            </Button>
            {typeInstead}
          </Actions>
        </>
      )}

      {(phase.kind === "stopped" || phase.kind === "transcribing") && (
        <>
          <p className={s.status}>
            {phase.kind === "stopped" && phase.hitLimit
              ? `Recording stopped at the ${durationWords(MAX_RECORDING_SECONDS)} limit.`
              : `Recorded ${durationWords(phase.take.seconds)}.`}
          </p>
          <audio className={s.player} controls preload="metadata" src={phase.take.url} aria-label="Listen back to your recording" />
          <p className={s.disclosure}>
            Transcribe sends this recording to ElevenLabs once. Nothing is saved until you confirm the words.
          </p>
          <Actions>
            <Button
              ref={primaryRef}
              variant="primary"
              busy={phase.kind === "transcribing"}
              busyLabel="Transcribing"
              onClick={() => void transcribe(phase.take)}
            >
              Transcribe
            </Button>
            {slow && phase.kind === "transcribing" && <Note>Still transcribing. This can take a little while.</Note>}
            <Button variant="secondary" disabled={phase.kind === "transcribing"} onClick={() => void startRecording()}>
              <RotateCcw size={18} aria-hidden="true" />
              Re-record
            </Button>
            {backButton}
            {typeInstead}
          </Actions>
        </>
      )}

      {(phase.kind === "review" || phase.kind === "saving") && (
        <>
          <p className={s.review}>
            Transcribed by ElevenLabs. Speech recognition makes mistakes, so check names, times and amounts and fix
            anything it misheard. Only the words you confirm are saved.
          </p>
          <TextArea
            ref={fieldRef}
            label="Transcript"
            hint="Edit it like any note. Each fact still comes back to you to approve."
            rows={6}
            value={transcript ?? ""}
            maxLength={MAX_TRANSCRIPT_CHARS}
            readOnly={phase.kind === "saving"}
            onChange={(event) => {
              setTranscript(event.target.value);
              setSaveError(null);
            }}
          />
          {saveError && <ErrorNote message={saveError} />}
          {saveNotice && (
            <p className={s.notice} role="status">
              {saveNotice}
            </p>
          )}
          <Actions>
            <Button
              ref={primaryRef}
              variant="primary"
              busy={phase.kind === "saving"}
              busyLabel="Reading your note…"
              onClick={() => void confirmTranscript()}
            >
              Use transcript
            </Button>
            {slow && phase.kind === "saving" && <Note>Still reading. This can take a little while.</Note>}
            <Button variant="secondary" disabled={phase.kind === "saving"} onClick={() => void startRecording()}>
              <RotateCcw size={18} aria-hidden="true" />
              Re-record
            </Button>
            {close}
          </Actions>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <ErrorNote message={phase.message} />
          {errorTake && (
            <audio
              className={s.player}
              controls
              preload="metadata"
              src={errorTake.url}
              aria-label="Listen back to your recording"
            />
          )}
          <Actions>
            {errorTake ? (
              <>
                <Button ref={primaryRef} variant="primary" onClick={() => void transcribe(errorTake)}>
                  Try again
                </Button>
                <Button variant="secondary" onClick={() => void startRecording()}>
                  <RotateCcw size={18} aria-hidden="true" />
                  Re-record
                </Button>
              </>
            ) : (
              <Button ref={primaryRef} variant="primary" onClick={() => void startRecording()}>
                <Mic size={20} aria-hidden="true" />
                Record again
              </Button>
            )}
            {backButton}
            {typeInstead}
            {close}
          </Actions>
        </>
      )}
    </section>
  );
}
