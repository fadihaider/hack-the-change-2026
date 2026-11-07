import "server-only";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

export const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export class GoogleIntegrationError extends Error {
  code: "google_reauth_required" | "google_request_failed" | "invalid_google_response";
  constructor(code: GoogleIntegrationError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface GoogleDependencies {
  clientId: string;
  clientSecret: string;
  // Loads the signed-in owner's encrypted DB token and decrypts it server-side.
  loadAccount: (userId: string) => Promise<{ email: string; refreshToken: string }>;
  fetch?: typeof fetch;
}

export function googleClient(dependencies: GoogleDependencies) {
  const request = dependencies.fetch ?? fetch;

  async function accessToken(refreshToken: string): Promise<string> {
    if (!refreshToken) throw new GoogleIntegrationError("google_reauth_required");
    const response = await request("https://oauth2.googleapis.com/token", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: dependencies.clientId, client_secret: dependencies.clientSecret,
        grant_type: "refresh_token", refresh_token: refreshToken,
      }),
    });
    if (!response.ok) throw new GoogleIntegrationError(response.status === 400 ? "google_reauth_required" : "google_request_failed");
    const result = await response.json() as { access_token?: unknown };
    if (typeof result.access_token !== "string" || !result.access_token) throw new GoogleIntegrationError("invalid_google_response");
    return result.access_token;
  }

  return {
    async send(message: { userId: string; to: string; subject: string; text: string }): Promise<{ id: string }> {
      // Use one address object so a contact string cannot add Cc/Bcc recipients.
      if (!/^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+$/.test(message.to)) throw new Error("Invalid recipient address");
      const account = await dependencies.loadAccount(message.userId);
      if (!/^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+$/.test(account.email)) throw new Error("Invalid sender address");
      const mime = await new MailComposer({
        from: { address: account.email, name: "" },
        to: [{ address: message.to, name: "" }], subject: message.subject, text: message.text,
        disableFileAccess: true, disableUrlAccess: true,
      }).compile().build();
      const response = await request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${await accessToken(account.refreshToken)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: mime.toString("base64url") }),
      });
      if (!response.ok) throw new GoogleIntegrationError(response.status === 401 ? "google_reauth_required" : "google_request_failed");
      const result = await response.json() as { id?: unknown };
      if (typeof result.id !== "string" || !result.id) throw new GoogleIntegrationError("invalid_google_response");
      return { id: result.id };
    },

    async listEvents(input: { userId: string; startsAt: Date; endsAt: Date; calendarId?: string }): Promise<CalendarEvent[]> {
      if (!Number.isFinite(input.startsAt.getTime()) || !Number.isFinite(input.endsAt.getTime()) || input.startsAt >= input.endsAt) {
        throw new Error("Invalid calendar window");
      }
      const account = await dependencies.loadAccount(input.userId);
      const token = await accessToken(account.refreshToken);
      const events: CalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId ?? "primary")}/events`);
        url.search = new URLSearchParams({
          singleEvents: "true", orderBy: "startTime", timeMin: input.startsAt.toISOString(),
          timeMax: input.endsAt.toISOString(), maxResults: "2500", ...(pageToken ? { pageToken } : {}),
        }).toString();
        const response = await request(url, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new GoogleIntegrationError(response.status === 401 ? "google_reauth_required" : "google_request_failed");
        const page = await response.json() as { items?: CalendarEvent[]; nextPageToken?: string };
        if (page.items !== undefined && !Array.isArray(page.items)) throw new GoogleIntegrationError("invalid_google_response");
        events.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return events;
    },
  };
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  attendeesOmitted?: boolean;
}
