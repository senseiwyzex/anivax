-- ============================================================================
-- Anivax — Supabase şeması (tek seferde SQL Editor'da çalıştırın: ctrl+A, Run)
-- Anon/publishable anahtar yalnızca "okuma + kendi satırı" yetkisine sahiptir;
-- yazımlar auth.users üzerinden açık oturum gerektirir.
-- ============================================================================

-- ---------- GLOBAL İÇERİK TABLOLARI (herkes okur) ----------

create table if not exists public.library (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.library enable row level security;
drop policy if exists library_read on public.library;
create policy library_read on public.library for select using (true);
drop policy if exists library_admin on public.library; -- write oturum açan
drop policy if exists library_admin_insert on public.library;
create policy library_admin_insert on public.library for insert with check (auth.uid() is not null);
create policy library_admin_update on public.library for update using (auth.uid() is not null);
create policy library_admin_delete on public.library for delete using (auth.uid() is not null);

create table if not exists public.categories (
  id         text primary key,
  name       text not null,
  slug       text,
  anime_ids  jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.categories enable row level security;
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select using (true);
create policy categories_admin_insert on public.categories for insert with check (auth.uid() is not null);
create policy categories_admin_update on public.categories for update using (auth.uid() is not null);
create policy categories_admin_delete on public.categories for delete using (auth.uid() is not null);

create table if not exists public.site_config (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.site_config enable row level security;
drop policy if exists site_config_read on public.site_config;
create policy site_config_read on public.site_config for select using (true);
create policy site_config_admin_insert on public.site_config for insert with check (auth.uid() is not null);
create policy site_config_admin_update on public.site_config for update using (auth.uid() is not null);

-- Hata kaydı: anonim istemciler ekleyebilir, okuma yalnızca oturum açana aittir.
create table if not exists public.error_logs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    text default 'anon',
  is_admin   boolean not null default false,
  source     text default 'general',
  message    text not null,
  stack      text,
  context    text,
  url        text
);
alter table public.error_logs enable row level security;
drop policy if exists error_logs_insert on public.error_logs;
create policy error_logs_insert on public.error_logs for insert with check (true);
drop policy if exists error_logs_read on public.error_logs;
create policy error_logs_read on public.error_logs for select using (auth.uid() is not null);
drop policy if exists error_logs_delete on public.error_logs;
create policy error_logs_delete on public.error_logs for delete using (auth.uid() is not null);


-- ------------------ KULLANICI TABLONLARI (RLS kullanıcı başına) ------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text,
  display_name text,
  lists_public boolean not null default false,
  custom_lists jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (auth.uid() = id);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (auth.uid() = id);

-- Yeni kayıt olduğunda profiles satırını otomatik oluştur.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, new.raw_user_meta_data->>'username', new.raw_user_meta_data->>'full_name');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.user_anime_status (
  user_id    uuid not null references auth.users (id) on delete cascade,
  anime_id   text not null,
  status     text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id)
);
alter table public.user_anime_status enable row level security;
drop policy if exists uas_select on public.user_anime_status;
create policy uas_select on public.user_anime_status for select using (auth.uid() = user_id);
create policy uas_insert on public.user_anime_status for insert with check (auth.uid() = user_id);
create policy uas_update on public.user_anime_status for update using (auth.uid() = user_id);
create policy uas_delete on public.user_anime_status for delete using (auth.uid() = user_id);
create index if not exists uas_user on public.user_anime_status (user_id);

create table if not exists public.user_ratings (
  user_id    uuid not null references auth.users (id) on delete cascade,
  anime_id   text not null,
  rating     integer not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id)
);
alter table public.user_ratings enable row level security;
drop policy if exists ur_select on public.user_ratings;
create policy ur_select on public.user_ratings for select using (auth.uid() = user_id);
create policy ur_insert on public.user_ratings for insert with check (auth.uid() = user_id);
create policy ur_update on public.user_ratings for update using (auth.uid() = user_id);
create policy ur_delete on public.user_ratings for delete using (auth.uid() = user_id);
create index if not exists ur_user on public.user_ratings (user_id);

create table if not exists public.episode_progress (
  user_id    uuid not null references auth.users (id) on delete cascade,
  anime_id   text not null,
  episode    integer not null,
  watched    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id, episode)
);
alter table public.episode_progress enable row level security;
drop policy if exists ep_select on public.episode_progress;
create policy ep_select on public.episode_progress for select using (auth.uid() = user_id);
create policy ep_insert on public.episode_progress for insert with check (auth.uid() = user_id);
create policy ep_update on public.episode_progress for update using (auth.uid() = user_id);
create policy ep_delete on public.episode_progress for delete using (auth.uid() = user_id);
create index if not exists ep_user on public.episode_progress (user_id);

create table if not exists public.watch_history (
  user_id         uuid not null references auth.users (id) on delete cascade,
  anime_id        text not null,
  base_id         text,
  episode         integer not null default 1,
  progress_seconds numeric not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (user_id, anime_id)
);
alter table public.watch_history enable row level security;
drop policy if exists wh_select on public.watch_history;
create policy wh_select on public.watch_history for select using (auth.uid() = user_id);
create policy wh_insert on public.watch_history for insert with check (auth.uid() = user_id);
create policy wh_update on public.watch_history for update using (auth.uid() = user_id);
create policy wh_delete on public.watch_history for delete using (auth.uid() = user_id);
create index if not exists wh_user on public.watch_history (user_id);

-- Tüm tablolarda updated_at'i otomatik taze layan trigger.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['library','categories','site_config','profiles','user_anime_status','user_ratings','episode_progress','watch_history']
  loop
    execute format('drop trigger if exists %I on %I.%I;', 'set_updated_at', 'public', t);
    execute format('create trigger %I before update on %I.%I for each row execute function public.touch_updated_at();', 'set_updated_at', 'public', t);
  end loop;
end $$;


-- ============================================================================
-- AZ Altyazı cache'i — Supabase Storage bucket "az-subs"
-- (gemini-proxy edge function + tarayıcıdan anon yazma/okuma)
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('az-subs', 'az-subs', true)
on conflict (id) do update set public = true;

drop policy if exists az_subs_anon_insert on storage.objects;
create policy az_subs_anon_insert on storage.objects
  for insert to anon with check (bucket_id = 'az-subs');

drop policy if exists az_subs_anon_update on storage.objects;
create policy az_subs_anon_update on storage.objects
  for update to anon using (bucket_id = 'az-subs');

drop policy if exists az_subs_anon_delete on storage.objects;
create policy az_subs_anon_delete on storage.objects
  for delete to anon using (bucket_id = 'az-subs');

drop policy if exists az_subs_anon_select on storage.objects;
create policy az_subs_anon_select on storage.objects
  for select to anon using (bucket_id = 'az-subs');