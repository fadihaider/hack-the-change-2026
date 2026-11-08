// mail adapters (docs/MVP.md RR_MAIL): outbox stores each message locally, gmail sends through lib/google.ts
import "server-only";
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

export function createMailSender(mode: MailMode, deps: { sql: SqlRunner; accounts: AccountStore }): MailSender {
  return mode === "gmail" ? createGmailMailer(deps.accounts) : createOutboxMailer(deps.sql);
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
