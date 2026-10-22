// Runs the SQL suites in this folder against SUPABASE_DB_URL.
//
//   node supabase/tests/run.mjs            every *.sql here
//   node supabase/tests/run.mjs money      just money.sql
//
// The URL comes from the environment or from supabase/.env.local (gitignored).
// Each suite is one transaction that rolls back, so a run leaves no trace.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

export function dbUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const file = join(here, "..", ".env.local");
  if (existsSync(file)) {
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_DB_URL="));
    if (line) return line.slice("SUPABASE_DB_URL=".length).trim();
  }
  throw new Error("Set SUPABASE_DB_URL, or put it in supabase/.env.local.");
}

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
