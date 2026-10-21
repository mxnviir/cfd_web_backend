# TurboFlow — Project Handover

**Written:** 12 August 2026
**Working copy:** `C:\Users\manvir\Downloads\cfd_web_supabase`
**Live Firebase project:** `turboflow-7b3ca` (Google Cloud project number `659747979647`) — still serving, unmodified
**Supabase project ref:** `unwzwzzuzvqwkxdbxxpd`

This document is the single source of truth for where the project stands. It
covers what TurboFlow is, what was built and changed, every bug found and how,
what is deployed where, what is blocked, and what has to happen next.

Companion documents:

- `README.md` — the developer front door: layout, request flow, conventions
- `MIGRATION.md` — the running migration status doc, section by section
- `tests/README.md` — what each test suite proves and why it exists

---

## 1. What TurboFlow is

A CFD service for F1 in Schools teams. A team uploads a car (a STEP file), and
gets back drag and lift, a 3D result they can look at, and a lap-time estimate.
Runs are paid for with credits, bought through PayPal.

The solver is **SimScale** — TurboFlow is not a solver, it is the workflow around
one: geometry handling, job orchestration, billing, results and comparison.

There are two ways a job arrives:

| Route | Status it starts in | Auto-runs? |
|---|---|---|
| Web app / workbench "Automatic CFD" | `pending` | yes, via the webhook |
| Web app classic submit | `queued` | **no** — deliberately, carried over from Firebase |
| Fusion 360 plugin | `pending` | yes |

The `queued` behaviour is inherited from the original Firebase app and was kept
on purpose: those jobs are started by hand.

---

## 2. Where the project stands, in one paragraph

The Firebase→Supabase migration is **finished and deployed**. Everything runs on
Supabase (Postgres, Auth, Storage, Edge Functions) with two Cloud Run workloads.
On top of that, a full SimScale-style **workbench** was built: project tree, 3D
viewport with real field colouring, convergence and force charts, run comparison,
and CAD geometry editing with version lineage. Seven test suites pass against
real data. Six genuine bugs were found and fixed, three of which had shipped in
the original Firebase app or would have shipped broken. **Nothing further can be
verified in a browser until Google sign-in is enabled** — that is the one gate in
front of everything else.

---

## 3. Architecture

```
                    ┌──────────────────────────────────────────┐
   browser          │  index.html      (existing compiled app)  │
                    │  workbench.html  (new CFD workspace)      │
                    │  supabase-firebase-shim.js                │
                    └───────────────┬──────────────────────────┘
                                    │ supabase-js
                    ┌───────────────▼──────────────────────────┐
                    │  Supabase project unwzwzzuzvqwkxdbxxpd    │
                    │   Postgres + RLS                          │
                    │   Auth (Google OAuth)                     │
                    │   Storage bucket `cfd-files` (private)    │
                    │   6 Edge Functions (Deno)                 │
                    │   pg_net trigger → on-new-job             │
                    └───────┬──────────────────────┬───────────┘
                            │                      │
             ┌──────────────▼─────────┐  ┌─────────▼───────────────────┐
             │ Cloud Run SERVICE      │  │ Cloud Run JOB               │
             │ turboflow-tessellate   │  │ simscale-job-supabase       │
             │ OCC/CadQuery kernel    │  │ SimScale pipeline + results │
             │ STEP → glTF, edits     │  │                             │
             └────────────────────────┘  └─────────┬───────────────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │    SimScale     │
                                          │  mesh + solve   │
                                          └─────────────────┘
```

### The full path of one simulation

1. User picks a STEP in the workbench and clicks **Automatic CFD**
2. File uploads to Storage at `jobs/<uid>/<jobId>/geometry.step` — RLS permits
   writing only inside your own `jobs/<uid>/` folder
3. A `jobs` row is inserted with `status = 'pending'`
4. The insert fires the `on_job_created` trigger (`pg_net`), which POSTs to the
   `on-new-job` edge function with a shared-secret header
5. `on-new-job` sends a Discord ping, validates the user exists in Auth, clamps
   every untrusted numeric parameter, charges credits atomically via
   `apply_new_job_charge`, and triggers the Cloud Run job
6. The worker downloads the STEP, uploads it to SimScale, meshes, solves, and
   writes status updates back to Postgres at each stage
