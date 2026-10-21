-- GitHub Actions işlerini Supabase'den zamanında tetikler (pg_cron + pg_net).
--
-- NEDEN: GitHub'ın kendi zamanlayıcısı 19.10.2026'daki Actions arızasından beri bu depoların
-- zamanlanmış çalışmalarının çoğunu düşürüyor (veri güncellemesi günde 19 yerine 1-2 kez,
-- bildirim hazırlıkları hiç). Supabase'deki pg_cron saatinde çalışır ve GitHub'a "şu işi şimdi
-- çalıştır" (workflow_dispatch) isteği gönderir. GitHub'ın kendi zamanlayıcısı da çalışmaya
-- devam eder; iki kaynaktan gelen çalışmalar aynı kuralları izler (gönderildi işareti, zaman
-- penceresi, "yalnızca yeni fiyat varsa derle"), yani çift gönderim ya da gereksiz derleme olmaz.
--
-- KURULUM (bir kez):
--   1) GitHub'da ince ayarlı anahtar oluştur: Settings > Developer settings > Personal access
--      tokens > Fine-grained tokens > Generate. Repository access: valaiso/Analiz ve
--      valaiso/tefas-quant. Permissions > Repository > Actions: Read and write. Başka izin verme.
--   2) Supabase SQL Editor'de anahtarı kasaya koy (anahtarı yalnızca sen yapıştır):
--        select vault.create_secret('<ANAHTAR>', 'github_dispatch_token');
--      Anahtar yenilendiğinde:
--        select vault.update_secret((select id from vault.secrets where name = 'github_dispatch_token'), '<YENI_ANAHTAR>');
--   3) Bu dosyanın tamamını SQL Editor'de çalıştır.
--   4) Kontrol: select jobname, schedule, active from cron.job order by jobname;
--      Son istekler: select id, status_code, created from net._http_response order by created desc limit 10;
--      (204 = GitHub isteği kabul etti)
--
-- Saatler UTC'dir (Türkiye = UTC+3, yaz saati yok).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Tetikleme fonksiyonu ayrı şemada: PostgREST bu şemayı yayınlamaz, yani site üzerinden çağrılamaz.
create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

create or replace function ops.github_dispatch(repo text, workflow text, inputs jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_dispatch_token';
  if token is null then
    raise warning 'github_dispatch_token kasada yok; tetikleme yapılmadı';
    return null;
  end if;
  return net.http_post(
    url := format('https://api.github.com/repos/valaiso/%s/actions/workflows/%s/dispatches', repo, workflow),
    body := jsonb_build_object('ref', 'main', 'inputs', inputs),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'analiz-supabase-cron'
    ),
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function ops.github_dispatch(text, text, jsonb) from public, anon, authenticated;

-- Önceki kurulumdan kalan işler varsa temizlenir (dosya tekrar çalıştırılabilir).
do $$
declare j record;
begin
  for j in select jobname from cron.job where jobname like 'gh-%' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- ---------------------------------------------------------------- Analiz: veri güncelleme
-- TEFAS günün fiyatını 09:00-09:30 TR arası yayımlar: 09:05-11:45 TR arası 20 dakikada bir yoklama.
-- Site zaten güncelse `kontrol` adımı derlemeyi atlar (saniyeler sürer).
select cron.schedule('gh-analiz-veri-yoklama', '5,25,45 6-8 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'update-data.yml', '{"yoklama": "true"}')$$);
-- 19:05 TR doğrulama turu (gün içi fiyat düzeltmeleri).
select cron.schedule('gh-analiz-veri-dogrulama', '5 16 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'update-data.yml', '{"dogrulama": "true"}')$$);

-- -------------------------------------------------------- Analiz: günlük portföy bildirimi
-- 13:05 TR hazırlık (18:00'e kadar bekler), 17:50 TR ikinci hazırlık, 18:25 ve 19:25 TR yedek,
-- 21:40 TR bekçi (bildirim gitmediyse GitHub e-postayla uyarır).
select cron.schedule('gh-analiz-bildirim-1305', '5 10 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'daily-push.yml', '{"mod": "otomatik"}')$$);
select cron.schedule('gh-analiz-bildirim-1750', '50 14 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'daily-push.yml', '{"mod": "otomatik"}')$$);
select cron.schedule('gh-analiz-bildirim-1825', '25 15 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'daily-push.yml', '{"mod": "otomatik"}')$$);
select cron.schedule('gh-analiz-bildirim-1925', '25 16 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'daily-push.yml', '{"mod": "otomatik"}')$$);
select cron.schedule('gh-analiz-bildirim-bekci', '40 18 * * 1-5',
  $$select ops.github_dispatch('Analiz', 'daily-push.yml', '{"mod": "bekci"}')$$);

-- ------------------------------------------- TEFAS Quant: aylık rapor bildirimi (Analiz deposu)
-- Ayın 1'i ve son günü (28-31 arası çalışır; betik yarının 1'i olup olmadığına bakar).
select cron.schedule('gh-tq-bildirim-sabah-0405', '5 1 1,28-31 * *',
  $$select ops.github_dispatch('Analiz', 'tq-report-push.yml', '{"kind": "otomatik-sabah"}')$$);
select cron.schedule('gh-tq-bildirim-sabah-0920', '20 6 1,28-31 * *',
  $$select ops.github_dispatch('Analiz', 'tq-report-push.yml', '{"kind": "otomatik-sabah"}')$$);
select cron.schedule('gh-tq-bildirim-aksam-1305', '5 10 1,28-31 * *',
  $$select ops.github_dispatch('Analiz', 'tq-report-push.yml', '{"kind": "otomatik-aksam"}')$$);
select cron.schedule('gh-tq-bildirim-aksam-1825', '25 15 1,28-31 * *',
  $$select ops.github_dispatch('Analiz', 'tq-report-push.yml', '{"kind": "otomatik-aksam"}')$$);

-- ----------------------------------------------------- TEFAS Quant: günlük derecelendirme
-- 19:05 ve 21:05 TR; site zaten güncelse `kontrol` adımı derlemeyi atlar.
select cron.schedule('gh-tq-veri-1905', '5 16 * * 1-5',
  $$select ops.github_dispatch('tefas-quant', 'update.yml', '{"yoklama": "true"}')$$);
select cron.schedule('gh-tq-veri-2105', '5 18 * * 1-5',
  $$select ops.github_dispatch('tefas-quant', 'update.yml', '{"yoklama": "true"}')$$);

-- ------------------------------------------------------ TEFAS Quant: aylık rapor e-postası
-- Ayın 1'i 13:05 TR hazırlık (17:15'e kadar bekler) ve 18:40 TR yedek; ay içinde bir kez gönderir.
select cron.schedule('gh-tq-eposta-1305', '5 10 1 * *',
  $$select ops.github_dispatch('tefas-quant', 'monthly-report.yml', '{"otomatik": "true"}')$$);
select cron.schedule('gh-tq-eposta-1840', '40 15 1 * *',
  $$select ops.github_dispatch('tefas-quant', 'monthly-report.yml', '{"otomatik": "true"}')$$);

-- pg_cron'un kendi çalışma kayıtları büyümesin: 7 günden eskiler her gece silinir.
select cron.schedule('gh-kayit-temizligi', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
