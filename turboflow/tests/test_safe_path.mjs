// A `?next=` value must not be able to send somebody off this site.
//
// The check this is a regression test for was, in two places on the sign-in
// path:
//
//     next.startsWith("/") && !next.startsWith("//")
//
// which reads as "a path, not a protocol-relative URL" and is not what it does.
// Every browser, following the WHATWG URL rules, normalises a backslash in the
// authority position to a forward slash, so:
//
//     /\evil.com     starts with "/", does not start with "//"  ->  allowed
//                    resolves to https://evil.com               ->  gone
//
// That is a link on the real turboflow.cloud domain which signs a person in and
// then drops them on somebody else's page. It is the primitive a phishing site
// wants, and the sign-in flow is the worst place in the product to have it.
//
// The fix resolves the value against the current origin and asks the parser
// where it landed, which is the only test that cannot be fooled by a spelling
// nobody thought of. This file exists because the last two attempts at it were
// hand-written string checks.
//
// Node's URL is the same WHATWG parser the browsers use, so the results here
// are the results there.
//
// Run: node tests/test_safe_path.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// pages.js reads window.location, so it gets a window before it is imported.
const ORIGIN = "https://turboflow-test.web.app";
globalThis.window = { location: { origin: ORIGIN } };

const src = readFileSync(join(root, "src/lib/pages.js"), "utf8");
if (!/export function safePath/.test(src)) {
  console.log("safe path: FAILED\n  src/lib/pages.js no longer exports safePath");
  process.exit(1);
}
const { safePath } = await import(
  "data:text/javascript;base64," + Buffer.from(src, "utf8").toString("base64"));

let checks = 0;
const failures = [];
const BS = String.fromCharCode(92);

function ok(what, condition, detail) {
  checks += 1;
  if (!condition) failures.push(detail ? `${what}: ${detail}` : what);
}

/** Where a browser would actually go, given what safePath returned. */
const lands = (value) => {
  try { return new URL(safePath(value, "/"), ORIGIN).origin; } catch { return "parse error"; }
};

// ── the bypass, and its relatives ──────────────────────────────────────────
const offSite = [
  ["//evil.com", "protocol relative"],
  [BS + BS + "evil.com", "two backslashes"],
  ["/" + BS + "evil.com", "one slash then a backslash, the bypass that worked"],
  ["/" + BS + "/evil.com", "slash backslash slash"],
  [BS + "/evil.com", "backslash slash"],
  ["https://evil.com/x", "an absolute URL"],
  ["http://evil.com", "an absolute URL on http"],
  ["//evil.com/dashboard", "protocol relative with a plausible path"],
  ["///evil.com", "three slashes"],
  ["/" + BS + BS + "evil.com", "slash and two backslashes"],
  ["https:/evil.com", "a scheme with one slash"],
];
for (const [value, why] of offSite) {
  ok(`refuses ${why}`, lands(value) === ORIGIN,
    `${JSON.stringify(value)} would have landed on ${lands(value)}`);
}

// ── things that are not paths at all ───────────────────────────────────────
for (const [value, why] of [
  ["javascript:alert(1)", "a javascript URL"],
  ["data:text/html,<script>alert(1)</script>", "a data URL"],
  ["mailto:someone@example.com", "a mailto"],
  ["vbscript:msgbox(1)", "a vbscript URL"],
]) {
  const got = safePath(value, "/");
  ok(`refuses ${why}`, got === "/" || got.startsWith("/"),
    `${JSON.stringify(value)} came back as ${JSON.stringify(got)}`);
  ok(`and ${why} cannot execute`, !/^[a-z]+:/i.test(got), JSON.stringify(got));
}

// ── nothing, or rubbish ────────────────────────────────────────────────────
ok("no value falls back", safePath(undefined, "/dashboard") === "/dashboard");
ok("an empty string falls back", safePath("", "/dashboard") === "/dashboard");
ok("a number falls back", safePath(42, "/dashboard") === "/dashboard");
ok("an object falls back", safePath({ toString: () => "//evil.com" }, "/x") === "/x");
ok("the default fallback is the site root", safePath(null) === "/");

// ── and the ordinary case still works, or the sign-in loses people ─────────
const keeps = [
  ["/dashboard", "/dashboard"],
  ["/billing", "/billing"],
  ["/workbench/abc123", "/workbench/abc123"],
  ["/billing?tab=history", "/billing?tab=history"],
  ["/docs#step-3", "/docs#step-3"],
  ["/workbench/g1/geometry/new?from=import", "/workbench/g1/geometry/new?from=import"],
  // Same origin written out in full is still same origin.
  [`${ORIGIN}/billing`, "/billing"],
];
for (const [value, want] of keeps) {
  const got = safePath(value, "/");
  ok(`keeps ${value}`, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

// A path is returned rebuilt from the parsed URL, so what gets navigated to is
// what was checked rather than the original string beside it.
ok("a traversal is normalised rather than passed through",
  !safePath("/a/../../../etc/passwd", "/").includes(".."),
  safePath("/a/../../../etc/passwd", "/"));

// ── the two callers still use it ───────────────────────────────────────────
// A helper nothing calls is not a fix. Both of these read `next` out of the
// address bar and hand it to location.assign / location.replace.
for (const file of ["src/Shell.jsx", "src/dashboard/DashboardApp.jsx"]) {
  const text = readFileSync(join(root, file), "utf8");
  ok(`${file} uses safePath`, /safePath\(/.test(text));
  ok(`${file} no longer hand-checks the prefix`,
    !/startsWith\(["']\/\/["']\)/.test(text),
    "a startsWith('//') check is still there");
}

console.log(failures.length ? "" : `safe path: ${checks} checks, a next= cannot leave the site`);
if (failures.length) {
  console.log(`\nFAIL  ${failures.length} of ${checks}\n`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
