# TurboFlow — Firebase → Supabase Migration

Status doc. Everything done, everything left, and how the pieces fit.

**Working copy:** `C:\Users\manvir\Downloads\cfd_web_supabase`
**Live Firebase (untouched):** project `turboflow-7b3ca`
**New Supabase project ref:** `unwzwzzuzvqwkxdbxxpd`

The original Firebase app has not been modified. All work is in the copy.

---

## 1. Architecture

| Concern | Before | After |
|---|---|---|
| Auth | Firebase Auth (Google) | Supabase Auth (Google OAuth) |
| Database | Firestore (documents) | Postgres (tables + RLS) |
| Server logic | Cloud Functions (Node) | Supabase Edge Functions (Deno/TS) |
| File storage | Firebase Storage | Supabase Storage, bucket `cfd-files` |
| CFD worker | Google Cloud Run | **unchanged** — still Cloud Run, now talks to Supabase |
| Live updates | Firestore listeners | Supabase Realtime (`postgres_changes`) |

Naming: the frontend and Firestore use **camelCase**; Postgres uses **snake_case**. Conversion happens in the shim (frontend) and in the worker. `jsonb` columns pass through untouched.

---

## 2. Frontend

The app's compiled bundle has ~44 Firebase call sites. Rewriting them all was high-risk, so instead:

**`supabase-firebase-shim.js`** (new) implements the Firebase compat API on top of `supabase-js`. It exposes `window.firebase`, `db`, `auth`, and `functions`, so existing code runs unchanged.

Covered:
- `collection().doc().get/set/update/delete/onSnapshot`
- Queries: `.where()`, `.limit()`, `.get()`, `.onSnapshot()`
- `FieldValue.increment()` and `serverTimestamp()`
- Firebase `Timestamp` emulation (`toMillis`/`toDate`/`seconds`) over Postgres ISO strings
- `batch()` writes
- `httpsCallable(...)` → `supabase.functions.invoke(...)`
- Google sign-in popup → `signInWithOAuth`
- Realtime listeners (initial fetch, then re-fetch on change)

**`index.html`** — the five Firebase SDK `<script>` tags were replaced with the supabase-js UMD bundle plus the shim. The inline init block was left as-is; it works through the shim.

**`app.compiled.js`** — only change is the three lap-calc URLs, repointed from the Cloud Functions endpoint to `.../functions/v1/run-lap-calc`.

---

## 3. Database

Migrations live in `supabase/migrations/`. Tables: `users`, `jobs`, `transactions`, `config`, `paypal_orders`, `legacy_users`.

- Row Level Security is on. Users read/write only their own rows; edge functions use the service-role key to bypass RLS where needed.
- `0005_realtime_and_config.sql` adds the four tables to the realtime publication and seeds `config/pricing`.
- Credit changes go through a Postgres function (`apply_new_job_charge`) so the balance check and the debit are atomic — no double-spend.

**Applied to the live database already.**

---

## 4. Edge Functions

In `supabase/functions/`. All share `_shared/util.ts` (CORS, JSON helper, admin client, `requireUser`).

| Function | Purpose |
|---|---|
| `submit-simulation-job` | Validates + prices a job, charges credits, inserts the row |
| `refund-job` | Refunds credits for a failed/cancelled job |
| `create-paypal-order` | Opens a PayPal order (live) |
| `capture-paypal-order` | Captures payment, grants credits |
| `on-new-job` | Fires on job INSERT — Discord ping, then triggers Cloud Run |
| `run-lap-calc` | Lap-time physics, 10 credits a run (refunded if the sim errors) |

`_shared/gcp.ts` mints a Google OAuth token (RS256 service-account JWT) so `on-new-job` can start the Cloud Run job.

**All six are deployed and live.** `on-new-job` is deployed with **Verify JWT off** — the database webhook calls it without a user token. The other five reject unauthenticated calls at the gateway.

Because it has to accept unauthenticated POSTs, `on-new-job` is the one publicly callable endpoint, and it acts on the `user_id`/`status` in the payload it is handed — the Firebase original was an internal Firestore trigger and had no such surface. It now rejects anything without the right shared secret:

```
x-webhook-secret: <the WEBHOOK_SECRET value, from Secret Manager>
```

Add that as a custom HTTP header when creating the webhook (section 8). The value is baked into the function as a fallback; set a `WEBHOOK_SECRET` function secret to rotate it without redeploying.

The Discord ping now fires only for `queued` / `pending` jobs. Otherwise the first-login job-history backfill would ping once per imported job — up to 100+ pings for a single user signing in.

