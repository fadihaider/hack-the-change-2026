// GET /outbox: the local demo outbox (RR_MAIL=outbox). messages were stored, not sent; response links work locally
import "server-only";
import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getRuntime } from "../../lib/mvp/runtime.ts";
import { listOutbox, type OutboxMessage } from "../../lib/mvp/mail.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Demo outbox | ReliefReady",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// only the app's own response links become clickable; any other text stays plain
const RESPONSE_LINK = /(https?:\/\/[^\s/]+\/r\/[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

const shell: CSSProperties = { maxWidth: 820, margin: "40px auto", padding: "0 20px", display: "grid", gap: 18 };
const card: CSSProperties = {
  background: "var(--white, #fff)",
  border: "1px solid var(--line, #e9e3db)",
  borderRadius: 20,
  padding: 22,
  display: "grid",
  gap: 10,
};
const banner: CSSProperties = {
  background: "var(--clay-soft, #fff0e9)",
  color: "var(--clay, #9a442d)",
  border: "1px solid var(--line, #e9e3db)",
  borderRadius: 14,
  padding: "12px 16px",
  fontWeight: 700,
};

function linkify(body: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(RESPONSE_LINK)) {
    const start = match.index ?? 0;
    parts.push(body.slice(last, start));
    parts.push(
      <a key={start} href={match[1]} rel="noreferrer">
        {match[1]}
      </a>,
    );
    last = start + match[0].length;
  }
  parts.push(body.slice(last));
  return parts;
}

function albertaTime(iso: string): string {
  const local = new Date(Date.parse(iso) - 6 * 60 * 60 * 1000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)} Alberta Time`;
}

async function loadMessages(): Promise<{ mail: string; messages: OutboxMessage[] } | null> {
  try {
    const rt = await getRuntime();
    const request = new Request(new URL("/outbox", rt.baseUrl), { headers: new Headers(await headers()) });
    const user = await rt.auth.currentUser(request);
    if (!user) return null;
    const messages = rt.mode.mail === "outbox" ? await listOutbox(rt.stores.database, user.id) : [];
    return { mail: rt.mode.mail, messages };
  } catch {
    return null;
  }
}

export default async function OutboxPage() {
  const loaded = await loadMessages();
  return (
    <main style={shell}>
      <p style={{ fontWeight: 700 }}>
        <a href="/">ReliefReady</a> / Outbox
      </p>
      <p role="note" style={banner}>
        Local demo outbox: no real email was sent
      </p>
      {loaded === null ? (
        <section style={card}>
          <p>The outbox is not available. Sign in and make sure the local workspace is running.</p>
        </section>
      ) : loaded.mail !== "outbox" ? (
        <section style={card}>
          <p>Mail is set to {loaded.mail}, so messages go out through that adapter and are not kept here.</p>
        </section>
      ) : loaded.messages.length === 0 ? (
        <section style={card}>
          <p>No messages yet. Approved requests appear here when they are sent.</p>
        </section>
      ) : (
        loaded.messages.map((message) => (
          <article key={message.id} style={card} aria-label={`Message to ${message.to}`}>
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
              <dt style={{ color: "var(--muted, #6e675f)" }}>To</dt>
              <dd style={{ margin: 0 }}>{message.to}</dd>
              <dt style={{ color: "var(--muted, #6e675f)" }}>Subject</dt>
              <dd style={{ margin: 0, fontWeight: 700 }}>{message.subject}</dd>
              <dt style={{ color: "var(--muted, #6e675f)" }}>Sent</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={message.sentAt}>{albertaTime(message.sentAt)}</time>
              </dd>
            </dl>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{linkify(message.body)}</div>
          </article>
        ))
      )}
    </main>
  );
}
