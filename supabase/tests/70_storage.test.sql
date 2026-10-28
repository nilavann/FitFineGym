-- Storage: the member-photos bucket settings and
-- its four policies. Storage writes rows in storage.objects as the caller, so each check writes
-- that row directly, as the Storage API would for that caller.
\set QUIET on
begin;
\ir framework.sql
select t.seed();

insert into storage.objects (bucket_id, name) values ('member-photos', '1/original-1700000000000.jpg');

select t.eq('the bucket is private, 5 MiB, JPEG/PNG/WebP and no SVG',
  (select public::text || '|' || file_size_limit || '|' || array_to_string(allowed_mime_types, ',')
   from storage.buckets where id = 'member-photos'),
  'false|5242880|image/jpeg,image/png,image/webp');

-- An active user: read, upload, replace and delete at an app-shaped path.
select t.eq('an active user reads a photo', t.try('authenticated', t.uid('staff'),
  'select 1 from storage.objects where bucket_id = ''member-photos'''), 'rows:1');
select t.runs('an active user uploads an original', 'authenticated', t.uid('staff'),
  'insert into storage.objects (bucket_id, name) values (''member-photos'', ''2/original-1700000000001.jpg'')');
select t.runs('an active user uploads a thumbnail', 'authenticated', t.uid('staff'),
  'insert into storage.objects (bucket_id, name) values (''member-photos'', ''2/thumbnail-1700000000001.jpg'')');
select t.eq('an active user replaces a photo', t.try('authenticated', t.uid('staff'),
  'update storage.objects set metadata = ''{}'' where name = ''1/original-1700000000000.jpg'''), 'rows:1');
select t.eq('an active user deletes a photo', t.try('authenticated', t.uid('staff'),
  'delete from storage.objects where name = ''1/original-1700000000000.jpg'''), 'rows:1');

-- The same user, at any other path.
do $$
declare v text;
begin
  foreach v in array array['x.jpg', '1/a.html', '../1/original-1.jpg', '1/original-1.png', '1/original-1.jpg/x',
                           '0/original-1.jpg', '1/original-.jpg', '1/../2/original-1.jpg', '/1/original-1.jpg'] loop
    perform t.raises(format('no upload at %s', v), 'authenticated', t.uid('staff'),
      format('insert into storage.objects (bucket_id, name) values (''member-photos'', %L)', v), '42501');
  end loop;
end $$;
insert into storage.objects (bucket_id, name) values ('member-photos', '1/notes.txt');
select t.eq('no delete at another path', t.try('authenticated', t.uid('staff'),
  'delete from storage.objects where name = ''1/notes.txt'''), 'rows:0');
select t.eq('no replace at another path', t.try('authenticated', t.uid('staff'),
  'update storage.objects set metadata = ''{}'' where name = ''1/notes.txt'''), 'rows:0');
select t.raises('no rename of a photo to another path', 'authenticated', t.uid('staff'),
  'update storage.objects set name = ''1/evil.html'' where name = ''1/original-1700000000000.jpg''', '42501');

-- Other buckets: no policy, so nothing.
insert into storage.buckets (id, name) values ('t-other', 't-other');
insert into storage.objects (bucket_id, name) values ('t-other', '1/original-1.jpg');
select t.eq('an active user reads nothing in another bucket', t.try('authenticated', t.uid('staff'),
  'select 1 from storage.objects where bucket_id = ''t-other'''), 'rows:0');
select t.raises('an active user uploads nothing to another bucket', 'authenticated', t.uid('staff'),
  'insert into storage.objects (bucket_id, name) values (''t-other'', ''1/original-2.jpg'')', '42501');

-- An inactive user, a user without a role, and anon: none of it.
do $$
declare v_who text;
begin
  foreach v_who in array array['inactive', 'norole', 'nop'] loop
    perform t.eq(format('%s reads no photo', v_who), t.try('authenticated', t.uid(v_who),
      'select 1 from storage.objects where bucket_id = ''member-photos'''), 'rows:0');
    perform t.raises(format('%s uploads no photo', v_who), 'authenticated', t.uid(v_who),
      'insert into storage.objects (bucket_id, name) values (''member-photos'', ''3/original-1.jpg'')', '42501');
    perform t.eq(format('%s deletes no photo', v_who), t.try('authenticated', t.uid(v_who),
      'delete from storage.objects where bucket_id = ''member-photos'''), 'rows:0');
  end loop;
end $$;
select t.eq('anon reads no photo', t.try('anon', null, 'select 1 from storage.objects where bucket_id = ''member-photos'''), 'rows:0');
select t.raises('anon uploads no photo', 'anon', null,
  'insert into storage.objects (bucket_id, name) values (''member-photos'', ''3/original-1.jpg'')', '42501');

select t.eq('the four policies are TO authenticated',
  (select string_agg(cmd || ':' || array_to_string(roles, ','), ' ' order by cmd) from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname like 'member_photos_%'),
  'DELETE:authenticated INSERT:authenticated SELECT:authenticated UPDATE:authenticated');

rollback;
