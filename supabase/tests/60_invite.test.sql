-- handle_new_auth_user, invite-only. The
-- auth.users rows are inserted the way GoTrue writes them: an invite sets invited_at and carries
-- invite-user's metadata; a sign-up or Google sign-in doesn't set invited_at.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

create function t.new_user(p_n int, p_email text, p_invited boolean, p_meta jsonb) returns uuid
language plpgsql as $$
declare v_id uuid := ('f17f1e00-0000-4000-8000-1' || lpad(p_n::text, 11, '0'))::uuid;
begin
  insert into auth.users (id, email, invited_at, raw_user_meta_data)
  values (v_id, p_email, case when p_invited then now() end, p_meta);
  return v_id;
end $$;

-- An invite creates the profile and its roles, attributed to the inviter.
do $$
declare v_id uuid;
begin
  v_id := t.new_user(1, 'new.staff@fitfine.test', true, jsonb_build_object(
    'full_name', 'New Staff', 'invited_by', t.uid('admin'), 'role_ids', jsonb_build_array(t.role_id('staff'))));
  perform t.ok('an invite creates an active profile with the invited name, created by the inviter',
    exists (select 1 from fitfine.profiles where id = v_id and full_name = 'New Staff' and is_active and created_by = t.uid('admin')));
  perform t.eq('an invite grants the invited roles, granted by the inviter',
    (select string_agg(r.name || ':' || ur.granted_by, ',') from fitfine.user_roles ur join fitfine.roles r on r.id = ur.role_id where ur.user_id = v_id),
    'staff:' || t.uid('admin'));
  perform t.ok('the profile and role rows are in the audit log, attributed to the inviter',
    exists (select 1 from fitfine.audit_log where table_name = 'profiles' and record_id = v_id::text and changed_by = t.uid('admin'))
    and exists (select 1 from fitfine.audit_log where table_name = 'user_roles' and record_id like v_id || ':%' and changed_by = t.uid('admin')));
  perform t.eq('the invited user is active', (fitfine_private.access_of(v_id)).is_active, true);

  -- A later metadata change (auth.updateUser({ data })) changes neither the profile nor the roles.
  update auth.users set raw_user_meta_data = jsonb_build_object(
    'full_name', 'Hijacked', 'invited_by', t.uid('sysadmin'), 'role_ids', jsonb_build_array(t.role_id('admin'), t.role_id('system_admin')))
  where id = v_id;
  perform t.eq('a later metadata update changes neither the profile nor the roles',
    (select p.full_name || '|' || string_agg(r.name, ',') from fitfine.profiles p
     join fitfine.user_roles ur on ur.user_id = p.id join fitfine.roles r on r.id = ur.role_id
     where p.id = v_id group by p.full_name),
    'New Staff|staff');
end $$;

-- Role ids that aren't positive integers of an existing, non-deleted role are skipped.
do $$
declare
  v_id      uuid;
  v_deleted smallint;
begin
  insert into fitfine.roles (name, deleted_at) values ('t_deleted_role', now()) returning id into v_deleted;
  v_id := t.new_user(2, 'mixed@fitfine.test', true, jsonb_build_object(
    'full_name', 'Mixed Roles', 'invited_by', t.uid('admin'),
    'role_ids', jsonb_build_array(t.role_id('staff'), 32000, v_deleted, '1; drop table fitfine.members', '1.5', -1, 0,
                                  '123456', '99999999999999999999', jsonb_build_object('id', 1), null)));
  perform t.eq('unknown, deleted, non-integer and oversized role ids are skipped; the valid one is kept',
    (select string_agg(r.name, ',') from fitfine.user_roles ur join fitfine.roles r on r.id = ur.role_id where ur.user_id = v_id),
    'staff');
  perform t.ok('members still exists', to_regclass('fitfine.members') is not null);
end $$;

do $$
declare v_id uuid;
begin
  v_id := t.new_user(3, 'string-roles@fitfine.test', true, jsonb_build_object(
    'full_name', 'String Roles', 'role_ids', t.role_id('staff')::text));
  perform t.ok('role_ids that is not an array grants nothing and does not fail the invite',
    exists (select 1 from fitfine.profiles where id = v_id)
    and not exists (select 1 from fitfine.user_roles where user_id = v_id));
