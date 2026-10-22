// Copies the web config for an environment into public/supabase-config.js,
// which every page loads before the app. Run by `npm run dev` and `npm run
// build`; the sources live in supabase/env/ (see supabase/env/README.md).
//
//   node scripts/sync-env.mjs dev | prod
import { copyFileSync, existsSync } from "node:fs";

const name = process.argv[2] || "dev";
const source = `supabase/env/web.${name}.js`;
if (!existsSync(source)) {
  console.error(`${source} does not exist. Copy supabase/env/web.${name}.example.js to it and fill it in.`);
  process.exit(1);
}
copyFileSync(source, "public/supabase-config.js");
console.log(`public/supabase-config.js <- ${source}`);
