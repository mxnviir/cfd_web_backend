# TurboFlow — Firebase rebuild with Workbench

## Context

TurboFlow (turboflow.cloud, Firebase project `turboflow-7b3ca`) is a live CFD service for STEM Racing teams, taking real money through PayPal. The work is split across **two disconnected folders**, and connecting them is the point of this plan:

- `Documents\cfd_web_frontend` — what users actually hit. The original Firebase app: one 4,980-line compiled-React file, no routing, no build step, and a critical money vulnerability.
- `Downloads\turboflow-cfd` — separate work: the **Workbench** (a real SimScale-style CAD/CFD workspace — 3D viewport, simulation tree, 18 setup panels, convergence/forces/compare panes, view cube, field shaders), a tessellation service, a CFD worker, 15 test suites, and a **complete, deployed Supabase migration**.

**Your decisions:** stay on Firebase, abandon Supabase, and get the Workbench running on a newly rebuilt Firebase backend. I raised the cost of discarding the Supabase work; you confirmed. This plan proceeds on that basis and does not revisit it.

**The reframe that makes it affordable:** the Supabase migrations stop being the destination and become the **specification**. Migrations `0022`, `0023`, `0024` already solve the exact money bugs the live Firebase backend still has — worked out, documented, and applied. We reimplement that logic on Firestore rather than rediscovering it. Nothing in `supabase/` gets deleted until the Firebase equivalent passes the ported tests.

---

## The sign-in bug you opened with — now explained

You asked at the start of this session why you can't sign in. Root cause found and confirmed:

Google sign-in fails with **`Error 400: redirect_uri_mismatch`**. `https://turboflow-7b3ca.firebaseapp.com/__/auth/handler` is not registered on OAuth client `659747979647-n5aqp6li9jngnjkpi4u4hi7qr0jcfpd5`.

The Supabase docs list "enable Google sign-in" as the one blocker holding up everything, read `false` for 22 consecutive checks. I checked live: **`external.google` is now `true`** — someone enabled it since. Both stacks share that one OAuth client. The Supabase callback was added and the Firebase handler is now gone: **a replace where an append was needed.** An OAuth client supports many redirect URIs; both can coexist.

**Fix (5 minutes, unblocks everything, do it first):** at `console.cloud.google.com/apis/credentials?project=turboflow-7b3ca`, open that client and **add without removing anything**:
```
https://turboflow-7b3ca.firebaseapp.com/__/auth/handler
```

---

## Verified state

Established by reading code and probing live systems — not inferred from docs.

| | State |
|---|---|
| **turboflow.cloud** | Old Firebase app. Dev-mode React (~1.1 MB), Tailwind CDN JIT (~300 KB), 5 compat SDKs, 27 MB autoplaying hero video. Carries the refund vulnerability. |
| **Firebase sign-in** | **Broken** — see above. |
| **Supabase backend** | Deployed and live. Being abandoned per your decision. |
| **Workbench** | Built, **never seen in a browser by a real user**. `/workbench.html` on prod returns the SPA catch-all (8,792 bytes = `index.html`) — none of it is live. |
| **Version control** | **None in either folder.** `CONTEXT.md:3` says the canonical working tree is `C:\Users\shash\Desktop\cfd_web_supabase\cfd_web_supabase` — `Downloads\turboflow-cfd` is a *snapshot*. Find the real tree before anything else. |
| **`.env.deploy`** | Holds live secrets, but **is** correctly gitignored (`.env.*` matches it — I verified with `git check-ignore`). |

### Security findings on the live Firebase stack

