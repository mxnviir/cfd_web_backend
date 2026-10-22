# env — every environment variable and secret, in one folder

Nothing environment-specific lives anywhere else. The sources here are the only
files to edit; everything the tools read is generated from them by
`turboflow/scripts/sync-env.mjs` (run automatically by `npm run dev`,
`npm run build` and `npm run emulate`).

## What lives here

| File | Committed | What it is |
|---|---|---|
| `firebase/config.test.js` | yes | Web config for turboflow-test. Copied to `turboflow/public/firebase-config.js`, which the page loads. Public by design. |
| `firebase/config.prod.js` | yes | Web config for turboflow-7b3ca. Read by `scripts/build-prod-site.mjs` when stamping `dist-prod/`. Public by design — the live site has always served these values. |
| `functions/turboflow-7b3ca.env` | yes | Production functions config (`BUCKET_REGION`, `WORKER_JOB`, `PAYPAL_ENV`). Not secrets. Copied to `turboflow/functions/.env.turboflow-7b3ca`, the location firebase-tools reads at deploy time. |
| `functions/local.env.example` | yes | Template for local dev secrets (PayPal sandbox, Discord). Copy to `local.env`, fill in; the sync copies it to `turboflow/functions/.env.local`, which the emulator loads. |
| `functions/local.env` | **no** | The real local dev secrets. |
| `secrets/production.env.example` | yes | Template for the original app's live credentials. |
| `secrets/production.env` | **no** | Production's live PayPal credentials and Discord webhook, moved out of `cfd_web_frontend/functions/.env`. In production the same values live in Secret Manager. |
| `worker/simscale-job.env.example` | yes | Template for the SimScale worker's environment. |
| `worker/simscale-job.env` | **no** | The real worker environment for local runs. The worker loads it when present; on Cloud Run the same variables are set on the job. |
| `deploy/` | **no** | Generated deploy artifacts (`firebase.prod.json`). |

Committed rows are safe to read out loud; the ignored rows are not.

## Commands

```bash
# local site (emulator project demo-turboflow, test web config)
npm run dev            # turboflow/
npm run emulate        # turboflow/

# deploy: syncs env/functions/<project>.env into turboflow/functions/ first
npm run deploy -- --project turboflow-7b3ca --only functions,hosting

# production site build (no backup dir needed any more)
npm run build                          # turboflow/
node scripts/build-prod-site.mjs       # turboflow/ -> dist-prod/, env/deploy/firebase.prod.json
npm run deploy -- --project turboflow-7b3ca --only hosting --config env/deploy/firebase.prod.json
```

## Rules

- Edit files in this folder, never the generated copies in `turboflow/public/`
  or `turboflow/functions/` — those are rebuilt on every dev/build/deploy run.
- `*.env` files here are ignored by `env/.gitignore`; the `*.example` files next
  to them are the committed templates. If a secret ever lands in a committed
  file, rotate it — removing the file does not remove it from history.
- The Firebase web apiKeys are public identifiers, not secrets. The PayPal
  credentials, the Discord webhook, the SimScale key and any service-account
  JSON are secrets: Secret Manager in production, this folder (ignored) locally.
- `backups/` (ignored) holds the production backup, which contains old copies
  of some of these values. It stays out of git for the same reason.
