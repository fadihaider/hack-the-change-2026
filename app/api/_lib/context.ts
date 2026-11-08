// owner-scoped lookups and the model quota wrapper shared by the mvp routes
import "server-only";
import { p, type SqlRunner } from "../../../lib/db.ts";
import { DEFAULT_MODEL, type StepDeps, type StepName } from "../../../lib/ai/model.ts";
import { ALBERTA_OFFSET } from "../../../lib/ai/time.ts";
import { paidProvidersAllowed } from "../../../lib/mvp/auth.ts";
import type { Runtime } from "../../../lib/mvp/runtime.ts";
import { recordTokens, reserveCall } from "../../../lib/rateLimit.ts";
import { ApiError, RateLimitedError, requireUuid } from "./http.ts";

const ALBERTA_OFFSET_MS = 6 * 60 * 60 * 1000;

/** YYYY-MM-DD in Alberta Time (UTC-6 all year, PRD section 14) */
export function albertaDate(at: Date): string {
  return new Date(at.getTime() - ALBERTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** midnight at the start of an Alberta calendar day */
export function albertaMidnight(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00${ALBERTA_OFFSET}`);
}

/**
 * counts one model call against the owner's quota before the call (lib/rateLimit.ts), and records its tokens after.
 * throws RateLimitedError (HTTP 429) when the quota says no.
 */
export async function reserveModel(rt: Runtime, userId: string, step: StepName): Promise<StepDeps> {
  const database = rt.stores.database;
  // the offline demo provider costs nothing; real providers need a verified owner unless running on localhost
  if (rt.mode.ai !== "demo" && !paidProvidersAllowed(rt.auth.mode, rt.baseUrl)) {
    throw new ApiError(403, "verified_owner_required");
  }
  const reservation = await reserveCall(database, { userId, step, model: rt.ai.model ?? DEFAULT_MODEL });
  if (!reservation.allowed) throw new RateLimitedError(reservation.limit);
  const callId = reservation.callId;
  return {
    ...rt.ai,
    onUsage: async (usage) => {
      if (!callId) return;
      try {
        await recordTokens(database, { callId, userId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      } catch {
        // spend tracking must never fail the caregiver's request
      }
    },
  };
}

export interface Recipient {
  id: string;
  alias: string;
  displayName: string | null;
  address: string | null;
  community: string | null;
  lat: number | null;
  lng: number | null;
}

interface RecipientRow {
  id: string;
  alias: string;
  display_name: string | null;
  address: string | null;
  community: string | null;
  lat: number | null;
  lng: number | null;
}

const RECIPIENT = `SELECT id::text AS id, alias, display_name, address, community,
    ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
  FROM care_recipient WHERE owner_id = CAST(:user_id AS uuid)
  ORDER BY alias, id LIMIT 1`;

/** the owner's care recipient (one per user in the mvp) */
export async function loadRecipient(sql: SqlRunner, userId: string): Promise<Recipient> {
  const rows = await sql.query<RecipientRow>(RECIPIENT, [p.uuid("user_id", userId)]);
  const row = rows[0];
  if (!row) throw new ApiError(404, "care_recipient_not_found");
  return {
    id: row.id,
    alias: row.alias,
    displayName: row.display_name,
    address: row.address,
    community: row.community,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
  };
}

export function recipientAliases(recipient: Pick<Recipient, "alias" | "displayName">): string[] {
  return [recipient.alias, recipient.displayName].filter((alias): alias is string => Boolean(alias && alias.trim()));
}

export interface Episode {
  id: string;
  careRecipientId: string;
  startsOn: string;
  endsOn: string;
  reasonText: string | null;
  status: string;
}

interface EpisodeRow {
  id: string;
  care_recipient_id: string;
  starts_on: string;
  ends_on: string;
  reason_text: string | null;
  status: string;
}

const EPISODE_COLUMNS = `id::text AS id, care_recipient_id::text AS care_recipient_id, starts_on::text AS starts_on,
  ends_on::text AS ends_on, reason_text, status`;

function toEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    careRecipientId: row.care_recipient_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    reasonText: row.reason_text,
    status: row.status,
  };
}

export async function loadEpisode(sql: SqlRunner, userId: string, episodeId: string): Promise<Episode> {
  const rows = await sql.query<EpisodeRow>(
    `SELECT ${EPISODE_COLUMNS} FROM care_episode WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user_id AS uuid)`,
    [p.uuid("id", requireUuid(episodeId)), p.uuid("user_id", userId)],
  );
  if (!rows[0]) throw new ApiError(404, "not_found");
  return toEpisode(rows[0]);
}

/** intake closes the previous active episode, so there is at most one */
export async function loadActiveEpisode(sql: SqlRunner, userId: string): Promise<Episode | null> {
  const rows = await sql.query<EpisodeRow>(
    `SELECT ${EPISODE_COLUMNS} FROM care_episode WHERE user_id = CAST(:user_id AS uuid) AND status = 'active'
      ORDER BY starts_on DESC, id LIMIT 1`,
    [p.uuid("user_id", userId)],
  );
  return rows[0] ? toEpisode(rows[0]) : null;
}

const RELATIONSHIPS: Record<string, string> = {
  mom: "my mother", mum: "my mother", mother: "my mother", mama: "my mother", ma: "my mother",
  dad: "my father", father: "my father", papa: "my father", pa: "my father",
  grandma: "my grandmother", grandmother: "my grandmother", nana: "my grandmother", oma: "my grandmother",
  grandpa: "my grandfather", grandfather: "my grandfather", opa: "my grandfather",
  wife: "my wife", husband: "my husband", partner: "my partner", son: "my son", daughter: "my daughter",
  sister: "my sister", brother: "my brother", aunt: "my aunt", uncle: "my uncle",
};

/** the care recipient's relationship to the user ("my mother"), for the A3 general and detailed tiers */
export function relationshipFor(alias: string | null): string | null {
  if (!alias) return null;
  const key = alias.trim().toLowerCase().replace(/^my\s+/, "");
  return RELATIONSHIPS[key] ?? null;
}
