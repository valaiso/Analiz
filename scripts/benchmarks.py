"""Kiyaslama (benchmark) serileri: BIST 100, USD/TRY, gram altin, TUFE.

Kaynaklar:
  * Yahoo Finance chart API  -> XU100.IS, USDTRY=X, GC=F  (anahtar gerekmez)
  * TCMB EVDS                -> TUFE (yalnizca EVDS_API_KEY tanimliysa)

Gram altin TL, ons altin (USD) ve USD/TRY'den turetilir:
    gram_altin = ons_usd / 31.1034768 * usdtry
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request

YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
EVDS3_URL = "https://evds3.tcmb.gov.tr/igmevdsms-dis/series={series}&startDate={start}&endDate={end}&type=json"
EVDS2_URL = "https://evds2.tcmb.gov.tr/service/evds/series={series}&startDate={start}&endDate={end}&type=json"
TUFE_OLD_SERIES = "TP.FG.J0"                  # TÜFE 2003=100; legacy series
TUFE_NEW_SERIES = "TP.TUKFIY2025.GENEL"       # TÜFE 2025=100; current series
TROY_OUNCE_GRAMS = 31.1034768

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def _get_json(url: str, headers: dict | None = None, timeout: int = 45) -> dict:
    hdr = {"User-Agent": _UA, "Accept": "application/json, */*", "Accept-Encoding": "gzip"}
    if headers:
        hdr.update(headers)
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            # Yanıt içeriğini veya istekteki API anahtarını loglama.
            host = urllib.parse.urlparse(url).netloc
            content_type = resp.headers.get("Content-Type", "bilinmiyor")
            raise ValueError(
                f"{host} JSON olmayan yanıt verdi (HTTP {resp.status}, "
                f"Content-Type: {content_type}, {len(raw)} bayt)"
            ) from exc


def yahoo_series(symbol: str, start: dt.date, end: dt.date) -> dict[str, float]:
    """Yahoo Finance'ten gunluk kapanis serisi ({'YYYY-MM-DD': deger})."""
    params = urllib.parse.urlencode({
        "period1": int(dt.datetime.combine(start, dt.time.min).timestamp()),
        "period2": int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min).timestamp()),
        "interval": "1d",
        "events": "history",
    })
    data = _get_json(f"{YAHOO_URL.format(symbol=symbol)}?{params}")
    result = (data.get("chart") or {}).get("result") or []
    if not result:
        return {}
    node = result[0]
    stamps = node.get("timestamp") or []
    quote = (node.get("indicators") or {}).get("quote") or [{}]
    closes = quote[0].get("close") or []
    out: dict[str, float] = {}
    for ts, close in zip(stamps, closes):
        if close is None:
            continue
        try:
            close = float(close)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(close) or close <= 0:
            continue
        # Yahoo zaman damgasi borsanin yerel gunudur; UTC gunu yeterince dogru.
        day = dt.datetime.utcfromtimestamp(ts).date().isoformat()
        out[day] = close
    return out


def _forward_fill(series: dict[str, float], days: list[str]) -> dict[str, float]:
    """Her güne, o gün itibarıyla bilinen en son gözlemi taşır."""
    out: dict[str, float] = {}
    observation_days = sorted(day for day in series if days and day <= days[-1])
    cursor = 0
    last: float | None = None
    for day in days:
        while cursor < len(observation_days) and observation_days[cursor] <= day:
            last = series[observation_days[cursor]]
            cursor += 1
        if last is not None:
            out[day] = last
    return out

def _parse_evds_date(raw_date: object) -> dt.date | None:
    """EVDS tarihini ayın ilk günü olarak döndürür (YYYY-MM, DD-MM-YYYY vb.)."""
    if not raw_date:
        return None
    parts = str(raw_date).strip().replace(".", "-").replace("/", "-").split("-")
    try:
        if len(parts) == 3 and len(parts[0]) == 4:
            year, month = int(parts[0]), int(parts[1])
        elif len(parts) == 3 and len(parts[2]) == 4:
            month, year = int(parts[1]), int(parts[2])
        elif len(parts) == 3:
            _, month, year = map(int, parts)
        elif len(parts) == 2 and len(parts[0]) == 4:
            year, month = int(parts[0]), int(parts[1])
        elif len(parts) == 2:
            month, year = int(parts[0]), int(parts[1])
        else:
            return None
        return dt.date(year, month, 1)
    except (ValueError, IndexError):
        return None


def _release_day(reference_month: dt.date) -> dt.date:
    """TÜFE ayın 3'ünde, hafta sonuna gelirse sonraki iş gününde yayımlanır."""
    if reference_month.month == 12:
        year, month = reference_month.year + 1, 1
    else:
        year, month = reference_month.year, reference_month.month + 1
    day = dt.date(year, month, 3)
    while day.weekday() >= 5:
        day += dt.timedelta(days=1)
    return day


