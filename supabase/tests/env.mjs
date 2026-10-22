// The linked project's URL and API keys, for the HTTP-level tests.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY from the
// environment if set; otherwise read from the Supabase CLI for the linked
// project (`supabase link`). The keys are held in memory, never printed.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function projectEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      url: process.env.SUPABASE_URL,
      anon: process.env.SUPABASE_ANON_KEY,
      service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
  }
  const refFile = join(here, "..", ".temp", "project-ref");
  if (!existsSync(refFile)) throw new Error("Link a project first: supabase link --project-ref <ref>");
  const ref = readFileSync(refFile, "utf8").trim();
  const out = execFileSync("supabase", ["projects", "api-keys", "--project-ref", ref, "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const keys = JSON.parse(out);
  const pick = (name) => keys.find((k) => k.name === name)?.api_key;
  return { url: `https://${ref}.supabase.co`, anon: pick("anon"), service: pick("service_role") };
}
