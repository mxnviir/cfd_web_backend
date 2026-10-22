# firestore.rules and storage.rules → Postgres

Every clause of the Firebase rules (kept for reference in
`docs/reference/firestore.rules` and `docs/reference/storage.rules`), and what
enforces it now. Test names in *italics* are assertions in
`supabase/tests/money.sql` (`npm run test:money`) unless marked *pipeline*
(`supabase/tests/pipeline.mjs`).

The mechanisms:

- **Policy**: an RLS policy in `supabase/migrations/20261022000200_rls.sql`
  (`20261022000400_storage.sql` for Storage). It decides which rows.
- **Grant**: a column-level `GRANT INSERT/UPDATE (cols)`. It decides which
  columns a client may write at all. This is the equivalent of the rules'
  `changed().hasOnly([...])`; a column with no grant cannot be written by a
  client whatever any policy says.
- **Check**: a `CHECK` constraint (`20261022000100_schema.sql`). It holds for
  every writer, the server included.
- **Router**: the ops edge function (`supabase/functions/ops`), talking to
  Postgres as the owner. Rules with no clean RLS form live here, or in a
  `private.*` function the router calls. `private` is not exposed by PostgREST
  and grants nothing to `anon`, `authenticated` or `service_role`
  (*no money function is executable by a client role*).

Two things that change shape rather than meaning:

- **Fusion sessions (`human()`)**. A session minted from a connection token
  never becomes a Supabase JWT: it is a `tfs_` token the router verifies in
  Postgres (`private.fusion_session`). So no Fusion session reaches PostgREST,
  and every table rule below applies only to people. Ops marked `human: true`
  in `ops/index.ts` refuse Fusion sessions (deleteGroup, copyGroup, shareGroup,
  unshareGroup, ensureAccount, both PayPal ops, revokeFusionToken,
  finishResults; createFusionToken refuses them in its handler).
- **list vs get**. Firestore distinguished a query from a single read and needed
  `canList()` so that a query by `group_id` could be proven safe. A Postgres
  policy is evaluated per row, so one `SELECT` policy covers both and a query
  by `group_id` simply returns the rows the caller may see.

## Helper functions

| Rule helper | Now |
|---|---|
| `signedIn()` | Policies are `to authenticated`; `anon` has no grant on any private table (*anon cannot read anything private*). |
| `isOwner(uid)` | `user_id = auth.uid()` (`id = auth.uid()` on `users`). |
| `textOk(v, max)` | `CHECK (char_length(col) <= max)` on the same columns with the same limits. |
| `mapOk(v, maxKeys)` | `CHECK (public.jsonb_keys(col) <= maxKeys)`. |
| `changed().hasOnly([...])` | Column grants. |
| `jobOwnerField()` (`user_id` or `userId`) | Jobs are created only by the router, which writes `user_id`. |
| `groupDoc`, `ownsGroup`, `sharedWith`, `memberOf` | `rls.is_member(gid)`: owner, or a key in `shared_with`. SECURITY DEFINER so a policy on one table can read `groups`. |
| `canList(field)` | Unneeded: per-row policies (see above). |
| `canEditGroup(gid)` | `rls.can_edit(gid)`: owner, or `shared_with ->> uid = 'edit'`. |
| `human()` | See "Fusion sessions" above. |
| `ownJobPath(p, jobId)` | Jobs are router-only; SUBMIT re-checks `ownedPath()` (`users/<owner>/` or `jobs/<this job>/`) before reading a STEP, as the worker did. |
| `ownPath(p)` | `rls.own_path(p)`: null, under `users/<caller's storage_uid>/geometries/*/*`, or `jobs/*/*`. |

## users/{uid}

| Clause | Now | Test |
|---|---|---|
| `get: isOwner(uid)` | Policy `users_read`: `id = auth.uid()`. | *another account's row is not visible* |
| `list: false` | Same policy: a list returns only the caller's own row. | |
| `create: false` | No INSERT grant. The row is written by `private.ensure_account` through the router's `ensureAccount`, Google accounts only. | *a client cannot create its own account row*; *pipeline: ensureAccount creates the account* |
| `delete: false` | No DELETE grant. | |
| `update: isOwner && not fusion && changed().hasOnly([name, team_name, region, contact_email, lap_calc_defaults, job_race_times, last_seen, workbench_defaults, teamName, contactEmail])` | Policy `users_profile` and an UPDATE grant on exactly those columns. `teamName` and `contactEmail` were the classic site's spellings of two of them; `src/lib/compat.js` writes them as `team_name` and `contact_email`. | *a client cannot change its own credit balance*, *...sponsor rate*, *...unlimited pass*, *...per-credit price*, *...storage quota*, *...storage folder*; *a normal profile name is accepted* |
| `last_seen == request.time` | Trigger `users_last_seen` stamps `now()` whatever was sent. | *last_seen is stamped by the server* |
| `textOk(name, 200)`, `team_name 200`, `region 200`, `contact_email 320` | CHECK constraints. | *an oversized profile name is refused* |
| `mapOk(lap_calc_defaults, 50)`, `job_race_times 500`, `workbench_defaults 50` | CHECK constraints. | |

