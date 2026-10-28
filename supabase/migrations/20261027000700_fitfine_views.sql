-- Views (spec/migration/phase-2-plan.md §2.4, Task 7). The same columns and joins as the
-- source's current definitions (member_list_view as of
-- 20261024000000_member_list_view_latest_membership.sql), schema-qualified, and
-- security_invoker = true: each view now reads its tables under the caller's RLS. What the
-- screens show doesn't change:
--   member_list_view already filters members.deleted_at is null, like the members policy.
--   member_current_items joins plans, whose policy hides deleted plans; soft_delete_plan refuses
--     a plan that live items use, so no current item points at one.
--   profiles_with_roles: every frontend read asks for non-deleted profiles only; deleted users
--     come from list-users, through the service role.

-- One row per (current item, member it covers): the item's member, and its shared member if any.
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
  where si.deleted_at is null and (si.end_date is null or si.end_date >= current_date)
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
  where si.shared_member_id is not null and si.deleted_at is null and (si.end_date is null or si.end_date >= current_date);

-- The member list: the latest membership item (expired or not) and the current add-ons.
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
        where (si.member_id = m.id or si.shared_member_id = m.id) and si.deleted_at is null and p.category = 'membership'
        order by si.end_date desc
       limit 1) current_membership on true
     left join lateral (
       select array_agg(distinct mci.plan_id) as addon_plan_ids
         from fitfine.member_current_items mci
        where mci.member_id = m.id and mci.category = 'addon') current_addons on true
  where m.deleted_at is null;

create view fitfine.profiles_with_roles with (security_invoker = true) as
 select p.id,
    p.full_name,
    p.is_active,
    p.deleted_at,
    coalesce(ur.role_names, '{}'::text[]) as roles
   from fitfine.profiles p
     left join lateral (
       select array_agg(r.name order by r.name) as role_names
         from fitfine.user_roles ur_1
           join fitfine.roles r on r.id = ur_1.role_id and r.deleted_at is null
        where ur_1.user_id = p.id) ur on true;

revoke all on fitfine.member_current_items, fitfine.member_list_view, fitfine.profiles_with_roles
  from public, anon, authenticated, service_role;
grant select on fitfine.member_current_items, fitfine.member_list_view, fitfine.profiles_with_roles
  to authenticated, service_role;