Job flow note, carried over from the original: web-submitted jobs are created as `queued` and are **not** auto-sent to Cloud Run. Only Fusion-plugin jobs (`pending`) trigger the worker. This matches the original Firebase behaviour exactly.

---

## 5. CFD Worker

`docker jobs/simscale_job.py` — still runs on Cloud Run, still uses SimScale. Changes:

- `firebase-admin` / `google-cloud-*` replaced with `supabase` (see `requirements.txt`)
- Reads the job row from Postgres, converts snake_case → camelCase so the rest of the script is untouched
- Status writes convert camelCase → snake_case
- Downloads input files from Supabase Storage
- **New:** a `finally` block deletes the input STEP/CSV files after each run

That cleanup matters — the free tier is 1 GB. Inputs are only needed to seed SimScale, which then holds the geometry itself; results are served from SimScale via `paraviewUrl`. Without it you'd fill the quota.

Needs these env vars set on Cloud Run: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET=cfd-files`.

---

## 6. Data export (done, not yet imported)

Pulled read-only from live Firestore into `_fbexport/` via `_fbexport/pull.py`. Nothing in Firebase was modified.

| Collection | Rows |
|---|---|
| `users` | 79 |
| `jobs` | 234 |
| `transactions` | 1 |
| `config` | 0 (pricing is seeded by migration instead) |

Job statuses: 93 complete, 95 failed, 20 cancelled, 18 running, 6 meshing, 2 cancelling.

User fields map cleanly: `credits`, `teamName`, `email`, `name`, `createdAt`, `lastSeen`, `usdPerCredit`, `unlimitedUsd`, plus optional `unlimitedUntil`, `lapCalcDefaults`, `jobRaceTimes`, `sponsored`.

**Loaded, and it carries over automatically.** Supabase mints a new uuid at first Google sign-in, so the old Firebase UIDs are dead keys and email is the only stable link — but the Supabase id doesn't exist until the person actually logs in. So the 79 profiles sit in `public.legacy_users` (keyed by lower-cased email, 2,457,168 credits parked), and the existing `on_auth_user_created` trigger merges the matching row into `public.users` at first sign-in, then stamps `claimed_at`. Nobody is pre-created, no identity-linking guesswork, and users who never return cost nothing.

Reload or refresh the staging table any time with `node supabase/_migrate/load_legacy.js` — already-claimed rows are left alone.

Verified on the live project with two throwaway accounts (with and without a legacy row) and cleaned up afterwards: credits, team, pricing overrides, `lapCalcDefaults` and `createdAt` all carry across; a brand-new email still gets the old default of 50 credits.

**Job history rides along.** All 234 jobs are parked in `public.legacy_jobs` (10 distinct owners, every job matched to an exported user — no orphans) and the same trigger inserts them right after the profile row. The Firestore doc ids are already uuids, so they carry over as `jobs.id` unchanged; `domain_*`, `faceCount`, `wheelCount`, `surfaceRefinement` and `bucket` have no columns in the schema and stay in `data`.

The 26 jobs that were still mid-pipeline when Firebase was frozen (18 `running`, 6 `meshing`, 2 `cancelling`) land as `failed` with an explanatory `error`. They will never resume, a `running` row would spin in the dashboard forever, and `meshing` sits in `refund_job`'s refundable list — imported as-is, anyone could refund a four-month-old dead job for real credits. `complete` / `failed` / `cancelled` (208 of them) carry over untouched.

The single exported transaction is **not** imported: it has no `userId` and no amount (`{"type":"credit","reason":"Initial Account Setup","number":0}`), so there is nothing to attribute it to.

---

## 7. Secrets

All values live in `.env.deploy` (gitignored). Not duplicated here on purpose.

Already set on Supabase: `DISCORD_WEBHOOK_URL`, `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do not set them manually.

Still to add if you want the Cloud Run trigger to work: `GCP_SA_KEY` (service-account JSON with `run.jobs.run`). Without it `on-new-job` logs and skips the trigger; jobs stay `pending`.

---

## 8. What's left

Only two things are left that need a human, and both need credentials that live behind a login:

1. **Google sign-in** — Supabase → Authentication → Providers → Google → client ID + secret, then add the redirect `https://unwzwzzuzvqwkxdbxxpd.supabase.co/auth/v1/callback` in Google Cloud Console. **Nothing else can be tested until this is on** — no user can sign in, so no profile, no credits, no job.
2. **Fusion plugin** — repoint at Supabase Storage and Supabase Auth (see section 9). The plugin source isn't in this folder.

Optional, and not on the critical path:

