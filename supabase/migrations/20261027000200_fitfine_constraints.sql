-- Check constraints on text, number and format fields. Added valid, never NOT VALID: every
-- existing row must satisfy them.
--
-- Two character rules, used by every *_text constraint. Written with \u escapes so no invisible
-- character sits in this file:
--   single-line: no C0 control, DEL, U+200B, U+200E-U+200F, U+202A-U+202E, U+2060,
--                U+2066-U+2069, U+FEFF
--   multi-line:  the same, but line feed (U+000A) is allowed
-- ZWNJ and ZWJ (U+200C, U+200D) are allowed in both: Indic scripts need them in ordinary names.
-- validate.ts in the Edge Functions strips exactly this set, with the same length limits.
-- A NULL passes every constraint (a CHECK that evaluates to NULL passes).

-- Set A: text fields --------------------------------------------------------------------------

alter table fitfine.members
  add constraint chk_members_name_not_blank check (trim(name) <> ''),
  add constraint chk_members_phone_not_blank check (trim(phone) <> ''),
  add constraint chk_members_emergency_contact_name_not_blank check (trim(emergency_contact_name) <> ''),
  add constraint chk_members_emergency_contact_phone_not_blank check (trim(emergency_contact_phone) <> ''),
  add constraint chk_members_emergency_contact_relationship_not_blank check (trim(emergency_contact_relationship) <> '');

alter table fitfine.profiles
  add constraint chk_profiles_full_name_not_blank check (trim(full_name) <> '');

-- Only the three member-number keys must hold positive integers; other keys stay free text.
alter table fitfine.configuration
  add constraint chk_configuration_member_number_positive_int check (
    key not in ('member_number_start_sequence', 'member_number_increment', 'member_number_padding_width')
    or value ~ '^[1-9][0-9]*$'
  );

-- Equal dates are allowed: a one-day item.
alter table fitfine.subscription_items
  add constraint chk_subscription_items_end_after_start check (end_date is null or end_date >= start_date);

-- Set B: formats and paths --------------------------------------------------------------------

alter table fitfine.members
  add constraint chk_members_name_text check (
    char_length(name) <= 80
    and name !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_members_emergency_contact_name_text check (
    char_length(emergency_contact_name) <= 80
    and emergency_contact_name !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_members_occupation_text check (
    char_length(occupation) <= 80
    and occupation !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_members_emergency_contact_relationship_text check (
    char_length(emergency_contact_relationship) <= 40
    and emergency_contact_relationship !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_members_residential_address_text check (
    char_length(residential_address) <= 500
    and residential_address !~ '[\u0001-\u0009\u000b-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_members_doctor_care_details_text check (
    char_length(doctor_care_details) <= 1000
    and doctor_care_details !~ '[\u0001-\u0009\u000b-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_members_phone_format check (phone ~ '^[0-9]{10}$'),
  add constraint chk_members_emergency_contact_phone_format check (emergency_contact_phone ~ '^[0-9]{10}$'),
  add constraint chk_members_pincode_format check (pincode ~ '^[0-9]{6}$'),
  add constraint chk_members_aadhaar_number_format check (aadhaar_number ~ '^[0-9]{12}$'),
  add constraint chk_members_email_format check (
    char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  -- A photo path is always under its own member's folder, so purge-member can only ever remove
  -- that member's files.
  add constraint chk_members_photo_url_path check (photo_url ~ ('^' || id || '/original-[0-9]+\.jpg$')),
  add constraint chk_members_photo_thumbnail_url_path check (photo_thumbnail_url ~ ('^' || id || '/thumbnail-[0-9]+\.jpg$'));

alter table fitfine.profiles
  add constraint chk_profiles_full_name_text check (
    char_length(full_name) <= 80
    and full_name !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]');

-- No '-' and no wildcard, so '<code>-' prefixes exactly one branch's member numbers.
alter table fitfine.branches
  add constraint chk_branches_name_text check (
    char_length(name) <= 80
    and name !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_branches_code_format check (code ~ '^[A-Za-z0-9]{1,10}$');

alter table fitfine.plans
  add constraint chk_plans_name_text check (
    char_length(name) <= 80
    and name !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]');

alter table fitfine.roles
  add constraint chk_roles_name_text check (
    char_length(name) <= 80
    and name !~ '[\u0001-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  add constraint chk_roles_description_text check (
    char_length(description) <= 500
    and description !~ '[\u0001-\u0009\u000b-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]');

-- Written only by the Edge Functions, checked anyway. 200 is the renewal form's limit.
alter table fitfine.subscriptions
  add constraint chk_subscriptions_notes_text check (
    char_length(notes) <= 200
    and notes !~ '[\u0001-\u0009\u000b-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]');
