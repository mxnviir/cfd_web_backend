# Tests

Three checks, all against real data rather than fixtures invented to pass. Each
one reads the code that actually ships — by importing or source-slicing the real
file — so a test can never quietly drift from the thing it is testing.

```powershell
node   tests\test_lapsim.mjs     # lap-time physics
node   tests\test_chart.mjs      # convergence / force charts
python tests\test_transform.py   # CAD edit operations         (needs cadquery)
python tests\test_plots.py       # plot export from SimScale   (needs .env.deploy + network)
```

| File | What it proves | Source of truth |
|---|---|---|
| `test_lapsim.mjs` | The ported lap-time physics matches the original Firebase Python function to 1e-6 s over four cases, and still raises when a car cannot finish. | Values produced by running the original `main.py` under numpy. |
| `test_chart.mjs` | `lineChart` (extracted from `workbench.html`) draws 6 residual series and 2 force series from a real run: no `NaN` coordinates, every point inside the viewBox, log axis spanning 1e0 → 1e-8. | `plots.json` — the real 29 KB payload from run `376ccaaf`. |
| `test_transform.py` | `apply_ops` and `exact_bbox` (source-sliced from `tessellate/main.py`) on a deliberately asymmetric solid: translate preserves size and volume, scale cubes the volume, rotate 90° swaps extents, mirror preserves volume *and* flips the asymmetry, ops compose in order, six bad inputs are rejected, and the reported bounding box scales exactly. | OCC, via cadquery. |
| `test_results_export.py` | `export_results_for_viewer` turns a SimScale-shaped package into what the viewer needs: the surface `.vtp` is chosen over the larger volume `.vtu`, decimation respects the triangle budget **and keeps the fields**, vectors become magnitudes, ranges survive decimation, and every field binary is one float per glb vertex. | A synthetic package with the same shape as the real 1.7 GB one, network stubbed. |
| `test_plots.py` | `export_plots` (source-sliced from `docker jobs/simscale_job.py`) parses SimScale's residual and force CSVs correctly, all six series converge, and drag comes from `TOTAL_FORCE_X` on the `FORCE_PLOT` item. | The live SimScale API, run `376ccaaf`. |
| `test_billing.js` | The whole credit lifecycle against the live database on a throwaway account: signup defaults, protected fields, the RPC lockdown from a real user session, charging, **no partial charge on failure**, sponsorship, unlimited passes, refund-once-only, lap calc, and PayPal capture including replay and cross-account claims. | The live Supabase project. |

`test_plots.py` needs `SIMSCALE_API_KEY` in `../.env.deploy` and hits the network;
the other two are offline.

## Why these three

They cover the places where being wrong is silent. Physics that returns a
plausible number, a chart that draws a confident line through bad coordinates,
a CSV parser that picks the wrong column, a bounding box that is 0.1% large —
none of those throw.

Two of them are regression tests for bugs that were actually shipped:

- **Drag was under-reported by ~10%** since the Firebase build, because a fuzzy
  column match hit `PRESSURE_FORCE_X` before `TOTAL_FORCE_X` and dropped skin
  friction (MIGRATION.md 8c). `test_plots.py` pins the column choice.
- **A transformed part measured 0.40077 m instead of 0.4 m** on `cadquery
  2.5.2`, which the container pins — `Shape.BoundingBox()` is not optimal there,
  though it is on 2.8.0, so it reproduced clean locally and wrong in production.
  That number sizes the wind tunnel around the car. `test_transform.py` asserts
  exactness to 1e-9 across three scale factors.

- **Every decimated result would have shipped with no fields.** `decimate()`
  throws point data away unless attributes are weighted in its error metric, and
  the flag that does that was renamed between pyvista 0.44 and 0.45 — again, the
  container pins the older one. Solver meshes always exceed the triangle budget,
  so every real run would have produced grey geometry and an empty field list,
  with nothing logged. `test_results_export.py` asserts the field binaries exist
  and match the vertex count, which is what caught it.

All three were found by running real data through the shipping code, not by
reading it. Two of the three were library-version differences between the dev
machine and the container — a class of bug that reproduces clean locally every
time, so it can only be caught by testing what actually ships.

## The one that costs money

`e2e_autosetup.mjs` is not in `run-all.sh` and never will be. It takes a real
STEP file and puts it through the deployed stack - group, upload intent, upload,
import, wind tunnel, automatic setup - as a signed-in user, and with `--queue` it
spends credits on a real solve. It needs `gcloud` logged in with permission to
impersonate the test project's admin service account, because the only way in to
a signed-in page is a token and nothing should be typing a password.

    node tests/e2e_autosetup.mjs "C:/path/to/car.step"
    node tests/e2e_autosetup.mjs --group=<id>      # a second car in one group
    node tests/e2e_autosetup.mjs --queue --watch   # spends credits

It reports the simulation it created, found by geometry rather than by group: a
Firestore query with no ordering comes back in document-id order, and reading
whichever row sorted first is how a working name-uniqueness rule got reported as
broken.
