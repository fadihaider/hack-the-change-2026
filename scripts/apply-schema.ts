// applies db/schema.sql through the RDS Data API, one statement per call
// usage: AWS_PROFILE=hold-my-coffee DB_CLUSTER_ARN=... DB_SECRET_ARN=... node --conditions=react-server --import tsx scripts/apply-schema.ts [--dry-run]
import { readFileSync } from "node:fs";
import { configFromEnv, createDatabase, DatabaseError } from "../lib/db.ts";

/** splits on semicolons that end a line; the schema has no function bodies or quoted semicolons */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const statements = splitStatements(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
if (process.argv.includes("--dry-run")) {
  for (const statement of statements) console.log(statement.split("\n")[0].slice(0, 90));
  console.log(`${statements.length} statements`);
} else {
  const db = createDatabase(configFromEnv());
  let applied = 0;
  for (const statement of statements) {
    const label = statement.split("\n")[0].slice(0, 70);
    try {
      await db.execute(statement);
      applied += 1;
      console.log(`ok   ${label}`);
    } catch (error) {
      console.log(`FAIL ${label} (${error instanceof DatabaseError ? error.code : "unknown"})`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`${applied}/${statements.length} statements applied`);
}