7. On completion it extracts drag and lift from the force CSVs, exports
   convergence and force history to `jobs.plots`, and unpacks the solution field
   into `results.glb` plus one binary per field
8. The workbench, subscribed over Realtime, updates live throughout, and can then
   colour the surface by pressure/velocity, cut a plane through it, chart
   convergence, and compare the run against any other

Meanwhile, in parallel with step 3, the tessellation service converts the STEP to
a `.glb` so the user sees their geometry immediately rather than after the solve.

---

## 4. Repository layout

```
index.html                  existing app — only change: a link to the workbench
app.compiled.js             compiled bundle — 3 lap-calc URLs repointed, nothing else
supabase-firebase-shim.js   Firebase compat API implemented on supabase-js
workbench.html              the entire new workspace, one file, no framework
script.js, style.css        marketing page assets (unchanged)
firestore.rules             the ORIGINAL Firebase rules — kept as the reference
                            for what the RLS policies had to reproduce

supabase/
  migrations/               0001–0020, all applied (see §6)
  functions/                6 edge functions + _shared/{util,paypal,gcp}.ts
  _migrate/                 deploy.ps1, run.js, load_legacy.js

docker jobs/                Cloud Run JOB — SimScale pipeline + results export
  simscale_job.py           the worker
  Dockerfile, requirements.txt

tessellate/                 Cloud Run SERVICE — the CAD kernel
  main.py                   /tessellate, /transform, /health
  Dockerfile, requirements.txt

tests/                      7 suites + run-all.ps1 (see §9)
_fbexport/                  read-only export from the old Firestore
.env.deploy                 all secrets, gitignored, never committed
```

---

## 5. Database

### Tables

| Table | Purpose | RLS |
|---|---|---|
| `users` | profile + credit balance | own row; money fields locked by trigger |
| `jobs` | one row per run — the unit of work AND the unit of results | own rows; insert restricted to `pending` + own paths |
| `transactions` | credit ledger | read own only, no client writes |
| `config` | pricing (`id = 'pricing'`, jsonb) | public read |
| `paypal_orders` | tamper-proof order intents | service role only |
| `legacy_users` | the 79 exported Firestore profiles | service role only |
| `legacy_jobs` | the 234 exported jobs | service role only |
| `projects` | workbench: top of the tree | own rows |
| `geometries` | uploaded/edited CAD, with version lineage | own rows + own paths |
| `simulations` | a named setup that can be run repeatedly | own rows |

`jobs` deliberately doubles as the "run" in the workbench tree — it already
carried geometry paths, solver settings, SimScale ids and results, so a parallel
table would have been duplication. It gained `project_id` and `simulation_ref`.

### Key database functions

| Function | Does |
|---|---|
| `submit_simulation_job` | prices, charges and inserts a job in one transaction |
| `apply_new_job_charge` | the same for Fusion/`pending` jobs, after clamping |
| `refund_job` | refunds and cancels/deletes, pre-run statuses only |
| `paypal_apply_credits` / `paypal_apply_unlimited` | grant on capture, idempotent |
| `lap_calc_charge` / `lap_calc_refund` | 10 credits, free for sponsored |
| `handle_new_user` | creates the profile row on signup |
| `claim_legacy_on_google` | claims credits + history on first Google identity |
| `enforce_protected_user_fields` | stops a client editing its own money fields |
| `jobs_webhook` | the `pg_net` trigger that calls `on-new-job` |

All are `SECURITY DEFINER` and **`EXECUTE` is revoked** from `public`, `anon` and
`authenticated` (see §8, finding 1). Only the service role calls them.

---

## 6. Migrations

All 20 are applied to the live database and present on disk.

