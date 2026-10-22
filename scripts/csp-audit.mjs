// The Content Security Policy has to be enforced, and it has to match the build.
//
// Two failure modes, both silent, both of which this turns into a red test.
//
// The policy was `Content-Security-Policy-Report-Only` for its whole life, with
// no report-uri and no report-to. That is a policy that blocks nothing and
// records nothing: it looked like a control in every review and was not one.
//
// And now that it is enforced, `script-src` pins the one inline script the site
// has - the theme bootstrap in the <head>, which stamps the stored choice onto
// <html> before first paint - by its sha256. A hash is the right way to allow
// one known script without allowing every injected one, and it has a cost:
// change a character of that script and the browser refuses to run it. The page
// still works, it just flashes the wrong theme on every load, which is exactly
// the kind of thing that ships and is noticed six weeks later.
//
// So the hash is recomputed from the built pages here and checked against the
// policy that will be served with them.
//
// Run: node scripts/csp-audit.mjs      (after npm run build)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const fails = [];
const note = (what) => fails.push(what);

// ── the policy that will actually be served ────────────────────────────────
const cfg = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8"));
const headers = (cfg.hosting?.headers ?? []).flatMap((b) => b.headers ?? []);

const reportOnly = headers.find((h) => h.key === "Content-Security-Policy-Report-Only");
const enforced = headers.find((h) => h.key === "Content-Security-Policy");

if (!enforced) {
  note("no enforced Content-Security-Policy header in firebase.json");
}
if (reportOnly && !/report-uri|report-to/.test(reportOnly.value ?? "")) {
  note("a Report-Only CSP with no report-uri and no report-to: it blocks "
    + "nothing and records nothing, so it is not a control");
}

const policy = enforced?.value ?? "";
const directive = (name) => {
  const m = policy.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`));
  return m ? m[1].trim().split(/\s+/) : null;
};

const scriptSrc = directive("script-src") ?? [];

if (scriptSrc.includes("'unsafe-inline'")) {
  note("script-src carries 'unsafe-inline', which permits any injected inline "
    + "script. Pin the ones the site needs by hash instead");
}
if (scriptSrc.includes("'unsafe-eval'")) {
  note("script-src carries 'unsafe-eval'");
}
for (const needed of ["object-src 'none'", "base-uri 'self'", "frame-ancestors"]) {
  if (!policy.includes(needed.split(" ")[0])) note(`the policy has no ${needed.split(" ")[0]}`);
}

// ── every inline script in the build, and whether the policy allows it ─────
if (!existsSync(DIST)) {
  note("dist/ is not built, so the inline scripts cannot be checked. Run npm run build");
} else {
  const pages = readdirSync(DIST).filter((f) => f.endsWith(".html"));
  if (!pages.length) note("dist/ contains no HTML pages");

  const allowed = new Set(scriptSrc.filter((s) => s.startsWith("'sha")).map((s) => s.slice(1, -1)));
  const seen = new Map();

  for (const page of pages) {
    const html = readFileSync(join(DIST, page), "utf8");
    // Inline only. A <script src=...> is governed by the origin list, not a hash.
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const [, attrs, body] = m;
      if (!body.trim()) continue;
      // A <script> whose type is not a JavaScript MIME type is a data block:
      // the HTML parser never executes it, so script-src is never consulted.
      // This audit used to count them, and flagged the JSON-LD on the home page
      // as needing a hash in the policy.
      //
      // Checked rather than assumed. Appending both a JSON-LD block and a real
      // inline script to the deployed page produced exactly one
      // securitypolicyviolation event — script-src-elem, naming the hash of the
      // real script — and the JSON-LD raised nothing. Adding a hash for it would
      // have pinned the policy to a block that never runs, so any later edit to
      // the structured data would have looked like a CSP failure.
      const type = (attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
      const executable = !type
        || /^(text|application)\/(javascript|ecmascript)$/i.test(type)
        || type.toLowerCase() === "module";
      if (!executable) continue;
      const hash = "sha256-" + createHash("sha256").update(body, "utf8").digest("base64");
      if (!seen.has(hash)) seen.set(hash, []);
      seen.get(hash).push(page);
    }
  }

  for (const [hash, on] of seen) {
    if (!allowed.has(hash)) {
      note(`an inline script on ${on.length} page(s) (${on.slice(0, 3).join(", ")}) `
        + `is not allowed by the policy.\n      Add '${hash}' to script-src in firebase.json`);
    }
  }

  // A hash in the policy that no page uses is not dangerous, but it is a sign
  // the policy and the build have drifted, which is the thing being guarded.
  for (const hash of allowed) {
    if (!seen.has(hash)) {
      note(`script-src allows '${hash}', which no built page uses. `
        + "Remove it, or the policy is describing a build that no longer exists");
    }
  }

  if (!fails.length) {
    console.log(`csp audit: enforced, ${pages.length} pages, `
      + `${seen.size} inline script(s), every hash matches`);
  }
}

if (fails.length) {
  console.log(`csp audit: ${fails.length} problem(s)\n`);
  for (const f of fails) console.log("   - " + f);
  process.exit(1);
}
