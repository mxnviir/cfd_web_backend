-- Row level security: firestore.rules, clause by clause.
--
-- docs/RLS_CHECKLIST.md maps every match block and condition in the old rules
-- to the policy, grant, constraint or function below that replaces it.
--
-- Two mechanisms, used for different things:
--   RLS policies decide which ROWS a session may see or touch.
--   Column grants decide which COLUMNS it may write. They are the equivalent
--   of the rules' changed().hasOnly([...]): a column with no UPDATE grant
--   cannot be written by a client at all, whatever the policy says.
--
-- Clients never get a grant on anything that decides money: credits, cost,
-- charged_at, status, versions, validation, shared_with. Those are written by
-- the ops router, which talks to Postgres as the database owner.

-- Helpers the policies call. SECURITY DEFINER so a policy on one table can
-- look at another without recursing through that table's own policies.
create schema if not exists rls;
grant usage on schema rls to anon, authenticated;

create or replace function rls.uid_text() returns text
language sql stable set search_path = '' as $$ select auth.uid()::text $$;

-- The caller's folder under users/.
create or replace function rls.storage_uid() returns text
language sql stable security definer set search_path = '' as $$
  select storage_uid from public.users where id = auth.uid()
$$;

-- Owner of the group, or someone it was shared with at any level.
create or replace function rls.is_member(gid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.groups g
     where g.id = gid
       and (g.user_id = auth.uid() or g.shared_with ? auth.uid()::text))
$$;

-- Owner of the group, or shared with "edit".
create or replace function rls.can_edit(gid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.groups g
     where g.id = gid
       and (g.user_id = auth.uid() or g.shared_with ->> auth.uid()::text = 'edit'))
$$;

create or replace function rls.owns_geometry(gid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.geometries where id = gid and user_id = auth.uid())
$$;

create or replace function rls.sees_geometry(gid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.geometries g
     where g.id = gid
       and (g.user_id = auth.uid() or (g.group_id is not null and rls.is_member(g.group_id))))
$$;

create or replace function rls.owns_run(rid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.runs where id = rid and user_id = auth.uid())
$$;