| # | Name | What it does |
|---|---|---|
| 0001 | init | tables |
| 0002 | rls | row-level security policies |
| 0003 | billing_functions | submit / refund / PayPal apply |
| 0004 | new_job_charge | the Fusion-path charge |
| 0005 | realtime_and_config | realtime publication, pricing seed |
| 0006 | lap_calc | lap calculator billing |
| 0007 | legacy_backfill | `legacy_users` + first-login merge |
| 0008 | legacy_jobs | `legacy_jobs` + history backfill |
| 0009 | jobs_webhook | `pg_net` trigger → `on-new-job` |
| 0010 | storage_policy | insert into own folder |
| 0011 | security_hardening | takeover fix, path pinning |
| 0012 | claim_on_google_identity | claim moved to `auth.identities` |
| 0013 | protected_fields_internal | let internal triggers write money fields |
| 0014 | lock_down_rpcs | **revoke EXECUTE from anon/authenticated** |
| 0015 | workbench_schema | projects, geometries, simulations |
| 0016 | geometry_tessellation | glb paths, edit lineage, storage read |
| 0017 | result_fields | `results_glb_path`, `results_fields` |
| 0018 | job_plots | `plots` jsonb |
| 0019 | storage_delete_own | delete own uploads |
| 0020 | length_limits | bound client-controlled free text |

> **Note:** `0016`–`0020` were applied via the Management API during the session
> and were initially missing from disk — a fresh `run.js` deploy would have
> skipped five migrations. They have been recovered from
> `supabase_migrations.schema_migrations` and written out. **If you ever apply a
> migration outside this repo, export it back into `supabase/migrations/`.**

---

## 7. What was migrated, and how

### Auth
Firebase Auth (Google) → Supabase Auth (Google OAuth). Supabase mints a **new
uuid** at first sign-in, so old Firebase UIDs are dead keys.

### Data carry-over — the important design decision
Because the Supabase user id doesn't exist until someone logs in, nothing could
be imported ahead of time keyed by user. So:

- 79 profiles sit in `legacy_users`, keyed by lower-cased email, holding
  **2,457,168 credits**
- 234 jobs sit in `legacy_jobs`, keyed to those emails (all matched, no orphans)
- A trigger on `auth.identities` fires when a **Google** identity is created,
  matches on email, copies the profile and the job history across, and stamps
  `claimed_at`

Users who never return cost nothing. Re-runnable via
`node supabase/_migrate/load_legacy.js`.

The 26 jobs that were mid-pipeline when Firebase froze (18 `running`, 6
`meshing`, 2 `cancelling`) are imported as `failed` with an explanatory error.
They will never resume, a `running` row would spin forever in the UI, and
`meshing` sits in the refundable list — imported as-is, anyone could have
refunded a four-month-old dead job for real credits.

The single exported transaction was **not** imported: it has no `userId` and no
amount, so there is nothing to attribute it to.

### Frontend
`supabase-firebase-shim.js` reimplements the Firebase compat API on supabase-js,
so the ~44 call sites in the compiled bundle work untouched. `app.compiled.js`
was changed in exactly one way: three lap-calc URLs repointed.

### Lap-time calculator
The original physics lived in a Firebase Python function whose source wasn't in
the repo. It was recovered from the deployed function's **source archive in
GCS**, ported 1:1 to TypeScript, and verified to 1e-6 s against the original
Python across four cases plus the "car never finishes" path.

### Worker
`docker jobs/simscale_job.py` still runs on Cloud Run and still drives SimScale,
but reads/writes Supabase instead of Firestore, downloads from Supabase Storage,
and deletes input files after each run (the free tier is 1 GB). It now also
exports convergence/force plots and unpacks the solution field for the viewer.

---

## 8. Security audit

