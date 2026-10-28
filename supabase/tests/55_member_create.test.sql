-- create_member and set_member_photo (supabase/migrations/20261027001000_fitfine_member_create.sql),
-- called the way the create-member Edge Function calls them: through service_role with the
-- verified caller's id. Every refusal must raise its named error with its PTxxx code.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

create function t.new_member(p_phone text, p_extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object(
    'name', 'Priya Sharma', 'phone', p_phone, 'date_of_birth', '1995-04-02', 'gender', 'Female',
    'weight_kg', 58, 'height_cm', 162, 'under_doctor_care', false,
    'emergency_contact_name', 'Ravi Sharma', 'emergency_contact_phone', '9876543210',
    'emergency_contact_relationship', 'Brother', 'branch_id', t.branch('TA')) || p_extra
$$;

create function t.m_by_phone(p_phone text) returns bigint language sql stable as $$
  select id from fitfine.members where phone = p_phone
$$;

grant execute on function t.new_member(text, jsonb), t.m_by_phone(text) to public;

-- who may call -------------------------------------------------------------------------------
select t.raises('create_member is not executable by authenticated', 'authenticated', t.uid('staff'),
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), t.new_member('5551110001')), '42501');
select t.raises('create_member is not executable by anon', 'anon', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), t.new_member('5551110001')), '42501');
select t.raises('set_member_photo is not executable by authenticated', 'authenticated', t.uid('staff'),
  format('select fitfine.set_member_photo(%L, 1, %L, %L)', t.uid('staff'), '1/original-1.jpg', '1/thumbnail-1.jpg'), '42501');

-- refusals -----------------------------------------------------------------------------------
select t.raises('create_member refuses an inactive caller', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('inactive'), t.new_member('5551110002')), 'PT403', 'Active account required');
select t.raises('create_member refuses a caller without a role', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('norole'), t.new_member('5551110002')), 'PT403');
select t.raises('create_member refuses a missing branch', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), t.new_member('5551110003', '{"branch_id": -1}')), 'PT400',
  'branch_id does not reference an active branch');
select t.raises('create_member refuses a user that does not exist as handled_by_staff', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'),
    t.new_member('5551110004', jsonb_build_object('handled_by_staff', t.uid('nop')))), 'PT400', 'handled_by_staff%');
select t.raises('create_member refuses a body that is not an object', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), '[1]'), 'PT400');
select t.raises('create_member: a phone already in use is a conflict', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), t.new_member('5550000001')), 'PT409',
  'A member with this phone number already exists');
-- The constraints stay the authority: a value they reject is not turned into a PT error.
select t.raises('create_member: a phone of the wrong shape is the constraint''s error', 'service_role', null,
  format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), t.new_member('123')), '23514');

-- success ------------------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_id bigint;
begin
  set local role service_role;
  v := fitfine.create_member(t.uid('staff'), t.new_member('5551110010', jsonb_build_object('handled_by_staff', t.uid('admin'), 'email', 'priya@example.com')));
  reset role;
  v_id := (v ->> 'id')::bigint;

  perform t.ok('create_member returns the new row', v_id is not null and v ->> 'name' = 'Priya Sharma');
  perform t.ok('create_member: member_number comes from the trigger',
    v ->> 'member_number' ~ '^TA-[0-9]{4}-[0-9]+$', v ->> 'member_number');
  perform t.eq('create_member: created_by is the caller', v ->> 'created_by', t.uid('staff')::text);
  perform t.eq('create_member: date_of_joining defaults to today', v ->> 'date_of_joining', current_date::text);
  perform t.eq('create_member: handled_by_staff is stored', v ->> 'handled_by_staff', t.uid('admin')::text);
  perform t.ok('create_member: no photo yet', v ->> 'photo_url' is null and v ->> 'photo_thumbnail_url' is null);
  perform t.ok('create_member: the audit log names the caller',
    exists (select 1 from fitfine.audit_log where table_name = 'members' and record_id = v_id::text
            and field_name = 'name' and operation = 'insert' and changed_by = t.uid('staff')));

  -- A member_number in the body is ignored: the trigger always generates it.
  set local role service_role;
  v := fitfine.create_member(t.uid('staff'), t.new_member('5551110011', '{"member_number": "FAKE-0001"}'));
  reset role;
  perform t.ok('create_member ignores a member_number in the body', v ->> 'member_number' <> 'FAKE-0001', v ->> 'member_number');

  -- Optional fields left blank become NULL.
  set local role service_role;
  v := fitfine.create_member(t.uid('staff'), t.new_member('5551110012', '{"email": "", "occupation": null, "pincode": ""}'));
  reset role;
  perform t.ok('create_member stores blank optional fields as NULL', v ->> 'email' is null and v ->> 'occupation' is null and v ->> 'pincode' is null);