| # | Sev | Finding |
|---|---|---|
| 1 | **Critical** | `functions/index.js:176` — `const amount = job.cost ?? 100;` reads the refund amount off a client-authored doc. `firestore.rules:102-109` constrains only `userId` and `status` on job create. Any signed-in user creates `jobs/x` with `{userId: self, status:'pending', cost: 1e9}`, calls `refundJob`, takes the credits, and the doc is deleted at `:185` — destroying the evidence. **Supabase `0022` already fixes this; port that logic.** |
| 2 | **Critical** | `storage.rules:20` — `allow create, update: if isSignedIn()` on `jobs/{jobId}/**`. Cross-tenant overwrite of anyone's geometry or results, no size or content-type cap. **Supabase `0011`+`0019` solved this with a uid path segment; port it.** |
| 3 | **High** | `firebase.json` `"public": "."`. Verified: `https://turboflow.cloud/functions/index.js` returns **200 with the full backend source**. 14 files ship, including `functions/package-lock.json` and `.claude/settings.local.json`. |
| 4 | **High** | **`queued` jobs charge and never run.** `submitSimulationJob` writes `status:"queued"`; `onNewJob:236-239` only dispatches on `"pending"`. 100 credits per click, no simulation. **This bug was ported into Supabase too** — same defect in both stacks, so fix it in the design, not the string. |
| 5 | **High** | The "Fusion 360 Connection Token" shown on screen and clipboard-copied (`app.compiled.js:1467, 1524, 1668`) is `auth.currentUser.refreshToken` — long-lived, unscoped, not user-revocable. |
| 6 | **Medium** | Live `PAYPAL_SECRET` + `DISCORD_WEBHOOK_URL` in plaintext `functions/.env`, no Secret Manager. |
| 7 | **Medium** | Discord webhook fires at `onNewJob:208-233` *before* validation, unbounded client strings. |
| 8 | **Medium** | Account create grants `credits == 50` (`firestore.rules:62`) with no `email_verified` check. Farmable. |
| 9 | **Medium** | Refunds delete the job doc, but `storage.rules:21` gates storage on that doc existing — refunded jobs' geometry is orphaned and undeletable. |
| 10 | **Medium** | **No PayPal webhook** (missing in both stacks). If the buyer closes the tab after approving, money is taken and no credits are granted. `app.compiled.js:4229` has a hand-written apology for it. |

**Correct already — port verbatim, do not rewrite:** `capturePayPalOrder` (`functions/index.js:546-673`) does server-side capture with amount/currency reconciliation against a server-written intent doc, idempotent in a transaction. `onNewJob` numeric clamping (`:263-266`) is sound.

---

## What abandoning Supabase costs

Stated once, as scope — not as argument. Three components speak Supabase and each needs its data layer swapped back:

1. **6 edge functions** → rewritten as Firebase callables. Their logic is the spec.
2. **`tessellate/main.py`** — Cloud Run STEP→GLB via CadQuery/OCC. Swap Supabase Storage I/O + Supabase Auth verification for Firebase Storage + Firebase Auth. **The OCC core is untouched** (~60 lines change). Keep `owned_path()`'s strict per-segment regex — it exists to defeat `%2e%2e` traversal and is correct.
3. **`docker jobs/simscale_job.py`** — the CFD worker, already ported once to Supabase. Point data access back at Firestore/Firebase Storage.

---

## The Workbench integration — the actual link

Workbench's backend surface is **small and concentrated**. `workbench.html` is 136 KB, but nearly all of it is UI, 3D and rendering — backend-agnostic. The data layer is ~50 lines at `workbench.html:1492-1545`:

```js
const [p, g, s, j, u] = await Promise.all([
  sb.from("projects").select("*").order("created_at"),
  sb.from("geometries").select("*").order("created_at"),
  sb.from("simulations").select("*").order("created_at"),
  sb.from("jobs").select("*").order("created_at", { ascending: false }),
  sb.from("users").select("credits, sponsored, sponsor_rate, unlimited_until")
    .eq("id", me.id).maybeSingle(),
]);
```
plus `sb.channel("workbench")` on those four tables, and `sb.auth.getSession()` / `onAuthStateChange`.

**Approach: a Firestore-backed adapter exposing the same five verbs**, so `workbench.html`, `workbench-panels.js`, `workbench-results.js`, `wb-viewcube.js` and `cfd-setup.js` change as little as possible. You already have `supabase-firebase-shim.js` going Firebase→Supabase; this is its mirror, and smaller.

