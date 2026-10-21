# 06. Decisions

Three parts: the thinking behind how TurboFlow is built, the decisions in force,
and the decisions that were made and then reversed or dropped. Dates are 2026.
"Owner" means Shashank; where a decision was his, his words are quoted when they
were short and clear.

## Part 1. The thinking behind the build

These ideas run through the code. Most of them came from a bug that hurt.

1. **CFD is silently wrong more often than it is loudly wrong.** A solver given
   a bad setup does not crash: it converges and prints a plausible drag. A
   boolean cut that removed nothing still meshes. A field read under the wrong
   name shows an empty panel, not an error. So the code **measures its own
   results** (the cut must remove about the car's volume, the tunnel file must
   read back as the same shape, forces must double exactly) and refuses rather
   than guessing.
2. **Money is server-only.** The client can propose; it can never decide a
   price, a balance, a refund or a status. One module (`lib/ledger.ts`) changes
   balances, always with a ledger row. Refunds come from the ledger, never from
   anything a user wrote. This came from the original app's refund hole, where
   anyone could mint credits.
3. **Charging and starting a run are one event.** The original app charged in
   one place and started work in another, so web jobs were billed and never ran.
   Now the move into `pending` does both, and a failure to start gives the
   money back.
4. **Pay for what runs.** What the solver receives is cut to what was priced
   (`clamp.ts`). Before that, a setup could buy 200,000 iterations for the price
   of 3,000.
5. **Snapshot at queue time.** A run keeps the exact setup it was solved with,
   so editing the simulation later cannot relabel an old result and make the
   comparison table lie.
6. **Test what ships.** Two of the worst bugs came from the container having a
   different library version than the dev machine (cadquery 2.5.2 vs 2.8.0,
   pyvista 0.44 vs 0.45). Tests import or lift code out of the real shipping
   files, library versions are pinned and treated as load-bearing, and every new
   check is first shown to fail on a known-bad case ("mutation tested").
7. **Say it in the user's words.** A user must never see a Python exception.
   Errors say what is wrong and what to do (which part of the car has slivers,
   where on the car a bad face is). The technical text is kept beside it for
   support.
8. **Nothing that does nothing.** A button that does nothing, even one that
   explains why, is removed. A menu item wired to nothing is a bug. Fake
   numbers, fake evidence, invented defaults are banned (DESIGN_RULES.md 1.8,
   and spec ground rule 2: "do not invent numbers").
9. **Keyless for users.** Teams never need a SimScale account; the key lives on
   the server only and never reaches a browser, a log or the repo.
10. **Production is sacred.** Production is changed only when the owner says so,
    with a rehearsed plan and an undo for every step. Everything new is proved
    on a separate test project first.
11. **One product, one look.** The site and the tool follow one set of design
    rules (`DESIGN_RULES.md`) and share tokens; the owner rejected a tool with
    its own identity.
12. **The owner stays in control.** Plain English, no subagents (so every
    reading and conclusion is visible), local only, nothing published or
    deployed without being asked, one short question when instructions conflict.
13. **Cost matters as much as correctness** (since 27 Sep). Anything that runs
    while idle, or bills per hour, needs the owner's explicit agreement with a
    dollar figure. The current target is under $0.10 a month.

## Part 2. Decisions in force

### Platform and environments

| Decision | Date | Why | Where |
|---|---|---|---|
| **No Google Cloud** for now: no `gcloud`, no `firebase deploy`, nothing on either project | 27 Sep | Owner found always-on services costing about $107 a month and is seeking a refund: "You are restricted to not using google cloud for now." | Memory `turboflow-no-google-cloud` |
| **Target cost under $0.10 a month**, using Supabase's free plan and/or the browser and the owner's PC | 27 Sep | Same | 09-NO-CLOUD-PLAN.md |
| **Local only**: never push, deploy or publish (git push, Firebase deploy, claude.ai Artifacts, any remote service) unless asked in that message | 27 Sep | A brand kit was published without being asked | Memory `local-only-no-push` |
| The tunnel cut can run **in the browser** with occt-wasm (OpenCascade 8 in WebAssembly), in a Web Worker, with a progress bar and cancel, no upload | 27 Sep | "make sure it doesn't crash the browser or freeze ... make the thing non-cloud based" | `tools/tunnel-cut/` |
| A separate test project `turboflow-test`, not a preview channel | 9 Sep | Preview channels share production's database, storage and accounts | `.firebaserc` |
| Production (`turboflow-7b3ca`) is changed only on the owner's word ("switch") | 12 Sep onward ("no" to deploying) | It has real users and money | Standing |
| Production switch, when it happens: rehearse first, stay on plain Firebase Auth (Identity Platform cannot be undone), PayPal sandbox first, old Fusion add-in tested against the new backend | 24 Sep | Owner's four answers | `docs/PROD_CUTOVER.md` |
| New production pieces are added beside the originals under new names (`turboflow-geometry`, `simscale-worker`) | 24 Sep | So a rollback still has the originals | `functions/.env.turboflow-7b3ca` |

