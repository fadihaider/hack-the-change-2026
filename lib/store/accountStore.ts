// durable AccountStore for lib/auth/google.ts: Google sign-in users and their encrypted refresh tokens
import "server-only";
import { p, type SqlRunner } from "../db.ts";
import type { AccountStore } from "../auth/google.ts";
import { WorkflowError } from "../requests/workflow.ts";

// the no-op update makes RETURNING give the existing id, so a repeat login keeps the same app_user.id
const UPSERT_USER = `INSERT INTO app_user (email) VALUES (lower(:email))
  ON CONFLICT (email) DO UPDATE SET email = app_user.email
  RETURNING id::text AS id`;

// bytea leaves the Data API as base64 text so JSON records stay exact
const LOAD_TOKEN = `SELECT email, encode(google_refresh_token_enc, 'base64') AS ciphertext_b64
  FROM app_user WHERE id = CAST(:user_id AS uuid)`;

const SAVE_TOKEN = `UPDATE app_user SET google_refresh_token_enc = :ciphertext WHERE id = CAST(:user_id AS uuid)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAccountStore(sql: SqlRunner): AccountStore {
  return {
    async findOrCreateUserByEmail(verifiedEmail: string): Promise<{ id: string }> {
      const email = verifiedEmail.trim();
      if (email.length === 0 || email.length > 320) {
        throw new WorkflowError("not_found");
      }
      const rows = await sql.query<{ id: string }>(UPSERT_USER, [p.text("email", email)]);
      if (rows.length !== 1) {
        throw new WorkflowError("not_found");
      }
      return { id: rows[0].id };
    },

    async loadEncryptedRefreshToken(userId: string): Promise<{ email: string; ciphertext: Uint8Array | null }> {
      if (!UUID.test(userId)) {
        throw new WorkflowError("not_found");
      }
      const rows = await sql.query<{ email: string; ciphertext_b64: string | null }>(LOAD_TOKEN, [p.uuid("user_id", userId)]);
      if (rows.length !== 1) {
        throw new WorkflowError("not_found");
      }
      const { email, ciphertext_b64 } = rows[0];
      return { email, ciphertext: ciphertext_b64 === null ? null : new Uint8Array(Buffer.from(ciphertext_b64, "base64")) };
    },

    async saveEncryptedRefreshToken(userId: string, ciphertext: Uint8Array): Promise<void> {
      if (!UUID.test(userId) || ciphertext.length === 0) {
        throw new WorkflowError("not_found");
      }
      const changed = await sql.execute(SAVE_TOKEN, [p.bytes("ciphertext", ciphertext), p.uuid("user_id", userId)]);
      if (changed !== 1) {
        throw new WorkflowError("not_found");
      }
    },
  };
}
