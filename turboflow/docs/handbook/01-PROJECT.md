# 01. The project

## What TurboFlow is

TurboFlow sells wind-tunnel simulations to school teams in **STEM Racing**
(previously called F1 in Schools). In that competition, teams design small
CO2-powered model cars, about 200 to 260 mm long, mostly in Fusion 360. The
fastest car wins, so drag matters, and a team wants to compare one version of
its car against the next.

TurboFlow is **not a solver**. The physics is done by **SimScale**, a commercial
cloud CFD service. TurboFlow is everything around it:

- getting the car's CAD file in, and checking it is usable;
- building the virtual wind tunnel around the car, and labelling which surface
  is the inlet, the outlet, the road, the walls and each wheel;
- setting up the simulation (air speed, mesh fineness, iterations, spinning
  wheels, moving road);
- charging credits, running the job on SimScale under TurboFlow's one account,
  and reporting progress;
- bringing back drag, lift, Cd and Cl, plots and result files, and letting the
  team compare runs.

The team never needs a SimScale account or key. The key lives only on the
server.

### The physics, in one line

Steady incompressible air flow (RANS), k-omega SST turbulence model, air at
1.196 kg/m³ and kinematic viscosity 1.529e-5 m²/s, default speed 20 m/s, wind
blowing along -x. Usually half the car is solved against a mirror plane (a
"half tunnel"), which costs about a quarter of the cells, and forces are doubled
back up for the whole car.

## Who uses it