### Product

| Decision | Date | Why |
|---|---|---|
| **Queue mode**: set everything up in TurboFlow, press Queue, one backend job does the whole SimScale trip; nothing touches SimScale before Queue | 10 Sep | Owner: "a person can upload the model, create the simulation, and queue it" |
| **Keyless**: users never need a SimScale account or key | 10 Sep | Owner: "I want the workbench to be keyless" |
| **Every project private**, no public library | 10 Sep | Simplest; avoids one team copying another's car |
| Uploads: **STEP, IGES, STL**; SimScale always receives **STEP** | 10 Sep (and 9 Sep "STEP ONLY" for what is solved) | The geometry service can read these; STEP keeps face ids stable |
| The Workbench takes **a raw car** and TurboFlow builds the tunnel | 9 Sep | Owner: "you will actually import the car by your own and move around the wind tunnel box" |
| Wheels: **auto-detect** like the add-in **or pick faces** like SimScale; picking replaces detection | 9 Sep | Owner |
| Select **faces, not triangles** | 9 Sep | Owner |
| **Half or full tunnel per simulation**, default half | 9 Sep | Owner chose "let the user choose" |
| Show only the **final** field write, picked by time step, not file size | 9 Sep | Owner chose "export the final write only, fix today's bug" |
| **Groups** replace projects and folders; any number of simulations per group | 12 Sep | Owner: "get rid of the project system like SimScale. You only have groups." |
| **Four setup steps** (Wheels, Wind tunnel, Mesh, Simulation) and **Quick setup** from saved defaults, instead of SimScale's 14-node tree | 12 Sep | Owner: "Stop copying the SimScale UI"; "the website should go step by step" |
| **Three views**: Model, Results, Split, resizable | 12 Sep | Owner |
| The viewer shows **the car with a translucent tunnel box**, never the car-shaped hole | 12 Sep | Owner: "it creates the negative and shows it to the user. That is NOT supposed to happen." |
| **Separate front and rear wheel radii** | 13 Sep | Owner |
| **Road 0.1 mm under the wheels** | 13 Sep | Owner: "the ground is supposed to be 0.1 mm below the wheels" |
| **Wheels spin by default**, at road speed, direction derived from rolling; any wheel can be left still | 14 Sep (off on 13 Sep while other things were fixed) | Owner: "fix the half-forces AND the rotating wheels ... select which wheels to rotate" |
| **Whole-car forces** from a half model (drag, lift, pitch doubled; side, roll, yaw zero) | 14 Sep | A team pastes the drag into the race calculator; half the drag gives the wrong lap time |
| Mesh **small-feature tolerance 2 mm** | 13 Sep | Real CAD has slivers the mesher refuses; 2 mm is under 1% of a car |
| **Draft mesh rungs 7 and 8**, priced as level 1 | 13 Sep | Owner: "set the mesh coarseness to 7"; the cheapest way to get a run through |
| Processors left to SimScale (`-1`) | 13 Sep | 16 cores is above the plan's limit |
| Keep **viewer files and the full OpenFOAM case** for each run, with a "Download for ParaView" button; results do not count towards the storage quota; the case expires on a bucket lifecycle rule (length **UNVERIFIED**) | 23 Sep | SimScale returns an OpenFOAM case, not VTK; TurboFlow kept nothing before |
| The **Garage** (`/dashboard`) is the way into the Workbench; one "Workbench" link in the site navigation | 25 Sep | Owner: "make the garage as the way to the workbench" |
| Copy states **today's facts**: STEP, IGES, STL; one simulation per run | 27 Sep | Owner, design review |

### Security and accounts

| Decision | Date | Why |
|---|---|---|
| **Google is the only sign-in** | 9 Sep, enforced in code 24 Sep | Owner; no farmable password accounts |
| Accounts are created by the server (`ensureAccount`), 50 credits | 24 Sep | Rules cannot know "is this your first account" |
| **Connection tokens** for the add-in, revocable, worth less than a person | 9 Sep | The old token was the whole account's credential |
| Every endpoint rate limited, nothing reachable without sign-in except the two that must be public (token exchange, PayPal webhook) | 23 Sep | Owner |
| Separate service accounts for the geometry service and the worker | 15 Sep | A parser bug must not reach every account |
| Content-Security-Policy enforced | 14 to 15 Sep | Report-only blocked nothing |
| Storage quota 5 GiB per account | 15 Sep | Free sign-up made storage an unmetered bill |
| Only production can reach live PayPal | 9 Sep | A test deploy must never charge a real card |