| Workbench call | Firestore |
|---|---|
| `sb.from(t).select("*").order(c)` | `getDocs(query(collection(db,t), orderBy(c)))` |
| `.eq("id", uid).maybeSingle()` | `getDoc(doc(db,'users',uid))` |
| `sb.channel().on("postgres_changes", …)` | `onSnapshot` per collection |
| `sb.auth.getSession()` / `onAuthStateChange` | `auth.currentUser` / `onAuthStateChanged` |

Two things get *better*: Firestore realtime is per-document and incremental rather than "any change → refetch all five tables", and `onSnapshot` needs no channel-stacking guard (the bug described at `workbench.html:1533-1536` cannot occur).

**Schema** — recreate as Firestore collections, from migrations `0015`/`0016`/`0017`/`0018`/`0021`:

```
projects     { id, user_id, name, description, created_at, updated_at }
geometries   { id, project_id, user_id, name, step_path, label_path, glb_path,
               size_bytes, face_count, solid_count, triangle_count, wheel_count,
               bbox, derived_from, edit_ops, created_at }
simulations  { id, project_id, geometry_id, user_id, name, inlet_velocity,
               refine_level, iteration_count, debug_mesh, setup, created_at }
jobs         { …existing…, project_id, simulation_ref, results_glb_path,
               results_fields, plots, setup_snapshot, drag_n, lift_n, paraview_url }
users        { credits, sponsored, sponsor_rate, unlimited_until, … }
```

`0015`'s insight carries over: `jobs` already *is* a run, so this only adds the three levels above it. Jobs with null `project_id`/`simulation_ref` show as "Unfiled". `setup_snapshot` on the job matters — without it, editing a simulation silently rewrites the conditions every past run is labelled with, and the compare table starts lying.

> **Field naming — settle in Phase 0.** Workbench and both Python services use snake_case (`drag_n`, `inlet_velocity`, `refine_level`, `label_path`, `results_glb_path`). The live app uses camelCase (`drag_N`, `inletVelocity`, `refineLevel`). **Recommendation: snake_case**, migrating the old app's fields — snake_case is the larger body of code and the old app's usages sit in files being rewritten anyway. Keep jsonb-style blobs (`setup`, `plots`, `bbox`, `lap_calc_defaults`) camelCase internally, as Supabase did. A half-converted schema silently mislabels a drag number, so this must be decided before Phase 3.

`cfd-setup.js`, `workbench-panels.js`, `workbench-results.js`, `wb-viewcube.js` are **pure functions over plain objects** — no backend coupling. They port unchanged.

---

## Target architecture

```
turboflow/                     # ONE repo, version controlled
  package.json  vite.config.js  tailwind.config.js
  .env.production  .env.test
  public/          logo.png  hero-poster.jpg  hero-background.mp4 (re-encoded)
  pages/           index.html  simulations.html  billing.html  lap-calculator.html
                   docs.html  workbench.html  legal/{terms,refund,sponsorship-policy}.html
                   404.html
  src/
    firebase.js    modular v10 SDK (not compat — compat defeats tree-shaking)
    auth.jsx       AuthProvider — the ONE user-doc listener
    shell.jsx  nav.js  icons.jsx  status.js
    workbench/     adapter.js  ← the Supabase-shaped → Firestore link
                   panels.js  results.js  viewcube.js  cfd-setup.js  (ported as-is)
    pages/         one .jsx per page
  functions/src/   TypeScript, Functions v2
    lib/           guard.ts  validate.ts (zod)  ledger.ts  ratelimit.ts  pricing.ts
    jobs/          submit.ts  refund.ts  onJobPending.ts  dispatch.ts
    paypal/        createOrder.ts  captureOrder.ts  applyPurchase.ts  webhook.ts
    geometry/      createUploadIntent.ts
  services/
    tessellate/    main.py — storage I/O + auth swapped to Firebase
    simscale-job/  simscale_job.py — data access swapped to Firebase
  tests/           15 suites ported from Downloads\turboflow-cfd\tests
  supabase/        KEPT read-only as the specification. Deleted last.
  dist/            build output — the ONLY thing hosting serves
```

