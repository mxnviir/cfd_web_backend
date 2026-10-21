# 04. Code map

Every folder and file in `turboflow/`, and what it does. Line counts are as of
3 Oct 2026. `node_modules/`, `dist/`, `dist-prod/`, `functions/lib/` (compiled
output) and `.git/` are left out. Almost every source file starts with a comment
explaining why it exists and what went wrong before; read that comment before
changing the file.

## Root of the repo

| File | What it is |
|---|---|
| `package.json` | The site package. Scripts: `dev` (Vite on 5173), `build` (Vite build, then prerender, SEO files and the add-in zip), `test` (pricing test plus the Firestore rules suite on the emulators), `emulate`. Depends on React 18, three.js 0.170, three-mesh-bvh, Firebase 10, Vite 6. |
| `vite.config.js` | The multi-page build: 15 HTML entries, shared vendor chunks (react, firebase, three), source maps off, and a dev-server rewrite so `/workbench/...` works locally like it does on Hosting. |
| `firebase.json` | Hosting (serves `dist/`, clean URLs, `/workbench/**` rewrite, cache headers, security headers including the enforced CSP), Functions (TypeScript build on deploy), Firestore and Storage rules, emulator ports (auth 9099, functions 5001, firestore 8080, storage 9199, hosting 5000, UI 4000). |
| `firebase.prod.json` | Written by `scripts/build-prod-site.mjs`: the same hosting config pointed at `dist-prod/`, without the predeploy step. Only for the production switch. |
| `.firebaserc` | Project aliases: `default` and `test` are `turboflow-test`, `prod` is `turboflow-7b3ca`. A bare deploy can only hit test. |
| `firestore.rules` | Database security rules (427 lines). See 03-ARCHITECTURE.md section 6. |
| `storage.rules` | File security rules (167 lines): the uid in the path is the ownership check, write-once uploads, size caps, everything else denied. |
| `storage-cors.json` | Which website origins may download files from the bucket in a browser. Without it every model download fails silently. Applied with `gcloud storage buckets update --cors-file`. |
| `postcss.config.js` | Autoprefixer only (Tailwind was removed on 10 Sep). |
| `.gitignore` | Ignores build output, `node_modules`, `.env` files, admin SDK keys, scan output. |
| `*.html` (15 files) | One per page: `index`, `simulations`, `billing`, `lap-calculator`, `dashboard`, `workbench`, `docs`, `sponsorship`, `mentorship`, `modelling`, `privacy-policy`, `terms`, `refund-policy`, `sponsorship-policy`, `404`. Each has its own title, description, canonical and Open Graph tags, the theme bootstrap script (its hash is in the CSP, so keep LF line endings), `firebase-config.js`, and one entry script from `src/entries/`. |
| `CHANGES.md` | 9 Sep: findings from the VibeMole scan of turboflow.cloud (which graded the old build), what to change before launch, and the 12 Sep security headers and storage-rules notes. |
| `GUIDELINES_REVIEW.md` | 27 Sep: about 200 findings from reviewing every `src/` file against the Vercel Web Interface Guidelines, grouped by file, fixed ones marked. Its "Bugs first" list is still mostly open. |
| `flow.step`, `labels.csv`, `prep.json`, `r.json`, `rav.json`, `base.txt` | **Leftover test artefacts from 9 Sep**, committed by mistake: a 2.2 m half-tunnel flow region in mm (used for the first end-to-end runs), its labels, and three `/prepare` replies. Safe to move out; nothing reads them. |
| `firestore-debug.log` | Emulator log. Not tracked. |

## `src/` (the website and the Workbench)

### Shared

| File | What it does |
|---|---|
| `Shell.jsx` (478) | The marketing chrome: header, sidebar navigation (one "Workbench" link that opens the Garage), credit balance, theme switch, sign-in dialog, footer. Loads Firebase lazily so pages paint first. Calls `ensureAccount` after sign-in, and asks for a team name once. |
| `prerender.jsx` (57) | Renders the signed-out view of each public page in Node at build time, so the HTML is not empty. Used by `scripts/prerender.mjs`. |
| `styles.css` (392) | Site tokens (colours for dark and light, accent `#4a90d9`, accent fill `#2f6cb0`), base styles, home page styles. |
| `type.css` (196) | The type scale: one H1, one H2, body, caption. IBM Plex Sans for text, IBM Plex Mono for numbers. |
| `chrome.css` (194) | Sidebar, header and footer styles. |
| `buttons.css` (188) | Primary, secondary and danger buttons. One 4 px radius. |
| `pages.css` (110) | Shared page layouts: `.page`, `.clause`, `.facts`, `.flow`, `.actions`, billing. |
| `reset.css` (54) | The browser reset that Tailwind used to provide. |

