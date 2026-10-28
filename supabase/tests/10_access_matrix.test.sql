-- The access matrix: every role x object x operation,
-- each cell with an expected allow or deny.
--
-- How a cell is judged, from what the statement did (t.try):
--   select / update / delete  allow = ran and touched at least one row
--                             deny  = 42501 (no privilege) or no row (RLS filtered every row)
--   insert                    allow = ran;  deny = 42501 (no privilege, or the RLS check refused)
--   truncate                  allow = ran;  deny = 42501
--   execute                   allow = the function ran (a refusal it raises itself still counts:
--                                     the caller got in); deny = 42501
-- Any other error means the statement is wrong for the cell and is reported as not ok.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

create table t.cells (obj text, op text, sql text, allow text[]);

do $$
declare
  ta    bigint := t.branch('TA');
  tab   bigint := t.branch('TAB');
  m1    bigint := (select id from fitfine.members where phone = '5550000001');
  s1    bigint := (select id from fitfine.subscriptions where member_id = m1);
  i1    bigint := (select id from fitfine.subscription_items where subscription_id = s1);
  staff_role smallint := t.role_id('staff');
  locker bigint := t.plan('T Locker');
  -- role groups
  active  text[] := array['staff', 'admin', 'admin3'];
  admins  text[] := array['admin', 'admin3'];
  signed  text[] := array['nop', 'inactive', 'norole', 'staff', 'admin', 'admin3'];
