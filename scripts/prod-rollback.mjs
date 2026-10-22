// Put production's website and security rules back as they were.
//
//   node scripts/prod-rollback.mjs hosting --project=<id> --site=<site> --version=<version id>
//       Re-releases a version the site has served before. Firebase keeps every
//       version, so this is instant and needs nothing from the backup.
//       Production's original: --site=turboflow-7b3ca --version=fa328903006aff67
//
//   node scripts/prod-rollback.mjs rules --project=<id> --from=<backup dir> [--bucket=<bucket>]
//       Creates rulesets from the rules text saved in the backup and releases
//       them for Firestore and for Storage. From the saved text rather than the
//       saved ruleset ids, because an old ruleset can be cleaned up; the text
//       cannot.
//
// Needs GTOKEN (an access token: gcloud auth print-access-token). Every write
// is logged. Production needs --production as well.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => rest.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const project = opt("project");
if (!project || !["hosting", "rules"].includes(cmd)) {
  console.error("usage: prod-rollback.mjs hosting|rules --project=<id> ...");
  process.exit(2);
}
if (project === "turboflow-7b3ca" && !rest.includes("--production")) {
  console.error("refusing to change production without --production");
  process.exit(2);
}
const H = { Authorization: `Bearer ${process.env.GTOKEN.trim()}`, "Content-Type": "application/json",
  "X-Goog-User-Project": project };
const call = async (method, url, body) => {
  const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

if (cmd === "hosting") {
  const site = opt("site");
  const version = opt("version");
  const API = "https://firebasehosting.googleapis.com/v1beta1";
  const rel = await call("POST",
    `${API}/sites/${site}/releases?versionName=${encodeURIComponent(`sites/${site}/versions/${version}`)}`,
    { message: "rollback" });
  console.log(`site ${site} now serves version ${version} (release ${rel.name.split("/").pop()}, ${rel.releaseTime})`);
}

if (cmd === "rules") {
  const dir = join(opt("from"), "rules");
  const RULES = "https://firebaserules.googleapis.com/v1";
  const files = readdirSync(dir).filter((f) => f.includes("__") && !f.endsWith(".json"));
  for (const f of files) {
    // cloud.firestore__firestore.rules, firebase.storage__<bucket>__storage.rules
    const [service, ...more] = f.split("__");
    const fileName = more.pop();
    const release = service === "cloud.firestore" ? "cloud.firestore"
      : `firebase.storage/${opt("bucket") || more.join("/")}`;
    const content = readFileSync(join(dir, f), "utf8");
    const rs = await call("POST", `${RULES}/projects/${project}/rulesets`,
      { source: { files: [{ name: fileName, content }] } });
    await call("PATCH", `${RULES}/projects/${project}/releases/${release}`,
      { release: { name: `projects/${project}/releases/${release}`, rulesetName: rs.name } });
    console.log(`${release} now uses ${rs.name.split("/").pop()} (from ${f}, ${content.length} chars)`);
  }
}