### `src/entries/` (16 files, 9 to 13 lines each)

One small entry per page. Each mounts its view inside `Shell` (site pages) or on
its own (`dashboard.jsx`, `workbench.jsx`, which have their own chrome).

### `src/lib/`

| File | What it does |
|---|---|
| `firebase.js` (198) | The Firebase client and a small compat-style API over the modular SDK (`db.collection().doc().get/set/update/onSnapshot`, `functions.httpsCallable`, `storage.upload/url/bytes/getJson`, `auth`). **Converts top-level field names** between camelCase (app) and snake_case (database). **Points any localhost page at the emulators** under project `demo-turboflow`, so local work cannot touch a real project. |
| `signIn.js` (38) | Google sign-in with a popup, falling back to a same-tab redirect when the popup is blocked (Safari, in-app browsers). |
| `pricing.js` (138) | The browser's copy of the price formula, plus `FINENESS_STEPS` (the mesh rungs shown in the dropdowns, including draft 7 and 8). Must equal `functions/src/lib/pricing.ts`; `tests/test_pricing.mjs` checks. |
| `quantities.js` (132) | How each result is written: forces to 3 decimals, coefficients to 3, moments to 4, tabular figures; and how a change against the previous run is shown. |
| `units.js` (109) | Unit families for Workbench fields. Storage is always SI; the dropdown only changes the display. Exact conversion factors. |
| `materials.js` (52) | The 14 fluids SimScale offers, in SimScale's order. Air and Water verified, the rest standard values marked as such. |
| `geometry.js` (40) | Which version of a geometry to draw (the newest car, not a tunnel). |
| `pages.js` (74) | Where each old in-app "view" now lives as a real URL. |
| `status.js` (75) | Job status labels and colours from theme tokens. |
| `format.js` (22) | Small number and date formatters. |
| `icons.js` (313) | The site's line icons. |

### `src/views/` (site pages)

| File | Page |
|---|---|
| `HomeView.jsx` (176) | Home. Rebuilt on 27 Sep to the layout of turboflow.cloud (Fusion footage, race calculator, CFD, mentorship, modelling), with banned patterns left out. The race calculator is loaded on its own so the home page does not pull in Firebase. |
| `SimulationsView.jsx` (637) | `/simulations`: every job (both routes), status, drag and lift (lift keeps its sign: negative is downforce), cancel and refund, race time per job, results and ParaView downloads, **Fusion connection tokens** (create, copy once, revoke). Extracted from the old compiled app. |
| `BillingView.jsx` (418) | `/billing`: buy credits or an unlimited pass through PayPal (the PayPal script loads only here), price of a standard run, transaction list. |
| `LapCalcView.jsx` (456) | `/lap-calculator`: the race time calculator. Calls the `run_lap_calc` function, which exists only on production (so it does not work on test). 10 credits, free for sponsored. |
| `DocsView.jsx` (70) | `/docs`: the setup guide as an ordered list, and the add-in download (`/downloads/TurboFlow_CFD.zip`, built at deploy). |
| `SponsorshipView.jsx`, `MentorshipView.jsx`, `ModellingView.jsx` | Programme pages, rewritten to the design rules. |
| `PrivacyPolicyView.jsx`, `TermsView.jsx`, `RefundPolicyView.jsx`, `SponsorshipPolicyView.jsx` | Policies, through `LegalPage.jsx`. The privacy policy is written from what the code does and says geometry goes to a **public** SimScale project. The refund policy matches `refundJob`. Their "Last updated" dates need the owner's confirmation (design rule 2.4). |
| `NotFoundView.jsx` (22) | The 404 page. |
| `DashboardView.jsx` (6) | Points the dashboard entry at `src/dashboard/`. |

### `src/components/`

| File | What it does |
|---|---|
| `AuthModal.jsx` (59) | The sign-in dialog: one button, Continue with Google. Escape closes it; errors show inside it. |
| `InlineRaceCalc.jsx` (204) | The small race calculator on the home page. `Field` was moved out of the component on 27 Sep so typing is not wiped on re-render. |
| `LapField.jsx` (67) | One labelled input for the calculator. |
| `LegalPage.jsx` (22) | The shared layout of the four policy pages. |
| `TransactionsList.jsx` (203) | The ledger list on billing. |

