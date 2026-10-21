// The Workbench's build.
//
// The site itself is the classic static app in public/ - index.html with
// React and Firebase from CDNs, served as-is - and only the Workbench is a
// Vite entry: three.js, the occt-wasm geometry engine and the Firebase
// client are bundled, hashed and cached for it, and nothing else pays for
// them.
//
// The one rewrite firebase.json declares, for the dev server too.
//
// /workbench/{projectId} is a real address the user can bookmark and reload,
// and hosting turns it into /workbench.html. Without the same rule here, dev
// serves the home page for it and the Workbench cannot be opened at all
// locally, which is a difference between dev and production that costs an
// hour every time somebody rediscovers it.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const workbenchHtml = resolve(__dirname, "workbench.html");

const workbenchRewrite = {
  name: "workbench-rewrite",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = req.url.split("?")[0];
      if (/^\/workbench(\/|$)/.test(path)) {
        req.url = "/workbench.html";
      } else if (path === "/"
        // The classic site is one page with in-memory views, so every
        // address that is not a file lands on it - the same shape as the
        // hosting catch-all. Files (dots), Vite internals (/@, /__vite)
        // and module URLs pass through untouched.
        || (!path.includes(".") && !path.startsWith("/@") && !path.startsWith("/__vite"))) {
        req.url = "/index.html";
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), workbenchRewrite],
  publicDir: "public",
  // occt-wasm loads its own .wasm by URL, which pre-bundling breaks, so it
  // stays out of the optimizer; the cut worker is built as an ES module so it
  // imports the package the same way the page does.
  optimizeDeps: { exclude: ["occt-wasm"] },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Source maps for a production bundle nobody can otherwise debug. They are
    // separate files, so they cost a request only when devtools is open.
    // Off. A source map publishes every line of the app, comments included,
    // to anyone who opens devtools. Build spec section 15 step 0.
    sourcemap: false,
    rollupOptions: {
      input: {
        workbench: workbenchHtml,
      },
      output: {
        // One shared vendor chunk rather than a copy of React per page. Only
        // the Workbench is bundled, but this keeps React, Firebase and three
        // in files the browser can cache separately from the app code.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react")) return "vendor-react";
          if (id.includes("firebase") || id.includes("@firebase")) return "vendor-firebase";
          if (id.includes("recharts") || id.includes("d3")) return "vendor-charts";
          // three.js is 600 kB and only the Workbench loads it.
          if (id.includes("three")) return "vendor-three";
          return "vendor";
        },
      },
    },
  },
  server: { port: 5173 },
});
