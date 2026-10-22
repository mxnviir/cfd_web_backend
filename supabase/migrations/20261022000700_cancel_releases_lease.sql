-- A cancel is for the next POLL tick, whoever holds the job.
--
-- refund_job and cancel_run moved a job to `cancelling` but left any lease
-- on it, so a run cancelled while SUBMIT was uploading sat for the rest of
-- SUBMIT's five-minute lease before POLL could wind it down. They now drop
-- the lease. Whatever step still holds the job cannot undo the cancel: every
-- status change a step makes is conditional on the status it started from.
-- No money moves differently.

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
         next_poll_at = now(), lease_until = null
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
         next_poll_at = now(), lease_until = null
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

revoke all on all functions in schema private from public, anon, authenticated, service_role;
