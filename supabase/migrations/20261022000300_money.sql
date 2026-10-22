-- The only code that moves credits.
--
-- Ported from functions/src/lib/ledger.ts and the handlers around it. The
-- rule that made the Firestore version safe is kept exactly: a refund is
-- never derived from anything a client wrote. It is the sum of the charge
-- rows this code recorded for that job, minus what was already given back.
-- A job with no charge row refunds zero.
--
-- Every function here lives in `private`, which PostgREST does not expose
-- and on which no client role has USAGE or EXECUTE. The ops router reaches
-- them over a direct database connection; a client session cannot call them.
--
-- Atomicity is SELECT ... FOR UPDATE on the job row and the user row, in
-- that order everywhere, so two callers on one job serialise rather than
-- both reading "not yet charged".

-- Statuses at which no solver or mesher compute has been spent. Cancelling
-- or refunding in one of these gives the whole charge back; from meshing on,
-- the charge stands.
create or replace function private.refundable(s public.job_status) returns boolean
language sql immutable set search_path = '' as $$
  select s in ('draft', 'pending', 'downloading', 'uploading_geometry',
               'processing', 'creating_simulation', 'checking')
$$;

-- What has been charged and given back for one job.
create or replace function private.job_ledger(
  p_user uuid, p_job text,
  out charged integer, out refunded integer, out outstanding integer)
language sql stable set search_path = '' as $$
  select coalesce(sum(abs(amount)) filter (where type = 'simulation_charge'), 0)::int,
         coalesce(sum(abs(amount)) filter (where type in ('refund', 'simulation_charge_reversal')), 0)::int,
         greatest(0, coalesce(sum(abs(amount)) filter (where type = 'simulation_charge'), 0)
                   - coalesce(sum(abs(amount)) filter (where type in ('refund', 'simulation_charge_reversal')), 0))::int
    from public.transactions
   where user_id = p_user and job_id = p_job
$$;

-- Give back whatever is outstanding on a job, as a refund (the user chose to
-- stop) or a reversal (we charged and could not do the work). Returns the
-- amount. The row id is deterministic, so a second call writes nothing and
-- moves nothing.
create or replace function private.give_back(p_user uuid, p_job text, p_type text, p_reason text)
returns integer language plpgsql set search_path = '' as $$
declare
  owed integer := (select outstanding from private.job_ledger(p_user, p_job));
  row_id text := case p_type when 'refund' then 'refund_' else 'reversal_' end || p_job;
begin
  if owed <= 0 then return 0; end if;
  insert into public.transactions (user_id, id, type, amount, reason, job_id)
  values (p_user, row_id, p_type, owed, p_reason, p_job)
  on conflict do nothing;
  if not found then return 0; end if;
  update public.users set credits = credits + owed where id = p_user;
  return owed;
end $$;

-- functions/src/lib/pricing.ts listPrice and chargeFor.
create or replace function private.price_for(
  p_user public.users, p_level integer, p_iterations integer, p_debug boolean)
returns integer language sql stable set search_path = '' as $$
  select case
    when p_user.unlimited_until is not null and p_user.unlimited_until > now() then 0
    else greatest(1, round(
      greatest(1, round((case when p_debug then 1 else 100 + (p_level - 1) * 25 end)
                        * p_iterations / 1000.0))
      * (case when p_user.sponsored and p_user.sponsor_rate > 0 and p_user.sponsor_rate <= 1
              then p_user.sponsor_rate else 1 end)))::int
  end
$$;

-- What the user would be charged for these parameters, for the queue reply.
create or replace function private.list_price(p_level integer, p_iterations integer, p_debug boolean)
returns integer language sql immutable set search_path = '' as $$
  select greatest(1, round((case when p_debug then 1 else 100 + (p_level - 1) * 25 end)
                           * p_iterations / 1000.0))::int
$$;