Audited the migrated schema against the original `firestore.rules`, then
pen-tested it with a real signed-in JWT. Fixes are `0011`–`0014` and `0020`.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Every billing RPC was callable from the browser.** Postgres grants `EXECUTE` to `PUBLIC` and PostgREST publishes `public` functions at `/rest/v1/rpc/…`. With only the anon key that ships in the page: `lap_calc_refund {p_uid:self}` = **+10 credits on repeat, forever**; `lap_calc_charge {p_uid:victim}` drains a rival's balance; `apply_new_job_charge` reassigns another team's job to yourself. | **Critical** | Fixed `0014`. Verified: anon → 401, service role unaffected. |
| 2 | **Credit + history takeover by email.** The backfill matched on email alone. Firebase only ever issued Google identities; Supabase also offers email/password, so signing up with a known team's address inherited their credits and runs. | High | Fixed `0011`+`0012` — claim now requires a Google identity. Verified both ways. |
| 3 | **Cross-tenant geometry.** Clients may insert `pending` jobs (parity with `validPendingJobCreate`), and nothing constrained `step_path` — a user could point a job at another team's STEP, receive their drag/lift and ParaView link, and the worker's cleanup would then delete that team's inputs. | High | Fixed `0011` — paths pinned to `jobs/<uid>/…` in the jobs policy and the storage policy. Verified 403. |
| 4 | **Live SimScale API key hardcoded** in `simscale_job.py` as a default, so it is in the repo and the old image. | High | Removed from source; now required from env. **You must still rotate the key.** |
| 5 | `on-new-job` publicly callable with no auth. | Medium | Shared-secret header `x-webhook-secret`. Verified 403/403/200. |
| 6 | Unbounded client-controlled text (a megabyte `part` name straight into the DB). | Medium | Fixed `0020` as table constraints, covering every write path. |
| 7 | Three helper functions had a mutable `search_path`. | Low | Fixed `0014`. |
| 8 | The tessellation service holds the service-role key, so it **bypasses RLS** — the storage policy's write-once guarantee did not apply to writes routed through it. "Save as v2" onto an existing folder would have destroyed the geometry a previous run was measured against. | Medium | Service now refuses an existing destination (409) and uploads without upsert. Verified live. |

**Confirmed not vulnerable**, by testing with a live user token: a user cannot
grant themselves credits or change their own pricing; cannot read another user's
rows; cannot insert a job as someone else; cannot see `paypal_orders`,
`legacy_users` or `legacy_jobs` at all.

One fix caused a second bug worth recording: `enforce_protected_user_fields`
exempted only `auth.role() = 'service_role'`, which a `SECURITY DEFINER`
**trigger** is not — so the legacy claim had its credits silently reverted to 50.
`0013` exempts internal contexts (no end-user JWT) as well.

---

## 9. Bugs found, and how

Every one was found by running real data through the shipping code. None would
have thrown an exception — they all produce plausible-looking output.

### 9.1 Drag under-reported by ~10% (inherited from Firebase)
`extract_drag_lift` chose its column with a fuzzy substring match:
`find_col(last, ["fx", "force_x", "f_x", "x"])`. `PRESSURE_FORCE_X` appears
before `TOTAL_FORCE_X`, so it matched pressure and **silently dropped viscous
force** — skin friction. On top of that, SimScale returns `Forces_Moments`
**twice** (one `FORCE_PLOT` in newtons, one `MOMENT_PLOT` in newton-metres, with
identical column names) and the old code summed both — adding a moment to a
force.

Proof from run `376ccaaf`:
```
FORCE_PLOT   PRESSURE_X=-0.17598  TOTAL_X=-0.19333  VISCOUS_X=-0.01734
MOMENT_PLOT  PRESSURE_X= 0.00290  TOTAL_X= 0.00292
sum of PRESSURE_X across both items = -0.17308   ← what was stored
correct drag (FORCE_PLOT TOTAL_X)   = -0.19333
Firebase stored drag_n              = -0.17308057472753402   ← exact match
```
Fixed: `FORCE_PLOT` only, exact-prefix match on `TOTAL_FORCE_X` / `_Z`.
**The 93 imported complete runs still carry the old numbers — see §12.**

### 9.2 Transformed geometry measured 0.08% too large
A part scaled ×2 reported `0.40077 m` instead of `0.4`. Cause: the container pins
`cadquery 2.5.2`, whose `Shape.BoundingBox()` is not optimal after a transform;
the dev machine had 2.8.0, where it is. It therefore **reproduced clean locally
and wrong in production**. Fixed with an explicit `BRepBndLib.AddOptimal_s`,
exact on any version. This matters because the bounding box sizes the wind tunnel
domain around the car.

*(My first fix for this — reordering the measurement before meshing — was a guess
and changed nothing. The live re-test caught that too.)*

### 9.3 Every decimated result would have shipped with no fields
`pyvista.decimate()` discards all point data unless attributes are weighted in
its error metric, and the flag doing that was renamed between pyvista 0.44
(pinned in the container) and 0.45 (dev machine). Solver meshes always exceed the
triangle budget, so **every real run** would have produced a `results.glb` with no
fields — grey geometry, empty field dropdown, nothing logged. Fixed by detecting
which flag name the installed build understands, and keeping the full-resolution
surface if the fields are lost anyway.

