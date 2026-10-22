# 07. Problems, risks and loose ends

Everything known to be wrong, unfinished or risky as of 3 Oct 2026, worst
first in each section. "Evidence" says how it is known. Items that could not be
checked from here are marked **UNVERIFIED**.

## A. Blocking

### A1. Google Cloud is off limits, and the product runs on it

- **What:** since 27 Sep no agent may touch Google Cloud. The new build's whole
  backend (functions, geometry service, worker, storage, database, hosting) is
  on Google Cloud. Nothing can be deployed or tested live.
- **Unknown state:** the owner was turning off or deleting services on
  turboflow-test to get a refund. Which ones are gone, and whether billing is
  still on, is **UNVERIFIED**.
- **If the services were deleted:** the code to rebuild them is all in the repo
  (`functions/src`, `services/tessellate`, `services/simscale-job`), and the
  database and files are separate from the services. Rebuilding would take about
  half an hour, but only when Google Cloud is allowed again.
- **Next:** the owner decides the platform (09-NO-CLOUD-PLAN.md).

### A2. Fusion add-in runs finish with no drag or lift (on the new backend)

- **What:** on turboflow-test, add-in runs mesh and solve, but SimScale offers no
  downloadable result for any result item of those runs:
  `availableExportFormats: []` and `download: null` on every item, at 100 and at
  1,000 iterations. So drag and lift are never read. Workbench runs in the
  **same SimScale project** export fine. **No add-in job on turboflow-test has
  ever had drag.** Production's old worker, with nearly the same code, does
  return drag.
- **Cost to a user:** they would be charged (150 credits at 1,000 iterations) for
  a run that shows no numbers.
- **Tried and failed:** worker v29 (wait for result files before reading) and v30
  (write forces every iteration).
- **Differences seen between an add-in run's setup and a Workbench run's:**
  residual targets 1e-5 against 1e-6; velocity solver SMOOTH against PBiCGStab;
  initial velocity 0 against -20 m/s; the add-in path creates the simulation and
  run through the SimScale Python SDK, the Workbench path through plain REST.
  Which of these matters is unknown.
- **Blocks:** moving Fusion users to the new backend.
- **Next (when allowed):** compare against production's SimScale project, where
  the old worker's runs do have results; try creating the add-in run through
  REST like spec mode does.

### A3. Production still runs the original app, with its holes

- The original app on turboflow.cloud still has every problem in
  `docs/PLAN.md`: forged refunds can mint credits, Storage lets any signed-in
  user overwrite others' files, the connection token is the account's refresh
  token, the 50 sign-up credits are farmable, there is no PayPal webhook, and the
  **website serves the backend source** (`/functions/index.js`,
  `.claude/settings.local.json`, a GitHub workflow, screenshots).
- The original worker on production has the **SimScale API key written into its
  code** (found in the 24 Sep backup).
- Google sign-in on production may still be broken by the Supabase redirect
  change found on 9 Sep. **UNVERIFIED.**
- 26 jobs on production have sat in `running`, `meshing` or `cancelling` for
  weeks.
- **Fix:** the production switch (`docs/PROD_CUTOVER.md`), which is on hold
  with Google Cloud.

### A4. The repo has no backup and most work is uncommitted

- Git: 47 commits, the last on 10 Sep. About **200 changed files are
  uncommitted**. There is **no remote**. This PC holds the only copy of almost
  everything built since 10 Sep.
- Two sessions edited the same files on 27 Sep; with no commits between them,
  there is no record of which change came from which.
- **Next:** copy `turboflow/` (about 35 MB without `node_modules`) to a USB stick
  or a private drive. Committing locally is safe and allowed; pushing is not,
  without the owner.

### A5. Always-on costs, and code that would bring them back

- On 27 Sep four services on turboflow-test kept one instance running all the
  time: `turboflow-tessellate` (4 vCPU, 8 GiB, about $79 a month) and
  `processGeometry`, `runPrepareDomain`, `onGeometryUploaded` (about $28
  together). At Cloud Run's idle rate of $0.0000025 per vCPU-second and per
  GiB-second.
- The code still says `minInstances: 1` in
  `functions/src/geometry/processGeometry.ts` (two places) and
  `functions/src/geometry/prepareDomain.ts`, so **any future deploy turns three
  of them back on**. Remove those lines before any deploy.
- `docs/PROD_CUTOVER.md` step 4 sets the production geometry service to min 1.
  That step must change too.
- No budget alerts and no billing export exist, so spend cannot be seen from the
  command line.
