-- Hard delete. Members, subscriptions (checkouts and their items), plans, branches and roles are
-- now deleted for real, behind the usage guards they already had (a foreign key with no cascade,
-- plus the delete_* functions below). Users are never deleted, only deactivated (is_active).
-- The deleted_at / deleted_by columns, the prevent_hard_delete triggers on the six tables, the
-- partial "...where deleted_at is null" indexes, purge_member() and soft_delete_profile() /
-- restore_profile() go; the audit trigger now also records a DELETE, so the audit log still
-- shows who removed what, with its last values.
--
-- Rows already soft-deleted are deleted for real first (children before parents). If a live row
-- still refers to one, a foreign key stops the migration and nothing is applied. A user who was
-- soft-deleted is kept as a deactivated user, which is the same lack of access.

-- 1. Remove what is already soft-deleted -------------------------------------------------------

drop trigger trg_members_no_hard_delete on fitfine.members;
drop trigger trg_subscriptions_no_hard_delete on fitfine.subscriptions;
drop trigger trg_subscription_items_no_hard_delete on fitfine.subscription_items;
drop trigger trg_plans_no_hard_delete on fitfine.plans;
drop trigger trg_branches_no_hard_delete on fitfine.branches;
drop trigger trg_roles_no_hard_delete on fitfine.roles;

-- A branch's counter row goes with the branch.
alter table fitfine.member_number_sequences drop constraint member_number_sequences_branch_id_fkey;
alter table fitfine.member_number_sequences
  add constraint member_number_sequences_branch_id_fkey
  foreign key (branch_id) references fitfine.branches(id) on delete cascade;

update fitfine.profiles set is_active = false where deleted_at is not null and is_active;

delete from fitfine.subscription_items si
where si.deleted_at is not null
   or si.subscription_id in (select s.id from fitfine.subscriptions s where s.deleted_at is not null);
delete from fitfine.subscriptions s
where s.deleted_at is not null
   or (s.member_id in (select m.id from fitfine.members m where m.deleted_at is not null)
       and not exists (select 1 from fitfine.subscription_items si where si.subscription_id = s.id));
delete from fitfine.members where deleted_at is not null;
delete from fitfine.plans where deleted_at is not null;
delete from fitfine.branches where deleted_at is not null;
delete from fitfine.roles where deleted_at is not null;

-- 2. Drop everything that mentions the columns --------------------------------------------------

drop view fitfine.member_list_view;
drop view fitfine.member_current_items;
drop view fitfine.profiles_with_roles;

drop policy profiles_select_active_users on fitfine.profiles;
drop policy profiles_select_self on fitfine.profiles;
drop policy profiles_update_admin on fitfine.profiles;
drop policy profiles_update_self_name on fitfine.profiles;
drop policy branches_select_active_users on fitfine.branches;
drop policy branches_update_admin on fitfine.branches;
drop policy plans_select_active_users on fitfine.plans;
drop policy plans_update_admin on fitfine.plans;
drop policy roles_select_active_users on fitfine.roles;
drop policy roles_update_admin on fitfine.roles;
drop policy members_select_active_users on fitfine.members;
drop policy members_update_active_users on fitfine.members;
drop policy subscriptions_select_active_users on fitfine.subscriptions;
drop policy subscription_items_select_active_users on fitfine.subscription_items;

drop function fitfine.soft_delete_member(uuid, bigint);
drop function fitfine.soft_delete_plan(uuid, bigint);
drop function fitfine.soft_delete_branch(uuid, bigint);
drop function fitfine.soft_delete_role(uuid, bigint);
drop function fitfine.soft_delete_profile(uuid, uuid);
drop function fitfine.restore_profile(uuid, uuid);
drop function fitfine.purge_member(uuid, bigint);

-- 3. The columns and the indexes that depended on them -------------------------------------------

drop index fitfine.idx_branches_code_active;
drop index fitfine.idx_members_number_active;
drop index fitfine.idx_members_phone_active;
drop index fitfine.idx_plans_name_active;
drop index fitfine.idx_roles_name_active;
drop index fitfine.idx_subscription_items_member_end;
drop index fitfine.idx_subscription_items_shared_member_end;

