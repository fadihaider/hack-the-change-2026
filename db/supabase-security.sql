-- Supabase only, re-applied on every boot after db/mvp.sql (lib/supabase/database.ts); every statement is idempotent.
-- The app reads and writes only from the Next.js server, over SUPABASE_DB_URL as the postgres role. Nothing goes
-- through the Supabase Data API, so the API roles get no access at all: every grant is revoked here, and
-- lib/supabase/database.ts enables row level security (with no policies) on every table in public.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
-- views run as their owner by default, which would skip row level security on sim_clock
ALTER VIEW sim_now SET (security_invoker = true);
