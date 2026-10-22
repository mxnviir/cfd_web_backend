# TurboFlow handbook

Written 3 October 2026, from the code in this repo, the older docs in `docs/`,
the saved memory files and every chat transcript for this project. Where a fact
could not be checked from here it is marked **UNVERIFIED**.

This folder is meant to be the first thing anyone reads, person or AI agent,
before touching TurboFlow. The older docs in `docs/` are still useful for detail,
but several of them describe a past state of the project (see the "Older docs"
table at the bottom).

## TurboFlow in one paragraph

TurboFlow is a website that runs wind-tunnel simulations (CFD) for school teams
in STEM Racing, the competition that used to be called F1 in Schools. A team
uploads its car, TurboFlow builds a virtual wind tunnel around it, sends the job
to SimScale (a commercial cloud CFD service) under TurboFlow's own account, and
shows the team drag, lift and plots when it finishes. Teams pay with credits
bought through PayPal. There are two ways in: a **Fusion 360 add-in** that builds
the tunnel inside Fusion and uploads it, and the **Workbench**, a browser tool
where the team uploads a raw car and the website does the rest.

## Where things stand on 3 October 2026

| Area | State |
|---|---|
| **Production site** (turboflow.cloud, Firebase project `turboflow-7b3ca`) | Still the original app from 4 August 2026. Never switched to the new build. A full backup was taken on 24 Sep. |
| **Test site** (turboflow-test.web.app, project `turboflow-test`) | The new build. Last deployed 25 Sep 2026. Changes made locally on 27 Sep are **not deployed**. |
| **Google Cloud** | **Frozen since 27 Sep 2026.** The owner found always-on services costing about $107 a month on the test project, asked Google for a refund, and banned any agent from touching Google Cloud. Which services were then stopped or deleted is **UNVERIFIED** (checking would mean touching Google Cloud). |
| **New target** | Run for under $0.10 a month, using Supabase's free plan and/or the browser and the owner's PC, not Google Cloud. Only the first piece exists: a browser tunnel cut in `tools/tunnel-cut/`. |
| **Workbench runs** | Worked end to end on turboflow-test on 27 Sep with the small test car (drag 0.318 N). |
| **Fusion add-in runs** | On turboflow-test they solve but come back with **no drag or lift**. Unsolved. This blocks moving Fusion users to the new backend. |
| **Payments** | New PayPal code has never taken a payment, test or real. The live PayPal webhook is not registered. |
| **Code safety** | The repo is git, 47 commits, last commit 10 Sep 2026, about 200 uncommitted changes, **no remote**. This PC holds the only copy of most of the work. Copy the folder somewhere safe. |

## Rules every agent must follow here

Full detail and the reasons are in [08-WORKING-RULES.md](08-WORKING-RULES.md).
The short version:

1. **Do not touch Google Cloud.** No `gcloud`, no `firebase deploy`, nothing
   against `turboflow-test` or `turboflow-7b3ca`, until the owner lifts it.
2. **Local only.** Never push, deploy or publish (including claude.ai Artifacts)
   unless the owner asks for that exact thing in that message.
3. **Never touch production** (`turboflow-7b3ca`) unless the owner says "switch"
   or asks for it directly.
4. **Plain English** in every reply. Short sentences, no jargon dressing.
5. **No subagents.** Do the reading yourself.
6. **No bash heredocs for code with backslashes.** Write scripts with the Write
   tool.
7. **No Claude attribution** anywhere (commits, PRs, files).
8. **Never print or commit a secret.** API keys, tokens and passwords stay out of
   chat, docs and code.
9. **Verify before saying "fixed".** If it cannot be checked, say UNVERIFIED.
10. **One design** for the site and the Workbench, from `DESIGN_RULES.md`. When
    the owner's messages conflict, ask one short question before a big change,
    and keep a private copy of anything you replace.

## Files in this handbook

| File | What it covers |
|---|---|
| [01-PROJECT.md](01-PROJECT.md) | What TurboFlow is, who uses it, how it makes money, the environments, the outside services |
| [02-HISTORY.md](02-HISTORY.md) | Everything that happened, in date order, from the original app to today |
| [03-ARCHITECTURE.md](03-ARCHITECTURE.md) | How the pieces fit: the pipeline from upload to result, the data model, storage, security, money |
| [04-CODE-MAP.md](04-CODE-MAP.md) | Every folder and file, and what it does |
| [05-BACKEND-REFERENCE.md](05-BACKEND-REFERENCE.md) | Every Cloud Function, the geometry service, the SimScale worker, the rules, prices and limits, in detail |
| [06-DECISIONS.md](06-DECISIONS.md) | Decisions in force, decisions reversed or scrapped, and the thinking behind them |
| [07-PROBLEMS.md](07-PROBLEMS.md) | Every known problem, open bug, risk and loose end |
| [08-WORKING-RULES.md](08-WORKING-RULES.md) | How to work on this project and keep the chat going: rules, memory, how to run and test, traps |
| [09-NO-CLOUD-PLAN.md](09-NO-CLOUD-PLAN.md) | The plan to leave Google Cloud: what moves where, the browser tunnel cut, what is left |
| [10-GLOSSARY.md](10-GLOSSARY.md) | The words used across the code and the docs |

## Older docs, and how far to trust them

| File | Trust it for | Out of date on |
|---|---|---|
| `docs/README.md` | Nothing current | Describes the August Supabase version. Wrong today. |
| `docs/HANDOVER.md`, `docs/MIGRATION.md` | History of the August Supabase migration, and the drag bug that under-reported by about 10% | Everything about how things run now |
| `docs/PLAN.md` | Why the project went back to Firebase on 9 Sep, and the security holes in the original app | The phases are done or changed |
| `docs/SETUP.md` | Setting up a new Firebase project from scratch | Assumes Google Cloud, which is now off limits |
| `docs/SIMSCALE_WORKBENCH_SPEC.md` | SimScale API facts, and Part C, the 61 "mistakes to avoid" | The "copy SimScale exactly" goal was dropped on 12 Sep; the postprocess service in it was never built |
| `docs/SIMSCALE.md` | What SimScale can return and what we take | Fine |
| `docs/WORKBENCH.md` | The older hand-written Workbench and how its faults were fixed | That Workbench is retired (`legacy/`) |
| `docs/SECURITY_AUDIT.md` | Every security finding and fix | Its status table is from 14 Sep; several "not fixed" items have since been fixed (see 07-PROBLEMS.md) |
| `docs/PROD_CUTOVER.md` | The production switch plan, rehearsal results, rollback | Assumes Google Cloud |
| `docs/UI_PROGRAM.md`, `docs/UI_REVIEW.md`, `docs/SITE_AUDIT.md`, `GUIDELINES_REVIEW.md`, `CHANGES.md` | UI and site findings, design decisions | Mostly current up to 27 Sep |
| `tests/README.md` | Why tests read the real shipping files | Lists only a few of the suites |
| `legacy/README.md` | Why the old Workbench is kept | Fine |
