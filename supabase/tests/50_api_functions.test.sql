-- The API functions, called the way their callers
-- call them: the Edge Function RPCs through service_role with the verified caller's id, the client
-- RPC as the signed-in user. Each refusal must raise its named error with its PTxxx code.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

create function t.m(p_phone text) returns bigint language sql stable as $$
  select id from fitfine.members where phone = p_phone
$$;

-- user_access (first, while the fixtures' three admins are untouched) ---------------------------------------------------------------------------------------
do $$
declare
  v jsonb;
  -- Active admins besides the fixtures' three (a scratch project has real ones).
  v_real int := (select count(*) from fitfine.profiles p where (fitfine_private.access_of(p.id)).is_admin) - 3;
begin
  set local role service_role;
  v := fitfine.user_access(t.uid('admin'));
  reset role;
  perform t.eq('user_access returns the caller''s access and the other active admins', v,
    jsonb_build_object('is_active', true, 'is_admin', true, 'other_active_admins', v_real + 2));
  set local role service_role;
  v := fitfine.user_access(t.uid('nop'));
  reset role;
  perform t.eq('user_access for a user without a profile', v,
    jsonb_build_object('is_active', false, 'is_admin', false, 'other_active_admins', v_real + 3));
end $$;

-- delete_member -----------------------------------------------------------------------------------
select t.raises('delete_member refuses a member with subscription items', 'service_role', null,
  format('select fitfine.delete_member(%L, %s)', t.uid('staff'), t.m('5550000001')), 'PT409',
  'Cannot delete — used by 1 subscription/add-on record(s)');
select t.raises('delete_member: a missing id is not found', 'service_role', null,
  format('select fitfine.delete_member(%L, -1)', t.uid('staff')), 'PT404', 'Member not found');
select t.raises('delete_member refuses an inactive caller', 'service_role', null,
  format('select fitfine.delete_member(%L, %s)', t.uid('inactive'), t.m('5550000002')), 'PT403');
do $$
declare
  v_id bigint := t.m('5550000002');
  v    jsonb;
begin
  update fitfine.members set photo_url = v_id || '/original-1.jpg', photo_thumbnail_url = v_id || '/thumbnail-1.jpg' where id = v_id;
  set local role service_role;
  v := fitfine.delete_member(t.uid('staff'), v_id);
  reset role;
  perform t.logout();
  perform t.ok('delete_member removes the row for real', not exists (select 1 from fitfine.members where id = v_id));
  perform t.eq('delete_member returns the photo paths so the files can be removed',
    v -> 'photo_paths', jsonb_build_array(v_id || '/original-1.jpg', v_id || '/thumbnail-1.jpg'));
  perform t.ok('delete_member: the audit log keeps the last values and names the caller',
    exists (select 1 from fitfine.audit_log where table_name = 'members' and record_id = v_id::text
            and field_name = 'name' and operation = 'delete' and old_value = 'Member Two'
            and new_value is null and changed_by = t.uid('staff')));
  perform t.raises('delete_member: an already deleted member is not found', 'service_role', null,
    format('select fitfine.delete_member(%L, %s)', t.uid('staff'), v_id), 'PT404');
end $$;

-- A member who is only a shared member on someone else's item is in use too.
do $$
declare v_partner bigint := t.member('5550000003', 'TA', 'Partner');
begin
  insert into fitfine.subscription_items (subscription_id, plan_id, member_id, shared_member_id, start_date, end_date, quantity, amount_paid)
  select s.id, t.plan('T Couple'), s.member_id, v_partner, current_date, current_date + 29, 1, 1800
  from fitfine.subscriptions s where s.member_id = t.m('5550000001');
  perform t.raises('delete_member refuses a shared member with subscription items', 'service_role', null,
    format('select fitfine.delete_member(%L, %s)', t.uid('staff'), v_partner), 'PT409');
end $$;

-- delete_subscription: one checkout, its items and its header; then the member can go --------------
select t.raises('delete_subscription: a missing id is not found', 'service_role', null,
  format('select fitfine.delete_subscription(%L, -1)', t.uid('staff')), 'PT404', 'Subscription not found');
select t.raises('delete_subscription refuses an inactive caller', 'service_role', null,
  format('select fitfine.delete_subscription(%L, (select min(id) from fitfine.subscriptions))', t.uid('inactive')), 'PT403');
do $$
declare
  v_m   bigint := t.member('5550000004', 'TA', 'Checkout Owner');
  v_sub bigint;
begin
  insert into fitfine.subscriptions (member_id, payment_mode) values (v_m, 'Cash') returning id into v_sub;
  insert into fitfine.subscription_items (subscription_id, plan_id, member_id, start_date, end_date, quantity, amount_paid)
  values (v_sub, t.plan('T Monthly'), v_m, current_date, current_date + 29, 1, 1000),
         (v_sub, t.plan('T Locker'),  v_m, current_date, null, 1, 200);
  perform t.raises('delete_member refuses the member while the checkout exists', 'service_role', null,
    format('select fitfine.delete_member(%L, %s)', t.uid('staff'), v_m), 'PT409', 'Cannot delete — used by 2 subscription/add-on record(s)');

  perform t.as_service(format('select fitfine.delete_subscription(%L, %s)', t.uid('staff'), v_sub));
  perform t.ok('delete_subscription removes the header and every item',
    not exists (select 1 from fitfine.subscriptions where id = v_sub)
    and not exists (select 1 from fitfine.subscription_items where subscription_id = v_sub));
  perform t.ok('delete_subscription: the audit log names the caller for the header and each item',
    exists (select 1 from fitfine.audit_log where table_name = 'subscriptions' and record_id = v_sub::text
            and operation = 'delete' and changed_by = t.uid('staff'))
    and (select count(distinct record_id) from fitfine.audit_log
         where table_name = 'subscription_items' and operation = 'delete' and changed_by = t.uid('staff')) = 2);
  perform t.runs('the member can be deleted once the checkout is gone', 'service_role', null,
    format('select fitfine.delete_member(%L, %s)', t.uid('staff'), v_m));
end $$;

-- delete_plan / _branch / _role -------------------------------------------------------------------
select t.raises('delete_plan refuses a plan with subscription items', 'service_role', null,
  format('select fitfine.delete_plan(%L, %s)', t.uid('admin'), t.plan('T Monthly')), 'PT409', 'Cannot delete — used by % subscription(s)');
select t.raises('delete_plan: a missing id is not found', 'service_role', null,
  format('select fitfine.delete_plan(%L, -1)', t.uid('admin')), 'PT404', 'Plan not found');
select t.raises('delete_plan refuses a staff caller', 'service_role', null,
  format('select fitfine.delete_plan(%L, %s)', t.uid('staff'), t.plan('T Locker')), 'PT403', 'Admin access required');
do $$
declare v_id bigint := t.plan('T Locker');
begin
  perform t.as_service(format('select fitfine.delete_plan(%L, %s)', t.uid('admin'), v_id));
  perform t.ok('delete_plan removes an unused plan for real, audited',
    not exists (select 1 from fitfine.plans where id = v_id)
    and exists (select 1 from fitfine.audit_log where table_name = 'plans' and record_id = v_id::text
                and operation = 'delete' and field_name = 'name' and old_value = 'T Locker' and changed_by = t.uid('admin')));
end $$;

select t.raises('delete_branch refuses a branch with members', 'service_role', null,
  format('select fitfine.delete_branch(%L, %s)', t.uid('admin'), t.branch('TA')), 'PT409', 'Cannot delete — used by % member(s)');
select t.raises('delete_branch: a missing id is not found', 'service_role', null,
  format('select fitfine.delete_branch(%L, -1)', t.uid('admin')), 'PT404', 'Branch not found');
do $$
declare v_id bigint := t.branch('TAB');
begin
  perform t.as_service(format('select fitfine.delete_branch(%L, %s)', t.uid('admin'), v_id));
  perform t.ok('delete_branch removes an unused branch for real, audited',
    not exists (select 1 from fitfine.branches where id = v_id)
    and exists (select 1 from fitfine.audit_log where table_name = 'branches' and record_id = v_id::text
                and operation = 'delete' and changed_by = t.uid('admin')));
end $$;
-- A branch whose members are all gone can be deleted, and its counter row goes with it.
do $$
declare v_id bigint;
begin
  insert into fitfine.branches (name, code) values ('Counter Branch', 'TCB') returning id into v_id;
  perform t.member('5550000005', 'TCB', 'Counter Member');
  perform t.eq('a counter row exists once a member was registered', (select count(*) from fitfine.member_number_sequences where branch_id = v_id), 1::bigint);
  delete from fitfine.members where phone = '5550000005';
  perform t.as_service(format('select fitfine.delete_branch(%L, %s)', t.uid('admin'), v_id));
  perform t.eq('delete_branch removes the branch''s counter row too', (select count(*) from fitfine.member_number_sequences where branch_id = v_id), 0::bigint);
end $$;

select t.raises('delete_role refuses a role users hold', 'service_role', null,
  format('select fitfine.delete_role(%L, %s)', t.uid('admin'), t.role_id('staff')), 'PT409', 'Cannot delete — used by % user(s)');
select t.raises('delete_role: a missing id is not found', 'service_role', null,
  format('select fitfine.delete_role(%L, -1)', t.uid('admin')), 'PT404', 'Role not found');
do $$
declare v_id smallint;
begin
  insert into fitfine.roles (name) values ('t_unused') returning id into v_id;
  perform t.as_service(format('select fitfine.delete_role(%L, %s)', t.uid('admin'), v_id));
  perform t.ok('delete_role removes an unused role for real, audited',
    not exists (select 1 from fitfine.roles where id = v_id)
    and exists (select 1 from fitfine.audit_log where table_name = 'roles' and record_id = v_id::text
                and operation = 'delete' and changed_by = t.uid('admin')));
end $$;

-- set_member_number_sequence -----------------------------------------------------------------------
-- TA holds ...-0001 and the shared-member fixture ...-0003; ...-0002 went with the member deleted
-- above, so it is free again. TAB (whose code starts with TA) gets ...-0001 to ...-0005, which must
-- not count as used at TA.
do $$
declare
  v       jsonb;
  v_year  text := extract(year from now())::integer::text;
  i       int;
  v_num   text;
begin
  insert into fitfine.branches (name, code) values ('Test Branch AB', 'TAB');
  for i in 1 .. 5 loop perform t.member('55500001' || lpad(i::text, 2, '0'), 'TAB', 'TAB member'); end loop;

  set local role service_role;
  v := fitfine.set_member_number_sequence(t.uid('admin'), t.branch('TA'), 1);
  reset role;
  perform t.logout();
  perform t.eq('set_member_number_sequence walks past numbers already used at the branch',
    v, jsonb_build_object('next_sequence', 2, 'requested', 1, 'adjusted', true));

  set local role service_role;
  v := fitfine.set_member_number_sequence(t.uid('admin'), t.branch('TA'), 5);
  reset role;
  perform t.logout();
  perform t.eq('set_member_number_sequence ignores another branch whose code starts the same (TAB)',
    v, jsonb_build_object('next_sequence', 5, 'requested', 5, 'adjusted', false));
  perform t.eq('the counter is primed so the next registration lands on the value applied',
    (select last_sequence from fitfine.member_number_sequences where branch_id = t.branch('TA')), 4);
  i := t.member('5550000066', 'TA');
  v_num := (select member_number from fitfine.members where id = i);
  perform t.eq('the next member registered at TA gets that number', v_num, 'TA-' || v_year || '-0005');

  -- A number held by a member is used; once that member is deleted the number is free again, and
  -- only an explicit admin setting can hand it out (the counter itself never goes backwards).
  set local role service_role;
  v := fitfine.set_member_number_sequence(t.uid('admin'), t.branch('TA'), 5);
  reset role;
  perform t.logout();
  perform t.eq('set_member_number_sequence skips a number a member holds', v ->> 'next_sequence', '6');
  delete from fitfine.members where member_number = 'TA-' || v_year || '-0005';
  set local role service_role;
  v := fitfine.set_member_number_sequence(t.uid('admin'), t.branch('TA'), 5);
  reset role;
  perform t.logout();
  perform t.eq('set_member_number_sequence can hand out a deleted member''s number again', v ->> 'next_sequence', '5');
end $$;
select t.raises('set_member_number_sequence refuses 0', 'service_role', null,
  format('select fitfine.set_member_number_sequence(%L, %s, 0)', t.uid('admin'), t.branch('TA')), 'PT400');
select t.raises('set_member_number_sequence refuses an unknown branch', 'service_role', null,
  format('select fitfine.set_member_number_sequence(%L, -1, 1)', t.uid('admin')), 'PT400', '%active branch%');
select t.raises('set_member_number_sequence refuses a staff caller', 'service_role', null,
  format('select fitfine.set_member_number_sequence(%L, %s, 9)', t.uid('staff'), t.branch('TA')), 'PT403');

-- create_subscription_with_items --------------------------------------------------------------------
create function t.items(p_member bigint, p_plan bigint, p_shared bigint default null, p_end date default current_date + 29)
returns text language sql stable as $$
  select jsonb_build_array(jsonb_build_object(
    'plan_id', p_plan, 'member_id', p_member, 'shared_member_id', p_shared,
    'start_date', current_date, 'end_date', p_end, 'quantity', 1, 'amount_paid', 1000))::text
$$;

do $$
declare
  m1      bigint := t.m('5550000001');
  v_gone  bigint := t.member('5550000011', 'TA', 'Gone');
  v_other bigint := t.member('5550000012', 'TA', 'Other');
begin
  delete from fitfine.members where id = v_gone;
  perform t.raises('create_subscription_with_items rejects an unknown header member', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), v_gone, 'Cash',
           t.items(v_gone, t.plan('T Monthly'))), 'PT404', 'Member % not found');
  perform t.raises('create_subscription_with_items rejects an unknown shared member', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), m1, 'Cash',
           t.items(m1, t.plan('T Couple'), v_gone)), 'PT404', 'Member % not found');
  perform t.raises('create_subscription_with_items rejects an item for another member', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), m1, 'Cash',
           t.items(v_other, t.plan('T Monthly'))), 'PT400', 'Every item must be for the subscription%');
  perform t.raises('create_subscription_with_items rejects an unknown plan', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), m1, 'Cash',
           t.items(m1, -1)), 'PT400', 'Plan % does not exist or is not active');
  perform t.raises('create_subscription_with_items rejects no items', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), m1, 'Cash', '[]'),
    'PT400', 'At least one item is required');
  perform t.raises('create_subscription_with_items refuses an inactive caller', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('inactive'), m1, 'Cash',
           t.items(m1, t.plan('T Monthly'))), 'PT403');

  -- A couple plan with a partner, then an indefinite add-on, then the same add-on again.
  perform t.as_service(format('select fitfine.create_subscription_with_items(%L, %s, %L, %L, %L)', t.uid('staff'), m1, 'UPI',
           'Paid', t.items(m1, t.plan('T Couple'), v_other)));
  perform t.ok('create_subscription_with_items writes the header and items, attributed',
    exists (select 1 from fitfine.subscriptions s join fitfine.subscription_items si on si.subscription_id = s.id
            where s.member_id = m1 and s.payment_mode = 'UPI' and si.shared_member_id = v_other
              and s.created_by = t.uid('staff') and si.created_by = t.uid('staff')));
  insert into fitfine.plans (name, category, duration_days, price) values ('T Forever', 'addon', null, 50);
  perform t.as_service(format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), m1, 'Cash',
           t.items(m1, t.plan('T Forever'), null, null)));
  perform t.raises('create_subscription_with_items refuses a second indefinite item for the same plan', 'service_role', null,
    format('select fitfine.create_subscription_with_items(%L, %s, %L, null, %L)', t.uid('staff'), m1, 'Cash',
           t.items(m1, t.plan('T Forever'), null, null)), 'PT409', '%already has an active indefinite item%');
