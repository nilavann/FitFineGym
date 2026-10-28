-- Trigger functions. The six functions move from fitfine (exposed, search_path = fitfine) to
-- fitfine_private (never exposed, search_path = '', every name schema-qualified). Same behaviour
-- as the fitfine copies, except handle_new_auth_user, which is now invite-only. Then each of the
-- 26 triggers is recreated with the same name, timing and events on the new function, and the
-- fitfine copies are dropped.
-- One migration, one transaction: no write ever finds a table without its triggers.
--
-- Triggers need no EXECUTE grant, so every function here is revoked from everyone.

create function fitfine_private.set_audit_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.now();
    new.created_by := auth.uid();
    new.changed_at := null;
    new.changed_by := null;
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.changed_at := pg_catalog.now();
    new.changed_by := auth.uid();
  end if;
  return new;
end;
$$;

create function fitfine_private.generate_member_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_code text;
  v_year        integer := extract(year from pg_catalog.now())::integer;
  v_start       integer;
  v_increment   integer;
  v_width       integer;
  v_sequence    integer;
begin
  if tg_op = 'UPDATE' then
    new.member_number := old.member_number;
    new.branch_id      := old.branch_id;
    return new;
  end if;

  select b.code into v_branch_code from fitfine.branches b where b.id = new.branch_id and b.deleted_at is null;
  if v_branch_code is null then
    raise exception 'branch_id % does not reference an active branch', new.branch_id;
  end if;

  select c.value::integer into v_start     from fitfine.configuration c where c.key = 'member_number_start_sequence';
  select c.value::integer into v_increment from fitfine.configuration c where c.key = 'member_number_increment';
  select c.value::integer into v_width     from fitfine.configuration c where c.key = 'member_number_padding_width';

  insert into fitfine.member_number_sequences as s (branch_id, last_sequence)
  values (new.branch_id, v_start)
  on conflict (branch_id)
  do update set last_sequence = s.last_sequence + v_increment
  returning s.last_sequence into v_sequence;

  new.member_number := v_branch_code || '-' || v_year || '-' || pg_catalog.lpad(v_sequence::text, v_width, '0');
  return new;
end;
$$;

create function fitfine_private.audit_row_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change_id uuid := pg_catalog.gen_random_uuid();
  v_old       jsonb;
  v_new       jsonb;
  v_record_id text;
  v_key       text;
  v_excluded  text[] := array['created_at', 'created_by', 'changed_at', 'changed_by'];
begin
  if tg_op = 'INSERT' then
    v_new := pg_catalog.to_jsonb(new);
    v_record_id := coalesce(v_new ->> 'id', (v_new ->> 'user_id') || ':' || (v_new ->> 'role_id'));
    for v_key in select pg_catalog.jsonb_object_keys(v_new) loop
      if v_key <> all (v_excluded) then
        insert into fitfine.audit_log (change_id, table_name, record_id, field_name, old_value, new_value, operation, changed_by, changed_at)
        values (v_change_id, tg_table_name, v_record_id, v_key, null, v_new ->> v_key, 'insert', auth.uid(), pg_catalog.now());
      end if;
    end loop;
    return new;

  elsif tg_op = 'UPDATE' then
    v_old := pg_catalog.to_jsonb(old);
    v_new := pg_catalog.to_jsonb(new);
    v_record_id := coalesce(v_new ->> 'id', (v_new ->> 'user_id') || ':' || (v_new ->> 'role_id'));
    for v_key in select pg_catalog.jsonb_object_keys(v_new) loop
      if v_key <> all (v_excluded) and (v_old ->> v_key) is distinct from (v_new ->> v_key) then
        insert into fitfine.audit_log (change_id, table_name, record_id, field_name, old_value, new_value, operation, changed_by, changed_at)
        values (v_change_id, tg_table_name, v_record_id, v_key, v_old ->> v_key, v_new ->> v_key, 'update', auth.uid(), pg_catalog.now());
      end if;
    end loop;
    return new;

  elsif tg_op = 'DELETE' then
    -- Reachable only for user_roles (the one table exempt from prevent_hard_delete).
    v_old := pg_catalog.to_jsonb(old);
    v_record_id := coalesce(v_old ->> 'id', (v_old ->> 'user_id') || ':' || (v_old ->> 'role_id'));
    for v_key in select pg_catalog.jsonb_object_keys(v_old) loop
      if v_key <> all (v_excluded) then
        insert into fitfine.audit_log (change_id, table_name, record_id, field_name, old_value, new_value, operation, changed_by, changed_at)
        values (v_change_id, tg_table_name, v_record_id, v_key, v_old ->> v_key, null, 'delete', auth.uid(), pg_catalog.now());
      end if;
    end loop;
    return old;
  end if;

  return null;