-- Take the credits for a job, exactly once.
--
-- The parameters are read off the job row, which only the server writes, and
-- clamped again here so the price cannot be talked down by anything upstream.
-- A job that already carries a charge row, or a charged_at, is not charged
-- again. Raises if the balance is short; the caller's transaction then rolls
-- back whatever it wrote alongside.
create or replace function private.charge_job(p_job text) returns integer
language plpgsql set search_path = '' as $$
declare
  j public.jobs;
  u public.users;
  lvl integer;
  iters integer;
  amount integer;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job does not exist.' using errcode = 'P0002'; end if;
  select * into u from public.users where id = j.user_id for update;
  if not found then raise exception 'User account not found.' using errcode = 'P0002'; end if;

  if j.charged_at is not null or (select charged from private.job_ledger(j.user_id, p_job)) > 0 then
    return 0;
  end if;

  lvl := least(5, greatest(1, coalesce(j.refine_level, 3)));
  iters := least(3000, greatest(1, coalesce(j.iteration_count, 1000)));
  amount := private.price_for(u, lvl, iters, j.debug_mesh);

  if u.credits < amount then
    raise exception 'Not enough credits: you have %, this run costs %.', u.credits, amount
      using errcode = 'P0001', hint = 'insufficient_credits';
  end if;

  if amount > 0 then
    insert into public.transactions (user_id, id, type, amount, reason, job_id)
    values (j.user_id, 'charge_' || p_job, 'simulation_charge', -amount,
            format('Simulation (level %s, %s iterations%s)', lvl, iters,
                   case when j.debug_mesh then ', debug' else '' end),
            p_job);
    update public.users set credits = credits - amount where id = j.user_id;
  end if;

  update public.jobs
     set cost = amount, charged_at = now(), refine_level = lvl, iteration_count = iters
   where id = p_job;
  return amount;
end $$;

-- A line on the user's notification list, newest first, capped at 50.
create or replace function private.notify(p_user uuid, p_type text, p_text text, p_run text, p_job text)
returns void language sql set search_path = '' as $$
  update public.users
     set notifications = (
       select coalesce(jsonb_agg(e), '[]'::jsonb) from (
         select e from jsonb_array_elements(
           jsonb_build_array(jsonb_build_object(
             'type', p_type, 'text', p_text, 'run_id', p_run, 'job_id', p_job,
             'at', (extract(epoch from now()) * 1000)::bigint, 'read', false))
           || coalesce(notifications, '[]'::jsonb)) with ordinality t(e, n)
         order by n limit 50) x)
   where id = p_user
$$;

