// demo clock and deadline expiry (PRD R3 and U6b, IMPLEMENTATION section 9)
import "server-only";
import { p, type Database, type SqlRunner } from "../db.ts";

export interface ClockReading {
  appNow: Date;
  realNow: Date;
  offsetMilliseconds: number;
}

const READ_CLOCK = `SELECT to_json(now())#>>'{}' AS real_now, to_json(n.ts)#>>'{}' AS app_now,
  (extract(epoch FROM c.offset_interval) * 1000)::float8 AS offset_ms
  FROM sim_now n CROSS JOIN sim_clock c WHERE c.id = 1`;

const JUMP = `UPDATE sim_clock SET offset_interval = offset_interval + make_interval(days => CAST(:days AS int)) WHERE id = 1`;

const AUDIT_JUMP = `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
  VALUES (:actor, 'clock_jump', 'sim_clock', '1', jsonb_build_object('days', CAST(:days AS int)))`;

const RESET = `UPDATE sim_clock SET offset_interval = '0' WHERE id = 1`;

// one statement per sweep, so each expiry and its evidence row commit together (section 9)
const SWEEP = `WITH x AS (UPDATE request SET state = 'expired', updated_at = now()
    WHERE state = 'requested' AND respond_by <= (SELECT ts FROM sim_now)
      AND (CAST(:user_id AS uuid) IS NULL OR user_id = CAST(:user_id AS uuid))
    RETURNING id),
  e AS (INSERT INTO request_event (request_id, from_state, to_state, evidence_kind, evidence_ref, actor)
    SELECT id, 'requested', 'expired', 'scheduler', 'respond_by passed', 'system' FROM x RETURNING request_id)
  SELECT request_id::text AS id FROM e`;

export const MAX_JUMP_DAYS = 30;

export async function readClock(sql: SqlRunner): Promise<ClockReading> {
  const rows = await sql.query<{ real_now: string; app_now: string; offset_ms: number }>(READ_CLOCK);
  const row = rows[0];
  if (!row) {
    throw new Error("sim_clock row missing; apply db/schema.sql");
  }
  return { appNow: new Date(row.app_now), realNow: new Date(row.real_now), offsetMilliseconds: Number(row.offset_ms) };
}

/** expires waiting requests past respond_by in app time; pass a user id to limit it to one owner (refresh endpoint) */
export async function sweepExpired(sql: SqlRunner, userId: string | null = null): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(SWEEP, [p.text("user_id", userId)]);
  return rows.map((row) => row.id);
}

/** admin-only demo control: moves app time forward, audits it, then runs the expiry sweep in the same transaction */
export async function jumpClock(
  db: Database,
  input: { days: number; adminUserId: string },
): Promise<ClockReading & { expiredRequestIds: string[] }> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_JUMP_DAYS) {
    throw new RangeError(`days must be an integer from 1 to ${MAX_JUMP_DAYS}`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(JUMP, [p.int("days", input.days)]);
    await tx.execute(AUDIT_JUMP, [p.text("actor", input.adminUserId), p.int("days", input.days)]);
    const expiredRequestIds = await sweepExpired(tx);
    return { ...(await readClock(tx)), expiredRequestIds };
  });
}

/** seed and test helper: back to real time */
export async function resetClock(sql: SqlRunner): Promise<void> {
  await sql.execute(RESET);
}
