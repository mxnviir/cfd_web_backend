// Any class the markup uses that no stylesheet defines. Freezing the utilities
// means nothing generates a class on demand any more, so a class that slipped
// through would simply do nothing, silently, on a page nobody checked.
import { readFileSync, readdirSync, statSync } from "node:fs";

const ROOT = "C:/Users/shash/Desktop/cfd_web_backend/turboflow";
const cssFiles = readdirSync(ROOT + "/dist/assets").filter((f) => f.endsWith(".css"));
let css = cssFiles.map((f) => readFileSync(ROOT + "/dist/assets/" + f, "utf8")).join("\n");
// public/ is copied as-is and the classic page carries its own <style>
css += readFileSync(ROOT + "/legacy/workbench-classic.html", "utf8");

const defined = new Set();
for (const m of css.matchAll(/\.((?:\\.|[-\w])+)/g)) defined.add(m[1].replace(/\\/g, ""));

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (["node_modules", "dist", "dist-prod", "archive", ".git"].includes(n)) continue;
    const p = d + "/" + n;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx|html)$/.test(n)) files.push(p);
  }
})(ROOT);

const used = new Map();
for (const f of files) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/class(?:Name)?[=:]\s*["'`]([^"'`]+)["'`]/g)) {
    for (const c of m[1].split(/\s+/)) {
      if (c && !c.includes("{") && !c.includes("$")) {
        used.set(c, (used.get(c) || 0) + 1);
      }
    }
  }
}

const missing = [...used.entries()].filter(([c]) => !defined.has(c))
  .sort((a, b) => b[1] - a[1]);
console.log("classes used:", used.size, " defined:", defined.size);
console.log("used but defined nowhere:", missing.length);
for (const [c, n] of missing.slice(0, 40)) console.log("   ", c, "x" + n);
