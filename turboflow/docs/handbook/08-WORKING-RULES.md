# 08. Working on TurboFlow: rules, memory, routines, traps

Written for whoever picks this up next, person or AI agent. It is the "how to
keep this going" file: the owner's rules, where memory lives, what to do at the
start of a session, how to run things, and the traps that have already cost
hours.

## 1. The owner and how to talk to him

- Shashank owns TurboFlow and is its developer. He is in the UAE (Dubai time,
  UTC+4); dates in chat are his local dates.
- **Plain English.** Short sentences, everyday words, tables and bullets. Not
  "claudish": no literary asides, no "the rule this module exists to keep is".
  Say what happened and what it means.
- He types fast and sometimes by voice, so expect typos and misheard words
  ("Jugoflow" and "turbolfow" are TurboFlow; "simsclae" is SimScale). Read for
  intent.
- He reacts strongly when something looks wrong or costs money ("STOP IT. STOP
  EVERYTHING."). When that happens: stop, run nothing further, say plainly what
  was and was not changed, and wait.
- He decides product, design and money. Anything that changes what users see,
  what they pay, or what Google bills needs his word.

## 2. Hard rules

| Rule | Since | Why |
|---|---|---|
| **No Google Cloud.** No `gcloud`, no `firebase deploy`, nothing against `turboflow-test` or `turboflow-7b3ca` | 27 Sep | Bill shock, refund in progress |
| **Local only.** Never push (git), deploy (Firebase) or publish (claude.ai Artifacts, any remote service) unless he asks for that exact thing in that message. Write reports as files in the repo | 27 Sep | Things were published that he had not asked for |
| **Production is untouched** unless he says "switch" or asks directly | Standing | Real users and money |
| **No subagents.** Do every reading yourself, so it is visible | 9 Sep | "no agents allowed, it's a rule" |
| **No bash heredocs or `node -e` / `python -` for code containing backslashes.** Write the script with the Write tool, then run it | 24 Sep | A heredoc turned `\b` into a backspace byte inside a file, silently |
| **No Claude attribution** in commits, PRs or files | Global | His global instructions |
| **Never print, paste or commit a secret.** Do not open `.env` files into chat output. Never quote the SimScale key, PayPal keys, Discord webhook, connection tokens or anything in `backups/` | Standing | Keys have already leaked into chat and code once |
| **Verify before saying "fixed".** If it cannot be checked, write UNVERIFIED | Standing | Several "fixes" in this project's history were guesses |
| **Give a dollar figure** for anything that costs money while idle or per use | 27 Sep lesson | Warm instances were added "for speed" with no price and ran up about $107 a month |
| **One design** for the site and the Workbench, from `DESIGN_RULES.md` | 25 Sep | A separate tool look was rejected |
| **When his messages conflict, ask one short multiple-choice question** before a large change; otherwise act. **Keep a private copy** of anything you replace | 25 Sep | Several rapid reversals on 24 to 25 Sep |
| Do not invent numbers or defaults; do not leave buttons that do nothing | Spec ground rules | See 06-DECISIONS.md part 1 |

His global instructions (`C:\Users\shash\.claude\CLAUDE.md`) also apply:
execute rather than ask when the task is clear, read the code before changing
it, no hardcoded or fake data, no reduced effort, verify in a browser where it
matters, surgical changes only, simplest solution that works.

## 3. Memory

Memory is how facts survive between sessions.

- **Where:** `C:\Users\shash\.claude\projects\C--Users-shash-Desktop-cfd-web-backend\memory\`
- **Index:** `MEMORY.md` in that folder, one line per memory, loaded into every
  session in this project.
- **Format:** one fact per file, with `name`, `description` and `type`
  (`user`, `feedback`, `project`, `reference`) in a header, then the fact, then
  **Why** and **How to apply**. Link related memories with `[[name]]`.

| Memory file | What it holds |
|---|---|
| `plain-english-no-claudish.md` | How to talk to him |
| `no-subagents.md` | No Agent tool |
| `no-heredoc-for-backslash-code.md` | The heredoc trap |
| `local-only-no-push.md` | Never push, deploy or publish (copied here on 3 Oct from a temporary session) |
| `turboflow-no-google-cloud.md` | The Google Cloud ban, the cost target, the browser cut |
| `turboflow-workbench-own-look.md` | One design for site and tool; the rejected race look; the Garage |
| `turboflow-simscale-workbench-spec.md` | The spec, queue mode, and a long log of lessons from 10 to 12 Sep |
| `turboflow-e2e-testing.md` | The test account, the scripts, which car meshes, the 27 Sep findings |
| `turboflow-domain-serves-old-build.md` | turboflow.cloud serves the old build; check before trusting a scan |
| `browser-pane-measurement-traps.md` | Why the preview browser lies when its window is hidden |
| `turboflow-handbook.md` | Points to this handbook and says to keep it updated |
| `ftc-biobuzz-build-uae.md` | Unrelated to TurboFlow (his FTC robot) |

**Lesson from 27 Sep:** a session started without a project folder saves its
memory in a temporary workspace that disappears. If a session like that learns a
standing rule, copy it into this project's memory folder.

Update a memory file rather than adding a duplicate; delete one that turns out
wrong. Do not store secrets, code structure, or things git already records.

## 4. Starting or resuming a session

1. Read `docs/handbook/00-README.md` and the memory index.
2. Check the date. Facts here are as of 3 Oct 2026.
3. `git -C turboflow status --short | wc -l` and `git log -1` to see what changed
   since. There is no remote, so this is the only history.
4. Look for files changed since the last session
   (`find turboflow -newer <a file you know> -not -path "*/node_modules/*"`), in
   case another session edited the same files.
5. If resuming after a context summary, trust the code over the summary, and the
   code over the older docs.
6. Before any change that touches Google Cloud, money, production or publishing:
   stop and check the rules in section 2.

## 5. Running things locally (allowed)

All from `C:\Users\shash\Desktop\cfd_web_backend\turboflow` unless said.

| Task | Command | Notes |
|---|---|---|
| Install | `npm install`, `npm --prefix functions install` | |
| Site dev server | `npm run dev` | http://localhost:5173. A localhost page talks to the **emulators** (project `demo-turboflow`), never to a real project |
| Emulators | from `cfd_web_backend`: `cmd /c "set FUNCTIONS_DISCOVERY_TIMEOUT=60 && cd turboflow && npx firebase-tools emulators:start --project demo-turboflow --only auth,firestore,functions,storage"` | UI on http://localhost:4000. `npm --prefix turboflow ...` runs the emulators in the wrong folder; use `cd`. The longer discovery timeout stops functions failing to load |
| Build functions | `npm --prefix functions run build` | TypeScript to `functions/lib/` |
| Build the site | `npm run build` | Vite, then prerender, SEO files, add-in zip (stamped for the project in `env/firebase/config.test.js`) |
| All offline tests and audits | `sh tests/run-all.sh` | Python tests need cadquery 2.8.0 (installed on this PC); `test_plots.py` needs the network and a key |
| Rules suites | `sh tests/run-all.sh --emulator` or `npm test` | Starts and stops the emulators |
| One audit | `node scripts/design-audit.mjs` (and `contrast-`, `palette-`, `token-`, `type-`, `csp-audit.mjs`, `orphan-classes.mjs`, `legacy-model-audit.mjs`) | Exit 1 on failure |
| Browser tunnel cut | `npm --prefix tools/tunnel-cut run dev` | http://localhost:5190 |
| Tunnel cut self-check | `node tools/tunnel-cut/check.mjs` | |
| Tunnel cut on a car in Node | `node tools/tunnel-cut/run-node.mjs "<car.step>" [--full] [--write]` | Run it from `tools/tunnel-cut` |
| Server's cut on the same car | `python tools/tunnel-cut/reference.py "<car.step>" [--full]` | For comparing |

The desktop app's browser preview has three saved configurations in
`cfd_web_backend/.claude/launch.json`: `turboflow-vite` (5173),
`turboflow-emulators` (4000) and `tunnel-cut` (5190).

**Signing in locally:** on the emulators, the Google sign-in is the emulator's
fake Google page, so no real account is needed. On the live sites, agents must
not type passwords or sign in as a real person; the 27 Sep tests used a
synthetic account (`e2eWorkbenchTest0001`) with a minted token, which needs
Google Cloud and so is off limits now.

**Test cars:** `Downloads/car(17.3).step` (half model, 9 bodies, never meshes on
SimScale), `withoutgap.step` (5 bodies, clean), `finalised combined car.step`
(10 bodies), `step_render.step` (11 bodies, broken where bodies meet), and a
small synthetic test car (16 faces) that meshes and solves. Never commit them.

## 6. Things that need Google Cloud (not allowed now)

Kept here so they are not rediscovered when the ban lifts. **Do none of this
without the owner's explicit go.**

- **Before any deploy:** remove `minInstances: 1` from `processGeometry.ts` (two
  places) and `prepareDomain.ts`, or three functions go back to costing money.
- Deploy to test: `firebase deploy --project test` (site build runs as a
  predeploy step), or `--only hosting`, `--only functions`, `--only firestore,storage`.
- Worker image: `gcloud builds submit services/simscale-job --tag gcr.io/turboflow-test/simscale-job:vNN`, then
  `gcloud run jobs update simscale-job --image gcr.io/turboflow-test/simscale-job:vNN --region us-central1 --project turboflow-test`.
  The image must contain every module the entry point imports (`spec_mode.py`
  was once missing).
- Geometry service: same pattern for `services/tessellate` and
  `turboflow-tessellate`, deployed private (`--no-allow-unauthenticated`), as
  `tf-geometry`, **with `--min-instances 0`**.
- Check what is actually deployed before trusting a live test (`gcloud run jobs
  describe`, `gcloud run services describe`): the deployed backend has lagged
  the repo before.
- Production switch: follow `docs/PROD_CUTOVER.md` step by step, including its
  rollback order. Production's worker needs v30 or later first, and A2 in
  07-PROBLEMS.md blocks Fusion users.
- Housekeeping waiting on the ban: revoke the token-creator grant (command in
  `docs/SECURITY_AUDIT.md`), budgets and billing export, the Gemini keys, the
  empty projects, image cleanup.

## 7. Traps that have already cost hours

### This PC (Windows 11, Git Bash and PowerShell)

- **Heredocs mangle backslashes.** See section 2. After any scripted edit,
  `grep -rlP "\x08"` the tree.
- **Line endings matter.** The pages' inline theme script is pinned by a SHA-256
  hash in the CSP. A page saved with CRLF changes the hash and the theme script
  is blocked. Keep the HTML pages LF; `node scripts/csp-audit.mjs` catches it.
- The shell's working directory resets between some commands; use absolute
  paths.
- PowerShell is 5.1: no `&&`, no ternary, `2>&1` on native programs misbehaves.

### The preview browser

- When its window is hidden it barely paints: screenshots time out, canvas reads
  come back blank, `requestAnimationFrame` never fires, and layout after a resize
  is stale. Count frames before trusting a reading; do pure maths (framing,
  contrast, layout numbers) in Node instead.
- Synthetic events: React-controlled number inputs ignore a synthetic `input`
  event (use a checkbox to test drafts); Tab does not move focus; `el.focus()`
  does not set `:focus-visible`; synthetic pointer events do not drive the
  orbit controls.
- Files cannot be picked through the browser tools; inject one with
  `DataTransfer` from a file the dev server can serve.

### Firebase and Firestore

- The client converts **top-level** keys between snake_case and camelCase and
  leaves nested maps alone, so `run.stageText` and `run.summary.drag` are both
  right in one component. A wrong spelling renders an empty panel, not an error.
- `orderBy` on a field some documents lack silently drops those documents. The
  Workbench sorts in the browser for that reason.
- A query with no `orderBy` returns documents in id order, not creation order.
- Reading a document that does not exist returns permission-denied, not empty.
- The callable SDK sends `undefined` as `null`; zod schemas must use `nullish()`.
- Storage rules: an allowed path with a missing file gives 404; a denied one 403.
  Storage rules here cannot reliably look things up in Firestore; put the uid in
  the path.
- `firebase emulators:exec` collides with a previous run still shutting down
  (ports 9099, 4400); that looks like a test failure and is not.
- A storage trigger must be deployed in the bucket's region (us-east1 on test,
  us-central1 on production).
- Node's `fetch` gives up after 300 s waiting for headers; long calls to the
  geometry service use `node:https` instead.

### OpenCascade and the geometry

- Library versions are load-bearing: cadquery 2.8.0 (2.5.2 cut only the wheels
  out of a car and had an inexact bounding box), pyvista 0.44.2, SimScale SDK
  9.2.0. A bug from a version difference reproduces clean on the dev machine
  every time.
- A boolean that fails does not raise. Measure what it removed.
- Booleans loosen the input shapes' tolerances; copy shapes before each attempt.
- An invalid region can export a STEP that reads back as something else; read it
  back.
- Cars arrive in mm, cm or m and sometimes sideways; the service detects both.
- Real CAD has slivers (faces under 0.25 mm², edges under 0.5 mm). The mesher
  refuses them; no setting fixes a badly shattered patch; re-exporting does.

### SimScale

- Match result items by **category** (`FORCE_PLOT`, `MOMENT_PLOT`,
  `RESIDUALS_PLOT`), never by name: the name is whatever the user called the
  result control.
- A failed operation says only FAILED; the reason is in its **event log**
  (`/meshoperations/{id}/eventlog`, entries).
- Some endpoints take arguments in the query string (starting a mesh needs
  `simulationId` there).
- Unit strings contain superscripts (`m²/s`, `kg/m³`); keep them from
  `functions/src/lib/units.ts`.
- SimScale drops zero-area faces on import, so a face set can shrink.
- Vectors need `type: "COMPONENT"`; a mesh operation needs a `version`; the setup
  check needs a mesh.
- Fields that belong to another solver (Pacefish) are rejected one at a time.
- This plan: under 16 cores, one run at a time on test, public projects only.
- Cloud Run sometimes holds a job execution on "Waiting for execution to start"
  for 5 to 15 minutes. It retries by itself.

## 8. Before calling anything done

1. It was run, not just compiled: in the browser preview or the emulators for UI,
   with a real or synthetic car for geometry, against a known-bad case for any new
   check.
2. `sh tests/run-all.sh` passes (and `--emulator` if rules changed).
3. UI changes follow `DESIGN_RULES.md`, and the audits pass.
4. Anything not checkable is written as UNVERIFIED.
5. The handbook is updated: a new decision goes in 06, a new problem in 07, a
   changed file in 04.

## 9. Useful identifiers (none of these are secrets)

| What | Value |
|---|---|
| Production Firebase project | `turboflow-7b3ca` (number 659747979647), https://turboflow.cloud |
| Test Firebase project | `turboflow-test`, https://turboflow-test.web.app |
| Emulator project | `demo-turboflow` |
| Production storage bucket | `turboflow-7b3ca.firebasestorage.app`, us-central1 |
| Test storage bucket | `turboflow-test.firebasestorage.app`, us-east1 |
| Functions region | us-central1 |
| Production original site version | `fa328903006aff67` (for rollback) |
| Test worker job | `simscale-job` (v30 as of 27 Sep) |
| Production new worker job | `simscale-worker` (v25) |
| Test geometry service | `turboflow-tessellate` |
| Production new geometry service | `turboflow-geometry` |
| SimScale project used by test runs | `7092902801726125387` (a public project) |
| SimScale project for production's new worker | `3955117048594207313` |
| Synthetic test account on turboflow-test | uid `e2eWorkbenchTest0001` |
| Retired Supabase project | `unwzwzzuzvqwkxdbxxpd` |

## 10. Where secrets live (names only)

| Secret | Lives in | Notes |
|---|---|---|
| `SIMSCALE_API_KEY` | Secret Manager (both projects), worker environment | Needs rotating (pasted in chat on 9 Sep) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID` | Secret Manager | Sandbox on test, live on production; the live webhook id is not set yet |
| `DISCORD_WEBHOOK_URL` | Secret Manager | |
| Old copies | `backups/turboflow-7b3ca-2026-09-24/`, `env/secrets/production.env`, the old production worker's code | Keep private |
