// Packages the Fusion 360 add-in for the project this build is for.
//
// What /docs used to hand out was a zip in the production bucket holding an
// older add-in: it asked for a Firebase refresh token, the whole-account
// credential this repo replaced with revocable connection tokens. The site
// hands out connection tokens, so the add-in people downloaded could not use
// the token the site gave them. The zip also carried a .vscode folder and
// compiled bytecode of an unrelated private module.
//
// Built here from services/TurboFlow_CFD_fusion_addin.py instead, with the
// project's own values from public/firebase-config.js, so a test build talks to
// the test project and a production build to production. Written to
// dist/downloads/TurboFlow_CFD.zip and served by Hosting from the same origin.
//
// A production build (scripts/build-prod-site.mjs) points it elsewhere with
// SITE_CONFIG (a firebase-config.js), SITE_ORIGIN and ADDIN_OUT.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";
import vm from "node:vm";

// Where the site is served from, stamped into the add-in. Lived in seo.mjs
// until the prerendered marketing pages went away; the add-in build is the
// only thing that still needed it.
const ORIGIN = "https://turboflow-test.web.app";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(root, "services/TurboFlow_CFD_fusion_addin.py");
const OUT = process.env.ADDIN_OUT || resolve(root, "dist/downloads/TurboFlow_CFD.zip");
const CONFIG = process.env.SITE_CONFIG || resolve(root, "public/firebase-config.js");

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(CONFIG, "utf8"), sandbox);
const cfg = sandbox.window.FIREBASE_CONFIG;
if (!cfg?.projectId || !cfg.apiKey || !cfg.storageBucket) {
  throw new Error("public/firebase-config.js does not define projectId, apiKey and storageBucket");
}
const site = new URL(process.env.SITE_ORIGIN || ORIGIN).host;

let py = readFileSync(SOURCE, "utf8");
// Checks the line was found, not that it changed: the add-in source already
// carries production's values, so a production build stamps them unchanged.
const stamp = (pattern, value, what) => {
  if (!pattern.test(py)) throw new Error(`build-addin: could not set ${what} in the add-in source`);
  py = py.replace(pattern, value);
};
stamp(/^FIREBASE_PROJECT = "[^"]*"/m, `FIREBASE_PROJECT = "${cfg.projectId}"`, "FIREBASE_PROJECT");
stamp(/^STORAGE_BUCKET {3}= "[^"]*"/m, `STORAGE_BUCKET   = "${cfg.storageBucket}"`, "STORAGE_BUCKET");
stamp(/^FIREBASE_API_KEY = "[^"]*"/m, `FIREBASE_API_KEY = "${cfg.apiKey}"`, "FIREBASE_API_KEY");
stamp(/^FUNCTIONS_BASE {3}= "[^"]*"/m,
  `FUNCTIONS_BASE   = "https://us-central1-${cfg.projectId}.cloudfunctions.net"`, "FUNCTIONS_BASE");
// Where the messages tell people to go: this build's site, not a hardcoded one.
py = py.replaceAll("turboflow.cloud", site).replaceAll("turboflow-7b3ca.web.app", site);
if (cfg.projectId !== "turboflow-7b3ca" && py.includes("7b3ca")) {
  throw new Error("build-addin: a production value is still in the add-in for a non-production build");
}

// A zip with one deflated file. Local header, data, central directory, end.
function zip(name, content) {
  const data = Buffer.from(content, "utf8");
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const fname = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  const localSize = local.length + fname.length + packed.length;
  const dirSize = central.length + fname.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dirSize, 12); end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, fname, packed, central, fname, end]);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip("TurboFlow_CFD.py", py));
console.log(`addin: TurboFlow_CFD.zip for ${cfg.projectId} (${site})`);
