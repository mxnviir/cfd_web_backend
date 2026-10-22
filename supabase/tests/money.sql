-- The money and ownership suite.
--
-- Replaces tests/test_security.mjs, which exercised firestore.rules through
-- the emulator. The same assertions, against Postgres: charging happens once,
-- refunds follow the tiers, no client can write a price, a balance or a
-- ledger row, every table refuses cross-user access, PayPal orders and
-- connection-token secrets are invisible.
--
-- One transaction, rolled back at the end, so it leaves nothing behind and
-- can run against any environment that has the migrations. Run it with
-- `node supabase/tests/run.mjs` (needs SUPABASE_DB_URL), or paste it into
-- the SQL editor. The last line it prints is the pass count; the first
-- failure aborts with "FAIL <name>".

begin;

create temp table results (name text);

-- Run `q` as user `u` through the client role, and say what happened:
-- 'ok:<rows>' or the SQLSTATE it failed with.
create function pg_temp.as_user(u uuid, q text) returns text language plpgsql as $$
declare n bigint; r text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q;
    get diagnostics n = row_count;
    r := 'ok:' || n;
  exception when others then
    r := sqlstate;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create function pg_temp.as_anon(q text) returns text language plpgsql as $$
declare n bigint; r text;
begin
  execute 'set local role anon';
  begin execute q; get diagnostics n = row_count; r := 'ok:' || n;
  exception when others then r := sqlstate; end;
  execute 'reset role';
  return r;
end $$;

create function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL %: got %, want %', label, got, want using errcode = 'TF001';
  end if;
  insert into results values (label);
end $$;

-- A refused write: no privilege (42501), a policy check (42501), or a
-- constraint (23514). Anything that went through is a failure.
create function pg_temp.refused(label text, got text) returns void language plpgsql as $$
begin
  if got like 'ok:%' and got <> 'ok:0' then
    raise exception 'FAIL %: the write went through (%)', label, got using errcode = 'TF001';
  end if;
  insert into results values (label);
end $$;

-- ── fixtures ────────────────────────────────────────────────────────────────
-- A owns things, B is a stranger, C is a collaborator.
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'a@test.local'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'b@test.local'),
  ('cccccccc-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'c@test.local');
select private.ensure_account('aaaaaaaa-0000-4000-8000-000000000001', 'a@test.local', 'A', 'uidA');
select private.ensure_account('bbbbbbbb-0000-4000-8000-000000000002', 'b@test.local', 'B', 'uidB');
select private.ensure_account('cccccccc-0000-4000-8000-000000000003', 'c@test.local', 'C', 'uidC');

insert into public.groups (id, user_id, name, shared_with) values
  ('gView', 'aaaaaaaa-0000-4000-8000-000000000001', 'shared for viewing',
   '{"cccccccc-0000-4000-8000-000000000003": "view"}'),
  ('gEdit', 'aaaaaaaa-0000-4000-8000-000000000001', 'shared for editing',
   '{"cccccccc-0000-4000-8000-000000000003": "edit"}'),
  ('gPriv', 'aaaaaaaa-0000-4000-8000-000000000001', 'private', '{}');
insert into public.geometries (id, user_id, group_id, name, status, step_path) values
  ('geoA', 'aaaaaaaa-0000-4000-8000-000000000001', 'gView', 'car', 'ready',
   'users/uidA/geometries/geoA/raw.step');
insert into public.simulations (id, user_id, group_id, geometry_id, name, spec) values
  ('simView', 'aaaaaaaa-0000-4000-8000-000000000001', 'gView', 'geoA', 'sim', '{}'),
  ('simEdit', 'aaaaaaaa-0000-4000-8000-000000000001', 'gEdit', null, 'sim', '{}'),
  ('simPriv', 'aaaaaaaa-0000-4000-8000-000000000001', 'gPriv', null, 'sim', '{}');
update public.users set credits = 100000 where id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- A job and run at a given status, charged the server's price.
create function pg_temp.charged_job(jid text, st public.job_status, lvl int default 3, iters int default 1000)
returns integer language plpgsql as $$
declare amount int;
begin
  insert into public.runs (id, user_id, group_id, job_id, name, status)
  values ('run_' || jid, 'aaaaaaaa-0000-4000-8000-000000000001', 'gEdit', jid, 'Run', 'queued');
  insert into public.jobs (id, user_id, run_ref, status, refine_level, iteration_count)
  values (jid, 'aaaaaaaa-0000-4000-8000-000000000001', 'run_' || jid, 'pending', lvl, iters);
  amount := private.charge_job(jid);
  update public.jobs set status = st where id = jid;
  return amount;
end $$;

create function pg_temp.credits(u uuid) returns integer language sql as $$
  select credits from public.users where id = u
$$;

-- ── accounts ───────────────────────────────────────────────────────────────
select pg_temp.eq('ensureAccount on an existing account changes nothing',
  private.ensure_account('aaaaaaaa-0000-4000-8000-000000000001', 'x', 'x', 'x'), false);
select pg_temp.eq('...and leaves the balance alone',
  pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001'), 100000);
select pg_temp.eq('the signup bonus is one ledger row',
  (select count(*)::int from public.transactions
    where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' and type = 'signup_bonus'), 1);
select pg_temp.refused('a client cannot create its own account row',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.users (id, storage_uid, credits) values ('bbbbbbbb-0000-4000-8000-000000000002', 'x', 1e6)$q$));
select pg_temp.refused('a client cannot change its own credit balance',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set credits = 1000000 where id = auth.uid()$q$));
select pg_temp.refused('a client cannot give itself a sponsor rate',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set sponsored = true, sponsor_rate = 0.01 where id = auth.uid()$q$));
select pg_temp.refused('a client cannot give itself an unlimited pass',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set unlimited_until = now() + interval '1 year' where id = auth.uid()$q$));
select pg_temp.refused('a client cannot set its own per-credit price',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set usd_per_credit = 0.0001 where id = auth.uid()$q$));
select pg_temp.refused('a client cannot raise its own storage quota',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set storage_quota_bytes = 1e15, storage_bytes = 0 where id = auth.uid()$q$));
select pg_temp.refused('a client cannot move its storage folder',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set storage_uid = 'uidA' where id = auth.uid()$q$));
select pg_temp.eq('a normal profile name is accepted',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set name = 'Team B', team_name = 'B Racing' where id = auth.uid()$q$), 'ok:1');
select pg_temp.refused('an oversized profile name is refused',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    format('update public.users set name = %L where id = auth.uid()', repeat('x', 201))));
select pg_temp.eq('another account''s row is not visible',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$select 1 from public.users where id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$), 'ok:0');
select pg_temp.eq('another account''s profile cannot be written',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.users set name = 'pwned' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$), 'ok:0');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
  $q$update public.users set last_seen = '2000-01-01' where id = auth.uid()$q$);