3. **`GCP_SA_KEY` secret** — only matters for Fusion `pending` jobs, which can't exist until the plugin is ported. Without it `on-new-job` logs and skips the Cloud Run trigger. Needs a service-account key with `run.jobs.run`, pasted into Supabase → Edge Functions → Secrets.
4. **A Supabase personal access token** (`sbp_…`, from Account → Access Tokens) if you want `deploy.ps1` and `supabase secrets set` to work from a terminal. Everything so far went in over the Management API and SQL instead.

Then: **end-to-end test** — sign in, confirm the old credit balance and job history land, buy credits, submit a job, confirm the Discord ping and status updates.

### Already done for you

- The **database webhook** is migration `0009_jobs_webhook.sql`, not a dashboard click — the dashboard's webhook UI just writes a `pg_net` trigger, so it's written down where it can be reviewed and re-applied. It fires only for `queued`/`pending` rows and sends the shared secret header. Verified live: a test insert returned `200 {"ok":true,"skipped":true}` from `net._http_response`.
- **Storage policy** — `0010_storage_policy.sql`. The `cfd-files` bucket had RLS on and no policies at all, so nothing but the service role could write to it. The web app never touches Storage (checked), so this only unblocks the Fusion plugin: insert-only, under `jobs/`, no read, no overwrite, no delete.

---

## 8b. Security audit

Audited the migrated schema against the original `firestore.rules`, then pen-tested it with a real signed-in JWT. Fixes are migrations `0011`–`0014`.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Every billing RPC was callable from the browser.** Postgres grants `EXECUTE` to `PUBLIC` and PostgREST publishes `public` functions at `/rest/v1/rpc/…`. With only the anon key that ships in the page: `lap_calc_refund {p_uid:self}` = **+10 credits on repeat, forever**; `lap_calc_charge {p_uid:victim}` drains someone else's balance; `apply_new_job_charge` reassigns another team's job (`user_id = p_uid`) to yourself. | **Critical** | Fixed (`0014`) — revoked from `public`/`anon`/`authenticated`, plus `alter default privileges` so new functions start locked. Verified: anon → 401, service role still executes. |
| 2 | **Credit/history takeover by email.** The first-login backfill matched on email alone. Firebase only ever issued Google identities; Supabase also ships email/password signup, so signing up with a known team's address inherited their credits and runs. | **High** | Fixed (`0011`, `0012`) — the claim now hangs off an `auth.identities` insert with `provider = 'google'`. Verified both ways: password signup gets 50 credits and claims nothing; Google identity claims 4242 credits + history. |
| 3 | **Cross-tenant geometry.** Clients may insert their own `pending` jobs (parity with `validPendingJobCreate`), and nothing constrained `step_path`/`label_path` — a user could point a job at another team's STEP file, get their drag/lift and ParaView link back, and the worker's cleanup block would then delete that team's inputs. | **High** | Fixed (`0011`) — paths pinned to `jobs/<uid>/…` in both the jobs insert policy and the Storage policy. Verified: 403. |
| 4 | **Live SimScale API key hardcoded** in `simscale_job.py` as a default. It is in the repo, in the old container image, and still valid. | **High** | Removed from source; the worker now requires `SIMSCALE_API_KEY` from the environment (set on Cloud Run). **You must rotate the key** — it has been exposed. |
| 5 | `on-new-job` publicly callable with no auth. | Medium | Fixed earlier — shared-secret header (section 4). |
| 6 | Three helper functions had a mutable `search_path`. | Low | Fixed (`0014`). |

Confirmed **not** vulnerable, by testing with a live user token: a user cannot grant themselves credits or change their own pricing (`enforce_protected_user_fields` holds — only `name`, `team_name`, `region`, `contact_email`, `lap_calc_defaults`, `job_race_times`, `last_seen` are writable); cannot read another user's rows; cannot insert a job as another user; cannot see `paypal_orders`, `legacy_users` or `legacy_jobs` at all.

One fix caused a second bug worth recording: `enforce_protected_user_fields` exempted only `auth.role() = 'service_role'`, which a `SECURITY DEFINER` **trigger** is not, so the legacy claim had its credits silently reverted to 50. `0013` exempts internal contexts (no end-user JWT) as well.

---

## 8c. Workbench (in progress)

New work, not part of the Firebase migration: a SimScale-style workspace of our own.

