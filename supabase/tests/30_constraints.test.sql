-- The new check constraints: set A rejects bad values and
-- accepts the edge cases; every set B constraint, written directly as authenticated (the way the
-- frontend writes), rejects what it must and accepts real text. Every rejection must come from the
-- constraint named, not from some other rule. Special characters are built with chr(), so no
-- invisible character sits in this file.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

-- Set A ---------------------------------------------------------------------------------------

select t.raises('chk_members_name_not_blank rejects spaces', 'authenticated', t.uid('staff'),
  'update fitfine.members set name = ''   '' where phone = ''5550000001''', '23514', '%chk_members_name_not_blank%');
select t.raises('chk_members_emergency_contact_relationship_not_blank rejects an empty string', 'authenticated', t.uid('staff'),
  'update fitfine.members set emergency_contact_relationship = '''' where phone = ''5550000001''', '23514',
  '%chk_members_emergency_contact_relationship_not_blank%');
select t.raises('chk_profiles_full_name_not_blank rejects spaces', 'authenticated', t.uid('staff'),
  format('update fitfine.profiles set full_name = '' '' where id = %L', t.uid('staff')), '23514', '%chk_profiles_full_name_not_blank%');

select t.raises('chk_configuration_member_number_positive_int rejects 0', 'service_role', null,
  'update fitfine.configuration set value = ''0'' where key = ''member_number_increment''', '23514',
  '%chk_configuration_member_number_positive_int%');
select t.raises('chk_configuration_member_number_positive_int rejects -1', 'service_role', null,
  'update fitfine.configuration set value = ''-1'' where key = ''member_number_padding_width''', '23514',
  '%chk_configuration_member_number_positive_int%');
select t.raises('chk_configuration_member_number_positive_int rejects 1.5', 'service_role', null,
  'update fitfine.configuration set value = ''1.5'' where key = ''member_number_start_sequence''', '23514',
  '%chk_configuration_member_number_positive_int%');
select t.runs('chk_configuration_member_number_positive_int leaves other keys free text', 'service_role', null,
  'insert into fitfine.configuration (key, value) values (''some_other_key'', ''any text'')');

select t.raises('chk_subscription_items_end_after_start rejects an end before the start', 'service_role', null,
  'update fitfine.subscription_items set end_date = start_date - 1 where true', '23514', '%chk_subscription_items_end_after_start%');
select t.runs('chk_subscription_items_end_after_start accepts a one-day item', 'service_role', null,
  'update fitfine.subscription_items set end_date = start_date where true');

-- Set B: text --------------------------------------------------------------------------------
-- One row per *_text constraint: who writes the column directly, and the row it writes.

create table t.text_cols (con text, tbl text, col text, max_len int, multi boolean, nullable boolean, who text, row_where text);
insert into t.text_cols values
  ('chk_members_name_text',                            'members',       'name',                           80,   false, false, 'staff', 'phone = ''5550000001'''),
  ('chk_members_emergency_contact_name_text',          'members',       'emergency_contact_name',         80,   false, false, 'staff', 'phone = ''5550000001'''),
  ('chk_members_occupation_text',                      'members',       'occupation',                     80,   false, true,  'staff', 'phone = ''5550000001'''),
  ('chk_members_emergency_contact_relationship_text',  'members',       'emergency_contact_relationship', 40,   false, false, 'staff', 'phone = ''5550000001'''),
  ('chk_members_residential_address_text',             'members',       'residential_address',            500,  true,  true,  'staff', 'phone = ''5550000001'''),
  ('chk_members_doctor_care_details_text',             'members',       'doctor_care_details',            1000, true,  true,  'staff', 'phone = ''5550000001'''),
  ('chk_profiles_full_name_text',                      'profiles',      'full_name',                      80,   false, false, 'staff', format('id = %L', t.uid('staff'))),
  ('chk_branches_name_text',                           'branches',      'name',                           80,   false, false, 'admin', 'code = ''TA'''),
  ('chk_plans_name_text',                              'plans',         'name',                           80,   false, false, 'admin', 'name = ''T Monthly'''),
  ('chk_roles_name_text',                              'roles',         'name',                           80,   false, false, 'admin', 'name = ''staff'''),
  ('chk_roles_description_text',                       'roles',         'description',                    500,  true,  true,  'admin', 'name = ''staff'''),
  -- subscriptions.notes is written only by the Edge Function RPCs; checked through the service role.
  ('chk_subscriptions_notes_text',                     'subscriptions', 'notes',                          200,  true,  true,  'service_role', 'true');