### Data and code conventions

| Decision | Date | Why |
|---|---|---|
| **Firestore is snake_case**; the client converts top-level keys; nested blobs keep the writer's shape | 9 to 10 Sep | The larger body of code spoke snake_case; one conversion point |
| One shared price formula in two copies (server and browser) **with a test that they agree** | 10 Sep | The price on the button must be the price charged |
| Results and uploads live under `users/{uid}/...` | 12 Sep | Storage rules cannot look ownership up in Firestore here |

### Design

| Decision | Date | Why |
|---|---|---|
| **DESIGN_RULES.md is the source of truth** for the site **and** the Workbench | 9 Sep (site), 25 Sep (both) | Owner: "make the site as per the rules, re-audit and fix the full site based on the md file" |
| **One design** for site and tool; the Workbench uses the site's tokens and buttons, keeps a smaller type scale because it is dense | 25 Sep | The separate tool look was rejected |
| The site is the **23 to 24 Sep rules version**; the Workbench is its **24 Sep arrangement** | 25 Sep | Owner's answers after rejecting the race look |
| Home page: **same layout as turboflow.cloud, rules kept** | 27 Sep | Owner, design review |
| Fonts: **IBM Plex Sans and IBM Plex Mono**; Inter banned | 9 Sep | DESIGN_RULES.md 1.4 |
| **No Tailwind, no utility classes**, plain CSS on custom properties | 10 Sep (Tailwind), 23 Sep (utilities) | DESIGN_RULES.md 1.10 |
| **Light and dark themes**, each designed, contrast measured | 10 Sep | DESIGN_RULES.md 3.5 |
| Every mechanically checkable design rule is a script (`scripts/*-audit.mjs`) | 9 to 23 Sep | A checklist nobody can run is a checklist nobody runs |

### Working with agents

| Decision | Date |
|---|---|
| Plain English, "not claudish" | 9 Sep |
| No subagents: "no agents allowed, it's a rule" | 9 Sep |
| No bash heredocs for code with backslashes | 24 Sep |
| No Claude attribution anywhere | Global rule |
| Ask one short multiple-choice question when instructions conflict; keep a private copy of anything replaced | 25 Sep |

## Part 3. Decisions made, then reversed or dropped

