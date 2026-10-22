# Cutting production over to Supabase

Firebase (`turboflow-7b3ca`) is production until the owner decides otherwise,
and stays the rollback afterwards. Nothing here has been done to it. This is
the list of what has to be true, and the order to do it in.

## What production needs

**A Supabase project on the Pro plan.** Free caps every upload at 50 MB and an
edge function's wall clock at 150 s. The app accepts STEP files up to 200 MB,
and a run's solution package (the OpenFOAM case) is hundreds of MB to a few GB.
It is streamed into Storage by RESULTS-STREAM in one invocation, so it needs
Pro's 5 GB object limit and 400 s wall clock. Set the project's upload limit
(Storage settings) to at least 5 GB; the `turboflow` bucket allows 200 MB per
client upload by itself, and the service writes the case.

**Auth**
- Google provider on, with the production OAuth client id and secret
  (Authentication → Providers). Add the site's origin to the redirect allow
  list and set the Site URL.
- Anonymous sign-ins **off**. They're only for the localhost Workbench in
  development, and `ensureAccount` refuses them unless
  `TURBOFLOW_ENV=development`.
- Leave email/password sign-up off, or confirm it can't create accounts:
  `ensureAccount` gives an account row only to Google sign-ins in production.

**Database**: `supabase link --project-ref <prod>` then `supabase db push`.
Do **not** run `supabase/seed.sql` or `supabase/dev/*` against production.
Then put the functions' base URL in the vault, which pg_cron's tick and the
simulations trigger read:

```sql
select vault.create_secret('https://<prod-ref>.supabase.co/functions/v1', 'functions_url');
```

**Edge functions**: deploy `ops`, `submit`, `poll` and `results-stream` with
`--no-verify-jwt` (`config.toml` declares it; they authenticate their own
callers). Never deploy `simscale-mock` to production.

```bash
supabase functions deploy ops submit poll results-stream --project-ref <prod>
```

**Secrets**: copy `supabase/env/functions.prod.env.example` to
`functions.prod.env`, fill it in from `env/secrets/production.env` and the
SimScale account, and run
`supabase secrets set --env-file supabase/env/functions.prod.env --project-ref <prod>`:

| Secret | From |
|---|---|
| `TURBOFLOW_ENV=production` | Gates live PayPal and refuses anonymous accounts. |
| `SIMSCALE_API_KEY`, `SIMSCALE_PROJECT_ID` | The worker's environment (`env/worker/simscale-job.env`). |
| `SIMSCALE_API_BASE` | `https://api.simscale.com/v0` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV=live` | Secret Manager on turboflow-7b3ca. |
| `DISCORD_WEBHOOK_URL` | Secret Manager on turboflow-7b3ca. |

`internal_secret` is generated in the vault by the poller migration and is not
set by hand.

**PayPal**: point a webhook for `PAYMENT.CAPTURE.COMPLETED` at
`https://<prod-ref>.supabase.co/functions/v1/ops/paypal-webhook`, and set
`PAYPAL_WEBHOOK_ID` to its id.

**Web config**: copy `supabase/env/web.prod.example.js` to `web.prod.js` with
the production URL and anon key (public by design), and build with
`npm run build:prod`.

**Hosting**: Supabase doesn't serve the site. Whatever serves `dist/` needs
what `firebase.json` declared:

- Rewrites: `/workbench/**` → `/workbench.html`; a path with no extension that
  names a view (`/dash`, `/billing`, ...) → that view's `.html` (clean URLs);
  anything else → `/index.html`.
- Cache: `/assets/**` immutable for a year; HTML, `/`, `supabase-config.js`
  and `site-config.js` revalidated (5 minutes for the two config scripts);
  images and fonts a week.
- Headers on everything: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: SAMEORIGIN`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`,
  and this Content-Security-Policy (Firebase's, with Supabase in place of the
  Google endpoints):

```
default-src 'self'; script-src 'self' 'sha256-gUexAbXAoKrZmGwuov16cPkMdR0W11YPpy/P3pNHhxk=' https://*.paypal.com https://*.paypalobjects.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleusercontent.com https://*.paypal.com https://*.paypalobjects.com https://<prod-ref>.supabase.co; connect-src 'self' https://<prod-ref>.supabase.co wss://<prod-ref>.supabase.co https://*.paypal.com; worker-src 'self' blob:; frame-src 'self' https://accounts.google.com https://*.paypal.com; object-src 'none'; base-uri 'self'; form-action 'self' https://<prod-ref>.supabase.co; frame-ancestors 'self'
```