begin
  insert into t.cells values
  -- profiles: a deactivated user, or one without a role, still reads their own row
  ('profiles', 'select', 'select 1 from fitfine.profiles', array['inactive', 'norole', 'service_role'] || active),
  ('profiles', 'insert', format('insert into fitfine.profiles (id, full_name) values (%L, %L)', t.uid('nop'), 'New'), array['service_role']),
  ('profiles', 'update (full_name), another user', format('update fitfine.profiles set full_name = %L where id = %L', 'Renamed', t.uid('staff2')), array['service_role'] || admins),
  ('profiles', 'delete', format('delete from fitfine.profiles where id = %L', t.uid('staff2')), array[]::text[]),
  ('profiles', 'truncate', 'truncate fitfine.profiles', array[]::text[]),

  ('branches', 'select', 'select 1 from fitfine.branches', array['service_role'] || active),
  ('branches', 'insert', 'insert into fitfine.branches (name, code) values (''New'', ''TNEW'')', array['service_role'] || admins),
  ('branches', 'update (name)', format('update fitfine.branches set name = %L where id = %s', 'Renamed', ta), array['service_role'] || admins),
  ('branches', 'delete', format('delete from fitfine.branches where id = %s', tab), array[]::text[]),
  ('branches', 'truncate', 'truncate fitfine.branches', array[]::text[]),

  ('plans', 'select', 'select 1 from fitfine.plans', array['service_role'] || active),
  ('plans', 'insert', 'insert into fitfine.plans (name, category, duration_days, price) values (''T New'', ''addon'', 30, 10)', array['service_role'] || admins),
  ('plans', 'update (price)', format('update fitfine.plans set price = 1 where id = %s', locker), array['service_role'] || admins),
  ('plans', 'delete', format('delete from fitfine.plans where id = %s', locker), array[]::text[]),
  ('plans', 'truncate', 'truncate fitfine.plans', array[]::text[]),

  ('roles', 'select', 'select 1 from fitfine.roles', array['service_role'] || active),
  ('roles', 'insert', 'insert into fitfine.roles (name) values (''t_new_role'')', array['service_role'] || admins),
  ('roles', 'update (description)', format('update fitfine.roles set description = %L where id = %s', 'x', staff_role), array['service_role'] || admins),
  ('roles', 'delete', format('delete from fitfine.roles where id = %s', staff_role), array[]::text[]),
  ('roles', 'truncate', 'truncate fitfine.roles', array[]::text[]),

  ('user_roles', 'select', 'select 1 from fitfine.user_roles', array['service_role'] || active),
  ('user_roles', 'insert', format('insert into fitfine.user_roles (user_id, role_id) values (%L, %s)', t.uid('norole'), staff_role), array['service_role']),
  ('user_roles', 'update', format('update fitfine.user_roles set granted_at = now() where user_id = %L', t.uid('staff')), array['service_role']),
  ('user_roles', 'delete', format('delete from fitfine.user_roles where user_id = %L', t.uid('staff')), array[]::text[]),
  ('user_roles', 'truncate', 'truncate fitfine.user_roles', array[]::text[]),

  ('members', 'select', 'select 1 from fitfine.members', array['service_role'] || active),
  ('members', 'insert', format($q$insert into fitfine.members (name, phone, date_of_birth, gender, weight_kg, height_cm,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, branch_id)
      values ('New Member', '5550000099', '1990-01-01', 'Female', 60, 160, 'C', '9999999999', 'Friend', %s)$q$, ta),
    array['service_role'] || active),
  ('members', 'update (name)', format('update fitfine.members set name = %L where id = %s', 'Renamed', m1), array['service_role'] || active),
  ('members', 'update (branch_id)', format('update fitfine.members set branch_id = %s where id = %s', tab, m1), array['service_role']),
  ('members', 'update (member_number)', format('update fitfine.members set member_number = %L where id = %s', 'X-1', m1), array['service_role']),
  ('members', 'delete', format('delete from fitfine.members where id = %s', m1), array[]::text[]),
  ('members', 'truncate', 'truncate fitfine.members', array[]::text[]),

  ('subscriptions', 'select', 'select 1 from fitfine.subscriptions', array['service_role'] || active),
  ('subscriptions', 'insert', format('insert into fitfine.subscriptions (member_id, payment_mode) values (%s, %L)', m1, 'Cash'), array['service_role']),
  ('subscriptions', 'update (notes)', format('update fitfine.subscriptions set notes = %L where id = %s', 'x', s1), array['service_role']),
  ('subscriptions', 'delete', format('delete from fitfine.subscriptions where id = %s', s1), array[]::text[]),
  ('subscriptions', 'truncate', 'truncate fitfine.subscriptions', array[]::text[]),

  ('subscription_items', 'select', 'select 1 from fitfine.subscription_items', array['service_role'] || active),
  ('subscription_items', 'insert', format($q$insert into fitfine.subscription_items
      (subscription_id, plan_id, member_id, start_date, end_date, quantity, amount_paid)
      values (%s, %s, %s, current_date, null, 1, 0)$q$, s1, locker, m1), array['service_role']),
  ('subscription_items', 'update (amount_paid)', format('update fitfine.subscription_items set amount_paid = 1 where id = %s', i1), array['service_role']),
  ('subscription_items', 'delete', format('delete from fitfine.subscription_items where id = %s', i1), array[]::text[]),
  ('subscription_items', 'truncate', 'truncate fitfine.subscription_items', array[]::text[]),

  ('configuration', 'select', 'select 1 from fitfine.configuration', array['service_role'] || admins),
  ('configuration', 'insert', 'insert into fitfine.configuration (key, value) values (''t_key'', ''v'')', array['service_role']),
  ('configuration', 'update (value)', 'update fitfine.configuration set value = ''2'' where key = ''member_number_increment''', array['service_role']),
  ('configuration', 'delete', 'delete from fitfine.configuration where key = ''member_number_increment''', array[]::text[]),
  ('configuration', 'truncate', 'truncate fitfine.configuration', array[]::text[]),

  ('member_number_sequences', 'select', 'select 1 from fitfine.member_number_sequences', array['service_role'] || admins),
  ('member_number_sequences', 'insert', format('insert into fitfine.member_number_sequences (branch_id, last_sequence) values (%s, 5)', tab), array['service_role']),
  ('member_number_sequences', 'update', format('update fitfine.member_number_sequences set last_sequence = 9 where branch_id = %s', ta), array['service_role']),
  ('member_number_sequences', 'delete', format('delete from fitfine.member_number_sequences where branch_id = %s', ta), array[]::text[]),
  ('member_number_sequences', 'truncate', 'truncate fitfine.member_number_sequences', array[]::text[]),

  ('audit_log', 'select', 'select 1 from fitfine.audit_log', array['service_role'] || admins),
  ('audit_log', 'insert', 'insert into fitfine.audit_log (change_id, table_name, record_id, field_name, operation) values (gen_random_uuid(), ''x'', ''1'', ''f'', ''insert'')', array['service_role']),
  ('audit_log', 'update', 'update fitfine.audit_log set field_name = field_name', array['service_role']),
  ('audit_log', 'delete', 'delete from fitfine.audit_log', array[]::text[]),
  ('audit_log', 'truncate', 'truncate fitfine.audit_log', array[]::text[]),

  -- views: security_invoker, so they follow the caller's RLS. None is updatable, and only
  -- SELECT is granted on them.
  ('member_list_view', 'select', 'select 1 from fitfine.member_list_view', array['service_role'] || active),
  ('member_current_items', 'select', 'select 1 from fitfine.member_current_items', array['service_role'] || active),
  ('profiles_with_roles', 'select', 'select 1 from fitfine.profiles_with_roles', array['inactive', 'norole', 'service_role'] || active),

  -- the client RPC: every signed-in user may call it; it refuses non-admins itself
  ('update_member_number_config', 'execute', 'select fitfine.update_member_number_config(1, 1, 4)', signed),

  -- Edge Function RPCs: service_role only
  ('user_access', 'execute', format('select fitfine.user_access(%L)', t.uid('staff')), array['service_role']),
  ('create_subscription_with_items', 'execute', format('select fitfine.create_subscription_with_items(%L, -1, %L, null, %L)', t.uid('staff'), 'Cash', '[]'), array['service_role']),
  ('update_subscription_header', 'execute', format('select fitfine.update_subscription_header(%L, -1, null, null, false)', t.uid('staff')), array['service_role']),
  ('update_profile_fields', 'execute', format('select fitfine.update_profile_fields(%L, %L, null, null)', t.uid('admin'), t.uid('staff2')), array['service_role']),
  ('replace_user_roles', 'execute', format('select fitfine.replace_user_roles(%L, %L, %L)', t.uid('admin'), t.uid('nop'), '{}'), array['service_role']),
  ('delete_member', 'execute', format('select fitfine.delete_member(%L, -1)', t.uid('staff')), array['service_role']),
  ('delete_subscription', 'execute', format('select fitfine.delete_subscription(%L, -1)', t.uid('staff')), array['service_role']),
  ('delete_plan', 'execute', format('select fitfine.delete_plan(%L, -1)', t.uid('admin')), array['service_role']),
  ('delete_branch', 'execute', format('select fitfine.delete_branch(%L, -1)', t.uid('admin')), array['service_role']),
  ('delete_role', 'execute', format('select fitfine.delete_role(%L, -1)', t.uid('admin')), array['service_role']),
  ('set_member_number_sequence', 'execute', format('select fitfine.set_member_number_sequence(%L, -1, 1)', t.uid('admin')), array['service_role']),

  -- fitfine_private: the two RLS helpers for signed-in users, nothing else for anyone
  ('fitfine_private.is_active_user', 'execute', 'select fitfine_private.is_active_user()', signed),
  ('fitfine_private.is_active_admin', 'execute', 'select fitfine_private.is_active_admin()', signed),
  ('fitfine_private.access_of', 'execute', format('select fitfine_private.access_of(%L)', t.uid('staff')), array[]::text[]),
  ('fitfine_private.act_as', 'execute', format('select fitfine_private.act_as(%L)', t.uid('admin')), array[]::text[]),
  ('fitfine_private.other_active_admins', 'execute', format('select fitfine_private.other_active_admins(%L)', t.uid('admin')), array[]::text[]),
  ('fitfine_private.lock_active_profiles', 'execute', 'select fitfine_private.lock_active_profiles()', array[]::text[]),
  ('fitfine_private.set_audit_fields', 'execute', 'select fitfine_private.set_audit_fields()', array[]::text[]),
  ('fitfine_private.generate_member_number', 'execute', 'select fitfine_private.generate_member_number()', array[]::text[]),
  ('fitfine_private.audit_row_changes', 'execute', 'select fitfine_private.audit_row_changes()', array[]::text[]),
  ('fitfine_private.prevent_hard_delete', 'execute', 'select fitfine_private.prevent_hard_delete()', array[]::text[]),
  ('fitfine_private.handle_new_auth_user', 'execute', 'select fitfine_private.handle_new_auth_user()', array[]::text[]);
