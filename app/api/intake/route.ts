// POST /api/intake {statement}: A1 intake; a ready window becomes the owner's active care_episode (PRD U1)
import "server-only";
import { z } from "zod";
import { p } from "../../../lib/db.ts";
import { INTAKE_LIMITS, runIntake } from "../../../lib/ai/intake.ts";
import { albertaDate, loadRecipient, reserveModel } from "../_lib/context.ts";
import { handle, json, parseInput, readJson, writeContext } from "../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.strictObject({
  statement: z.string().trim().min(1).max(INTAKE_LIMITS.statementChars),
});

const CLOSE_ACTIVE = `UPDATE care_episode SET status = 'closed'
  WHERE user_id = CAST(:user_id AS uuid) AND status = 'active'`;

const INSERT_EPISODE = `INSERT INTO care_episode (user_id, care_recipient_id, starts_on, ends_on, reason_text, status)
  VALUES (CAST(:user_id AS uuid), CAST(:recipient_id AS uuid), CAST(:starts_on AS date), CAST(:ends_on AS date),
    :reason_text, 'active')
  RETURNING id::text AS id`;

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const { statement } = parseInput(schema, await readJson(request));
    const database = rt.stores.database;
    const today = albertaDate(await rt.stores.appNow(user.id));
    const deps = await reserveModel(rt, user.id, "intake");
    const result = await runIntake({ statement, today }, deps);
    if (result.status !== "ready") return json({ result, episodeId: null });

    const recipient = await loadRecipient(database, user.id);
    const episodeId = await database.transaction(async (tx) => {
      // one active episode per owner: the newest statement replaces the previous window
      await tx.execute(CLOSE_ACTIVE, [p.uuid("user_id", user.id)]);
      const rows = await tx.query<{ id: string }>(INSERT_EPISODE, [
        p.uuid("user_id", user.id),
        p.uuid("recipient_id", recipient.id),
        p.text("starts_on", result.startDate),
        p.text("ends_on", result.endDate),
        p.text("reason_text", result.reasonText),
      ]);
      return rows[0].id;
    });
    return json({ result, episodeId });
  });
}
