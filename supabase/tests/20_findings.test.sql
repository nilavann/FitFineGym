-- One regression test per access gap found in the earlier public-schema backend (F1-F9), so none
-- comes back.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

-- F1: the views bypassed RLS and anon could read them.
select t.raises('F1 anon cannot read member_list_view', 'anon', null,
  'select * from fitfine.member_list_view', '42501');
select t.raises('F1 anon cannot read profiles_with_roles', 'anon', null,
  'select * from fitfine.profiles_with_roles', '42501');
select t.eq('F1 a deactivated user with a live token reads no member through the view',
  t.try('authenticated', t.uid('inactive'), 'select * from fitfine.member_list_view'), 'rows:0');
select t.eq('F1 a deactivated user reads no current item through the view',
  t.try('authenticated', t.uid('inactive'), 'select * from fitfine.member_current_items'), 'rows:0');
select t.ok('F1 all three views are security_invoker',
  (select count(*) from pg_class c
   where c.relnamespace = 'fitfine'::regnamespace and c.relkind = 'v'
     and 'security_invoker=true' = any (c.reloptions)) = 3);

-- F2: the caller-id RPCs were executable by anon and authenticated.
select t.raises('F2 a signed-in user cannot call create_subscription_with_items', 'authenticated', t.uid('staff'),
  format('select fitfine.create_subscription_with_items(%L, 1, %L, null, %L)', t.uid('admin'), 'Cash', '[]'), '42501');
select t.raises('F2 a signed-in admin cannot call update_profile_fields', 'authenticated', t.uid('admin'),
  format('select fitfine.update_profile_fields(%L, %L, null, false)', t.uid('admin'), t.uid('admin3')), '42501');
select t.raises('F2 anon cannot call delete_member', 'anon', null,
  format('select fitfine.delete_member(%L, 1)', t.uid('staff')), '42501');
select t.raises('F2 a signed-in user cannot call delete_subscription', 'authenticated', t.uid('staff'),
  format('select fitfine.delete_subscription(%L, 1)', t.uid('staff')), '42501');

-- F3: every new auth user, invited or not, became an active staff member.
insert into auth.users (id, email) values ('f17f1e00-0000-4000-8000-0000000000f3', 'signup@fitfine.test');
select t.eq('F3 an uninvited sign-up gets no profile',
  (select count(*) from fitfine.profiles where id = 'f17f1e00-0000-4000-8000-0000000000f3'), 0::bigint);
select t.eq('F3 an uninvited sign-up reads no member',
  t.try('authenticated', 'f17f1e00-0000-4000-8000-0000000000f3', 'select * from fitfine.members'), 'rows:0');
select t.eq('F3 a profile without a role reads no member',
  t.try('authenticated', t.uid('norole'), 'select * from fitfine.members'), 'rows:0');

-- F4: anon and authenticated held DELETE, TRUNCATE, REFERENCES and TRIGGER on every table.
select t.raises('F4 a signed-in admin cannot truncate audit_log', 'authenticated', t.uid('admin'),
  'truncate fitfine.audit_log', '42501');
select t.raises('F4 service_role cannot truncate members', 'service_role', null,
  'truncate fitfine.members', '42501');
select t.ok('F4 nobody but the owner holds DELETE, TRUNCATE, REFERENCES or TRIGGER on a table',
  not exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'fitfine' and g.grantee <> 'postgres'
      and g.privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')));

-- F5: a direct write could reach any column, and a direct delete skipped the usage guards.
select t.raises('F5 staff cannot delete a member directly', 'authenticated', t.uid('staff'),
  'delete from fitfine.members where true', '42501');
select t.raises('F5 staff cannot write member_number', 'authenticated', t.uid('staff'),
  'update fitfine.members set member_number = ''X-1'' where true', '42501');
select t.raises('F5 an admin cannot delete a plan directly', 'authenticated', t.uid('admin'),
  'delete from fitfine.plans where true', '42501');

-- F6: the policies applied to anon and re-evaluated the helper per row.
select t.ok('F6 every policy is TO authenticated only',
  not exists (select 1 from pg_policies where schemaname = 'fitfine' and roles <> '{authenticated}'));
select t.ok('F6 every helper call in a policy is wrapped in (select ...)',
  not exists (
    select 1 from pg_policies
    where schemaname = 'fitfine'
      and (regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                          '\( SELECT fitfine_private\.is_active_(user|admin)\(\) AS is_active_(user|admin)\)', '', 'g')
           ~ 'is_active_(user|admin)')));

-- F7: the helpers were RPC endpoints, so anyone could test which ids are admins.
select t.raises('F7 a signed-in user cannot call access_of', 'authenticated', t.uid('staff'),
  format('select fitfine_private.access_of(%L)', t.uid('admin')), '42501');
select t.ok('F7 the only function in fitfine authenticated may execute is update_member_number_config',
  (select array_agg(p.proname::text) from pg_proc p
   where p.pronamespace = 'fitfine'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute'))
  = array['update_member_number_config']);

-- F8: update_member_number_config updated 0 rows for a non-admin and reported success.
select t.raises('F8 a non-admin gets an error, not a silent success', 'authenticated', t.uid('staff'),
  'select fitfine.update_member_number_config(5, 2, 6)', 'PT403', 'Admin access required');
select t.eq('F8 the configuration is unchanged',
  (select value from fitfine.configuration where key = 'member_number_increment'), '1');

-- F9: there was no storage DELETE policy, so photo removal removed nothing.
select t.ok('F9 storage.objects has a DELETE policy for member-photos',
  exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'member_photos_delete_active_users' and cmd = 'DELETE'));

rollback;