- **Teams** (students and teachers). Sign in with Google only.
- **The owner**, Shashank, who is also the developer ("I'm literally the
  developer of TurboFlow"). He runs this project through Claude Code sessions.
- The August 2026 Supabase migration was done on another machine (its docs give
  the path `C:\Users\manvir\...`). Manvir appears in the owner's team lists.
- 86 sign-in accounts and 83 user documents existed on production on 24 Sep 2026
  (from the backup).

## The two ways a run arrives

| Route | What the user does | What TurboFlow receives |
|---|---|---|
| **Fusion 360 add-in** (`services/TurboFlow_CFD_fusion_addin.py`) | Opens their car in Fusion, runs the "TurboFlow CFD" command. The add-in builds the wind tunnel inside Fusion, cuts the car out, labels the faces, and uploads. | A ready-made flow region (`geometry.step`), an `entity_labels.csv` naming the faces, and a job document in camelCase with four settings (speed, mesh level, iterations, debug mesh). |
| **Web Workbench** (`/dashboard` then `/workbench/{groupId}`) | Uploads a raw car (STEP, IGES or STL). Picks wheels, tunnel size, mesh, iterations. Presses Queue. | A raw car. The geometry service builds the tunnel, the backend writes a full SimScale setup, and the job carries that setup. |

Both end in the same place: a `jobs` document becomes `pending`, the backend
charges for it and starts the SimScale worker.

## How TurboFlow makes money

Everything costs **credits**. Credits are bought with PayPal.

| Item | Default price | Where it is set |
|---|---|---|
| Credits | $5 per 100 credits; 100 to 20,000 per order | `config/pricing` in Firestore, else defaults in `functions/src/paypal/client.ts` |
| Unlimited pass | $100 per month, 30 days per month, up to 24 months at once; passes stack | same |
| Per-team price | `usd_per_credit` and `unlimited_usd` on a user document override the defaults for that one team | user document |
| Sponsorship | A sponsored team pays `sponsor_rate` times the list price (for example 0.2 = 80% off). Never free: at least 1 credit | user document `sponsored`, `sponsor_rate` |
| Sign-up bonus | 50 credits, once, for a Google account | `functions/src/users/onUserCreate.ts` |
| Race time calculator | 10 credits a run, free for sponsored teams | the original `run_lap_calc` function, only on production |

**The price of a simulation run** (`functions/src/lib/pricing.ts`, copied in
`src/lib/pricing.js`, a test keeps them equal):

```
mesh level 1 to 5   ->  credits per 1000 iterations = 100 + (level - 1) x 25
price               =   max(1, round(per1000 x iterations / 1000))
debug mesh          =   1 credit per 1000 iterations
sponsored           =   max(1, round(price x sponsor_rate))
unlimited pass      =   0
```

Mesh level maps to SimScale's fineness: level 1 = 9.0, 2 = 9.2, 3 = 9.5,
4 = 9.7, 5 = 10.0. The default Workbench run (level 3, 1,000 iterations) costs
**150 credits**. Iterations are capped at 3,000 and mesh level at 5.

Refunds follow one line: **if the solver never started, all the credits come
back; once it has started, the compute is spent.** See 05-BACKEND-REFERENCE.md.

## What is on the website

| Page | Address | What it is |
|---|---|---|
| Home | `/` | What TurboFlow does, the Fusion footage, the race time calculator, links |
| Simulations | `/simulations` | The original job list (both routes' jobs), Fusion connection tokens, results downloads |
| Garage | `/dashboard` | The way into the Workbench: one row per group, its best drag and Cd, run count, any run in progress |
| Workbench | `/workbench/{groupId}/...` | The 3D tool: upload, four setup steps, queue, run panel, plots, results |
| Billing | `/billing` | Buy credits or an unlimited pass through PayPal; transaction list |
| Race time calculator | `/lap-calculator` | Predicts a race time from drag and other inputs (production function) |
| Docs | `/docs` | Setup guide; downloads the Fusion add-in |
| Sponsorship, Mentorship, Modelling | `/sponsorship`, `/mentorship`, `/modelling` | Programmes TurboFlow offers |
| Policies | `/privacy-policy`, `/terms`, `/refund-policy`, `/sponsorship-policy` | Legal pages |
| 404 | any unknown address | A real "page not found", not the home page |

## Environments

| Name | Firebase / Google project | Address | Notes |
|---|---|---|---|
| **Production** | `turboflow-7b3ca` (project number 659747979647) | https://turboflow.cloud | Real users and money. Serves the original August app. Firestore in `me-central1`, storage bucket in `us-central1`. Backup in `cfd_web_backend/backups/turboflow-7b3ca-2026-09-24/`. |
| **Test** | `turboflow-test` | https://turboflow-test.web.app | Everything new is built and checked here. Storage bucket in `us-east1`, functions in `us-central1`. The owner allowed "anything" here on 23 Sep, but Google Cloud is off limits since 27 Sep. |
| **Local** | emulator project `demo-turboflow` | http://localhost:5173 | Vite dev server plus the Firebase emulators. `src/lib/firebase.js` points any localhost page at the emulators automatically, so local work can never touch a real project. |
| **Supabase** (retired) | project ref `unwzwzzuzvqwkxdbxxpd` | none | The August migration target. Abandoned on 9 Sep. Whether it still exists is **UNVERIFIED**. |

`.firebaserc` makes `turboflow-test` the default, so a bare `firebase deploy`
can never hit production. Production has to be named (`--project prod`).

## Outside services TurboFlow depends on

| Service | Used for | Cost note |
|---|---|---|
| **Firebase Hosting** | Serves the website | Free tier |
| **Firebase Auth** | Google sign-in, nothing else | Free |
| **Cloud Firestore** | All data: users, jobs, groups, geometries, simulations, runs, ledger | Pay per use |
| **Cloud Storage for Firebase** | CAD uploads, tunnel versions, results | Pay per use; needs the Blaze plan |
| **Cloud Functions (2nd gen)** | 31 functions: money, jobs, groups, geometry front doors | Each is a Cloud Run service; idle cost only if min instances is above 0 |
| **Cloud Run service** `turboflow-tessellate` (test) / `turboflow-geometry` (prod, unused yet) | The geometry service (OpenCascade) | 4 vCPU, 8 GiB. At min 1 instance it costs about $79 a month idle |
| **Cloud Run job** `simscale-job` (test) / `simscale-worker` (prod, unused yet) | The SimScale worker, one execution per run | Pay per run |
| **Secret Manager** | SimScale key, PayPal keys, Discord webhook | Small |
| **Cloud Build, Container/Artifact Registry** | Building and storing container images | About 33 GB of images on test, about $3 a month |
| **SimScale** | Meshing and solving | Separate SimScale plan; one account, one project per environment. Projects on this plan are public, which the privacy policy says |
| **PayPal** | Credit purchases | Sandbox on test, live on production only (enforced in code) |
| **Discord webhook** | A message per new job, for the owner | Free |
| **Google Fonts** | IBM Plex Sans and IBM Plex Mono | Free |

All of the Google Cloud rows are off limits until the owner says otherwise. The
plan to replace them is in [09-NO-CLOUD-PLAN.md](09-NO-CLOUD-PLAN.md).

## Folders on this PC

| Path | What |
|---|---|
| `C:\Users\shash\Desktop\cfd_web_backend\turboflow\` | **The repo.** Site, functions, services, tests, docs. Git, no remote. |
| `C:\Users\shash\Desktop\cfd_web_backend\DESIGN_RULES.md` | The design rules every page must follow. Outside the repo on purpose. |
| `C:\Users\shash\Desktop\cfd_web_backend\backups\turboflow-7b3ca-2026-09-24\` | Full backup of production. **Contains live secrets. Never upload, attach or commit it.** |
| `C:\Users\shash\Desktop\cfd_web_backend\cfd_web_frontend\` | The original production app as it was in August (compiled single page, old functions). Not git. Its `functions/.env` was moved to `env/secrets/production.env` in this repo. |
| `C:\Users\shash\Desktop\cfd_web_backend\fusion_addin_test\TurboFlow_CFD\` | The Fusion add-in stamped for turboflow-test (27 Sep). |
| `C:\Users\shash\Downloads\car(17.3).step`, `withoutgap.step`, `finalised combined car.step`, `step_render.step` | Real customer and test cars used for testing. Do not commit them. |
