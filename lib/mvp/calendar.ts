// calendar adapters (docs/MVP.md RR_CALENDAR): seed returns the 6 fictional demo events, google reads lib/google.ts
import "server-only";
import type { AccountStore } from "../auth/google.ts";
import { googleAccountLoader } from "../auth/google.ts";
import { addDays, ALBERTA_OFFSET } from "../ai/time.ts";
import { googleClient, type CalendarEvent } from "../google.ts";
import { NotConfiguredError } from "./mail.ts";
import { DEMO_EMAIL } from "./seed.ts";

export interface CalendarSource {
  listEvents(userId: string, startsAt: Date, endsAt: Date): Promise<CalendarEvent[]>;
}

export type CalendarMode = "seed" | "google";

const ALBERTA_OFFSET_MS = -6 * 60 * 60 * 1000;

interface SeedEvent {
  id: string;
  /** days after today in Alberta Time, 1 to 7 */
  day: number;
  start: string;
  end: string;
  summary: string;
  location?: string;
  organizer: string;
  attendees: string[];
}

// fictional people (lib/mvp/seed.ts); Foothills Medical Centre is a public hospital address
const SEED_EVENTS: readonly SeedEvent[] = [
  {
    id: "rr-seed-group-project", day: 1, start: "10:00", end: "11:30",
    summary: "ENGG 513 group project meeting", location: "Taylor Family Digital Library, University of Calgary",
    organizer: DEMO_EMAIL, attendees: [DEMO_EMAIL, "jordan.lee@example.test", "sam.patel@example.test"],
  },
  {
    id: "rr-seed-assignment", day: 2, start: "23:00", end: "23:59",
    summary: "ENGG 513 assignment 4 deadline",
    organizer: "avery.brooks@example.test", attendees: [DEMO_EMAIL],
  },
  {
    id: "rr-seed-work-shift", day: 3, start: "16:00", end: "21:00",
    summary: "Work shift at the bookstore", location: "Kensington Rd NW, Calgary",
    organizer: "morgan.chen@example.test", attendees: [DEMO_EMAIL],
  },
  {
    id: "rr-seed-volunteer", day: 4, start: "09:00", end: "12:00",
    summary: "Food bank volunteer shift",
    organizer: "priya.shah@example.test", attendees: [DEMO_EMAIL],
  },
  {
    id: "rr-seed-family-dinner", day: 5, start: "18:00", end: "20:00",
    summary: "Family dinner at Lucia's",
    organizer: "lucia.alvarez@example.test", attendees: [DEMO_EMAIL, "lucia.alvarez@example.test"],
  },
  {
    id: "rr-seed-mom-follow-up", day: 6, start: "14:00", end: "15:00",
    summary: "Mom follow-up appointment", location: "Foothills Medical Centre, 1403 29 St NW, Calgary, AB",
    organizer: DEMO_EMAIL, attendees: [DEMO_EMAIL],
  },
];

/** today's date in Alberta Time (UTC-6 all year) as YYYY-MM-DD */
function albertaToday(now: Date): string {
  return new Date(now.getTime() + ALBERTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** the 6 demo events placed from tomorrow on, relative to the given real time */
export function seedCalendarEvents(now: Date = new Date()): CalendarEvent[] {
  const today = albertaToday(now);
  return SEED_EVENTS.map((event) => {
    const date = addDays(today, event.day);
    return {
      id: event.id,
      summary: event.summary,
      status: "confirmed",
      start: { dateTime: `${date}T${event.start}:00${ALBERTA_OFFSET}`, timeZone: "America/Edmonton" },
      end: { dateTime: `${date}T${event.end}:00${ALBERTA_OFFSET}`, timeZone: "America/Edmonton" },
      ...(event.location ? { location: event.location } : {}),
      organizer: { email: event.organizer },
      attendees: event.attendees.map((email) => ({ email, responseStatus: "accepted" })),
    };
  });
}

function validWindow(startsAt: Date, endsAt: Date): void {
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || startsAt >= endsAt) {
    throw new Error("Invalid calendar window");
  }
}

/** events overlapping [startsAt, endsAt); the clock is injectable for tests */
export function createSeedCalendar(realNow: () => Date = () => new Date()): CalendarSource {
  return {
    async listEvents(_userId: string, startsAt: Date, endsAt: Date): Promise<CalendarEvent[]> {
      validWindow(startsAt, endsAt);
      return seedCalendarEvents(realNow()).filter((event) => {
        const start = new Date(event.start?.dateTime ?? "").getTime();
        const end = new Date(event.end?.dateTime ?? "").getTime();
        return start < endsAt.getTime() && end > startsAt.getTime();
      });
    },
  };
}

/** Google Calendar for the signed-in owner; throws NotConfiguredError until the Google client and APP_ENC_KEY are set */
export function createGoogleCalendar(accounts: AccountStore, env: NodeJS.ProcessEnv = process.env): CalendarSource {
  return {
    async listEvents(userId: string, startsAt: Date, endsAt: Date): Promise<CalendarEvent[]> {
      const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_ENC_KEY } = env;
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !APP_ENC_KEY) throw new NotConfiguredError("google_calendar");
      const client = googleClient({
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        loadAccount: googleAccountLoader({ store: accounts, encryptionKey: APP_ENC_KEY }),
      });
      return client.listEvents({ userId, startsAt, endsAt });
    },
  };
}

export function createCalendarSource(mode: CalendarMode, deps: { accounts: AccountStore }): CalendarSource {
  return mode === "google" ? createGoogleCalendar(deps.accounts) : createSeedCalendar();
}
