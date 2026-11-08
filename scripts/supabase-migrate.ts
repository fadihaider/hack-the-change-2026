// creates or updates the ReliefReady schema on Supabase and reports what is there; the app runs the same migration on
// its first database call, so this is for setting up a project ahead of time and checking it.
// usage: npm run db:migrate              (fresh database: extensions, db/schema.sql, db/mvp.sql, lock-down, demo seed)
//        npm run db:migrate -- --no-seed (same, without the fictional demo persona and Calgary resources)
import { createSupabaseDatabase, migrateSupabase, supabaseConfigFromEnv } from "../lib/supabase/database.ts";
import { DatabaseError } from "../lib/db.ts";

const database = createSupabaseDatabase(supabaseConfigFromEnv());
try {
  const { fresh } = await migrateSupabase(database, { seed: !process.argv.includes("--no-seed") });
  console.log(fresh ? "created the schema on a fresh database" : "schema already present; db/mvp.sql and access lock-down re-applied");

  const extensions = await database.query<{ name: string; version: string; schema: string }>(
    `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema FROM pg_extension e
     JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname IN ('postgis', 'vector', 'pgcrypto') ORDER BY 1`);
  for (const e of extensions) console.log(`extension ${e.name} ${e.version} in ${e.schema}`);

  const tables = await database.query<{ name: string; rls: boolean; api_access: boolean }>(
    `SELECT c.relname AS name, c.relrowsecurity AS rls,
       EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
               AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE')) AS api_access
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') ORDER BY 1`);
  const exposed = tables.filter((t) => t.api_access);
  const noRls = tables.filter((t) => !t.rls && t.name !== "sim_now");
  console.log(`${tables.length} tables and views in public; row level security off on ${noRls.length}; reachable by anon/authenticated: ${exposed.length}`);
  if (exposed.length > 0 || noRls.length > 0) process.exitCode = 1;

  const counts = await database.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM app_user)::int AS app_user, (SELECT count(*) FROM care_recipient)::int AS care_recipient,
       (SELECT count(*) FROM care_fact WHERE status = 'approved')::int AS approved_facts,
       (SELECT count(*) FROM request)::int AS requests, (SELECT count(*) FROM resource)::int AS resources,
       (SELECT count(*) FROM community)::int AS communities`);
  console.log("rows:", JSON.stringify(counts[0]));
} catch (error) {
  console.error(`migration failed: ${error instanceof DatabaseError ? error.code : (error as Error).message}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
