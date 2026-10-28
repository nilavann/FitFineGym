-- Schemas and grants (spec/migration/phase-2-plan.md §2.1, §2.2, Task 3). Closed by default:
-- everything is revoked first, then each privilege is granted by name. RLS is already enabled
-- on every table and no policy exists yet, so these grants open nothing until Task 6.
--
-- Nobody but the owner (postgres) ever holds DELETE, TRUNCATE, REFERENCES or TRIGGER on a table.
-- Inserting into an identity column needs no grant on its sequence, so no sequence is granted.

-- fitfine_private is never exposed through the Data API (config.toml: [api] schemas = ["fitfine"]).
create schema fitfine_private;

revoke all on schema fitfine, fitfine_private from public, anon, authenticated, service_role;
revoke all on all tables    in schema fitfine, fitfine_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema fitfine, fitfine_private from public, anon, authenticated, service_role;
revoke all on all functions in schema fitfine, fitfine_private from public, anon, authenticated, service_role;

-- A future object in either schema starts closed.
alter default privileges for role postgres in schema fitfine, fitfine_private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema fitfine, fitfine_private
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema fitfine, fitfine_private
  revoke all on functions from public, anon, authenticated, service_role;
-- Global, not per schema: Postgres grants EXECUTE to PUBLIC on every new function, and a
-- per-schema default can only add to that, never take it away.
alter default privileges for role postgres revoke execute on functions from public;

-- anon gets no USAGE on either schema: an anonymous request reaches nothing.
-- authenticated needs USAGE on fitfine_private because the policies call its helpers as the caller.
grant usage on schema fitfine, fitfine_private to authenticated, service_role;

-- authenticated: only what the frontend uses, with column lists on INSERT / UPDATE. Leaving
-- id, member_number, the audit columns and deleted_at / deleted_by out of every column list
-- means a soft delete is possible only through the Edge Functions.
grant select on
  fitfine.profiles, fitfine.branches, fitfine.plans, fitfine.roles, fitfine.user_roles,
  fitfine.members, fitfine.subscriptions, fitfine.subscription_items,
  fitfine.configuration, fitfine.member_number_sequences, fitfine.audit_log
to authenticated;

grant update (full_name) on fitfine.profiles to authenticated;

grant insert (name, code), update (name, code) on fitfine.branches to authenticated;

grant insert (name, category, duration_days, price, max_members),
      update (name, category, duration_days, price, max_members)
on fitfine.plans to authenticated;

grant insert (name, description), update (name, description) on fitfine.roles to authenticated;

-- Every business column. branch_id is insert-only: generate_member_number() reverts any change
-- to it on update anyway.
grant insert (
  name, phone, date_of_birth, date_of_joining, gender, weight_kg, height_cm,
  under_doctor_care, doctor_care_details,
  emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
  email, residential_address, pincode, aadhaar_number, occupation,
  photo_url, photo_thumbnail_url, branch_id, handled_by_staff
) on fitfine.members to authenticated;
grant update (
  name, phone, date_of_birth, date_of_joining, gender, weight_kg, height_cm,
  under_doctor_care, doctor_care_details,
  emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
  email, residential_address, pincode, aadhaar_number, occupation,
  photo_url, photo_thumbnail_url, handled_by_staff
) on fitfine.members to authenticated;

-- service_role bypasses RLS. Plain reads and writes only: every write it makes on a caller's
-- behalf goes through a SECURITY DEFINER function in fitfine (Task 8).
grant select, insert, update on
  fitfine.profiles, fitfine.branches, fitfine.plans, fitfine.roles, fitfine.user_roles,
  fitfine.members, fitfine.subscriptions, fitfine.subscription_items,
  fitfine.configuration, fitfine.member_number_sequences, fitfine.audit_log
to service_role;