- `0015_workbench_schema.sql` — `projects`, `geometries`, `simulations`, all with owner-only RLS and realtime. `public.jobs` gains `project_id` / `simulation_ref` and keeps being the *run*, which is what it already was. Existing jobs have both null and show up under "Unfiled".
- `workbench.html` — the whole workspace in one file, no framework:
  - **Tree** — projects → simulations → runs, live over Realtime. Runs that predate the workbench appear under "Unfiled".
  - **Viewport** — three.js, loads the `.glb` over a short-lived signed URL and auto-frames whatever size the car is. Result surfaces are coloured in a fragment shader from the field binaries, with a viridis ramp (perceptually uniform, and readable to colour-blind users, which the CFD-default rainbow is not) and a cutting plane on any axis.
  - **Setup panel** — inlet velocity, refinement, iterations, debug mesh, with the credit cost of the current settings shown before you commit.
  - **Geometry panel** — version badge, solids/faces/triangles/dimensions, and the edit controls described below.
  - **Runs / Convergence / Forces / Compare tabs** — residuals on a log axis, force history, and run-vs-run with percent deltas against a baseline (less drag reads green) plus overlaid drag traces.
  - **Automatic CFD** — pick a STEP (plus optional `entity_labels.csv`) → upload to `jobs/<uid>/<jobId>/` → create project + geometry + simulation → queue a `pending` job → tessellate for the preview. The run is queued *before* tessellation, so a kernel failure costs a preview and never a simulation.

  It reuses the shim's `window.sb`, so it shares the session with the main app, and `index.html` gains only a link — `app.compiled.js` is untouched.

- `tessellate/` — the CAD kernel, as a small Cloud Run HTTP service. A browser cannot triangulate a STEP file, so this reads the uploaded STEP from Storage with OCC (via CadQuery), writes a `.glb` beside it, and returns the bounding box, face and solid counts. It verifies the caller's Supabase token and refuses any path outside that user's own `jobs/<uid>/` folder. The workbench draws the `.glb` with three.js.
- `0016_geometry_tessellation.sql` — `glb_path`, `triangle_count`, `solid_count` on `geometries`, a `select` policy so a user can read their own files out of the private bucket, plus `derived_from` / `edit_ops` for the editing flow below.

### How an edited geometry gets simulated

Worth being precise about, because it decides the whole editing design: **SimScale meshes and solves the B-rep, not our triangles.** The `.glb` is display-only — pushing a modified triangle soup back would give SimScale nothing it can mesh cleanly.

So an edit made in the workbench never touches the `.glb`. It is recorded as an operation list (`geometries.edit_ops`: scale, translate, rotate, mirror, delete-solid) and replayed on the *original STEP* by the same OCC kernel that tessellated it. That produces a genuinely new STEP, which becomes a new `geometries` row with `derived_from` pointing at its parent — and from there the existing pipeline is unchanged: the worker uploads that STEP to SimScale, meshes, solves, returns drag/lift.

```
geometry.step ──OCC──> geometry.glb        (what you see and drag in the browser)
      │
      └── edit_ops ──OCC──> geometry_v2.step ──> SimScale ──> mesh ──> solve ──> drag/lift
```

The practical consequence: edits are limited to what a kernel can replay on a solid — moving and scaling parts, mirroring, deleting bodies, repositioning wheels. Freeform sculpting is not on the table, and SimScale's own workbench does not offer it either (it imports CAD and simplifies it; the modelling happens in Fusion).

### Results post-processing

`export_results_for_viewer()` in the worker turns a finished SimScale run into something the workbench can draw itself: `results.glb` (surface triangles), one `Float32` binary per field (`fields/p.bin`, `U`, `k`, `omega`, `nut`, `wallShearStress`) and a `fields.json` manifest of ranges. Paths land on the job row (`results_glb_path`, `results_fields`, migration `0017`). Fields live outside the glb so switching field re-uploads one attribute instead of refetching geometry, and colour is evaluated in a fragment shader.

Three facts measured against a real completed run, not assumed:

- A `SOLUTION_FIELD` package is **~1.7 GB** for one run.
- The download URL **does not honour Range requests** (`200`, no `Accept-Ranges`), so partial fetches are impossible — the whole archive has to come down.
- Extraction therefore streams to disk with a 6 GB abort, pulls out **one** surface entry rather than `extractall`, deletes the archive before VTK reads anything, and decimates to a 300k-triangle budget. The first version held the package in memory and would have been killed on its first real run — Cloud Run's `/tmp` is RAM-backed, so it was heading for ~1.5 GB on a 2 GiB job. The job is now 8 GiB / 4 vCPU.

Decimation is a visual change only: drag and lift come from the solver's force CSVs, never from this surface.

