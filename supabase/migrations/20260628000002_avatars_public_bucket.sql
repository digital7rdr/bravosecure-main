-- Public 'avatars' bucket for user/CPO/service-provider profile photos.
-- The mobile + ops clients talk to Supabase Storage with the ANON key (the app
-- owns auth via its own Argon2id+JWT, not Supabase Auth), so the object policies
-- target the anon/authenticated roles rather than auth.uid().
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

-- Public read is served by the /object/public endpoint, but keep an explicit
-- SELECT policy so RLS-gated reads also succeed.
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

drop policy if exists "avatars_anon_insert" on storage.objects;
create policy "avatars_anon_insert"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'avatars');

-- UPDATE is needed for upsert (re-uploading a new photo to the same path).
drop policy if exists "avatars_anon_update" on storage.objects;
create policy "avatars_anon_update"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'avatars')
  with check (bucket_id = 'avatars');
