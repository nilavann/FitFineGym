-- Storage: the member-photos bucket and its policies. Safe to run again: the bucket is upserted
-- and every policy is dropped before it is created.
--
-- The bucket checks the type the client declares, not the file's bytes. Files are served from the
-- Supabase domain, never the app's, so a mislabelled file can't run script on the app's origin.
-- image/svg+xml is never allowed: an SVG can carry script.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-photos', 'member-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Any active user. Writes only at the path shape member.service uses,
-- <member_id>/(original|thumbnail)-<timestamp>.jpg, which chk_members_photo_url_path also requires
-- of the member row. DELETE is new: the app's photo removal works.

drop policy if exists member_photos_select_active_users on storage.objects;
create policy member_photos_select_active_users on storage.objects
  for select to authenticated
  using (bucket_id = 'member-photos' and (select fitfine_private.is_active_user()));

drop policy if exists member_photos_insert_active_users on storage.objects;
create policy member_photos_insert_active_users on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'member-photos' and (select fitfine_private.is_active_user())
    and name ~ '^[1-9][0-9]*/(original|thumbnail)-[0-9]+\.jpg$'
  );

drop policy if exists member_photos_update_active_users on storage.objects;
create policy member_photos_update_active_users on storage.objects
  for update to authenticated
  using (
    bucket_id = 'member-photos' and (select fitfine_private.is_active_user())
    and name ~ '^[1-9][0-9]*/(original|thumbnail)-[0-9]+\.jpg$'
  )
  with check (
    bucket_id = 'member-photos' and (select fitfine_private.is_active_user())
    and name ~ '^[1-9][0-9]*/(original|thumbnail)-[0-9]+\.jpg$'
  );

drop policy if exists member_photos_delete_active_users on storage.objects;
create policy member_photos_delete_active_users on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'member-photos' and (select fitfine_private.is_active_user())
    and name ~ '^[1-9][0-9]*/(original|thumbnail)-[0-9]+\.jpg$'
  );
