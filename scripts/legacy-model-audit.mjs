// References to the data model that was taken out.
//
// The Workbench used to have projects and folders. It has groups now: one
// group, as many simulations in it as you like, no folders. The rename went
// through the callables, the rules, the collections and most of the client in
// one go, and two places quietly kept the old word:
//
//   - GeometryUpload took a `projectId` prop and sent `project_id`. App had
//     been passing `groupId` since the migration, so the prop was undefined
//     and the server, whose schema takes group_id as optional, wrote null.
//     Every car imported through the Workbench after that belonged to no
//     group. The file uploaded, the geometry service read it, the document
//     went to "ready" - and the Workbench never listed it, because it lists by
//     group. Nothing failed. The car simply was not there.
//
//   - TopBar took a `project` prop where App passes `group`, so every group in
//     the Workbench was called "Untitled project".
//
// Neither threw, neither logged, and no test covered either. What they have in
// common is a word, so that is what this looks for.
//
// Run: node scripts/legacy-model-audit.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "dist-prod", "archive", ".git", ".firebase", "lib", "docs"]);

/** The retired vocabulary. */
const RETIRED = /\b(project_id|projectId|projectID|folder_id|folderId|COL\.projects|COL\.folders)\b/g;

/**
 * Uses of the word "project" that mean something else entirely, each with the
 * reason it is not the retired model.
 */
const FINE = [
  [/window\.FIREBASE_CONFIG(\?\.|\.)projectId/, "the Google Cloud project, in the Firebase client config"],
  [/FIREBASE_CONFIG\.projectId/, "as above"],
  [/\bprojectId\(\)/, "lib/config's helper for the Google Cloud project id"],
  [/projectId,?\s*\}\s*from\s*"\.\.?\/lib\/config"/, "importing that helper"],
  [/import \{[^}]*projectId[^}]*\} from "\.\.\/lib\/config"/, "importing that helper"],
  [/SIMSCALE|simscale/i, "SimScale's own project ids, which are a different system"],
  [/projectId:\s*"turboflow/, "the Firebase config literal"],
  [/projectId:\s*(PROJECT|"demo-)/, "the Firebase config key, in emulator setup"],
  [/\bcfg(\?\.|\.)projectId\b/, "the Google Cloud project, read from public/firebase-config.js to build the Fusion add-in"],
  [/does not define projectId/, "the error that names that config key"],
  [/\bc\.projectId\b/, "production's web app config (the Google Cloud project), read from the backup to build the production site"],
  [/initializeApp\(\{ projectId: project \}\)/, "firebase-admin's option for the Google Cloud project, in the production migration script"],
];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(jsx?|tsx?|mjs|rules)$/.test(name)) files.push(full);
  }
})(ROOT);

/** Comments explain history; a note about what the code used to be is not the code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, " "));
}

const hits = [];
for (const file of files) {
  const rel = file.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, "");
  if (rel.startsWith("scripts/legacy-model-audit")) continue;
  const text = stripComments(readFileSync(file, "utf8"));
  for (const m of text.matchAll(RETIRED)) {
    const lineNo = text.slice(0, m.index).split("\n").length;
    const line = text.split("\n")[lineNo - 1];
    if (FINE.some(([re]) => re.test(line))) continue;
    hits.push({ rel, lineNo, line: line.trim().slice(0, 100), word: m[0] });
  }
}

if (hits.length) {
  console.log(`\nFAIL  ${hits.length} reference(s) to the retired project/folder model\n`);
  for (const h of hits) {
    console.log(`   - ${h.rel}:${h.lineNo}  ${h.word}`);
    console.log(`       ${h.line}`);
  }
  console.log("\n   The model is groups. If a use really means the Google Cloud project");
  console.log("   or a SimScale project, add it to FINE in this file with the reason.");
  process.exit(1);
}

console.log(`legacy model audit: ${files.length} files, no references to projects or folders`);