### 9.4 Worker crashed on any missing job
`maybe_single()` returns `None`, not a response object, so `res.data` raised
`AttributeError`. Found by the first smoke test. Fixed at the root with a
`fetch_job()` helper used by both call sites.

### 9.5 Realtime channel leak
`onAuthStateChange` fires on every token refresh — hourly — and `boot()` called
`live()` unguarded, stacking a new subscription each time. After an afternoon,
one job update triggered many duplicate refetches. Now subscribes once, and only
refetches on the first session.

### 9.6 Query failures rendered as emptiness
`refresh()` used `p.data || []`, so a failed query drew an empty tree reading as
"you have no projects". Now surfaces the actual error, and a dropped Realtime
channel says so rather than going quietly stale.

### The pattern
**Two of the three most serious bugs were library-version differences between the
dev machine and the container.** That class reproduces perfectly locally every
time — reading the code cannot find it. This is why every test suite
source-slices from the real shipping file rather than importing a copy.

---

## 10. The workbench

`workbench.html` — one file, ~49 KB, no framework, no chart library, no icon
pack. It shares the session with the main app through the shim's `window.sb`.

| Area | What it does |
|---|---|
| Tree | projects → simulations → runs, live over Realtime; pre-workbench jobs appear under "Unfiled" |
| Viewport | three.js + OrbitControls, loads `.glb` over a short-lived signed URL, auto-frames any car size |
| Field colouring | fragment shader over the raw field binaries, viridis ramp (perceptually uniform and colour-blind safe, unlike the CFD-default rainbow) |
| Cutting plane | clip on any axis with a slider |
| Setup panel | inlet velocity, refinement, iterations, debug mesh — with the credit cost of the current settings shown before committing |
| Geometry panel | version badge, solids/faces/triangles/dimensions, and edit controls |
| Runs tab | status pills that pulse only while live, drag, date |
| Convergence tab | residuals on a log axis (`Ux, Uy, Uz, k, omega, p`) |
| Forces tab | drag and lift against iteration |
| Compare tab | tick 2+ runs: side-by-side table with % deltas vs a baseline, overlaid drag traces |
| Automatic CFD | upload → create project/geometry/simulation → queue → tessellate |
| Cancel & refund | offered only for statuses `refund_job` will accept |

### Geometry editing — the model
**SimScale meshes the B-rep, not our triangles.** The `.glb` is display-only.
So an edit is never applied to the mesh: it is recorded as an operation list
(`geometries.edit_ops`) and replayed on the **original STEP** by the same OCC
kernel, producing a genuinely new STEP. The new geometry row points at its parent
via `derived_from`, giving `v1 → v2 → v3` lineage, and applying an edit
**branches a new simulation** rather than mutating the current one — overwriting
the geometry a result was measured against would make the comparison meaningless.

```
geometry.step ──OCC──> geometry.glb          ← what you see and drag
      │
      └── edit_ops ──OCC──> geometry_v2.step ──> SimScale ──> mesh ──> solve
```

Supported ops: `translate`, `scale`, `rotate`, `mirror` — rigid transforms and
uniform scale, i.e. what a kernel can replay on a solid without repairing
topology. No freeform sculpting; SimScale's own workbench doesn't offer that
either (modelling stays in Fusion).

### Design
No CSS framework. A token system (one spacing scale, one type scale, three greys,
one accent) and hand-written components. Numbers are tabular-figure monospace so
columns align; status pills animate only while a run is live; selected rows carry
a 2px accent edge rather than a background wash. Run rows are keyboard-operable
with `role`, `tabindex`, `aria-pressed` and a real focus ring.

### Known limits
- **No in-browser 3D geometry preview without the tessellation service** — a STEP
  cannot be triangulated in a browser; that is what the OCC service is for
- Volume fields are not exported (surface only) — see §11
- No teams/sharing yet; projects are per-user (`user_id` can become `team_id`)

---

## 11. Results pipeline — measured constraints

Three facts measured against a real completed run, not assumed:

1. A `SOLUTION_FIELD` package is **~1.7 GB** for one run
2. The download URL **does not honour Range requests** (`200`, no
   `Accept-Ranges`), so partial fetches are impossible
3. Therefore the whole archive must come down every time

