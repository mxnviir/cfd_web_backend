# 03. Architecture

This describes the system **as the code stands on 3 Oct 2026**: the new build in
this repo, running on Firebase and Google Cloud (project `turboflow-test`). The
planned move off Google Cloud is in [09-NO-CLOUD-PLAN.md](09-NO-CLOUD-PLAN.md).
Production still runs the original August app, which is described briefly at
the end.

## 1. The big picture

```
                        BROWSER
   site pages (/ /billing /simulations ...)   Garage (/dashboard)   Workbench (/workbench/...)
        |  Google sign-in (Firebase Auth, popup, falls back to redirect)
        |  Firestore listeners: live reads of the user's own documents
        |  a few direct Firestore writes that the rules allow (profile, simulation edits)
        |  Storage: one resumable upload to a path the server minted; downloads of models and results
        |  Callables: everything that costs money, starts work, or needs admin rights
        v
   CLOUD FUNCTIONS (31, Node 24, TypeScript, us-central1; storage triggers in the bucket's region)
        |                                   |                                   |
        | private HTTPS + Google ID token   | Cloud Run Jobs API "run"          | PayPal REST API
        v                                   v                                   v
   GEOMETRY SERVICE                    SIMSCALE WORKER                       PayPal
   Cloud Run service, Python,          Cloud Run job, Python, one
   OpenCascade via CadQuery            execution per run, up to 6 hours
   /inspect /prepare /measure                |
   /transform /tessellate                    | SimScale REST API v0 + Python SDK 9.2.0
        |                                    v
        |                                 SIMSCALE (mesh + solve, one account, one project)
        v                                    |
   FIREBASE STORAGE  <-----------------------+  results, logs, OpenFOAM case
   FIRESTORE         <-----------------------+  progress on jobs/{id} and runs/{id}

   FUSION 360 ADD-IN (desktop): exchangeFusionToken -> custom token -> Firebase sign-in
        -> uploads geometry.step + entity_labels.csv -> writes jobs/{id} as "pending"
```

The browser **never** talks to SimScale or holds its key. Cloud Functions never
wait on SimScale either; they are short (60 s by default) and the worker does
every SimScale call.

## 2. A Workbench run, from upload to result

### Step 1. Upload (free)

1. In the Workbench, **Import a car** opens `GeometryUpload.jsx`. Accepts `.step`,
   `.stp`, `.iges`, `.igs`, `.stl`, up to 50 MB in the browser (60 MB on the
   server). The user states the file's unit if it is STL.
2. The browser calls **`createUploadIntent`** with the name, size, extension,
   unit and group. The function checks the caller may add to that group, checks
   the 5 GiB storage quota, mints a geometry id, and writes
   `geometries/{gid}` with `status: "uploading"` **before any bytes move**. It
   returns the one path the Storage rules will accept:
   `users/{uid}/geometries/{gid}/raw.{ext}`.
3. The browser uploads the file straight to that path with a resumable upload and
   a real percentage. Storage rules allow it once (write-once), under 60 MB.

### Step 2. Import (free)

