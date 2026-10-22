# supabase/env: every environment value, in one folder

The same convention as the Firebase build's `env/`: the sources are here, and
the copies the tools read are generated from them.

| File | Committed | What it is |
|---|---|---|
| `web.dev.js` | yes | URL and anon key of the development project. Copied to `public/supabase-config.js` by `scripts/sync-env.mjs` (`npm run dev`, `npm run build`). Public by design: every browser gets these, and RLS protects the data. |
| `web.prod.example.js` | yes | Template for `web.prod.js`, used by `npm run build:prod`. |
| `web.prod.js` | once it exists | Production's URL and anon key. Public, like `web.dev.js`. |
| `functions.dev.env.example` | yes | Edge function secrets for a development project: the SimScale mock, `TURBOFLOW_ENV=development`. |
| `functions.dev.env` | **no** | The filled-in copy. |
| `functions.prod.env.example` | yes | Production's function secrets, as placeholders. |
| `functions.prod.env` | **no** | Production's real SimScale, PayPal and Discord values. Never committed. |

Function secrets are set with the CLI only:

```bash
supabase secrets set --env-file supabase/env/functions.dev.env --project-ref <ref>
```

Two values are not here:

- `supabase/.env.local` (ignored) holds `SUPABASE_DB_URL` for the tests and
  dev scripts.
- `internal_secret`, which pg_cron and the pipeline functions share, is
  generated in the database's vault by a migration. It never appears in a
  file. `functions_url` is set in the vault per environment
  (`supabase/dev/apply.mjs`, or the SQL in docs/CUTOVER.md).

If a secret ever lands in a committed file, rotate it: deleting the file
doesn't remove it from history.