- About 33 GB of old container images on turboflow-test (about $3 a month).
- Other Google Cloud items found on 27 Sep: a Gemini project with billing on and
  two API keys (made in March and August); two empty billed projects
  (`turboflow-crm`, "My First Project"); an old Supabase-era job on production.

## B. Product bugs

| # | Problem | Evidence | Notes |
|---|---|---|---|
| B1 | `car(17.3).step` never meshes | Two runs on 27 Sep, same entity (B1_TE701), at fineness 9.5 and 8 | Slivers where its 9 solids join. A CAD fix, not a mesh setting. The Workbench warns about slivers, but the stricter warning (5 or more) is a **local change, not deployed** |
| B2 | Workbench run summaries did not show Cd | 27 Sep test-car run | Cause not investigated |
| B3 | A failed run keeps no event log (`log_paths` empty), so the "Event log" section is empty | 27 Sep failed runs | The mesh log is saved only after a mesh succeeds |
| B4 | The race-time calculator does not work on turboflow-test | 23 Sep test | `run_lap_calc` exists only on production; its source is in the backup (`functions/source/run_lap_calc/`) and is not in the repo |
| B5 | "Shared with me" in the Garage never lists anything | `docs/UI_PROGRAM.md` | It filters the user's own groups |
| B6 | Sharing a group does not give access to its files | `docs/SECURITY_AUDIT.md` item 10 | A collaborator sees the list and gets 403 on the files; needs a signed-URL callable |
| B7 | A Workbench run counts **twice** against the 30-per-hour run limit | Code: `queueRun` calls `guard(..., "runJob")` and `onJobPending` calls `overRateLimit(uid, "runJob")` | The real limit for Workbench runs is 15 an hour; Fusion runs count once |
| B8 | A setup SimScale refuses at its own check **after meshing** keeps the charge | Code: `mesh_id` is written before the check; `onJobPending` reverses only when no `mesh_id` or `run_id` exists | The check moved after meshing because SimScale will not check without a mesh. The comment in `lib/types.ts` still says a refused check costs nothing |
| B9 | The Workbench "Update" button (newer geometry exists) does nothing | `GUIDELINES_REVIEW.md` | No handler |
| B10 | x, y, z fields cannot take a minus sign or a decimal point while typing | same | Negative and decimal vectors cannot be entered |
| B11 | Dashboard dialogs put focus on Close, and a data refresh pulls focus back to Close mid-typing | same | |
| B12 | "Reset to default" in a panel restores the saved values, not the defaults | same | |
| B13 | Enter on a panel's Close or Delete button saves instead | same | |
| B14 | The orientation ball rebuilds its renderer on every hover | same | Performance |
| B15 | Cancelling a paid run has no confirmation | same | |
| B16 | Smaller items: zero-based face labels for screen readers, a blank row for a group with no name, camera moves that stack, long error text overflowing on `/simulations` | same | |
| B17 | Unlabelled inputs: 4 on `/lap-calculator`, 5 on `/billing`, and one empty button on `/billing` | `docs/SITE_AUDIT.md` | Accessibility |
| B18 | Keyboard access to Workbench menus and the 3D canvas | 27 Sep review | Not done |
| B19 | `LapCalcView`, `SimulationsView`, `TransactionsList` still use inline styles and hardcoded font sizes (type-audit budget) | `docs/UI_PROGRAM.md` | Old compiled code |
| B20 | The full post-processor does not exist | Spec section 12 | The Workbench can colour the car by a result field and download every file, but there are no cutting planes, streamlines or statistics. The header comment in `runs/ResultsPanel.jsx` is stale (says colouring is not possible) |
| B21 | CAD edit mode does not exist | Spec section 8 | `/transform` works, nothing calls it |
| B22 | A geometry cannot be deleted from the Workbench | 11 Sep | Waiting for an answer about simulations that point at it |

## C. Faults found by the browser tunnel cut that the server also has

Found on 27 Sep by running the same cars through both engines.

| # | Problem | Effect | Fix |
|---|---|---|---|
| C1 | **OpenCascade booleans loosen the tolerances of the shapes they are given.** The server's `cut_car_out` reuses the same car and tunnel across its three strategies and four mirror-wall offsets, so each attempt changes the next. | On `step_render`, the fused car cut removed 100.9% when cut first and 2.6% after another cut had touched it. Results depend on the order of attempts. | Copy the shapes before every attempt (`k.copy()` in `tools/tunnel-cut/cut-core.js`). Not yet done on the server. |
| C2 | **A region OCC will not certify can export a STEP that reads back as something else.** The server checks for faults it can name, but never reads its own output back. | `step_render`'s tunnel read back as two scraps of about 1,200 mm³ in **both** engines. The server would have sent that to SimScale and charged for the run. | Read the STEP back and compare volumes when the region is not certified valid (done in the browser version). Not yet done on the server. |

