// The database the test suites and dev scripts connect to: SUPABASE_DB_URL
// from the environment, or from supabase/.env.local (gitignored).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
