-- Supabase only, applied before db/schema.sql on a fresh database (lib/supabase/database.ts).
-- Supabase keeps extensions in the "extensions" schema, never "public" (supabase.com/docs/guides/database/extensions/postgis);
-- "extensions" is on the default search_path, so db/schema.sql's unqualified geography, vector and gen_random_uuid
-- still resolve, and its own CREATE EXTENSION IF NOT EXISTS lines then do nothing
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