end $$;

-- update_subscription_header -----------------------------------------------------------------------
do $$
declare v_sub bigint := (select min(id) from fitfine.subscriptions where member_id = t.m('5550000001'));
begin
  perform t.as_service(format('select fitfine.update_subscription_header(%L, %s, %L, %L, true)', t.uid('staff'), v_sub, 'Card', 'New note'));
  perform t.ok('update_subscription_header updates the header, attributed',
    exists (select 1 from fitfine.subscriptions where id = v_sub and payment_mode = 'Card' and notes = 'New note' and changed_by = t.uid('staff')));
  perform t.as_service(format('select fitfine.update_subscription_header(%L, %s, null, null, false)', t.uid('staff'), v_sub));
  perform t.eq('update_subscription_header leaves notes alone when they are not provided',
    (select notes from fitfine.subscriptions where id = v_sub), 'New note');
end $$;
select t.raises('update_subscription_header: a missing subscription is not found', 'service_role', null,
  format('select fitfine.update_subscription_header(%L, -1, null, null, false)', t.uid('staff')), 'PT404', 'Subscription % not found');

-- The profile functions and the last-admin rule ----------------------------------------------------
-- Fixtures: three active admins (admin, admin2, admin3), plus any real ones on a scratch project.
create table t.other_admins as
  select p.id from fitfine.profiles p
  where (fitfine_private.access_of(p.id)).is_admin and p.id not in (t.uid('admin'), t.uid('admin2'), t.uid('admin3'));
