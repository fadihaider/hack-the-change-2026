-- ReliefReady schema for Aurora PostgreSQL 17 (IMPLEMENTATION section 4); apply with scripts/apply-schema.ts
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- people and setup
CREATE TABLE app_user (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Edmonton', -- 'Etc/GMT+6' if the section 0 row 9 check fails anywhere
  google_refresh_token_enc bytea, -- iv || authTag || ciphertext, AES-GCM with the owner id as AAD (section 8)
  created_at timestamptz DEFAULT now());
CREATE TABLE contact_group (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_user ON DELETE CASCADE,
  name text NOT NULL, disclosure_tier text NOT NULL CHECK (disclosure_tier IN ('minimal','general','detailed')),
  channel text NOT NULL DEFAULT 'email');
CREATE TABLE contact (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES contact_group ON DELETE CASCADE,
  name text NOT NULL, email text NOT NULL, relationship text);

-- crisis and life continuity
CREATE TABLE care_recipient (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES app_user ON DELETE CASCADE, alias text NOT NULL, address text,
  geog geography(Point,4326), community text, is_fictional boolean NOT NULL DEFAULT true);
CREATE TABLE care_episode (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_user ON DELETE CASCADE,
  care_recipient_id uuid REFERENCES care_recipient ON DELETE CASCADE,
  starts_on date NOT NULL, ends_on date NOT NULL,
  reason_text text, -- the user's words from intake; sent to A3 only for the detailed tier
  status text NOT NULL CHECK (status IN ('anticipated','active','stabilizing','closed')));
CREATE TABLE commitment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  episode_id uuid REFERENCES care_episode ON DELETE CASCADE,
  source text NOT NULL, -- 'calendar', 'manual' or 'response' (a recipient proposed another time)
  source_id text, title text, starts_at timestamptz, ends_at timestamptz, location text,
  organizer_email text, attendees jsonb, conflict_reason text,
  decision text CHECK (decision IN ('notify','reschedule','extension','coverage','defer','keep')));
CREATE TABLE dependency (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_commitment uuid REFERENCES commitment ON DELETE CASCADE,
  to_kind text, to_ref text, evidence text NOT NULL, origin text NOT NULL CHECK (origin IN ('rule','model','user')),
  confirmed boolean NOT NULL DEFAULT false);
CREATE TABLE request (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  commitment_id uuid REFERENCES commitment ON DELETE CASCADE,
  contact_id uuid REFERENCES contact ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('notify','reschedule','extension','coverage')),
  draft_subject text, draft_body text,
  disclosure_tier text NOT NULL CHECK (disclosure_tier IN ('minimal','general','detailed')),
  health_terms_found text[] DEFAULT '{}', health_override boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','awaiting_approval','approved','sending','requested',
    'accepted','completed','cancelled','failed','rejected','expired','needs_review')),
  respond_by timestamptz, proposed_at timestamptz,
  proposed_note text CHECK (char_length(proposed_note) <= 300),
  updated_at timestamptz DEFAULT now());
CREATE TABLE request_event (id bigserial PRIMARY KEY, request_id uuid REFERENCES request ON DELETE CASCADE,
  from_state text CHECK (from_state IN ('draft','awaiting_approval','approved','sending','requested',
    'accepted','completed','cancelled','failed','rejected','expired','needs_review')),
  to_state text NOT NULL CHECK (to_state IN ('draft','awaiting_approval','approved','sending','requested',
    'accepted','completed','cancelled','failed','rejected','expired','needs_review')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('approval','gmail_message_id','link_click','user_manual','scheduler','error')),
  evidence_ref text, actor text NOT NULL, at timestamptz DEFAULT now());
CREATE TABLE response_token (token_hash text PRIMARY KEY, request_id uuid REFERENCES request ON DELETE CASCADE,
  choice text NOT NULL CHECK (choice IN ('accept','decline','propose')),
  expires_at timestamptz NOT NULL, used_at timestamptz);

-- care continuity
CREATE TABLE care_source (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid REFERENCES care_recipient ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('voice','document','note','usage')), s3_key text, full_text text NOT NULL,
  author text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE care_fact (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid REFERENCES care_recipient ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('routine','preference','communication','mobility','contacts','logistics',
    'medical_instruction')),
  text_exact text NOT NULL, source_id uuid REFERENCES care_source ON DELETE CASCADE,
  span_start int, span_end int,
  status text NOT NULL CHECK (status IN ('suggested','approved','superseded','conflicting','rejected')),
  version int NOT NULL DEFAULT 1, supersedes uuid REFERENCES care_fact ON DELETE SET NULL,
  embedding vector(1024), -- P1: embed on approval once profiles exceed 200 facts
  created_at timestamptz DEFAULT now());
