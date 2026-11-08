// GET /r/[token]: the recipient's response page. read-only preview; the client form makes the one confirming POST
import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getRuntime } from "../../../lib/mvp/runtime.ts";
import { RateLimitedError } from "../../api/_lib/http.ts";
import { limitResponseLinks, requestHandlers } from "../../api/_lib/requests.ts";
import { MinimalHeader } from "@/components/app/recover/MinimalHeader.tsx";
import { Column, Note, Question } from "@/components/app/ui.tsx";
import { formatAlberta } from "@/lib/frontend/live-api.ts";
import ResponseForm from "./ResponseForm.tsx";
import s from "./respond.module.css";

export const dynamic = "force-dynamic";

// the url is a bearer secret: never send it on as a referrer, never index it
export const metadata: Metadata = {
  title: "Respond to a request | ReliefReady",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

type Choice = "accept" | "decline" | "propose";

interface Preview {
  subject: string;
  body: string;
  state: string;
  choice: Choice;
  respondBy: string | null;
}

type Loaded = { ok: true; preview: Preview } | { ok: false; reason: "not_found" | "rate_limited" | "unavailable" };

const FAILURES: Record<Extract<Loaded, { ok: false }>["reason"], { title: string; next: string }> = {
  not_found: {
    title: "This link is invalid or has expired.",
    next: "If you still need to answer, ask the person who sent it for a new message.",
  },
  rate_limited: {
    title: "Too many tries from this network.",
    next: "Wait a few minutes, then open the link again.",
  },
  unavailable: {
    title: "This page isn’t available right now.",
    next: "Nothing was recorded. Open the link again a little later.",
  },
};

async function loadPreview(token: string): Promise<Loaded> {
  try {
    const rt = await getRuntime();
    await limitResponseLinks(rt, new Headers(await headers()));
    // the preview handler only reads: it never transitions, consumes tokens or writes evidence
    const response = await requestHandlers(rt).preview(new Request(new URL("/r/preview", rt.baseUrl), { method: "GET" }), token);
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (!response.ok) return { ok: false, reason: "unavailable" };
    const data = (await response.json()) as { request: Preview };
    return { ok: true, preview: data.request };
  } catch (error) {
    return { ok: false, reason: error instanceof RateLimitedError ? "rate_limited" : "unavailable" };
  }
}

/** "Mon, Nov 9, 7:37 p.m." in Alberta time (UTC-6 all year in this product) */
function albertaTime(iso: string): string | null {
  return Number.isFinite(Date.parse(iso)) ? formatAlberta(iso) : null;
}

export default async function ResponsePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadPreview(token);

  return (
    <div className={s.page}>
      <MinimalHeader />
      <main id="main" className={s.main}>
        {loaded.ok ? (
          <Column>
            {/* plain text only: subject and body are rendered as text, never as html */}
            <ResponseForm
              token={token}
              choice={loaded.preview.choice}
              state={loaded.preview.state}
              subject={loaded.preview.subject}
              body={loaded.preview.body}
              respondBy={loaded.preview.respondBy ? albertaTime(loaded.preview.respondBy) : null}
            />
          </Column>
        ) : (
          <Column>
            <Question>{FAILURES[loaded.reason].title}</Question>
            <Note align="start">{FAILURES[loaded.reason].next}</Note>
          </Column>
        )}
      </main>
    </div>
  );
}
