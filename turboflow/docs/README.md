# TurboFlow

> **Out of date.** This page describes the August 2026 Supabase version, which
> was abandoned on 9 Sep 2026. Start at [handbook/00-README.md](handbook/00-README.md).

CFD for F1 in Schools teams: upload a car, get drag and lift back, compare
versions. Runs on Supabase (Postgres, Auth, Storage, Edge Functions), with the
solver on SimScale and two Cloud Run services doing the heavy work.

Originally a Firebase app; `MIGRATION.md` is the running status document for that
move and for the workbench built on top of it.

---

## Layout

```
index.html                  the existing app (compiled bundle, untouched)
supabase-firebase-shim.js   Firebase compat API implemented on supabase-js
workbench.html              the CFD workspace: tree, 3D viewport, charts, editing

supabase/
  migrations/               schema, RLS, billing functions, webhook  (0001-0018)
  functions/                six edge functions + _shared helpers
  _migrate/                 deploy + data-loading scripts

docker jobs/                Cloud Run job: runs the SimScale pipeline, exports results
tessellate/                 Cloud Run service: the CAD kernel (OCC via CadQuery)
tests/                      five suites, all against real data — see tests/README.md
_fbexport/                  read-only export from the old Firestore
```

## How a simulation flows

```
workbench: upload .step
    │
    ├─ Storage  jobs/<uid>/<jobId>/geometry.step        (RLS: your folder only)
    ├─ tessellate service → geometry.glb                (browsers cannot read STEP)
    └─ insert jobs row, status 'pending'
            │
            └─ pg_net trigger → on-new-job edge function (shared-secret header)
                    │  validates the user, clamps the parameters, charges credits
                    └─ Cloud Run job → SimScale: upload, mesh, solve
                            │
                            ├─ drag / lift from the force CSVs
                            ├─ residual + force history → jobs.plots
                            └─ surface + fields → results.glb + fields/*.bin
                                     │
                                     └─ workbench draws it: field colouring,
                                        cutting plane, convergence, comparison
```

Credits are charged in Postgres functions so the balance check and the debit
happen in one transaction — there is no path that spends credits twice.

## Running it

The app is static: serve the folder, or open `index.html`. `workbench.html`
shares the session through the shim.

```powershell
# tests
node   tests\test_lapsim.mjs
node   tests\test_chart.mjs
node   tests\test_compare.mjs
python tests\test_transform.py
python tests\test_plots.py        # needs .env.deploy + network

# edge functions (needs a Supabase personal access token)
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."
powershell -File supabase\_migrate\deploy.ps1

# cloud run
gcloud builds submit "docker jobs" --tag gcr.io/turboflow-7b3ca/simscale-job-supabase
gcloud builds submit tessellate    --tag gcr.io/turboflow-7b3ca/turboflow-tessellate
```

Secrets live in `.env.deploy`, which is gitignored and never committed.

## Conventions worth knowing

- **The frontend speaks camelCase, Postgres speaks snake_case.** Conversion
  happens at the boundary — in the shim and in the worker. `jsonb` columns pass
  through untouched.
- **STEP is the source of truth, `.glb` is only for looking at.** SimScale meshes
  the B-rep, so geometry edits are replayed on the solid by the same CAD kernel
  and produce a new STEP; the display mesh is regenerated from it.
- **Services that hold the service-role key bypass RLS.** Anything the policies
  guarantee — own-folder only, write-once — is restated inside those services,
  because otherwise routing a write through them launders the policy away.
- **Web-submitted jobs are `queued` and do not auto-run; only `pending` (Fusion,
  and Automatic CFD) triggers the worker.** Carried over from the original
  Firebase behaviour deliberately.

## Known gaps

Tracked in `MIGRATION.md`; the ones that block a full end-to-end run are Google
sign-in and the `GCP_SA_KEY` secret.
