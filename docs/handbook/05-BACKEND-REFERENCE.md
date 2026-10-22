# 05. Backend reference

Every Cloud Function, the geometry service, the SimScale worker, and the numbers
they enforce. Read with [03-ARCHITECTURE.md](03-ARCHITECTURE.md). All facts here
are from the code in `functions/src/` and `services/` as of 3 Oct 2026.

## How to read the tables

- **Callable**: called from the browser with `functions.httpsCallable(name)`.
  Goes through `guard()`: must be signed in, rate limited, input parsed by zod
  (unknown fields dropped). Errors come back as `HttpsError` with a sentence.
- **humanOnly**: refused for a session made from a Fusion connection token.
- **Trigger**: runs on a Firestore or Storage event; nobody calls it.
- **HTTP**: a URL. "Private" means only a Google identity with invoker rights
  (the functions' own account) can call it.

## Accounts

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `ensureAccount` | Callable, humanOnly | 30/h | Called by the site right after sign-in. If `users/{uid}` exists, returns. Otherwise reads the auth record; refuses anything that is not a Google account ("TurboFlow accounts are made with Google"). In a transaction, creates the user document (email, name, credits 50, `sponsored: false`, `sponsor_rate: 1`, `email_verified: true`) and the ledger row `signup_bonus`. Two tabs at once cannot reset a spent balance. |

## Groups

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `createGroup` | Callable | 30/h | New group: name (1 to 200), description (up to 2,000), category (fixed list, default `education`), tags (up to 12 of 3 to 50 characters), unit system (SI or IMPERIAL). Empty fields may arrive as null. |
| `updateGroup` | Callable | 120/h | Owner only. Writes only the fields given. |
| `deleteGroup` | Callable, humanOnly | 30/h | Owner only. Refuses while any run is still working ("Cancel running jobs first"). Deletes post states, saved selections, geometries, simulations and runs in batches of 400, then the files under the owner's geometry and results prefixes (old `results/` too), then the group. |
| `copyGroup` | Callable, humanOnly | 10/h | Owner only. New group, geometries and simulations with new ids and rewritten paths, runs not copied, files copied server-side. 300 s timeout. |
| `shareGroup` | Callable, humanOnly | 60/h | Owner only. Looks the email up. No account: returns `pending: true` and writes nothing (so it is not a cheap way to test whether an email has an account). Otherwise sets `shared_with.{uid}` to `view` or `edit` and remembers the typed email. |
| `unshareGroup` | Callable, humanOnly | shares the 60/h | Removes a member. |

"Not found" and "not yours" give the same answer on purpose, so a stranger
cannot tell whether a group id exists.

## Geometry

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `createUploadIntent` | Callable | 60/h | Checks the caller may add to the group (owner or edit), checks the 5 GiB quota, then mints a geometry id and writes the document **before** the upload. `kind: "raw"` (Workbench): extension required, 60 MB cap, writes `status: "uploading"`, format, unit (default mm), import options, `raw_path`, and only for a new geometry `current_version: 0` and empty `versions`. `kind: "step"` or `"labels"` (older path): records `step_path` or `label_path`. Returns the one path the rules accept. |
| `onGeometryUploaded` | Storage trigger (bucket region), **min 1 instance** | | For `users/{uid}/geometries/{gid}/raw.*` only. Checks the document exists, the owner matches the path, and the status is `uploading` (so a repeated event cannot queue twice). Sets `queued` and fires `processGeometry` without waiting. |
| `processGeometry` | HTTP, private, 540 s, 512 MiB, **min 1 instance** | | Sets `tessellating`, calls `/inspect`, writes `versions.{n}` (kind `raw`) and `status: "ready"`, or `failed` with the service's own message (first 300 characters). |
| `measureGeometry` | Callable | 300/h | Owner or any member. Two face indices on a version; calls `/measure`; returns the distance. |
| `prepareDomain` | Callable | 20/h | Owner or edit member. Geometry must be `ready` and not already preparing. Stores the options as `domain_options`, sets `domain_status: "preparing"`, fires `runPrepareDomain`. Options and defaults: half tunnel, 20 m/s, 1,000 iterations, fineness 9.5, upstream 1.5 m, downstream 0.5 m, side 0.3 m, top 0.3 m, wheel radius 14.125 mm (optional rear radius), tolerance 8%, spin all wheels, moving road, optional picked wheels. |
| `runPrepareDomain` | HTTP, private, 540 s, 512 MiB, **min 1 instance** | | Calls `/prepare` on the newest car version (never a tunnel), waiting up to 530 s of silence. Writes the tunnel as a new version and makes it current, then builds the automatic setup (`autoSpec`, `meshSpecFor`), checks it, and creates or updates the simulation (named after the car, made unique in the group). On failure: `domain_status: "failed"` and the service's message (600 characters). |

## Simulations

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `createSimulation` | Callable | 60/h | Owner or edit member of the group; the named geometry must be reachable. New document with the default model and mesh spec, named "Incompressible", "Incompressible 1", ... |
| `saveSimulation` | Callable | 600/h | Owner or edit member. Saves `spec`, `mesh_spec` and `primitives` (any of them), re-runs the checker against the stored parts for whatever was not sent, stores and returns `validation`. |
| `onSimulationWritten` | Firestore trigger | | Re-checks a simulation whenever `spec`, `mesh_spec` or `geometry_id` changed (not when only `validation` changed, or it would loop). |

**The checker** (`validateSetup`): errors for no geometry, no material, no
inlet, no outlet, a boundary condition with no faces, a face in two boundary
conditions, a face the current version does not have, fields that belong to
another SimScale solver (`orientationReference`, `fractionFromEnd`,
`exportStatistics`), and slivers under the small-feature tolerance; warnings for
judgement calls. A face list is read from the version's `faces.json`; if it
cannot be read, that check is skipped rather than failing the whole setup.

**The default mesh spec**: Simmetrix fluid mesher (`SIMMETRIX_MESHING_FLUID_V16`),
automatic sizing at fineness 9.5, automatic curvature, automatic boundary layers,
physics-based meshing, hex core, processors `-1` (SimScale chooses; 16 cores is
above this plan's limit), small-feature tolerance **2 mm**.

## Running and money

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `queueRun` | Callable | 30/h (`runJob`) | Owner, or edit member with its own limit of 8 an hour against that owner. Re-checks the setup; needs the current version's STEP; prices from end time and fineness; clamps the setup (`clampToPaidRun`); writes `runs/{id}` (queued) and `jobs/{id}` (pending, spec mode). Returns run id, job id, price, list price. Does not charge. |
| `onJobPending` | Firestore trigger on `jobs/{id}` | 30/h (`runJob`) | (1) A job that becomes `failed` with no `mesh_id` and no `run_id`: reverse whatever the ledger says is outstanding, mark the run `refunded`. (2) A job that **becomes** `pending`: rename camelCase fields, check the user exists (uid at least 10 characters), check the hourly run limit, charge in a transaction (refuse if already charged, refuse if the balance is short), stamp the clamped parameters and `cost`, start the worker (spec mode if `spec_mode`), reverse and fail if the start fails, then post to Discord. |
| `dispatchWorker` | (helper) | | `POST https://{region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/{project}/jobs/{WORKER_JOB}:run` with env overrides `JOB_ID` (and `SPEC_MODE`, `RUN_ID`). |
| `cancelRun` | Callable | 30/h (`refundJob`) | Owner or edit member. Only while the run is still working. Writes `cancelling` on the job and the run; the worker does the rest at its next poll. Does not move credits itself. |
| `refundJob` | Callable | 30/h | Owner only. Allowed while the job is `draft`, `pending` (becomes `cancelled`) or `downloading`, `uploading_geometry`, `processing`, `creating_simulation`, `meshing` (becomes `cancelling`). Refunds exactly what the ledger says is outstanding. Never deletes the job. |
| `onJobFinished` | Firestore trigger on `jobs/{id}` | | When a job reaches `complete`, `failed` or `cancelled`: if its run is not already in an end state, set it (`finished`, `failed`, `cancelled`) with the error; then add a notification (newest 50 kept). |
| `submitJob` | Callable | 30/h | Older web route. Resolves STEP and label paths from a geometry the caller owns. With both files the job is `pending` (charged by `onJobPending`); without, `draft`. Clamps parameters, stores the setup snapshot (256 KB cap). |
| `startJob` | Callable | shares 30/h | Moves a `draft` job with both files to `pending`. |

### When credits come back

| What happened | Credits |
|---|---|
| Cancelled before the worker picked it up (`draft`, `pending`) | All back (`refund`) |
| Cancelled while uploading, reading the geometry, creating the simulation or meshing | All back (`refund`), worker winds SimScale down |
| Cancelled once the solver is running | Not refundable through `refundJob`; `cancelRun` stops it, the charge stands |
| The worker could not start | All back (`simulation_charge_reversal`) |
| Failed before a mesh existed (bad setup, mesh refused, import refused, our own bug before meshing) | All back (`simulation_charge_reversal`) |
| Failed after `mesh_id` was written (for example SimScale's setup check, which comes after meshing, or a crash during the solve) | Charge stands |
| Finished | Charge stands |

## Payments

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `createPayPalOrder` | Callable, humanOnly | 20/h | Client sends `{product: "credits", credits}` or `{product: "unlimited", months}`. Server prices it (per-user rates override `config/pricing`), opens a PayPal order with `intent: CAPTURE` and `custom_id: uid`, stores what was agreed in `paypal_orders/{orderId}` with a 3-hour expiry. |
| `capturePayPalOrder` | Callable, humanOnly | 40/h | The order must be the caller's. Captures at PayPal (handles "already captured" by re-reading the order), requires order **and capture** COMPLETED, requires amount and currency to match, then `applyPurchase`. |
| `paypalWebhook` | HTTP, public | 300/h per IP | Refuses requests without PayPal's headers, rate limits by IP, refuses if `PAYPAL_WEBHOOK_ID` is not set, verifies the signature with PayPal, acts only on `PAYMENT.CAPTURE.COMPLETED`, checks the amount against the stored order, then `applyPurchase`. Returns 500 on an internal fault so PayPal retries. |
| `applyPurchase` | (helper) | | In one transaction: if the order document is gone, someone already granted it, do nothing; otherwise add credits (`purchase`) or extend the unlimited pass (`unlimited_pass`, stacking on time left), write the ledger row `order_{orderId}`, delete the order. |

Only project `turboflow-7b3ca` with `PAYPAL_ENV=live` reaches live PayPal; every
other project is forced to sandbox even with live keys.

## Fusion connection tokens

| Function | Kind | Limit | What it does |
|---|---|---|---|
| `createFusionToken` | Callable, refuses token sessions | 20/h | Mints `tfk_` + 32 random bytes; stores the SHA-256 hash in `fusion_tokens/{hash}` and a listing (label, last 6 characters) under the user. Returns the token once. |
| `revokeFusionToken` | Callable, humanOnly | shares 20/h | Deletes the secret record and the listing. |
| `exchangeFusionToken` | HTTP, public | 120/h per IP | Looks the hash up; unknown tokens get the same 401 as malformed ones. Returns a custom token with `fusion: true` and `fusion_token_id`, and records `last_used_at`. |

## Storage quota

| Function | Kind | What it does |
|---|---|---|
| `onStorageWrite` | Storage trigger | Adds the file's size to `users/{uid}.storage_bytes` (results under `users/{uid}/results/` are not counted). If over the quota (5 GiB, or `storage_quota_bytes`), deletes the file if it was a client upload, or only flags `storage_over_quota` if a service wrote it. |
| `onStorageDelete` | Storage trigger | Subtracts the size; clears the flag when back under. |

## Rate limits in one table

Per user per hour unless stated. Counters in `rate/{key}` with `expire_at` (a
TTL policy must exist on the project or the collection grows forever; set on
turboflow-test 23 Sep, not on production).

| Key | Limit | Used by |
|---|---|---|
| `submitJob` | 30 | `submitJob`, `startJob` |
| `runJob` | 30 | `queueRun` **and** `onJobPending` (so a Workbench run counts twice; see 07-PROBLEMS.md) |
| `refundJob` | 30 | `refundJob`, `cancelRun` |
| `collaboratorRun` | 8 per owner and collaborator | `queueRun` by a non-owner |
| `createPayPalOrder` | 20 | |
| `capturePayPalOrder` | 40 | |
| `createUploadIntent` | 60 | |
| `createGroup` | 30 | |
| `updateGroup` | 120 | |
| `deleteGroup` | 30 | |
| `copyGroup` | 10 | |
| `shareGroup` | 60 | `shareGroup`, `unshareGroup` |
| `createSimulation` | 60 | |
| `saveSimulation` | 600 | |
| `measureGeometry` | 300 | |
| `prepareDomain` | 20 | |
| `fusionToken` | 20 | create and revoke |
| `ensureAccount` | 30 | |
| `exchangeFusionToken` | 120 per IP | |
| `paypalWebhook` | 300 per IP | |

The geometry service keeps its own counters in the same collection: `prepare`
25, `inspect` 80, `tessellate` 80, `transform` 80, `measure` 300 per hour.

## Prices and limits in one table

| Thing | Value | Where |
|---|---|---|
| Iterations | 1 to 3,000, default 1,000 | `lib/pricing.ts` |
| Mesh level | 1 to 5, default 3 | same |
| Fineness per level | 9.0, 9.2, 9.5, 9.7, 10.0 | same |
| Draft fineness rungs | 7 and 8, priced as level 1 | `src/lib/pricing.js` |
| Air speed | 1 to 100 m/s, default 20 | same |
| Price per 1,000 iterations | 100 + (level - 1) x 25 credits | same |
| Debug mesh | 1 credit per 1,000 iterations | same |
| Sign-up bonus | 50 credits | `users/onUserCreate.ts` |
| Credits per dollar | 100 credits = $5 by default | `paypal/client.ts`, `config/pricing` |
| Order size | 100 to 20,000 credits | same |
| Unlimited pass | $100 per 30 days, up to 24 months | same |
| Raw upload | 60 MB server, 50 MB in the Workbench dialog and the geometry service | `createUploadIntent.ts`, `GeometryUpload.jsx`, `main.py` |
| Storage per account | 5 GiB, results excluded | `storage/quota.ts` |
| Setup snapshot | 256 KB | `lib/schema.ts` |
| Worker run time | 6 hours | `MAX_RUN_SECONDS` |
| Result package download | 6 GB abort | `MAX_PACKAGE_BYTES` |
| Viewer surface | 300,000 triangles | `MAX_VIEWER_TRIANGLES` |
| Clamp: run time | 21,600 s | `simulations/clamp.ts` |
| Clamp: refinements | 60, at most 0.5 finer than the tunnel | same |
| Clamp: boundary layers | 10 | same |
| Car size accepted | 0.10 to 0.60 m long | `main.py` `CAR_MIN_M`, `CAR_MAX_M` |

## The geometry service — deleted

`services/tessellate/main.py` (the `turboflow-tessellate` Cloud Run service)
was removed on 22 Oct 2026. Geometry — inspection, tunnel building, the cut,
the STEP export — runs in the visitor's browser now: `src/workbench/geometry/`
(04-CODE-MAP documents it). The full endpoint reference lives in git history.

## The SimScale worker (`services/simscale-job/`)

**Started by** `onJobPending` through the Cloud Run Jobs API, one execution per
job, with `JOB_ID`, and `SPEC_MODE=1` plus `RUN_ID` for a Workbench run.

**Needs** `SIMSCALE_API_KEY`, `SIMSCALE_PROJECT_ID` and `STORAGE_BUCKET`; refuses
to start without them and fails the job with a clear message.

**Spec mode** (Workbench): the stage table in 03-ARCHITECTURE.md section 2. Key
points:
- the STEP is always uploaded with unit **metres**, because the geometry
  service writes metres;
- face references are rewritten from browser indices to SimScale names through
  the STEP entity ids; an id SimScale did not keep (it drops zero-area faces) is
  handled, an unknown one fails the run with a sentence;
- SimScale needs type tags the Workbench used to omit (`COMPONENT` on vectors);
  `add_missing_discriminators` puts them back;
- the setup check runs after meshing because SimScale will not check a
  simulation with no mesh;
- results: forces, moments and coefficients are matched by **category**
  (`FORCE_PLOT`, `MOMENT_PLOT`, ...), never by name; drag is along the inlet
  direction; a half model is doubled; anything after the solve that fails in our
  own code is logged and does not fail the paid run.

**Label mode** (Fusion): downloads `geometry.step` and `entity_labels.csv`,
uploads to SimScale through the SDK, maps labels to SimScale face names, builds
the model (`build_model`: k-omega SST, velocity inlet at `-inlet_velocity` in x,
pressure outlet, slip or moving walls, rotating wheels at speed / radius, forces
and coefficients result controls), creates the mesh (fineness from the level,
2 mm small-feature tolerance), runs, waits for result files, extracts drag and
lift from the force plot, gets the ParaView download link, exports viewer files.

**Results written** (both modes, under `users/{uid}/results/{jobId}/`): the
viewer surface `results.glb`, one raw float32 file per field per vertex
(`fields/p.bin`, `U` as magnitude, `k`, `omega`, `nut`), `fields.json`, the
OpenFOAM case for ParaView, the mesh and run event logs, the face-name map.

## Rules summary

Firestore and Storage rules are summarised in 03-ARCHITECTURE.md sections 5 and
6, and fully commented in `firestore.rules` and `storage.rules`. The suites
`tests/test_security.mjs` and `tests/test_storage_rules.mjs` pin them down.
