-- Storage: one private bucket, the users/{uid}/... layout unchanged.
--
-- storage.rules, ported. Ownership is the folder name: users/<storage_uid>/,
-- where storage_uid is the caller's own (rls.storage_uid). A migrated account
-- keeps its Firebase uid as storage_uid, so every existing path resolves.
--
-- Writes are along reserved intents only. A client can upload a path only if
-- the server has already written it down for that client: a geometry's raw
-- or STEP path (createUploadIntent), an open artifact intent's staging folder
-- (createArtifactIntent / createCarIntent), or the viewer files of its own
-- finished run that has none yet (the browser FINISH step).
--
-- There is no UPDATE policy, so every client upload is write-once: upserting
-- over an existing object needs UPDATE and is refused.

-- 200 MB per object is the largest file the app accepts. The project-wide
-- upload limit is lower on the Free plan (50 MB); see docs/CUTOVER.md.
insert into storage.buckets (id, name, public, file_size_limit)
values ('turboflow', 'turboflow', false, 200 * 1024 * 1024)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function rls.quota_bytes() returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(storage_quota_bytes, 0), 5::bigint * 1024 * 1024 * 1024)
    from public.users where id = auth.uid()
$$;

-- May the caller read this object?
create or replace function rls.may_read(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_name ~ ('^users/' || rls.storage_uid() || '/('
      || 'geometries/[^/]+/[^/]+'
      || '|geometries/[^/]+/v[0-9]+/[^/]+'
      || '|geometries/[^/]+/incoming/[A-Za-z0-9_-]{8,64}/[^/]+'
      || '|results/[^/]+/.+)$')
$$;

-- May the caller delete this object? Its own uploads, as before; never a
-- version folder or a result, which services wrote.
create or replace function rls.may_delete(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_name ~ ('^users/' || rls.storage_uid() || '/geometries/[^/]+/('
      || '[^/]+|incoming/[A-Za-z0-9_-]{8,64}/[^/]+)$')
$$;

-- May the caller create this object?
create or replace function rls.may_upload(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  suid text := rls.storage_uid();
  parts text[] := string_to_array(p_name, '/');
  u public.users;
begin
  if suid is null or parts[1] <> 'users' or parts[2] <> suid then return false; end if;
  select * into u from public.users where id = auth.uid();
  if u.storage_bytes >= rls.quota_bytes() then return false; end if;

  -- users/<suid>/geometries/<gid>/<file>: a path createUploadIntent recorded.
  if array_length(parts, 1) = 5 and parts[3] = 'geometries'
     and parts[5] in ('raw.step', 'raw.stp', 'geometry.step', 'entity_labels.csv') then
    return exists (
      select 1 from public.geometries g
       where g.id = parts[4] and g.user_id = auth.uid()
         and p_name in (g.raw_path, g.step_path, g.label_path));
  end if;

  -- users/<suid>/geometries/<gid>/incoming/<token>/<file>: an open intent.
  if array_length(parts, 1) = 7 and parts[3] = 'geometries' and parts[5] = 'incoming'
     and parts[7] in ('geometry.step', 'entity_labels.csv', 'geometry.glb', 'model.glb',
                      'faces.json', 'solids.json', 'thumb.png') then
    return exists (
      select 1 from public.artifact_intents i
       where i.token = parts[6] and i.geometry_id = parts[4]
         and i.user_id = auth.uid() and i.state in ('open', 'consumed'));
  end if;

  -- users/<suid>/results/<job>/(results.glb | fields.json | fields/<name>.bin):
  -- the viewer files of the caller's own finished run, before it has any.
  if parts[3] = 'results' and (
       (array_length(parts, 1) = 5 and parts[5] in ('results.glb', 'fields.json'))
    or (array_length(parts, 1) = 6 and parts[5] = 'fields' and parts[6] ~ '^[A-Za-z]{1,40}\.bin$')) then
    return exists (
      select 1 from public.jobs j
       where j.id = parts[4] and j.user_id = auth.uid()
         and j.status = 'complete' and j.results_glb_path is null and j.case_path is not null);
  end if;

  return false;
end $$;

revoke all on all functions in schema rls from public;
grant execute on all functions in schema rls to anon, authenticated;

create policy turboflow_read on storage.objects for select to authenticated
  using (bucket_id = 'turboflow' and rls.may_read(name));
create policy turboflow_create on storage.objects for insert to authenticated
  with check (bucket_id = 'turboflow' and rls.may_upload(name));
create policy turboflow_delete on storage.objects for delete to authenticated
  using (bucket_id = 'turboflow' and rls.may_delete(name));

-- ── the quota ──────────────────────────────────────────────────────────────
-- Every object under users/<suid>/ counts against that account, except run
-- results (functions/src/storage/quota.ts): a case is hundreds of MB and only
-- the pipeline writes one, after a run the account paid for. Over the quota,
-- rls.may_upload refuses further uploads; nothing already stored is removed.
create or replace function private.count_storage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_size bigint := 0;
  new_size bigint := 0;
  suid text;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.bucket_id = 'turboflow' then
    old_size := coalesce((old.metadata ->> 'size')::bigint, 0);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.bucket_id = 'turboflow' then
    new_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  end if;
  suid := substring(coalesce(new.name, old.name) from '^users/([^/]+)/');
  if suid is null or coalesce(new.name, old.name) ~ '^users/[^/]+/results/'
     or new_size = old_size then
    return null;
  end if;
  update public.users
     set storage_bytes = greatest(0, storage_bytes + new_size - old_size),
         storage_over_quota = storage_bytes + new_size - old_size
                              >= coalesce(nullif(storage_quota_bytes, 0), 5::bigint * 1024 * 1024 * 1024)
   where storage_uid = suid;
  return null;
end $$;

create trigger turboflow_count_storage
  after insert or update of metadata or delete on storage.objects
  for each row execute function private.count_storage();

revoke all on all functions in schema private from public, anon, authenticated, service_role;
