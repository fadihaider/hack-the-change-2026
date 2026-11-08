// copies every row of the local PGlite database (.data/pglite or RR_PGLITE_DIR) into Supabase, replacing what is
// there. tables go parent-first by foreign key; geography, vector, bytea and array values travel as their Postgres
// text forms through json and are parsed back by json_populate_recordset, so PostGIS points and embeddings survive.
// stop any dev server using the same PGlite folder first. usage: npm run db:copy-local -- --yes
import { createPgliteDatabase, pgliteDataDir } from "../lib/mvp/database.ts";
import { DatabaseError, p, type SqlRunner } from "../lib/db.ts";
import { createSupabaseDatabase, migrateSupabase, supabaseConfigFromEnv } from "../lib/supabase/database.ts";

const CHUNK = 1000;
// PGlite keeps PostGIS in public; Supabase keeps it in extensions, with its own copy of this table
const SKIP = new Set(["spatial_ref_sys"]);

if (!process.argv.includes("--yes")) {
  console.error("this replaces every ReliefReady row in Supabase with the local PGlite data; re-run with --yes");
  process.exit(1);
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function publicTables(db: SqlRunner): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`);
  return rows.map((row) => row.name).filter((name) => !SKIP.has(name));
}

/** parent tables before the tables that reference them; self references (care_fact.supersedes) are ignored here */
async function parentFirst(db: SqlRunner, tables: string[]): Promise<string[]> {
  const edges = await db.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, f.relname AS parent FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class f ON f.oid = k.confrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = 'public'`);
  const ordered: string[] = [];
  const placed = new Set<string>();
  const visit = (table: string, path: Set<string>) => {
    if (placed.has(table) || path.has(table)) return;
    path.add(table);
    for (const edge of edges) if (edge.child === table && edge.parent !== table) visit(edge.parent, path);
    placed.add(table);
    ordered.push(table);
  };
  for (const table of tables) visit(table, new Set());
  return ordered.filter((table) => tables.includes(table));
}

const source = await createPgliteDatabase(pgliteDataDir());
const target = createSupabaseDatabase(supabaseConfigFromEnv());
try {
  await migrateSupabase(target, { seed: false });
  const sourceTables = await publicTables(source);
  const targetTables = new Set(await publicTables(target));
  const missing = sourceTables.filter((table) => !targetTables.has(table));
  if (missing.length > 0) throw new Error(`tables missing on Supabase: ${missing.join(", ")}`);
  const order = await parentFirst(source, sourceTables);

  const copied = await target.transaction(async (tx) => {
    await tx.execute(`TRUNCATE ${[...targetTables].map((t) => `public.${quote(t)}`).join(", ")} RESTART IDENTITY CASCADE`);
    const counts: Record<string, number> = {};
    for (const table of order) {
      const columns = await source.query<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = :t`,
        [p.text("t", table)]);
      // older rows first, so a fact that supersedes another arrives after it
      const orderBy = columns.some((c) => c.name === "created_at") ? "created_at NULLS FIRST, ctid" : "ctid";
      counts[table] = 0;
      for (let offset = 0; ; offset += CHUNK) {
        const [chunk] = await source.query<{ rows: string | null }>(
          `SELECT json_agg(t)::text AS rows FROM (SELECT * FROM public.${quote(table)} ORDER BY ${orderBy}
           LIMIT ${CHUNK} OFFSET ${offset}) t`);
        if (!chunk?.rows) break;
        counts[table] += await tx.execute(
          `INSERT INTO public.${quote(table)} SELECT * FROM json_populate_recordset(NULL::public.${quote(table)}, CAST(:rows AS json))`,
          [p.text("rows", chunk.rows)]);
      }
    }
    // bigserial ids were copied as values, so each sequence moves past the largest one
    const serials = await tx.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`);
    for (const { table_name: table, column_name: column } of serials) {
      await tx.query(
        `SELECT setval(pg_get_serial_sequence(:qualified, :column), COALESCE(MAX(${quote(column)}), 1), MAX(${quote(column)}) IS NOT NULL)::text AS v
         FROM public.${quote(table)}`,
        [p.text("qualified", `public.${quote(table)}`), p.text("column", column)]);
    }
    return counts;
  });
  for (const [table, count] of Object.entries(copied)) console.log(`${String(count).padStart(6)}  ${table}`);
  console.log("copied local PGlite data into Supabase");
} catch (error) {
  console.error(`copy failed: ${error instanceof DatabaseError ? error.code : (error as Error).message}`);
  process.exitCode = 1;
} finally {
  await source.close();
  await target.close();
}
