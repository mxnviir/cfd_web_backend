// Runs the SQL suites in this folder against SUPABASE_DB_URL.
//
//   node supabase/tests/run.mjs            every *.sql here
//   node supabase/tests/run.mjs money      just money.sql
//
// The URL comes from the environment or from supabase/.env.local (gitignored).
// Each suite is one transaction that rolls back, so a run leaves no trace.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { dbUrl } from "./db.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const only = process.argv[2];
const suites = readdirSync(here).filter((f) => f.endsWith(".sql") && (!only || f === `${only}.sql`));

const sql = postgres(dbUrl(), { max: 1, onnotice: () => {}, prepare: false });
let failed = false;
for (const file of suites) {
  try {
    const out = await sql.unsafe(readFileSync(join(here, file), "utf8")).simple();
    const last = out.flat().filter((r) => r && r.result).pop();
    console.log(`${file}: ${last?.result ?? "ran"}`);
  } catch (err) {
    failed = true;
    console.log(`${file}: ${err.message}`);
  }
}
await sql.end();
process.exit(failed ? 1 : 0);