def _fetch_tufe_series(series_code: str, start: dt.date, end: dt.date) -> tuple[dict[dt.date, float], list[str]]:
    """Bir TÜFE seri kodunu EVDS3'ten, eski kod için EVDS2 yedeğiyle alır."""
    errors: list[str] = []
    templates = [EVDS3_URL]
    if series_code == TUFE_OLD_SERIES:
        templates.append(EVDS2_URL)
    for template in templates:
        url = template.format(series=series_code, start=start.strftime("%d-%m-%Y"),
                              end=end.strftime("%d-%m-%Y"))
        host = urllib.parse.urlparse(url).netloc
        try:
            data = _get_json(url, headers={"key": os.environ.get("EVDS_API_KEY", "").strip()})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{host}/{series_code}: {exc}")
            continue
        items = data.get("items", []) if isinstance(data, dict) else []
        values: dict[dt.date, float] = {}
        column = series_code.lower().replace(".", "_")
        for item in items:
            if not isinstance(item, dict):
                continue
            normalized = {str(k).strip().lower().replace(".", "_"): v
                          for k, v in item.items()}
            period = _parse_evds_date(normalized.get("tarih"))
            raw_value = normalized.get(column)
            if period is None or raw_value in (None, "", "null"):
                continue
            try:
                value = float(str(raw_value).replace(",", "."))
            except (ValueError, TypeError):
                continue
            if math.isfinite(value) and value > 0:
                values[period] = value
        if values:
            return values, errors
        errors.append(f"{host}/{series_code}: JSON yanıtında seri gözlemi yok")
    return {}, errors


def tufe_series(start: dt.date, end: dt.date) -> dict[str, float]:
    """Aylık TÜFE'yi yayımlandığı tarihten itibaren kullanılabilir kılar."""
    key = os.environ.get("EVDS_API_KEY", "").strip()
    if not key:
        print("  TUFE atlandi: EVDS_API_KEY bu CMD penceresinde tanimli degil", flush=True)
        return {}

    fetch_start = start - dt.timedelta(days=70)
    old_values, errors = _fetch_tufe_series(TUFE_OLD_SERIES, fetch_start, end)
    new_values, new_errors = _fetch_tufe_series(TUFE_NEW_SERIES, fetch_start, end)
    errors.extend(new_errors)
    if not old_values and not new_values:
        print("  TUFE cekilemedi: " + " | ".join(errors), flush=True)
        return {}

    overlap = sorted(set(old_values) & set(new_values))
    if old_values and new_values and overlap:
        anchor = overlap[-1]
        factor = old_values[anchor] / new_values[anchor]
        new_start = min(new_values)
        monthly = {day: value for day, value in old_values.items() if day < new_start}
        monthly.update({day: value * factor for day, value in new_values.items()})
        print(f"  TUFE: eski/yeni baz {anchor:%Y-%m} gözleminde zincirlendi", flush=True)
    elif new_values:
        monthly = dict(new_values)
        if old_values:
            print("  TUFE uyarisi: eski/yeni seri ortak ay vermedi; eski seri eklenmedi", flush=True)
    else:
        monthly = dict(old_values)
        print("  TUFE uyarisi: yeni 2025=100 seri alınamadı; yalnızca eski seri kullanılacak", flush=True)

    # TÜFE referans ayın başında henüz bilinmez. Ayın 3'ünde, hafta sonuysa
    # takip eden ilk iş gününde yayımlanmış kabul edilir (TÜİK takvim kuralı).
    published = {_release_day(period).isoformat(): value for period, value in monthly.items()}
    if published:
        print(f"  TUFE: {len(published)} aylik gozlem, yayim gunlerine hizalandi", flush=True)
    return published
def collect(start: dt.date, end: dt.date, days: list[str]) -> dict:
    """Tum kiyaslama serilerini toplayip takvim gunlerine hizalar.

    `days` portfoy takviminin gunleridir (TEFAS'in veri urettigi gunler).
    Her seri bu gunlere ileri-doldurma ile hizalanir, boylece on uc
    tarafinda hizalama yapmak gerekmez.
    """
    series: dict[str, dict] = {}

    def add(key: str, label: str, unit: str, raw: dict[str, float]) -> None:
        if not raw:
            print(f"  {label}: veri yok, atlandi", flush=True)
            return
        aligned = _forward_fill(raw, days)
        if not aligned:
            return
        series[key] = {
            "label": label,
            "unit": unit,
            "values": [round(aligned.get(d), 6) if aligned.get(d) is not None else None
                       for d in days],
        }
        print(f"  {label}: {len(raw)} ham nokta -> {len(aligned)} hizali gun", flush=True)

    try:
        bist = yahoo_series("XU100.IS", start, end)
    except Exception as exc:                                    # noqa: BLE001
        print(f"  BIST 100 cekilemedi: {exc}", flush=True)
        bist = {}
    try:
        usdtry = yahoo_series("USDTRY=X", start, end)
    except Exception as exc:                                    # noqa: BLE001
        print(f"  USD/TRY cekilemedi: {exc}", flush=True)
        usdtry = {}
    try:
        gold_usd = yahoo_series("GC=F", start, end)
    except Exception as exc:                                    # noqa: BLE001
        print(f"  Ons altin cekilemedi: {exc}", flush=True)
        gold_usd = {}

    add("BIST100", "BIST 100", "puan", bist)
    add("USDTRY", "Dolar/TL", "TL", usdtry)

    # Gram altin: iki seriyi ortak gunlerde birlestir, sonra hizala.
    if gold_usd and usdtry:
        usd_ff = _forward_fill(usdtry, sorted(set(usdtry) | set(gold_usd)))
        gram = {
            day: value / TROY_OUNCE_GRAMS * usd_ff[day]
            for day, value in gold_usd.items()
            if day in usd_ff
        }
        add("GRAMALTIN", "Gram Altin", "TL", gram)

    add("TUFE", "TUFE (Enflasyon)", "endeks", tufe_series(start, end))
    return series





