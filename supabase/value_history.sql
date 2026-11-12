-- Sunucunun kaydettiği günlük portföy değerleri. Supabase → SQL Editor'de bir kez çalıştır.
-- Günlük bildirim işi (GitHub) her iş günü 18:00'de o günün değerini buraya yazar.
-- Site açıldığında yalnızca kaydı EKSİK günleri buradan doldurur; cihazın kaydettiği
-- değerlerin üzerine yazmaz.
create table if not exists public.portfolio_value_history (
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  value      numeric not null check (value > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.portfolio_value_history enable row level security;

-- Kullanıcı yalnızca kendi kayıtlarını okur. Yazma yalnızca sunucu (service role) ile yapılır.
drop policy if exists "kendi degerleri" on public.portfolio_value_history;
create policy "kendi degerleri" on public.portfolio_value_history
  for select to authenticated
  using (auth.uid() = user_id);
