-- The three views: security_invoker, so they show
-- an active user the same rows as before and a deactivated user nothing. Row-for-row equality with
-- the source's views on the same data is checked by compare-views.sh.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

do $$
declare
  m1 bigint := (select id from fitfine.members where phone = '5550000001');
  m2 bigint := (select id from fitfine.members where phone = '5550000002');
  v_gone bigint := t.member('5550000009', 'TA', 'Gone');
begin
  update fitfine.members set deleted_at = now() where id = v_gone;
  -- m2 shares m1's couple plan; m1 also holds an expired add-on and a current one.
  insert into fitfine.subscription_items (subscription_id, plan_id, member_id, shared_member_id, start_date, end_date, quantity, amount_paid)
  select s.id, p.id, m1, x.shared, x.s, x.e, 1, 0
  from fitfine.subscriptions s, fitfine.plans p,
       (values ('T Couple', m2, current_date, current_date + 29), ('T Locker', null::bigint, current_date - 60, current_date - 31),
               ('T Locker', null::bigint, current_date, null)) as x(plan, shared, s, e)
  where s.member_id = m1 and p.name = x.plan;
end $$;

select t.eq('member_list_view: staff sees every non-deleted member and no deleted one',
  t.try('authenticated', t.uid('staff'), 'select 1 from fitfine.member_list_view'),
  'rows:' || (select count(*) from fitfine.members where deleted_at is null));
select t.eq('member_list_view: the shared member sees the couple plan as their membership',
  (select current_membership_plan_name from fitfine.member_list_view where phone = '5550000002'), 'T Couple');
select t.eq('member_list_view: only current add-ons are listed',
  (select current_addon_plan_ids from fitfine.member_list_view where phone = '5550000001'), array[t.plan('T Locker')]);
select t.eq('member_current_items: the shared item appears once for each member',
  (select count(*) from fitfine.member_current_items where plan_name = 'T Couple'), 2::bigint);
select t.eq('member_current_items: an expired item is not current',
  (select count(*) from fitfine.member_current_items where plan_name = 'T Locker'), 1::bigint);

select t.eq('member_list_view: an inactive user sees nothing', t.try('authenticated', t.uid('inactive'),
  'select 1 from fitfine.member_list_view'), 'rows:0');
select t.eq('member_current_items: a user without a role sees nothing', t.try('authenticated', t.uid('norole'),
  'select 1 from fitfine.member_current_items'), 'rows:0');
select t.eq('profiles_with_roles: staff sees every non-deleted profile', t.try('authenticated', t.uid('staff'),
  'select 1 from fitfine.profiles_with_roles'), 'rows:' || (select count(*) from fitfine.profiles where deleted_at is null));
select t.eq('profiles_with_roles: an inactive user sees only their own row', t.try('authenticated', t.uid('inactive'),
  format('select 1 from fitfine.profiles_with_roles where id = %L', t.uid('inactive'))) || '/'
  || t.try('authenticated', t.uid('inactive'), 'select 1 from fitfine.profiles_with_roles'), 'rows:1/rows:1');
select t.eq('profiles_with_roles: roles are listed by name',
  (select roles from fitfine.profiles_with_roles where id = t.uid('sysadmin')), array['admin', 'system_admin']);
select t.eq('profiles_with_roles: service_role still sees deleted users (list-users)', t.try('service_role', null,
  format('select 1 from fitfine.profiles_with_roles where id = %L', t.uid('deleted'))), 'rows:1');

rollback;
