// Renders each public page at build time and writes the markup into its HTML.
//
// Runs after `vite build`, against the files already in dist/. It builds
// src/prerender.jsx for Node, calls it once per page, and replaces the empty
// `<div id="root"></div>` with the same markup the browser would have produced.
//
// Why the client still uses createRoot and not hydrateRoot
// --------------------------------------------------------
// hydrateRoot would let React adopt this markup instead of re-rendering it, and
// it is the usual reason to do this at all. It is wrong here. The Shell decides
// its initial sidebar state from `window.matchMedia("(max-width: 900px)")`,
// which cannot be known on the server, so on any window under 900px the server
// markup and the first client render genuinely differ. Hydrating across that
// prints a mismatch error to the console and makes React throw the markup away
// anyway — the same work, plus an error on every narrow screen.
//
// So this is a crawler-and-no-JavaScript view, not a hydration target. React
// replaces it on mount exactly as it replaces the empty div today, and the gain
// is that the document is no longer blank to anything that does not run
// scripts. Nothing about the running app changes.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(root, ".prerender");

// A separate, self-contained build. Not the page config: that one names fifteen
// HTML entries and splits vendor chunks, neither of which makes sense for a
// module that is imported once by Node and deleted.
//
// noExternal bundles React in rather than leaving it as a bare import. Left
// external, the output would `import { renderToString } from "react-dom/server"`
// and Node's named-export detection on that CommonJS build is not reliable.
await build({
  configFile: false,
  root,
  plugins: [react()],
  logLevel: "warn",
  ssr: { noExternal: true },
  // src/lib/firebase.js reads location.hostname at module scope and throws if
  // window.FIREBASE_CONFIG is missing, so importing it in Node is fatal. The
  // Shell already loads it dynamically; LapCalcView imports it statically, and
  // that one static import is enough to pull it into this build. See the stub
  // for what it replaces and why nothing shipped is affected.
  resolve: {
    alias: [{
      // Matches the whole specifier, not a piece of it: an alias regex that
      // matches only `/lib/firebase` inside `./lib/firebase` leaves the leading
      // dot behind and Vite then looks for a path with the drive letter in the
      // middle of it.
      find: /^.*\/lib\/firebase(\.js)?$/,
      replacement: resolve(root, "scripts/prerender-firebase-stub.js"),
    }],
  },
  build: {
    ssr: resolve(root, "src/prerender.jsx"),
    outDir: OUT,
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: "prerender.mjs" } },
  },
});

const { render, PRERENDERED } = await import(pathToFileURL(resolve(OUT, "prerender.mjs")).href);

// React writes its warnings to console.error. A warning during a build that
// produces the markup real visitors read is worth seeing, not swallowing.
const warnings = [];
const realError = console.error;
console.error = (...args) => warnings.push(args.join(" "));

const results = [];
try {
  for (const page of PRERENDERED) {
    const file = resolve(root, `dist/${page}.html`);
    const html = readFileSync(file, "utf8");
    const marker = '<div id="root"></div>';
    if (!html.includes(marker)) {
      throw new Error(`dist/${page}.html has no empty <div id="root"></div> to fill`);
    }
    const markup = render(page);
    writeFileSync(file, html.replace(marker, `<div id="root">${markup}</div>`));
    // Text only, tags stripped, so the number means what it looks like it means.
    const text = markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    results.push({ page, bytes: markup.length, text: text.length });
  }
} finally {
  console.error = realError;
  rmSync(OUT, { recursive: true, force: true });
}

for (const r of results) {
  console.log(`  ${r.page.padEnd(20)} ${String(r.bytes).padStart(7)} bytes of markup, ${r.text} characters of text`);
}
const empty = results.filter((r) => r.text < 200);
if (empty.length) {
  throw new Error(`prerendered but still effectively blank: ${empty.map((r) => r.page).join(", ")}`);
}
if (warnings.length) {
  console.log(`\n  ${warnings.length} React warning(s) during prerender:`);
  for (const w of [...new Set(warnings)]) console.log(`    ${w.slice(0, 200)}`);
}
console.log(`prerender: ${results.length} pages filled in`);