select pg_temp.eq('last_seen is stamped by the server, not taken from the client',
  (select last_seen > now() - interval '1 minute' from public.users
    where id = 'bbbbbbbb-0000-4000-8000-000000000002'), true);

-- ── the ledger ─────────────────────────────────────────────────────────────
select pg_temp.refused('a client cannot write its own ledger row',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.transactions (user_id, id, type, amount) values (auth.uid(), 'x', 'purchase', 1000)$q$));
select pg_temp.refused('a client cannot edit a ledger row',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.transactions set amount = 999999 where user_id = auth.uid()$q$));
select pg_temp.eq('a client reads its own ledger',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$select 1 from public.transactions where user_id = auth.uid()$q$), 'ok:1');
select pg_temp.eq('...and nobody else''s',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$select 1 from public.transactions where user_id <> auth.uid()$q$), 'ok:0');

-- ── the money functions are not reachable from a client ────────────────────
select pg_temp.refused('a client cannot call charge_job',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select private.charge_job('x')$q$));
select pg_temp.refused('a client cannot call refund_job',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$select private.refund_job('x', 'bbbbbbbb-0000-4000-8000-000000000002')$q$));
select pg_temp.refused('a client cannot call apply_purchase',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select private.apply_purchase('x', null)$q$));
select pg_temp.refused('a client cannot call ensure_account',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$select private.ensure_account(auth.uid(), 'x', 'x', 'y')$q$));
select pg_temp.refused('anon cannot call charge_job',
  pg_temp.as_anon($q$select private.charge_job('x')$q$));
select pg_temp.eq('no money function is executable by a client role',
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))
      and has_schema_privilege('authenticated', n.oid, 'usage')), 0);

-- ── jobs ───────────────────────────────────────────────────────────────────
select pg_temp.refused('a client cannot create a job (every job goes through the router)',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.jobs (user_id, status) values (auth.uid(), 'pending')$q$));
select pg_temp.refused('a job carrying its own cost is refused',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.jobs (user_id, status, cost) values (auth.uid(), 'pending', 1)$q$));
select pg_temp.refused('a job cannot be created for another user',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.jobs (user_id, status) values ('aaaaaaaa-0000-4000-8000-000000000001', 'draft')$q$));
select pg_temp.charged_job('jobRead', 'running');
select pg_temp.refused('a client cannot move a job''s status itself',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.jobs set status = 'pending' where id = 'jobRead'$q$));
select pg_temp.refused('a client cannot write a job''s cost',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.jobs set cost = 0 where id = 'jobRead'$q$));
select pg_temp.eq('a stranger cannot read a job',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$select 1 from public.jobs where id = 'jobRead'$q$), 'ok:0');
select pg_temp.eq('the owner can read their job',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$select 1 from public.jobs where id = 'jobRead'$q$), 'ok:1');
do $$ begin
  insert into public.jobs (user_id, file_name) values ('aaaaaaaa-0000-4000-8000-000000000001', repeat('x', 201));
  raise exception 'FAIL an oversized job file name was stored' using errcode = 'TF001';