do $$
declare
  c        record;
  v_role   text;
  v_uid    uuid;
  v_sql    text;
  v_bad    text[];
  v_good   text[];
  v_label  text[];
  v_glabel text[];
  i        int;
  -- Hindi (with a virama and ZWJ) and Malayalam (a chillu with ZWJ, then ZWNJ): ordinary names.
  v_hindi     text := chr(2325) || chr(2381) || chr(8205) || chr(2359) || chr(2375) || chr(2340) || chr(2381) || chr(2352);
  v_malayalam text := chr(3384) || chr(3405) || chr(8205) || chr(3368) || chr(3375) || chr(8204) || chr(3374);
begin
  for c in select * from t.text_cols loop
    v_role := case when c.who = 'service_role' then 'service_role' else 'authenticated' end;
    v_uid  := case when c.who = 'service_role' then null else t.uid(c.who) end;

    v_bad   := array[repeat('a', c.max_len + 1), 'a' || chr(1) || 'b', 'a' || chr(9) || 'b',
                     'a' || chr(8238) || 'b', 'a' || chr(8203) || 'b', 'a' || chr(65279) || 'b', 'a' || chr(127) || 'b'];
    v_label := array['one character over the limit', 'U+0001', 'tab', 'U+202E', 'U+200B', 'U+FEFF', 'DEL'];
    if not c.multi then
      v_bad := v_bad || ('a' || chr(10) || 'b'); v_label := v_label || 'a line feed'::text;
    end if;
    for i in 1 .. array_length(v_bad, 1) loop
      v_sql := format('update fitfine.%I set %I = %L where %s', c.tbl, c.col, v_bad[i], c.row_where);
      perform t.raises(format('%s rejects %s', c.con, v_label[i]), v_role, v_uid, v_sql, '23514', '%' || c.con || '%');
    end loop;

    v_good   := array[repeat('b', c.max_len), v_hindi, v_malayalam, '<script>alert(1)</script>', 'O''Brien'];
    v_glabel := array['exactly the limit', 'Hindi with ZWJ', 'Malayalam with ZWJ and ZWNJ', 'markup, as plain text', 'O''Brien'];
    if c.multi then
      v_good := v_good || ('line one' || chr(10) || 'line two'); v_glabel := v_glabel || 'a line feed'::text;
    end if;
    for i in 1 .. array_length(v_good, 1) loop
      -- Each t.try is rolled back before the next, so a value unique among active rows never
      -- collides with an earlier case.
      v_sql := format('update fitfine.%I set %I = %L where %s', c.tbl, c.col, v_good[i], c.row_where);
      perform t.runs(format('%s accepts %s', c.con, v_glabel[i]), v_role, v_uid, v_sql);
    end loop;
    if c.nullable then
      perform t.runs(format('%s accepts NULL', c.con), v_role, v_uid,
        format('update fitfine.%I set %I = null where %s', c.tbl, c.col, c.row_where));
    end if;
  end loop;
end $$;

-- Markup is stored exactly as typed: it is React's job to escape it on display.
do $$
begin
  perform t.login('staff');
  update fitfine.members set name = '<b>Bold</b> & "quoted"' where phone = '5550000001';
  perform t.logout();
end $$;
select t.eq('text is stored unchanged, never escaped',
  (select name from fitfine.members where phone = '5550000001'), '<b>Bold</b> & "quoted"');

-- Set B: formats -----------------------------------------------------------------------------

