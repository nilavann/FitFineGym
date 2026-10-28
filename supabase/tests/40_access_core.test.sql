-- access_of for every kind of user, act_as, the trigger functions in fitfine_private and the
-- identity-insert rule.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

-- access_of: (is_active, is_admin, is_system_admin) --------------------------------------------
select t.eq('access_of: an auth user with no profile has no access',
  fitfine_private.access_of(t.uid('nop'))::text, '(f,f,f)');
select t.eq('access_of: an inactive user has no access',
  fitfine_private.access_of(t.uid('inactive'))::text, '(f,f,f)');
select t.eq('access_of: a deleted user has no access',
  fitfine_private.access_of(t.uid('deleted'))::text, '(f,f,f)');
select t.eq('access_of: a user without a role has no access',
  fitfine_private.access_of(t.uid('norole'))::text, '(f,f,f)');
select t.eq('access_of: staff is active only',
  fitfine_private.access_of(t.uid('staff'))::text, '(t,f,f)');
select t.eq('access_of: an admin is active and admin',
  fitfine_private.access_of(t.uid('admin'))::text, '(t,t,f)');
select t.eq('access_of: a system admin is all three',
  fitfine_private.access_of(t.uid('sysadmin'))::text, '(t,t,t)');
select t.eq('access_of: an unknown id has no access',
  fitfine_private.access_of('00000000-0000-0000-0000-000000000000')::text, '(f,f,f)');
select t.eq('access_of: NULL has no access',
  coalesce(fitfine_private.access_of(null)::text, '(f,f,f)'), '(f,f,f)');

-- A role that is soft-deleted no longer counts.
update fitfine.roles set deleted_at = now() where id = t.role_id('staff');
select t.eq('access_of: a user whose only role is deleted has no access',
  fitfine_private.access_of(t.uid('staff'))::text, '(f,f,f)');
update fitfine.roles set deleted_at = null where name = 'staff' and deleted_at is not null;
-- system_admin without admin is not a system admin.
delete from fitfine.user_roles where user_id = t.uid('sysadmin') and role_id = t.role_id('admin');
select t.eq('access_of: system_admin without admin is neither admin nor system admin',
  fitfine_private.access_of(t.uid('sysadmin'))::text, '(t,f,f)');
insert into fitfine.user_roles (user_id, role_id) values (t.uid('sysadmin'), t.role_id('admin'));

-- The RLS helpers read the caller ------------------------------------------------------------
select t.eq('is_active_user() is true for staff',
  t.try('authenticated', t.uid('staff'), 'select 1 where fitfine_private.is_active_user()'), 'rows:1');
select t.eq('is_active_admin() is false for staff',
  t.try('authenticated', t.uid('staff'), 'select 1 where fitfine_private.is_active_admin()'), 'rows:0');
select t.eq('is_active_admin() is true for an admin',
  t.try('authenticated', t.uid('admin'), 'select 1 where fitfine_private.is_active_admin()'), 'rows:1');

-- act_as ----------------------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', '{"sub": "x", "role": "service_role"}', true);
  perform fitfine_private.act_as(t.uid('admin'));
  perform t.eq('act_as sets request.jwt.claims to exactly {"sub": <id>}',
    current_setting('request.jwt.claims')::jsonb, jsonb_build_object('sub', t.uid('admin')));
  perform t.eq('act_as sets request.jwt.claim.sub', current_setting('request.jwt.claim.sub'), t.uid('admin')::text);
  perform t.eq('after act_as, auth.uid() is the caller', auth.uid(), t.uid('admin'));
  perform t.logout();
end $$;
select t.raises('act_as refuses NULL', 'postgres', null, 'select fitfine_private.act_as(null)', 'P0001', '%user id is required%');