One trap worth knowing about, since it would have made the whole feature useless: `decimate()` discards every point array unless attributes are weighted in its error metric, and pyvista renamed that flag between 0.44 (pinned in the container) and 0.45 (what a dev machine gets today). Because solver meshes always exceed the triangle budget, *every* real run would have produced a `results.glb` with no fields attached — grey geometry, empty field list, nothing logged. The worker now asks for whichever flag name the installed build understands, and if the fields are lost anyway it keeps the full-resolution surface rather than uploading a result nobody can colour.

Consequence worth planning for: at roughly 10–20 MB of surface plus fields per run, Supabase's 1 GB free tier holds on the order of 50–100 runs.

### Geometry editing

`POST /transform` on the tessellation service applies an operation list to a STEP
and writes a **new** STEP and `.glb` beside it: `translate`, `scale`, `rotate`,
`mirror` — rigid transforms and uniform scale, the operations a kernel can replay
on a solid without repairing topology afterwards. The workbench records them in
`geometries.edit_ops` and links the new row to its parent with `derived_from`, so
a project keeps `v1 → v2 → v3` lineage and each version keeps its own runs.
Applying an edit branches a new simulation rather than mutating the current one —
overwriting the geometry a result was measured against would make the comparison
meaningless.

Two guards exist because this service holds the service-role key and therefore
**bypasses RLS**: any guarantee the storage policy provides has to be restated
here. The policy grants users `insert` and never `update`, so a version is
written once — the endpoint refuses a destination that already exists (409) and
uploads without `x-upsert`. It also re-checks the caller's token and refuses any
path outside their own `jobs/<uid>/` folder, for source and destination alike.

Two bugs worth recording, both found by running real geometry through the
deployed service rather than reading the code:

- **A scaled part reported 0.40077 m instead of 0.4 m.** `Shape.BoundingBox()`
  is not optimal on `cadquery 2.5.2`, which the container pins, but is on 2.8.0,
  which was installed locally — so it reproduced clean on the dev machine and
  wrong in production. That number sizes the wind tunnel around the car.
  `exact_bbox()` now measures with `BRepBndLib.AddOptimal_s`, which is exact on
  every version; `tests/test_transform.py` asserts exactness to 1e-9 across
  three scale factors.
- My first fix for it — reordering the measurement before meshing — was a guess
  and changed nothing. The live re-test caught that too.

### Design

The workbench does not use a CSS framework. It has a small token system (one spacing scale, one type scale, three greys, one accent) and hand-written components, which is both smaller than pulling Tailwind off a CDN and the reason it reads as a designed tool rather than a scaffold. Status pills animate only while a run is live; numbers are tabular-figure monospace so columns line up; the viewport is the focus and the chrome stays quiet.

Remaining gap: the queued run does not start until `GCP_SA_KEY` exists (section 8, item 3).

---

## 9. Known limitations

**Fusion 360 plugin still points at Firebase.** The plugin source is not in this folder — it's on your other setup. Until it's repointed, the worker won't find input files for Fusion-submitted jobs. Does not affect sign-in, credits, or payments. Two changes, both small:

- *Storage* — upload to the `cfd-files` bucket instead of Firebase Storage.
- *Auth* — Firebase let a stored refresh token act as an API key. Supabase works the same way: `POST /auth/v1/token?grant_type=refresh_token` with the anon key as `apikey`, then send `Authorization: Bearer <access_token>` (plus `apikey`) on every call. `requireUser()` already accepts exactly that. **The one difference that will bite:** Supabase *rotates* refresh tokens — every refresh returns a new one and retires the old, so the plugin must persist the new token each time or it locks itself out. Access tokens last an hour; refresh once per session, not per request.

**Lap-time calculator is fully ported.** The original physics were pulled from the deployed Firebase python function's source archive in GCS. `_shared/lapsim.ts` is a 1:1 port and `_shared/co2_thrust.ts` carries the CO2 thrust curve (the CSV the python loaded at cold start; the 1 ms time grid is regenerated rather than stored). `supabase/_migrate/test_lapsim.mjs` checks four cases plus the "car never finishes" path against values produced by the original python — run it with `node`.

---

## 10. Deploy command

From a terminal in the project folder:

```powershell
$env:SUPABASE_ACCESS_TOKEN="<token from .env.deploy>"
powershell -File supabase\_migrate\deploy.ps1
```

Sets the secrets and deploys all six functions, with the JWT flag handled for `on-new-job`. Requires Node.js installed.

Everything is already deployed — this is only for pushing later edits. It needs a personal access token (`sbp_…`, from Supabase → Account → Access Tokens); `.env.deploy` does not have one.