4. The Storage trigger **`onGeometryUploaded`** (deployed in the bucket's region)
   sees the file land, checks the path owner matches the document, moves the
   geometry to `queued`, and fires an authenticated request at
   **`processGeometry`** without waiting for it.
5. `processGeometry` (private HTTP function, 9 minute limit) sets
   `tessellating` and calls the geometry service **`/inspect`** with a Google ID
   token, passing the path and `on_behalf_of: uid`.
6. `/inspect` reads the CAD file with OpenCascade, turns the car to face the
   wind (along +x, axles along y), works out the unit, triangulates **face by
   face** so every triangle knows which face it belongs to, finds the wheels,
   measures the frontal area, counts slivers, and writes version 1:
   `v1/model.glb` (the 3D picture), `v1/faces.json` (every face with type, area,
   centre, normal, cylinder radius and axis, STEP entity id, adjacency),
   `v1/solids.json`, `v1/thumb.png`, and `v1/geometry.step` (always STEP, in
   metres, which is what SimScale will get).
7. `processGeometry` writes `versions.1` on the geometry document (`kind: "raw"`,
   paths, bbox, wheels, a proposed domain, frontal area, slivers) and sets
   `status: "ready"`. The Workbench is listening and shows the car.

### Step 3. Set up (free)

The Workbench sidebar (`Setup.jsx`) has four steps and a Quick setup button:

| Step | What the user chooses | Defaults |
|---|---|---|
| 1. Wheels | Auto-detect by radius (front and rear can differ), or pick faces; which wheels spin | radius 14.125 mm, tolerance 8%, all spin |
| 2. Wind tunnel | Half (mirror plane) or full width; distances upstream, downstream, side, top; moving road | half, 1.5 / 0.5 / 0.3 / 0.3 m, road moves |
| 3. Mesh | Fineness rung (draft 7, 8; priced 9.0 to 10.0) | 9.5 (level 3) |
| 4. Simulation | Air speed, iterations | 20 m/s, 1,000 |

8. **Build** calls **`prepareDomain`**, which checks the caller may edit the
   geometry, marks `domain_status: "preparing"`, and fires
   **`runPrepareDomain`** (private, 9 minutes).
9. `runPrepareDomain` calls the geometry service **`/prepare`** against the
   newest version that is a car (never a previous tunnel). `/prepare` finds the
   mirror plane, sizes the tunnel, cuts the car out (three strategies, volume
   checks), checks the result is a valid solid with no sliver voids, exports the
   flow region as STEP, labels every face (inlet, outlet, ground, top, side,
   symmetry, car, each wheel), measures the frontal area over the tunnel's own
   width, and writes the next version (`kind: "flow_domain"`) with its own
   model, face list, STEP and `entity_labels.csv`.
10. `runPrepareDomain` writes that version, makes it current, then builds a full
    SimScale setup with **`autoSpec()`** (boundary conditions, materials, wheel
    rotation from speed and radius, moving ground, force and coefficient result
    controls, reference area and length, moment centre on the mirror plane) and a
    mesh spec with **`meshSpecFor()`**, runs the checker, and writes or updates
    the `simulations/{sid}` document.
11. Edits after that (mesh fineness, iterations, or any panel) go through
    **`saveSimulation`** or a direct Firestore write. Either way
    **`onSimulationWritten`** re-runs the checker and stores `validation`
    (errors block a run, warnings do not). The client can never write
    `validation`.

The viewer shows **the car**, with the tunnel drawn as a translucent box from the
numbers. It never shows the car-shaped hole.

### Step 4. Queue (the only step that costs money)

12. The Queue dialog shows the price (from `src/lib/pricing.js`) and the balance,
    and disables Queue if the balance is short or the setup has errors.
13. **`queueRun`** re-checks the setup (it does not trust the stored validation),
    checks the caller may queue in that group (owner, or "edit" collaborator with
    its own hourly limit), works out the price from iterations and fineness, and
    **cuts the setup down to what was paid for** (`clampToPaidRun`: iterations,
    run time, refinements, layers, processors). Then it writes two documents:
    - `runs/{runId}`: what the Workbench watches. Status `queued`, the price, who
      queued it, and **snapshots of the setup** (`spec_snapshot`,
      `mesh_snapshot`), so a later edit cannot relabel an old result.
    - `jobs/{jobId}`: the money document, `status: "pending"`, `spec_mode: true`,
      `run_ref`, the STEP path and the four numbers the price is based on.
    `queueRun` does **not** charge.

### Step 5. Charge and dispatch

14. **`onJobPending`** fires on the transition *into* `pending` (never on a write
    that was already pending, or it would charge in a loop). It:
    - folds any camelCase field names into snake_case (for Fusion jobs);
    - checks the user exists;
    - applies the hourly run limit (30);
    - in one transaction: refuses if the ledger already shows a charge for this
      job, works out the charge with `chargeFor()`, refuses if the balance is
      short, writes the charge row and debits the balance, and stamps the
      clamped parameters and `cost` on the job;
    - starts the worker through the Cloud Run Jobs API with `JOB_ID`, and for a
      Workbench run `SPEC_MODE=1` and `RUN_ID`;
    - if the start fails, **reverses the charge** and marks the job failed;
    - sends a Discord message.

### Step 6. The worker (spec mode)

15. The worker (`services/simscale-job/simscale_job.py`, `run_spec_mode`) writes
    every stage to both the job and the run (`spec_mode.make_stage_writer`):

| Stage | What happens | Progress |
|---|---|---|
| `uploading_geometry` | Check the STEP path belongs to the owner, download it, upload to SimScale storage, start an import (unit metres) and wait | 5% |
| `processing` | Read SimScale's face names for the imported geometry and map each STEP entity id to them; read region names | 15% |
| (resolve) | Rewrite every face reference in the spec from browser face index to SimScale face name, put back type tags SimScale requires | |
| `creating_simulation` | `POST /simulations` with the resolved spec | 20% |
| `meshing` | Create and start the mesh operation from the resolved mesh spec, poll every 15 s with SimScale's own progress, save the mesh event log, attach the mesh, write `mesh_id` | 25 to 50% |
| `checking` | SimScale's own setup check (it refuses to check without a mesh, so this comes after meshing) | 48% |
| `running` | Create and start the run, write `run_id`, poll with progress, save the run log | 50 to 90% |
| `downloading_results` | Wait for result files, export the viewer files and the OpenFOAM case, export plots, double forces for a half model, summarise | 90% |
| `finished` | Write plots (at most 2,000 points per series), summary, result paths; job becomes `complete` | 100% |

    Cancel: at every poll the worker checks whether the job says `cancelling`,
    and if so cancels the SimScale operation and marks itself `cancelled`.

16. **Failures.** A setup the user can fix raises `SpecError` and the message is
    shown in their words. A mesh the mesher refuses raises `MeshingError` with
    advice about slivers. Anything else is "TurboFlow hit a fault of its own",
    with the technical text kept in `error_detail`. If the job fails **before
    `mesh_id` or `run_id` exists**, `onJobPending` reverses the whole charge and
    marks the run `refunded`.
17. **`onJobFinished`** mirrors the job's ending onto the run if the worker did
    not (a container that died, a dispatch that never started), and adds a
    notification to the user document (newest 50 kept).

### What a finished run holds

On `runs/{runId}`:
- `summary`: drag, lift, side force, roll, pitch, yaw, Cd, Cl, Cm, and `doubled`
  when it came from a half model.
- `plots`: `residuals`, `forces` (with pressure and viscous parts), `moments`,
  `coefficients`, each downsampled.
- `results_glb_path`, `results_fields`, `case_path` (the OpenFOAM case for
  ParaView), `log_paths` (mesh and run event logs), `simscale.*` ids,
  `clamped` notes, `refunded` if the charge was reversed.

**Drag** is the force along the wind (the first velocity inlet's direction), not
"minus Fx". **A half model** reports half the force; the worker doubles drag,
lift and pitch and zeroes side force, roll and yaw, which cancel between the two
halves of a symmetric car. Coefficients are not doubled (the reference area was
already halved).

## 3. A Fusion add-in run

1. The team creates a **connection token** on `/simulations` (`createFusionToken`:
   32 random bytes, prefix `tfk_`, stored only as a SHA-256 hash, shown once).
2. They paste it into the add-in. The add-in calls **`exchangeFusionToken`**
   (public, limited by IP, 120 an hour), which looks the hash up and returns a
   Firebase **custom token with a `fusion: true` claim**.
3. The add-in signs in with it, reads the user's credits (to warn early), builds
   the wind tunnel inside Fusion, exports `geometry.step` and
   `entity_labels.csv`, uploads both to `jobs/{jobId}/...` in Storage, and
   writes a `jobs/{jobId}` document in **camelCase** with `status: "pending"`.
4. `onJobPending` normalises the field names, charges, and starts the worker
   **without** spec mode.
5. The worker's older path (`main()` below the spec-mode branch) builds a
   SimScale model itself from the four numbers on the job and the labels file
   (`build_model`), runs mesh and solve through the SimScale Python SDK, and
   extracts drag and lift from the force plot (`extract_drag_lift`).

**Known fault:** on turboflow-test, add-in runs solve but SimScale offers no
downloadable result files for them, so they finish with no drag or lift. See
07-PROBLEMS.md.

A session made from a connection token is refused by anything marked
`humanOnly` (buying credits, creating or revoking tokens, deleting, copying,
sharing, `ensureAccount`) and by the `human()` check in the delete rules.

## 4. The data model (Firestore)

Everything is snake_case. Every collection is top-level.

| Collection | One document is | Written by | Key fields |
|---|---|---|---|
| `users/{uid}` | An account | `ensureAccount` creates it; the owner may edit profile fields only | `email`, `name`, `team_name`, `credits`, `sponsored`, `sponsor_rate`, `usd_per_credit`, `unlimited_usd`, `unlimited_until`, `unlimited_started_at`, `storage_bytes`, `storage_quota_bytes`, `storage_over_quota`, `notifications[]`, `workbench_defaults`, `lap_calc_defaults`, `job_race_times`, `region`, `contact_email`, `email_verified`, `created_at`, `last_seen`. A user may change only `name`, `team_name`, `region`, `contact_email`, `lap_calc_defaults`, `job_race_times`, `last_seen` and `workbench_defaults`, and not from a connection-token session |
| `users/{uid}/transactions/{id}` | One ledger row | Backend only | `type` (`simulation_charge`, `simulation_charge_reversal`, `refund`, `purchase`, `unlimited_pass`, `signup_bonus`), `amount` (negative for money out), `reason`, `job_id`, `order_id`, `capture_id`, `timestamp`. Row ids are deterministic (`charge_{jobId}`, `reversal_{jobId}`, `refund_{jobId}`, `order_{orderId}`, `signup_bonus`) so a repeat cannot pay twice |
| `users/{uid}/fusion_tokens/{id}` | A token's public listing (no secret) | Backend only | `label`, `tail` (last 6 characters), `created_at`, `last_used_at` |
| `fusion_tokens/{sha256}` | A token's secret record | Backend only; no client access | `user_id`, `token_id`, `created_at`, `last_used_at` |
| `jobs/{jobId}` | The money document for one run | Created by `queueRun`, `submitJob` or the Fusion add-in; every status change after that by the backend or the worker | `user_id`, `status`, `source` (`workbench`, `web`, `fusion`), `spec_mode`, `run_ref`, `group_id`, `geometry_id`, `simulation_ref`, `step_path`, `label_path`, `iteration_count`, `refine_level`, `inlet_velocity`, `debug_mesh`, `fineness`, `mesh_cells_m`, `cost`, `charged_at`, `mesh_id`, `run_id`, `simulation_id`, `drag_n`, `lift_n`, `paraview_url`, `results_glb_path`, `results_fields`, `case_path`, `error`, `error_detail`, `cancelled_by` |
| `groups/{groupId}` | A group of simulations (replaced projects and folders on 12 Sep) | Callables; owner may update a few fields | `user_id`, `name`, `description`, `category`, `tags`, `unit_system`, `shared_with` (uid to `view` or `edit`), `shared_emails`, `counts`, `lock` (tab heartbeat), `thumbnail_path` |
| `geometries/{gid}` | One uploaded car and all its versions | `createUploadIntent`, `processGeometry`, `runPrepareDomain`; owner may rename | `user_id`, `group_id`, `name`, `format`, `input_unit`, `import_options`, `raw_path`, `size_bytes`, `status` (`uploading`, `queued`, `tessellating`, `ready`, `failed`), `error`, `current_version`, `versions` (map, below), `domain_status` (`preparing`, `ready`, `failed`), `domain_error`, `domain_options`, `prepared_by` |
| `geometries/{gid}/selections/{id}` | A saved face selection | Owner | `name`, `entity_type`, `step_ids` (max 5,000) |
| `simulations/{sid}` | One setup | `createSimulation`, `runPrepareDomain`, `saveSimulation`, direct owner writes | `user_id`, `group_id`, `geometry_id`, `geometry_version`, `name`, `analysis` (`INCOMPRESSIBLE`), `spec` (SimScale model JSON with browser face indices), `mesh_spec`, `primitives`, `validation` (`ok`, `errors`, `warnings`; server only), `setup_source` |
| `runs/{runId}` | One queued run, what the Workbench shows | `queueRun` creates it; worker and functions update it; no client writes | `user_id`, `group_id`, `simulation_id`, `simulation_name`, `geometry_id`, `geometry_version`, `name`, `status`, `stage_text`, `progress`, `credits`, `queued_by`, `job_id`, `spec_snapshot`, `mesh_snapshot`, `clamped`, `simscale`, `summary`, `plots`, `results_glb_path`, `results_fields`, `case_path`, `log_paths`, `error`, `error_detail`, `refunded`, `started_at`, `finished_at` |
| `runs/{runId}/post_states/{id}` | A saved post-processing view | Owner (bounded) | Planned for the post-processor, which was never built |
| `config/pricing` | Prices | Console only; anyone may read | `usdPer100Credits`, `currency`, `minCredits`, `maxCredits`, `unlimitedMonthlyUSD`, `unlimitedDays`, `maxUnlimitedMonths`, `paypalClientId` |
| `paypal_orders/{orderId}` | What a buyer agreed to pay, before capture | `createPayPalOrder`; deleted when granted | `uid`, `kind`, `credits` or `days`/`months`, `amount_usd`, `currency`, `status`, `expire_at` (TTL) |
| `rate/{uid:action:window}` | A rate-limit counter | Backend and geometry service | `count`, `uid`, `action`, `expire_at` (TTL) |

### A geometry's versions

`versions` is a map from version number to what that version is. Each version
has its own folder `users/{uid}/geometries/{gid}/v{n}/`.

| Field | Meaning |
|---|---|
| `kind` | `raw` (the car, from `/inspect`) or `flow_domain` (a tunnel, from `/prepare`) |
| `glb_path`, `faces_path`, `solids_path`, `step_path`, `thumb_path`, `label_path` | The files in that version's folder |
| `bbox`, `unit`, `rotated_deg`, `reference_length_m` | Size and orientation |
| `wheels`, `car_wheels` | Wheels found, with names by position, radius, centre, face indices, `spin` |
| `domain`, `symmetry`, `symmetry_plane_y`, `symmetry_kind` | The tunnel walls in metres; half or full; where the mirror plane is and how sure |
| `labels`, `label_counts`, `missing_labels`, `unresolvable_faces` | Which faces are which wall |
| `frontal_area_m2`, `frontal_area_half_m2` | Reference area for coefficients |
| `slivers` | How much of the car is tiny fragments, and where |

A tunnel is a new version, so rebuilding a tunnel never changes what an earlier
run was solved against.

### Status lists

- **Job** (`functions/src/lib/types.ts`): `draft`, `pending`, `downloading`,
  `uploading_geometry`, `processing`, `creating_simulation`, `checking`,
  `meshing`, `running`, `downloading_results`, `complete`, `failed`,
  `cancelling`, `cancelled`.
- **Run**: `queued`, then the same working stages as the job, ending in
  `finished`, `failed` or `cancelled` (not `complete`).

## 5. Storage layout

```
users/{uid}/geometries/{gid}/raw.{step|stp|iges|igs|stl}   the upload; client writes once, < 60 MB
users/{uid}/geometries/{gid}/geometry.step                  Fusion-style STEP (older path)
users/{uid}/geometries/{gid}/entity_labels.csv              Fusion-style labels (older path)
users/{uid}/geometries/{gid}/v{n}/model.glb | faces.json | solids.json | thumb.png | geometry.step | entity_labels.csv
                                                            written by the geometry service
users/{uid}/results/{jobId}/...                             written by the worker: viewer files, fields,
                                                            OpenFOAM case, logs, face-name map
jobs/{jobId}/geometry.step, entity_labels.csv               the Fusion add-in's uploads: write-once, two
                                                            file names only, 60 MB; the owner cannot be
                                                            checked (the add-in uploads before the job
                                                            document exists), so first writer wins on a
                                                            random job id; client reads are denied in practice
results/{jobId}/...                                         old results location; now denied to everyone
```

The owner's uid **in the path** is the ownership check. Storage rules cannot look
things up in Firestore reliably in this project (an owner reading their own file
was denied), so every path a user may read carries their uid.

Results under `users/{uid}/results/` do **not** count towards the 5 GiB quota,
because they are paid for with a run and only the worker can write them.

## 6. Security model

**Rules of thumb in the code:**
1. Anything that decides money is written by the backend and denied to clients
   (`credits`, `cost`, ledger rows, `validation`, run status).
2. Every callable goes through `guard()`: signed in, rate limited, input parsed
   by a zod schema (unknown fields dropped).
3. Services that run with admin rights restate every check the rules make
   (ownership of paths, write-once), so routing a write through them cannot
   bypass the rules.
4. Connection-token sessions are worth less than a person: no money, no deleting,
   no sharing, no new tokens.

**Firestore rules (`firestore.rules`):** users may read their own account and
ledger and update only profile fields; create of accounts is denied (the server
does it). Jobs may be created only by their owner, in an unpaid state, with no
`cost`, pointing only at the owner's own paths; never updated or deleted by a
client. Groups readable by owner and members; geometries and simulations
readable by group members; simulations editable by owner or "edit" members
(not `validation`); runs read-only; tokens, PayPal orders and rate counters
fully closed; everything else denied. Free text is length-capped and maps are
key-capped.

**Storage rules (`storage.rules`):** described in section 5.

**Rate limits** (`functions/src/lib/ratelimit.ts`, per user per hour unless
noted): see 05-BACKEND-REFERENCE.md. Counters live in the `rate` collection and
expire through a TTL policy.

**Service identities (test, since 15 Sep):** `tf-geometry` runs the geometry
service (Firestore, logging, bucket objects), `tf-worker` runs the worker (the
same plus the SimScale secret only), the default compute account runs the
functions (with `run.jobsExecutorWithOverrides` and bucket-scoped object admin
instead of project-wide roles).

**Website headers (`firebase.json`):** enforced Content-Security-Policy (with a
hash for the one inline theme script), nosniff, Referrer-Policy, X-Frame-Options,
Permissions-Policy. Source maps are off.

## 7. Money model

- **One writer.** `functions/src/lib/ledger.ts` is the only code that changes a
  balance. It always writes a ledger row in the same transaction.
- **Charge once.** A job is charged in `onJobPending` only on the transition
  into `pending`, and only if the ledger shows no charge for it yet.
- **Refunds come from the ledger,** never from the job. A forged job has no
  charge row and refunds zero.
- **Three kinds of money back:** `refund` (the user cancelled before the solver
  ran), `simulation_charge_reversal` (TurboFlow failed before the solver ran),
  and nothing (the solver ran, the compute is spent).
- **Pay for what runs.** The setup sent to SimScale is clamped to the priced
  iterations and mesh at queue time.
- **Collaborators** with edit rights spend the owner's credits, at most 8 runs an
  hour each.
- **PayPal:** the client proposes a quantity; the server prices it, records the
  agreed amount in `paypal_orders`, captures server-side, checks the capture
  (not just the order) is COMPLETED and the amount matches, then grants inside a
  transaction that deletes the order (so the webhook and the capture cannot both
  grant). Only project `turboflow-7b3ca` can reach live PayPal.

## 8. Naming: snake_case and camelCase

| Layer | Spelling |
|---|---|
| Firestore documents | snake_case |
| Site code (old compiled views) | camelCase; `src/lib/firebase.js` converts **top-level keys only** on every read and write (`drag_n` to `drag_N` and back are special-cased) |
| Workbench code | reads camelCase top-level keys through the same layer; nested maps (`versions`, `summary`, `spec`) keep the writer's spelling |
| Fusion add-in | writes camelCase; `onJobPending` renames it once (`lib/normalize.ts`) |
| SimScale worker | converts the job to camelCase on read, writes snake_case |
| SimScale JSON (`spec`, `mesh_spec`) | SimScale's own camelCase, untouched |

This split has caused several silent bugs (a field read under the wrong name
shows an empty panel, not an error). `tests/test_run_fields.mjs` checks that
every run field the UI reads is written by someone.

## 9. How a face is named

A face has three names:

| Where | Name | Example |
|---|---|---|
| The browser | its index in `faces.json` | 12 |
| The STEP file | its entity number | #4711 |
| SimScale | the name SimScale invents on import | B1_TE12 |

Only the STEP entity number is shared by all three. The geometry service records
it for every face (`match_step_ids`, by matching corner points between OCC's
faces and the exported STEP text). The worker reads SimScale's mapping from
entity number to its names after import (`fetch_step_id_to_names`) and rewrites
the spec. Guessing by face order would put the inlet on the car's underside.

## 10. Front-end structure

- **Vite multi-page build** (`vite.config.js`): 15 HTML entries, shared chunks for
  React, Firebase and three.js, so moving between pages reloads only the small
  page chunk. `scripts/prerender.mjs` renders the signed-out pages into the HTML at
  build time so the source is not empty.
- **Theme**: dark default, a designed light theme, System / Light / Dark switch.
  An inline script in each page's `<head>` stamps the theme before first paint;
  its SHA-256 hash is pinned in the CSP (so the pages must keep LF line endings).
- **`src/Shell.jsx`**: the marketing chrome (header, sidebar, credit balance,
  sign-in dialog, footer). It loads Firebase lazily and calls `ensureAccount`
  after sign-in.
- **Garage** (`src/dashboard/`): its own chrome, one row per group.
- **Workbench** (`src/workbench/`): its own chrome; **the URL is the selection**
  (`route.js`), so reload and back work; one live listener per collection
  (`data.js`); every panel edits a **draft** saved only by the tick or Enter
  (`useDraft.js`), and leaving a panel saves a valid draft or refuses to leave;
  the 3D engine is a class (`viewer/engine.js`, three.js plus a BVH for fast
  picking), draws only when something changes, and is lazy-loaded.

## 11. Configuration per environment

| Setting | Where | Test | Production |
|---|---|---|---|
| Firebase web config | `env/firebase/config.*.js` at the repo root, synced to `public/firebase-config.js` by `scripts/sync-env.mjs` | turboflow-test | turboflow-7b3ca |
| `BUCKET_REGION` | `env/functions/<project>.env`, synced into `functions/.env.<project>` at deploy | default us-east1 | us-central1 |
| `WORKER_JOB` | same | default `simscale-job` | `simscale-worker` |
| `PAYPAL_ENV` | same | ignored (sandbox forced) | `live` |
| Secrets | Secret Manager | `SIMSCALE_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID`, `DISCORD_WEBHOOK_URL` | same names |
| Worker env | Cloud Run job | `SIMSCALE_API_KEY`, `SIMSCALE_PROJECT_ID`, `STORAGE_BUCKET` | same |

Never open the `.env.*` files in chat output; they are not secret by design but
the habit protects the files that are.

## 12. Production today (the original app)

What turboflow.cloud actually runs (from the 24 Sep backup):
- One compiled single-page app, Tailwind from a CDN, the whole project folder
  deployed as the website (so `/functions/index.js` and other files are
  downloadable).
- Functions: `submitSimulationJob`, `onNewJob`, `refundJob` (Node),
  `createPayPalOrder`, `capturePayPalOrder` (Node), `run_lap_calc` (Python).
- Cloud Run: `turboflow-tessellate` (service), `simscale-job` (the original
  worker, with the SimScale key written into its code), `simscale-job-supabase`
  (from August).
- Added on 24 Sep, unused until a switch: `turboflow-geometry`, `simscale-worker`
  (v25), secrets, service accounts `tf-geometry` and `tf-worker`.
- All the security holes listed in `docs/PLAN.md` (refund forgery, open storage,
  refresh-token connection tokens, and so on) are still live there.
