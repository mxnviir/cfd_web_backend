// Multi-page build.
//
// The old site was one index.html that rendered every screen from a `view`
// state variable, behind a hosting rewrite that returned it for every URL. So
// /billing was the home page with different contents, a hard refresh always
// landed on home, and nothing could be linked to or cached separately.
//
// Each page below is a real HTML file with its own entry. Vite works out what
// each one actually needs and gives the shared parts — React, the Firebase
// client, the shell — a single hashed chunk that every page reuses from cache.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const page = (name) => resolve(__dirname, `${name}.html`);

/**
 * The one rewrite firebase.json declares, for the dev server too.
 *
 * /workbench/{projectId} is a real address the user can bookmark and reload,
 * and hosting turns it into /workbench.html. Without the same rule here, dev
 * serves the home page for it and the Workbench cannot be opened at all
 * locally, which is a difference between dev and production that costs an
 * hour every time somebody rediscovers it.
 */
const workbenchRewrite = {
  name: "workbench-rewrite",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (/^\/workbench(\/|$)/.test(req.url.split("?")[0])) req.url = "/workbench.html";
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), workbenchRewrite],
  // The old hand-written Workbench is still in public/, now as
  // workbench-classic.html. The new one is a real Vite entry below, which is
  // what lets it share the React and Firebase chunks with every other page
  // instead of pulling three.js from a CDN import map. Build spec step 15
  // deletes the old file; until then both work and neither shadows the other.
  publicDir: "public",
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
        index: page("index"),
        simulations: page("simulations"),
        billing: page("billing"),
        "lap-calculator": page("lap-calculator"),
        dashboard: page("dashboard"),
        workbench: page("workbench"),
        docs: page("docs"),
        sponsorship: page("sponsorship"),
        mentorship: page("mentorship"),
        modelling: page("modelling"),
        "privacy-policy": page("privacy-policy"),
        terms: page("terms"),
        "refund-policy": page("refund-policy"),
        "sponsorship-policy": page("sponsorship-policy"),
        404: page("404"),
      },
      output: {
        // One shared vendor chunk rather than a copy of React per page. This is
        // the whole point of the multi-page build: move between pages and only
        // the small page-specific chunk is new.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react")) return "vendor-react";
          if (id.includes("firebase") || id.includes("@firebase")) return "vendor-firebase";
          if (id.includes("recharts") || id.includes("d3")) return "vendor-charts";
          // three.js is 600 kB and only the Workbench loads it. In the shared
          // "vendor" chunk it would be downloaded by the home page too, which
          // is most of that page's weight for something it never draws.
          if (id.includes("three")) return "vendor-three";
          return "vendor";
        },
      },
    },
  },
  server: { port: 5173 },
});