exception when check_violation then null; end $$;
insert into results values ('an oversized job file name is refused, even from the server');

-- ── charging ───────────────────────────────────────────────────────────────
select pg_temp.eq('the server price: level 3, 1000 iterations is 150',
  pg_temp.charged_job('jobPrice', 'pending', 3, 1000), 150);
select pg_temp.eq('...taken once', pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001'), 100000 - 150 - 150);
select pg_temp.eq('a second charge of the same job takes nothing', private.charge_job('jobPrice'), 0);
select pg_temp.eq('...a third neither', private.charge_job('jobPrice'), 0);
select pg_temp.eq('...and the balance has not moved',
  pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001'), 100000 - 300);
select pg_temp.eq('...and there is one charge row',
  (select count(*)::int from public.transactions where job_id = 'jobPrice' and type = 'simulation_charge'), 1);
select pg_temp.eq('the job records the price it was charged',
  (select cost from public.jobs where id = 'jobPrice'), 150);
select pg_temp.eq('level 1, 1000 iterations is 100', private.list_price(1, 1000, false), 100);
select pg_temp.eq('level 5, 3000 iterations is 600', private.list_price(5, 3000, false), 600);
select pg_temp.eq('a debug mesh, 1000 iterations is 1', private.list_price(3, 1000, true), 1);
select pg_temp.eq('a tiny run still costs at least 1', private.list_price(1, 1, false), 1);

insert into public.jobs (id, user_id, status, refine_level, iteration_count)
values ('jobClamp', 'aaaaaaaa-0000-4000-8000-000000000001', 'pending', 99, 200000);
select pg_temp.eq('parameters are clamped before pricing (level 5, 3000 its)', private.charge_job('jobClamp'), 600);

update public.users set credits = 10 where id = 'bbbbbbbb-0000-4000-8000-000000000002';
insert into public.jobs (id, user_id, status, refine_level, iteration_count)
values ('jobPoor', 'bbbbbbbb-0000-4000-8000-000000000002', 'pending', 3, 1000);
do $$ begin
  perform private.charge_job('jobPoor');
  raise exception 'FAIL a short balance is charged anyway' using errcode = 'TF001';
exception when sqlstate 'P0001' then
  if sqlerrm not like 'Not enough credits%' then raise; end if;
end $$;
select pg_temp.eq('a short balance is refused and not touched',
  pg_temp.credits('bbbbbbbb-0000-4000-8000-000000000002'), 10);
select pg_temp.eq('...with no ledger row',
  (select count(*)::int from public.transactions where job_id = 'jobPoor'), 0);

update public.users set sponsored = true, sponsor_rate = 0.5 where id = 'cccccccc-0000-4000-8000-000000000003';
update public.users set credits = 1000 where id = 'cccccccc-0000-4000-8000-000000000003';
insert into public.jobs (id, user_id, status, refine_level, iteration_count)
values ('jobSponsor', 'cccccccc-0000-4000-8000-000000000003', 'pending', 3, 1000);
select pg_temp.eq('a sponsored team pays its rate', private.charge_job('jobSponsor'), 75);
update public.users set sponsored = false, unlimited_until = now() + interval '1 day'
 where id = 'cccccccc-0000-4000-8000-000000000003';
insert into public.jobs (id, user_id, status, refine_level, iteration_count)
values ('jobUnlimited', 'cccccccc-0000-4000-8000-000000000003', 'pending', 5, 3000);
select pg_temp.eq('an unlimited pass pays nothing', private.charge_job('jobUnlimited'), 0);
select pg_temp.eq('...and writes no charge row',
  (select count(*)::int from public.transactions where job_id = 'jobUnlimited'), 0);
select pg_temp.eq('...and is not charged later either', private.charge_job('jobUnlimited'), 0);
update public.users set unlimited_until = null where id = 'cccccccc-0000-4000-8000-000000000003';
select pg_temp.eq('...even once the pass has lapsed', private.charge_job('jobUnlimited'), 0);

-- ── refunds: a forged or foreign job ───────────────────────────────────────
insert into public.jobs (id, user_id, status, cost)
values ('jobForged', 'aaaaaaaa-0000-4000-8000-000000000001', 'pending', 1000000000);
select pg_temp.eq('a forged job refunds ZERO, not its stated cost',
  (private.refund_job('jobForged', 'aaaaaaaa-0000-4000-8000-000000000001') ->> 'refunded')::int, 0);
select pg_temp.eq('...and the balance has not moved',
  pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001'), 100000 - 300 - 600);
select pg_temp.charged_job('jobTheirs', 'pending');
do $$ begin
  perform private.refund_job('jobTheirs', 'bbbbbbbb-0000-4000-8000-000000000002');
  raise exception 'FAIL someone else''s job was refunded' using errcode = 'TF001';
exception when sqlstate '42501' then null;
end $$;
insert into results values ('someone else''s job cannot be refunded');

-- ── refunds: the tiers ─────────────────────────────────────────────────────
-- Every status, both entry points. Before the mesher: everything back. From
-- meshing on: refundJob refuses, cancelRun stops the run and keeps the charge.
do $$
declare
  s public.job_status;
  before int;
  got jsonb;
  refundable boolean;
begin
  foreach s in array enum_range(null::public.job_status) loop
    refundable := s in ('draft', 'pending', 'downloading', 'uploading_geometry',
                        'processing', 'creating_simulation', 'checking');

    -- refundJob
    perform pg_temp.charged_job('rj_' || s, s);
    before := pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001');
    begin
      got := private.refund_job('rj_' || s, 'aaaaaaaa-0000-4000-8000-000000000001');
      if not refundable then raise exception 'FAIL refundJob at % was allowed', s using errcode = 'TF001'; end if;
      if (got ->> 'refunded')::int <> 150 then raise exception 'FAIL refundJob at % refunded %', s, got using errcode = 'TF001'; end if;
      if pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001') <> before + 150 then
        raise exception 'FAIL refundJob at % did not move the balance', s using errcode = 'TF001';
      end if;
      if (got ->> 'status') <> (case when s in ('draft', 'pending') then 'cancelled' else 'cancelling' end) then
        raise exception 'FAIL refundJob at % left status %', s, got ->> 'status' using errcode = 'TF001';
      end if;
      -- Twice: the second asks at cancelling or cancelled, which is refused.
      begin
        perform private.refund_job('rj_' || s, 'aaaaaaaa-0000-4000-8000-000000000001');
        raise exception 'FAIL refundJob at % paid twice', s using errcode = 'TF001';
      exception when sqlstate 'P0001' then null; end;
    exception when sqlstate 'P0001' then
      if refundable then raise exception 'FAIL refundJob at % was refused: %', s, sqlerrm using errcode = 'TF001'; end if;
      if pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001') <> before then
        raise exception 'FAIL refusing refundJob at % moved the balance', s using errcode = 'TF001';
      end if;
    end;

    -- cancelRun
    perform pg_temp.charged_job('cr_' || s, s);
    before := pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001');
    begin
      got := private.cancel_run('run_cr_' || s, 'aaaaaaaa-0000-4000-8000-000000000001');
      if s in ('complete', 'failed', 'cancelled', 'cancelling') then
        raise exception 'FAIL cancelRun at % was allowed', s using errcode = 'TF001';
      end if;
      if (got ->> 'refunded')::int <> (case when refundable then 150 else 0 end) then
        raise exception 'FAIL cancelRun at % refunded %', s, got using errcode = 'TF001';
      end if;
      if pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001')
         <> before + (case when refundable then 150 else 0 end) then
        raise exception 'FAIL cancelRun at % moved the balance wrongly', s using errcode = 'TF001';
      end if;
      if (select status_at_cancel from public.jobs where id = 'cr_' || s) <> s then
        raise exception 'FAIL cancelRun at % did not record the status it was cancelled at', s using errcode = 'TF001';
      end if;
    exception when sqlstate 'P0001' then
      if s not in ('complete', 'failed', 'cancelled', 'cancelling') then
        raise exception 'FAIL cancelRun at % was refused: %', s, sqlerrm using errcode = 'TF001';
      end if;
      if pg_temp.credits('aaaaaaaa-0000-4000-8000-000000000001') <> before then
        raise exception 'FAIL refusing cancelRun at % moved the balance', s using errcode = 'TF001';
      end if;
    end;
  end loop;
end $$;
insert into results values ('refund tiers: refundJob at every status'),
                           ('refund tiers: cancelRun at every status');

select pg_temp.eq('a refunded job has charge and refund rows that cancel out',
  (select sum(amount)::int from public.transactions where job_id = 'rj_checking'), 0);
select pg_temp.eq('a run cancelled while meshing keeps its charge',
  (select sum(amount)::int from public.transactions where job_id = 'cr_meshing'), -150);

-- Who may cancel.
select pg_temp.charged_job('jobWho', 'running');
do $$ begin
  perform private.cancel_run('run_jobWho', 'bbbbbbbb-0000-4000-8000-000000000002');
  raise exception 'FAIL a stranger cancelled a run' using errcode = 'TF001';
exception when sqlstate '42501' then null; end $$;
insert into results values ('someone else''s run cannot be cancelled');
update public.runs set group_id = 'gView' where id = 'run_jobWho';
do $$ begin
  perform private.cancel_run('run_jobWho', 'cccccccc-0000-4000-8000-000000000003');
  raise exception 'FAIL a view-only collaborator cancelled a run' using errcode = 'TF001';
exception when sqlstate '42501' then null; end $$;
insert into results values ('a view-only collaborator cannot cancel');
update public.runs set group_id = 'gEdit' where id = 'run_jobWho';
select pg_temp.eq('a collaborator with edit can cancel',
  private.cancel_run('run_jobWho', 'cccccccc-0000-4000-8000-000000000003') ->> 'status', 'cancelling');
select pg_temp.eq('...and the cancel did not refund past the mesher',
  (select coalesce(sum(amount), 0)::int from public.transactions where job_id = 'jobWho'), -150);
select private.finish_cancel('jobWho');
select pg_temp.eq('the poller finishing a cancel moves no money',
  (select coalesce(sum(amount), 0)::int from public.transactions where job_id = 'jobWho'), -150);
select pg_temp.eq('...and ends the run cancelled',
  (select status from public.runs where id = 'run_jobWho'), 'cancelled');

-- ── failures ───────────────────────────────────────────────────────────────
select pg_temp.charged_job('jobFailEarly', 'processing');
select pg_temp.eq('a run that fails before solving gives the credits back',
  private.fail_job('jobFailEarly', 'SimScale could not read the geometry'), 150);
select pg_temp.eq('...as a reversal row',
  (select type from public.transactions where job_id = 'jobFailEarly' and amount > 0), 'simulation_charge_reversal');
select pg_temp.eq('...once', private.fail_job('jobFailEarly', 'again'), 0);
select pg_temp.eq('...and says so on the run',
  (select refunded from public.runs where id = 'run_jobFailEarly'), 150);
select pg_temp.charged_job('jobFailLate', 'running');
update public.jobs set mesh_id = 'mesh-1' where id = 'jobFailLate';
select pg_temp.eq('a run that fails after meshing keeps the charge',
  private.fail_job('jobFailLate', 'diverged'), 0);
select pg_temp.eq('...and is failed', (select status::text from public.jobs where id = 'jobFailLate'), 'failed');
select pg_temp.charged_job('jobCancelThenFail', 'checking');
select private.cancel_run('run_jobCancelThenFail', 'aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.eq('a cancelled run that then fails is not refunded twice',
  private.fail_job('jobCancelThenFail', 'x'), 0);

-- ── purchases ──────────────────────────────────────────────────────────────
insert into public.paypal_orders (id, user_id, kind, credits, amount_usd, currency)
values ('ORDER1', 'bbbbbbbb-0000-4000-8000-000000000002', 'credits', 500, 25, 'USD');
select pg_temp.eq('a captured order grants its credits',
  (private.apply_purchase('ORDER1', 'CAP1') ->> 'applied')::boolean, true);
select pg_temp.eq('...into the balance', pg_temp.credits('bbbbbbbb-0000-4000-8000-000000000002'), 510);
select pg_temp.eq('...once: capture and webhook cannot both grant',
  (private.apply_purchase('ORDER1', 'CAP1') ->> 'applied')::boolean, false);
select pg_temp.eq('...and the balance stays', pg_temp.credits('bbbbbbbb-0000-4000-8000-000000000002'), 510);
insert into public.paypal_orders (id, user_id, kind, days, amount_usd, currency)
values ('ORDER2', 'bbbbbbbb-0000-4000-8000-000000000002', 'unlimited', 30, 100, 'USD');
select private.apply_purchase('ORDER2', null);
select pg_temp.eq('an unlimited pass runs 30 days',
  (select unlimited_until::date - now()::date from public.users where id = 'bbbbbbbb-0000-4000-8000-000000000002'), 30);
insert into public.paypal_orders (id, user_id, kind, days, amount_usd, currency)
values ('ORDER3', 'bbbbbbbb-0000-4000-8000-000000000002', 'unlimited', 30, 100, 'USD');
select private.apply_purchase('ORDER3', null);
select pg_temp.eq('a second pass stacks on the time left',
  (select unlimited_until::date - now()::date from public.users where id = 'bbbbbbbb-0000-4000-8000-000000000002'), 60);

-- ── server-only tables ─────────────────────────────────────────────────────
select pg_temp.refused('paypal_orders are invisible to their own buyer',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select * from public.paypal_orders$q$));
select pg_temp.refused('a client cannot open its own PayPal order',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.paypal_orders (id, user_id, kind, credits, amount_usd, currency) values ('O', auth.uid(), 'credits', 1e6, 0.01, 'USD')$q$));
select pg_temp.refused('rate counters are invisible',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select * from public.rate_counters$q$));
select pg_temp.refused('a client cannot reset its rate counter',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$delete from public.rate_counters$q$));
select pg_temp.refused('anon cannot read anything private',
  pg_temp.as_anon($q$select * from public.users$q$));
