// GET /r/[token]: the recipient's response page. read-only preview; the client form makes the one confirming POST
import "server-only";
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getRuntime } from "../../../lib/mvp/runtime.ts";
import { RateLimitedError } from "../../api/_lib/http.ts";
import { limitResponseLinks, requestHandlers } from "../../api/_lib/requests.ts";
import ResponseForm from "./ResponseForm.tsx";

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

const CHOICE_LABELS: Record<Choice, string> = {
  accept: "Accept",
  decline: "Decline",
  propose: "Propose another time",
};

const STATE_LABELS: Record<string, string> = {
  accepted: "Accepted",
  rejected: "Declined",
  needs_review: "Another time was proposed",
  completed: "Completed",
};

// closed without an answer: these read as a full sentence, not as "a recorded answer"
const CLOSED_MESSAGES: Record<string, string> = {
  expired: "This request expired before an answer was recorded.",
  cancelled: "The sender cancelled this request.",
};

const shell: CSSProperties = { maxWidth: 640, margin: "48px auto", padding: "0 20px", display: "grid", gap: 20 };
const card: CSSProperties = {
  background: "var(--white, #fff)",
  border: "1px solid var(--line, #e9e3db)",
  borderRadius: 20,
  padding: 24,
  display: "grid",
  gap: 14,
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

function albertaTime(iso: string): string {
  const local = new Date(Date.parse(iso) - 6 * 60 * 60 * 1000);
  const date = local.toISOString().slice(0, 10);
  return `${date} ${local.toISOString().slice(11, 16)} Alberta Time`;
}

export default async function ResponsePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadPreview(token);

  if (!loaded.ok) {
    const message = {
      not_found: "This link is invalid or has expired.",
      rate_limited: "Too many attempts from this network. Please wait a few minutes and try again.",
      unavailable: "This page is not available right now. Please try again later.",
    }[loaded.reason];
    return (
      <main style={shell}>
        <p style={{ fontWeight: 700 }}>ReliefReady</p>
        <section style={card}>
          <p>{message}</p>
        </section>
      </main>
    );
  }

  const { preview } = loaded;
  const answered = preview.state !== "requested";
  return (
    <main style={shell}>
      <p style={{ fontWeight: 700 }}>ReliefReady</p>
      <section style={card} aria-labelledby="request-subject">
        <p style={{ color: "var(--muted, #6e675f)" }}>A request sent to you</p>
        {/* plain text only: subject and body are rendered as text, never as html */}
        <h1 id="request-subject" style={{ fontSize: 20 }}>
          {preview.subject}
        </h1>
        <div style={{ whiteSpace: "pre-wrap" }}>{preview.body}</div>
        {preview.respondBy && (
          <p style={{ color: "var(--muted, #6e675f)" }}>Please respond by {albertaTime(preview.respondBy)}.</p>
        )}
      </section>
      <section style={card} aria-label="Your response">
        {answered ? (
          <p role="status" style={{ fontWeight: 600 }}>
            {CLOSED_MESSAGES[preview.state] ??
              `This request already has a recorded answer: ${STATE_LABELS[preview.state] ?? preview.state}.`}
          </p>
        ) : (
          <>
            <p>
              This link answers <strong>{CHOICE_LABELS[preview.choice]}</strong>. Nothing is recorded until you confirm.
            </p>
            <ResponseForm token={token} choice={preview.choice} />
          </>
        )}
      </section>
    </main>
  );
}
