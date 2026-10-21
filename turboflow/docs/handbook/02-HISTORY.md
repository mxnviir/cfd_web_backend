# 02. History

Everything that happened, in date order. Dates are 2026. Times of day are left
out unless they matter. "The owner" is Shashank. Sources: git log, the docs in
`docs/`, the memory files, and every chat transcript for this project.

Some sessions in the same transcript folder are not about TurboFlow (an FTC
robot budget and simulator, physics homework, a team roles chart, RustDesk
setup). They are left out here.

## Before September: the original app and the Supabase detour

| When | What |
|---|---|
| Up to 4 Aug | **The original TurboFlow app** runs on Firebase project `turboflow-7b3ca` at turboflow.cloud. One 4,980-line compiled React file (`app.compiled.js`), Tailwind from a CDN, a 27 MB hero video, six Cloud Functions (`submitSimulationJob`, `onNewJob`, `refundJob`, `createPayPalOrder`, `capturePayPalOrder`, `run_lap_calc` in Python), a Cloud Run geometry service (`turboflow-tessellate`) and a Cloud Run job (`simscale-job`). Its last deploy is 4 Aug (Hosting version `fa328903006aff67`). That is still what production serves today. |
| July to Aug | The Fusion 360 add-in is the main way runs arrive. It used the account's Firebase refresh token as its "connection token", printed on screen. |
| ~12 Aug | **A migration from Firebase to Supabase** is done on another machine (paths say `C:\Users\manvir\...`). Postgres with row-level security, six Edge Functions, a `pg_net` trigger, 20 migrations, a legacy-data claim on first Google sign-in, a security audit, and a first hand-written **Workbench** (`workbench.html`, one file, three.js). It was deployed to Supabase project `unwzwzzuzvqwkxdbxxpd` but never reachable by users, because Google sign-in was never configured for it. Documented in `docs/HANDOVER.md` and `docs/MIGRATION.md`. |
| Aug | The August work finds and fixes real bugs that the original app shipped, the worst being **drag under-reported by about 10%**: a fuzzy column match took pressure force instead of total force (dropping skin friction) and added a moment to a force. The 93 historical runs on production still carry the old numbers. |
| Aug/Sep | Someone replaced the Firebase redirect address on the shared Google OAuth client with the Supabase one, which **broke Google sign-in on production** (`redirect_uri_mismatch`). Found on 9 Sep (`docs/PLAN.md`). UNVERIFIED whether it was ever re-added. |

## 9 September: back to Firebase, from scratch

Session `b36c6eed`. The owner brings the August Workbench files and the Fusion
add-in and asks for a working copy.

- **Decision: a second real Firebase project, `turboflow-test`**, rather than a
  preview channel, so tests never touch production data or money.
- **Decision: stay on Firebase, abandon Supabase.** The Supabase work becomes the
  *specification*: its fixes are re-implemented on Firestore.