select pg_temp.eq('anon can read the public prices',
  pg_temp.as_anon($q$select * from public.config$q$), 'ok:0');

-- ── Fusion connection tokens ───────────────────────────────────────────────
insert into public.fusion_tokens (hash, user_id, token_id) values
  ('hashOfTokenA', 'aaaaaaaa-0000-4000-8000-000000000001', 'tokA');
insert into public.fusion_token_listing (id, user_id, label, tail) values
  ('tokA', 'aaaaaaaa-0000-4000-8000-000000000001', 'Fusion 360', 'abc123');
select pg_temp.refused('the token hashes are invisible, even to their owner',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', $q$select * from public.fusion_tokens$q$));
select pg_temp.eq('the owner sees the listing',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', $q$select * from public.fusion_token_listing$q$), 'ok:1');
select pg_temp.eq('...and nobody else does',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select * from public.fusion_token_listing$q$), 'ok:0');
select pg_temp.refused('a client cannot write its own token listing',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.fusion_token_listing (id, user_id) values ('x', auth.uid())$q$));
select pg_temp.refused('a client cannot mint a token hash',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.fusion_tokens (hash, user_id, token_id) values ('h', auth.uid(), 't')$q$));

-- ── groups ─────────────────────────────────────────────────────────────────
select pg_temp.eq('a client can create its own group',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.groups (id, user_id, name) values ('gB', auth.uid(), 'mine')$q$), 'ok:1');
select pg_temp.refused('a group cannot be created for someone else',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.groups (user_id, name) values ('aaaaaaaa-0000-4000-8000-000000000001', 'x')$q$));
select pg_temp.refused('a new group cannot come pre-shared',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.groups (user_id, name, shared_with) values (auth.uid(), 'x', '{"aaaaaaaa-0000-4000-8000-000000000001":"edit"}')$q$));
select pg_temp.refused('a group name over 200 characters is refused',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    format('insert into public.groups (user_id, name) values (auth.uid(), %L)', repeat('x', 201))));
select pg_temp.eq('a stranger cannot read a group that is not shared',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select 1 from public.groups where id = 'gView'$q$), 'ok:0');
select pg_temp.eq('a collaborator with view can read the group',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$select 1 from public.groups where id = 'gView'$q$), 'ok:1');
select pg_temp.eq('...but not one they were not given',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$select 1 from public.groups where id = 'gPriv'$q$), 'ok:0');
select pg_temp.eq('a collaborator with view cannot write the group',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$update public.groups set name = 'x' where id = 'gView'$q$), 'ok:0');
select pg_temp.refused('a collaborator cannot promote themselves to edit',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003',
    $q$update public.groups set shared_with = '{"cccccccc-0000-4000-8000-000000000003":"edit"}' where id = 'gView'$q$));
