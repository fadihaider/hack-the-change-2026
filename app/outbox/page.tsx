// GET /outbox: the local demo outbox (RR_MAIL=outbox). messages were stored, not sent; response links work locally
import "server-only";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Info } from "lucide-react";
import { getRuntime } from "../../lib/mvp/runtime.ts";
import { listOutbox, type OutboxMessage } from "../../lib/mvp/mail.ts";
import { listSmsOutbox, type SmsOutboxMessage } from "../../lib/sms/provider.ts";
import { maskPhone } from "../../lib/sms/phone.ts";
import { MinimalHeader } from "@/components/app/recover/MinimalHeader.tsx";
import { Column, Note, Question } from "@/components/app/ui.tsx";
import { formatAlberta } from "@/lib/frontend/live-api.ts";
import s from "./outbox.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Demo outbox | ReliefReady",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// only the app's own response links become clickable; any other text stays plain
const RESPONSE_LINK = /(https?:\/\/[^\s/]+\/r\/[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

function linkify(body: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(RESPONSE_LINK)) {
    const start = match.index ?? 0;
    parts.push(body.slice(last, start));
    parts.push(
      <a key={start} href={match[1]} rel="noreferrer" className={s.responseLink}>
        {match[1]}
      </a>,
    );
    last = start + match[0].length;
  }
  parts.push(body.slice(last));
  return parts;
}

/** "Sun, Nov 8, 1:37 a.m." in Alberta time (UTC-6 all year in this product) */
function albertaTime(iso: string): string {
  return formatAlberta(iso);
}

async function loadMessages(): Promise<{ mail: string; messages: OutboxMessage[]; texts: SmsOutboxMessage[] } | null> {
  try {
    const rt = await getRuntime();
    const request = new Request(new URL("/outbox", rt.baseUrl), { headers: new Headers(await headers()) });
    const user = await rt.auth.currentUser(request);
    if (!user) return null;
    const messages = rt.mode.mail === "outbox" ? await listOutbox(rt.stores.database, user.id) : [];
    // simulated texts are kept whichever sms mode runs now, so a demo run stays visible after Twilio is set up
    const texts = await listSmsOutbox(rt.stores.database, user.id);
    return { mail: rt.mode.mail, messages, texts };
  } catch {
    return null;
  }
}

export default async function OutboxPage() {
  const loaded = await loadMessages();
  const count = loaded?.messages.length ?? 0;
  return (
    <div className={s.page}>
      <MinimalHeader href="/" trailing="Demo outbox" />
      <main id="main" className={s.main}>
        <Column>
          <p role="note" className={s.banner}>
            <Info size={18} aria-hidden="true" />
            <span>Local demo outbox: no real email was sent</span>
          </p>
          {loaded === null ? (
            <>
              <Question>The outbox isn’t available.</Question>
              <Note align="start">Sign in and make sure the local workspace is running, then reload this page.</Note>
            </>
          ) : loaded.mail !== "outbox" ? (
            <>
              <Question>Nothing is kept here.</Question>
              <Note align="start">
                Mail is set to {loaded.mail}, so messages go out through that adapter and are not kept here.
              </Note>
            </>
          ) : count === 0 ? (
            <>
              <Question>No messages yet.</Question>
              <Note align="start">Approved requests show up here when they are sent.</Note>
            </>
          ) : (
            <>
              <Question>
                {count === 1
                  ? "Here’s the message that would have gone out."
                  : `Here are the ${count} messages that would have gone out.`}
              </Question>
              <p className={s.count}>Newest first. The reply links work on this computer.</p>
              <ol className={s.list} role="list">
                {loaded.messages.map((message) => (
                  <li key={message.id}>
                    <article className={s.letter} aria-label={`Message to ${message.to}`}>
                      <dl className={s.head}>
                        <div className={s.row}>
                          <dt>To</dt>
                          <dd>{message.to}</dd>
                        </div>
                        <div className={s.row}>
                          <dt>Subject</dt>
                          <dd className={s.subject}>{message.subject}</dd>
                        </div>
                        <div className={s.row}>
                          <dt>Sent</dt>
                          <dd>
                            <time dateTime={message.sentAt}>{albertaTime(message.sentAt)}</time>
                          </dd>
                        </div>
                      </dl>
                      <div className={s.body}>{linkify(message.body)}</div>
                    </article>
                  </li>
                ))}
              </ol>
            </>
          )}
          {loaded && loaded.texts.length > 0 && (
            <section aria-labelledby="outbox-texts" className={s.texts}>
              <p role="note" className={s.banner}>
                <Info size={18} aria-hidden="true" />
                <span>Simulated texts: not delivered to any phone</span>
              </p>
              <h2 id="outbox-texts" className={s.textsTitle}>
                {loaded.texts.length === 1 ? "1 text that would have gone out" : `${loaded.texts.length} texts that would have gone out`}
              </h2>
              <ol className={s.list} role="list">
                {loaded.texts.map((text) => (
                  <li key={text.id}>
                    <article className={s.letter} aria-label={`Simulated text to ${maskPhone(text.to)}`}>
                      <dl className={s.head}>
                        <div className={s.row}>
                          <dt>To</dt>
                          <dd>{maskPhone(text.to)}</dd>
                        </div>
                        <div className={s.row}>
                          <dt>Saved</dt>
                          <dd>
                            <time dateTime={text.sentAt}>{albertaTime(text.sentAt)}</time>
                          </dd>
                        </div>
                      </dl>
                      <div className={s.body}>{text.body}</div>
                    </article>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </Column>
      </main>
    </div>
  );
}