end;
$$;

-- Invoker: touches no table.
create function fitfine_private.prevent_hard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.current_setting('app.purge_member', true), '') = 'on'
     and tg_table_name in ('members', 'subscriptions', 'subscription_items', 'audit_log') then
    return old;
  end if;
  raise exception 'Hard delete is not allowed on table %. Soft-delete by setting deleted_at instead.', tg_table_name;
end;
$$;

-- Invoker: touches no table.
create function fitfine_private.protect_system_admin_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.name = 'system_admin' then
    raise exception 'The system_admin role is reserved and cannot be edited or deleted';
  end if;
  return new;
end;
$$;

-- Invite-only. GoTrue sets invited_at only for an invite from the admin API or
-- the dashboard, so an uninvited sign-up or Google sign-in gets no profile and RLS denies it
-- everything. Runs AFTER INSERT only: a signed-in user can rewrite their own
-- raw_user_meta_data at any time, so the metadata is trusted only here, when the invite creates
-- the row. No other function and no policy reads raw_user_meta_data.
--
-- For an invite: act as the inviter (when invited_by names an existing profile, otherwise as
-- nobody), create the active profile, then one user_roles row per role id that exists and isn't
-- deleted. A role id that isn't a positive integer is skipped like an unknown one, never cast
-- blindly. All of it runs in the auth.users insert's transaction: an invite yields a profile with
-- its roles, or fails as a whole. The transaction's own claims are restored afterwards, so the
-- inviter neither leaks into later statements nor is inherited by a later invite.
create function fitfine_private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta       jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_inviter    text  := v_meta ->> 'invited_by';
  v_invited_by uuid;
  v_full_name  text;
  v_prev_sub    text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_prev_claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  if new.invited_at is null then
    return new;
  end if;

  if v_inviter ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select p.id into v_invited_by from fitfine.profiles p where p.id = v_inviter::uuid;
  end if;
  if v_invited_by is not null then
    perform fitfine_private.act_as(v_invited_by);
  else
    perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
    perform pg_catalog.set_config('request.jwt.claims', '', true);
  end if;

  -- A dashboard invite carries no name: fall back to the email's local part, cut to the
  -- 80 characters chk_profiles_full_name_text allows.
  v_full_name := coalesce(
    nullif(pg_catalog.btrim(v_meta ->> 'full_name'), ''),
    nullif(pg_catalog.left(pg_catalog.split_part(new.email, '@', 1), 80), ''),
    'Invited user'
  );

  insert into fitfine.profiles (id, full_name, is_active)
  values (new.id, v_full_name, true)
  on conflict (id) do nothing;

  if pg_catalog.jsonb_typeof(v_meta -> 'role_ids') = 'array' then
    insert into fitfine.user_roles (user_id, role_id, granted_by)
    select new.id, r.id, v_invited_by
    from fitfine.roles r
    where r.deleted_at is null
      and r.id in (
        -- At most 5 digits, so the cast can't overflow; roles.id is a smallint.
        select e::integer
        from pg_catalog.jsonb_array_elements_text(v_meta -> 'role_ids') as e
        where e ~ '^[1-9][0-9]{0,4}$'
      )
    on conflict do nothing;
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
  return new;
end;
$$;

revoke all on function
  fitfine_private.set_audit_fields(),
  fitfine_private.generate_member_number(),
  fitfine_private.audit_row_changes(),
  fitfine_private.prevent_hard_delete(),
  fitfine_private.protect_system_admin_role(),
  fitfine_private.handle_new_auth_user()
from public, anon, authenticated, service_role;

-- The 26 triggers, same names, timing and events, now on fitfine_private.

