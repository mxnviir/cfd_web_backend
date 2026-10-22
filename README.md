# TurboFlow on Supabase

CFD for F1 in Schools / STEM Racing teams: import a car, get a wind tunnel
built around it, run it on SimScale, read drag and lift and colour the car by
pressure. This is the Supabase build. The Firebase build (`turboflow/` in the
original repo, project `turboflow-7b3ca`) is production until cutover and the
rollback after it; nothing here touches it.

## Architecture

```
browser                                   Supabase
───────                                   ────────
12 site pages + the Workbench             Auth          Google (anonymous on localhost, dev only)
  src/lib/backend.js  ── supabase-js ──>  Postgres      tables + RLS + column grants
  src/lib/compat.js   (Firebase-shaped                  private.* : the ledger, the poller's claim
                       surface for the                  pg_cron   : POLL every minute
                       compiled site)     Realtime      the Workbench's live tree and run status
  occt-wasm in Web Workers:               Storage       one bucket, users/<uid>/... as before
    import, tunnel cut, STEP export       Edge functions
  FINISH: case.zip -> GLB + fields          ops             every callable, one router
                                            submit          STEP -> SimScale, start the import
                                            poll            one SimScale call per due job
                                            results-stream  plots, and the case streamed to Storage
                                            simscale-mock   development only
```

**Geometry runs in the browser.** Import, wheel detection, the tunnel cut and
the STEP export are occt-wasm in Web Workers, unchanged from the Firebase
build. The server never builds geometry. It mints the paths a build may upload
to (an *artifact intent*), checks what arrives, and files it as a version.

**The run pipeline.** SimScale has no webhooks, so something has to poll.

1. `queueRun` (ops) checks the setup, writes the run and its job, and charges
   for it, all in one transaction. It then calls SUBMIT.
2. **SUBMIT** claims the job (exactly once), sends the STEP to SimScale and
   starts the geometry import. It takes about 30 s.
3. **POLL** runs every minute from pg_cron. It claims due jobs with
   `FOR UPDATE SKIP LOCKED` plus a lease, makes one SimScale call per job, and
   moves the job on: import, simulation and mesh created, meshing, check,
   solver, finished. It also winds SimScale down after a cancel.
4. **RESULTS-STREAM** reads the force, moment and residual plots (a few KB)
   and computes the summary. It then streams the solution package, the
   OpenFOAM case, from SimScale into Storage chunk by chunk.
5. **FINISH** runs in the owner's browser. The first time the run's owner
   opens it, a Web Worker reads the case's mesh and last fields by HTTP Range
   requests and writes `results.glb` and `fields/*.bin` beside it.
   `finishResults` files them on the run, and every later view loads them.

Every status change is conditional on the status it came from, so a cancel
that lands mid-step always wins.

## Money

Unchanged from the Firebase build, and enforced in Postgres:

- A run is charged **exactly once**, at a price computed in SQL from
  server-clamped parameters (`private.charge_job`). A client can't set a price,
  a balance, a sponsor rate, an unlimited pass, or a ledger row (no grant).
- A refund is the ledger's outstanding amount for that job, never a field on
  the job. A forged job refunds zero.
- **Refund tiers**: everything back at draft, pending, downloading,
  uploading_geometry, processing, creating_simulation and checking; nothing
  from meshing on. This applies to `refundJob` and to cancelling a run. A run
  that fails before its mesh exists is reversed in full.
- PayPal credits are granted server-side, once, by whichever of capture and
  webhook arrives first (`private.apply_purchase`).
- The ledger functions live in schema `private`. PostgREST doesn't expose it,
  and no client role can execute them. The ops router reaches them over a
  direct database connection.

`docs/RLS_CHECKLIST.md` maps every clause of the old `firestore.rules` and
`storage.rules` to the policy, grant, constraint or function that replaces it,
with the test that proves it.

## Running it

Needs Node 24. Install with `npm install`.

```bash
npm run dev                 # site + Workbench on http://localhost:5173 against the dev project
```

`npm run dev` copies `supabase/env/web.dev.js` to `public/supabase-config.js`
first. On localhost the Workbench signs in anonymously and makes itself an
account. That needs anonymous sign-ins on (as in `supabase/config.toml`) and
`TURBOFLOW_ENV=development` among the function secrets.

**Against a local stack** (needs Docker):

```bash
supabase start                              # Postgres, Auth, Storage, Realtime, functions
supabase db reset                           # migrations + seed (one demo account)
supabase functions serve --no-verify-jwt --env-file supabase/env/functions.dev.env
```

Point `supabase/env/web.dev.js` at `http://127.0.0.1:54321` with the local
anon key, and put the functions' URL in the vault for pg_cron:
`node supabase/dev/apply.mjs http://host.docker.internal:54321` (`apply.mjs`
also creates the SimScale mock's state table).

**Against a hosted development project** (what this port was built and tested
on, project `Turboflow`):

```bash
supabase link --project-ref <ref>
supabase db push
node supabase/dev/apply.mjs https://<ref>.supabase.co
supabase secrets set --env-file supabase/env/functions.dev.env --project-ref <ref>
supabase functions deploy ops submit poll results-stream simscale-mock --project-ref <ref>
```

Put the database URL in `supabase/.env.local` (gitignored) as
`SUPABASE_DB_URL=...` for the tests. `supabase/env/README.md` explains the env
layout.

## Tests

```bash
npm run test:money       # supabase/tests/money.sql: 158 checks on money, RLS and storage paths
npm run test:lock        # two and eight overlapping POLL claims never share a job
npm run test:pipeline    # end to end against the deployed functions and the SimScale mock (~10 min)
sh tests/run-all.sh      # the offline suites: pricing parity, autoSpec, clamping, FINISH, migration, ...
sh tests/run-all.sh --db # ...plus the money and lock suites
```

`test:money` runs in one transaction and rolls back. `test:pipeline` creates
three accounts and deletes them afterwards. Run `test:lock` on its own: it
pauses pg_cron's tick while it runs.

## Layout

```
supabase/
  migrations/      schema, RLS, ledger, storage, poller, pipeline
  functions/       ops (the router), submit, poll, results-stream, simscale-mock
    _shared/       core (db, auth, storage), simscale (REST port), pipeline, logic/ (pure TS)
  tests/           money.sql, lock.mjs, pipeline.mjs
  env/             web config and function-secret templates
  dev/             development-only setup (the mock's table, the vault URL)
src/
  lib/backend.js   the client: tables, Realtime, ops, Storage, in the shape the pages expect
  lib/compat.js    the same, as the globals the compiled classic site reads
  workbench/       the Workbench; results/ is FINISH
scripts/migrate/   Firestore and Firebase Storage -> Supabase (delivered, not run)
docs/
  RLS_CHECKLIST.md firestore.rules / storage.rules, clause by clause
  CUTOVER.md       what production needs, the order to do it in, what differs
  reference/       the Firebase rules, for the checklist
```

The rest of `docs/` (the handbook, PLAN, SIMSCALE, WORKBENCH, the August
Supabase notes) describes the Firebase build and earlier attempts. It's kept
as history and is not about this code.
