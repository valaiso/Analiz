"""Her işlem günü 18:00'de (TR) portföyün günlük değişimini telefona bildirir.

Supabase'deki her bildirim aboneliği için kullanıcının son Midas pozisyonları
(portfolio_state.state_json.midasPositionsCloud) okunur. Hisse/ETF/kripto için
Yahoo Finance'ın güncel fiyatı ve önceki kapanışı, fonlar için sitenin son
TEFAS fiyatı ve günlük değişimi kullanılır. Bildirim Web Push ile gönderilir.

Ortam değişkenleri: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY (PEM).
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
import time

import requests
from pywebpush import WebPushException, webpush

SITE_URL = "https://valaiso.github.io/Analiz"
FUND_KINDS = {"YAT", "EMK", "GYF", "GSYF"}
NO_DAILY_CHANGE = {"THF", "TP2"}
UA = {"User-Agent": "Mozilla/5.0 (Analiz daily push)"}
SEND_AT_UTC = dt.time(15, 0)  # 18:00 Türkiye (UTC+3, yaz saati yok)


def wait_until_send_time(max_wait_s: int = 30 * 60) -> None:
    """GitHub zamanlayıcısı birkaç dakika erken/geç başlayabilir; 18:00'i bekle."""
    now = dt.datetime.now(dt.timezone.utc)
    target = now.replace(hour=SEND_AT_UTC.hour, minute=SEND_AT_UTC.minute, second=0, microsecond=0)
    wait = (target - now).total_seconds()
    if 0 < wait <= max_wait_s:
        print(f"18:00'e {int(wait)} sn var, bekleniyor")
        time.sleep(wait)


def supabase_get(path: str, params: dict) -> list:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    res = requests.get(f"{base}/rest/v1/{path}", params=params, timeout=30,
                       headers={"apikey": key, "Authorization": f"Bearer {key}"})
    res.raise_for_status()
    return res.json()


def supabase_delete_subscription(endpoint: str) -> None:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    requests.delete(f"{base}/rest/v1/push_subscriptions", params={"endpoint": f"eq.{endpoint}"}, timeout=30,
                    headers={"apikey": key, "Authorization": f"Bearer {key}"})


_quote_cache: dict[str, tuple[float, float] | None] = {}


def yahoo_quote(ticker: str) -> tuple[float, float] | None:
    """(güncel fiyat, önceki kapanış) ya da None."""
    if ticker in _quote_cache:
        return _quote_cache[ticker]
    result = None
    for attempt in range(3):
        try:
            res = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
                               params={"range": "1d", "interval": "1d"}, headers=UA, timeout=20)
            if res.status_code == 404:
                break
            res.raise_for_status()
            meta = (res.json().get("chart", {}).get("result") or [{}])[0].get("meta", {})
            price = meta.get("regularMarketPrice")
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            if price and prev and price > 0 and prev > 0:
                result = (float(price), float(prev))
            break
        except requests.RequestException:
            time.sleep(2 * (attempt + 1))
    _quote_cache[ticker] = result
    return result


def fmt_tr(value: float, decimals: int = 2) -> str:
    text = f"{abs(value):,.{decimals}f}"
    return text.replace(",", "X").replace(".", ",").replace("X", ".")