end $$;

-- allow / deny / unexpected, from an outcome of t.try.
create function t.verdict(p_op text, p_outcome text) returns text language sql immutable as $$
  select case
    when p_outcome like 'err:42501:%' then 'deny'
    when p_outcome like 'rows:%' then
      case when p_op in ('insert', 'truncate', 'execute') or split_part(p_outcome, ':', 2)::bigint > 0
           then 'allow' else 'deny' end
    when p_op = 'execute' then 'allow'
    else 'unexpected'
  end
$$;

do $$
declare
  r       record;
  c       record;
  v_role  text;
  v_uid   uuid;
  v_out   text;
  v_got   text;
  v_want  text;
  v_cells integer;
  v_bad   integer;
begin
  for r in select * from unnest(array['anon', 'nop', 'inactive', 'norole', 'staff', 'admin', 'admin3', 'service_role']) as who
  loop
    v_cells := 0; v_bad := 0;
    v_role := case when r.who in ('anon', 'service_role') then r.who else 'authenticated' end;
    v_uid  := case when r.who in ('anon', 'service_role') then null else t.uid(r.who) end;
    for c in select * from t.cells order by obj, op loop
      v_out  := t.try(v_role, v_uid, c.sql);
      v_got  := t.verdict(split_part(c.op, ' ', 1), v_out);
      v_want := case when r.who = any (c.allow) then 'allow' else 'deny' end;
      v_cells := v_cells + 1;
      if v_got <> v_want then
        v_bad := v_bad + 1;
        raise notice 'not ok - matrix % / % / %: expected %, got % (%)', r.who, c.obj, c.op, v_want, v_got, v_out;
      end if;
    end loop;
    if v_bad = 0 then
      raise notice 'ok - matrix %: % cells', r.who, v_cells;
    end if;
  end loop;
end $$;

rollback;