## D. Security and access loose ends

| # | Item | State |
|---|---|---|
| D1 | Rotate the SimScale API key | The current key was pasted into chat on 9 Sep ("I'll roll it as soon as everything is done"). Not known to be rotated. The old worker on production also has a key in its code. |
| D2 | Revoke the connection token pasted into chat on 9 Sep | Not known to be revoked. |
| D3 | Revoke the token-creator grant on `firebase-adminsdk-fbsvc@turboflow-test` for the owner's account | Still active on 27 Sep. The exact command is in `docs/SECURITY_AUDIT.md`. Needs Google Cloud. |
| D4 | App Check | Key registered on turboflow-test, nothing sends or enforces it. The add-in cannot produce tokens, so enforcement must exempt it. |
| D5 | Restrict the Firebase web API keys to the site's addresses | **UNVERIFIED** from here. |
| D6 | The old `cfd_web_frontend` GitHub repository had a workflow that deploys to production on every pull request | Reported 12 Sep. Must be deleted before a switch or it can overwrite the new site. Current state **UNVERIFIED**. |
| D7 | The old PayPal secret and Discord webhook (from `cfd_web_frontend/functions/.env`) now live in `env/secrets/production.env` at the repo root, git-ignored | Delete after the old app is retired; rotate if the folder was ever shared. |
| D8 | The production backup holds live secrets | Keep private; never upload, attach or commit. |
| D9 | The brand kit published as a private claude.ai artifact on 27 Sep could not be deleted from that session | The owner can delete it from claude.ai or `/artifacts` in a terminal. |
| D10 | `hi@hi.com` on turboflow-test is disabled, not deleted | It owns old test groups. |
| D11 | Backups | turboflow-test has daily backups, point-in-time recovery and delete protection (23 Sep); a restore has never been tried. Production has none. |
| D12 | TTL policies on `rate` and `paypal_orders` | Set on test (`rate`); production has none, so those collections would grow forever after a switch. |
| D13 | A collaborator with edit can spend the owner's credits | Limited to 8 runs an hour each; whether that is the right policy is the owner's call. |

## E. Data and quality

| Item | Notes |
|---|---|
| 93 historical runs on production report drag about 10% low | The original app took pressure force instead of total force. Leave, flag in the UI, or recompute from SimScale (the runs still exist there). Owner's decision since August. |
| SimScale keeps every run forever | Nothing deletes old SimScale runs, so the project grows. TurboFlow now also keeps the OpenFOAM case per run, with a lifecycle rule whose length is **UNVERIFIED**. |
| SimScale plan limits | Fewer than 16 cores; two runs at once on the test plan fail with "cores not available"; the API can only use **public** projects, and creating new public projects is disabled. So all geometry goes to a public SimScale project, as the privacy policy says. |
| Worker cold start | About 2.5 minutes of every run's queue time is Cloud Run pulling and starting the 322 MB worker image. |
| Leftover files in the repo root | `flow.step`, `labels.csv`, `prep.json`, `r.json`, `rav.json`, `base.txt` from 9 Sep testing, committed. |
| Stale docs | `docs/README.md` describes the Supabase version; `tests/README.md` lists only a few suites; `docs/SECURITY_AUDIT.md`'s status table is from 14 Sep (since then items 3, 12, 15, 18, 20 and 21 were fixed in code). |
| Dead test | `tests/test_billing.js` tests the retired Supabase database. |
| `legacy/` | Kept only because three checks still read it; port those first to delete it. |
| Local changes not deployed | 27 Sep: the design-review fixes, the Setup sliver warning, the add-in's unlimited-pass field fix, worker changes v26 to v30 are deployed to test but not production. |

## F. Things that only work with Google Cloud today

These tools exist and are documented but cannot be used while the ban stands:
`tests/e2e_autosetup.mjs` (needs an impersonated admin token),
`tests/replay_fusion_addin.py` against a deployed project, the production
scripts (`prod-migrate.mjs`, `prod-rollback.mjs`, `build-prod-site.mjs`
deploy), every `firebase deploy`, every `gcloud` command. The emulator suite
and `sh tests/run-all.sh` run locally and are fine.