## users/{uid}/transactions (the ledger)

| Clause | Now | Test |
|---|---|---|
| `read: isOwner(uid)` | Policy `transactions_read`. | *a client reads its own ledger ...and nobody else's* |
| `write: false` | No INSERT/UPDATE/DELETE grant. Rows are written only by `private.charge_job`, `give_back`, `apply_purchase` and `ensure_account`. | *a client cannot write its own ledger row*, *...edit a ledger row* |

## jobs/{jobId}

| Clause | Now | Test |
|---|---|---|
| `get`, `list`: owner | Policy `jobs_read`: `user_id = auth.uid()`. | *a stranger cannot read a job*; *the owner can read their job* |
| `create`: owner, status pending/draft, no `cost`, no `charged_at`, own paths, text/map limits | **Moved to the router.** No client INSERT grant at all. The only creator is `queueRun`, which inserts the job and calls `private.charge_job` in one transaction. The price is computed in SQL from server-clamped parameters. `file_name`, `team_name`, `part` and `setup_snapshot` keep their CHECK limits. | *a client cannot create a job*; *a job carrying its own cost is refused*; *a job cannot be created for another user*; *an oversized job file name is refused* |
| `update, delete: false` | No grant. Status moves through `private.*` and the pipeline only. | *a client cannot move a job's status itself*; *...write a job's cost* |

