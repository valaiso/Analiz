-- Günlük bildirim abonelikleri. Supabase → SQL Editor'de bir kez çalıştır.
create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  subscription jsonb not null,
  updated_at   timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

-- Herkes yalnızca kendi cihaz aboneliğini görür, ekler, günceller, siler.
drop policy if exists "kendi aboneligi" on public.push_subscriptions;
create policy "kendi aboneligi" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