-- A storage path a client may name on a geometry: under its own folder.
-- (firestore.rules ownPath). The legacy jobs/<id>/<file> form is accepted
-- for rows that carry it; only the server ever writes one.
create or replace function rls.own_path(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p is null
      or p ~ ('^users/' || (select storage_uid from public.users where id = auth.uid())
              || '/geometries/[^/]+/[^/]+$')
      or p ~ '^jobs/[^/]+/[^/]+$'
$$;

revoke all on all functions in schema rls from public;
grant execute on all functions in schema rls to anon, authenticated;

-- Start from nothing, then grant exactly what a client needs.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['users', 'transactions', 'groups', 'geometries',
    'geometry_versions', 'selections', 'artifact_intents', 'simulations', 'runs',
    'post_states', 'jobs', 'config', 'fusion_tokens', 'fusion_token_listing',
    'paypal_orders', 'rate_counters']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ── users/{uid} ─────────────────────────────────────────────────────────────
-- get: owner. list, create, delete: denied. update: profile fields only.
grant select on public.users to authenticated;
grant update (name, team_name, region, contact_email, lap_calc_defaults,
              job_race_times, last_seen, workbench_defaults) on public.users to authenticated;
create policy users_read on public.users for select to authenticated
  using (id = auth.uid());
create policy users_profile on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ── users/{uid}/transactions ────────────────────────────────────────────────
grant select on public.transactions to authenticated;
create policy transactions_read on public.transactions for select to authenticated
  using (user_id = auth.uid());

-- ── groups ─────────────────────────────────────────────────────────────────
grant select, delete on public.groups to authenticated;
grant insert (id, user_id, name, description, category, tags, unit_system)
  on public.groups to authenticated;
grant update (name, description, category, tags, unit_system, thumbnail_path, lock)
  on public.groups to authenticated;
create policy groups_read on public.groups for select to authenticated
  using (user_id = auth.uid() or shared_with ? auth.uid()::text);
create policy groups_create on public.groups for insert to authenticated
  with check (user_id = auth.uid());
create policy groups_update on public.groups for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy groups_delete on public.groups for delete to authenticated
  using (user_id = auth.uid());

-- ── geometries ─────────────────────────────────────────────────────────────
grant select, delete on public.geometries to authenticated;
grant insert (id, user_id, group_id, name, description, format, step_path, label_path,
              glb_path, source_step_path, prepared_by, bbox, face_count, solid_count,
              triangle_count, wheel_count) on public.geometries to authenticated;
grant update (name, description, glb_path, bbox, face_count, solid_count,
              triangle_count, wheel_count) on public.geometries to authenticated;
create policy geometries_read on public.geometries for select to authenticated
  using (user_id = auth.uid() or (group_id is not null and rls.is_member(group_id)));
create policy geometries_create on public.geometries for insert to authenticated
  with check (
    user_id = auth.uid()
    and (group_id is null or rls.is_member(group_id))
    and rls.own_path(step_path)
    and rls.own_path(label_path)
    and rls.own_path(source_step_path));
create policy geometries_update on public.geometries for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy geometries_delete on public.geometries for delete to authenticated
  using (user_id = auth.uid());

grant select on public.geometry_versions to authenticated;
create policy geometry_versions_read on public.geometry_versions for select to authenticated
  using (rls.sees_geometry(geometry_id));

-- ── geometries/{id}/selections ──────────────────────────────────────────────
grant select, delete on public.selections to authenticated;
grant insert (id, geometry_id, user_id, name, entity_type, step_ids) on public.selections to authenticated;
grant update (name, entity_type, step_ids) on public.selections to authenticated;
create policy selections_all on public.selections for all to authenticated
  using (rls.owns_geometry(geometry_id))
  with check (rls.owns_geometry(geometry_id) and user_id = auth.uid());

-- ── geometries/{id}/artifact_intents ────────────────────────────────────────
-- create/delete: server only. update: the state, by the owner or an editor.
grant select on public.artifact_intents to authenticated;
grant update (state, consumed_at, error) on public.artifact_intents to authenticated;
create policy intents_read on public.artifact_intents for select to authenticated
  using (user_id = auth.uid() or (group_id is not null and rls.is_member(group_id)));
create policy intents_update on public.artifact_intents for update to authenticated
  using (user_id = auth.uid() or (group_id is not null and rls.can_edit(group_id)))
  with check (state in ('consumed', 'failed', 'cancelled'));

-- ── simulations ────────────────────────────────────────────────────────────
grant select, delete on public.simulations to authenticated;
grant insert (id, user_id, group_id, geometry_id, geometry_version, name, analysis,
              spec, mesh_spec, setup, primitives, setup_source) on public.simulations to authenticated;
grant update (geometry_id, geometry_version, name, analysis, spec, mesh_spec, setup,
              primitives, setup_source) on public.simulations to authenticated;
create policy simulations_read on public.simulations for select to authenticated
  using (user_id = auth.uid() or (group_id is not null and rls.is_member(group_id)));
create policy simulations_create on public.simulations for insert to authenticated
  with check (
    user_id = auth.uid()
    and (group_id is null or rls.is_member(group_id))
    and (geometry_id is null or rls.sees_geometry(geometry_id)));
create policy simulations_update on public.simulations for update to authenticated
  using (user_id = auth.uid() or (group_id is not null and rls.can_edit(group_id)))
  with check (geometry_id is null or rls.sees_geometry(geometry_id));
create policy simulations_delete on public.simulations for delete to authenticated
  using (user_id = auth.uid());

-- ── runs, and runs/{id}/post_states ─────────────────────────────────────────
grant select on public.runs to authenticated;
create policy runs_read on public.runs for select to authenticated
  using (user_id = auth.uid() or (group_id is not null and rls.is_member(group_id)));

grant select, delete on public.post_states to authenticated;
grant insert (id, run_id, user_id, state) on public.post_states to authenticated;
grant update (state) on public.post_states to authenticated;
create policy post_states_all on public.post_states for all to authenticated
  using (rls.owns_run(run_id))
  with check (rls.owns_run(run_id) and user_id = auth.uid());

-- ── jobs ───────────────────────────────────────────────────────────────────
-- get/list: owner. Every write goes through the ops router.
grant select on public.jobs to authenticated;
create policy jobs_read on public.jobs for select to authenticated
  using (user_id = auth.uid());

-- ── config, tokens, orders, counters ────────────────────────────────────────
grant select on public.config to anon, authenticated;
create policy config_read on public.config for select to anon, authenticated using (true);

grant select on public.fusion_token_listing to authenticated;
create policy fusion_listing_read on public.fusion_token_listing for select to authenticated
  using (user_id = auth.uid());

-- fusion_tokens, paypal_orders, rate_counters: RLS on, no policy, no grant.

-- ── realtime ───────────────────────────────────────────────────────────────
-- Realtime applies the select policies above to each subscriber.
alter table public.groups replica identity full;
alter table public.geometries replica identity full;
alter table public.simulations replica identity full;
alter table public.runs replica identity full;
alter publication supabase_realtime add table
  public.users, public.transactions, public.groups, public.geometries,
  public.simulations, public.runs, public.jobs, public.config;
