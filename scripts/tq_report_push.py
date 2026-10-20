"""TEFAS Quant aylık rapor bildirimleri (Web Push, TEFAS Quant ana ekran uygulamasına).

    python scripts/tq_report_push.py --slot sabah|aksam [--force rapor|hatirlatma]

Ayın 1'i 09:00   "Bugün raporlarınız gönderilecek"
Ayın 1'i 18:00   "Raporlarınız gönderildi" (TEFAS Quant'ın e-posta işi başarısızsa sorun bildirilir)
Ayın son günü 09:00 ve 18:00   "Yarın raporlarınız gönderilecek" hatırlatması
Başka günlerde bir şey göndermez. İş saatler önce başlar ve hedef saate (İstanbul) kadar bekler;
hedef saat geçtiyse (yedek çalışma) hemen gönderir. Gönderilince tq-push-sent.flag yazılır,
iş akışı bunu önbelleğe kaydeder ve aynı gün/aynı saat için tekrar göndermez.

Abonelikler Supabase push_subscriptions tablosunda, subscription.app == "tefas-quant" olan satırlardır.
Ortam değişkenleri: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY (PEM).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import requests
from pywebpush import WebPushException, webpush

TR = dt.timezone(dt.timedelta(hours=3))  # Türkiye, yaz saati yok
TARGET_HOUR = {"sabah": 9, "aksam": 18}
VAPID_SUBJECT = "mailto:valaiso@users.noreply.github.com"
APP = "tefas-quant"
MAIL_RUNS = "https://api.github.com/repos/valaiso/tefas-quant/actions/workflows/monthly-report.yml/runs?per_page=5"
MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]


def wait_until(target: dt.datetime, max_wait_s: int = 6 * 60 * 60) -> None:
    wait = (target - dt.datetime.now(TR)).total_seconds()
    if 0 < wait <= max_wait_s:
        print(f"{target:%H:%M}'e {int(wait)} sn var, bekleniyor")
        time.sleep(wait)


def mail_ok(today: dt.date) -> bool | None:
    """TEFAS Quant'ın bugünkü aylık e-posta işinin sonucu; okunamazsa ya da bitmediyse None."""
    try:
        runs = requests.get(MAIL_RUNS, timeout=20, headers={"Accept": "application/vnd.github+json"}).json().get("workflow_runs", [])
    except (requests.RequestException, ValueError) as e:
        print(f"e-posta işi okunamadı: {e}")
        return None
    today_runs = [r for r in runs if r.get("status") == "completed"
                  and dt.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00")).astimezone(TR).date() == today]
    if any(r.get("conclusion") == "success" for r in today_runs):
        return True
    if today_runs:
        return False
    return None


def message(kind: str, slot: str, today: dt.date) -> dict:
    if kind == "hatirlatma":
        nxt = today + dt.timedelta(days=1)
        return {"title": "Hatırlatma: Raporlarınız yarın gönderilecek",
                "body": f"{MONTHS[today.month - 1]} ayına ait Portföy ve Model Performans raporlarınız yarın "
                        f"({nxt.day} {MONTHS[nxt.month - 1]}) saat 18:00'e kadar e-posta adresinize gönderilecektir."}
    month = MONTHS[(today.month - 2) % 12]
    if slot == "sabah":
        return {"title": "Bugün raporlarınız gönderilecek",
                "body": f"{month} ayına ait Portföy ve Model Performans raporlarınız bugün saat 18:00'e kadar "
                        "e-posta adresinize gönderilecektir."}
    ok = mail_ok(today)
    if ok is False:
        return {"title": "Rapor gönderiminde sorun oluştu",
                "body": f"{month} ayına ait raporlarınız e-postayla gönderilemedi. Raporları TEFAS Quant'ta "
                        "inceleyebilirsiniz; gönderim kaydı GitHub Actions üzerinde kontrol edilmelidir."}
    if ok is None:
        return {"title": "Raporlarınız gönderiliyor",
                "body": f"{month} ayına ait Portföy ve Model Performans raporlarınız hazırlanmaktadır ve kısa süre "
                        "içinde e-posta adresinize ulaşacaktır."}
    return {"title": "Raporlarınız gönderildi",
            "body": f"{month} ayına ait Portföy ve Model Performans raporlarınız e-posta adresinize gönderilmiştir."}


def supabase(method: str, params: dict) -> requests.Response:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    res = requests.request(method, f"{os.environ['SUPABASE_URL'].rstrip('/')}/rest/v1/push_subscriptions", params=params,
                           timeout=30, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    res.raise_for_status()
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slot", choices=TARGET_HOUR, required=True)
    ap.add_argument("--force", choices=["rapor", "hatirlatma"], help="elle deneme: tarih ve saat beklenmez")
    a = ap.parse_args()

    today = dt.datetime.now(TR).date()
    kind = a.force or ("rapor" if today.day == 1 else "hatirlatma" if (today + dt.timedelta(days=1)).day == 1 else None)
    if not kind:
        print(f"{today}: bildirim günü değil")
        return 0
    if not a.force:
        target = dt.datetime.combine(today, dt.time(TARGET_HOUR[a.slot]), TR)
        now = dt.datetime.now(TR)
        # Gönderim penceresi: hedeften 6 saat önce (hazırlık) ile 3 saat sonra (yedek) arası.
        # GitHub sırası bir yedeği gece yarısından sonra başlatırsa (Analiz'de 19-20.10'da oldu)
        # ertesi günün bildirimi gece gönderilip asıl saatteki bildirim engellenmesin.
        if not target - dt.timedelta(hours=6) <= now <= target + dt.timedelta(hours=3):
            print(f"Gönderim penceresi dışında ({now:%d.%m %H:%M} TR, hedef {target:%H:%M}); bildirim yok")
            return 0
        wait_until(target)

    subs = [r for r in supabase("GET", {"select": "endpoint,subscription"}).json()
            if (r.get("subscription") or {}).get("app") == APP]
    if not subs:
        print("TEFAS Quant aboneliği yok (uygulamada bildirim kurulumu yapılmamış)")
        return 1
    payload = {**message(kind, a.slot, today), "tag": f"tq-{today.isoformat()}-{a.slot}", "url": "/tefas-quant/#/modelrapor"}

    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as key_file:
        key_file.write(os.environ["VAPID_PRIVATE_KEY"].replace("\\n", "\n"))
    sent = failed = 0
    for sub in subs:
        info = {k: v for k, v in sub["subscription"].items() if k != "app"}
        try:
            webpush(subscription_info=info, data=json.dumps(payload, ensure_ascii=False),
                    vapid_private_key=key_file.name, vapid_claims={"sub": VAPID_SUBJECT}, ttl=12 * 3600)
            sent += 1
        except WebPushException as error:
            status = getattr(error.response, "status_code", None)
            if status in (404, 410):
                supabase("DELETE", {"endpoint": f"eq.{sub['endpoint']}"})
                print("süresi dolmuş abonelik silindi")
            else:
                failed += 1
                print(f"gönderilemedi: {error}")
    print(f"{payload['title']} · {sent} cihaza gönderildi, {failed} hata")
    if sent and not a.force:
        Path("tq-push-sent.flag").write_text(f"{today} {a.slot}", encoding="utf-8")
    return 0 if sent else 1


if __name__ == "__main__":
    sys.exit(main())
