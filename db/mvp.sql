-- local MVP additions on top of db/schema.sql (docs/MVP.md); every statement is idempotent and runs on each boot
-- demo mail adapter (RR_MAIL=outbox): messages are stored here instead of sent, and shown at /outbox
CREATE TABLE IF NOT EXISTS outbox_message (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  to_email text NOT NULL, subject text NOT NULL, body text NOT NULL, sent_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS outbox_message_user_sent ON outbox_message (user_id, sent_at DESC);

-- the care recipient's name for display ("Rosa"); alias stays the word the user says ("Mom")
ALTER TABLE care_recipient ADD COLUMN IF NOT EXISTS display_name text;
