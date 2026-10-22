// Prepares a development project for the pipeline:
//   - the SimScale mock's state table (mock_simscale.sql)
//   - the vault's `functions_url`, which pg_cron's POLL tick and the
//     simulations trigger call
//
//   node supabase/dev/apply.mjs https://<ref>.supabase.co
//
// Production needs only the second, with its own URL; see docs/CUTOVER.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { dbUrl } from "../tests/db.mjs";

const projectUrl = process.argv[2];
if (!/^https?:\/\/[^/]+$/.test(projectUrl ?? "")) {
  console.error("usage: node supabase/dev/apply.mjs https://<ref>.supabase.co");
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const sql = postgres(dbUrl(), { max: 1, onnotice: () => {} });
await sql.unsafe(readFileSync(join(here, "mock_simscale.sql"), "utf8")).simple();
const url = `${projectUrl}/functions/v1`;
const [existing] = await sql`select id from vault.secrets where name = 'functions_url'`;
if (existing) await sql`select vault.update_secret(${existing.id}, ${url})`;
else await sql`select vault.create_secret(${url}, 'functions_url', 'Where pg_cron reaches the TurboFlow functions')`;
console.log(`mock schema ready; functions_url = ${url}`);
await sql.end();