alter table fitfine.members            drop column deleted_at, drop column deleted_by;
alter table fitfine.subscriptions      drop column deleted_at, drop column deleted_by;
alter table fitfine.subscription_items drop column deleted_at, drop column deleted_by;
alter table fitfine.plans              drop column deleted_at, drop column deleted_by;
alter table fitfine.branches           drop column deleted_at, drop column deleted_by;
alter table fitfine.roles              drop column deleted_at, drop column deleted_by;
alter table fitfine.profiles           drop column deleted_at, drop column deleted_by;

create unique index idx_branches_code on fitfine.branches (code);
create unique index idx_members_number on fitfine.members (member_number);
create unique index idx_members_phone on fitfine.members (phone);
create unique index idx_plans_name on fitfine.plans (name);
create unique index idx_roles_name on fitfine.roles (name);
create index idx_subscription_items_member_end on fitfine.subscription_items (member_id, end_date);
create index idx_subscription_items_shared_member_end on fitfine.subscription_items (shared_member_id, end_date)
  where shared_member_id is not null;

-- 4. The functions, without the deleted_at checks ------------------------------------------------

create or replace function fitfine_private.access_of(p_user_id uuid)
returns fitfine_private.access
language sql
stable
security definer
set search_path = ''
as $$
  select row(
    p.ok and cardinality(r.names) > 0,
    p.ok and 'admin' = any (r.names),
    p.ok and 'admin' = any (r.names) and 'system_admin' = any (r.names)
  )::fitfine_private.access
  from (
    select exists (
      select 1 from fitfine.profiles pr
      where pr.id = p_user_id and pr.is_active
    ) as ok
  ) p,
  (
    select coalesce(array_agg(ro.name), '{}') as names
    from fitfine.user_roles ur
    join fitfine.roles ro on ro.id = ur.role_id
    where ur.user_id = p_user_id
  ) r
$$;

