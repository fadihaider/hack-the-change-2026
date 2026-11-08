// mail adapters (docs/MVP.md RR_MAIL): outbox stores each message locally, gmail sends through lib/google.ts.
// demo copy (DEMO_EMAIL_TO): every sent message is also emailed to one demo inbox through Gmail SMTP
import "server-only";
import nodemailer from "nodemailer";
import { p, type SqlRunner } from "../db.ts";
import type { AccountStore } from "../auth/google.ts";
import { googleAccountLoader } from "../auth/google.ts";
import { googleClient } from "../google.ts";

export interface OutgoingMessage {
  userId: string;
  to: string;
  subject: string;
  text: string;
}

/** same shape as sendApprovedRequest's send dependency in lib/requests/workflow.ts */
export interface MailSender {
  send(message: OutgoingMessage): Promise<{ id: string }>;
}

export type MailMode = "outbox" | "gmail";

/** an adapter was selected by env but its settings are missing; routes answer 503 */
export class NotConfiguredError extends Error {
  readonly code = "not_configured";

  constructor(readonly adapter: string) {
    super(`${adapter} is not configured`);
    this.name = "NotConfiguredError";
  }
}

const ADDRESS = /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+$/;

export function createOutboxMailer(sql: SqlRunner): MailSender {
  return {
    async send(message: OutgoingMessage): Promise<{ id: string }> {
      if (!ADDRESS.test(message.to)) throw new Error("Invalid recipient address");
      const rows = await sql.query<{ id: string }>(
        `INSERT INTO outbox_message (user_id, to_email, subject, body)
          VALUES (CAST(:user_id AS uuid), :to_email, :subject, :body) RETURNING id::text AS id`,
        [
          p.uuid("user_id", message.userId),
          p.text("to_email", message.to),
          p.text("subject", message.subject),
          p.text("body", message.text),
        ],
      );
      return { id: rows[0].id };
    },
  };
}

/** gmail.send for the signed-in owner; throws NotConfiguredError until the Google client and APP_ENC_KEY are set */
export function createGmailMailer(accounts: AccountStore, env: NodeJS.ProcessEnv = process.env): MailSender {
  return {
    async send(message: OutgoingMessage): Promise<{ id: string }> {
      const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_ENC_KEY } = env;
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !APP_ENC_KEY) throw new NotConfiguredError("gmail");
      const client = googleClient({
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        loadAccount: googleAccountLoader({ store: accounts, encryptionKey: APP_ENC_KEY }),
      });
      return client.send(message);
    },
  };
}

export interface DemoCopyConfig {
  /** the demo inbox that gets a copy of every message */
  to: string;
  /** the Gmail address that sends the copies */
  user: string;
  /** that account's 16-letter app password */
  pass: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** DEMO_EMAIL_TO, DEMO_SMTP_USER and DEMO_SMTP_PASS, or null when any is missing or malformed (no copies) */
export function demoCopyConfig(env: Env = process.env): DemoCopyConfig | null {
  const to = env.DEMO_EMAIL_TO?.trim() ?? "";
  const user = env.DEMO_SMTP_USER?.trim() ?? "";
  // Google shows app passwords in groups of four with spaces
  const pass = (env.DEMO_SMTP_PASS ?? "").replace(/\s+/g, "");
  if (!ADDRESS.test(to) || !ADDRESS.test(user) || pass.length < 16) return null;
  return { to, user, pass };
}

export type CopySender = (message: { from: string; to: string; subject: string; text: string }) => Promise<unknown>;

function gmailSmtp(config: DemoCopyConfig): CopySender {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return (message) => transport.sendMail(message);
}

/**
 * the real send first, then a copy to the demo inbox. a failed copy never fails the send: the message already went
 * to the outbox or Gmail, so it is only logged (without addresses)
 */
export function withDemoCopy(inner: MailSender, config: DemoCopyConfig | null, sendCopy?: CopySender): MailSender {
  if (!config) return inner;
  const copy = sendCopy ?? gmailSmtp(config);
  return {
    async send(message: OutgoingMessage): Promise<{ id: string }> {
      const result = await inner.send(message);
      try {
        await copy({
          from: `ReliefReady demo <${config.user}>`,
          to: config.to,
          subject: message.subject,
          text: `[ReliefReady demo copy. This message was sent to ${message.to}.]\n\n${message.text}`,
        });
      } catch (caught) {
        console.error("demo email copy failed:", caught instanceof Error ? caught.name : "unknown error");
      }
      return result;
    },
  };
}

export function createMailSender(mode: MailMode, deps: { sql: SqlRunner; accounts: AccountStore }): MailSender {
  const inner = mode === "gmail" ? createGmailMailer(deps.accounts) : createOutboxMailer(deps.sql);
  return withDemoCopy(inner, demoCopyConfig());
}

export interface OutboxMessage {
  id: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

/** the owner's stored demo messages, newest first; bodies hold the raw response links, so this is owner-only */
export async function listOutbox(sql: SqlRunner, userId: string): Promise<OutboxMessage[]> {
  const rows = await sql.query<{ id: string; to_email: string; subject: string; body: string; sent_at: string }>(
    `SELECT id::text AS id, to_email, subject, body, to_json(sent_at)#>>'{}' AS sent_at
      FROM outbox_message WHERE user_id = CAST(:user_id AS uuid)
      ORDER BY sent_at DESC, id`,
    [p.uuid("user_id", userId)],
  );
  return rows.map((row) => ({
    id: row.id,
    to: row.to_email,
    subject: row.subject,
    body: row.body,
    sentAt: new Date(row.sent_at).toISOString(),
  }));
}