create table t.format_cases (con text, col text, val text, ok boolean);
insert into t.format_cases values
  ('chk_members_phone_format', 'phone', '9876543210', true),
  ('chk_members_phone_format', 'phone', '98765 43210', false),
  ('chk_members_phone_format', 'phone', '+919876543210', false),
  ('chk_members_phone_format', 'phone', '987654321', false),
  ('chk_members_phone_format', 'phone', 'abcdefghij', false),
  ('chk_members_emergency_contact_phone_format', 'emergency_contact_phone', '9876543211', true),
  ('chk_members_emergency_contact_phone_format', 'emergency_contact_phone', '98765-43211', false),
  ('chk_members_emergency_contact_phone_format', 'emergency_contact_phone', '98765432110', false),
  ('chk_members_pincode_format', 'pincode', '400050', true),
  ('chk_members_pincode_format', 'pincode', null, true),
  ('chk_members_pincode_format', 'pincode', '40005', false),
  ('chk_members_pincode_format', 'pincode', '4000501', false),
  ('chk_members_pincode_format', 'pincode', '400 05', false),
  ('chk_members_aadhaar_number_format', 'aadhaar_number', '123456789012', true),
  ('chk_members_aadhaar_number_format', 'aadhaar_number', null, true),
  ('chk_members_aadhaar_number_format', 'aadhaar_number', '1234 5678 9012', false),
  ('chk_members_aadhaar_number_format', 'aadhaar_number', '12345678901', false),
  ('chk_members_email_format', 'email', 'asha@example.com', true),
  ('chk_members_email_format', 'email', null, true),
  ('chk_members_email_format', 'email', 'asha@example', false),
  ('chk_members_email_format', 'email', 'asha rao@example.com', false),
  ('chk_members_email_format', 'email', '@example.com', false),
  ('chk_members_email_format', 'email', repeat('a', 243) || '@example.com', false);

do $$
declare c record;
begin
  for c in select * from t.format_cases loop
    if c.ok then
      perform t.runs(format('%s accepts %s', c.con, coalesce(c.val, 'NULL')), 'authenticated', t.uid('staff'),
        format('update fitfine.members set %I = %L where phone = ''5550000001''', c.col, c.val));
    else
      perform t.raises(format('%s rejects %s', c.con, left(c.val, 40)), 'authenticated', t.uid('staff'),
        format('update fitfine.members set %I = %L where phone = ''5550000001''', c.col, c.val), '23514', '%' || c.con || '%');
    end if;
  end loop;
end $$;

-- chk_branches_code_format: no '-', no wildcard, at most 10 characters (F28).
do $$
declare v text;
begin
  foreach v in array array['A-B', 'A%', 'A_', 'A*', 'ABCDEFGHIJK', 'A B'] loop
    perform t.raises(format('chk_branches_code_format rejects %s', v), 'authenticated', t.uid('admin'),
      format('insert into fitfine.branches (name, code) values (''New'', %L)', v), '23514', '%chk_branches_code_format%');
  end loop;
  foreach v in array array['AB12', 'ABCDEFGHIJ', 'x'] loop
    perform t.runs(format('chk_branches_code_format accepts %s', v), 'authenticated', t.uid('admin'),
      format('insert into fitfine.branches (name, code) values (''New'', %L)', v));
  end loop;
end $$;

-- Photo paths: always under the member's own folder (F29).
do $$
declare
  m1 bigint := (select id from fitfine.members where phone = '5550000001');
  m2 bigint := (select id from fitfine.members where phone = '5550000002');
begin
  perform t.runs('chk_members_photo_url_path accepts the member''s own path', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_url = %L, photo_thumbnail_url = %L where id = %s',
           m1 || '/original-1730000000000.jpg', m1 || '/thumbnail-1730000000000.jpg', m1));
  perform t.raises('chk_members_photo_url_path rejects another member''s path', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_url = %L where id = %s', m2 || '/original-1.jpg', m1), '23514', '%chk_members_photo_url_path%');
  perform t.raises('chk_members_photo_url_path rejects a prefix match on a longer id', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_url = %L where id = %s', m1 || '0/original-1.jpg', m1), '23514', '%chk_members_photo_url_path%');
  perform t.raises('chk_members_photo_url_path rejects a name that is not .jpg', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_url = %L where id = %s', m1 || '/original-1.png', m1), '23514', '%chk_members_photo_url_path%');
  perform t.raises('chk_members_photo_url_path rejects a full URL', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_url = %L where id = %s',
           'https://x.supabase.co/storage/v1/object/public/member-photos/' || m1 || '/original-1.jpg', m1), '23514', '%chk_members_photo_url_path%');
  perform t.raises('chk_members_photo_thumbnail_url_path rejects another member''s path', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_thumbnail_url = %L where id = %s', m2 || '/thumbnail-1.jpg', m1), '23514',
    '%chk_members_photo_thumbnail_url_path%');
  perform t.raises('chk_members_photo_thumbnail_url_path rejects an original in the thumbnail column', 'authenticated', t.uid('staff'),
    format('update fitfine.members set photo_thumbnail_url = %L where id = %s', m1 || '/original-1.jpg', m1), '23514',
    '%chk_members_photo_thumbnail_url_path%');
end $$;

rollback;
