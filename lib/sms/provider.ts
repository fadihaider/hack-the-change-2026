// sms adapters (RR_SMS): twilio sends real texts through Twilio Programmable Messaging; demo stores them in sms_outbox,
// labelled simulated, and nothing leaves the machine. blank RR_SMS picks twilio when its three settings are present.
// Twilio Messages API: POST/GET https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages[/{Sid}].json
import "server-only";
import { p, type SqlRunner } from "../db.ts";
import { NotConfiguredError } from "../mvp/mail.ts";

export type SmsMode = "twilio" | "demo";

export interface SmsSubmission {
  /** Twilio's message SID (SM + 32 hex), or demo_<uuid> */
  sid: string;
  /** the provider's status word right after submission (queued, accepted, ...), or simulated */
  status: string;
}

export interface SmsStatusReading {
  status: string;
  /** Twilio's numeric error code as text, only for failed or undelivered */
  errorCode: string | null;
}

export interface SmsProvider {
  mode: SmsMode;
  /** never retried: a timeout may still have sent. throws SmsSendError */
  submit(message: { userId: string; requestId: string; to: string; body: string }): Promise<SmsSubmission>;
  /** the current provider status; null when the provider keeps none (demo) */
  status(sid: string): Promise<SmsStatusReading | null>;
}

/**
 * a send that did not go through. code is safe to store and show (twilio_21211, twilio_http_401, ...): never the
 * provider's message text, which can echo phone numbers. definite=false means it may have sent (timeout, dropped
 * connection), so the request stays "sending" for the owner to check instead of being marked failed.
 */
export class SmsSendError extends Error {
  constructor(readonly code: string, readonly definite: boolean) {
    super(`sms send failed: ${code}`);
    this.name = "SmsSendError";
  }
}

/** statuses after which Twilio changes nothing more (docs: Message resource, status values) */
export const FINAL_STATUSES = new Set(["delivered", "undelivered", "failed", "canceled", "read"]);

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** an E.164 number (From) or a Messaging Service SID (MessagingServiceSid) */
  from: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const TIMEOUT_MS = 15_000;

/** the three Twilio settings, or null when any is missing or malformed */
export function twilioConfig(env: Env = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const from = (env.TWILIO_PHONE_NUMBER?.trim() ?? "").replace(/[\s().-]/g, "");
  if (!ACCOUNT_SID.test(accountSid) || authToken.length < 16 || !(E164.test(from) || SERVICE_SID.test(from))) return null;
  return { accountSid, authToken, from };
}

export function smsMode(env: Env = process.env): SmsMode {
  const chosen = (env.RR_SMS ?? "").trim().toLowerCase();
  if (chosen === "demo" || chosen === "twilio") return chosen;
  if (chosen === "") return twilioConfig(env) ? "twilio" : "demo";
  throw new NotConfiguredError("RR_SMS");
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** the error code in a Twilio error body ({code, message, more_info, status}); only digits are kept */
async function twilioErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === "number" && Number.isInteger(body.code)) return `twilio_${body.code}`;
  } catch {
    // not json; the status is all that is kept
  }
  return `twilio_http_${response.status}`;
}

export function createTwilioProvider(config: TwilioConfig | null, fetcher: Fetch = fetch): SmsProvider {
  function require(): TwilioConfig {
    // RR_SMS=twilio without its settings: routes answer 503 not_configured instead of quietly simulating
    if (!config) throw new NotConfiguredError("twilio");
    return config;
  }
  function endpoint(path: string): { url: string; headers: Record<string, string> } {
    const c = require();
    const auth = Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");
    return {
      url: `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/${path}`,
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    };
  }

  return {
    mode: "twilio",
    async submit(message) {
      const c = require();
      const { url, headers } = endpoint("Messages.json");
      const form = new URLSearchParams({ To: message.to, Body: message.body });
      form.set(SERVICE_SID.test(c.from) ? "MessagingServiceSid" : "From", c.from);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // no answer: Twilio may or may not have queued it
        throw new SmsSendError("twilio_unconfirmed", false);
      }
      if (!response.ok) {
        // a 5xx may still have queued the message; a 4xx is a definite refusal (bad number, auth, trial limits)
        throw new SmsSendError(await twilioErrorCode(response), response.status < 500);
      }
      let body: { sid?: unknown; status?: unknown };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new SmsSendError("twilio_unconfirmed", false);
      }
      if (typeof body.sid !== "string" || !MESSAGE_SID.test(body.sid)) throw new SmsSendError("twilio_unconfirmed", false);
      return { sid: body.sid, status: typeof body.status === "string" ? body.status : "queued" };
    },
    async status(sid) {
      if (!MESSAGE_SID.test(sid)) return null;
      const { url, headers } = endpoint(`Messages/${sid}.json`);
      const response = await fetcher(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new SmsSendError(await twilioErrorCode(response), false);
      const body = (await response.json()) as { status?: unknown; error_code?: unknown };
      if (typeof body.status !== "string") return null;
      const code = body.error_code;
      return {
        status: body.status,
        errorCode: typeof code === "number" || (typeof code === "string" && /^\d{1,6}$/.test(code)) ? String(code) : null,
      };
    },
  };
}

/** the demo adapter: the text is stored for /outbox and reported as simulated. nothing is delivered */
export function createDemoSmsProvider(sql: SqlRunner): SmsProvider {
  return {
    mode: "demo",
    async submit(message) {
      const rows = await sql.query<{ id: string }>(
        `INSERT INTO sms_outbox (user_id, request_id, to_phone, body)
          VALUES (CAST(:user_id AS uuid), CAST(:request_id AS uuid), :to_phone, :body) RETURNING id::text AS id`,
        [p.uuid("user_id", message.userId), p.uuid("request_id", message.requestId), p.text("to_phone", message.to),
          p.text("body", message.body)],
      );
      return { sid: `demo_${rows[0].id}`, status: "simulated" };
    },
    async status() {
      return null;
    },
  };
}

export function createSmsProvider(mode: SmsMode, deps: { sql: SqlRunner; env?: Env; fetcher?: Fetch }): SmsProvider {
  return mode === "twilio" ? createTwilioProvider(twilioConfig(deps.env ?? process.env), deps.fetcher) : createDemoSmsProvider(deps.sql);
}

export interface SmsOutboxMessage {
  id: string;
  to: string;
  body: string;
  sentAt: string;
}

/** the owner's simulated texts, newest first */
export async function listSmsOutbox(sql: SqlRunner, userId: string): Promise<SmsOutboxMessage[]> {
  const rows = await sql.query<{ id: string; to_phone: string; body: string; sent_at: string }>(
    `SELECT id::text AS id, to_phone, body, to_json(sent_at)#>>'{}' AS sent_at FROM sms_outbox
      WHERE user_id = CAST(:user_id AS uuid) ORDER BY sent_at DESC, id`,
    [p.uuid("user_id", userId)],
  );
  return rows.map((row) => ({ id: row.id, to: row.to_phone, body: row.body, sentAt: new Date(row.sent_at).toISOString() }));
}