The worker streams it to disk with a 6 GB abort, extracts **one** surface entry
rather than `extractall`, deletes the archive before VTK reads anything, and
decimates to a 300k-triangle budget. The first version held the package in memory
and would have been killed on its first real run — Cloud Run's `/tmp` is
RAM-backed, so it was heading for ~1.5 GB on a 2 GiB job. The job is now
**8 GiB / 4 vCPU**.

Decimation is a visual change only: drag and lift come from the solver's force
CSVs, never from this surface.

**Plan for this:** at roughly 10–20 MB of surface + fields per run, Supabase's
1 GB free tier holds on the order of **50–100 runs**. With 79 users that is not a
lot. Options: a paid Storage tier, a retention policy that drops result files
after N days, or exporting fewer fields.

Convergence and force history are a different story — a few KB each, so they live
on the job row as `plots` jsonb and cost nothing.

---

## 12. Open decision: the 93 historical runs

The imported complete runs carry the **under-reported drag** from §9.1 (~10% low,
missing skin friction). They are internally consistent with each other, so
team-vs-team rankings still hold — but they are not physically right, and they
will read ~10% lower than any new run, which makes old-vs-new comparison
misleading.

Three options:

1. **Leave them.** Simplest. Comparison across the migration boundary is wrong.
2. **Flag them in the UI.** Mark pre-migration runs as "legacy drag" so nobody
   compares them to new numbers unknowingly. Modest work.
3. **Recompute.** The SimScale runs still exist; the force CSVs can be re-fetched
   and the correct `TOTAL_FORCE_X` extracted for each. Most work, most correct.

**This is your call — it changes users' visible numbers, so I have not touched
it.**

---

## 13. Deployed inventory

### Supabase (`unwzwzzuzvqwkxdbxxpd`)
| Item | State |
|---|---|
| Edge functions | 6, all live: `submit-simulation-job`, `refund-job`, `create-paypal-order`, `capture-paypal-order`, `run-lap-calc`, `on-new-job` |
| JWT verification | on for all except `on-new-job`, which uses the shared-secret header instead |
| Migrations | 0001–0020 applied |
| RLS policies | 9 in `public` + 3 on `storage.objects` |
| Storage | bucket `cfd-files`, private, 50 MB file limit |
| Secrets set | `DISCORD_WEBHOOK_URL`, `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` |
| Secrets missing | `GCP_SA_KEY` (see §14), optionally `WEBHOOK_SECRET` to rotate the baked-in one |
| Extensions | `pg_net` enabled (used by the webhook trigger) |

### Google Cloud (`turboflow-7b3ca`)
| Item | State |
|---|---|
| `turboflow-tessellate` (Cloud Run **service**) | live, 2 vCPU / 4 GiB, public with its own token auth. `https://turboflow-tessellate-659747979647.us-central1.run.app` |
| `simscale-job-supabase` (Cloud Run **job**) | live, 8 GiB / 4 vCPU, 2 h timeout, env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `SIMSCALE_API_KEY` |
| `simscale-job` (Cloud Run job) | **the original Firebase worker — untouched and still working** |
| Firebase functions | all 6 still deployed and serving the live Firebase app |

Nothing about the live Firebase app was modified. The two systems run side by
side; the Supabase one is simply not reachable by users until sign-in works.

### Current database contents
```
auth users          0        legacy_users      79   (2,457,168 credits parked)
profiles            0        claimed            0
jobs                0        legacy_jobs      234
projects            0        paypal_orders      0
```
Zero is correct — every test account created during the work was deleted.

---

## 14. What is blocked, and on what

### 14.1 Google sign-in — **blocks everything**
No user can sign in, so nothing in the browser has ever been exercised: the
workbench, the viewport, the shader, the charts and the backfill are all verified
only at the code and database level.

Both credentials already exist and were retrieved from the Identity Toolkit API:

```
client ID     659747979647-n5aqp6li9jngnjkpi4u4hi7qr0jcfpd5.apps.googleusercontent.com
client secret (removed 24 Sep 2026: read it in Google Cloud Console > APIs & Services > Credentials)
```

Two steps remain:

1. **Add the redirect URI** to that OAuth client — Google publishes **no API**
   for this, so it must be done in the Console:
   ```
   https://console.cloud.google.com/apis/credentials/oauthclient/659747979647-n5aqp6li9jngnjkpi4u4hi7qr0jcfpd5.apps.googleusercontent.com?project=turboflow-7b3ca
   ```
   → Authorized redirect URIs → **+ ADD URI** →
   `https://unwzwzzuzvqwkxdbxxpd.supabase.co/auth/v1/callback` → Save.
   Leave the existing URIs alone; they are what Firebase Auth uses.
2. **Enable the provider in Supabase** — Authentication → Providers → Google,
   paste both values. Then Authentication → **URL Configuration** → add your app
   origins to the redirect allow-list. *Do not skip this:* the workbench signs in
   with `redirectTo: location.href`, and Supabase silently refuses any URL that
   isn't allow-listed. This is the step that costs people an hour.

Also check **Audience → publishing status is "In production"**, not "Testing" —
in Testing, only listed test users can sign in, which would block all 79 accounts.

### 14.2 `GCP_SA_KEY` — queued runs never start
Without it `on-new-job` logs and skips the Cloud Run trigger, so `pending` jobs
sit forever. Needs a service account with `run.jobs.run`, key JSON pasted into
Supabase → Edge Functions → Secrets.

### 14.3 Rotate the SimScale API key
It was committed in source and is inside the old container image. Generate a new
one, then:
```powershell
gcloud run jobs update simscale-job-supabase --region us-central1 `
  --update-env-vars SIMSCALE_API_KEY=<new-key>
```

### 14.4 Fusion 360 plugin
Source is not in this folder. Two changes:
- **Storage:** upload to `jobs/<uid>/<jobId>/…` in the `cfd-files` bucket
- **Auth:** Firebase let a stored refresh token act as an API key; Supabase works
  the same way —
  `POST /auth/v1/token?grant_type=refresh_token` with the anon key as `apikey`,
  then `Authorization: Bearer <access_token>` on every call. `requireUser()`
  already accepts exactly that.
  **The difference that will bite:** Supabase *rotates* refresh tokens — every
  refresh returns a new one and retires the old, so the plugin must persist the
  new token each time or it locks itself out. Access tokens last an hour; refresh
  once per session, not per request.

### 14.5 Optional: a Supabase personal access token
An `sbp_…` token from Account → Access Tokens would let `deploy.ps1` and
`supabase secrets set` work from a terminal, and would allow the auth provider to
be configured over the Management API instead of by hand. Everything so far was
done via the Management API through MCP, SQL, and `gcloud`.

---

## 15. Tests

`powershell -File tests\run-all.ps1` (add `-Offline` to skip the two needing
network + credentials). Non-zero exit on failure, so it can gate a deploy.

```
lap-time physics       PASS  4 cases match the original Python to 1e-6 s
charts                 PASS  6 residual + 2 force series, log axis 1e0→1e-8
comparison deltas      PASS  both sign conventions
CAD edit operations    PASS  translate/scale/rotate/mirror/compose + 6 guards
results export         PASS  glb + field binaries from a SimScale-shaped package
SimScale plot export   PASS  parses the real run 376ccaaf
credits and PayPal     PASS  38 assertions on the live database
```

**Every suite reads the real shipping file** — by import or source-slice — so a
test can never quietly drift from the thing it tests. Two suites are regression
tests for bugs that were actually shipped (§9.1, §9.2), and one for a bug that
would have shipped (§9.3).

What the billing suite covers, on a throwaway account against the live database:
signup defaults, protected fields, the RPC lockdown from a real user session,
charging, **no partial charge on a failed submit**, sponsorship rates, unlimited
passes (including that they *stack* rather than reset), refund-once-only, the lap
calculator, and PayPal capture including replay and cross-account claims.

---

## 16. Conventions worth knowing

- **The frontend speaks camelCase, Postgres speaks snake_case.** Conversion
  happens at the boundary — in the shim and in the worker. `jsonb` columns pass
  through untouched.
- **STEP is the source of truth; `.glb` is only for looking at.**
- **Services holding the service-role key bypass RLS.** Every guarantee the
  policies provide — own-folder only, write-once — is restated inside those
  services, or routing a write through them launders the policy away.
- **Constrain what users control; truncate what you write yourself.** Client text
  has table constraints; the worker's `error` column does not, because a
  constraint that rejects a long traceback would stop a failing job from ever
  being marked failed.
- **Web jobs are `queued` and do not auto-run; only `pending` triggers the
  worker.** Inherited from Firebase deliberately.
- **`firestore.rules` is kept as the reference** for what the RLS policies had to
  reproduce. Do not delete it.
- **Pinned library versions are load-bearing.** Both containers pin versions that
  are now behind current. Bumping them is a real decision with real risk — two of
  the worst bugs in this project came from version differences.

---

## 17. Runbook

```powershell
# tests
powershell -File tests\run-all.ps1
powershell -File tests\run-all.ps1 -Offline

