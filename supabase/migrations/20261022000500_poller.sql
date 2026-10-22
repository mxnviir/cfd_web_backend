-- The run pipeline's database half.
--
-- SimScale has no webhooks, so something has to ask it how each run is
-- doing. pg_cron calls the POLL edge function once a minute; POLL claims the
-- jobs that are due, makes one SimScale call per job, and writes back.
--
-- Claiming is the lock. poll_claim takes due rows with FOR UPDATE SKIP
-- LOCKED and stamps a lease on them in the same statement, so two ticks that
-- overlap (a slow tick and the next one, or two invocations of POLL) get
-- disjoint sets of jobs. A crashed tick holds nothing for longer than its
-- lease.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- A secret only the database and the pipeline functions know. Generated
-- here, never written in code. The edge functions read it over their own
-- database connection and compare it to the x-internal-secret header.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'internal_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'internal_secret',
      'Shared by pg_cron and the TurboFlow pipeline functions');
  end if;
end $$;

-- Jobs that are due and not held by another tick.
create or replace function private.poll_claim(p_limit integer, p_lease_s integer)
returns setof public.jobs language sql set search_path = '' as $$
  update public.jobs j
     set lease_until = now() + make_interval(secs => p_lease_s),
         poll_count = j.poll_count + 1
   where j.id in (
     select id from public.jobs
      where status not in ('draft', 'complete', 'failed', 'cancelled')
        and next_poll_at is not null and next_poll_at <= now()
        and (lease_until is null or lease_until < now())
      order by next_poll_at
      limit p_limit
      for update skip locked)
  returning j.*
$$;

-- Hand a job back to the schedule: due again after `p_after_s` seconds, plus
-- up to a fifth of that again as jitter, so jobs queued together spread out.
create or replace function private.poll_release(p_job text, p_after_s integer) returns void
language sql set search_path = '' as $$
  update public.jobs
     set lease_until = null,
         next_poll_at = now() + make_interval(secs => p_after_s * (1 + random() * 0.2))
   where id = p_job
$$;

-- SUBMIT's claim: a charged job that nobody has started. Exactly one caller
-- gets the row back.
create or replace function private.submit_claim(p_job text) returns setof public.jobs
language sql set search_path = '' as $$
  update public.jobs
     set status = 'uploading_geometry', lease_until = now() + interval '5 minutes',
         next_poll_at = now() + interval '6 minutes'
   where id = p_job and status = 'pending' and charged_at is not null
     and (lease_until is null or lease_until < now())
  returning *
$$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;

-- The schedule. The functions' base URL is per project, so it is read from
-- the vault at run time (secret `functions_url`, set once per environment;
-- see supabase/README.md). Without it the tick does nothing.
create or replace function private.poll_tick() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  base text := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url');
  secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret');
begin
  if base is null then return null; end if;
  return net.http_post(
    url := base || '/poll',
    headers := jsonb_build_object('content-type', 'application/json', 'x-internal-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
end $$;
revoke all on function private.poll_tick() from public, anon, authenticated, service_role;

select cron.schedule('turboflow-poll', '* * * * *', 'select private.poll_tick()');

-- A client may write a simulation's setup straight to the table (the
-- Workbench's quick edits do). The server's verdict on it is `validation`,
-- which no client can write, so a changed setup is sent back to the ops
-- router to be checked again (functions/src/simulations onSimulationWritten).
-- Writes the router itself makes run as the table owner and are not echoed.
create or replace function private.revalidate_simulation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  base text := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url');
  secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret');
begin
  -- auth.role() is the client's role from its JWT; the router's own
  -- connection carries no JWT, so its writes read as null here.
  if base is null or coalesce(auth.role(), '') not in ('authenticated', 'anon') then return null; end if;
  if tg_op = 'UPDATE' and new.spec is not distinct from old.spec
     and new.mesh_spec is not distinct from old.mesh_spec
     and new.geometry_id is not distinct from old.geometry_id then
    return null;
  end if;
  perform net.http_post(
    url := base || '/ops',
    headers := jsonb_build_object('content-type', 'application/json', 'x-internal-secret', secret),
    body := jsonb_build_object('op', 'revalidateSimulation', 'payload', jsonb_build_object('simulation_id', new.id)),
    timeout_milliseconds := 5000);
  return null;
end $$;
revoke all on function private.revalidate_simulation() from public, anon, authenticated, service_role;

create trigger simulations_revalidate after insert or update on public.simulations
  for each row execute function private.revalidate_simulation();
