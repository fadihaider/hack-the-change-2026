"use client";
// care: what anyone helping rosa should know. one calm overview, and one question per step when checking notes
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { liveErrorMessage, type CareFactView, type CareProfileView, type CareSourceView } from "@/lib/frontend/live-api.ts";
import { recipientName, useApis, useSession } from "../session.tsx";
import { Actions, ButtonLink, Column, ErrorNote, Question, useAnnounce } from "../ui.tsx";
import { AddWhatYouKnow, type AddedFrom } from "./AddWhatYouKnow.tsx";
import { CareHome } from "./CareHome.tsx";
import { ReviewSteps, type ReviewSummary } from "./ReviewSteps.tsx";
import { pendingSteps, plural, possessive, type ReviewStep } from "./care-data.ts";
import s from "./care.module.css";

type View =
  | { kind: "home" }
  | { kind: "add" }
  | { kind: "review"; steps: ReviewStep[]; intro: string | null; notes: Record<string, string> };

type Review = Extract<View, { kind: "review" }>;

/** the sub-flow lives in ?step= so the top bar's Care link (plain /care) always returns to the overview */
function stepOf(param: string | null): View["kind"] {
  return param === "add" || param === "review" ? param : "home";
}

export function CareScreen() {
  const { session, loading, error, reload } = useSession();
  const { live } = useApis();
  const announce = useAnnounce();
  const params = useSearchParams();
  const kind = stepOf(params.get("step"));
  const [review, setReview] = useState<Review | null>(null);
  const [direction, setDirection] = useState<"forward" | "back" | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [profile, setProfile] = useState<CareProfileView | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const moved = useRef(false);
  const seq = useRef(0);

  const episodeId = session?.episode?.id ?? null;
  const name = recipientName(session);

  const loadProfile = useCallback(async (): Promise<CareProfileView | null> => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const next = await live.careProfile();
      if (mine === seq.current) {
        setProfile(next);
        setProfileError(null);
        setVersion((value) => value + 1);
      }
      return next;
    } catch (caught) {
      if (mine === seq.current) setProfileError(liveErrorMessage(caught));
      return null;
    }
  }, [live]);

  useEffect(() => {
    if (episodeId) void loadProfile();
  }, [episodeId, loadProfile]);

  // leaving the sub-flow any other way (top bar link, browser back) also lands on the overview
  const lastKind = useRef(kind);
  useEffect(() => {
    if (lastKind.current === kind) return;
    if (kind === "home") {
      moved.current = true;
      setDirection("back");
    }
    if (kind !== "review") setReview(null);
    lastKind.current = kind;
  }, [kind]);

  // a review opened by url (reload, browser forward) starts from whatever is still waiting, fixed once
  const hasProfile = profile !== null;
  useEffect(() => {
    if (kind !== "review" || review || !profile) return;
    setReview({ kind: "review", steps: pendingSteps(profile.facts), intro: null, notes: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, review, hasProfile]);

  function go(next: View, dir: "forward" | "back") {
    moved.current = true;
    setDirection(dir);
    setReview(next.kind === "review" ? next : null);
    lastKind.current = next.kind;
    const url = next.kind === "home" ? window.location.pathname : `${window.location.pathname}?step=${next.kind}`;
    // native history calls are picked up by useSearchParams without a server round trip
    window.history.pushState(null, "", url);
  }

  /** a note or pdf was read: check what it found, newest first. returns a message when there is nothing to check */
  async function added(result: CareSourceView, from: AddedFrom): Promise<string | null> {
    const latest = (await loadProfile()) ?? profile;
    const byId = new Map<string, CareFactView>((latest?.facts ?? []).map((fact) => [fact.id, fact]));
    for (const fact of result.facts) byId.set(fact.id, fact);
    const steps = pendingSteps([...byId.values()], result.source.id);
    const where = from === "pdf" ? "The PDF" : "Your note";
    // dropped lines were already on file, repeated, or not found word for word in the source
    const count = result.droppedCount;
    const lines = result.facts.length > 0 ? plural(count, "other line", "other lines") : plural(count, "line", "lines");
    const dropped =
      count > 0
        ? ` ${lines} ${count === 1 ? "was" : "were"} already on file or couldn’t be kept word for word, so ${
            count === 1 ? "it was" : "they were"
          } left out.`
        : "";

    if (result.facts.length === 0) {
      return `${where} didn’t have anything new to add.${dropped} Try one thing per sentence, with times where you know them.`;
    }

    const notes: Record<string, string> = {};
    for (const conflict of result.conflicts) {
      const note = conflict.modelNote?.trim();
      const step = steps.find((item) => item.kind === "conflict" && item.factIds.includes(conflict.factId));
      if (note && step && !notes[step.key]) notes[step.key] = note;
    }
    const fresh = plural(result.facts.length, "new thing", "new things");
    const intro = steps.length > result.facts.length ? `${where} has ${fresh} to check, shown first.${dropped}` : `${where} has ${fresh} to check.${dropped}`;
    announce(intro);
    setReceipt(null);
    go({ kind: "review", steps, intro, notes }, "forward");
    return null;
  }

  function finished(summary: ReviewSummary) {
    const added = summary.approved + summary.kept;
    const parts: string[] = [];
    if (added > 0) parts.push(`Added ${plural(added, "thing", "things")} to ${possessive(name)} profile.`);
    if (summary.skipped > 0) parts.push(`${plural(summary.skipped, "thing is", "things are")} waiting for later.`);
    const text = parts.length > 0 ? parts.join(" ") : null;
    setReceipt(text);
    if (text) announce(text);
    void loadProfile();
    go({ kind: "home" }, "back");
  }

  if (!session) {
    if (loading) {
      return (
        <Column>
          <p className={s.loading} role="status">
            Loading the care details
          </p>
        </Column>
      );
    }
    return (
      <Column>
        <Question>The care details didn’t load.</Question>
        <ErrorNote message={error ?? "ReliefReady couldn’t reach its server."} onRetry={() => void reload()} />
      </Column>
    );
  }

  const episode = session.episode;
  if (!episode) {
    return (
      <Column>
        <Question lead="There’s no care week yet.">Start with what’s happening, then come back here.</Question>
        <Actions>
          <ButtonLink href="/" variant="primary">
            Set up your care week
          </ButtonLink>
        </Actions>
      </Column>
    );
  }

  if (!profile) {
    if (profileError) {
      return (
        <Column>
          <Question>{possessive(name)} care details didn’t load.</Question>
          <ErrorNote message={profileError} onRetry={() => void loadProfile()} />
        </Column>
      );
    }
    return (
      <Column>
        <p className={s.loading} role="status">
          Loading {possessive(name)} care details
        </p>
      </Column>
    );
  }

  const reviewing = kind === "review" ? review : null;

  if (kind === "add") {
    return (
      <AddWhatYouKnow
        key="add"
        name={name}
        motion={direction}
        arrived={moved.current}
        onAdded={added}
        onBack={() => go({ kind: "home" }, "back")}
      />
    );
  }

  if (reviewing && reviewing.steps.length > 0) {
    return (
      <ReviewSteps
        key="review"
        name={name}
        steps={reviewing.steps}
        facts={profile.facts}
        intro={reviewing.intro}
        notes={reviewing.notes}
        onChanged={loadProfile}
        onDone={finished}
      />
    );
  }

  return (
    <CareHome
      name={name}
      session={session}
      episode={episode}
      profile={profile}
      version={version}
      receipt={receipt}
      motion={direction}
      arrived={moved.current}
      onAdd={() => {
        setReceipt(null);
        go({ kind: "add" }, "forward");
      }}
      onReview={(steps) => {
        setReceipt(null);
        go({ kind: "review", steps, intro: null, notes: {} }, "forward");
      }}
      onChanged={loadProfile}
    />
  );
}