-- ── refundJob ────────────────────────────────────────────────────────────────
-- Cancel a job and give back what was paid for it. Allowed only while no
-- compute has been spent (private.refundable). A job that was never picked
-- up ends here; one the pipeline holds goes to `cancelling`, and the poller
-- winds SimScale down.
create or replace function private.refund_job(p_job text, p_caller uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  j public.jobs;
  amount integer;
  next_status public.job_status;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found then raise exception 'That job does not exist.' using errcode = 'P0002'; end if;
  if j.user_id is distinct from p_caller then
    raise exception 'That job is not yours.' using errcode = '42501';
  end if;
  if not private.refundable(j.status) then
    raise exception 'A job that is % cannot be cancelled for a refund.', j.status using errcode = 'P0001';
  end if;
  perform 1 from public.users where id = j.user_id for update;

  amount := private.give_back(j.user_id, p_job, 'refund', 'Simulation cancelled');
  next_status := case when j.status in ('draft', 'pending') then 'cancelled' else 'cancelling' end;

  update public.jobs
     set status = next_status, status_at_cancel = j.status, cancelled_by = p_caller,
         next_poll_at = now()
   where id = p_job;
  if j.run_ref is not null then
    update public.runs
       set status = next_status::text,
           stage_text = case when next_status = 'cancelled' then 'Cancelled' else 'Stopping' end,
           refunded = nullif(amount, 0),
           finished_at = case when next_status = 'cancelled' then now() end
     where id = j.run_ref;
  end if;
  return jsonb_build_object('refunded', amount, 'status', next_status);
end $$;

-- ── cancelRun ────────────────────────────────────────────────────────────────
-- Ask a run to stop. The owner, or a collaborator with edit, may. The refund
-- is decided here, under the row lock, from the status the job holds right
-- now: a run that has not reached the mesher gets its whole charge back.
create or replace function private.cancel_run(p_run text, p_caller uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  r public.runs;
  j public.jobs;
  amount integer := 0;
  next_status public.job_status;
begin
  select * into r from public.runs where id = p_run;
  if not found then raise exception 'No such run.' using errcode = 'P0002'; end if;
  if r.user_id is distinct from p_caller and not exists (
       select 1 from public.groups g
        where g.id = r.group_id
          and (g.user_id = p_caller or g.shared_with ->> p_caller::text = 'edit')) then
    raise exception 'That run is not yours to cancel.' using errcode = '42501';
  end if;

  select * into j from public.jobs where id = r.job_id for update;
  if not found then raise exception 'No such run.' using errcode = 'P0002'; end if;
  if j.status in ('complete', 'failed', 'cancelled', 'cancelling') then
    raise exception '%', case when j.status in ('cancelled', 'cancelling')
                              then 'That run is already cancelled.'
                              else format('That run is %s and cannot be stopped.', r.status) end
      using errcode = 'P0001';
  end if;
  perform 1 from public.users where id = j.user_id for update;

  if private.refundable(j.status) then
    amount := private.give_back(j.user_id, j.id, 'refund', 'Simulation cancelled');
  end if;
  next_status := case when j.status in ('draft', 'pending') then 'cancelled' else 'cancelling' end;

  update public.jobs
     set status = next_status, status_at_cancel = j.status, cancelled_by = p_caller,
         next_poll_at = now()
   where id = j.id;
  update public.runs
     set status = next_status::text,
         stage_text = case when next_status = 'cancelled' then 'Cancelled' else 'Stopping' end,
         refunded = nullif(amount, 0),
         finished_at = case when next_status = 'cancelled' then now() end
   where id = p_run;
  if next_status = 'cancelled' then
    perform private.notify(j.user_id, 'cancelled', coalesce(r.name, 'A run') || ' was cancelled.', p_run, j.id);
  end if;
  return jsonb_build_object('ok', true, 'refunded', amount, 'status', next_status);
end $$;

-- ── endings ──────────────────────────────────────────────────────────────────
-- A job that failed. If the solver never started (no mesh id, no SimScale run
-- id) nothing was spent, and the whole charge goes back as a reversal; past
-- that, the charge stands (functions/src/jobs/onJobPending.ts).
create or replace function private.fail_job(p_job text, p_reason text) returns integer
language plpgsql set search_path = '' as $$
declare
  j public.jobs;
  reversed integer := 0;
  r_name text;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found or j.status in ('complete', 'failed', 'cancelled') then return 0; end if;
  perform 1 from public.users where id = j.user_id for update;

  if j.mesh_id is null and j.simscale_run_id is null then
    reversed := private.give_back(j.user_id, p_job, 'simulation_charge_reversal',
      'The simulation could not be run, so the charge was reversed');
  end if;
  update public.jobs
     set status = 'failed', error = left(p_reason, 2000), next_poll_at = null, lease_until = null
   where id = p_job;
  if j.run_ref is not null then
    update public.runs
       set status = 'failed', stage_text = 'Failed', error = left(p_reason, 2000),
           refunded = case when reversed > 0 then reversed else refunded end, finished_at = now()
     where id = j.run_ref and status not in ('finished', 'failed', 'cancelled')
    returning name into r_name;
    perform private.notify(j.user_id, 'failed',
      coalesce(r_name, 'A run') || ' failed: ' || left(coalesce(p_reason, 'no reason given'), 160),
      j.run_ref, p_job);
  end if;
  return reversed;
end $$;

-- The poller has wound SimScale down after a cancel. No money moves here:
-- the refund, if any, was decided when the cancel was asked for.
create or replace function private.finish_cancel(p_job text) returns void
language plpgsql set search_path = '' as $$
declare j public.jobs; r_name text;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found or j.status <> 'cancelling' then return; end if;
  update public.jobs set status = 'cancelled', next_poll_at = null, lease_until = null where id = p_job;
  if j.run_ref is not null then
    update public.runs set status = 'cancelled', stage_text = 'Cancelled', finished_at = now()
     where id = j.run_ref returning name into r_name;
    perform private.notify(j.user_id, 'cancelled', coalesce(r_name, 'A run') || ' was cancelled.', j.run_ref, p_job);
  end if;
end $$;

-- ── accounts ─────────────────────────────────────────────────────────────────
-- Create the account row and the 50-credit signup bonus, once. A second call
-- for the same user writes nothing, so a spent balance is never reset.
create or replace function private.ensure_account(
  p_user uuid, p_email text, p_name text, p_storage_uid text) returns boolean
language plpgsql set search_path = '' as $$
begin
  insert into public.users (id, storage_uid, email, name, credits, sponsored, sponsor_rate,
                            email_verified, last_seen)
  values (p_user, p_storage_uid, p_email, p_name, 50, false, 1, true, now())
  on conflict (id) do nothing;
  if not found then return false; end if;
  insert into public.transactions (user_id, id, type, amount, reason)
  values (p_user, 'signup_bonus', 'signup_bonus', 50, 'Welcome to TurboFlow');
  return true;
end $$;

-- ── purchases ────────────────────────────────────────────────────────────────
-- Grant what a captured PayPal order bought, exactly once. The order row is
-- deleted in the same transaction that grants; if it is already gone, the
-- other route (capture or webhook) got there first and this grants nothing.
create or replace function private.apply_purchase(p_order text, p_capture text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  o public.paypal_orders;
  u public.users;
  days integer;
  active boolean;
  until_at timestamptz;
  paid text;
begin
  delete from public.paypal_orders where id = p_order returning * into o;
  if not found then
    return jsonb_build_object('applied', false, 'product', 'credits');
  end if;
  select * into u from public.users where id = o.user_id for update;
  if not found then raise exception 'The buyer''s account no longer exists.'; end if;
  paid := '$' || to_char(o.amount_usd, 'FM999999990.00');

  if o.kind = 'unlimited' then
    days := case when coalesce(o.days, 0) > 0 then o.days else 30 end;
    active := u.unlimited_until is not null and u.unlimited_until > now();
    until_at := (case when active then u.unlimited_until else now() end) + make_interval(days => days);
    update public.users
       set unlimited_until = until_at,
           unlimited_started_at = case when active then coalesce(u.unlimited_started_at, now()) else now() end
     where id = o.user_id;
    insert into public.transactions (user_id, id, type, amount, reason, order_id, capture_id)
    values (o.user_id, 'order_' || p_order, 'unlimited_pass', 0,
            format('PayPal %s, unlimited for %s days', paid, days), p_order, p_capture)
    on conflict (user_id, id) do update set reason = excluded.reason;
    return jsonb_build_object('applied', true, 'product', 'unlimited',
      'unlimited_until', (extract(epoch from until_at) * 1000)::bigint);
  end if;

  insert into public.transactions (user_id, id, type, amount, reason, order_id, capture_id)
  values (o.user_id, 'order_' || p_order, 'purchase', coalesce(o.credits, 0),
          format('PayPal %s, %s credits', paid, coalesce(o.credits, 0)), p_order, p_capture);
  update public.users set credits = credits + coalesce(o.credits, 0) where id = o.user_id;
  return jsonb_build_object('applied', true, 'product', 'credits', 'credits', coalesce(o.credits, 0));
end $$;

-- ── rate limits ──────────────────────────────────────────────────────────────
-- A fixed window per key, as functions/src/lib/ratelimit.ts. Returns true
-- when this call puts the key over its limit.
create or replace function private.rate_hit(p_key text, p_limit integer, p_window_s integer)
returns boolean language plpgsql set search_path = '' as $$
declare
  w bigint := floor(extract(epoch from now()) / p_window_s);
  n integer;
begin
  insert into public.rate_counters (key, count, expire_at)
  values (p_key || ':' || w, 1, to_timestamp((w + 2) * p_window_s))
  on conflict (key) do update set count = public.rate_counters.count + 1
  returning count into n;
  return n > p_limit;
end $$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
