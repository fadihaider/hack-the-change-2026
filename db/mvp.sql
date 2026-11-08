-- local MVP additions on top of db/schema.sql (docs/MVP.md); every statement is idempotent and runs on each boot
-- demo mail adapter (RR_MAIL=outbox): messages are stored here instead of sent, and shown at /outbox
CREATE TABLE IF NOT EXISTS outbox_message (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  to_email text NOT NULL, subject text NOT NULL, body text NOT NULL, sent_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS outbox_message_user_sent ON outbox_message (user_id, sent_at DESC);

-- the care recipient's name for display ("Rosa"); alias stays the word the user says ("Mom")
ALTER TABLE care_recipient ADD COLUMN IF NOT EXISTS display_name text;

-- urgent repairs (PRD section 12): begin
-- "Change the plan" reopens a step on the server, so a reload still shows it open; any new decision clears it
ALTER TABLE commitment ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
-- per-request words that also count as health terms (intake reason, approved medical_instruction facts), checked at
-- edit, approve and send; never sent to the browser
ALTER TABLE request ADD COLUMN IF NOT EXISTS extra_health_terms text[] NOT NULL DEFAULT '{}';
-- urgent repairs: end
