-- Local tests only: the pieces of a Supabase project that the migrations in supabase/migrations
-- rely on. The API roles, auth.users / auth.identities / auth.sessions with GoTrue's column
-- shapes (incl. the generated confirmed_at / email columns), auth.uid() as Supabase defines it,
-- and storage.buckets / storage.objects. Applied by supabase/tests/run.sh.

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'supabase_auth_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema auth;
create schema storage;
create schema extensions;

create table auth.users (
  instance_id         uuid,
  id                  uuid primary key,
  aud                 varchar(255),
  role                varchar(255),
  email               varchar(255),
  encrypted_password  varchar(255),
  email_confirmed_at  timestamptz,
  invited_at          timestamptz,
  confirmation_token  varchar(255),
  recovery_token      varchar(255),
  last_sign_in_at     timestamptz,
  raw_app_meta_data   jsonb,
  raw_user_meta_data  jsonb,
  is_super_admin      boolean,
  created_at          timestamptz,
  updated_at          timestamptz,
  phone               text unique default null,
  phone_confirmed_at  timestamptz,
  confirmed_at        timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  banned_until        timestamptz,
  deleted_at          timestamptz,
  is_sso_user         boolean not null default false,
  is_anonymous        boolean not null default false
);
create unique index users_email_partial_key on auth.users (email) where is_sso_user = false;

create table auth.identities (
  provider_id      text not null,
  user_id          uuid not null references auth.users (id) on delete cascade,
  identity_data    jsonb not null,
  provider         text not null,
  last_sign_in_at  timestamptz,
  created_at       timestamptz,
  updated_at       timestamptz,
  email            text generated always as (lower(identity_data ->> 'email')) stored,
  id               uuid primary key default gen_random_uuid(),
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);

create table auth.sessions (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz
);

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;

create table storage.buckets (
  id                  text primary key,
  name                text not null,
  owner               uuid,
  public              boolean default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets (id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
alter table storage.objects enable row level security;
