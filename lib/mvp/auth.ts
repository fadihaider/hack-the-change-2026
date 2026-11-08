// auth adapters (docs/MVP.md RR_AUTH): demo signs every request in as the fictional Alex
import "server-only";
import { p, type SqlRunner } from "../db.ts";
import { DEMO_EMAIL } from "./seed.ts";

export type AuthMode = "demo" | "google";

export interface SessionUser {
  id: string;
  email: string;
}

export interface AuthAdapter {
  readonly mode: AuthMode;
  /** the verified owner id for this request, or null when nobody is signed in */
  currentUserId(request: Request): Promise<string | null>;
  currentUser(request: Request): Promise<SessionUser | null>;
}

/** every request is the seeded demo user; the id is looked up once and cached */
export function createDemoAuth(sql: SqlRunner): AuthAdapter {
  let cached: SessionUser | null = null;
  async function currentUser(): Promise<SessionUser | null> {
    if (!cached) {
      const rows = await sql.query<{ id: string }>("SELECT id::text AS id FROM app_user WHERE email = :email", [
        p.text("email", DEMO_EMAIL),
      ]);
      cached = rows[0] ? { id: rows[0].id, email: DEMO_EMAIL } : null;
    }
    return cached;
  }
  return {
    mode: "demo",
    currentUser,
    async currentUserId(): Promise<string | null> {
      return (await currentUser())?.id ?? null;
    },
  };
}

/** TODO(integration): resolve the NextAuth v4 session (getServerSession) once the root auth config lands */
export function createGoogleAuth(): AuthAdapter {
  return {
    mode: "google",
    async currentUserId(): Promise<string | null> {
      return null;
    },
    async currentUser(): Promise<SessionUser | null> {
      return null;
    },
  };
}

export function createAuthAdapter(mode: AuthMode, deps: { sql: SqlRunner }): AuthAdapter {
  return mode === "google" ? createGoogleAuth() : createDemoAuth(deps.sql);
}

/**
 * paid providers (model calls, ElevenLabs) accept the demo identity only on a local base URL; any deployed origin
 * needs a verified owner (mode "google"). Agreed with the speech routes on the board.
 */
export function paidProvidersAllowed(mode: AuthMode, baseUrl: string): boolean {
  if (mode === "google") return true;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
