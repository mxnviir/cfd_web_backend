// robots.txt and sitemap.xml, written into dist after the Vite build.
//
// Neither file existed. https://turboflow-test.web.app/robots.txt and
// /sitemap.xml both returned the 404 page, which means every crawler was
// guessing at what it was allowed to fetch and none of them had a list of what
// is here.
//
// Generated rather than hand-written for one reason: a page added to
// vite.config.js and forgotten here is the normal way a sitemap goes stale. The
// table below is checked against the build's own entry list at the bottom of
// this file, and the build fails if they disagree.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the site is served from.
 *
 * One constant, because it appears in the sitemap (which requires absolute
 * URLs) and in robots.txt. The `<link rel="canonical">` in each HTML file
 * already hardcodes the same origin; moving to the production domain is those
 * files and this line.
 */
export const ORIGIN = "https://turboflow-test.web.app";

/**
 * Every built page, and whether a search engine should index it.
 *
 * `index: false` is not about secrecy — these pages are reachable and their
 * markup is public. It is that they are the signed-out shell of a screen whose
 * content only exists after sign-in, so what a crawler can see of /billing is a
 * heading and an empty panel. Indexed, that is a thin page competing with the
 * real ones; listed in a sitemap, it is a claim that it is worth fetching.
 */
export const PAGES = [
  { file: "index", path: "/", index: true },
  { file: "docs", path: "/docs", index: true },
  { file: "lap-calculator", path: "/lap-calculator", index: true },
  { file: "sponsorship", path: "/sponsorship", index: true },
  { file: "mentorship", path: "/mentorship", index: true },
  { file: "modelling", path: "/modelling", index: true },
  { file: "privacy-policy", path: "/privacy-policy", index: true },
  { file: "terms", path: "/terms", index: true },
  { file: "refund-policy", path: "/refund-policy", index: true },
  { file: "sponsorship-policy", path: "/sponsorship-policy", index: true },

  { file: "dashboard", path: "/dashboard", index: false },
  { file: "simulations", path: "/simulations", index: false },
  { file: "billing", path: "/billing", index: false },
  { file: "workbench", path: "/workbench", index: false },
  { file: "404", path: "/404", index: false },
];

const indexable = PAGES.filter((p) => p.index);

// ── robots.txt ───────────────────────────────────────────────────────────────
//
// Open to everything, including the AI crawlers, which are named here only so
// that the answer is written down rather than inferred from silence. The one
// thing that is closed is the set of pages above that are signed-in screens:
// there is nothing there for a crawler to read, and fetching them repeatedly
// costs us Hosting reads for markup that says nothing.
const robots = `# https://www.robotstxt.org/robotstxt.html
#
# Everything here is public and crawlable, AI crawlers included. The pages
# listed under Disallow are the signed-in application screens: a crawler
# without a session sees an empty panel, so there is nothing there to index.

User-agent: *
${indexable.length ? "Allow: /\n" : ""}${PAGES.filter((p) => !p.index && p.path !== "/404")
  .map((p) => `Disallow: ${p.path}`)
  .join("\n")}

Sitemap: ${ORIGIN}/sitemap.xml
`;

// ── sitemap.xml ──────────────────────────────────────────────────────────────
//
// No <lastmod>. It is optional, search engines discount it when it is wrong,
// and there is no honest source for it here: this is not a git checkout, so a
// file's modification time is when it was last copied, not when the page last
// changed. A date that is invented is worse than a date that is absent.
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexable.map((p) => `  <url><loc>${ORIGIN}${p.path}</loc></url>`).join("\n")}
</urlset>
`;

// ── the guard ────────────────────────────────────────────────────────────────
// vite.config.js is where a new page actually gets built. If one is added there
// and not here it would be live, crawlable and missing from the sitemap, which
// is exactly the failure this file exists to prevent, so fail the build loudly.
function checkAgainstVite() {
  const config = readFileSync(resolve(root, "vite.config.js"), "utf8");
  const block = config.slice(config.indexOf("input: {"), config.indexOf("output: {"));
  const built = [...block.matchAll(/page\("([^"]+)"\)/g)].map((m) => m[1]);
  const known = new Set(PAGES.map((p) => p.file));
  const missing = built.filter((f) => !known.has(f));
  const extra = PAGES.map((p) => p.file).filter((f) => !built.includes(f));
  if (missing.length || extra.length) {
    throw new Error(
      "scripts/seo.mjs is out of step with vite.config.js.\n"
      + (missing.length ? `  built but not listed here: ${missing.join(", ")}\n` : "")
      + (extra.length ? `  listed here but not built: ${extra.join(", ")}\n` : "")
      + "  Add the page to PAGES above, with index: true only if a search engine\n"
      + "  should list it.",
    );
  }
  return built.length;
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/")
    || process.argv[1]?.endsWith("seo.mjs")) {
  const n = checkAgainstVite();
  writeFileSync(resolve(root, "dist/robots.txt"), robots);
  writeFileSync(resolve(root, "dist/sitemap.xml"), sitemap);
  console.log(`seo: robots.txt and sitemap.xml written (${indexable.length} indexable of ${n} pages)`);
}
