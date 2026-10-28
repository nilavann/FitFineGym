-- Removes the reserved system_admin role. Its only remaining power was granting and removing
-- itself (the permanent member delete went with the hard-delete migration), so there is nothing
-- left for it to protect. Anyone who held it keeps admin, which they had to hold alongside it.
--
-- The role row and its grants are deleted; the protect_system_admin_role trigger, the
-- is_system_admin access flag and every check on the role name go. Applied in one transaction.

-- 1. The role and its grants -----------------------------------------------------------------------

drop trigger trg_roles_protect_system_admin on fitfine.roles;
drop function fitfine_private.protect_system_admin_role();

delete from fitfine.user_roles ur using fitfine.roles r
where r.id = ur.role_id and r.name = 'system_admin';
delete from fitfine.roles where name = 'system_admin';

-- 2. The access flag -------------------------------------------------------------------------------

alter type fitfine_private.access drop attribute is_system_admin;

create or replace function fitfine_private.access_of(p_user_id uuid)
returns fitfine_private.access
language sql
stable
security definer
set search_path = ''
as $$
  select row(
    p.ok and cardinality(r.names) > 0,
    p.ok and 'admin' = any (r.names)
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

create or replace function fitfine.user_access(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'is_active',           coalesce(a.is_active, false),
    'is_admin',            coalesce(a.is_admin, false),
    'other_active_admins', fitfine_private.other_active_admins(p_user_id)
  )
  from fitfine_private.access_of(p_user_id) a
$$;

-- 3. The functions that checked the role -------------------------------------------------------------

create or replace function fitfine.replace_user_roles(p_caller_id uuid, p_target_user_id uuid, p_role_ids smallint[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_had_admin   boolean;
  v_keeps_admin boolean;
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
    select 1 from fitfine.roles r where r.id = any (p_role_ids) and r.name = 'admin'
  ) into v_keeps_admin;

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

-- A role a user still holds cannot be deleted.
create or replace function fitfine.delete_role(p_caller_id uuid, p_id bigint)
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

  perform 1 from fitfine.roles r where r.id = p_id for update;
  if not found then
    raise exception 'Role not found' using errcode = 'PT404';
  end if;

  select count(*) into v_used from fitfine.user_roles ur where ur.role_id = p_id;
  if v_used > 0 then
    raise exception 'Cannot delete — used by % user(s)', v_used using errcode = 'PT409';
  end if;

  delete from fitfine.roles r where r.id = p_id;
end;
$$;