**Key decisions**

- `firebase.json` `public` → `"dist"`. Closes finding #3 structurally, not by ignore-glob.
- **No blanket rewrite.** Today `** → /index.html` makes `/billing` silently render home *and* is why `/workbench.html` returns `index.html`. Replace with `cleanUrls: true` and a real `404.html`.
- **Vite multi-page.** This is what makes Workbench viable — it needs three.js and a GLB loader that no other page should pay for.
- **Restore JSX.** `app.compiled.js` is compiled output being hand-edited; `STATUS_META` has a duplicate `cancelled` key and an invalid `rgba(255,133,133,08)` precisely because nobody can read `React.createElement` soup.
- **`zod`** for function input validation. Hand-rolled guards are how finding #1 happened.
- Also delete `vercel.json` — the repo carries two mutually exclusive hosting configs and no doc mentions Vercel.

---

## Phase 0 — Foundations (blocks everything, ~1 day)

1. **Fix Google sign-in.** Add the Firebase handler URI back, without removing the Supabase one. Nothing is testable until this is done.
2. **Find the canonical git repo.** `CONTEXT.md:3` points at `C:\Users\shash\Desktop\cfd_web_supabase\cfd_web_supabase`. If a repo exists there, work from it. If not: `git init`, commit current state as the baseline, push private. Confirm `functions/.env` and `.env.deploy` are excluded **before** the first commit.
3. **Consolidate into one repo.** The Downloads copy is a snapshot and is newer/larger; reconcile against the canonical tree, then bring across whatever is authoritative from `Documents\cfd_web_frontend`.
4. **Rotate** the SimScale API key (committed in source, inside the old container image) and the Google OAuth client secret. Both have been in plaintext for months.
5. **Settle field naming** (snake_case recommended).

## Phase 1 — Stop the bleeding on prod (independently shippable, ~1 day)

Minimal diffs to existing JS so it ships fast. These are the first commits of the rewrite, not throwaway work. **Port the logic from Supabase `0022`/`0023`/`0024` — it is already worked out.**

1. **`refundJob`: amount from the ledger.** `onNewJob:295` already writes a server-authored `{type:"simulation_charge", amount:-chargeable, jobId}`, and `firestore.rules:119` blocks all client writes there. Sum charge rows for the job, subtract prior refunds, refund the difference. A forged job has no charge row → refunds **zero**. Also **branch on status, not `simulationId`** (0022's second fix: `simulationId` isn't written until `meshing`, but work starts at `downloading`, so the old branch deleted jobs the worker was mid-flight on — full refund to the user, up to 2h of SimScale compute billed to you). And **stop deleting the job doc** — set `status:'cancelled'`, fixing finding #9.
2. **Charge idempotency** (from `0023`): a uniqueness guard on one `simulation_charge` per job, plus an early return inside the transaction.
3. **`!('cost' in request.resource.data)`** in `validPendingJobCreate`. Survey existing `jobs` docs first to confirm the Fusion add-in doesn't write `cost`.
4. **`storage.rules`: `allow update: if false`** plus size and content-type caps. Denying `update` alone kills cross-tenant overwrite with zero add-in impact.
5. **Move the site into a subdirectory**, set `public` to it. Stops serving `functions/index.js` today. Delete `script.js`, `style.css`, `tmp_*.png`.
6. **Rotate `PAYPAL_SECRET`/`DISCORD_WEBHOOK_URL`**, move to Secret Manager, add `.env` to `functions/.gitignore`.

## Phase 2 — Test environment (blocks 3 and 4)