CREATE TABLE care_event (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid REFERENCES care_recipient ON DELETE CASCADE,
  fact_id uuid REFERENCES care_fact ON DELETE CASCADE, title text NOT NULL, starts_at timestamptz, rrule text,
  remind_minutes int DEFAULT 15, location_text text,
  location_resource_id uuid, -- foreign key added after the resource table
  status text NOT NULL DEFAULT 'suggested');
CREATE TABLE usage_signal (id bigserial PRIMARY KEY, care_event_id uuid REFERENCES care_event ON DELETE CASCADE,
  kind text, value text, at timestamptz DEFAULT now());
CREATE TABLE open_question (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid REFERENCES care_recipient ON DELETE CASCADE,
  asked_by text, question text NOT NULL, answer_fact_id uuid REFERENCES care_fact ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open');
CREATE TABLE handoff_grant (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid REFERENCES care_recipient ON DELETE CASCADE,
  substitute_email text NOT NULL, categories text[] NOT NULL, care_event_ids uuid[] NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, revoked_at timestamptz, token_hash text UNIQUE NOT NULL);
-- people the caregiver typed in for the Emergency / Help sheet; never seeded, removal only sets removed_at
CREATE TABLE care_contact (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_recipient_id uuid NOT NULL REFERENCES care_recipient ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  relationship text CHECK (char_length(relationship) <= 60),
  phone text NOT NULL CHECK (char_length(phone) BETWEEN 3 AND 40),
  kind text NOT NULL CHECK (kind IN ('emergency','trusted')),
  created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz);
CREATE INDEX care_contact_recipient ON care_contact (care_recipient_id, created_at);
-- a timeline occurrence the caregiver marked done: usage_signal kind 'completed', value YYYY-MM-DD, at most one each
CREATE UNIQUE INDEX usage_signal_completed_once ON usage_signal (care_event_id, value) WHERE kind = 'completed';

-- calgary knowledge
CREATE TABLE resource (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, name text NOT NULL,
  address text, geog geography(Point,4326), phone text, opening_hours text, wheelchair text,
  description text, source text NOT NULL, source_url text NOT NULL, license text, fetched_at date NOT NULL,
  embedding vector(1024));
CREATE INDEX ON resource USING gist (geog);
CREATE INDEX ON resource USING hnsw (embedding vector_cosine_ops);
ALTER TABLE care_event ADD FOREIGN KEY (location_resource_id) REFERENCES resource ON DELETE SET NULL;
CREATE TABLE community (name text PRIMARY KEY, comm_code text UNIQUE, sector text, geom geography(MultiPolygon,4326));
CREATE INDEX ON community USING gist (geom);
-- optional, Equity Index map only (PRD D5)
CREATE TABLE census_tract (ctuid text PRIMARY KEY, geom geography(MultiPolygon,4326), cei jsonb);
CREATE TABLE rule_card (id text PRIMARY KEY, title text, body text, conditions jsonb, source_url text, fetched_at date);
CREATE TABLE geocode_cache (address_norm text PRIMARY KEY, geog geography(Point,4326), source text);

-- audit and demo
CREATE TABLE audit_event (id bigserial PRIMARY KEY, actor text, action text, entity text, entity_id text, detail jsonb, at timestamptz DEFAULT now());
CREATE TABLE sim_clock (id int PRIMARY KEY DEFAULT 1 CHECK (id = 1), offset_interval interval NOT NULL DEFAULT '0');
INSERT INTO sim_clock (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE VIEW sim_now AS SELECT now() + offset_interval AS ts FROM sim_clock WHERE id = 1;
CREATE TABLE llm_call (id bigserial PRIMARY KEY, user_id uuid, -- no foreign key, so spend history survives a persona reset
  step text, model text, input_tokens int, output_tokens int, at timestamptz DEFAULT now());

-- rate limits (IMPLEMENTATION section 12): one row per key and fixed window, incremented atomically
CREATE TABLE rate_limit (key text NOT NULL, window_start timestamptz NOT NULL, count int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start));
