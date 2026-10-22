-- TurboFlow on Postgres: the tables.
--
-- One table per Firestore collection, snake_case throughout, and a user_id
-- ownership column on every row. Ids are text: rows migrated from Firestore
-- keep their document ids, and new rows get the same 20-character shape.
--
-- Columns that decide money or pipeline state (credits, cost, status,
-- versions, validation, ...) exist here like any other column. What keeps a
-- client from writing them is the column-level grants and RLS in the next
-- migration, and the PL/pgSQL in the one after that, which is the only code
-- that moves credits.

create extension if not exists pgcrypto with schema extensions;

-- Server-only objects live here. PostgREST does not expose this schema, and
-- nothing in it is granted to anon, authenticated or service_role.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- A Firestore-shaped id: 20 characters of [A-Za-z0-9].
create or replace function public.gen_id() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                           1 + (get_byte(b, i) % 62), 1), '' order by i)
  from extensions.gen_random_bytes(20) b, generate_series(0, 19) i
$$;

-- Top-level key count of a jsonb object; null counts as zero.
create or replace function public.jsonb_keys(v jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when v is null or jsonb_typeof(v) <> 'object' then 0
              else (select count(*)::int from jsonb_object_keys(v)) end
$$;

create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── enums ──────────────────────────────────────────────────────────────────
-- functions/src/lib/types.ts JOB_STATUS, in the same order.
create type public.job_status as enum (
  'draft', 'pending', 'downloading', 'uploading_geometry', 'processing',
  'creating_simulation', 'checking', 'meshing', 'running',
  'downloading_results', 'complete', 'failed', 'cancelling', 'cancelled'
);

-- ── accounts ───────────────────────────────────────────────────────────────
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  user_id uuid generated always as (id) stored,
  -- The folder under users/ that holds this account's files. A migrated
  -- account keeps its Firebase uid here so every stored path still resolves;
  -- a new account uses its own id.
  storage_uid text not null unique,
  legacy_uid text unique,
  email text,
  name text check (char_length(name) <= 200),
  team_name text check (char_length(team_name) <= 200),
  region text check (char_length(region) <= 200),
  contact_email text check (char_length(contact_email) <= 320),
  lap_calc_defaults jsonb check (public.jsonb_keys(lap_calc_defaults) <= 50),
  job_race_times jsonb check (public.jsonb_keys(job_race_times) <= 500),
  workbench_defaults jsonb check (public.jsonb_keys(workbench_defaults) <= 50),
  notifications jsonb not null default '[]',
  credits integer not null default 0,
  sponsored boolean not null default false,
  sponsor_rate numeric not null default 1,
  usd_per_credit numeric,
  unlimited_usd numeric,
  unlimited_until timestamptz,
  unlimited_started_at timestamptz,
  email_verified boolean not null default false,
  storage_bytes bigint not null default 0,
  storage_quota_bytes bigint,
  storage_over_quota boolean not null default false,
  extra jsonb,
  created_at timestamptz not null default now(),
  last_seen timestamptz
);

-- A client may write last_seen only as "now"; it is stamped here whatever
-- value was sent (firestore.rules: incoming().last_seen == request.time).
create or replace function private.stamp_last_seen() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.last_seen is distinct from old.last_seen then
    new.last_seen := now();
  end if;
  return new;
end $$;
create trigger users_last_seen before update on public.users
  for each row execute function private.stamp_last_seen();

-- The ledger. Ids are deterministic where a repeat must not double-count
-- (charge_<job>, refund_<job>, reversal_<job>, order_<order>, signup_bonus).
create table public.transactions (
  user_id uuid not null references public.users (id) on delete cascade,
  id text not null default public.gen_id(),
  type text not null check (type in (
    'simulation_charge', 'simulation_charge_reversal', 'refund',
    'purchase', 'unlimited_pass', 'signup_bonus')),
  amount integer not null,
  reason text,
  job_id text,
  order_id text,
  capture_id text,
  "timestamp" timestamptz not null default now(),
  primary key (user_id, id)
);
create index transactions_job on public.transactions (user_id, job_id);