### `src/dashboard/` (the Garage, `/dashboard`)

| File | What it does |
|---|---|
| `DashboardApp.jsx` (320) | The Garage: tabs "My groups", "Shared with me", "Recent"; one row per group; new group, rename, copy, share, delete through the group callables. Counts are worked out in the browser from the same queries. Signed-out screen has its own Google button. |
| `GroupGrid.jsx` (178) | The rows: best drag and its Cd, run count, any run in progress; sort options; row menu. |
| `dialogs.jsx` (329) | One `Modal` frame (Escape, X, scrim, focus) and the New group, Share (view or edit), Rename and Confirm dialogs. Never `alert()`. |
| `dashboard.css` (222) | Garage styles on the shared tokens. |

### `src/workbench/` (the Workbench, `/workbench/{groupId}/...`)

| File | What it does |
|---|---|
| `App.jsx` (797) | The Workbench shell: layout grid (sidebar, viewer, scene column, results), the three views (Model, Results, Split; keys 1, 2, 3), the launch screen with real milestones, signed-out screen, and the calls to `saveSimulation`, `updateGroup`, `measureGeometry`, `prepareDomain`, `copyGroup`, `cancelRun`, `shareGroup`, `unshareGroup`, `queueRun`. Every navigation goes through a save guard so a dirty panel is committed or kept. |
| `Setup.jsx` (509) | **The four setup steps** (Wheels, Wind tunnel, Mesh, Simulation) and Quick setup, `FACTORY_DEFAULTS`, saved per-user defaults, car menu (rename, download), sliver warning (local change on 27 Sep lowered it to 5 or more, **not deployed**). |
| `GeometryUpload.jsx` (238) | Import dialog: file types, unit, size limit, `createUploadIntent`, resumable upload with a percentage. |
| `TopBar.jsx` (206) | Top bar: back to the Garage, group name, save state ("Unsaved edits in this panel" beats "All changes saved"), view switch, credits, account menu. |
| `SettingsPanel.jsx` (224) | The floating panel frame with the draft rule: tick or Enter saves, Escape or X discards, leaving saves a valid draft. |
| `SceneTree.jsx` (228) | The right-hand list of what is in the scene (bodies, faces on demand). |
| `JobStatus.jsx` (155) | The dock under the viewer: every run in the group, live, with a ticking runtime and cancel. |
| `Results.jsx` (91) | The Results view: one row per run with its numbers so far. |
| `Resizer.jsx` (87) | Drag handles that write a CSS variable (not React state) and remember the width. |
| `HelpButton.jsx` (57) | The "?" popover: docs, setup video, email with the group id. |
| `ShortcutSheet.jsx` (61) | Keyboard shortcuts table. |
| `ErrorBoundary.jsx` (42) | One broken panel shows an error instead of blanking the whole Workbench. |
| `data.js` (157) | All Firestore reads: `useUser`, `useDoc`, `useGroupCollection` (one live listener per collection, sorted in the browser), `useSaver` (honest save state), `useTabLock` (warns when the same group is open in two tabs). |
| `route.js` (96) | **The URL is the selection**: `/workbench/{group}`, `/geometry/{id}`, `/sim/{id}/{node}`. |
| `simtree.js` (168) | The simulation tree nodes and when each is complete, read from the real `spec`. |
| `icons.jsx` (133) | Workbench line icons, `currentColor`. |
| `tokens.css` (519) | The Workbench's tokens, mapped onto the site's (checked by `scripts/palette-audit.mjs`). |
| `workbench.css` (1646) | Workbench styles. Smaller type scale on purpose (13 px body) for a dense tool. |

`src/workbench/panels/` (the setup panels, reached from the tree or the steps):

| File | What it does |
|---|---|
| `index.jsx` (513) | Which panel a node opens; wires the draft, the panel frame and the face-assignment box to the viewer. |
| `setup.jsx` (706) | Global, Geometry (with the tunnel summary), Model, Material (and the material dialog), Initial conditions, Numerics, Simulation control, Force coefficients, Forces and moments, Mesh panels. |
| `boundary.jsx` (385) | Boundary conditions: one panel with a type dropdown (velocity inlet, pressure outlet, wall with no-slip, slip, moving or rotating, symmetry and others), turbulence rows. |
| `fields.jsx` (267) | The controls every panel uses: `Row`, `Section`, `Num` (with units), `Select`, `Toggle`, `Vec` (x, y, z), `Assignment` (faces list), `Note`. |
| `useDraft.js` (110) | The draft hook: typing changes the draft only; save and discard; "may I leave?" for the router. |