end $$;

-- Sign-ups and Google sign-ins (no invited_at) get nothing, whatever their metadata claims.
do $$
declare v_id uuid;
begin
  v_id := t.new_user(4, 'signup@fitfine.test', false, jsonb_build_object(
    'full_name', 'Sign Up', 'invited_by', t.uid('sysadmin'), 'role_ids', jsonb_build_array(t.role_id('admin'))));
  perform t.ok('an uninvited insert creates no profile and no roles',
    not exists (select 1 from fitfine.profiles where id = v_id) and not exists (select 1 from fitfine.user_roles where user_id = v_id));
end $$;

-- A dashboard invite carries no metadata: the name falls back to the email's local part, cut to 80.
do $$
declare v_id uuid;
begin
  v_id := t.new_user(5, repeat('x', 100) || '@fitfine.test', true, null);
  perform t.eq('an invite without full_name gets the email''s local part, cut to 80 characters',
    (select full_name from fitfine.profiles where id = v_id), repeat('x', 80));
  perform t.ok('a dashboard invite (no inviter) is created by nobody and has no role',
    exists (select 1 from fitfine.profiles where id = v_id and created_by is null)
    and not exists (select 1 from fitfine.user_roles where user_id = v_id));
end $$;

-- invited_by that names no profile, or isn't a uuid, is ignored rather than failing the invite.
do $$
declare v_a uuid; v_b uuid;
begin
  v_a := t.new_user(6, 'ghost-inviter@fitfine.test', true, jsonb_build_object(
    'full_name', 'Ghost', 'invited_by', '00000000-0000-4000-8000-000000000000', 'role_ids', jsonb_build_array(t.role_id('staff'))));
  v_b := t.new_user(7, 'bad-inviter@fitfine.test', true, jsonb_build_object(
    'full_name', 'Bad', 'invited_by', 'not-a-uuid', 'role_ids', jsonb_build_array(t.role_id('staff'))));
  perform t.ok('an inviter id with no profile, or not a uuid, is ignored',
    (select count(*) from fitfine.profiles where id in (v_a, v_b) and created_by is null) = 2
    and (select count(*) from fitfine.user_roles where user_id in (v_a, v_b) and granted_by is null) = 2);
end $$;

-- The inviter's attribution doesn't leak into the rest of the inserting transaction.
do $$
begin
  perform set_config('request.jwt.claim.sub', t.uid('staff')::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.uid('staff'))::text, true);
  perform t.new_user(9, 'restore@fitfine.test', true, jsonb_build_object('full_name', 'Restore', 'invited_by', t.uid('admin')));
  perform t.eq('after an invite, the transaction''s own auth.uid() is back', auth.uid(), t.uid('staff'));
  perform t.logout();
end $$;

-- A name the database refuses fails the whole invite: no auth user without a profile.
select t.raises('an invite whose name breaks chk_profiles_full_name_text fails as a whole', 'postgres', null,
  format($q$insert into auth.users (id, email, invited_at, raw_user_meta_data)
    values ('f17f1e00-0000-4000-8000-100000000008', 'long@fitfine.test', now(), %L)$q$,
    jsonb_build_object('full_name', repeat('n', 81))), '23514', '%chk_profiles_full_name_text%');

-- Only handle_new_auth_user reads the metadata, and only on insert.
select t.eq('trg_handle_new_auth_user fires AFTER INSERT only, per row',
  (select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_handle_new_auth_user'),
  'CREATE TRIGGER trg_handle_new_auth_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION fitfine_private.handle_new_auth_user()');
select t.eq('no function but handle_new_auth_user mentions raw_user_meta_data or user_metadata',
  (select string_agg(p.proname, ',') from pg_proc p
   where p.pronamespace in ('fitfine'::regnamespace, 'fitfine_private'::regnamespace)
     and p.prosrc ~* '(raw_user_meta_data|user_metadata)'),
  'handle_new_auth_user');

rollback;