- Second Firebase project `turboflow-test`, Blaze, **$5/month budget alert**. A separate project, not a preview channel — preview channels share prod's Firestore, Storage and Auth, so they'd test new rules against live money and live user data. Note all Supabase work was done directly against production with throwaway accounts; this is the fix for that.
- Enable Google auth and **verify the redirect URI is registered at creation** — exactly what is broken on prod.
- `.firebaserc` with **`default` → test**, so a bare `firebase deploy` can never hit production.
- **`PROJECT` is hardcoded at `functions/index.js:11`** — must become `process.env.GCLOUD_PROJECT` or test will dispatch **prod's** Cloud Run job.
- Derive `PAYPAL_ENV` from the project id rather than configuring it — makes "test charged a real card" structurally impossible.
- Set TTL policies (`paypal_orders.expireAt`, `rate.expireAt`) — project-level GCP settings a fresh project silently lacks. Also **version the Storage bucket config** (size/MIME limits), which Supabase never did.
- `scripts/seed.mjs` — pricing config, three users (normal/sponsored/unlimited), ~25 jobs spanning every status, and a geometry + simulation + completed job **with `plots` and `results_glb_path`**, so Workbench's results panes have something real to render.

## Phase 3 — New Firebase backend (TypeScript)

Port function by function, each keeping its external contract. Use the Supabase migrations as the reference implementation.

- `lib/ledger.ts` — the only writer of `credits` and `transactions`.
- `lib/guard.ts` — auth + App Check + per-uid rate limit on every callable.
- **PayPal: port `capturePayPalOrder` verbatim**, then add the **verified webhook** (`/v1/notifications/verify-webhook-signature`) that neither stack has. Keep Supabase's extra check that the *capture* status is COMPLETED, not just the order — an eCheck or fraud-hold reads order-COMPLETED while the capture is PENDING, and crediting there hands over credits before funds settle.
- **One charging site, fixing finding #4.** Replace `onDocumentCreated` with `onDocumentWritten` dispatching on the transition *into* `pending` (guard against self-re-entry — the handler writes back to the same doc). Fusion creates `pending` → fires unchanged. Workbench creates `draft`, uploads, then flips to `pending`. This kills the `queued` bug and creates the Workbench intake seam in one change.
- **Reverse the charge if dispatch fails** (from `0024`) — including the missing-credentials branch, where Supabase charges and returns without reversing.
- Jobs carry `source: 'fusion' | 'web'`. Move account creation server-side (`beforeUserCreated`), fixing finding #8.
- **Port the 15 test suites.** Must-have: a regression test asserting a forged `jobs/x` with `cost: 1e9` grants **zero** credits.

## Phase 4 — Vite multi-page frontend

1. **Scaffold** — Vite MPA, Tailwind at build time, modular Firebase SDK, `AuthProvider`, shell, nav, icons, `status.js` (dedupe `cancelled`, fix the invalid `rgba`). Bridge unmigrated views via `?view=` so this is not a big bang.
2. **Legal ×3 first** — static, no Firebase, and they deliver shareable policy URLs that are currently impossible (PayPal merchant compliance wants them). Best proving ground.
3. **docs, sponsorship, mentorship, modelling.**
4. **home** + the video: it sits behind a 70–90% opacity scrim, so almost none of the 27 MB is visible. `hero-poster.jpg` already exists in the Downloads folder — prefer the still; if motion is required, re-encode to ≤2.5 MB with `preload="none"`. Now loads only on `/`.
5. **billing** — PayPal SDK becomes page-scoped.
6. **simulations** — after Phase 3, written against the corrected refund contract once.
7. **lapcalc.**
8. **Delete** `app.compiled.js` and ~500 dead lines: `ProfileView`, `OrderTracker`, `ResultsView` (fabricates Cd/Cl from `Math.sin` — must not reach production again), `runLapSim`/`CO2_DATA`, the client-side credit mutators at `:51-128`.

## Phase 5 — Workbench on Firebase

