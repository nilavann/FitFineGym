-- Table policies (spec/migration/phase-2-plan.md §2.2, Task 6). Same rules as the source, with
-- three changes: every policy is TO authenticated, the helpers are wrapped in (select ...) so
-- Postgres evaluates them once per statement, and the write policies pair with the column grants
-- of Task 3. No table has a DELETE policy. RLS stays enabled, not forced.
--
-- "Active": a profile that is active and not deleted, holding at least one non-deleted role
-- (fitfine_private.access_of).

-- profiles ----------------------------------------------------------------------------------
create policy profiles_select_active_users on fitfine.profiles
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);
-- The only row a deactivated user can read: their own.
create policy profiles_select_self on fitfine.profiles
  for select to authenticated
  using (id = (select auth.uid()) and deleted_at is null);
create policy profiles_update_admin on fitfine.profiles
  for update to authenticated
  using ((select fitfine_private.is_active_admin()) and deleted_at is null);
-- The column grant limits this to full_name.
create policy profiles_update_self_name on fitfine.profiles
  for update to authenticated
  using (id = (select auth.uid()) and deleted_at is null)
  with check (id = (select auth.uid()));

-- branches, plans, roles: everyone active reads, admins write -------------------------------
create policy branches_select_active_users on fitfine.branches
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);
create policy branches_insert_admin on fitfine.branches
  for insert to authenticated
  with check ((select fitfine_private.is_active_admin()));
create policy branches_update_admin on fitfine.branches
  for update to authenticated
  using ((select fitfine_private.is_active_admin()) and deleted_at is null);

create policy plans_select_active_users on fitfine.plans
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);
create policy plans_insert_admin on fitfine.plans
  for insert to authenticated
  with check ((select fitfine_private.is_active_admin()));
create policy plans_update_admin on fitfine.plans
  for update to authenticated
  using ((select fitfine_private.is_active_admin()) and deleted_at is null);

create policy roles_select_active_users on fitfine.roles
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);
create policy roles_insert_admin on fitfine.roles
  for insert to authenticated
  with check ((select fitfine_private.is_active_admin()));
create policy roles_update_admin on fitfine.roles
  for update to authenticated
  using ((select fitfine_private.is_active_admin()) and deleted_at is null);

-- user_roles has no soft delete (replace_user_roles deletes for real).
create policy user_roles_select_active_users on fitfine.user_roles
  for select to authenticated
  using ((select fitfine_private.is_active_user()));

-- members: any active user reads, adds and edits ---------------------------------------------
create policy members_select_active_users on fitfine.members
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);
create policy members_insert_active_users on fitfine.members
  for insert to authenticated
  with check ((select fitfine_private.is_active_user()));
create policy members_update_active_users on fitfine.members
  for update to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);

-- subscriptions: read only; every write goes through an Edge Function RPC --------------------
create policy subscriptions_select_active_users on fitfine.subscriptions
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);
create policy subscription_items_select_active_users on fitfine.subscription_items
  for select to authenticated
  using ((select fitfine_private.is_active_user()) and deleted_at is null);

-- admin-only reads ----------------------------------------------------------------------------
-- configuration has no UPDATE policy: update_member_number_config (SECURITY DEFINER) writes it.
create policy configuration_select_admin on fitfine.configuration
  for select to authenticated
  using ((select fitfine_private.is_active_admin()));
create policy member_number_sequences_select_admin on fitfine.member_number_sequences
  for select to authenticated
  using ((select fitfine_private.is_active_admin()));
-- audit_log holds copies of member data.
create policy audit_log_select_admin on fitfine.audit_log
  for select to authenticated
  using ((select fitfine_private.is_active_admin()));