def portfolio_change(cloud: dict, funds: dict) -> tuple[float, float, list[str]]:
    """(şimdiki değer, önceki değer, fiyatı bulunamayan kodlar) — ₺ cinsinden."""
    usd = yahoo_quote("USDTRY=X")
    if not usd:
        raise RuntimeError("USD/TRY kuru alınamadı")
    usd_now, usd_prev = usd
    now_total = prev_total = 0.0
    missing: list[str] = []

    def add(units: float, now_price: float, prev_price: float, currency: str) -> None:
        nonlocal now_total, prev_total
        fx_now, fx_prev = (usd_now, usd_prev) if currency == "USD" else (1.0, 1.0)
        now_total += units * now_price * fx_now
        prev_total += units * prev_price * fx_prev

    for row in cloud.get("positions") or []:
        code, units = str(row.get("code", "")).upper(), float(row.get("units") or 0)
        if not code or units <= 0:
            continue
        meta = funds.get(code, {})
        kind = str(meta.get("kind", "")).upper()
        currency = row.get("currency") or meta.get("currency") or ("USD" if kind.startswith("US_") else "TRY")
        if kind in FUND_KINDS or (code in NO_DAILY_CHANGE):
            price = float(meta.get("price") or row.get("price") or 0)
            if price <= 0:
                missing.append(code)
                continue
            chg = 0.0 if code in NO_DAILY_CHANGE else float(meta.get("chg") or 0)
            add(units, price, price / (1 + chg / 100), "TRY")
            continue
        ticker = code if currency == "USD" or kind.startswith("US_") else f"{code}.IS"
        quote = yahoo_quote(ticker)
        if not quote:
            missing.append(code)
            continue
        add(units, quote[0], quote[1], currency)

    for row in cloud.get("cryptoPositions") or []:
        code, units = str(row.get("code", "")).upper(), float(row.get("units") or 0)
        if not code or units <= 0 or code in {"USDT", "USDC"}:
            continue
        quote = yahoo_quote(f"{code}-USD")
        if not quote:
            missing.append(code)
            continue
        add(units, quote[0], quote[1], "USD")
    return now_total, prev_total, missing


def main() -> int:
    force = os.environ.get("FORCE_SEND") == "true"  # elle deneme: hafta sonu ve saat beklenmez
    if not force and dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).weekday() >= 5:
        print("Hafta sonu; bildirim yok")
        return 0
    if not force:
        wait_until_send_time()
    subs = supabase_get("push_subscriptions", {"select": "user_id,endpoint,subscription"})
    if not subs:
        print("Abonelik yok")
        return 0
    user_ids = sorted({row["user_id"] for row in subs})
    states = supabase_get("portfolio_state", {
        "select": "user_id,state_json", "user_id": f"in.({','.join(user_ids)})"})
    state_by_user = {row["user_id"]: row.get("state_json") or {} for row in states}
    funds = {f["code"]: f for f in requests.get(f"{SITE_URL}/data/funds.json", timeout=60).json()}

    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as key_file:
        key_file.write(os.environ["VAPID_PRIVATE_KEY"].replace("\\n", "\n"))
    sent = failed = 0
    for user_id in user_ids:
        user_subs = sum(1 for row in subs if row["user_id"] == user_id)
        cloud = state_by_user.get(user_id, {}).get("midasPositionsCloud")
        if not cloud:
            print(f"{user_id[:8]}: {user_subs} cihaz aboneliği var ama hesapta Midas pozisyonu yok; "
                  "siteyi Midas verisinin olduğu bilgisayarda bir kez açın")
            continue
        now_total, prev_total, missing = portfolio_change(cloud, funds)
        if prev_total <= 0:
            continue
        change = now_total - prev_total
        pct = change / prev_total * 100
        up = change >= 0
        sign = "+" if up else "−"
        payload = {
            "title": f"{'🟢' if up else '🔴'} Portföy bugün {sign}%{fmt_tr(pct)} {'arttı' if up else 'düştü'}",
            "body": f"{sign}₺{fmt_tr(change, 0)} · toplam ₺{fmt_tr(now_total, 0)}"
                    + (f" · fiyatı alınamayan: {', '.join(missing)}" if missing else ""),
            "tag": f"gunluk-{dt.date.today().isoformat()}",
            "url": "/Analiz/#panel",
        }
        print(f"{user_id[:8]}: {user_subs} cihaz · {payload['title']} | {payload['body']}")
        for sub in (row for row in subs if row["user_id"] == user_id):
            try:
                webpush(subscription_info=sub["subscription"], data=json.dumps(payload, ensure_ascii=False),
                        vapid_private_key=key_file.name, vapid_claims={"sub": SITE_URL}, ttl=6 * 3600)
                sent += 1
            except WebPushException as error:
                status = getattr(error.response, "status_code", None)
                if status in (404, 410):
                    supabase_delete_subscription(sub["endpoint"])
                    print("  süresi dolmuş abonelik silindi")
                else:
                    failed += 1
                    print(f"  gönderilemedi: {error}")
    print(f"{sent} bildirim gönderildi, {failed} hata")
    return 1 if failed and not sent else 0


if __name__ == "__main__":
    sys.exit(main())