drop trigger trg_handle_new_auth_user on auth.users;
create trigger trg_handle_new_auth_user after insert on auth.users
  for each row execute function fitfine_private.handle_new_auth_user();

drop trigger trg_audit_log_no_hard_delete on fitfine.audit_log;
create trigger trg_audit_log_no_hard_delete before delete on fitfine.audit_log
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_branches_audit on fitfine.branches;
create trigger trg_branches_audit before insert or update on fitfine.branches
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_branches_audit_fields on fitfine.branches;
create trigger trg_branches_audit_fields after insert or update on fitfine.branches
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_branches_no_hard_delete on fitfine.branches;
create trigger trg_branches_no_hard_delete before delete on fitfine.branches
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_members_audit on fitfine.members;
create trigger trg_members_audit before insert or update on fitfine.members
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_members_audit_fields on fitfine.members;
create trigger trg_members_audit_fields after insert or update on fitfine.members
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_members_generate_number on fitfine.members;
create trigger trg_members_generate_number before insert or update on fitfine.members
  for each row execute function fitfine_private.generate_member_number();
drop trigger trg_members_no_hard_delete on fitfine.members;
create trigger trg_members_no_hard_delete before delete on fitfine.members
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_plans_audit on fitfine.plans;
create trigger trg_plans_audit before insert or update on fitfine.plans
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_plans_audit_fields on fitfine.plans;
create trigger trg_plans_audit_fields after insert or update on fitfine.plans
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_plans_no_hard_delete on fitfine.plans;
create trigger trg_plans_no_hard_delete before delete on fitfine.plans
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_profiles_audit on fitfine.profiles;
create trigger trg_profiles_audit before insert or update on fitfine.profiles
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_profiles_audit_fields on fitfine.profiles;
create trigger trg_profiles_audit_fields after insert or update on fitfine.profiles
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_profiles_no_hard_delete on fitfine.profiles;
create trigger trg_profiles_no_hard_delete before delete on fitfine.profiles
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_roles_audit on fitfine.roles;
create trigger trg_roles_audit before insert or update on fitfine.roles
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_roles_audit_fields on fitfine.roles;
create trigger trg_roles_audit_fields after insert or update on fitfine.roles
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_roles_no_hard_delete on fitfine.roles;
create trigger trg_roles_no_hard_delete before delete on fitfine.roles
  for each row execute function fitfine_private.prevent_hard_delete();
drop trigger trg_roles_protect_system_admin on fitfine.roles;
create trigger trg_roles_protect_system_admin before update on fitfine.roles
  for each row execute function fitfine_private.protect_system_admin_role();

drop trigger trg_subscription_items_audit on fitfine.subscription_items;
create trigger trg_subscription_items_audit before insert or update on fitfine.subscription_items
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_subscription_items_audit_fields on fitfine.subscription_items;
create trigger trg_subscription_items_audit_fields after insert or update on fitfine.subscription_items
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_subscription_items_no_hard_delete on fitfine.subscription_items;
create trigger trg_subscription_items_no_hard_delete before delete on fitfine.subscription_items
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_subscriptions_audit on fitfine.subscriptions;
create trigger trg_subscriptions_audit before insert or update on fitfine.subscriptions
  for each row execute function fitfine_private.set_audit_fields();
drop trigger trg_subscriptions_audit_fields on fitfine.subscriptions;
create trigger trg_subscriptions_audit_fields after insert or update on fitfine.subscriptions
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_subscriptions_no_hard_delete on fitfine.subscriptions;
create trigger trg_subscriptions_no_hard_delete before delete on fitfine.subscriptions
  for each row execute function fitfine_private.prevent_hard_delete();

drop trigger trg_user_roles_audit_fields on fitfine.user_roles;
create trigger trg_user_roles_audit_fields after insert or delete on fitfine.user_roles
  for each row execute function fitfine_private.audit_row_changes();

-- Nothing points at the fitfine copies any more.
drop function fitfine.set_audit_fields();
drop function fitfine.generate_member_number();
drop function fitfine.audit_row_changes();
drop function fitfine.prevent_hard_delete();
drop function fitfine.protect_system_admin_role();
drop function fitfine.handle_new_auth_user();