1. **`src/workbench/adapter.js`** — the Supabase-shaped→Firestore layer (~150 lines).
2. **Port `cfd-setup.js`, `workbench-panels.js`, `workbench-results.js`, `wb-viewcube.js`** unchanged.
3. **`pages/workbench.html`** as a real Vite entry, three.js and the GLB loader in its own chunk. It gets a genuine `/workbench` URL for the first time.
4. **Geometry intake**: `createUploadIntent` mints the geometry id and writes an owner claim *before* upload — which also unlocks the strict owner-scoped storage rule deferred in Phase 1. Keep Supabase's key insight: the storage path is keyed by **geometry, not job**, because the worker deletes its own job folder and a second run was downloading a file the first had cleaned up.
5. **`services/tessellate`** — swap storage I/O and token verification to Firebase. OCC core untouched.
6. **`services/simscale-job`** — data access back to Firestore.
7. Wire `plots`, `results_glb_path`, `results_fields` and `setup_snapshot` through the new job schema so the results panes light up.

## Phase 6 — Cutover

Deploy functions to prod under the same export names (old frontend keeps working) → backfill, build indexes, wait for READY before shipping any `orderBy` query → deploy the Vite site → clean up orphaned storage → delete `functions/.env` → **delete `supabase/` only once the Firebase equivalents pass the ported tests.**

---

## Carried forward — known issues to decide, not silently inherit

- **93 historical runs carry ~10% under-reported drag** (`HANDOVER.md:299-318`) — a fuzzy column match took `PRESSURE_FORCE_X` over `TOTAL_FORCE_X`, dropping skin friction. Leave / flag in UI / recompute. **Your call — it changes users' visible numbers.**
- **`/infer_labels` is proven non-functional** — STEP entity ids cannot be recovered, disproven across three independent OCC routes (`FINDINGS.md:213`, WORKPLAN passes 20–22). There is a DO-NOT-DEPLOY note in `step_ident()`. Needs XCAF or a join key agreed with SimScale. Until then, users must supply `entity_labels.csv` by hand — and without it **no boundary conditions are created at all**.
- **C3 face-picking**: viewer half done, service half written but never executed. The BC-assignment UI is not built.
- **C5 plot-over-line is impossible** on surface-only data. Recorded as "do not fake the SimScale version."
- **Workbench has never run in a browser** — every claim about it is code-level or headless. Budget for first-contact bugs.
- **`preview: true` skips the lap-calc charge** on client say-so.
- Results storage runs ~10–20 MB per run; plan retention before this reaches many users.

## Verification

- **Phase 1:** an emulator test that **fails against current `functions/index.js` and passes after** — that is the proof the refund fix is real. Rules test: user B cannot write `jobs/<A's id>/geometry.step`. `curl` for `/functions/index.js` must return **404**.
- **Phase 0/2:** sign in end to end — the check that catches the OAuth redirect URI.
- **Phase 4:** per page — build, serve `dist/`, drive it in the browser, console clean. **Deep-link to each URL and hard-refresh** — the current app cannot do this at all. Targets: initial JS under ~200 KB gzipped per page (from ~2.5 MB); hero under 3 MB (from 27 MB).
- **Phase 5:** the definition of done — load a real STEP through the browser → tessellate → render → set parameters → run → watch status advance → see convergence, forces and compare panes populate. **This full round trip has never once been executed on any stack.**

## Risks

- **Three services must be un-ported from Supabase.** Main cost of the Firebase decision and the likeliest source of slip.
- **Field-naming split** is the highest-risk silent bug here. Settle it in Phase 0.
- **The docs are stale in places** — `workbench.html` is 136 KB not the documented 49 KB; migration counts, test counts and the theme all disagree between files; `FINDINGS.md`'s "Open" section lists items long since fixed. Trust the code over the docs.
- **Two undocumented contracts:** what `simscale-job` reads/writes on the job doc, and `run_lap_calc`'s request/response shape. Capture both before Phase 3 changes the job schema.
- **Phase 1 touches live money code.** Every change ships behind an emulator test; `capturePayPalOrder` is ported verbatim, not rewritten.