select pg_temp.refused('the owner cannot rewrite shared_with directly either',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.groups set shared_with = '{}' where id = 'gView'$q$));
select pg_temp.refused('nor the counts',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.groups set counts = '{"runs": 0}' where id = 'gView'$q$));
select pg_temp.refused('nor hand the group to someone else',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.groups set user_id = 'bbbbbbbb-0000-4000-8000-000000000002' where id = 'gView'$q$));
select pg_temp.eq('the owner renames their group',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', $q$update public.groups set name = 'renamed' where id = 'gPriv'$q$), 'ok:1');
select pg_temp.eq('someone else''s group cannot be deleted',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$delete from public.groups where id = 'gEdit'$q$), 'ok:0');

-- ── geometries ─────────────────────────────────────────────────────────────
select pg_temp.eq('a collaborator can list the shared group''s geometries',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$select 1 from public.geometries where group_id = 'gView'$q$), 'ok:1');
select pg_temp.eq('a stranger cannot list another team''s geometries',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select 1 from public.geometries$q$), 'ok:0');
select pg_temp.refused('a stranger cannot file a geometry into a group they are not in',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.geometries (user_id, group_id, name) values (auth.uid(), 'gPriv', 'x')$q$));
select pg_temp.eq('a geometry with no group is still allowed',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.geometries (id, user_id, name) values ('geoB', auth.uid(), 'x')$q$), 'ok:1');
select pg_temp.refused('a geometry cannot point at another user''s files',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.geometries (user_id, name, step_path) values (auth.uid(), 'x', 'users/uidA/geometries/geoA/raw.step')$q$));
select pg_temp.refused('a client cannot create a geometry already marked ready',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.geometries (user_id, name, status) values (auth.uid(), 'x', 'ready')$q$));
select pg_temp.refused('a client cannot mark a geometry ready',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.geometries set status = 'ready' where id = 'geoB'$q$));
select pg_temp.refused('a client cannot write a geometry''s versions',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$update public.geometries set versions = '{"1":{"step_path":"users/uidA/geometries/geoA/raw.step"}}', current_version = 1 where id = 'geoB'$q$));
select pg_temp.refused('a client cannot write a version row',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.geometry_versions (geometry_id, version, user_id, data) values ('geoB', 1, auth.uid(), '{}')$q$));
select pg_temp.eq('the owner renames their geometry',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$update public.geometries set name = 'car' where id = 'geoB'$q$), 'ok:1');