-- Trigger functions -------------------------------------------------------------------------------
select t.ok('every trigger on fitfine and on auth.users runs a fitfine_private function',
  (select count(*) from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where not tg.tgisinternal and p.pronamespace = 'fitfine_private'::regnamespace
     and tg.tgrelid in (select oid from pg_class where relnamespace in ('fitfine'::regnamespace, 'auth'::regnamespace))) = 26
  and not exists (select 1 from pg_proc where pronamespace = 'fitfine'::regnamespace and prorettype = 'trigger'::regtype));

do $$
declare
  v_id     bigint;
  v_number text;
  v_by     uuid;
  v_seq    integer;
begin
  select last_sequence into v_seq from fitfine.member_number_sequences where branch_id = t.branch('TA');
  perform t.login('staff');
  insert into fitfine.members (name, phone, date_of_birth, gender, weight_kg, height_cm,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, branch_id)
  values ('Trigger Test', '5550000077', '1990-01-01', 'Female', 60, 160, 'C', '9999999999', 'Friend', t.branch('TA'))
  returning id, member_number, created_by into v_id, v_number, v_by;
  update fitfine.members set name = 'Trigger Test 2' where id = v_id;
  perform t.logout();

  perform t.eq('generate_member_number: <code>-<year>-<padded next sequence>', v_number,
    'TA-' || extract(year from now())::integer || '-' || lpad((v_seq + 1)::text, 4, '0'));
  perform t.eq('set_audit_fields: created_by is the signed-in user', v_by, t.uid('staff'));
  perform t.eq('set_audit_fields: changed_by is the signed-in user',
    (select changed_by from fitfine.members where id = v_id), t.uid('staff'));
  perform t.ok('audit_row_changes: the update is in audit_log, attributed',
    exists (select 1 from fitfine.audit_log where table_name = 'members' and record_id = v_id::text
            and field_name = 'name' and operation = 'update' and new_value = 'Trigger Test 2' and changed_by = t.uid('staff')));

  -- The trigger reverts member_number and branch_id even for the service role.
  set local role service_role;
  update fitfine.members set member_number = 'X-1', branch_id = t.branch('TAB') where id = v_id;
  reset role;
  perform t.eq('generate_member_number: member_number and branch_id never change',
    (select member_number || '|' || branch_id from fitfine.members where id = v_id), v_number || '|' || t.branch('TA'));
end $$;

select t.raises('prevent_hard_delete: the owner cannot delete a member either', 'postgres', null,
  'delete from fitfine.members where phone = ''5550000002''', 'P0001', '%Hard delete is not allowed on table members%');
select t.raises('protect_system_admin_role: system_admin cannot be renamed', 'postgres', null,
  'update fitfine.roles set name = ''root'' where name = ''system_admin''', 'P0001', '%reserved%');

-- Every function in both schemas has search_path = '' (invoker ones too) ------------------------
select t.ok('every function in fitfine and fitfine_private has search_path = ''''',
  not exists (
    select 1 from pg_proc p
    where p.pronamespace in ('fitfine'::regnamespace, 'fitfine_private'::regnamespace)
      and coalesce(p.proconfig, '{}') @> array['search_path=""'] is not true));

-- Identity inserts need no sequence grant ------------------------------------------------------
select t.ok('authenticated holds no privilege on any fitfine sequence',
  not exists (
    select 1 from pg_class s where s.relnamespace = 'fitfine'::regnamespace and s.relkind = 'S'
      and (has_sequence_privilege('authenticated', s.oid, 'usage') or has_sequence_privilege('authenticated', s.oid, 'select')
           or has_sequence_privilege('authenticated', s.oid, 'update'))));
select t.runs('a member insert as authenticated works without a sequence grant', 'authenticated', t.uid('staff'),
  format($q$insert into fitfine.members (name, phone, date_of_birth, gender, weight_kg, height_cm,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, branch_id)
    values ('Seq Test', '5550000088', '1990-01-01', 'Male', 70, 170, 'C', '9999999999', 'Friend', %s)$q$, t.branch('TA')));

rollback;
