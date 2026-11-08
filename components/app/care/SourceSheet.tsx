"use client";
// the full retained source behind one passport fact, as plain text, with the fact's own words marked
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  albertaDateOf,
  formatDate,
  liveErrorMessage,
  sourceLabel,
  type CareFactView,
  type CareSourceDetailView,
} from "@/lib/frontend/live-api.ts";
import { useApis } from "../session.tsx";
import { ErrorNote, Note, Sheet, SheetTitle, VisuallyHidden, useAnnounce } from "../ui.tsx";
import { authorName, sourceParts } from "./care-data.ts";
import s from "./passport.module.css";

type Props = {
  /** the fact whose source is shown; null keeps the sheet closed */
  fact: CareFactView | null;
  onClose: () => void;
};

type Loaded = { sourceId: string; source: CareSourceDetailView };

export function SourceSheet({ fact, onClose }: Props) {
  const { live } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const sourceId = fact?.sourceId ?? null;

  const load = useCallback(
    async (id: string) => {
      const mine = ++seq.current;
      setError(null);
      try {
        const source = await live.careSource(id);
        if (mine !== seq.current) return;
        setLoaded({ sourceId: id, source });
        announce("Full source loaded.");
      } catch (caught) {
        if (mine === seq.current) setError(liveErrorMessage(caught));
      }
    },
    [live, announce],
  );

  useEffect(() => {
    if (!sourceId) return;
    if (loaded?.sourceId === sourceId) return;
    void load(sourceId);
  }, [sourceId, loaded?.sourceId, load]);

  // a close while loading must not let a late reply land on the next fact
  useEffect(() => {
    if (!fact) seq.current += 1;
  }, [fact]);

  const source = loaded && loaded.sourceId === sourceId ? loaded.source : null;
  const parts = source && fact ? sourceParts(source.fullText, fact) : null;
  const ms = source ? Date.parse(source.createdAt) : Number.NaN;
  const author = source ? authorName(source.author) : null;

  return (
    <Sheet open={fact !== null} onClose={onClose} labelledBy={titleId} closeLabel="Close the full source">
      <SheetTitle id={titleId}>Full source</SheetTitle>
      {!sourceId ? (
        <p className={s.sourceStatus}>This fact has no saved source to show.</p>
      ) : error ? (
        <ErrorNote message={error} onRetry={() => void load(sourceId)} />
      ) : !source ? (
        <p className={s.sourceStatus} role="status">
          Loading the full source…
        </p>
      ) : (
        <>
          <p className={s.sourceMeta}>
            {sourceLabel(source.kind)}
            {Number.isFinite(ms) ? `, added ${formatDate(albertaDateOf(ms))}` : ""}
            {author ? ` by ${author}` : ""}
          </p>
          {parts ? (
            <Note align="start">The highlighted words are the fact in the passport.</Note>
          ) : (
            <Note align="start">The fact’s exact words couldn’t be found in this source, so nothing is highlighted.</Note>
          )}
          <div className={s.sourceText} tabIndex={0} role="region" aria-label="Source text">
            {parts ? (
              <>
                {parts.before}
                <mark className={s.sourceMark}>
                  <VisuallyHidden>Start of the fact: </VisuallyHidden>
                  {parts.match}
                  <VisuallyHidden> End of the fact.</VisuallyHidden>
                </mark>
                {parts.after}
              </>
            ) : (
              source.fullText
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