insert into public.geometry_versions (geometry_id, version, user_id, data)
values ('geoA', 1, 'aaaaaaaa-0000-4000-8000-000000000001', '{"kind": "raw", "glb_path": "g"}');
select pg_temp.eq('a version row folds into geometries.versions',
  (select versions -> '1' ->> 'kind' from public.geometries where id = 'geoA'), 'raw');
select pg_temp.eq('a collaborator sees the version',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$select 1 from public.geometry_versions where geometry_id = 'geoA'$q$), 'ok:1');
select pg_temp.eq('a stranger does not',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select 1 from public.geometry_versions where geometry_id = 'geoA'$q$), 'ok:0');

-- Artifact intents: the page may move the state, nothing else.
insert into public.artifact_intents (token, geometry_id, user_id, group_id, version, paths)
values ('tok12345678', 'geoA', 'aaaaaaaa-0000-4000-8000-000000000001', 'gView', 2, '{"step": "users/uidA/geometries/geoA/incoming/tok12345678/geometry.step"}');
select pg_temp.refused('a client cannot reserve its own upload paths',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.artifact_intents (token, geometry_id, user_id, version, paths) values ('t2345678', 'geoA', auth.uid(), 9, '{}')$q$));
select pg_temp.refused('a client cannot rewrite the reserved paths',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.artifact_intents set paths = '{"step": "users/uidB/x"}' where token = 'tok12345678'$q$));
select pg_temp.refused('a client cannot mark its own build ingested',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.artifact_intents set state = 'ingested' where token = 'tok12345678'$q$));
select pg_temp.eq('a view-only collaborator cannot move the state',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003',
    $q$update public.artifact_intents set state = 'consumed' where token = 'tok12345678'$q$), 'ok:0');
