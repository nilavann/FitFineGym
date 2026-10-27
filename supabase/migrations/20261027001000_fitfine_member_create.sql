-- Member create (spec/backend/edge-function-structure.md, create-member). The create-member Edge
-- Function registers a member and stores their photo in one request. Both writes go through
-- these two Edge Function RPCs (service_role only), like every other service-role write: each
-- starts with act_as(p_caller_id), so created_by / changed_by / audit_log name the caller, and
-- re-checks the caller's access with access_of.
--
-- Refusals raise a named error whose SQLSTATE is a PostgREST status (PT400, PT403, PT404, PT409),
-- as in the other API functions. The constraints (chk_members_*) and the triggers
-- (generate_member_number, set_audit_fields, audit_row_changes) stay the authority: this function
-- adds no rule of its own beyond giving the three refusals a client can act on a stable status.

-- Registers a member. p_member holds the business columns (the request the Edge Function already
-- validated); member_number comes from the trigger, never from p_member. Returns the new row.
create function fitfine.create_member(p_caller_id uuid, p_member jsonb)
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

  perform 1 from fitfine.branches b where b.id = v_branch_id and b.deleted_at is null for share;
  if not found then
    raise exception 'branch_id does not reference an active branch' using errcode = 'PT400';
  end if;
  if v_handled_by is not null then
    perform 1 from fitfine.profiles p where p.id = v_handled_by and p.deleted_at is null;
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
      if v_constraint = 'idx_members_phone_active' then
        raise exception 'A member with this phone number already exists' using errcode = 'PT409';
      end if;
      raise;
  end;

  return pg_catalog.to_jsonb(v_member);
end;
$$;

-- Stores the two photo paths on a member. chk_members_photo_url_path and
-- chk_members_photo_thumbnail_url_path still require each path to sit under the member's own
-- folder.
create function fitfine.set_member_photo(p_caller_id uuid, p_member_id bigint, p_photo_url text, p_thumbnail_url text)
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
  where m.id = p_member_id and m.deleted_at is null;
  if not found then
    raise exception 'Member % not found', p_member_id using errcode = 'PT404';
  end if;
end;
$$;

revoke all on function
  fitfine.create_member(uuid, jsonb),
  fitfine.set_member_photo(uuid, bigint, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  fitfine.create_member(uuid, jsonb),
  fitfine.set_member_photo(uuid, bigint, text, text)
to service_role;