do $$
begin
  perform t.as_service(format('select fitfine.update_profile_fields(%L, %L, %L, false)', t.uid('admin'), t.uid('admin2'), 'Admin Two'));
  perform t.ok('update_profile_fields renames and deactivates, attributed',
    exists (select 1 from fitfine.profiles where id = t.uid('admin2') and full_name = 'Admin Two' and not is_active and changed_by = t.uid('admin')));
  -- Now admin3 and admin (and any real admin) are the active admins. Leave admin alone.
  update fitfine.profiles set is_active = false where id = t.uid('admin3') or id in (select id from t.other_admins);
  perform t.raises('update_profile_fields refuses to deactivate the last active admin', 'service_role', null,
    format('select fitfine.update_profile_fields(%L, %L, null, false)', t.uid('admin'), t.uid('admin')), 'PT409',
    'Cannot deactivate — this is the last active admin.');
  perform t.raises('replace_user_roles refuses to remove the last active admin''s admin role', 'service_role', null,
    format('select fitfine.replace_user_roles(%L, %L, %L)', t.uid('admin'), t.uid('admin'), array[t.role_id('staff')]), 'PT409',
    'Cannot remove — this is the last active admin.');
  perform t.runs('deactivating a non-admin is fine with one admin left', 'service_role', null,
    format('select fitfine.update_profile_fields(%L, %L, null, false)', t.uid('admin'), t.uid('staff2')));
  update fitfine.profiles set is_active = true
  where id in (t.uid('admin3'), t.uid('admin2')) or id in (select id from t.other_admins);
