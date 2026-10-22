// Deploy wrapper: sync the project's env into turboflow/functions/ first, so
// `firebase deploy` finds functions/.env.<project> without the env sources
// living anywhere but env/. Everything in env/ stays the only place to edit.
//
//   node scripts/deploy.mjs --project turboflow-7b3ca [--only functions,hosting] [...]
//   (equivalently: npm run deploy -- --project prod --only functions)
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const turbo = join(root, "turboflow");

const args = process.argv.slice(2);
const i = args.findIndex((a) => a === "--project" || a.startsWith("--project="));
if (i < 0) {
  console.error("usage: node scripts/deploy.mjs --project <id> [firebase deploy args...]");
  process.exit(2);
}
const project = args[i].startsWith("--project=")
  ? args[i].split("=").slice(1).join("=")
  : args[i + 1];
const rest = args.filter((_, idx) => idx !== i && !(idx === i + 1 && !args[i].startsWith("--project=")));

const sync = spawnSync(process.execPath, [join(turbo, "scripts", "sync-env.mjs"), project],
  { stdio: "inherit", cwd: turbo });
if (sync.status !== 0) process.exit(sync.status ?? 1);

// shell: true so the firebase CLI resolves on Windows (firebase.cmd)
const res = spawnSync("firebase", ["deploy", ...rest],
  { stdio: "inherit", cwd: turbo, shell: process.platform === "win32" });
process.exit(res.status ?? 1);
