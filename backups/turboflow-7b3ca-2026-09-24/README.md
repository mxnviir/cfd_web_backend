# Backup of turboflow-7b3ca (production), 24 September 2026

A copy of what is deployed on the production Firebase project, taken from the
project itself, not from the repo. Nothing on production was changed: every
call was a read (list, get, download).

## Contains live secrets, keep this folder private

These files hold real credentials, copied as they are deployed:

| File | What is in it |
|---|---|
| `functions/source/*/unzipped/.env` | PayPal secret, Discord webhook URL |
| `functions/functions_list.json` | the same values, as the functions' environment |
| `cloud_run/services.json`, `cloud_run/*.service.yaml` | PayPal secret, Discord webhook, Supabase service-role and anon keys |
| `cloud_run/jobs.json`, `cloud_run/*.job.yaml` | SimScale API key, Supabase service-role key |
| `containers/simscale-job/unpacked/simscale_job.py` line 48 | the SimScale API key, written into the code |

Do not upload this folder, attach it to a message, or put it in a git repo. The
password-hash key and any OAuth client secret were removed from `auth/`.

## What is here

| Folder | Contents | How it was taken |
|---|---|---|
| `website/turboflow-7b3ca/` | The live Hosting release: version `fa328903006aff67`, released 4 Aug 2026, 16 files, 28.4 MB. `public/` is the files, `version.json` the hosting config (rewrites, headers), `files.json` Firebase's file list and hashes. | Downloaded from the site. All 16 files checked against Firebase's own SHA-256 hashes: every one matches byte for byte. |
| `functions/` | The six Cloud Functions (2nd gen, us-central1): `submitSimulationJob`, `onNewJob`, `refundJob` (one Node code base), `createPayPalOrder`, `capturePayPalOrder` (another), `run_lap_calc` (Python). `source/<name>/source.zip` is the exact archive deployed, pinned to its storage generation; `unzipped/` is it opened. `functions_list.json` is their full configuration. | From the functions' source bucket. |
| `containers/` | Source of the three container images: `turboflow-tessellate` (Cloud Run service, the image live now), `simscale-job` and `simscale-job-supabase` (Cloud Run jobs, the image tagged latest). `BUILD_INFO.txt` names the Cloud Build that made each image. | From the Cloud Build source bucket, matched to the running image by digest. |
| `cloud_run/` | Definitions of the 7 Cloud Run services and 2 jobs (image, region, scaling, environment). | `gcloud run ... describe/list` |
| `rules/` | Firestore rules (released 30 Jul 2026) and Storage rules (30 Jul 2026), exactly as released. | Firebase Rules API |
| `firestore/` | Database settings (`(default)`, me-central1, native mode), composite indexes, field overrides. | Firestore Admin API |
| `auth/` | Sign-in settings: Google only, email/password and anonymous off, authorized domains. | Identity Platform config |
| `project/` | Firebase project, web app and its config, IAM policy. | |
| `cloud_build/builds.json` | The last 53 builds and where their source is kept. | |
| `storage/buckets.json` | The project's four buckets (names and settings, not contents). | |
| `data/firestore_documents.json` | Every Firestore document, 782 of them: 83 users with 448 transaction records under them, 236 jobs, 6 + 5 Ko-fi, 3 PayPal orders, 1 top-level transaction. Firestore's typed JSON, so a restore writes back the same types. Personal data: emails, names, payments. | Firestore REST, read-only |
| `data/auth_users.json` | The 86 sign-in accounts, all Google, no password hashes. | Identity Toolkit, read-only |

`SHA256SUMS.txt` lists a checksum for every file here. To check the backup
later, from this folder: `sha256sum -c SHA256SUMS.txt`.

## Added later on 24 Sep

| File | What |
|---|---|
| `fusion_addin/` | The old Fusion add-in the live site hands out (`TurboFlow_CFD.zip`, 4 Aug 2026), for the compatibility test. Its built-in refresh token is a one-character placeholder, not a credential. |
| `prod-setup-2026-09-24.log` | Every command of the additive production setup (see `docs/PROD_CUTOVER.md` in the repo), with results. No secret values. |
| `prod-geometry.yaml`, `prod-worker.yaml`, `prod-storage-cors.json` | The definitions that setup applied. |

## Not in this backup

- **Uploaded files.** The 716 files (493 MB) in the Storage bucket are not copied.
  The database and the accounts are, in `data/` (below).
- **The container images themselves**, only the source they were built from.
  The images stay in `gcr.io/turboflow-7b3ca`.
- **Secret Manager and Cloud Scheduler.** Neither API is enabled on the
  project, so there is nothing there to copy.

## Restoring

- Website: `firebase deploy --only hosting` from a folder whose `firebase.json`
  uses `website/turboflow-7b3ca/version.json`'s config and `public/` as the
  public directory. Leave out `.claude/`, `.github/`, `functions/` and the two
  `tmp_*.png` screenshots: they were deployed by mistake (see below).
- Functions: each `unzipped/` folder is a deployable function source.
- Rules and indexes: `firebase deploy --only firestore,storage` with the files
  in `rules/` and `firestore/`.

## Found while taking it

- The live site serves the backend source to anyone: `/functions/index.js`
  (identical to the deployed functions), `/functions/package-lock.json`,
  `/.claude/settings.local.json`, `/.github/workflows/...` and two screenshots.
  The whole project folder was deployed as the website. No secret values are in
  those public files; the only key on the site is the Firebase web API key,
  which is public by design.
- `simscale-job`'s code has the live SimScale API key written into it (line 48
  of `simscale_job.py`), where the newer `simscale-job-supabase` reads it from
  its environment.
