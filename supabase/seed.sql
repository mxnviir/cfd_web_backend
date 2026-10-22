-- One demo account, for `supabase db reset` and the test suites.
--
-- It has no password and no identity, so nobody can sign in as it; the tests
-- act as it by setting its id in the JWT claims. The Workbench on localhost
-- signs in anonymously instead (config.toml) and gets an account of its own.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000d3e0', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'demo@turboflow.local', now(),
        '{"provider": "google", "providers": ["google"]}', '{"full_name": "Demo Team"}', now(), now())
on conflict (id) do nothing;

select private.ensure_account('00000000-0000-4000-8000-00000000d3e0', 'demo@turboflow.local',
                              'Demo Team', '00000000-0000-4000-8000-00000000d3e0');

insert into public.groups (id, user_id, name, description, category)
values ('demoGroup00000000001', '00000000-0000-4000-8000-00000000d3e0', 'Demo car', '', 'education')
on conflict (id) do nothing;
