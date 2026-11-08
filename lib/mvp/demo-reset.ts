// clears one demo run so the next demo starts clean (Demo menu, "Reset the demo")
import "server-only";
import { p, type SqlRunner } from "../db.ts";
import { resetClock } from "../store/clock.ts";

// every child row of these cascades (request events, response tokens, usage signals)
const BY_USER = ["outbox_message", "sms_outbox", "request", "commitment", "care_episode"] as const;
const BY_RECIPIENT = ["open_question", "care_event", "care_fact", "care_source", "care_contact", "handoff_grant"] as const;

/**
 * deletes the user's care weeks, commitments, requests, outbox and texts, and everything recorded about their care
 * recipients, then puts the demo clock back to real time. the user, contact groups, contacts and care recipient stay,
 * because running servers cache the demo user's id.
 */
export async function clearDemoRun(sql: SqlRunner, userId: string): Promise<void> {
  const user = [p.uuid("user_id", userId)];
  for (const table of BY_USER) {
    await sql.execute(`DELETE FROM ${table} WHERE user_id = CAST(:user_id AS uuid)`, user);
  }
  for (const table of BY_RECIPIENT) {
    await sql.execute(
      `DELETE FROM ${table} WHERE care_recipient_id IN
        (SELECT id FROM care_recipient WHERE owner_id = CAST(:user_id AS uuid))`,
      user,
    );
  }
  await resetClock(sql);
  await sql.execute(
    `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
      VALUES (:actor, 'demo_reset', 'app_user', :actor, '{}'::jsonb)`,
    [p.text("actor", userId)],
  );
}
