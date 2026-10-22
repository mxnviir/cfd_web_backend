-- State for the SimScale mock (supabase/functions/simscale-mock).
--
-- Development environments only. Not a migration: production never has the
-- mock deployed and never has this schema. Apply with
--   node supabase/dev/apply.mjs
create schema if not exists dev_mock;
revoke all on schema dev_mock from public, anon, authenticated, service_role;

-- One row per thing the mock has been asked to create: storage slots,
-- geometry imports, simulations, mesh operations, runs. Progress is worked
-- out from created_at / started_at, so the mock itself holds no state.
create table if not exists dev_mock.objects (
  id text primary key,
  kind text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  cancelled boolean not null default false
);
-- Every request the mock answered, so a test can count them.
create table if not exists dev_mock.calls (
  at timestamptz not null default now(),
  method text not null,
  path text not null
);