Tightening: the Fusion add-in used to create its job document directly. It can't
reach Supabase as built (it's hard-wired to Firebase URLs); a rebuilt add-in
queues through the router (see CUTOVER.md).

## groups/{groupId}

| Clause | Now | Test |
|---|---|---|
| `read`: owner or shared | Policy `groups_read`: `user_id = auth.uid() or shared_with ? auth.uid()`. | *a stranger cannot read a group that is not shared*; *a collaborator with view can read the group* |
| `delete: human() && owner` | Policy `groups_delete` (owner). The `deleteGroup` op (human-only) is what the app calls; it refuses while a run is in flight. | *someone else's group cannot be deleted* |
| `create`: `user_id == auth.uid`, name ≤ 200, description ≤ 2000 | Policy `groups_create` + INSERT grant on `id, user_id, name, description, category, tags, unit_system` + CHECKs. | *a client can create its own group*; *a group cannot be created for someone else*; *a group name over 200 characters is refused* |
| `update`: owner, `user_id` unchanged, not `shared_with`/`shared_emails`/`counts`, limits | Policy `groups_update` + UPDATE grant on `name, description, category, tags, unit_system, thumbnail_path, lock` only. | *a collaborator cannot promote themselves to edit*; *the owner cannot rewrite shared_with directly either*; *nor the counts*; *nor hand the group to someone else* |

Tightening: a client can no longer *create* a group that is already shared
(`shared_with` had no create-time check). Sharing is the `shareGroup` op only
(*a new group cannot come pre-shared*).

## runs/{runId} and runs/{runId}/post_states

| Clause | Now | Test |
|---|---|---|
| `get`/`list`: owner, or member of its group | Policy `runs_read`. | *a collaborator can list the shared group's runs*; *a stranger cannot* |
| `create, update, delete: false` | No grant. Runs are written by `queueRun`, the pipeline and `private.*`. | *a client cannot write a run document*; *a client cannot claim a result it never paid for* |
| `post_states` read/write: run owner, ≤ 60 keys | Policy `post_states_all` (`rls.owns_run`) + CHECK `jsonb_keys(state) <= 60`. | *the owner keeps a post-processing state*; *a collaborator cannot write one on the owner's run* |

## geometries/{geometryId}

| Clause | Now | Test |
|---|---|---|
| `get`/`list`: owner or member | Policy `geometries_read`. | *a collaborator can list the shared group's geometries*; *a stranger cannot list another team's geometries* |
| `delete: human() && owner` | Policy `geometries_delete`. | |
| `create`: owner; group must be one the caller is in; `ownPath` on `step_path`, `label_path`, `source_step_path`; name ≤ 200, glb_path ≤ 400; `prepared_by` in workbench/fusion | Policy `geometries_create` (owner, `rls.is_member`, `rls.own_path` ×3) + INSERT grant + CHECKs (incl. `prepared_by in ('workbench','fusion')`). | *a stranger cannot file a geometry into a group they are not in*; *a geometry with no group is still allowed*; *a geometry cannot point at another user's files* |
| `update`: owner; only `name, description, glb_path, bbox, face_count, solid_count, triangle_count, wheel_count`; never `status, versions, current_version, error` | Policy `geometries_update` + UPDATE grant on exactly those columns. `versions` is also derived: it is folded from `geometry_versions`, which no client can write. | *a client cannot mark a geometry ready*; *...write a geometry's versions*; *...write a version row*; *the owner renames their geometry* |

Tightening: a client can no longer *create* a geometry already carrying
`status` or `versions` (the create rule didn't forbid them). Geometries are
made by `createUploadIntent` (*a client cannot create a geometry already
marked ready*).

New table, same rule: `geometry_versions` has a SELECT policy equal to its
geometry's and no write grant (*a collaborator sees the version; a stranger
does not*).

### geometries/{id}/selections

| Clause | Now | Test |
|---|---|---|
| read/write: geometry owner; name ≤ 200; `entity_type` face/solid; ≤ 5000 `step_ids` | Policy `selections_all` (`rls.owns_geometry`) + CHECKs. | *a stranger cannot save a selection on someone else's geometry*; *the owner saves a selection*; *a selection over 5000 faces is refused* |

### geometries/{id}/artifact_intents

| Clause | Now | Test |
|---|---|---|
| read: owner or member | Policy `intents_read`. | |
| `create: false`, `delete: false` | No grant. Minted by `createCarIntent` / `createArtifactIntent`. | *a client cannot reserve its own upload paths* |
| update: owner or editor; only `state, consumed_at, error`; state → consumed/failed/cancelled | Policy `intents_update` (`with check state in (...)`) + UPDATE grant on those three columns. | *a client cannot rewrite the reserved paths*; *...mark its own build ingested*; *a view-only collaborator cannot move the state*; *the owner marks the upload consumed* |

## simulations/{simulationId}

| Clause | Now | Test |
|---|---|---|
| `get`/`list`: owner or member | Policy `simulations_read`. | *a collaborator with view can read the group's simulations*; *a stranger cannot read a simulation in a group they were not given* |
| `delete: human() && owner` | Policy `simulations_delete`. | |
| `create`: owner; group the caller is in; name ≤ 200; setup ≤ 200 keys, spec ≤ 30, mesh_spec ≤ 30; no `validation` | Policy `simulations_create` + INSERT grant without `validation` + CHECKs. | *nor create one already valid*; *nor create one in a group they are not in* |
| `update`: owner or editor; `user_id` unchanged; limits; never `validation` | Policy `simulations_update` + UPDATE grant without `user_id` or `validation`. | *a client cannot mark its own simulation valid*; *a collaborator with view cannot edit a setup*; *a collaborator with edit can*; *a simulation cannot change hands*; *an oversized simulation name is refused* |
| (`onSimulationWritten`) | Trigger `simulations_revalidate` sends a client's direct write back to the router (`revalidateSimulation`, internal only), which writes `validation`. | |

Tightening: a simulation's `geometry_id` must be a geometry the caller can see
(*nor point one at a geometry they cannot see*). Before, the checker read any
geometry id it was given with admin credentials.

## Server-only collections

| Rule | Now | Test |
|---|---|---|
| `config/{doc}`: read true, write false | Policy `config_read` for `anon` and `authenticated`; SELECT grant only. | *anon can read the public prices* |
| `users/{uid}/fusion_tokens`: owner read, no write | Table `fusion_token_listing`: policy `fusion_listing_read`, SELECT grant only. | *the owner sees the listing ...and nobody else does*; *a client cannot write its own token listing* |
| `fusion_tokens/{hash}`: none | RLS on, no policy, no grant. Read only by `private.fusion_session` and the router. | *the token hashes are invisible, even to their owner*; *a client cannot mint a token hash* |
| `paypal_orders/{id}`: none | RLS on, no policy, no grant. | *paypal_orders are invisible to their own buyer*; *a client cannot open its own PayPal order* |
| `rate/{id}`: none | `rate_counters`: RLS on, no policy, no grant. | *rate counters are invisible*; *a client cannot reset its rate counter* |
| `/{document=**}`: deny | Every grant on `public` revoked from `anon`/`authenticated` before the specific grants above; RLS enabled and forced on every table. | |

## Money (rules plus the callables they protected)

| Guarantee | Now | Test |
|---|---|---|
| Charged exactly once, at the server's price | `private.charge_job` locks the job and the user row, refuses if a charge row or `charged_at` exists, prices from clamped columns. `queueRun` calls it in the transaction that creates the run. | *a second charge of the same job takes nothing*; *parameters are clamped before pricing*; *pipeline: queueRun quotes the server's price ... and takes it once*; *pipeline: job ...: one charge row* |
| Refund = ledger, never a job field | `private.give_back`: outstanding = charges − refunds/reversals, written once under a deterministic id. | *a forged job refunds ZERO, not its stated cost* |
| Refund tiers | `private.refundable`: full refund at draft, pending, downloading, uploading_geometry, processing, creating_simulation, checking; none from meshing on. Applies to `refundJob` and `cancelRun`. | *refund tiers: refundJob at every status*, *...cancelRun at every status*; *pipeline: cancelling before the mesher refunds in full*, *cancelling while meshing refunds nothing* |
| Failure before solving is reversed; after, the charge stands | `private.fail_job`: reversal iff no `mesh_id` and no SimScale run id. | *a run that fails before solving gives the credits back*; *a run that fails after meshing keeps the charge*; *pipeline: the run fails ... charge stands* |
| Signup bonus once | `private.ensure_account`: `on conflict do nothing`, bonus only on insert. | *ensureAccount on an existing account changes nothing* |
| PayPal granted once, server-side | `private.apply_purchase` deletes the order row in the transaction that grants. | *...once: capture and webhook cannot both grant* |
| Unlimited pass and sponsor rates are server-owned | No client grant on `unlimited_*`, `sponsored`, `sponsor_rate`, `usd_per_credit`, `unlimited_usd`. | *a sponsored team pays its rate*; *an unlimited pass pays nothing* |

## storage.rules

| Clause | Now | Test |
|---|---|---|
| `users/{uid}/geometries/{gid}/{file}`: read/delete owner | `rls.may_read` / `rls.may_delete`: under `users/<caller's storage_uid>/`. | *pipeline: a stranger cannot upload into the owner's folder*; *a stranger does not (read)* |
| ...create: owner, new object, file in raw.step/raw.stp/geometry.step/entity_labels.csv, < 60 MB | `rls.may_upload`: those names, **and** the path must be the geometry's `raw_path`/`step_path`/`label_path` that `createUploadIntent` recorded for the caller. No UPDATE policy, so uploads are write-once (an upsert needs UPDATE). | *the owner uploads the raw file createUploadIntent reserved ...but not a raw file nobody reserved ...nor into someone else's folder*; *pipeline: ...and not again (write-once)* |
| `.../{versionDir}/{file}`: read owner if `v[0-9]+`, no write | `rls.may_read` allows `v[0-9]+/*`; `may_upload` and `may_delete` refuse it. | *...nor into a version folder*; *a version file cannot be deleted by the client* |
| `.../incoming/{token}/{file}`: get/delete owner; create new, token shape, file list, < 200 MB | `may_upload`: file list, **and** an `artifact_intents` row with that token, for that geometry and caller, still `open` or `consumed`. | *the staging folder of an open intent is writable ...a made-up token is not ...nor a file that does not belong in staging ...nor a closed intent's staging* |
| `jobs/{jobId}/{file}`: first writer creates; get/delete effectively denied | Not writable by clients. Only installed Fusion add-ins wrote here, and they cannot reach Supabase. Existing objects are migrated and readable by the pipeline (`ownedPath` accepts `jobs/<this job>/`). | |
| `users/{uid}/results/{jobId}/**`: get owner, no write | `may_read`: owner. `may_upload` adds the one client write FINISH needs: `results.glb`, `fields.json`, `fields/<name>.bin` of the caller's own job, only while it is `complete`, has a case, and has no `results_glb_path` yet. `finishResults` checks the GLB's magic and the field paths before filing them. | *results are not writable while the run is going*; *the owner uploads the viewer files of a finished run ...a collaborator does not ...and only once*; *the owner reads their results* |
| `results/{jobId}/**`: deny | Not copied by the migration and not readable. | |
| catch-all deny | No policy matches anything else in the bucket, and the bucket is private. | |

Differences in Storage:

- **Size limits**. A Storage policy cannot see an upload's size. The bucket's
  limit is 200 MB per object (the project-wide limit also applies: 50 MB on
  Free). The 60 MB raw limit is enforced by `createUploadIntent` against the
  declared size, as before, and the quota counts actual bytes.
- **Quota**. Firebase swept a client's over-quota upload after the fact. Here
  the trigger `turboflow_count_storage` keeps `users.storage_bytes`, and
  `may_upload` refuses every upload once an account is at its quota
  (*an account over its quota uploads nothing*). It prevents rather than sweeps.
- **List**. Firebase denied listing staging folders. Supabase's list uses the
  SELECT policy, so an owner can list their own staging folder. Nothing of
  anyone else's is listable.
- **Collaborators** still can't read a shared group's files, the same as
  before (`request.auth.uid == uid` in storage.rules).