select pg_temp.eq('the owner marks the upload consumed',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.artifact_intents set state = 'consumed' where token = 'tok12345678'$q$), 'ok:1');

-- Selections and post-processing states belong to the owner alone.
select pg_temp.refused('a stranger cannot save a selection on someone else''s geometry',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.selections (geometry_id, user_id, name) values ('geoA', auth.uid(), 'x')$q$));
select pg_temp.eq('the owner saves a selection',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.selections (geometry_id, user_id, name, step_ids) values ('geoA', auth.uid(), 'wing', '[1,2,3]')$q$), 'ok:1');
select pg_temp.refused('a selection over 5000 faces is refused',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    format('insert into public.selections (geometry_id, user_id, name, step_ids) values (%L, auth.uid(), %L, %L)',
           'geoA', 'big', (select jsonb_agg(i) from generate_series(1, 5001) i))));

-- ── simulations ────────────────────────────────────────────────────────────
select pg_temp.eq('a collaborator with view can read the group''s simulations',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$select 1 from public.simulations where group_id = 'gView'$q$), 'ok:1');
select pg_temp.eq('a stranger cannot read a simulation in a group they were not given',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select 1 from public.simulations$q$), 'ok:0');
select pg_temp.eq('a collaborator with view cannot edit a setup',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003',
    $q$update public.simulations set spec = '{"x":1}' where id = 'simView'$q$), 'ok:0');
select pg_temp.eq('a collaborator with edit can',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003',
    $q$update public.simulations set spec = '{"x":1}' where id = 'simEdit'$q$), 'ok:1');
select pg_temp.refused('a client cannot mark its own simulation valid',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.simulations set validation = '{"ok": true}' where id = 'simPriv'$q$));
select pg_temp.refused('nor create one already valid',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.simulations (user_id, group_id, validation) values (auth.uid(), 'gPriv', '{"ok": true}')$q$));
select pg_temp.refused('nor create one in a group they are not in',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.simulations (user_id, group_id, name) values (auth.uid(), 'gPriv', 'x')$q$));
select pg_temp.refused('nor point one at a geometry they cannot see',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002',
    $q$insert into public.simulations (user_id, geometry_id, name) values (auth.uid(), 'geoA', 'x')$q$));
