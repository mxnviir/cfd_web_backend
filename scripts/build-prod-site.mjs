// Turn a finished build (dist/, made for turboflow-test) into the production
// site (dist-prod/, for turboflow-7b3ca at https://turboflow.cloud).
//
// Four things in a build are the test project's: public/firebase-config.js,
// the site address in every page's canonical and Open Graph tags (and the
// sitemap and robots.txt), and the Fusion add-in in downloads/, which is
// stamped with the project it talks to. Everything else is the same bytes.
//
// It also writes env/deploy/firebase.prod.json: the hosting config with
// dist-prod as the public folder and without the predeploy step, because
// firebase.json's predeploy runs `npm run build`, which would quietly replace
// this with a test build on the way out.
//
//   npm run build
//   node scripts/build-prod-site.mjs
//   node scripts/deploy.mjs --project turboflow-7b3ca --only hosting --config ../env/deploy/firebase.prod.json
//
// Production's web config is read from env/firebase/config.prod.js. Those
// values are public identifiers, the same ones the live site serves.
import { cpSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "..");
const PROD = "turboflow-7b3ca";
const ORIGIN = "https://turboflow.cloud";
const TEST_ORIGIN = "https://turboflow-test.web.app";
const src = join(root, "dist");
const out = join(root, "dist-prod");
if (!existsSync(join(src, "index.html"))) {
  console.error("usage: npm run build, then node scripts/build-prod-site.mjs");
  process.exit(2);
}

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// 1. copy, and move the site address
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
let moved = 0;
for (const f of walk(out)) {
  if (![".html", ".xml", ".txt", ".webmanifest", ".json"].includes(extname(f))) continue;
  const t = readFileSync(f, "utf8");
  if (t.includes(TEST_ORIGIN)) { writeFileSync(f, t.replaceAll(TEST_ORIGIN, ORIGIN)); moved++; }
}
console.log(`site address: ${moved} files moved to ${ORIGIN}`);

// 2. production's Firebase config, from env/firebase/config.prod.js
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(join(repoRoot, "env", "firebase", "config.prod.js"), "utf8"), sandbox);
const c = sandbox.window.FIREBASE_CONFIG;
if (!c?.projectId || !c?.apiKey) throw new Error("env/firebase/config.prod.js does not define a web config");
if (c.projectId !== PROD) throw new Error(`env/firebase/config.prod.js is for ${c.projectId}`);
writeFileSync(join(out, "firebase-config.js"), `// Which Firebase project this build talks to: production.
//
// Written by scripts/build-prod-site.mjs from env/firebase/config.prod.js.
// These values identify the project; they authorise nothing. What protects the
// data is firestore.rules and storage.rules.
window.FIREBASE_CONFIG = {
  apiKey: ${JSON.stringify(c.apiKey)},
  authDomain: ${JSON.stringify(c.authDomain)},
  projectId: ${JSON.stringify(c.projectId)},
  storageBucket: ${JSON.stringify(c.storageBucket)},
  messagingSenderId: ${JSON.stringify(c.messagingSenderId)},
  appId: ${JSON.stringify(c.appId)},
};
`);
console.log(`firebase-config.js: ${c.projectId}`);

// 3. the add-in, stamped for production
execFileSync(process.execPath, [join(root, "scripts", "build-addin.mjs")], {
  stdio: "inherit",
  env: { ...process.env, SITE_CONFIG: join(out, "firebase-config.js"), SITE_ORIGIN: ORIGIN,
    ADDIN_OUT: join(out, "downloads", "TurboFlow_CFD.zip") },
});

// 4. nothing of the test project may remain, including inside the zip
const zipText = (() => {
  const z = readFileSync(join(out, "downloads", "TurboFlow_CFD.zip"));
  const nameLen = z.readUInt16LE(26);
  const extraLen = z.readUInt16LE(28);
  const size = z.readUInt32LE(18);
  return inflateRawSync(z.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + size)).toString("utf8");
})();
const left = walk(out).filter((f) => extname(f) !== ".zip"
  && /\.(html|js|css|json|xml|txt|webmanifest|svg)$/.test(f)
  && readFileSync(f, "utf8").includes("turboflow-test"));
if (zipText.includes("turboflow-test")) left.push("downloads/TurboFlow_CFD.zip");
if (!zipText.includes(`FIREBASE_PROJECT = "${PROD}"`)) left.push("downloads/TurboFlow_CFD.zip (not stamped for production)");
if (left.length) {
  console.error(`test-project values left in: ${left.map((f) => f.replace(out, "dist-prod")).join(", ")}`);
  process.exit(1);
}
console.log("checked: no turboflow-test value anywhere in dist-prod, add-in stamped for production");

// 5. the deploy config, into env/deploy/ at the repo root (git-ignored)
const fb = JSON.parse(readFileSync(join(root, "firebase.json"), "utf8"));
const hosting = { ...(Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting), public: "dist-prod" };
delete hosting.predeploy;
const deployDir = join(repoRoot, "env", "deploy");
mkdirSync(deployDir, { recursive: true });
writeFileSync(join(deployDir, "firebase.prod.json"), JSON.stringify({ hosting }, null, 2) + "\n");
console.log("env/deploy/firebase.prod.json written (public dist-prod, no predeploy)");