## Order of operations

1. Build and check the production Supabase project as above, with no users.
   Run `npm run test:money` against it before any data arrives: it runs in a
   transaction and rolls back.
2. **Drain the Firebase pipeline.** Stop new runs (maintenance banner or a
   paused queue) and wait until no job is in a non-terminal status. A job in
   flight belongs to its Cloud Run task and can't be resumed by POLL; the
   migration imports such jobs as they stand and lists them as problems.
3. Dry run, from a machine with read access to turboflow-7b3ca:
   ```bash
   FIREBASE_PROJECT=turboflow-7b3ca FIREBASE_BUCKET=<bucket> \
   FIREBASE_TOKEN=$(gcloud auth print-access-token --impersonate-service-account=<reader-sa>) \
   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_DB_URL=... \
   node scripts/migrate/run.mjs
   ```
   Read the report it writes (`migration-report-*.json`) for problems.
4. `node scripts/migrate/run.mjs --execute`. It checks every balance against
   Firestore after writing and reports any mismatch. It's re-runnable: rows go in
   with `ON CONFLICT DO NOTHING`, and files whose MD5 already matches are skipped.
   A final `--only-storage` pass picks up files written during the window.
5. Point the site's hosting at the Supabase build. Users sign in with Google
   as before; Supabase links them to their migrated account by verified email.
6. Keep turboflow-7b3ca running and untouched. Rollback is pointing hosting
   back at the Firebase build. Anything done on Supabase after cutover
   (runs, purchases) would need reconciling by hand, so decide the rollback
   window up front.

## What behaves differently, on purpose

- **Refund tiers.** `refundJob` and a cancel both give a full refund at draft,
  pending, downloading, uploading_geometry, processing, creating_simulation
  and checking, and nothing from meshing on (decided for this port). The
  Firebase code disagreed with itself: `refundJob` refunded at meshing but
  refused at checking, and `cancelRun`, which the Workbench calls, never
  refunded. A run that fails before its mesh exists is still reversed in full,
  as before.
- **Insufficient credits** refuse `queueRun` outright; no run or job is
  created. Firebase created both and then failed the job.
- **Jobs are created only by the router**; see RLS_CHECKLIST.md for this and
  the other tightenings.
- **Results are converted in the owner's browser (FINISH)**, not by the
  worker:
  - A finished run has its forces, plots and the downloadable case at once,
    but no 3D model until its **owner** first opens it. A collaborator
    opening it first sees a note saying so.
  - The browser reads only the mesh and the last time step's fields, by
    Range request, but a very large case (millions of boundary faces, or
    fields that only exist on cells) still means hundreds of MB of parsing
    in a tab. There is no decimation yet: the surface goes to the viewer at
    full size, where the worker capped it at 300,000 triangles.
- **`error_detail`** (the worker's Python traceback) is gone; the pipeline's
  failure reasons are the sentences the worker showed as `error`.

## What is not ported

- **The Fusion 360 add-in** (`services/TurboFlow_CFD_fusion_addin.py`) is
  hard-wired to Firebase URLs and creates jobs in Firestore directly, using
  the worker's non-Workbench path (a model built from four columns), which
  isn't ported. On Supabase the add-in needs a new build that exchanges its
  connection token at `ops` (`exchangeFusionToken` → a `tfs_` session),
  uploads through `createUploadIntent`, and queues through the Workbench path.
  Existing connection tokens migrate and keep their hashes, so they will work
  with that build.
- **The lap-time calculator** in the classic site calls
  `https://us-central1-turboflow-7b3ca.cloudfunctions.net/run_lap_calc`, a
  Python function that isn't in this codebase. It will keep calling Firebase
  with a Supabase token and fail, until it's ported or pointed elsewhere.
- **`submitSimulationJob`**, which the classic site's old submit form calls,
  didn't exist in the Firebase backend either; it still answers "no such
  operation".

## Known ceilings

- SUBMIT holds the STEP in memory for SimScale's PUT (it needs a
  Content-Length): fine to the 60 MB raw limit, but a much larger tunnel STEP
  would want a sized streaming PUT.
- RESULTS-STREAM copies a case in one invocation. SimScale's download URL
  doesn't honour Range, so a case can't be resumed part-way. A case that
  can't stream within the wall clock is retried three times, and the run then
  finishes with its forces and plots but no case.
- POLL handles up to 10 jobs per tick, a minute apart. Raise `BATCH` in
  `poll/index.ts`, or the cron frequency, if many runs are in flight at once.