end $$;

-- set_member_photo ---------------------------------------------------------------------------
do $$
declare
  v_id bigint := t.m_by_phone('5551110010');
begin
  perform t.as_service(format('select fitfine.set_member_photo(%L, %s, %L, %L)', t.uid('staff'), v_id,
    v_id || '/original-1700000000000.jpg', v_id || '/thumbnail-1700000000000.jpg'));
  perform t.ok('set_member_photo stores both paths, attributed to the caller',
    exists (select 1 from fitfine.members where id = v_id
            and photo_url = v_id || '/original-1700000000000.jpg'
            and photo_thumbnail_url = v_id || '/thumbnail-1700000000000.jpg'
            and changed_by = t.uid('staff')));
  perform t.raises('set_member_photo: a path under another member''s folder is the constraint''s error', 'service_role', null,
    format('select fitfine.set_member_photo(%L, %s, %L, %L)', t.uid('staff'), v_id, '999999/original-1.jpg', v_id || '/thumbnail-1.jpg'), '23514');
  perform t.raises('set_member_photo: a missing member is not found', 'service_role', null,
    format('select fitfine.set_member_photo(%L, -1, %L, %L)', t.uid('staff'), '-1/original-1.jpg', '-1/thumbnail-1.jpg'), 'PT404');
  perform t.raises('set_member_photo refuses an inactive caller', 'service_role', null,
    format('select fitfine.set_member_photo(%L, %s, %L, %L)', t.uid('inactive'), v_id, v_id || '/original-2.jpg', v_id || '/thumbnail-2.jpg'), 'PT403');
end $$;

-- the views follow the new functions (member_list_view reads members under the caller's RLS) -------------
do $$
declare
  v jsonb;
  v_id bigint;
  v_seen record;
begin
  perform t.as_service(format('select fitfine.create_member(%L, %L::jsonb)', t.uid('staff'), t.new_member('5551110020')));
  v_id := t.m_by_phone('5551110020');
  perform t.as_service(format('select fitfine.set_member_photo(%L, %s, %L, %L)', t.uid('staff'), v_id,
    v_id || '/original-1700000000001.jpg', v_id || '/thumbnail-1700000000001.jpg'));

  perform t.login('staff');
  select * into v_seen from fitfine.member_list_view where id = v_id;
  perform t.logout();
  perform t.ok('member_list_view lists a member created by create_member', v_seen.id = v_id);
  perform t.eq('member_list_view: the generated member_number', v_seen.member_number, (select member_number from fitfine.members where id = v_id));
  perform t.eq('member_list_view: photo_url is the path set_member_photo stored', v_seen.photo_url, v_id || '/original-1700000000001.jpg');
  perform t.eq('member_list_view: photo_thumbnail_url is the path set_member_photo stored', v_seen.photo_thumbnail_url, v_id || '/thumbnail-1700000000001.jpg');
  perform t.ok('member_list_view: a new member has no plan and no add-ons',
    v_seen.current_membership_plan_id is null and v_seen.current_addon_plan_ids = '{}');

  perform t.login('inactive');
  perform t.eq('member_list_view: an inactive user does not see the new member',
    (select count(*) from fitfine.member_list_view where id = v_id), 0::bigint);
  perform t.logout();

  perform t.as_service(format('select fitfine.delete_member(%L, %s)', t.uid('staff'), v_id));
  perform t.login('staff');
  perform t.eq('member_list_view: the member is gone after delete-member',
    (select count(*) from fitfine.member_list_view where id = v_id), 0::bigint);
  perform t.logout();
end $$;

rollback;
