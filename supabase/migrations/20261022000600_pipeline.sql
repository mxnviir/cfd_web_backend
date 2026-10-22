-- The rest of the pipeline's database half, and Fusion sessions.

-- A finished run: the job complete, the run finished, the numbers on both.
-- No money moves; the charge was taken when the run was queued.
create or replace function private.complete_job(
  p_job text, p_plots jsonb, p_summary jsonb, p_case_path text) returns void
language plpgsql set search_path = '' as $$
declare j public.jobs; r_name text;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found or j.status <> 'downloading_results' then return; end if;
  update public.jobs
     set status = 'complete', case_path = p_case_path,
         drag_n = (p_summary ->> 'drag')::double precision,
         lift_n = (p_summary ->> 'lift')::double precision,
         next_poll_at = null, lease_until = null
   where id = p_job;
  if j.run_ref is not null then
    update public.runs
       set status = 'finished', stage_text = 'Finished', progress = 1,
           plots = p_plots, summary = p_summary, case_path = p_case_path, finished_at = now()
     where id = j.run_ref
    returning name into r_name;
    perform private.notify(j.user_id, 'finished', coalesce(r_name, 'A run') || ' finished.', j.run_ref, p_job);
  end if;
end $$;

-- ── Fusion sessions ──────────────────────────────────────────────────────────
-- A connection token (tfk_...) is exchanged by the ops router for a session
-- token that lasts an hour:
--
--   tfs_<user id>.<token id>.<expiry, epoch seconds>.<hex HMAC-SHA256>
--
-- signed with the vault's internal secret. It is verified here, which is
-- also where revocation is seen: a session whose connection token has been
-- revoked stops working at once, not when it expires.
create or replace function private.fusion_session(p_token text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  parts text[];
  secret text;
begin
  if p_token is null or left(p_token, 4) <> 'tfs_' then return null; end if;
  parts := string_to_array(substr(p_token, 5), '.');
  if coalesce(array_length(parts, 1), 0) <> 4 or parts[3] !~ '^[0-9]{1,12}$'
     or parts[1] !~ '^[0-9a-f-]{36}$' then
    return null;
  end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'internal_secret';
  if encode(extensions.hmac(parts[1] || '.' || parts[2] || '.' || parts[3], secret, 'sha256'), 'hex')
     <> parts[4] then
    return null;
  end if;
  if parts[3]::bigint < extract(epoch from now()) then return null; end if;
  if not exists (select 1 from public.fusion_tokens
                  where user_id = parts[1]::uuid and token_id = parts[2]) then
    return null;
  end if;
  return parts[1]::uuid;
end $$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