`src/workbench/runs/`:

| File | What it does |
|---|---|
| `QueueDialog.jsx` (99) | The dialog that spends credits: price, balance, errors disable Queue, warnings do not. |
| `RunPanel.jsx` (393) | One run: stage text and progress, price, refunds, the summary (drag leads, Cd, change against the previous run), plots, event log, errors in plain words. |
| `Plot.jsx` (286) | Residual and force charts as SVG polylines, log axis for residuals, colour-blind-checked series colours, real x axis. No chart library. |
| `ResultsPanel.jsx` (197) | What a finished run produced, with every file a download, a field legend, and an honest note that the full post-processor is not built. |

`src/workbench/viewer/`:

| File | What it does |
|---|---|
| `engine.js` (1141) | The three.js engine as a class: loads the GLB, BVH for fast picking, per-vertex selection and hover colours, face highlighting, the translucent tunnel box, field colouring, camera presets (SimScale, Fusion 360, Onshape, TurboFlow), fit to view that knows about the floating panel, draw on demand. |
| `Viewer.jsx` (520) | The viewport: toolbar, picking, box select, keyboard, overlays. |
| `useSelection.js` (102) | Selection model (solid, face modes; click, ctrl-click toggle, shift add) and assignment mode for panels. |
| `ViewBall.jsx` (206) | The draggable orientation ball with axis handles (replaced SimScale's view cube, 11 Sep). |
| `ContextMenu.jsx` (82) | Right-click: select other (what is behind), expand selection (tangent faces, same size). |
| `MeasurePanel.jsx` (113) | Measure one face from `faces.json`, or two faces exactly through `measureGeometry`. |

## `functions/` (Cloud Functions, TypeScript, Node 24)

Full behaviour of each function is in 05-BACKEND-REFERENCE.md.

| File | What it does |
|---|---|
| `package.json` | `firebase-admin` 13, `firebase-functions` 7, `google-auth-library` 10, `zod` 3; `npm run build` is `tsc`. |
| `tsconfig.json` | Compiles `src/` to `lib/`. |
| `.env.turboflow-test`, `.env.turboflow-7b3ca` | Per-project settings read at deploy (`TESSELLATE_URL`, `BUCKET_REGION`, `WORKER_JOB`, `PAYPAL_ENV`). Not secrets, but do not paste them into chat. |
| `src/index.ts` (52) | Which functions are deployed and under what names. Global options: us-central1, max 10 instances, 60 s timeout. |
| `src/lib/admin.ts` | One Admin SDK app; `db`, `auth`, `storage`, `bucket()`. |
| `src/lib/config.ts` | Project id at runtime, `isProd()`, region, worker job name, the four secrets, `secretValue()` (treats "unset" as empty), `paypalBase()` (live only on production), collection names. |
| `src/lib/guard.ts` | `guard()`: sign-in, rate limit, zod parse; `humanOnly` refuses connection-token sessions. |
| `src/lib/ratelimit.ts` | The rate-limit table, fixed windows counted in Firestore, fails open; `clientIp()` reads the last X-Forwarded-For hop. |
| `src/lib/ledger.ts` | The only code that changes credits: charge, refund, reversal, grant, unlimited pass extension; deterministic row ids. |
| `src/lib/pricing.ts` | `FINENESS`, `LIMITS`, `clampRunParams`, `listPrice`, `sponsorRate`, `hasUnlimited`, `chargeFor`. |
| `src/lib/schema.ts` | zod schemas for the job, refund, PayPal and upload callables. |
| `src/lib/types.ts` | Job statuses, refundable and terminal lists, document shapes. |
| `src/lib/normalize.ts` | camelCase to snake_case for Fusion job documents, safe against `__proto__`. |
| `src/lib/units.ts` | The exact unit strings SimScale expects (with the superscript characters). |
| `src/jobs/onJobPending.ts` | **The one place a run is charged and started**; reverses charges on failure. |
| `src/jobs/dispatch.ts` | Starts the Cloud Run worker job with environment overrides. |
| `src/jobs/queueRun.ts` | Queue a Workbench run: validate, permission, collaborator limit, price, clamp, write `runs` and `jobs`. |
| `src/jobs/submitJob.ts` | `submitJob` and `startJob`: the older web route (draft until a STEP and labels exist). |
| `src/jobs/refundJob.ts` | Cancel and refund, amount from the ledger. |
| `src/jobs/cancelRun.ts` | Ask a Workbench run to stop (writes `cancelling`). |
| `src/jobs/onJobFinished.ts` | Mirror the job's ending onto its run; add a notification. |
| `src/groups/index.ts`, `schemas.ts` | Create, update, delete (with children and files), copy (server-side file copy), share, unshare groups. |
| `src/geometry/createUploadIntent.ts` | Mint the geometry id and the one upload path; quota check. |
| `src/geometry/processGeometry.ts` | `onGeometryUploaded` (storage trigger) and `processGeometry` (calls `/inspect`, writes version 1). **Both keep one instance warm** (`minInstances: 1`), which costs money; see 07-PROBLEMS.md. |
| `src/geometry/prepareDomain.ts` | `prepareDomain` (callable) and `runPrepareDomain` (private, calls `/prepare`, writes the tunnel version and the automatic setup). `runPrepareDomain` **keeps one instance warm**. Uses `node:https` instead of `fetch` because fetch gives up after 300 s. |
| `src/geometry/measureGeometry.ts` | Distance between two faces through `/measure`. |
| `src/simulations/index.ts` | `DEFAULT_MESH_SPEC` (Simmetrix, fineness 9.5, 2 mm small-feature tolerance, automatic processors), `createSimulation`, `saveSimulation`, `checkSimulation`, `onSimulationWritten`. |
| `src/simulations/autoSpec.ts` (528) | The automatic setup: boundary conditions, wheel spin, moving road, result controls, mesh spec with refinements and coarse sizing on slivers. Pure; tested by `tests/test_auto_spec.mjs`. |
| `src/simulations/spec.ts` | zod shape of an Incompressible setup (keeps unknown keys). |
| `src/simulations/validate.ts` | The checker: errors (no geometry, no material, no inlet or outlet, empty or duplicated faces, missing faces, solver-foreign fields, slivers) and warnings. |
| `src/simulations/clamp.ts` | `clampToPaidRun`: cut the setup to what was paid for. |
| `src/simulations/defaultIncompressible.json` | The default SimScale model, from a simulation SimScale's own Workbench created. |
| `src/paypal/client.ts` | Prices from `config/pricing` with defaults; PayPal OAuth and fetch. |
| `src/paypal/createOrder.ts`, `captureOrder.ts`, `applyPurchase.ts`, `webhook.ts` | The purchase flow. |
| `src/fusion/tokens.ts` | Connection tokens: create, revoke, exchange. |
| `src/users/onUserCreate.ts` | `ensureAccount`: Google only, 50 credits, written in a transaction. (The file keeps its old name.) |
| `src/storage/quota.ts` | `onStorageWrite` and `onStorageDelete`: 5 GiB per account, counted as files land and leave. |

## `services/` (Python, run on Cloud Run)

### `services/tessellate/` (the geometry service)

| File | What it is |
|---|---|
| `main.py` (4,008) | Flask app on gunicorn (1 worker, 2 threads, 600 s timeout). Auth: a user's Firebase ID token, or a Google token from a trusted service account plus `on_behalf_of`. Every path is checked against the owner's prefix (`owned`). Has its own rate limits in the shared `rate` collection. |
| `requirements.txt` | **cadquery 2.8.0** (the OpenCascade kernel; 2.5.2 had the wheels-only cut bug), trimesh 4.5.3, flask, gunicorn, firebase-admin. Versions are load-bearing. |
| `Dockerfile` | python:3.11-slim, OpenGL libraries, an import check at build time, runs as uid 10001 (not root). |

Endpoints:

| Endpoint | What it does |
|---|---|
| `/health` | Liveness. |
| `/inspect` | Raw CAD (STEP, IGES, STL) in; turns it to face the wind, works out the unit, triangulates face by face, finds wheels, measures frontal area and slivers, matches STEP entity ids; writes `v{n}/` model, face list, solids, thumbnail, STEP. STL goes through `inspect_mesh` (no OCC). |
| `/prepare` | Car in; mirror plane, tunnel sizing (floor 0.1 mm under the wheels), the cut (one pass, then fused bodies, then body by body, with volume guards and several mirror-wall offsets), validity and void checks, STEP export, face labels, wheels per face, adjacency; writes the tunnel version. |
| `/measure` | Exact distance between two B-rep faces. |
| `/transform` | Replay translate, scale, rotate, mirror on a STEP and write a new version (built for CAD edit; no UI uses it now). |
| `/tessellate` | The older STEP to GLB preview, now face by face. |

Main helpers, in order of the file: request timing (`stage`), rate limits,
storage I/O, caller identity (`caller_uid`, `owned`), STEP import with a cache,
STL and IGES readers, STEP entity matching (`parse_step_faces`,
`match_step_ids`), `write_step` (flat, in metres), `ensure_meshed` (triangulate
once), `exact_bbox` (AddOptimal), `detect_scale`, face statistics from
triangles, `sliver_report`, `survey_faces`, `car_axis` and `orient_to_wind`,
wheel finding (`wheel_radii`, `split_axle`, `name_wheels`, `find_wheels`),
`cut_parallel`, `cut_car_out`, `fuse_bodies`, `faulty_faces`, `describe_spot`,
`symmetry_plane`, `label_faces`, `group_wheel_faces`, `build_domain`,
`classify_faces` (labels from the STEP text), `write_labels_csv`, `apply_ops`,
`face_adjacency`, `render_thumb` (numpy rasteriser, no image library),
`frontal_area` (rasterised shadow), `to_glb_by_face`.

### `services/simscale-job/` (the SimScale worker)

| File | What it is |
|---|---|
| `simscale_job.py` (2,152) | The worker. `main()` reads `JOB_ID`, loads the job, and takes **spec mode** (Workbench) or the **older label mode** (Fusion). Also `EXPORT_ONLY=1` to rebuild a finished run's results. |
| `spec_mode.py` (473) | Spec-mode helpers: `make_stage_writer` (writes job and run together), `fetch_step_id_to_names`, `region_names`, `add_missing_discriminators`, `readable_api_error`, `resolve_spec`, `api_post/put/get`, `attach_mesh`, `check_setup`, `first_error_in_event_log`, `save_event_log`, `latest_timestep`, `downsample`. |
| `requirements.txt` | firebase-admin, requests, **SimScale SDK 9.2.0 pinned to a git commit**, pyvista 0.44.2, trimesh 4.5.3, numpy. |
| `Dockerfile` | python:3.11-slim, git and OpenGL libraries, import check, runs as a non-root `worker` user. |

Worker functions worth knowing: `owned_path` (only the owner's prefix or this
job's own folder), `upload_geometry` and `upload_geometry_spec`,
`load_entity_labels` and `fetch_label_to_names` (Fusion path), `build_model`
(Fusion path model), `create_mesh` (2 mm small-feature tolerance), `start_run`,
`wait_for_result_links`, `extract_drag_lift`, `download_url_of` (null-safe),
`openfoam_car_surface` and `export_results_for_viewer` (OpenFOAM case to GLB
plus per-vertex field files, decimated to 300k triangles, plus the case for
ParaView), `flow_direction`, `symmetry_factor`, `whole_car` (doubling),
`export_plots`, `summarise`, `poll_operation` (progress, cancel, mesh failure
reason), `geometry_import_error`, `export_again`.

Versions deployed to turboflow-test: up to **v30** (27 Sep). Production's
`simscale-worker` is **v25**.

### `services/TurboFlow_CFD_fusion_addin.py` (826)

The Fusion 360 add-in, as the source the zip is built from. Settings at the top
(`FIREBASE_PROJECT`, `STORAGE_BUCKET`, `FIREBASE_API_KEY`, `FUNCTIONS_BASE`,
`CONNECTION_TOKEN`); `scripts/build-addin.mjs` stamps them for the target
project. A dialog with account, tunnel, wheels, mesh, iterations and a live cost
card; on Run it builds the tunnel in Fusion, cuts the car, labels faces from the
exported STEP text, exchanges the token, checks credits and the unlimited pass
(fixed on 27 Sep to read `unlimited_until`), uploads to `jobs/{id}/`, and writes
the job document. A copy stamped for turboflow-test is in
`cfd_web_backend/fusion_addin_test/TurboFlow_CFD/TurboFlow_CFD.py`.

## `scripts/` (build, audits, production tools)

| File | What it does |
|---|---|
| `prerender.mjs` | After `vite build`: renders each public page and writes the markup into its HTML. Uses `prerender-firebase-stub.js` in place of the real Firebase client. |
| `seo.mjs` | Writes `robots.txt` and `sitemap.xml` into `dist/`, checked against the build's entry list. |
| `build-addin.mjs` | Builds `dist/downloads/TurboFlow_CFD.zip` from the add-in source, stamped for the project in `public/firebase-config.js`. |
| `build-prod-site.mjs` | Turns a test build into the production site (`dist-prod/`): production Firebase config, turboflow.cloud in canonical and OG tags and the sitemap, add-in stamped for production; refuses to finish if any test value is left. Writes `firebase.prod.json`. |
| `prod-migrate.mjs` | Renames production's camelCase fields to snake_case (and back with `--reverse`), logging every change so a rollback restores the exact bytes. |
| `prod-rollback.mjs` | Puts production's site version and rules back from the backup. |
| `build-restore-folders.py` | Builds deployable folders of production's original functions from the backup, for a rollback. |
| `design-audit.mjs` | Every mechanically checkable rule in DESIGN_RULES.md (banned fonts, em dashes, gradients, radii, uppercase labels, numbered steps, utility classes, hardcoded colours, "Last updated" dates, and more). Exit 1 on failure. |
| `contrast-audit.mjs` | Resolves every colour and background pair per theme and checks WCAG contrast, without a browser. |
| `palette-audit.mjs` | Workbench tokens against the site's, token by token; divergence must be recorded. |
| `token-audit.mjs` | CSS custom properties used but never defined (they fail silently). |
| `type-audit.mjs` | Font sizes typed into inline styles, with a ceiling that only goes down. |
| `orphan-classes.mjs` | Class names used in markup that no stylesheet defines. |
| `csp-audit.mjs` | The CSP is enforced and its script hash matches the inline theme script. |
| `legacy-model-audit.mjs` | Leftover references to projects and folders after the move to groups. |

## `tests/`

`sh tests/run-all.sh` runs everything that needs no emulator and no credits;
`sh tests/run-all.sh --emulator` adds the two rules suites. `npm test` runs the
pricing test and the Firestore rules suite. Most tests **read the real shipping
file** (by import or by lifting functions out with `ast`) so they cannot drift
from it. Two library-version bugs taught that.

| Test | Proves |
|---|---|
| `test_security.mjs` (1,226) | Firestore rules and callables as a real signed-in user on the emulators (75 checks): forged jobs refund zero, money fields closed, groups and sharing, connection-token limits, Google-only sign-up. |
| `test_storage_rules.mjs` | Storage rules on the emulator (14 checks): own files yes, others no, old results path denied, write-once. |
| `test_pricing.mjs` | Browser and server prices agree for every input. |
| `test_clamp_paid_run.mjs` | A run cannot buy more compute than it paid for (37 checks). |
| `test_auto_spec.mjs` | The automatic setup produces what the solver accepts: flow direction, wheel spin, moving road, result controls, no foreign fields. |
| `test_run_fields.mjs` | Every run field the Workbench reads is written by something. |
| `test_plot_shape.mjs` | The stored plot shape is drawable by the React chart. |
| `test_quantities.mjs` | How results are written and compared. |
| `test_framing.mjs` | Fit to view puts the car where it can be seen, beside the floating panel. |
| `test_frontal_area.mjs` | A flow domain's shadow is the tunnel, not the car (so the car's is used). |
| `test_safe_path.mjs` | `?next=` cannot send anyone off the site (open-redirect regression, 36 checks). |
| `test_client_ip.mjs` | The rate-limit address cannot be spoofed with a header. |
| `test_google_only.mjs` | Only Google sign-ups are accepted. |
| `test_chart.mjs`, `test_compare.mjs` | Chart and comparison functions, still read from `legacy/workbench-classic.html`; use `tests/plots.json` (real run data). |
| `test_cut_car_out.py` | The cut strategies and their volume guards (needs cadquery). |
| `test_symmetry_plane.py` | Mirror plane on cars not drawn on the origin; half versus whole. |
| `test_half_car.py` | Half-model forces doubled correctly. |
| `test_drag_sign.py` | Drag is along the wind whichever way it blows. |
| `test_wheel_detection.py`, `test_wheel_grouping.py` | Wheels found on real surfaces; faces grouped to the right wheel with the right radius. |
| `test_transform.py` | Translate, scale, rotate, mirror and the exact bounding box. |
| `test_summarise.py` | `summarise()` reads what `export_plots()` returns. |
| `test_results_export.py`, `test_openfoam_export.py` | Results packages and OpenFOAM cases become viewer files with fields intact. |
| `test_service_names.py` | No endpoint reads a name nothing gives it. |
| `test_plots.py` | Plot export from a real SimScale run (needs the key and the network). |
| `test_billing.js` | **Dead.** Tested the August Supabase database. |
| `e2e_autosetup.mjs` | A real car through the deployed test stack, as a signed-in test user; `--queue` spends credits, `--watch` follows the run. Needs Google Cloud credentials, so it is **off limits** now. |
| `replay_fusion_addin.py` | Runs the add-in's own upload code against a deployed project without Fusion. |
| `replay_old_addin.mjs` | Replays the August add-in's requests against a project. |
| `rehearse_prod_migration.mjs` | The production data migration and rollback on the emulator with production's documents. |
| `run-all.sh`, `run-all.ps1` | Runners (the `.ps1` one is older and shorter). |
| `README.md` | Why tests read the shipping files. Lists only a few suites. |

## `tools/tunnel-cut/` (the browser tunnel cut, 27 Sep)

Not part of the site build. See 09-NO-CLOUD-PLAN.md.

| File | What it does |
|---|---|
| `cut-core.js` (410) | The cut, ported from `/prepare`: unit detection, mirror plane from triangles, tunnel sizing, three cut strategies on fresh copies with volume guards, mirror-wall offsets, validity, void and read-back checks, STEP export, face labels from the STEP text. |
| `cut.worker.js` | Runs the cut in a Web Worker so the page never freezes; loads the engine once. |
| `main.js`, `index.html` | The test page: file picker, tunnel options, progress bar with stages and seconds, Cancel, 10-minute limit, 50 MB limit, results and downloads. |
| `vite.config.js`, `package.json` | `npm run dev` serves it on port 5190 with the site's Vite. Depends on `occt-wasm` 5.3.5 (OpenCascade 8 in WebAssembly). |
| `check.mjs` | Self-check on a car built from boxes. `node check.mjs`. |
| `run-node.mjs` | The same cut in Node, for comparing. |
| `reference.py` | The server's own functions on the same file, for comparing. |
| `local-samples/` | Copies of test cars. Ignored by git; do not commit. |

## `docs/`

See the "Older docs" table in [00-README.md](00-README.md). Also:
`docs/simscale/default_incompressible_spec.json` (the default model) and
`docs/simscale/figures/` (123 images from SimScale's documentation, used to
check the spec).

## Other folders

| Folder | What it is |
|---|---|
| `public/` | Copied into the build as is: `firebase-config.js` (which project), icons, logo, `og-image.png`, the hero video (0.26 MB) and poster. |
| `legacy/` | The old hand-written Workbench (`workbench-classic.html` and five scripts). Not built or served. Kept only because `test_chart.mjs`, `test_compare.mjs` and `orphan-classes.mjs` read it. |
| `archive/site-redesign-2026-09-24/` | The site built to DESIGN_RULES.md on 23 to 24 Sep. Restored on 25 Sep. |
| `archive/workbench-simscale-layout-2026-09-25/` | The Workbench as it was before the rejected race-engineering look. |
| `archive/design-review-2026-09-27/` | Snapshot of `src/` and the pages before the 27 Sep design review. |
| `brand/brand-kit.html` | The brand kit from 27 Sep, saved locally. Not deployed. |
| `.screenshots/` | Screenshots from earlier checks. |
| `.claude/launch.json` | Dev server config for the app's browser preview. |
| `.firebase/` | Firebase CLI hosting cache. |

## Outside the repo, in `cfd_web_backend/`

| Path | What it is |
|---|---|
| `DESIGN_RULES.md` | The design rules (hard bans, signals, what to do instead, launch gates, review checklist). Source of truth for how every page looks. |
| `backups/turboflow-7b3ca-2026-09-24/` | Production backup. **Holds live secrets.** |
| `cfd_web_frontend/` | The original app's source as it was in August. Not git. Its `functions/.env` holds old secrets. |
| `fusion_addin_test/` | The add-in stamped for turboflow-test. |
| `.claude/launch.json` | Preview configs: `turboflow-vite` (5173), `turboflow-emulators` (UI on 4000), `tunnel-cut` (5190). |
| `design_audit.json` | Output of the 9 Sep scan. Stale. |
| `firebase-debug.log`, `firestore-debug.log` | Emulator logs. |
| `laws_of_motion_answers.pdf` | Unrelated (physics homework). |
