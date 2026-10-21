# 09. Leaving Google Cloud

On 27 Sep 2026 the owner banned Google Cloud ("You are restricted to not using
google cloud for now") and set a target: **TurboFlow must run for under $0.10 a
month**, using Supabase Edge Functions and/or keeping the tessellating work
local. This file is the plan, what exists, and what is still open. Nothing here
is decided beyond what the owner said; the questions at the end are his.

## 1. Why the heavy parts cannot go to Supabase

Supabase Edge Function limits (checked on supabase.com on 27 Sep 2026):
256 MB memory, **2 seconds of CPU time per request**, 150 s wall clock on the
free plan (400 s paid), no Web Workers, no Python.

| Part | What it needs | Fits an Edge Function? |
|---|---|---|
| Geometry service (`/inspect`, `/prepare`) | OpenCascade, up to several GB, 5 to 60 s of CPU per car | No |
| SimScale worker | About 30 minutes waiting on SimScale per run; Python with pyvista and the SimScale SDK to convert results | No (the waiting could be split into short steps on a timer; the conversion cannot) |
| The ~25 small functions (accounts, groups, credits, PayPal, tokens, queueing) | Short requests, a database transaction | Yes |

Supabase free plan (same check): 500 MB database, **1 GB file storage**,
**50 MB per file**, 5 GB of downloads a month, 50,000 monthly users, 500,000
Edge Function calls, 2 free projects, and **a free project pauses after a week
with no activity**.

## 2. The proposed shape

| Part | Today | Proposed | Cost |
|---|---|---|---|
| Website | Firebase Hosting | A free static host (Cloudflare Pages was suggested) | $0 |
| Google sign-in | Firebase Auth | Supabase Auth (needs a free OAuth client from Google's developer console, no billing) | $0 |
| Database and ledger | Firestore | Supabase Postgres, with row-level security and the ledger in SQL transactions | $0 |
| Uploads and results | Cloud Storage | Supabase Storage (1 GB total, 50 MB per file) | $0 |
| Small functions | Cloud Functions | Supabase Edge Functions | $0 |
| **Tunnel cut** | Cloud Run geometry service | **The user's browser** (built, see section 3) | $0 |
| Import, 3D preview, wheels, frontal area | Cloud Run geometry service | The browser (not built yet), or the owner's PC | $0 |
| SimScale worker | Cloud Run job | **One program on the owner's PC** that checks the database for waiting work, does it, and writes results back; nothing connects in to the PC | $0 plus electricity |

The owner's PC can do the PC part: 15 GB of memory, an 8-core Ryzen 7, and
cadquery 2.8.0 already installed (the SimScale SDK is not).

**Catches, stated to the owner on 27 Sep:**
- When the PC is off, imports and runs wait.
- 1 GB of files is a few dozen runs before old files must be cleared (a rough
  estimate).
- A free Supabase project pauses after a week without activity. Whether a PC
  program checking the database counts as activity is **UNVERIFIED**.
- The Fusion add-in has Firebase addresses built in and needs a new version.
- It is days of work: about 5,600 lines of function code to rewrite, the rules
  as Postgres row-level security, the site's one Firebase file
  (`src/lib/firebase.js`) swapped, both Python programs pointed at Supabase.
- Some of it is a move back: the August Supabase migration solved many of the
  same problems (its migrations and edge functions were removed from this repo
  on 10 Sep; a snapshot zip was in `Downloads/cfd_web_supabase.zip` on 9 Sep,
  **UNVERIFIED** whether it is still there).

## 3. What is built: the browser tunnel cut (`tools/tunnel-cut/`)

Built on 27 Sep after the owner asked: "make sure that it doesn't crash the
browser or freeze while cutting the tunnel. Make it have a progress bar. Make the
thing non-cloud based."

**Engine.** `occt-wasm` 5.3.5: OpenCascade **version 8** compiled to
WebAssembly, about 4.5 MB compressed (22 MB unpacked), MIT/Apache wrapper,
LGPL engine (satisfied by loading the `.wasm` from a URL). Chosen over
opencascade.js because that one is on OpenCascade 7.6.2, older than the server's
7.8, and an older kernel is known to have cut only the wheels out of a car.
Needs Chrome or Edge 114+, Safari 17.2+ or Firefox 121+.

**What it does** (`cut-core.js`, ported from the server's `/prepare`):
1. Read the STEP; refuse a file with no solids.
2. Measure; work out the unit (m, cm or mm, whichever makes the car 0.1 to
   0.6 m long).
3. Find the mirror plane from the triangles (half model, whole car, or unsure).
4. Size the tunnel (half or full width; upstream, downstream, side, top; floor
   0.1 mm under the lowest point).
5. Cut, trying the whole car in one pass, then the bodies fused, then body by
   body; each attempt on **fresh copies** of the shapes; retry without the
   bounding-box shortcut if a cut comes back short; up to four mirror-wall
   offsets; every result held to the server's volume checks.
6. Check: removed at least 5% and at most 150% of the car; sealed voids;
   validity; and if OpenCascade will not certify the region, **write the STEP,
   read it back and compare volumes**, refusing a broken result.
7. Write the tunnel as STEP and label its faces from the STEP text (same rules
   and tolerances as the server), producing `entity_labels.csv`.

**Never freezes or crashes the page** (`cut.worker.js`, `main.js`):
- The cut runs in a **Web Worker**; the page never does the heavy work.
  Measured: during a 67 s cut the page never paused more than 41 ms, with no
  long tasks.
- **Cancel** ends the worker immediately; the next job gets a fresh engine.
- Any engine fault: a message, and that worker is thrown away. A fault in the
  car (a `CutError`) keeps the engine.
- 50 MB file limit, 10-minute time limit, engine memory capped at 4 GB by the
  build. Worst car used 382 MB.
- **Progress bar** through the stages (engine, read, measure, cut, check,
  export, label) with what it is doing and the seconds elapsed. The engine
  cannot report progress inside one cut, so the bar slows rather than guesses.
- The file never leaves the computer.

**Results, against the server's own code on the same files:**

| Car | Browser | Server's code |
|---|---|---|
| small test car | 100% removed, 17 faces, valid | identical |
| `car(17.3)` (half model, 9 bodies) | 107,443.50 mm³ removed, 131 faces, valid, 8 to 12 s | 107,443.61 mm³, 131 faces, 19 s |
| `withoutgap` (5 bodies) | 100.0%, 343 faces, valid | identical |
| `finalised combined car` (10 bodies) | 100.6%, 109 faces, not certified but reads back correctly | identical |
| `step_render` (11 bodies) | **refused**: the tunnel reads back broken | "succeeded" at the third wall offset, but its file reads back as two scraps |

**Not ported yet:** turning the car to face the wind, wheel detection and
rotating-wheel labels (wheels are labelled as car), frontal area, the viewer
model and face list. It is a separate test page, not part of the Workbench.

**Run it:** `npm --prefix tools/tunnel-cut run dev`, then http://localhost:5190.
Self-check: `node tools/tunnel-cut/check.mjs`.

## 4. What is left, roughly in order

1. **Owner decisions** (section 5).
2. **Finish the browser geometry**: orientation, wheels (detection and picking),
   frontal area, a face-grouped model and face list for the viewer, so `/inspect`
   and `/prepare` both run in the browser. Then the geometry service is not
   needed at all.
3. **Fix C1 and C2 on the server's copy too** (07-PROBLEMS.md), or retire the
   server copy.
4. **Choose and set up the data platform** (Supabase was proposed), then port:
   schema and row-level security from `firestore.rules`; the ledger, charge,
   reversal and refund as SQL functions in transactions; PayPal; connection
   tokens; groups; simulations and validation; queueing.
5. **The worker on the PC**: the same Python, reading and writing the new
   database, pulling jobs instead of being started by Cloud Run; keep the
   results conversion.
6. **The site's data layer**: replace `src/lib/firebase.js` (one file) with the
   new client, keeping the same small API so the views do not change.
7. **The Fusion add-in**: new addresses and sign-in.
8. **Hosting and domain**: point turboflow.cloud at the new host only when the
   owner says so.

## 5. Open questions for the owner (asked on 27 Sep, not yet answered)

1. **Does the ban cover production?** turboflow.cloud runs on Google Cloud with
   real accounts. If billing goes off there, runs and payments stop.
2. **Is a free Google sign-in key acceptable**, or should sign-in be email only?
3. **Supabase account:** the old one from August, or a new one?
4. **Next step:** finish the browser geometry, or start moving the Workbench's
   data off Google Cloud? (Asked at the end of 27 Sep.)
