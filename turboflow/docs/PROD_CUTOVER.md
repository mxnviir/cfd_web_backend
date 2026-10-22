# Moving production (turboflow-7b3ca) onto the new build

Written 24 Sep 2026. Nothing on production has been changed. The backup
every rollback below returns to is
`C:\Users\shash\Desktop\cfd_web_backend\backups\turboflow-7b3ca-2026-09-24\`
(site, functions, containers, rules, indexes, auth settings, all 782 Firestore
documents and 86 accounts, the old Fusion add-in; `SHA256SUMS.txt` verifies it).

## Decisions (owner, 24 Sep)

1. Rehearse everything, including the rollback, before production.
2. Stay on plain Firebase Auth. Identity Platform cannot be undone.
3. Test payments in the PayPal sandbox before live.
4. Test the old Fusion add-in against the new backend in the rehearsal.

## Rehearsal results

| What | Where | Result |
|---|---|---|
| Account creation without Identity Platform | code, emulator, turboflow-test | `onUserCreate` (a blocking function) replaced by `ensureAccount`, a callable the site makes after sign-in. A first-generation trigger was tried and cannot run on Node 24. Emulator suite 76/76; live on test. |
| Data conversion, forward and back | emulator, with production's 782 documents | `tests/rehearse_prod_migration.mjs`, 15/15. Nobody's credits move, no ledger rows written; a migrated user sees all 100 of their jobs, their balance and 128 ledger rows through the new rules; rollback returns all 782 documents byte for byte; a refund made in between survives the rollback in the old field names. |
| Old Fusion add-in | turboflow-test | `tests/replay_old_addin.mjs` replays its exact requests: token exchange, balance read, both uploads, the camelCase job document, all accepted; the new backend renames it, charges by its own formula, starts the worker; the worker downloads both files and starts the SimScale upload; cancel is honoured and refunded exactly. |
| Functions rollback | turboflow-test | The five original functions redeployed from the backup (`scripts/build-restore-folders.py`), with dummy secrets. Works, **but** the two PayPal functions must be deleted before the old ones are deployed (Secret Manager keys and plain settings cannot share a name on one service). Forward again, new over old, works in place. |
| Website rollback | turboflow-test | `scripts/prod-rollback.mjs hosting`: instant, both directions. Production's original version `fa328903006aff67` is still stored (FINALIZED, 16 files). |
| Rules rollback | turboflow-test | `scripts/prod-rollback.mjs rules`: rulesets re-created from the backup's text and released. |

### Found by the rehearsal

- **Convert the data before the new functions go live.** Job triggers act on
  status changes, and a rename is not one, so they ignore it; but the emulator
  showed their events can run late, and a late "failed" event reading a ledger
  that has already been renamed will refund an old charge. Production's old
  functions only react to newly created jobs, so converting first, while only
  they are deployed, cannot set anything off.
- **Old add-in: an active unlimited pass.** It reads `unlimitedUntil`; after the
  conversion that is `unlimited_until`, so an old add-in would not see a pass.
  Matters only for a pass holder with a low balance; nobody has an active pass
  today.
- **Worker cold start** is about two minutes. Jobs sit in `pending` that long.
- **Worker and geometry service names.** Production already has `simscale-job`
  (the original worker) and `turboflow-tessellate`. The new ones go in beside
  them as `simscale-worker` and `turboflow-geometry`, named in
  `env/functions/turboflow-7b3ca.env` (synced into `functions/.env.turboflow-7b3ca`
  at deploy), so the originals stay untouched for a
  rollback.
- **Production's bucket is in us-central1**; the upload triggers default to
  us-east1, so `BUCKET_REGION=us-central1` goes in the same file.

## Production setup: done 24 Sep (additive; users see nothing)

Logged command by command in the backup folder, `prod-setup-2026-09-24.log`.

- Secret Manager enabled. Secrets `SIMSCALE_API_KEY`, `DISCORD_WEBHOOK_URL`,
  `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` (live), from what production runs today.
- Service accounts `tf-geometry` and `tf-worker`, with the grants test has:
  Firestore and logging on the project, object admin on the bucket, the worker
  may read the SimScale key, the functions' account may run the worker as it.
  The functions' account also got `serviceAccountTokenCreator` (Fusion
  connection sessions), `run.jobsExecutorWithOverrides` and `firebaseauth.admin`.
- `turboflow-geometry` (Cloud Run service, image copied from test's v65, same
  digest) and `simscale-worker` (Cloud Run job, test's v25, same digest,
  pointed at production's SimScale project 3955117048594207313). Definitions
  in the backup folder (`prod-geometry.yaml`, `prod-worker.yaml`). The geometry
  service is at minimum 0 instances until the switch.
- Storage CORS for turboflow.cloud, www, and the two firebase domains
  (`prod-storage-cors.json` in the backup; the bucket had none).
- `config/pricing.paypalClientId`: the live client id the old site already
  sets in its page, so the old site is unaffected.
- `functions/.env.turboflow-7b3ca`: `TESSELLATE_URL`, `BUCKET_REGION`,
  `WORKER_JOB`, `PAYPAL_ENV=live`.
- Production site build: `npm run build`, then
  `node scripts/build-prod-site.mjs <backup>` writes `dist-prod/` (site address
  turboflow.cloud, production's Firebase config, add-in stamped for
  production; refuses to finish if any test value is left) and
  `firebase.prod.json` (no predeploy, which would rebuild for test).
  The site pages in it are the DESIGN_RULES.md version (owner's decision on
  25 Sep; `docs/UI_PROGRAM.md`), so at the switch visitors see a new-looking
  site, the Garage as the way into the Workbench, and the Workbench.
- No index changes: the new build needs no composite index, and production's
  one index (the old app's job list) stays.
- Untouched, checked afterwards: the six original functions, `simscale-job`,
  `turboflow-tessellate`, rules, data, site.

## Still needed before the switch

- **The live PayPal webhook** (`PAYPAL_WEBHOOK_ID`): register one on the live
  PayPal app for `https://us-central1-turboflow-7b3ca.cloudfunctions.net/paypalWebhook`,
  `PAYMENT.CAPTURE.COMPLETED`, and store its id. Owner's decision; it changes the
  live PayPal account. Without it `paypalWebhook` cannot be deployed (the rest
  can), and purchases still complete through `capturePayPalOrder`.