select pg_temp.refused('an oversized simulation name is refused',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    format('update public.simulations set name = %L where id = %L', repeat('x', 201), 'simPriv')));
select pg_temp.refused('a simulation cannot change hands',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003',
    $q$update public.simulations set user_id = auth.uid() where id = 'simEdit'$q$));

-- ── runs ───────────────────────────────────────────────────────────────────
select pg_temp.refused('a client cannot write a run document',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.runs (user_id, status) values (auth.uid(), 'finished')$q$));
select pg_temp.refused('a client cannot claim a result it never paid for',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$update public.runs set status = 'finished', summary = '{"drag": 0.1}' where id = 'run_jobRead'$q$));
select pg_temp.eq('a collaborator can list the shared group''s runs',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003', $q$select 1 from public.runs where group_id = 'gEdit'$q$),
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', $q$select 1 from public.runs where group_id = 'gEdit'$q$));
select pg_temp.eq('a stranger cannot',
  pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002', $q$select 1 from public.runs$q$), 'ok:0');
select pg_temp.eq('the owner keeps a post-processing state',
  pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001',
    $q$insert into public.post_states (run_id, user_id, state) values ('run_jobRead', auth.uid(), '{"field":"p"}')$q$), 'ok:1');
select pg_temp.refused('a collaborator cannot write one on the owner''s run',
  pg_temp.as_user('cccccccc-0000-4000-8000-000000000003',
    $q$insert into public.post_states (run_id, user_id, state) values ('run_jobRead', auth.uid(), '{}')$q$));

-- ── storage paths ──────────────────────────────────────────────────────────
-- The upload policy, asked directly: only paths the server reserved.
update public.geometries set raw_path = 'users/uidA/geometries/geoA/raw.step' where id = 'geoA';
create function pg_temp.may(u uuid, op text, p text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute format('select rls.%I(%L)', op, p) into r;
  execute 'reset role';
  return r;
end $$;
select pg_temp.eq('the owner uploads the raw file createUploadIntent reserved',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/raw.step'), true);
select pg_temp.eq('...but not a raw file nobody reserved',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoX/raw.step'), false);
select pg_temp.eq('...nor into someone else''s folder',
  pg_temp.may('bbbbbbbb-0000-4000-8000-000000000002', 'may_upload', 'users/uidA/geometries/geoA/raw.step'), false);
select pg_temp.eq('...nor into a version folder',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/v1/faces.json'), false);
select pg_temp.eq('the staging folder of an open intent is writable',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/incoming/tok12345678/faces.json'), true);
select pg_temp.eq('...a made-up token is not',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/incoming/madeup1234/faces.json'), false);
select pg_temp.eq('...nor a file that does not belong in staging',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/incoming/tok12345678/evil.exe'), false);
update public.artifact_intents set state = 'failed' where token = 'tok12345678';
select pg_temp.eq('...nor a closed intent''s staging',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/incoming/tok12345678/faces.json'), false);
select pg_temp.eq('results are not writable while the run is going',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/results/jobRead/results.glb'), false);
update public.jobs set status = 'complete', case_path = 'users/uidA/results/jobRead/case.zip' where id = 'jobRead';
select pg_temp.eq('the owner uploads the viewer files of a finished run',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/results/jobRead/fields/p.bin'), true);
select pg_temp.eq('...a collaborator does not',
  pg_temp.may('cccccccc-0000-4000-8000-000000000003', 'may_upload', 'users/uidC/results/jobRead/results.glb'), false);
update public.jobs set results_glb_path = 'users/uidA/results/jobRead/results.glb' where id = 'jobRead';
select pg_temp.eq('...and only once',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/results/jobRead/results.glb'), false);
select pg_temp.eq('the owner reads their results',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_read', 'users/uidA/results/jobRead/case.zip'), true);
select pg_temp.eq('a stranger does not',
  pg_temp.may('bbbbbbbb-0000-4000-8000-000000000002', 'may_read', 'users/uidA/results/jobRead/case.zip'), false);
select pg_temp.eq('a version file cannot be deleted by the client',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_delete', 'users/uidA/geometries/geoA/v1/model.glb'), false);
update public.users set storage_bytes = 6::bigint * 1024 * 1024 * 1024 where id = 'aaaaaaaa-0000-4000-8000-000000000001';
select pg_temp.eq('an account over its quota uploads nothing',
  pg_temp.may('aaaaaaaa-0000-4000-8000-000000000001', 'may_upload', 'users/uidA/geometries/geoA/raw.step'), false);

-- ── rate limits ────────────────────────────────────────────────────────────
select private.rate_hit('test:k', 2, 3600);
select private.rate_hit('test:k', 2, 3600);
select pg_temp.eq('the third call in a window of two is over', private.rate_hit('test:k', 2, 3600), true);

select count(*) || ' passed' as result from results;
rollback;