create or replace function fitfine_private.other_active_admins(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from fitfine.profiles p
  where p.id is distinct from p_user_id
    and p.is_active
    and (fitfine_private.access_of(p.id)).is_admin
$$;

create or replace function fitfine_private.lock_active_profiles()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from fitfine.profiles p where p.is_active for update;
end;
$$;

create or replace function fitfine.create_subscription_with_items(
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

  perform 1 from fitfine.members m where m.id = p_member_id for share;
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
      perform 1 from fitfine.members m where m.id = v_item_shared_member_id for share;
      if not found then
        raise exception 'Member % not found', v_item_shared_member_id using errcode = 'PT404';
      end if;
    end if;

    select * into v_plan from fitfine.plans p
    where p.id = (v_item ->> 'plan_id')::bigint
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

create or replace function fitfine.update_subscription_header(
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
  returning * into v_subscription;

  if v_subscription.id is null then
    raise exception 'Subscription % not found', p_subscription_id using errcode = 'PT404';
  end if;

  return pg_catalog.to_jsonb(v_subscription);
end;
$$;

create or replace function fitfine.update_profile_fields(
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
  where p.id = p_target_user_id;
end;
$$;

create or replace function fitfine.replace_user_roles(p_caller_id uuid, p_target_user_id uuid, p_role_ids smallint[])
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
    where not exists (select 1 from fitfine.roles r where r.id = x.role_id)
  ) then
    raise exception 'One or more roles do not exist or are not active' using errcode = 'PT400';
  end if;

  select exists (
    select 1 from fitfine.user_roles ur join fitfine.roles r on r.id = ur.role_id
    where ur.user_id = p_target_user_id and r.name = 'system_admin'
  ) into v_had_system_admin;
  select exists (
    select 1 from fitfine.roles r where r.id = any (p_role_ids) and r.name = 'system_admin'
  ) into v_keeps_system_admin;
  select exists (
    select 1 from fitfine.roles r where r.id = any (p_role_ids) and r.name = 'admin'
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

  -- A role grant or removal is a real insert or delete on user_roles, audited
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

create or replace function fitfine.set_member_number_sequence(p_caller_id uuid, p_branch_id bigint, p_next_sequence integer)
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

  select b.code into v_code from fitfine.branches b where b.id = p_branch_id;
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

create or replace function fitfine.create_member(p_caller_id uuid, p_member jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member     fitfine.members;
  v_branch_id  bigint;
  v_handled_by uuid;
  v_constraint text;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Active account required' using errcode = 'PT403';
  end if;

  if pg_catalog.jsonb_typeof(p_member) is distinct from 'object' then
    raise exception 'A member is required' using errcode = 'PT400';
  end if;

  v_branch_id  := (p_member ->> 'branch_id')::bigint;
  v_handled_by := (p_member ->> 'handled_by_staff')::uuid;

  perform 1 from fitfine.branches b where b.id = v_branch_id for share;
  if not found then
    raise exception 'branch_id does not reference an active branch' using errcode = 'PT400';
  end if;
  if v_handled_by is not null then
    perform 1 from fitfine.profiles p where p.id = v_handled_by;
    if not found then
      raise exception 'handled_by_staff does not reference an active user' using errcode = 'PT400';
    end if;
  end if;

  begin
    insert into fitfine.members (
      name, phone, date_of_birth, date_of_joining, gender, weight_kg, height_cm,
      under_doctor_care, doctor_care_details,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      email, residential_address, pincode, aadhaar_number, occupation,
      branch_id, handled_by_staff
    )
    values (
      p_member ->> 'name',
      p_member ->> 'phone',
      (p_member ->> 'date_of_birth')::date,
      coalesce(nullif(p_member ->> 'date_of_joining', '')::date, current_date),
      p_member ->> 'gender',
      (p_member ->> 'weight_kg')::numeric,
      (p_member ->> 'height_cm')::numeric,
      coalesce((p_member ->> 'under_doctor_care')::boolean, false),
      nullif(p_member ->> 'doctor_care_details', ''),
      p_member ->> 'emergency_contact_name',
      p_member ->> 'emergency_contact_phone',
      p_member ->> 'emergency_contact_relationship',
      nullif(p_member ->> 'email', ''),
      nullif(p_member ->> 'residential_address', ''),
      nullif(p_member ->> 'pincode', ''),
      nullif(p_member ->> 'aadhaar_number', ''),
      nullif(p_member ->> 'occupation', ''),
      v_branch_id,
      v_handled_by
    )
    returning * into v_member;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'idx_members_phone' then
        raise exception 'A member with this phone number already exists' using errcode = 'PT409';
      end if;
      raise;
  end;

  return pg_catalog.to_jsonb(v_member);
end;
$$;

create or replace function fitfine.set_member_photo(p_caller_id uuid, p_member_id bigint, p_photo_url text, p_thumbnail_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Active account required' using errcode = 'PT403';
  end if;

  update fitfine.members m
  set photo_url = p_photo_url, photo_thumbnail_url = p_thumbnail_url
  where m.id = p_member_id;
  if not found then
    raise exception 'Member % not found', p_member_id using errcode = 'PT404';
  end if;
end;
$$;

create or replace function fitfine_private.generate_member_number()
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

  select b.code into v_branch_code from fitfine.branches b where b.id = new.branch_id;
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

create or replace function fitfine_private.handle_new_auth_user()
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
    where r.id in (
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

-- 5. Real deletes, each behind its usage guard -----------------------------------------------------
-- Lock the row, run the guard, delete, all in one transaction, attributed to the caller. A missing
-- row is a 404. The foreign keys (no cascade) are the backstop behind each guard.

-- Returns the member's photo paths, which chk_members_photo_url_path keeps under '<member_id>/':
-- the delete-member Edge Function removes the files after the rows are gone.
create function fitfine.delete_member(p_caller_id uuid, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member fitfine.members;
  v_used   integer;
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Active account required' using errcode = 'PT403';
  end if;

  select * into v_member from fitfine.members m where m.id = p_id for update;
  if not found then
    raise exception 'Member not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.subscription_items si
  where si.member_id = p_id or si.shared_member_id = p_id;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % subscription/add-on record(s)', v_used using errcode = 'PT409';
  end if;

  -- A checkout always has items, so a member with none has no checkout either; this only clears
  -- a header left without items, which would otherwise block the delete.
  delete from fitfine.subscriptions s where s.member_id = p_id;
  delete from fitfine.members m where m.id = p_id;

  return pg_catalog.jsonb_build_object(
    'photo_paths', pg_catalog.to_jsonb(pg_catalog.array_remove(array[v_member.photo_url, v_member.photo_thumbnail_url], null))
  );
end;
$$;

-- One checkout: its items, then the header. Frees the member to be deleted.
create function fitfine.delete_subscription(p_caller_id uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform fitfine_private.act_as(p_caller_id);
  if not coalesce((fitfine_private.access_of(p_caller_id)).is_active, false) then
    raise exception 'Active account required' using errcode = 'PT403';
  end if;

  perform 1 from fitfine.subscriptions s where s.id = p_id for update;
  if not found then
    raise exception 'Subscription not found' using errcode = 'PT404';
  end if;

  delete from fitfine.subscription_items si where si.subscription_id = p_id;
  delete from fitfine.subscriptions s where s.id = p_id;
end;
$$;

create function fitfine.delete_plan(p_caller_id uuid, p_id bigint)
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

  perform 1 from fitfine.plans p where p.id = p_id for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.subscription_items si where si.plan_id = p_id;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % subscription(s)', v_used using errcode = 'PT409';
  end if;

  delete from fitfine.plans p where p.id = p_id;
end;
$$;

create function fitfine.delete_branch(p_caller_id uuid, p_id bigint)
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

  perform 1 from fitfine.branches b where b.id = p_id for update;
  if not found then
    raise exception 'Branch not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.members m where m.branch_id = p_id;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % member(s)', v_used using errcode = 'PT409';
  end if;

  delete from fitfine.branches b where b.id = p_id;
end;
$$;

-- system_admin can never be deleted; nor can any role a user still holds.
create function fitfine.delete_role(p_caller_id uuid, p_id bigint)
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

  select r.name into v_name from fitfine.roles r where r.id = p_id for update;
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

  delete from fitfine.roles r where r.id = p_id;
end;
$$;

revoke all on function
  fitfine.delete_member(uuid, bigint),
  fitfine.delete_subscription(uuid, bigint),
  fitfine.delete_plan(uuid, bigint),
  fitfine.delete_branch(uuid, bigint),
  fitfine.delete_role(uuid, bigint)
from public, anon, authenticated, service_role;

grant execute on function
  fitfine.delete_member(uuid, bigint),
  fitfine.delete_subscription(uuid, bigint),
  fitfine.delete_plan(uuid, bigint),
  fitfine.delete_branch(uuid, bigint),
  fitfine.delete_role(uuid, bigint)
to service_role;

-- 6. Policies and views again, without the filter ------------------------------------------------

create policy profiles_select_active_users on fitfine.profiles
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

create policy profiles_select_self on fitfine.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_admin on fitfine.profiles
  for update to authenticated
  using ((select fitfine_private.is_active_admin()));

create policy profiles_update_self_name on fitfine.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy branches_select_active_users on fitfine.branches
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

create policy branches_update_admin on fitfine.branches
  for update to authenticated
  using ((select fitfine_private.is_active_admin()));

create policy plans_select_active_users on fitfine.plans
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

create policy plans_update_admin on fitfine.plans
  for update to authenticated
  using ((select fitfine_private.is_active_admin()));

create policy roles_select_active_users on fitfine.roles
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

create policy roles_update_admin on fitfine.roles
  for update to authenticated
  using ((select fitfine_private.is_active_admin()));

create policy members_select_active_users on fitfine.members
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

create policy members_update_active_users on fitfine.members
  for update to authenticated
  using ((select fitfine_private.is_active_user()));

create policy subscriptions_select_active_users on fitfine.subscriptions
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

create policy subscription_items_select_active_users on fitfine.subscription_items
  for select to authenticated
  using ((select fitfine_private.is_active_user()));


create view fitfine.member_current_items with (security_invoker = true) as
 select si.id as subscription_item_id,
    si.subscription_id,
    si.plan_id,
    p.name as plan_name,
    p.category,
    si.member_id,
    si.start_date,
    si.end_date,
    si.quantity,
    si.amount_paid
   from fitfine.subscription_items si
     join fitfine.plans p on p.id = si.plan_id
  where (si.end_date is null or si.end_date >= current_date)
union all
 select si.id as subscription_item_id,
    si.subscription_id,
    si.plan_id,
    p.name as plan_name,
    p.category,
    si.shared_member_id as member_id,
    si.start_date,
    si.end_date,
    si.quantity,
    si.amount_paid
   from fitfine.subscription_items si
     join fitfine.plans p on p.id = si.plan_id
  where si.shared_member_id is not null and (si.end_date is null or si.end_date >= current_date);

create view fitfine.member_list_view with (security_invoker = true) as
 select m.id,
    m.name,
    m.phone,
    m.member_number,
    m.date_of_joining,
    m.gender,
    m.photo_thumbnail_url,
    current_membership.plan_id as current_membership_plan_id,
    current_membership.plan_name as current_membership_plan_name,
    current_membership.end_date as current_membership_end_date,
    coalesce(current_addons.addon_plan_ids, '{}'::bigint[]) as current_addon_plan_ids,
    m.photo_url
   from fitfine.members m
     left join lateral (
       select si.plan_id,
          p.name as plan_name,
          si.end_date
         from fitfine.subscription_items si
           join fitfine.plans p on p.id = si.plan_id
        where (si.member_id = m.id or si.shared_member_id = m.id) and p.category = 'membership'
        order by si.end_date desc
       limit 1) current_membership on true
     left join lateral (
       select array_agg(distinct mci.plan_id) as addon_plan_ids
         from fitfine.member_current_items mci
        where mci.member_id = m.id and mci.category = 'addon') current_addons on true;

create view fitfine.profiles_with_roles with (security_invoker = true) as
 select p.id,
    p.full_name,
    p.is_active,
    coalesce(ur.role_names, '{}'::text[]) as roles
   from fitfine.profiles p
     left join lateral (
       select array_agg(r.name order by r.name) as role_names
         from fitfine.user_roles ur_1
           join fitfine.roles r on r.id = ur_1.role_id
        where ur_1.user_id = p.id) ur on true;


revoke all on fitfine.member_current_items, fitfine.member_list_view, fitfine.profiles_with_roles
  from public, anon, authenticated, service_role;
grant select on fitfine.member_current_items, fitfine.member_list_view, fitfine.profiles_with_roles
  to authenticated, service_role;

-- 7. Audit a delete too; hard delete stays blocked only where it must (users, the audit log) ------

create or replace function fitfine_private.audit_row_changes()
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
    -- One row per column, with the last values: the record is gone, so this is what remains of it.
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

drop trigger trg_members_audit_fields on fitfine.members;
create trigger trg_members_audit_fields after insert or update or delete on fitfine.members
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_subscriptions_audit_fields on fitfine.subscriptions;
create trigger trg_subscriptions_audit_fields after insert or update or delete on fitfine.subscriptions
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_subscription_items_audit_fields on fitfine.subscription_items;
create trigger trg_subscription_items_audit_fields after insert or update or delete on fitfine.subscription_items
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_plans_audit_fields on fitfine.plans;
create trigger trg_plans_audit_fields after insert or update or delete on fitfine.plans
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_branches_audit_fields on fitfine.branches;
create trigger trg_branches_audit_fields after insert or update or delete on fitfine.branches
  for each row execute function fitfine_private.audit_row_changes();
drop trigger trg_roles_audit_fields on fitfine.roles;
create trigger trg_roles_audit_fields after insert or update or delete on fitfine.roles
  for each row execute function fitfine_private.audit_row_changes();

-- Only profiles (users are deactivated, never deleted) and the audit log are still protected.
create or replace function fitfine_private.prevent_hard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Hard delete is not allowed on table %.', tg_table_name;
end;
$$;