| What | Made | Changed | Why it changed |
|---|---|---|---|
| **Move the backend to Supabase** | Aug (other machine) | Abandoned 9 Sep ("stay on Firebase"). **Back on the table 27 Sep** as the cheap target | 9 Sep: the live app was Firebase and the Supabase stack was never reachable. 27 Sep: Google Cloud cost |
| **Firebase and Google Cloud as the platform** | 9 Sep | Frozen 27 Sep | Cost, refund |
| "Match the main app exactly", "leave the fonts as is" | 9 Sep 15:28 | The same day, by DESIGN_RULES.md | The rules ban what the main app used (Inter, dot grid, blur, gradients) |
| **Copy SimScale exactly** (spec ground rule 1; "for the Workbench, matching SimScale wins over DESIGN_RULES.md") | 10 Sep | 11 Sep: keep SimScale's *layout*, not its paint. 12 Sep: "stop copying the SimScale UI". 25 Sep: "make it unique, not a 1:1 SimScale rip-off" | The owner wanted a TurboFlow product, step by step, not a SimScale clone |
| **Projects and folders** (SimScale's model) | 10 Sep spec | Groups, 12 Sep | One container is enough when a simulation is one car in one tunnel |
| **SimScale's 14-node simulation tree** | 10 Sep | Four steps, 12 Sep | A first-time team needed four of the fourteen |
| **Show the flow region** (the car-shaped hole) in the viewer | 9 to 12 Sep | Car plus translucent box, 12 Sep | Owner |
| **Post-processing service and full post-processor** (cutting planes, streamlines, statistics) | 10 Sep spec | Never built. Replaced by an honest results panel and a ParaView download | SimScale returns an OpenFOAM case, so it is real work, and the owner's priorities moved |
| **CAD Edit mode** (delete body, transform) | 10 Sep spec | Never built in the UI; `/transform` exists, unused | Priorities |
| **Cloud Tasks** queue for processing uploads | Spec 14.2 | Fire-and-forget authenticated HTTP | Needed per-environment setup and behaved differently in the emulator |
| **`beforeUserCreated`** blocking sign-up function | 9 Sep | `ensureAccount` callable, 24 Sep | Blocking functions need Identity Platform, which production lacks and which cannot be undone |
| **`claimSignupBonus`** for password accounts | 14 Sep | Deleted 24 Sep | Password accounts were removed |
| **Temporary password sign-in** (`hi@hi.com`) | 12 Sep, owner asked for it | Removed 24 Sep, account disabled | Owner: "remove the password based sign in fully" |
| **Twenty site features** (cookie banner, search, back to top, progress bars, floating contact button, and more) | 14 Sep request | Built in `chrome.jsx`, never mounted, deleted 23 to 24 Sep | They did not exist on screen; the UI programme removes what does not exist |
| **Site pages back to production's original look** | 24 Sep, owner | Reversed 25 Sep to the rules version | Owner wanted the whole site to follow DESIGN_RULES.md |
| **Race-engineering look** for the Workbench and Garage (near-black, orange, Saira, step bar, tool rail) | 25 Sep, owner chose it | Rejected the same day: "wrong colours, shapes, fonts, designs, UI, UX" | It did not look like the site |
| **Warm instances** (min 1) on the geometry service and three functions | 10 to 15 Sep, for "make it faster" | Judged a mistake 27 Sep; the owner is turning them off | About $107 a month on test, never priced in dollars when it was done |
| **Google Drive** for viewer files or raw packages | 9 Sep idea from the owner | Not done; files stay in Firebase Storage | A service account cannot use Google One storage; Drive has no per-user rules |
| **STL in the preview path** | Before 9 Sep | Removed 9 Sep | STL loses faces, so clicks could not find a face; owner: "STEP ONLY" |
| **`/infer_labels`** automatic labelling | Aug | Replaced by `/inspect` and `/prepare` | It never existed in the deployed service |
| **Fuse the car, then cut** | Before 9 Sep | Body by body (9 Sep), then one compound tool first with fallbacks and guards (12 Sep) | Fusing silently lost bodies; 29 separate tools removed 13% |
| **Wheels off** | 13 Sep, owner | Back on 14 Sep | Off only while other problems were fixed |
| **16 mesh processors** | 13 Sep | Back to automatic, 13 Sep | Above the plan's limit |
| **Small-feature tolerance 0.5 mm** | 11 Sep | 2 mm, 13 Sep | Slivers still refused |
| **Ground 30 mm under the car** | 9 Sep | 0.1 mm under the wheels, 13 Sep | 30 mm is a car in flight |
| **Default fineness 5.0** | 10 Sep spec | 9.5 | 5.0 is not on the priced ladder; 9.5 is what the add-in always used |
| **opencascade.js** for the browser cut | 27 Sep, first idea | occt-wasm chosen the same day | opencascade.js is on OpenCascade 7.6.2, older than the server's; an older kernel had cut only the wheels out of a car |
| "I allow you to do anything at turboflow-test" | 23 Sep | Overridden by the Google Cloud ban, 27 Sep | Cost |

## Part 4. Decisions waiting for the owner

| Question | Context |
|---|---|
| Does the Google Cloud ban cover **production** too? | Asked 27 Sep, no answer. If billing goes off on `turboflow-7b3ca`, the live site's runs and payments stop. |
| Which platform for the no-cloud version (Supabase plus the PC worker, or something else), and where to host the site | 09-NO-CLOUD-PLAN.md |
| Is a free Google sign-in key from Google's developer console acceptable, or email-only sign-in? | Asked 27 Sep |
| Old Supabase account (`unwzwzzuzvqwkxdbxxpd`) or a new one? | Asked 27 Sep |
| What to do with the **93 historical runs** whose drag is about 10% low | Open since Aug (`docs/HANDOVER.md` section 12): leave, flag, or recompute |
| The four policy pages' "Last updated" dates (design rule 2.4) | Real revision dates needed |
| What product evidence goes in the home hero (design rule 3.1) | `docs/UI_PROGRAM.md` |
| App Check: badge, privacy wording, page weight; the add-in cannot send tokens | `docs/SECURITY_AUDIT.md` item 5 |
| Register the live PayPal webhook; make one sandbox purchase by hand | `docs/PROD_CUTOVER.md` |
| Google Cloud housekeeping when allowed: Gemini project and its two keys, two empty billed projects, 33 GB of images, budgets and billing export, revoking the token-creator grant | 27 Sep findings |
| Whether to keep the test project at all after the refund | 27 Sep |
