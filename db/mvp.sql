-- local MVP additions on top of db/schema.sql (docs/MVP.md); every statement is idempotent and runs on each boot
-- demo mail adapter (RR_MAIL=outbox): messages are stored here instead of sent, and shown at /outbox
CREATE TABLE IF NOT EXISTS outbox_message (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  to_email text NOT NULL, subject text NOT NULL, body text NOT NULL, sent_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS outbox_message_user_sent ON outbox_message (user_id, sent_at DESC);

-- the care recipient's name for display ("Rosa"); alias stays the word the user says ("Mom")
ALTER TABLE care_recipient ADD COLUMN IF NOT EXISTS display_name text;

-- care contacts and completions
-- people the caregiver typed in for the Emergency / Help sheet (PRD 9); never seeded, removal only sets removed_at
CREATE TABLE IF NOT EXISTS care_contact (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid NOT NULL REFERENCES care_recipient ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  relationship text CHECK (char_length(relationship) <= 60),
  phone text NOT NULL CHECK (char_length(phone) BETWEEN 3 AND 40),
  kind text NOT NULL CHECK (kind IN ('emergency','trusted')),
  created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz);
CREATE INDEX IF NOT EXISTS care_contact_recipient ON care_contact (care_recipient_id, created_at);
-- a timeline occurrence the caregiver marked done: usage_signal kind 'completed', value YYYY-MM-DD, at most one each
CREATE UNIQUE INDEX IF NOT EXISTS usage_signal_completed_once ON usage_signal (care_event_id, value) WHERE kind = 'completed';
