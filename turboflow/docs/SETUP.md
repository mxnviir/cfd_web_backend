# Setting up a TurboFlow project from scratch

Everything below was needed to get `turboflow-test` working and none of it is in
the code, so it would otherwise have to be rediscovered. Most of it a new
Firebase project does not do for you, and the failures are unhelpful: the
service-account gap in step 4 makes *every* function return
`Internal Server Error` with `Missing or insufficient permissions` buried in the
logs.

Replace `PROJECT` and `PROJECT_NUMBER` throughout.

## 1. Create the project

Firebase console → Add project. Then switch it to the **Blaze** plan; Cloud
Functions will not deploy on Spark. Set a budget alert while you are there —
$5/month is enough to notice a runaway.

## 2. Register a web app and record its config

```bash
firebase apps:create WEB "TurboFlow" --project PROJECT
firebase apps:sdkconfig WEB <appId> --project PROJECT
```

Put the values in `env/firebase/config.test.js` at the repo root. They are public
by design — they identify the project, they do not authorise anything.
`scripts/sync-env.mjs` copies them into `public/firebase-config.js` (generated,
git-ignored). What protects the data is `firestore.rules` and `storage.rules`.

## 3. Turn on the services

```bash
gcloud services enable secretmanager.googleapis.com identitytoolkit.googleapis.com --project PROJECT

# Firestore is created by the first rules deploy
firebase deploy --only firestore:rules --project PROJECT
```

**Storage** needs one click that has no API: Firebase console → Storage → Get
Started. Then `firebase deploy --only storage --project PROJECT`.

**Authentication**: initialise Identity Platform, then enable Google in the
console (Authentication → Sign-in method → Google → Enable, and pick a support
email). The console does this rather than the API because it provisions the
OAuth client for you.

```bash
curl -X POST "https://identitytoolkit.googleapis.com/v2/projects/PROJECT/identityPlatform:initializeAuth" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: PROJECT" -H "Content-Type: application/json" -d '{}'
```

Google is the only sign-in TurboFlow supports. Leave email/password and
anonymous off:

```bash
curl -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/PROJECT/config?updateMask=signIn.email.enabled,signIn.anonymous.enabled" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: PROJECT" -H "Content-Type: application/json" \
  -d '{"signIn":{"email":{"enabled":false},"anonymous":{"enabled":false}}}'
```

## 4. Grant the functions service account its roles

A new project does **not** give the default compute service account what Cloud
Functions v2 needs. Without these, builds fail and then every function fails at
runtime on its first Firestore call.

```bash
SA="PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for role in \
  roles/cloudbuild.builds.builder \
  roles/artifactregistry.writer \
  roles/storage.admin \
  roles/logging.logWriter \
  roles/datastore.user \
  roles/firebaseauth.admin \
  roles/iam.serviceAccountTokenCreator \
  roles/run.developer
do
  gcloud projects add-iam-policy-binding PROJECT \
    --member="serviceAccount:${SA}" --role="$role" --condition=None --quiet
done
```

Why each one is needed:

| Role | Without it |
|---|---|
| `cloudbuild.builds.builder` | functions will not build |
| `artifactregistry.writer` | the built image cannot be stored |
| `storage.admin` | the build source cannot be uploaded |
| `logging.logWriter` | nothing appears in the logs |
| `datastore.user` | **every** function fails on its first Firestore call |
| `firebaseauth.admin` | `auth.getUser` and `createCustomToken` fail |
| `iam.serviceAccountTokenCreator` | connection tokens cannot be signed |
| `run.developer` | the SimScale worker cannot be started |

IAM takes about a minute to propagate. A function that failed before the grant
keeps failing until it is called again.

## 5. Create the secrets

`defineSecret` will not deploy a function whose secret is missing, so all four
must exist even on a project with no PayPal account. `secretValue()` reads the
literal `unset` back as empty, so PayPal reports "not configured" rather than
sending the word `unset` to PayPal and returning an auth error nobody can act on.

```bash
for s in PAYPAL_CLIENT_ID PAYPAL_SECRET PAYPAL_WEBHOOK_ID DISCORD_WEBHOOK_URL; do
  printf 'unset' | gcloud secrets create "$s" --project PROJECT \
    --replication-policy=automatic --data-file=-
done
```

Replace them with real values when you need them:

```bash
firebase functions:secrets:set PAYPAL_CLIENT_ID --project PROJECT
```

Only the production project id can ever reach live PayPal — see `paypalBase()`
in `functions/src/lib/config.ts`. Any other project is pinned to sandbox even if
it is handed live credentials by mistake.

## 6. TTL policies

Two collections are written expecting a TTL policy, which is a project setting
that code cannot declare. Without them they grow forever:

- `paypal_orders` on `expire_at` — abandoned checkouts
- `rate` on `expire_at` — rate-limit counters

Firestore console → TTL → Create policy, for each.

## 6b. Let the browser read the storage bucket

A new bucket has no CORS rules, and without them every model download from the
browser fails. The file comes back `200` with no `Access-Control-Allow-Origin`
header, so the fetch is blocked before any of your code sees it: the viewport
stays empty and nothing is logged anywhere. `storage-cors.json` in the repo root
holds the origins.

```
gcloud storage buckets update gs://<project>.firebasestorage.app   --cors-file=storage-cors.json --project <project>
```

Check it took, from outside the browser:

```
curl -s -D - -o /dev/null -H "Origin: https://<your host>" "<a download URL>"   | grep -i access-control
```

Add any new hosting origin to that file, custom domains included.

## 6c. The rate collection matters more than it looks

Both halves of the backend now count calls in the `rate` collection: the Cloud
Functions for the callables, and the geometry service for /inspect, /prepare,
/tessellate and /transform. Without the TTL policy on `rate.expire_at` the
collection grows forever, one document per user per endpoint per hour.

It is a project setting, not something code can declare: Firestore > TTL, field
`expire_at` on `rate`. The same goes for `paypal_orders.expire_at`.

## 7. Deploy

```bash
firebase deploy --project PROJECT
```

Hosting builds the site first (`npm run build`) and functions compile
TypeScript, both via `predeploy` hooks in `firebase.json`.

## 8. The SimScale worker

The Cloud Run job is not deployed by `firebase deploy`. It needs these
environment variables, none of which are in the source any more:

- `SIMSCALE_API_KEY`
- `SIMSCALE_PROJECT_ID`
- `STORAGE_BUCKET` (defaults to `<project>.firebasestorage.app`)

The worker refuses to start if any is missing, rather than failing part way
through a run.

For local runs, put them in `env/worker/simscale-job.env` at the repo root
(git-ignored; the worker loads it when present and never overrides variables
already in the environment). `env/worker/simscale-job.env.example` is the
template.

## Checks worth running afterwards

```bash
# the backend source must not be downloadable
curl -s -o /dev/null -w '%{http_code}\n' https://PROJECT.web.app/functions/index.js   # 404 or the site page, never source

# an unknown path must 404 rather than silently render the home page
curl -s -o /dev/null -w '%{http_code}\n' https://PROJECT.web.app/nope                 # 404

# a bad connection token must be refused
curl -s -X POST https://us-central1-PROJECT.cloudfunctions.net/exchangeFusionToken \
  -H 'Content-Type: application/json' -d '{"token":"tfk_bad"}'                        # 401
```

And `npm test`, which runs the security suite against the emulators.