# reload the legacy staging tables (safe, skips claimed rows)
node supabase\_migrate\load_legacy.js

# apply migrations from disk
$env:PGHOST="<pooler>"; $env:PGUSER="<user>"; $env:PGPASSWORD="<pw>"
node supabase\_migrate\run.js

# edge functions (needs an sbp_ token)
$env:SUPABASE_ACCESS_TOKEN="sbp_..."
powershell -File supabase\_migrate\deploy.ps1

# cloud run — worker
gcloud builds submit "docker jobs" --tag gcr.io/turboflow-7b3ca/simscale-job-supabase
gcloud run jobs update simscale-job-supabase --region us-central1 `
  --image gcr.io/turboflow-7b3ca/simscale-job-supabase

# cloud run — CAD kernel
gcloud builds submit tessellate --tag gcr.io/turboflow-7b3ca/turboflow-tessellate
gcloud run deploy turboflow-tessellate --image gcr.io/turboflow-7b3ca/turboflow-tessellate `
  --region us-central1

# run one job by hand
gcloud run jobs execute simscale-job-supabase --region us-central1 `
  --update-env-vars JOB_ID=<uuid>

# worker logs
gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=simscale-job-supabase' `
  --limit 30 --freshness=1h --format="value(textPayload)"
```

### Secrets map
| Secret | Lives in | Notes |
|---|---|---|
| Supabase URL / anon / service-role | `.env.deploy` | anon is public by design |
| Postgres pooler creds | `.env.deploy` | used by `run.js` / `load_legacy.js` |
| `SIMSCALE_API_KEY` | `.env.deploy` + Cloud Run job env | **needs rotating** |
| PayPal live client + secret | `.env.deploy` + Supabase secrets | |
| Discord webhook | `.env.deploy` + Supabase secrets | |
| `x-webhook-secret` | baked into `on-new-job`, sent by the `0009` trigger | override with a `WEBHOOK_SECRET` function secret to rotate without redeploying |
| Google OAuth client + secret | see §14.1 | |

---

## 18. Recommended order of work

1. **Google sign-in** (§14.1) — unblocks all browser verification
2. **Sign in with an email from the legacy list** — one action that exercises the
   identity trigger, credit carry-over, job history, tree and viewport at once
3. **Rotate the SimScale key** (§14.3) — it is exposed today
4. **`GCP_SA_KEY`** (§14.2) — makes runs actually start
5. **A real end-to-end run** — submit, watch status move, confirm Discord, drag
   and lift, results in the viewport
6. **Decide on the historical drag** (§12)
7. **Fusion plugin** (§14.4)
8. **Storage plan** (§11) before this reaches many users

---

## 19. Honest status of what has and hasn't been seen working

| Component | Verified how |
|---|---|
| Edge functions | live HTTP: correct 401/403/200 |
| RLS + billing | 38 assertions against the live database |
| Webhook | real insert → `200 {"ok":true,"skipped":true}` in `net._http_response` |
| Tessellation | real STEP → real glTF, 3 s, read back through user RLS |
| Transform / edits | live: scale ×2 + rotate 90° + move gives exact dimensions |
| Legacy backfill | throwaway accounts, both paths, claimed 4242 credits + history |
| Lap-time physics | 1e-6 s against the original Python |
| Results export | synthetic package with real structure |
| Plot export | the real SimScale run `376ccaaf` |
| Worker | boots, connects, fails cleanly on a missing job |
| **Workbench UI** | **not seen in a browser** — syntax-checked and unit-tested only |
| **Full end-to-end run** | **never executed** — blocked on sign-in and `GCP_SA_KEY` |

The last two lines are the honest gap. Everything else has been exercised against
real infrastructure or real solver output.