end $$;
select t.raises('the profile functions refuse a non-admin caller', 'service_role', null,
  format('select fitfine.update_profile_fields(%L, %L, %L, null)', t.uid('staff'), t.uid('staff2'), 'X'), 'PT403');

-- replace_user_roles --------------------------------------------------------------------------------
select t.raises('replace_user_roles refuses an unknown role', 'service_role', null,
  format('select fitfine.replace_user_roles(%L, %L, %L)', t.uid('admin'), t.uid('staff'), '{32000}'), 'PT400', 'One or more roles%');
select t.raises('replace_user_roles refuses no roles', 'service_role', null,
  format('select fitfine.replace_user_roles(%L, %L, %L)', t.uid('admin'), t.uid('staff'), '{}'), 'PT400', 'At least one role is required');
do $$
declare v jsonb;
begin
  set local role service_role;
  v := fitfine.replace_user_roles(t.uid('admin'), t.uid('staff'), array[t.role_id('admin'), t.role_id('staff')]);
  reset role;
  perform t.logout();
  perform t.eq('replace_user_roles returns the new role names', v, '["admin", "staff"]'::jsonb);
  perform t.ok('replace_user_roles records the caller as granted_by and in the audit log',
    (select bool_and(granted_by = t.uid('admin')) from fitfine.user_roles where user_id = t.uid('staff'))
    and exists (select 1 from fitfine.audit_log where table_name = 'user_roles' and operation = 'delete' and changed_by = t.uid('admin')));
end $$;

-- update_member_number_config (client RPC) -----------------------------------------------------------
select t.raises('update_member_number_config refuses 0', 'authenticated', t.uid('admin'),
  'select fitfine.update_member_number_config(0, 1, 4)', 'PT400');
select t.raises('update_member_number_config refuses NULL', 'authenticated', t.uid('admin'),
  'select fitfine.update_member_number_config(1, null, 4)', 'PT400');
select t.raises('update_member_number_config refuses an inactive admin', 'authenticated', t.uid('inactive'),
  'select fitfine.update_member_number_config(1, 1, 4)', 'PT403');
do $$
begin
  perform t.login('admin');
  perform fitfine.update_member_number_config(100, 5, 6);
  perform t.logout();
  perform t.eq('update_member_number_config updates the three keys for an admin',
    (select string_agg(key || '=' || value, ',' order by key) from fitfine.configuration
     where key in ('member_number_start_sequence', 'member_number_increment', 'member_number_padding_width')),
    'member_number_increment=5,member_number_padding_width=6,member_number_start_sequence=100');
end $$;

rollback;
