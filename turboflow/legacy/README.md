# Retired code, kept out of the served build

`workbench-classic.html` and the five scripts beside it are the hand-written
Workbench that came before `src/workbench/`. Nothing links to the page and the
React Workbench replaced all of it.

They were in `public/`, which Vite copies into `dist/` verbatim, so the page was
being served at `/workbench-classic` on every deploy. That was worth stopping:

- it pulls three.js straight from `cdn.jsdelivr.net` with no integrity hash, so
  a bad day at that CDN would have run somebody else's JavaScript on the
  turboflow origin, where a signed-in user's Firebase session lives;
- it injects five more scripts with `document.write`;
- it calls the geometry service from the browser, which is why that service was
  deployed to `allUsers` for years;
- and none of it is reachable from the product.

They are kept rather than deleted because `tests/test_chart.mjs`,
`tests/test_compare.mjs` and `scripts/orphan-classes.mjs` still read this file:
the chart and comparison functions in it are the ones those suites check, and
the inline stylesheet is part of what the orphan-class audit measures. Deleting
the page means porting those three first.

Nothing in `legacy/` is built, bundled or deployed.