-- ── groups ─────────────────────────────────────────────────────────────────
create table public.groups (
  id text primary key default public.gen_id(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text check (char_length(name) <= 200),
  description text check (char_length(description) <= 2000),
  category text,
  tags jsonb not null default '[]',
  unit_system text,
  thumbnail_path text,
  -- {uid: "view" | "copy" | "edit"}. Written by the shareGroup op only.
  shared_with jsonb not null default '{}',
  shared_emails jsonb not null default '{}',
  counts jsonb not null default '{}',
  lock jsonb,
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index groups_user on public.groups (user_id);
create index groups_shared on public.groups using gin (shared_with);
create trigger groups_touch before update on public.groups
  for each row execute function private.touch_updated_at();

-- ── geometries ─────────────────────────────────────────────────────────────
create table public.geometries (
  id text primary key default public.gen_id(),
  user_id uuid not null references public.users (id) on delete cascade,
  group_id text references public.groups (id) on delete set null,
  name text check (char_length(name) <= 200),
  description text check (char_length(description) <= 2000),
  format text,
  input_unit text,
  import_options jsonb,
  raw_path text,
  step_path text,
  label_path text,
  glb_path text check (char_length(glb_path) <= 400),
  source_step_path text,
  prepared_by text not null default 'workbench' check (prepared_by in ('workbench', 'fusion')),
  size_bytes bigint,
  status text,
  error text,
  current_version integer not null default 0,
  -- Derived from geometry_versions by trigger, so a reader gets the whole
  -- geometry, versions included, from one row and one realtime event.
  versions jsonb not null default '{}',
  domain_status text,
  domain_error text,
  domain_options jsonb,
  bbox jsonb check (public.jsonb_keys(bbox) <= 20),
  face_count integer,
  solid_count integer,
  triangle_count integer,
  wheel_count integer,
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index geometries_group on public.geometries (group_id);
create index geometries_user on public.geometries (user_id);
create trigger geometries_touch before update on public.geometries
  for each row execute function private.touch_updated_at();

-- One row per version of a geometry: the raw car, and every tunnel built
-- around it. `data` is the version document exactly as the Workbench reads it.
create table public.geometry_versions (
  geometry_id text not null references public.geometries (id) on delete cascade,
  version integer not null,
  user_id uuid not null references public.users (id) on delete cascade,
  kind text generated always as (data ->> 'kind') stored,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (geometry_id, version)
);

create or replace function private.fold_versions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare gid text := coalesce(new.geometry_id, old.geometry_id);
begin
  update public.geometries g
     set versions = coalesce((select jsonb_object_agg(v.version::text, v.data)
                                from public.geometry_versions v
                               where v.geometry_id = gid), '{}')
   where g.id = gid;
  return null;
end $$;
create trigger geometry_versions_fold after insert or update or delete on public.geometry_versions
  for each row execute function private.fold_versions();

-- Saved face selections (geometries/{id}/selections).
create table public.selections (
  id text primary key default public.gen_id(),
  geometry_id text not null references public.geometries (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  name text check (char_length(name) <= 200),
  entity_type text not null default 'face' check (entity_type in ('face', 'solid')),
  step_ids jsonb not null default '[]' check (jsonb_array_length(step_ids) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index selections_geometry on public.selections (geometry_id);
create trigger selections_touch before update on public.selections
  for each row execute function private.touch_updated_at();

-- A browser build's reserved upload paths (geometries/{id}/artifact_intents).
create table public.artifact_intents (
  token text primary key,
  geometry_id text not null references public.geometries (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  group_id text,
  kind text not null default 'tunnel' check (kind in ('tunnel', 'car')),
  version integer not null,
  reserve_bytes bigint not null default 0,
  paths jsonb not null,
  state text not null default 'open'
    check (state in ('open', 'consumed', 'failed', 'cancelled', 'ingested')),
  error text,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  ingested_at timestamptz
);
create index artifact_intents_geometry on public.artifact_intents (geometry_id, state);

-- ── simulations ────────────────────────────────────────────────────────────
create table public.simulations (
  id text primary key default public.gen_id(),
  user_id uuid not null references public.users (id) on delete cascade,
  group_id text references public.groups (id) on delete set null,
  geometry_id text references public.geometries (id) on delete set null,
  geometry_version integer,
  name text check (char_length(name) <= 200),
  analysis text,
  spec jsonb check (public.jsonb_keys(spec) <= 30),
  mesh_spec jsonb check (public.jsonb_keys(mesh_spec) <= 30),
  setup jsonb check (public.jsonb_keys(setup) <= 200),
  primitives jsonb not null default '[]',
  -- What the server decided about this setup. Never client-written.
  validation jsonb,
  setup_source text,
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index simulations_group on public.simulations (group_id);
create index simulations_user on public.simulations (user_id);
create trigger simulations_touch before update on public.simulations
  for each row execute function private.touch_updated_at();

-- ── runs: what the Workbench watches ───────────────────────────────────────
create table public.runs (
  id text primary key default public.gen_id(),
  user_id uuid not null references public.users (id) on delete cascade,
  group_id text references public.groups (id) on delete set null,
  simulation_id text,
  simulation_name text,
  geometry_id text,
  geometry_version integer,
  job_id text,
  name text,
  kind text not null default 'run',
  status text not null default 'queued',
  stage_text text,
  progress real not null default 0,
  credits integer,
  refunded integer,
  queued_by uuid,
  spec_snapshot jsonb,
  mesh_snapshot jsonb,
  clamped jsonb,
  simscale jsonb not null default '{}',
  mesh jsonb,
  log_paths jsonb not null default '{}',
  plots jsonb,
  summary jsonb,
  results_glb_path text,
  results_fields jsonb,
  case_path text,
  error text,
  extra jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_group on public.runs (group_id);
create index runs_user on public.runs (user_id);
create index runs_simulation on public.runs (simulation_id);
create trigger runs_touch before update on public.runs
  for each row execute function private.touch_updated_at();

-- A user's post-processing view of a run (runs/{id}/post_states).
create table public.post_states (
  id text primary key default public.gen_id(),
  run_id text not null references public.runs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  state jsonb not null default '{}' check (public.jsonb_keys(state) <= 60),
  updated_at timestamptz not null default now()
);
create index post_states_run on public.post_states (run_id);
create trigger post_states_touch before update on public.post_states
  for each row execute function private.touch_updated_at();

-- ── jobs: billing, and the poller's state machine ──────────────────────────
create table public.jobs (
  id text primary key default public.gen_id(),
  user_id uuid not null references public.users (id) on delete cascade,
  group_id text,
  geometry_id text,
  simulation_ref text,
  run_ref text,
  source text not null default 'web',
  spec_mode boolean not null default false,
  status public.job_status not null default 'draft',
  step_path text,
  label_path text,
  file_name text check (char_length(file_name) <= 200),
  team_name text check (char_length(team_name) <= 200),
  part text check (char_length(part) <= 200),
  setup_snapshot jsonb check (public.jsonb_keys(setup_snapshot) <= 200),
  iteration_count integer,
  refine_level integer,
  inlet_velocity real,
  debug_mesh boolean not null default false,
  mesh_cells_m real,
  fineness real,
  -- The price, written by private.charge_job and nothing else.
  cost integer,
  charged_at timestamptz,
  cancelled_by uuid,
  -- The status the job held when cancellation was asked for. The refund
  -- tier is decided from this, at that moment.
  status_at_cancel public.job_status,
  error text,
  -- SimScale's ids for this run. mesh_id / simscale_run_id existing is the
  -- line between "no compute spent" and "solver time spent".
  simscale jsonb not null default '{}',
  mesh_id text,
  simscale_run_id text,
  simulation_id text,
  results_glb_path text,
  results_fields jsonb,
  case_path text,
  drag_n double precision,
  lift_n double precision,
  -- The poller.
  next_poll_at timestamptz,
  lease_until timestamptz,
  poll_count integer not null default 0,
  ready_polls integer not null default 0,
  results_attempts integer not null default 0,
  extra jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_user on public.jobs (user_id);
create index jobs_run on public.jobs (run_ref);
create index jobs_due on public.jobs (next_poll_at)
  where status not in ('draft', 'complete', 'failed', 'cancelled');
create trigger jobs_touch before update on public.jobs
  for each row execute function private.touch_updated_at();

-- ── server-only ────────────────────────────────────────────────────────────
-- Public prices (config/pricing), readable before sign-in.
create table public.config (
  id text primary key,
  data jsonb not null default '{}'
);

-- Fusion connection tokens. The secret side is keyed by hash and readable by
-- nobody; the listing carries no secret, so the owner can see what to revoke.
create table public.fusion_tokens (
  hash text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  token_id text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index fusion_tokens_owner on public.fusion_tokens (user_id, token_id);

create table public.fusion_token_listing (
  id text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  label text,
  tail text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table public.paypal_orders (
  id text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('credits', 'unlimited')),
  credits integer,
  days integer,
  months integer,
  amount_usd numeric not null,
  currency text not null,
  status text not null default 'created',
  created_at timestamptz not null default now(),
  expire_at timestamptz
);

create table public.rate_counters (
  key text primary key,
  count integer not null default 0,
  expire_at timestamptz not null
);