- **One sandbox purchase on turboflow-test, by a person**: PayPal's popup needs a
  sandbox buyer to log in. Everything up to it is verified: the sandbox keys,
  the webhook, and a sandbox order created by the new `createPayPalOrder` at the
  server's price (500 credits, 25.00 USD).
- **Worker v30** (27 Sep 2026), live on turboflow-test; production's
  `simscale-worker` job is still on v25, which has the two add-in bugs below.
  Build `services/simscale-job` into `gcr.io/turboflow-7b3ca/simscale-worker:v30`
  and point the job at it. What changed since v25, all found by real runs:
  - A SimScale mesh failure tells the user it is the geometry or the mesh
    setting, not "a fault of our own, changing the simulation will not help".
  - Add-in (Fusion) runs send the same 2 mm small-feature tolerance as the
    Workbench. Without it SimScale refused a test car in 15 seconds ("no
    instance with sufficient computational resources").
  - Add-in runs read their results null-safely. SimScale sends
    `"download": null` on some result items, and v25 crashed on it after a
    good solve: no drag, no lift, no ParaView link, job still "complete".
    Every add-in run after the switch would have finished with no numbers.
  - NOT FIXED: add-in runs still come back with no drag and no lift. They
    solve cleanly, but SimScale offers no download for any result item of an
    add-in run (`availableExportFormats: []`), at 100 and at 1000 iterations,
    while Workbench runs in the same SimScale project export fine. No add-in
    job on turboflow-test has ever had drag. v29 (wait for result files) and
    v30 (forces written every iteration) were attempts at this and did not
    fix it. Until it is found, an add-in user is charged for a run that shows
    no numbers. This blocks the switch for Fusion users.
- **Always-on cost**: step 4 sets `turboflow-geometry` (4 vCPU, 8 GiB) to one
  minimum instance. At Cloud Run's idle rates ($0.0000025 per vCPU-second and
  per GiB-second) that is about $79 a month, and `processGeometry`,
  `runPrepareDomain` and `onGeometryUploaded` add about $28 more between them.
  Decide whether imports are worth it warm, or accept the cold start.
- **A quiet moment**: no run in progress. 26 jobs have sat in `running`,
  `meshing` or `cancelling` for weeks; they are left as they are.

## The switch

In this order. Each step's undo is next to it; the order of a rollback is
below the table.

| # | Step | Command | Undo |
|---|---|---|---|
| 0 | Fresh data copy | `backup_data.py` (as on 24 Sep) | |
| 1 | Convert the data | `node scripts/prod-migrate.mjs --forward --project=turboflow-7b3ca --production --log=<backup>/migrate.log.json` | `--reverse` with the same log. Keeps anything done since. |
| 2 | Rules and indexes | `firebase deploy --only firestore,storage --project turboflow-7b3ca` | `prod-rollback.mjs rules --project=turboflow-7b3ca --production --from=<backup>` |
| 3 | New functions; delete `onNewJob` and `submitSimulationJob` | `firebase deploy --only functions --project turboflow-7b3ca` (not `--force`: `run_lap_calc` must stay) then `firebase functions:delete onNewJob submitSimulationJob` | delete the new-only functions and the two new PayPal ones; `build-restore-folders.py <backup> <out>`; in `<out>/jobs` and `<out>/paypal`, `npm ci` then the printed `firebase deploy` |
| 4 | Site | `npm run build`, `node scripts/build-prod-site.mjs`, `node scripts/deploy.mjs --project turboflow-7b3ca --only hosting --config ../env/deploy/firebase.prod.json` | `prod-rollback.mjs hosting --project=turboflow-7b3ca --production --site=turboflow-7b3ca --version=fa328903006aff67` |
| 5 | Watch | a sign-up, a run, a cancel, a purchase | |

## Rolling back

When you say "roll it back", in this order:

1. **Site** to version `fa328903006aff67` (seconds). Everyone is on the old app.
2. **Rules** from the backup's text (seconds). The old app writes its own
   account documents, which the new rules refuse.
3. **Data** `--reverse` with the step-1 log (under a minute). Keeps every
   credit spent or bought since the switch, in the old field names.
4. **Functions** (about ten minutes, two builds): delete every new-only
   function first, including `onJobPending`, and the two new PayPal functions;
   then deploy the original five from the backup. The new job trigger must be
   gone before the old `onNewJob` exists, or a job created in between is
   charged twice. For those ten minutes the old app cannot submit or pay.

Everything the new build added (the new worker, the geometry service, secrets,
indexes, groups and runs documents) can stay; the old app ignores it.
