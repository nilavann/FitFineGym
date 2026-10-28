-- API functions. act_as(p_caller_id) makes the writes that follow attributable to the caller and
-- access_of is the only access rule. All SECURITY DEFINER with search_path = '', every name
-- schema-qualified, no dynamic SQL.
--
-- Two audiences:
--   client RPC (authenticated): update_member_number_config, caller from auth.uid()
--   Edge Function RPCs (service_role only): everything else. Each starts with
--     act_as(p_caller_id), so created_by / changed_by / audit_log name the caller, and re-checks
--     the caller's access with access_of: the Edge Function checked it already, this is the
--     backstop.
--
-- Every refusal raises a named error with a PostgREST status code as its SQLSTATE: PT400, PT403,
-- PT404, PT409. PostgREST answers a client RPC with that HTTP status, and the Edge Functions map
-- the code to theirs. Any other error is unexpected and becomes a generic 500 there.

-- Active admins other than p_user_id, by the access_of rule.
create function fitfine_private.other_active_admins(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from fitfine.profiles p
  where p.id is distinct from p_user_id
    and p.is_active and p.deleted_at is null
    and (fitfine_private.access_of(p.id)).is_admin
$$;

-- Locks every active profile, so two concurrent "remove an admin" changes can't each see the
-- other as the remaining admin. Called before a last-admin check, in the same transaction.
create function fitfine_private.lock_active_profiles()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from fitfine.profiles p where p.is_active and p.deleted_at is null for update;
end;
$$;

revoke all on function fitfine_private.other_active_admins(uuid) from public, anon, authenticated, service_role;
revoke all on function fitfine_private.lock_active_profiles()    from public, anon, authenticated, service_role;

-- Client RPC ----------------------------------------------------------------------------------

-- Raises for a non-admin rather than updating 0 rows and reporting success.
-- configuration has no UPDATE grant or policy: this is its only writer.
create function fitfine.update_member_number_config(p_start_sequence integer, p_increment integer, p_padding_width integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce((fitfine_private.access_of(auth.uid())).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;
  if p_start_sequence is null or p_start_sequence < 1
     or p_increment is null or p_increment < 1
     or p_padding_width is null or p_padding_width < 1 then
    raise exception 'Start sequence, increment and padding width must be positive integers' using errcode = 'PT400';
  end if;

  update fitfine.configuration set value = p_start_sequence::text where key = 'member_number_start_sequence';
  update fitfine.configuration set value = p_increment::text      where key = 'member_number_increment';
  update fitfine.configuration set value = p_padding_width::text  where key = 'member_number_padding_width';
end;
$$;

-- Edge Function RPCs --------------------------------------------------------------------------

-- The one call requireCaller makes (_shared/auth.ts).
create function fitfine.user_access(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'is_active',           coalesce(a.is_active, false),
    'is_admin',            coalesce(a.is_admin, false),
    'is_system_admin',     coalesce(a.is_system_admin, false),
    'other_active_admins', fitfine_private.other_active_admins(p_user_id)
  )
  from fitfine_private.access_of(p_user_id) a
$$;

-- One checkout: the header and its items in one transaction. end_date comes from the items, as
-- the create-subscription Edge Function computed it. The header member and every
-- shared member exist and aren't soft-deleted, every item is for the header's member, every plan
-- is active. The members and plans are locked FOR SHARE, so a concurrent soft delete either
-- waits for this checkout (and then sees its items) or wins (and this checkout finds no member).
create function fitfine.create_subscription_with_items(
  p_caller_id uuid, p_member_id bigint, p_payment_mode text, p_notes text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription           fitfine.subscriptions;
  v_item                   jsonb;
  v_inserted_item          fitfine.subscription_items;
  v_items                  jsonb := '[]'::jsonb;
  v_plan                   fitfine.plans;
  v_item_member_id         bigint;
  v_item_shared_member_id  bigint;
  v_conflict_exists        boolean;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Account is not active' using errcode = 'PT403';
  end if;

  if pg_catalog.jsonb_typeof(p_items) is distinct from 'array' or pg_catalog.jsonb_array_length(p_items) = 0 then
    raise exception 'At least one item is required' using errcode = 'PT400';
  end if;

  perform 1 from fitfine.members m where m.id = p_member_id and m.deleted_at is null for share;
  if not found then
    raise exception 'Member % not found', p_member_id using errcode = 'PT404';
  end if;

  insert into fitfine.subscriptions (member_id, payment_mode, notes)
  values (p_member_id, p_payment_mode, p_notes)
  returning * into v_subscription;

  for v_item in select * from pg_catalog.jsonb_array_elements(p_items)
  loop
    v_item_member_id := (v_item ->> 'member_id')::bigint;
    v_item_shared_member_id := nullif(v_item ->> 'shared_member_id', '')::bigint;

    if v_item_member_id is distinct from p_member_id then
      raise exception 'Every item must be for the subscription''s member (a partner goes in shared_member_id)'
        using errcode = 'PT400';
    end if;
    if v_item_shared_member_id is not null then
      perform 1 from fitfine.members m where m.id = v_item_shared_member_id and m.deleted_at is null for share;
      if not found then
        raise exception 'Member % not found', v_item_shared_member_id using errcode = 'PT404';
      end if;
    end if;

    select * into v_plan from fitfine.plans p
    where p.id = (v_item ->> 'plan_id')::bigint and p.deleted_at is null
    for share;
    if not found then
      raise exception 'Plan % does not exist or is not active', v_item ->> 'plan_id' using errcode = 'PT400';
    end if;

    -- REQ-SUB-007 hard block: an indefinite plan can't be attached twice to the same member (or
    -- shared member). Checked in the transaction that also inserts, so a concurrent request for
    -- the same member and plan can't slip past it.
    if v_plan.duration_days is null then
      select exists (
        select 1 from fitfine.subscription_items si
        where si.plan_id = v_plan.id
          and si.deleted_at is null
          and (
            si.member_id in (v_item_member_id, coalesce(v_item_shared_member_id, v_item_member_id))
            or si.shared_member_id in (v_item_member_id, coalesce(v_item_shared_member_id, v_item_member_id))
          )
      ) into v_conflict_exists;

      if v_conflict_exists then
        raise exception 'This member already has an active indefinite item for plan "%" — it cannot be attached again', v_plan.name
          using errcode = 'PT409';
      end if;
    end if;

    insert into fitfine.subscription_items (
      subscription_id, plan_id, member_id, shared_member_id,
      start_date, end_date, quantity, amount_paid
    )
    values (
      v_subscription.id,
      v_plan.id,
      v_item_member_id,
      v_item_shared_member_id,
      (v_item ->> 'start_date')::date,
      nullif(v_item ->> 'end_date', '')::date,
      (v_item ->> 'quantity')::integer,
      (v_item ->> 'amount_paid')::numeric
    )
    returning * into v_inserted_item;

    v_items := v_items || pg_catalog.to_jsonb(v_inserted_item);
  end loop;

  return pg_catalog.jsonb_build_object('subscription', pg_catalog.to_jsonb(v_subscription), 'items', v_items);
end;
$$;

-- Header fields only: items are immutable after creation.
create function fitfine.update_subscription_header(
  p_caller_id uuid, p_subscription_id bigint, p_payment_mode text, p_notes text, p_notes_provided boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription fitfine.subscriptions;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Account is not active' using errcode = 'PT403';
  end if;

  update fitfine.subscriptions s
  set payment_mode = coalesce(p_payment_mode, s.payment_mode),
      notes        = case when p_notes_provided then p_notes else s.notes end
  where s.id = p_subscription_id
    and s.deleted_at is null
  returning * into v_subscription;

  if v_subscription.id is null then
    raise exception 'Subscription % not found', p_subscription_id using errcode = 'PT404';
  end if;

  return pg_catalog.to_jsonb(v_subscription);
end;
$$;

-- Edits full_name and/or is_active (NULL leaves a field as it is). Deactivating
-- the last active admin is refused inside this transaction, with the active profiles locked.
create function fitfine.update_profile_fields(
  p_caller_id uuid, p_target_user_id uuid, p_full_name text, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  if p_is_active is false then
    perform fitfine_private.lock_active_profiles();
    if (fitfine_private.access_of(p_target_user_id)).is_admin
       and fitfine_private.other_active_admins(p_target_user_id) = 0 then
      raise exception 'Cannot deactivate — this is the last active admin.' using errcode = 'PT409';
    end if;
  end if;

  update fitfine.profiles p
  set full_name = coalesce(p_full_name, p.full_name),
      is_active = coalesce(p_is_active, p.is_active)
  where p.id = p_target_user_id and p.deleted_at is null;
end;
$$;

-- Deleting the last active admin is refused inside this transaction.
create function fitfine.soft_delete_profile(p_caller_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  perform fitfine_private.lock_active_profiles();
  if (fitfine_private.access_of(p_target_user_id)).is_admin
     and fitfine_private.other_active_admins(p_target_user_id) = 0 then
    raise exception 'Cannot delete — this is the last active admin.' using errcode = 'PT409';
  end if;

  update fitfine.profiles p
  set deleted_at = pg_catalog.now(), deleted_by = p_caller_id
  where p.id = p_target_user_id and p.deleted_at is null;
end;
$$;

create function fitfine.restore_profile(p_caller_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  update fitfine.profiles p
  set deleted_at = null, deleted_by = null
  where p.id = p_target_user_id and p.deleted_at is not null;
end;
$$;

-- Replaces a user's roles. Only a system admin may grant or remove system_admin, which is only
-- ever held together with admin; removing the last active admin's admin role is refused.
create function fitfine.replace_user_roles(p_caller_id uuid, p_target_user_id uuid, p_role_ids smallint[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_had_admin          boolean;
  v_keeps_admin        boolean;
  v_had_system_admin   boolean;
  v_keeps_system_admin boolean;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  if coalesce(pg_catalog.cardinality(p_role_ids), 0) = 0 then
    raise exception 'At least one role is required' using errcode = 'PT400';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(p_role_ids) as x(role_id)
    where not exists (select 1 from fitfine.roles r where r.id = x.role_id and r.deleted_at is null)
  ) then
    raise exception 'One or more roles do not exist or are not active' using errcode = 'PT400';
  end if;

  select exists (
    select 1 from fitfine.user_roles ur join fitfine.roles r on r.id = ur.role_id
    where ur.user_id = p_target_user_id and r.name = 'system_admin' and r.deleted_at is null
  ) into v_had_system_admin;
  select exists (
    select 1 from fitfine.roles r where r.id = any (p_role_ids) and r.name = 'system_admin' and r.deleted_at is null
  ) into v_keeps_system_admin;
  select exists (
    select 1 from fitfine.roles r where r.id = any (p_role_ids) and r.name = 'admin' and r.deleted_at is null
  ) into v_keeps_admin;

  if v_had_system_admin is distinct from v_keeps_system_admin
     and not coalesce((fitfine_private.access_of(p_caller_id)).is_system_admin, false) then
    raise exception 'Only a system admin can grant or remove the system_admin role.' using errcode = 'PT403';
  end if;
  if v_keeps_system_admin and not v_keeps_admin then
    raise exception 'The system_admin role can only be held together with admin.' using errcode = 'PT400';
  end if;

  perform fitfine_private.lock_active_profiles();
  v_had_admin := coalesce((fitfine_private.access_of(p_target_user_id)).is_admin, false);
  if v_had_admin and not v_keeps_admin and fitfine_private.other_active_admins(p_target_user_id) = 0 then
    raise exception 'Cannot remove — this is the last active admin.' using errcode = 'PT409';
  end if;

  -- user_roles has no soft delete: a role grant or removal is a real insert or delete, audited
  -- by trg_user_roles_audit_fields.
  delete from fitfine.user_roles ur where ur.user_id = p_target_user_id;

  insert into fitfine.user_roles (user_id, role_id, granted_by)
  select distinct p_target_user_id, x.role_id, p_caller_id
  from pg_catalog.unnest(p_role_ids) as x(role_id);

  return (
    select pg_catalog.jsonb_agg(r.name order by r.name)
    from fitfine.user_roles ur join fitfine.roles r on r.id = ur.role_id
    where ur.user_id = p_target_user_id
  );
end;
$$;

-- The one permanent delete (REQ-MEM-008), system admin only. Removes the member, their
-- subscriptions and items, and those rows' audit history. Returns the photo paths, which
-- chk_members_photo_url_path keeps under '<member_id>/'.
create function fitfine.purge_member(p_caller_id uuid, p_member_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member         fitfine.members;
  v_sub_ids        bigint[];
  v_item_ids       bigint[];
  v_shared_owners  integer;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_system_admin, false) then
    raise exception 'System admin access required' using errcode = 'PT403';
  end if;

  select * into v_member from fitfine.members m where m.id = p_member_id for update;
  if not found then
    raise exception 'Member % not found', p_member_id using errcode = 'PT404';
  end if;

  select count(distinct si.member_id) into v_shared_owners
  from fitfine.subscription_items si
  where si.shared_member_id = p_member_id and si.member_id <> p_member_id;
  if v_shared_owners > 0 then
    raise exception 'Cannot purge — this member is the shared member on % other member(s) subscriptions', v_shared_owners
      using errcode = 'PT409';
  end if;

  select coalesce(array_agg(s.id), '{}') into v_sub_ids from fitfine.subscriptions s where s.member_id = p_member_id;
  select coalesce(array_agg(si.id), '{}') into v_item_ids
  from fitfine.subscription_items si where si.member_id = p_member_id or si.subscription_id = any (v_sub_ids);

  -- prevent_hard_delete lets these four tables through while this is on.
  perform pg_catalog.set_config('app.purge_member', 'on', true);

  delete from fitfine.audit_log a
  where (a.table_name = 'members' and a.record_id = p_member_id::text)
     or (a.table_name = 'subscriptions' and a.record_id in (select x::text from pg_catalog.unnest(v_sub_ids) x))
     or (a.table_name = 'subscription_items' and a.record_id in (select x::text from pg_catalog.unnest(v_item_ids) x));

  delete from fitfine.subscription_items si where si.id = any (v_item_ids);
  delete from fitfine.subscriptions s where s.id = any (v_sub_ids);
  delete from fitfine.members m where m.id = p_member_id;

  perform pg_catalog.set_config('app.purge_member', 'off', true);

  return pg_catalog.jsonb_build_object(
    'photo_paths', pg_catalog.to_jsonb(pg_catalog.array_remove(array[v_member.photo_url, v_member.photo_thumbnail_url], null)),
    'subscriptions', coalesce(pg_catalog.array_length(v_sub_ids, 1), 0),
    'items', coalesce(pg_catalog.array_length(v_item_ids, 1), 0)
  );
end;
$$;

-- The guarded soft deletes: lock the row, run the usage guard, soft-delete, all in
-- one transaction, attributed to the caller. A missing or already deleted row is a 404.

create function fitfine.soft_delete_member(p_caller_id uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Active account required' using errcode = 'PT403';
  end if;

  perform 1 from fitfine.members m where m.id = p_id and m.deleted_at is null for update;
  if not found then
    raise exception 'Member not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.subscription_items si
  where (si.member_id = p_id or si.shared_member_id = p_id) and si.deleted_at is null;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % subscription/add-on record(s)', v_used using errcode = 'PT409';
  end if;

  update fitfine.members m set deleted_at = pg_catalog.now(), deleted_by = p_caller_id where m.id = p_id;
end;
$$;

create function fitfine.soft_delete_plan(p_caller_id uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  perform 1 from fitfine.plans p where p.id = p_id and p.deleted_at is null for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.subscription_items si where si.plan_id = p_id and si.deleted_at is null;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % subscription(s)', v_used using errcode = 'PT409';
  end if;

  update fitfine.plans p set deleted_at = pg_catalog.now(), deleted_by = p_caller_id where p.id = p_id;
end;
$$;

create function fitfine.soft_delete_branch(p_caller_id uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used integer;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  perform 1 from fitfine.branches b where b.id = p_id and b.deleted_at is null for update;
  if not found then
    raise exception 'Branch not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.members m where m.branch_id = p_id and m.deleted_at is null;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % member(s)', v_used using errcode = 'PT409';
  end if;

  update fitfine.branches b set deleted_at = pg_catalog.now(), deleted_by = p_caller_id where b.id = p_id;
end;
$$;

-- system_admin can never be deleted; nor can any role a user still holds.
create function fitfine.soft_delete_role(p_caller_id uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_used integer;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  select r.name into v_name from fitfine.roles r where r.id = p_id and r.deleted_at is null for update;
  if not found then
    raise exception 'Role not found' using errcode = 'PT404';
  end if;
  if v_name = 'system_admin' then
    raise exception 'The system_admin role is reserved and cannot be deleted.' using errcode = 'PT403';
  end if;

  select count(*) into v_used from fitfine.user_roles ur where ur.role_id = p_id;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % user(s)', v_used using errcode = 'PT409';
  end if;

  update fitfine.roles r set deleted_at = pg_catalog.now(), deleted_by = p_caller_id where r.id = p_id;
end;
$$;

-- The update-member-number-sequence rule, atomic: sets what the next member
-- registered at a branch will be numbered. member_number is never reused, so a requested value
-- already issued at this branch (any year, active or soft-deleted member) walks forward by the
-- configured increment to the first unused one; the result reports the value applied. The
-- branch's counter row is locked first, so a concurrent registration either commits before the
-- used numbers are read or waits for this to finish. Used numbers are matched with
-- starts_with(member_number, code || '-'), never LIKE: chk_branches_code_format keeps '-' and
-- wildcards out of codes, so the prefix names exactly one branch.
create function fitfine.set_member_number_sequence(p_caller_id uuid, p_branch_id bigint, p_next_sequence integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code         text;
  v_increment    integer;
  v_candidate    integer;
  v_attempts     integer := 0;
  v_max_attempts constant integer := 10000;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_admin, false) then
    raise exception 'Admin access required' using errcode = 'PT403';
  end if;

  if p_next_sequence is null or p_next_sequence < 1 then
    raise exception 'next_sequence must be at least 1' using errcode = 'PT400';
  end if;

  select b.code into v_code from fitfine.branches b where b.id = p_branch_id and b.deleted_at is null;
  if not found then
    raise exception 'branch_id does not reference an active branch' using errcode = 'PT400';
  end if;

  select c.value::integer into v_increment from fitfine.configuration c where c.key = 'member_number_increment';
  v_increment := coalesce(v_increment, 1);

  -- Create the counter row if the branch has none yet, then lock it.
  insert into fitfine.member_number_sequences (branch_id, last_sequence)
  values (p_branch_id, 0)
  on conflict (branch_id) do nothing;
  perform 1 from fitfine.member_number_sequences s where s.branch_id = p_branch_id for update;

  v_candidate := p_next_sequence;
  while v_attempts < v_max_attempts and exists (
    select 1 from fitfine.members m
    where pg_catalog.starts_with(m.member_number, v_code || '-')
      and pg_catalog.substring(m.member_number, '-([0-9]{1,9})$')::integer = v_candidate
  ) loop
    v_candidate := v_candidate + v_increment;
    v_attempts := v_attempts + 1;
  end loop;
  if v_attempts >= v_max_attempts then
    raise exception 'Could not find an available member number after % attempts', v_max_attempts using errcode = 'PT409';
  end if;

  -- generate_member_number() adds the increment to last_sequence, so the next registration
  -- lands exactly on v_candidate.
  update fitfine.member_number_sequences s
  set last_sequence = v_candidate - v_increment
  where s.branch_id = p_branch_id;

  return pg_catalog.jsonb_build_object(
    'next_sequence', v_candidate,
    'requested', p_next_sequence,
    'adjusted', v_candidate <> p_next_sequence
  );
end;
$$;

-- Grants: every function is revoked from everyone by name first; the defaults are not relied on.
revoke all on function
  fitfine.update_member_number_config(integer, integer, integer),
  fitfine.user_access(uuid),
  fitfine.create_subscription_with_items(uuid, bigint, text, text, jsonb),
  fitfine.update_subscription_header(uuid, bigint, text, text, boolean),
  fitfine.update_profile_fields(uuid, uuid, text, boolean),
  fitfine.soft_delete_profile(uuid, uuid),
  fitfine.restore_profile(uuid, uuid),
  fitfine.replace_user_roles(uuid, uuid, smallint[]),
  fitfine.purge_member(uuid, bigint),
  fitfine.soft_delete_member(uuid, bigint),
  fitfine.soft_delete_plan(uuid, bigint),
  fitfine.soft_delete_branch(uuid, bigint),
  fitfine.soft_delete_role(uuid, bigint),
  fitfine.set_member_number_sequence(uuid, bigint, integer)
from public, anon, authenticated, service_role;

grant execute on function fitfine.update_member_number_config(integer, integer, integer) to authenticated;

grant execute on function
  fitfine.user_access(uuid),
  fitfine.create_subscription_with_items(uuid, bigint, text, text, jsonb),
  fitfine.update_subscription_header(uuid, bigint, text, text, boolean),
  fitfine.update_profile_fields(uuid, uuid, text, boolean),
  fitfine.soft_delete_profile(uuid, uuid),
  fitfine.restore_profile(uuid, uuid),
  fitfine.replace_user_roles(uuid, uuid, smallint[]),
  fitfine.purge_member(uuid, bigint),
  fitfine.soft_delete_member(uuid, bigint),
  fitfine.soft_delete_plan(uuid, bigint),
  fitfine.soft_delete_branch(uuid, bigint),
  fitfine.soft_delete_role(uuid, bigint),
  fitfine.set_member_number_sequence(uuid, bigint, integer)
to service_role;
