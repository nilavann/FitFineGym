-- Access core (spec/migration/phase-2-plan.md §2.3, Task 4). access_of is the only place the
-- access rule lives; every policy, API function and Edge Function reaches it from here.
-- Every function: SECURITY DEFINER, search_path = '', every name schema-qualified.

create type fitfine_private.access as (
  is_active       boolean,
  is_admin        boolean,
  is_system_admin boolean
);

-- Active: profile active and not deleted, and at least one non-deleted role.
-- Admin: active and holds the admin role. System admin: admin and holds system_admin.
create function fitfine_private.access_of(p_user_id uuid)
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
      where pr.id = p_user_id and pr.is_active and pr.deleted_at is null
    ) as ok
  ) p,
  (
    select coalesce(array_agg(ro.name), '{}') as names
    from fitfine.user_roles ur
    join fitfine.roles ro on ro.id = ur.role_id and ro.deleted_at is null
    where ur.user_id = p_user_id
  ) r
$$;

-- Makes auth.uid() return p_user_id for the rest of the transaction, in either of the forms
-- auth.uid() reads, so set_audit_fields / audit_row_changes attribute the writes that follow.
-- Owner only: it would otherwise let anyone impersonate anyone.
create function fitfine_private.act_as(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'act_as: a user id is required';
  end if;
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', p_user_id)::text, true);
end;
$$;

-- The RLS helpers. Policies call them as (select ...), so each runs once per statement.
create function fitfine_private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((fitfine_private.access_of(auth.uid())).is_active, false)
$$;

create function fitfine_private.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((fitfine_private.access_of(auth.uid())).is_admin, false)
$$;

revoke all on function fitfine_private.access_of(uuid)   from public, anon, authenticated, service_role;
revoke all on function fitfine_private.act_as(uuid)      from public, anon, authenticated, service_role;
revoke all on function fitfine_private.is_active_user()  from public, anon, authenticated, service_role;
revoke all on function fitfine_private.is_active_admin() from public, anon, authenticated, service_role;

-- The storage policies run as authenticated too, so the same grant covers them.
grant execute on function fitfine_private.is_active_user()  to authenticated;
grant execute on function fitfine_private.is_active_admin() to authenticated;