- The repo `turboflow/` is created and put under git (first commit "Consolidate
  TurboFlow into one repo, pointed at a test project").
- **Backend rewritten in TypeScript** (`functions/src/`): zod on every input, a
  `guard()` for sign-in plus rate limit plus validation, a ledger that is the only
  writer of credits. Fixes, all found in the original app:
  - **The refund hole.** The old `refundJob` paid back `job.cost ?? 100` from a
    document the user wrote, then deleted the job. Anyone could mint credits.
    Now refunds come from the backend's own ledger.
  - Web jobs were charged 100 credits and never ran (`queued` vs `pending`).
    Charging and starting are now one event.
  - Failed dispatch kept the credits. Now reversed.
  - Anyone could overwrite anyone's geometry in Storage. Owner now in the path.
  - The 50 sign-up credits were farmable. The server now creates accounts.
  - No PayPal webhook. Added, signature-verified.
  - The website served the backend source (`public: "."`). Now only `dist/`.
  - The project id was hardcoded, so a test deploy would have run production's
    worker and live PayPal. Now derived at runtime; only production can reach
    live PayPal.
- **The site is split into real pages** (Vite multi-page build, 13 then 15 pages,
  real 404, clean URLs). Pages drop from about 1.5 MB to 58 to 166 kB.
- **Google becomes the only sign-in.**
- **Connection tokens** replace the refresh token for the Fusion add-in: random,
  hashed, revocable, and a session made from one is marked `fusion` and refused
  anything to do with money or deleting.
- **The worker is rebuilt** from the Supabase copy (which had results export and
  the drag fix) with its data layer swapped back to Firebase. First runs reach
  SimScale. The old SimScale key turned out dead; the owner supplied a new one in
  chat. SimScale refuses private projects on this plan and creating public
  projects is disabled, so test runs go into an existing public project.
- **Design rules arrive.** The owner pastes the "no vibe-coded look" brief, then
  points at `DESIGN_RULES.md`. Within the day: em dashes removed, dot grid and
  blur removed, Inter replaced by IBM Plex Sans, one corner radius, gradients cut
  from 31 to 4, and `scripts/design-audit.mjs` written so the rules can be
  checked by a script. (An earlier answer that day said "match the main app
  exactly" and "leave the fonts"; the rules file reversed both.)
- **The Workbench should take a raw car** (owner, 17:04): import the car, move the
  tunnel box, auto-detect wheels like the add-in or pick faces like SimScale. The
  geometry service gains `/inspect` (face-by-face model, so a click is a face) and
  `/prepare` (builds the tunnel). STL is removed from the preview path ("STEP
  ONLY", owner).
- Found: OpenCascade's fuse silently lost bodies, so a cut could remove nothing
  and still pass every label check. Fixed by cutting body by body and refusing a
  cut that removes under 5% of the car.
- **Standing rules set this day:** plain English ("not claudish") and no
  subagents ("no agents allowed, it's a rule").

## 10 September: speed, Tailwind out, the SimScale spec

- Tailwind removed. Light mode designed separately from dark (contrast measured,
  163 hard-coded colours turned into tokens).
- The owner's real car crashed the geometry service: it ran out of 4 GB because
  the model was triangulated twice. Also, the car was modelled sideways, so the
  tunnel was built across it. Fixed: triangulate once, and turn the car to face
  the wind automatically.
- "Make it faster, 30 s is still too slow": `/inspect` goes from 30.8 s to 11.1 s
  warm, by vectorising the shadow rasteriser, taking face areas from triangles,
  and caching the imported shape. **This is also where always-on instances
  started** (one warm instance on the upload trigger, 10 Sep).
- The viewer becomes snappy (no damping, draw on demand), with control presets
  (SimScale, Fusion 360, Onshape) and selection modes.
- **The SimScale Workbench spec** (`docs/SIMSCALE_WORKBENCH_SPEC.md`) is written
  at the owner's request: a field-by-field description of SimScale's UI and API
  so another agent could build an identical Workbench. Decisions recorded in it:
  - **Queue mode**: nothing touches SimScale until the user presses Queue; one
    backend job then does everything.
  - **Every project private**, no public library.
  - **STEP, IGES and STL** uploads only.
  - **Keyless for users**: only the backend holds the SimScale key.
  - **Firestore is snake_case.**
- The build follows the spec's step plan: steps 0 to 10 are committed that night
  (projects, upload intent, Workbench shell, dashboard, picking, save and
  validate, setup panels, queue and worker spec mode, runs UI). **This is the
  last git commit** ("Build spec step 10: the runs UI", 23:04 Dubai time).

## 11 September: the first runs that finish

- "Run one real car end to end." Fifteen queued runs on turboflow-test, each
  failing one step further, each on a real bug: the worker image missing
  `spec_mode.py`; SimScale dropping zero-area faces; velocity inlets missing
  `type: "COMPONENT"`; the setup check running before a mesh existed; missing
  `version` fields; results matched by name instead of category; a shape
  mismatch between `summarise()` and `export_plots()` that failed a finished run;
  drag hardcoded as `-Fx`.
- **Run 11 is the first finished run** (drag 0.2096 N). Runs 12 to 15 confirm the
  drag sign fix and that a panel edit reaches the solver.
- Eleven menu items wired to nothing are found by clicking every one.
- The owner rejects the SimScale-coloured Workbench: "it has to be TurboFlow
  vibe". **Rule: keep SimScale's layout, not its paint**; the Workbench uses the
  site's tokens. The view cube becomes a draggable orientation ball.
- `onJobFinished` written so a failed job always marks its run failed.

## 12 September: groups, four steps, no SimScale tree

- The owner: no separate geometry and simulation tabs, no visible triangles,
  auto-place a fluid domain and set up the simulation automatically, settings in
  a sidebar.
- "Why does it take so long?" Import goes from 26 s to 10 s **by keeping warm
  instances**: the geometry service (`turboflow-tessellate`, 8 GiB) and
  `runPrepareDomain` were set to keep one instance running. The 23 s boolean cut
  could not be sped up. The reply warned that warm instances raise the floor bill
  and gave the command to undo it, **but gave no dollar figure**.
- "The negative should not be visible": the viewer now shows the car with a
  translucent tunnel box, not the car-shaped hole.
- **"Stop copying the SimScale UI."** The 14-node SimScale tree is replaced by
  **four steps**: Wheels, Wind tunnel, Mesh, Simulation, plus **Quick setup**.
- **Three views**: Model, Results, Split (resizable), keys 1/2/3.
- **Projects and folders are replaced by groups.** One container, any number of
  simulations in it. Test data deleted ("bro it's all test").
- Uploads silently went missing (a leftover `projectId` prop wrote a null group).
  Found and fixed; the owner's three uploads were reattached.
- A temporary **password sign-in** (`hi@hi.com`) is added at the owner's request
  so agents can test without Google. (Removed 24 Sep.)
- Wheel radius bug: an axle could become a "wheel" of 1.43 mm and spin ten times
  too fast. Fixed.
- **The cut is fixed** on a 29-body car: one compound tool instead of 29 tools,
  98% removed in 7 s instead of 13% and a nine-minute hang. Guards added: a cut
  may not remove more than its tool, nor more than the whole car.

## 13 September: meshing lessons

- Separate front and rear wheel radii. Wheel spin switched off for a while (owner).
- SimScale rejected three fields that belong to a different solver (Pacefish).
  Removed, and the queue now refuses them.
- Out of memory at fineness 9.5 on SimScale's automatic machine; **16 cores is
  above the plan's limit**. Fineness 7 and 8 added as draft rungs. Run 4 is the
  first full 1,000-iteration finish: drag 0.1267 N on half a car, Cd 0.575.
- "The ground is supposed to be 0.1 mm below the wheels": fixed.
- The owner's car is half slivers (342 of 640 faces under 0.25 mm²), all in one
  20 mm band. Raising the small-feature tolerance from 0.5 mm to **2 mm**, and a
  local coarse refinement, did not get it through. The Workbench now **warns
  about slivers at import**, before anyone pays.
- The owner adds 100k credits to the test account ("I'm literally the developer").

## 14 and 15 September: forces, wheels, security

- **Half-car forces doubled**: drag, lift and pitch x2, side, roll and yaw zero,
  moments taken about the mirror plane. Verified to ten decimal places on a real
  run (15 Sep).
- **Rotating wheels fixed**: four wheels on a four-wheel car, named by position,
  spin direction derived from rolling on the road, pick which wheels spin.
- `turboflow-tessellate` redeployed (v63, v64) still with `--min-instances 1`
  (14 and 15 Sep), so the always-on cost carried on without anyone noticing.
- **Security audit pass 1 and pass 2** (`docs/SECURITY_AUDIT.md`). Critical: a run
  was priced from two fields while the solver got the whole document, so 200,000
  iterations could be bought for the price of 3,000. Fixed with `clamp.ts`. Also:
  open redirect on sign-in, CSP never enforced (now enforced), CVEs in the
  functions image, connection tokens able to delete an account, and more.
- 15 Sep: **service accounts split** (`tf-geometry`, `tf-worker`), storage quota
  (5 GiB per account), UI review (`docs/UI_REVIEW.md`), results block redesigned,
  site hygiene pass (pre-rendered HTML, robots.txt, sitemap, structured data;
  `docs/SITE_AUDIT.md`).
- 14 Sep: a long list of UI features was requested (dark mode toggle, cookie
  banner, search, back-to-top, and so on). Twenty components were built in
  `src/components/chrome.jsx` but never mounted, and were deleted on 23 to 24 Sep
  as "things that do not exist".

## 23 September: full test, rate limits, OpenFOAM cases, UI programme

- Full-site function test. Broken: sharing (page crash), race calculator on
  test (its function only exists on production), half tunnels on a real car.
- **Rate limit on every endpoint**, nothing reachable without sign-in (all 33
  endpoints called with no login).
- **OpenFOAM cases**: SimScale returns a raw OpenFOAM case, not VTK. The worker
  now converts the car surface for the viewer and keeps the case for a
  "Download for ParaView" button (results excluded from the storage quota).
- Backups, point-in-time recovery and delete protection switched on for
  turboflow-test Firestore; TTL on `rate`; App Check key registered but not
  enforced.
- **UI programme** started (`docs/UI_PROGRAM.md`): remove what does not exist,
  every design rule as an automated check, no utility-class framework, one
  design system for site and tool.
- The owner: **"I allow you do anything at the site turboflow-test."**

## 24 September: Google only, production backup, switch rehearsal, original look

- Password sign-in removed completely. `hi@hi.com` disabled, not deleted.
- **Full backup of production** to `backups/turboflow-7b3ca-2026-09-24/` (site,
  six functions including the missing `run_lap_calc` source, containers, rules,
  782 documents, 86 accounts). Found: the live site serves its own backend
  source code to anyone; the old worker has the SimScale key in its code.
- "Push the Workbench to production, and be able to revert": a **cutover plan**
  (`docs/PROD_CUTOVER.md`). Owner decisions: rehearse everything first; **stay on
  plain Firebase Auth** (Identity Platform cannot be undone, so the blocking
  sign-up function became the `ensureAccount` callable); test PayPal in sandbox
  first; test the old Fusion add-in against the new backend.
- Rehearsal passed: data conversion forward and back on all 782 records, old
  add-in requests replayed, every rollback step tried on test.
- **Additive production setup** done (invisible to users): Secret Manager, two
  service accounts, `turboflow-geometry` (min 0) and `simscale-worker` (v25)
  under new names beside the originals, storage CORS, PayPal client id.
- "Revert the frontend to the backup": the site pages on turboflow-test were
  made to look exactly like production's original pages while still working with
  the new backend. (Reversed the next day.)

## 25 September: the race-engineering look, rejected

- "Make it unique, not a 1:1 SimScale rip-off." Owner chose "rebuild around car +
  run" and a "new race-engineering look". Built: near-black, signal orange,
  Saira font, step bar, tool rail, run board, and the **Garage** (`/dashboard`).
- Rejected hard: "the new UI is not like the main site, it's so bad", "wrong
  colours, shapes, fonts, designs, UI, UX", "bad layout, poorly built".
- Settled, in quick answers:
  - the **whole site follows DESIGN_RULES.md**, using the 24 Sep rules version
    (from `archive/site-redesign-2026-09-24/`);
  - the **Workbench goes back to its 24 Sep arrangement** using the site's tokens
    (copy in `archive/workbench-simscale-layout-2026-09-25/`);
  - **keep the Garage** as the way into the Workbench.
- Home page rebuilt to the rules; refund policy date fixed; scrollbars fixed.
  Deployed to turboflow-test. **This is the last deploy of the site.**
- "Push" (twice, 25 Sep and later): the clarifying question was dismissed both
  times, so nothing was pushed or switched.

## 27 September: design review, end-to-end runs, the bill, no more Google Cloud

Two sessions ran on the same files this day.

**Session `c5c0fb66` (design review, about 12:45 to 13:47 Dubai time):**
- An "anti-AI-slop" design review spec was applied. Owner: home page "same look
  as turboflow.cloud, rules kept", and copy states **today's facts** (STEP, IGES,
  STL; one simulation per run, no "dozens of variants").
- `/brandkit`, `/web-design-guidelines` and `/redesign-existing-projects` were
  run. `GUIDELINES_REVIEW.md` lists about 200 findings; several were fixed. A
  snapshot was taken first in `archive/design-review-2026-09-27/`.
- A brand kit was published as a private claude.ai artifact without being
  asked. The owner then set the rule **"do not push anything, always work on
  local copies"**. The brand kit was saved to `brand/brand-kit.html`. The online
  copy could not be deleted from that session.

**Session `5d4107fd` (this one):**
- **End-to-end Workbench run** on turboflow-test with a synthetic test account
  (`e2eWorkbenchTest0001`): upload, import, tunnel, queue, mesh (1.08 M cells),
  solve, results, drag 0.318 N. Credits right throughout.
- `car(17.3).step` never meshes (slivers where its nine solids join).
- **Fusion add-in** stamped for turboflow-test, its upload code replayed against
  the test backend (works). But **add-in runs solve and return no drag or lift**:
  SimScale offers no downloadable result for any item of an add-in run. Worker
  images v26 to v30 deployed to test; v26 (honest mesh-failure message), v27 (2 mm
  tolerance on the add-in path) and v28 (null-safe result links) fixed real
  bugs; v29 and v30 were guesses that did not fix the missing results.
- **Google Cloud check**: no budgets, no billing export, and **four always-on
  services on turboflow-test costing about $107 a month idle**:
  `turboflow-tessellate` (4 vCPU, 8 GiB, about $79), `processGeometry`,
  `runPrepareDomain`, `onGeometryUploaded` (about $28 together). Also: 33 GB of
  container images, a Gemini project with two API keys and billing on, two empty
  billed projects, an old Supabase-era job in production.
- The owner: "WHAT?" and **"STOP IT. STOP EVERYTHING."** Then asked how to stop
  the instances in the console, and said they need to **disable everything so
  Google refunds it**. What was then stopped or deleted is UNVERIFIED.
- **"You are restricted to not using Google Cloud for now. It has to cost less
  than $0.10 a month, using Supabase Edge Functions or keeping the tessellating
  thing locally."** A plan was given: Supabase free plan for data, sign-in, files
  and small functions; geometry and worker on the owner's PC.
- "Can the tunnel cut happen just in the website?" Yes. **Built in
  `tools/tunnel-cut/`**: occt-wasm (OpenCascade 8 compiled to WebAssembly) in a
  Web Worker, progress bar, cancel, time and size limits, no upload. It matches
  the server's cut on four real cars, and found two faults the server also has
  (see 07-PROBLEMS.md).

## 3 October

This handbook was written. Nothing else was changed in the project apart from
saving the "local only" rule to the project memory.
