#!/usr/bin/env python3
"""TEFAS ve Ekstra Varlıkları (BIST/US ETF) çekip SQLite'a işleyen ve statik site üreten betik."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parent))

import benchmarks
import buckets
from categorize import categorize
from tefas import Tefas, KIND_LABELS

ROOT = Path(__file__).resolve().parent.parent

EKSTRA_ENSTRUMANLAR = {
    # ABD ETF'leri
    "VOO":   {"symbol": "VOO",      "title": "Vanguard S&P 500 ETF", "type": "US_ETF", "cat": "Yabancı ETF"},
    "QQQ":   {"symbol": "QQQ",      "title": "Invesco QQQ Trust (Nasdaq 100)", "type": "US_ETF", "cat": "Yabancı ETF"},
    "SCHD":  {"symbol": "SCHD",     "title": "Schwab U.S. Dividend Equity ETF", "type": "US_ETF", "cat": "Yabancı ETF"},
    "VIG":   {"symbol": "VIG",      "title": "Vanguard Dividend Appreciation ETF", "type": "US_ETF", "cat": "Yabancı ETF"},
    "MGV":   {"symbol": "MGV",      "title": "Vanguard Mega Cap Value ETF", "type": "US_ETF", "cat": "Yabancı ETF"},

    # BIST Hisseleri
    "ASELS": {"symbol": "ASELS.IS", "title": "Aselsan Elektronik Sanayi", "type": "HISSE", "cat": "Hisse Senedi"},
    "THYAO": {"symbol": "THYAO.IS", "title": "Türk Hava Yolları", "type": "HISSE", "cat": "Hisse Senedi"},
    "PGSUS": {"symbol": "PGSUS.IS", "title": "Pegasus Hava Taşımacılığı", "type": "HISSE", "cat": "Hisse Senedi"},
    "TUPRS": {"symbol": "TUPRS.IS", "title": "TÜPRAŞ - Türkiye Petrol Rafinerileri", "type": "HISSE", "cat": "Hisse Senedi"},
    "FROTO": {"symbol": "FROTO.IS", "title": "Ford Otomotiv Sanayi", "type": "HISSE", "cat": "Hisse Senedi"},
    "TOASO": {"symbol": "TOASO.IS", "title": "Tofaş Türk Otomobil Fabrikası", "type": "HISSE", "cat": "Hisse Senedi"},
    "ENJSA": {"symbol": "ENJSA.IS", "title": "Enerjisa Enerji", "type": "HISSE", "cat": "Hisse Senedi"},
    "TRGYO": {"symbol": "TRGYO.IS", "title": "Torunlar Gayrimenkul Yatırım Ortaklığı", "type": "HISSE", "cat": "Hisse Senedi"},
    "GARAN": {"symbol": "GARAN.IS", "title": "Garanti Bankası", "type": "HISSE", "cat": "Hisse Senedi"},
    "AEFES": {"symbol": "AEFES.IS", "title": "Anadolu Efes Biracılık ve Malt Sanayi", "type": "HISSE", "cat": "Hisse Senedi"},
    "BIMAS": {"symbol": "BIMAS.IS", "title": "BİM Birleşik Mağazalar", "type": "HISSE", "cat": "Hisse Senedi"},
    "ANHYT": {"symbol": "ANHYT.IS", "title": "Anadolu Hayat Emeklilik", "type": "HISSE", "cat": "Hisse Senedi"},
    "ENKAI": {"symbol": "ENKAI.IS", "title": "Enka İnşaat ve Sanayi", "type": "HISSE", "cat": "Hisse Senedi"},
    "MPARK": {"symbol": "MPARK.IS", "title": "MLP Sağlık Hizmetleri (Medical Park)", "type": "HISSE", "cat": "Hisse Senedi"},
    "AKSA":  {"symbol": "AKSA.IS",  "title": "Aksa Akrilik Kimya Sanayii", "type": "HISSE", "cat": "Hisse Senedi"},
    "AYGAZ": {"symbol": "AYGAZ.IS", "title": "Aygaz Sanayi", "type": "HISSE", "cat": "Hisse Senedi"},
    "TCELL": {"symbol": "TCELL.IS", "title": "Turkcell İletişim Hizmetleri", "type": "HISSE", "cat": "Hisse Senedi"},
    "TTKOM": {"symbol": "TTKOM.IS", "title": "Türk Telekomünikasyon", "type": "HISSE", "cat": "Hisse Senedi"},
    "CCOLA": {"symbol": "CCOLA.IS", "title": "Coca-Cola İçecek", "type": "HISSE", "cat": "Hisse Senedi"},
    "EREGL": {"symbol": "EREGL.IS", "title": "Ereğli Demir Çelik", "type": "HISSE", "cat": "Hisse Senedi"},
}

OVERLAP_DAYS = 7
RETURN_WINDOWS = {"1h": 7, "1a": 30, "3a": 90, "6a": 180, "1y": 365, "3y": 1095}
RETENTION_BUFFER_DAYS = 20
CATEGORY_REFRESH_DAYS = 7
MIN_KATEGORI_FON = 5

SCHEMA = """
CREATE TABLE IF NOT EXISTS prices (
    date TEXT NOT NULL, code TEXT NOT NULL, price REAL NOT NULL, PRIMARY KEY (date, code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS funds (
    code TEXT PRIMARY KEY, name TEXT, kind TEXT, shares REAL, investors INTEGER, size REAL, updated TEXT
);
CREATE TABLE IF NOT EXISTS allocation (code TEXT PRIMARY KEY, date TEXT, json TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_prices_code ON prices (code, date);
"""

EK_SUTUNLAR = {"category": "TEXT", "category_src": "TEXT"}


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    mevcut = {r[1] for r in conn.execute("PRAGMA table_info(funds)")}
    for ad, tip in EK_SUTUNLAR.items():
        if ad not in mevcut:
            conn.execute(f"ALTER TABLE funds ADD COLUMN {ad} {tip}")
    conn.commit()
    return conn


def meta_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)", (key, value))
    conn.commit()


def sync_categories(conn: sqlite3.Connection, client: Tefas, end: dt.date, force: bool = False) -> int:
    son = meta_get(conn, "category_sync")
    eksik = conn.execute("SELECT COUNT(*) FROM funds WHERE kind = 'YAT' AND category IS NULL").fetchone()[0]
    if not force and son and not eksik and (end - dt.date.fromisoformat(son)).days < CATEGORY_REFRESH_DAYS:
        print("[kategori] Yakın zamanda eşlendi, atlanıyor", flush=True)
        return 0

    try:
        turler = client.fund_types("YAT")
        tumu = client.codes_for_type("YAT", None, end)
    except Exception as exc:
        print(f"[kategori] Hata: {exc}", flush=True)
        return 0

    eslesen = {}
    for tur in turler:
        kod, ad = tur.get("sfonTuru"), (tur.get("sfonTurAciklama") or "").strip()
        if not kod or not ad:
            continue
        try:
            kodlar = client.codes_for_type("YAT", kod, end)
            if kodlar and kodlar != tumu:
                for c in kodlar:
                    eslesen[c] = ad
        except Exception:
            continue

    if eslesen:
        conn.executemany("UPDATE funds SET category = ?, category_src = 'tefas' WHERE code = ?",
                         [(ad, c) for c, ad in eslesen.items()])
        conn.commit()
        meta_set(conn, "category_sync", end.isoformat())
    return len(eslesen)


def fetch_prices(conn: sqlite3.Connection, client: Tefas, kinds: list[str], start: dt.date, end: dt.date) -> int:
    total = 0
    for kind in kinds:
        print(f"[fiyat] {KIND_LABELS.get(kind, kind)} ({kind}) {start} -> {end}", flush=True)
        price_rows, fund_rows = [], {}
        for rec in client.prices(kind, start, end):
            price_rows.append((rec["date"], rec["code"], rec["price"]))
            prev = fund_rows.get(rec["code"])
            if prev is None or rec["date"] >= prev[6]:
                fund_rows[rec["code"]] = (rec["code"], rec["name"], kind, rec["shares"], rec["investors"], rec["size"], rec["date"])
            
            if len(price_rows) >= 50_000:
                conn.executemany("INSERT OR REPLACE INTO prices (date, code, price) VALUES (?,?,?)", price_rows)
                total += len(price_rows)
                price_rows.clear()

        if price_rows:
            conn.executemany("INSERT OR REPLACE INTO prices (date, code, price) VALUES (?,?,?)", price_rows)
            total += len(price_rows)
        if fund_rows:
            conn.executemany("INSERT OR REPLACE INTO funds VALUES (?,?,?,?,?,?,?)", list(fund_rows.values()))
        conn.commit()
    return total


def fetch_allocation(conn: sqlite3.Connection, client: Tefas, kinds: list[str], end: dt.date) -> int:
    start = end - dt.timedelta(days=10)
    latest = {}
    for kind in kinds:
        for rec in client.allocation(kind, start, end):
            code, date = rec["code"], rec["date"]
            if code not in latest or date >= latest[code][0]:
                latest[code] = (date, json.dumps(buckets.summarize(rec["row"]), ensure_ascii=False))
    if latest:
        conn.executemany("INSERT OR REPLACE INTO allocation VALUES (?,?,?)", [(c, d, p) for c, (d, p) in latest.items()])
        conn.commit()
    return len(latest)


def prune(conn: sqlite3.Connection, cutoff: dt.date) -> int:
    cur = conn.execute("DELETE FROM prices WHERE date < ?", (cutoff.isoformat(),))
    conn.commit()
    return cur.rowcount


def _pct(new: float | None, old: float | None) -> float | None:
    return round((new / old - 1) * 100, 2) if old and new else None


def _volatility_and_drawdown(prices: list[float]) -> tuple[float | None, float | None]:
    clean = [p for p in prices if p and p > 0]
    if len(clean) < 30:
        return None, None
    rets = [clean[i] / clean[i - 1] - 1 for i in range(1, len(clean))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    vol = (var ** 0.5) * (252 ** 0.5) * 100
    peak, max_dd = clean[0], 0.0
    for p in clean:
        peak = max(peak, p)
        max_dd = min(max_dd, p / peak - 1)
    return round(vol, 2), round(max_dd * 100, 2)


def add_category_percentiles(funds: list[dict]) -> None:
    metrikler = {
        "1y": lambda f: (f["ret"] or {}).get("1y"),
        "3y": lambda f: (f["ret"] or {}).get("3y"),
        "vol": lambda f: f.get("vol"),
        "mdd": lambda f: f.get("mdd"),
    }
    kategoriler = {}
    for f in funds:
        kategoriler.setdefault(f["cat"], []).append(f)

    for grup in kategoriler.values():
        for f in grup:
            f["catN"] = len(grup)
        if len(grup) < MIN_KATEGORI_FON:
            continue
        for etiket, al in metrikler.items():
            degerler = sorted(v for v in (al(f) for f in grup) if v is not None)
            if len(degerler) < MIN_KATEGORI_FON:
                continue
            for f in grup:
                v = al(f)
                if v is not None:
                    alt = sum(1 for d in degerler if d < v)
                    f.setdefault("pct", {})[etiket] = round(alt / (len(degerler) - 1) * 100, 1)
                    if etiket == "1y":
                        f["catRank"], f["catRanked"] = len(degerler) - alt, len(degerler)


def process_extra_assets(hist_dir: Path, calendar: list[str], index_of: dict[str, int]) -> list[dict]:
    """Ekstra BIST/ETF enstrümanlarını yfinance ile çeker ve funds.json formatına getirir."""
    print("\n[ekstra] BIST Hisseleri ve ABD ETF'leri yfinance ile çekiliyor...", flush=True)
    extra_funds = []
    
    for code, info in EKSTRA_ENSTRUMANLAR.items():
        try:
            hist = yf.Ticker(info["symbol"]).history(period="3y")
            if hist.empty:
                continue
            
            price_map = {d.strftime("%Y-%m-%d"): round(float(r["Close"]), 4) for d, r in hist.iterrows()}
            matching_days = [d for d in calendar if d in price_map]
            if not matching_days:
                continue
            
            i0, i1 = index_of[matching_days[0]], index_of[matching_days[-1]]
            series = [price_map.get(d) for d in calendar[i0:i1 + 1]]
            
            # JSON olarak kaydet
            (hist_dir / f"{code}.json").write_text(
                json.dumps({"c": code, "i": i0, "p": series}, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8"
            )

            last_p = price_map[matching_days[-1]]
            prev_p = price_map.get(calendar[i1 - 1]) if i1 > 0 else None
            
            extra_funds.append({
                "code": code, "name": info["title"], "kind": info["type"], "cat": info["cat"],
                "catSrc": "ekstra", "price": last_p, "date": matching_days[-1],
                "chg": _pct(last_p, prev_p), "ret": {}, "vol": None, "mdd": None,
                "size": 0, "inv": 0, "alloc": {}, "i0": i0, "n": len(series)
            })
            print(f"  [ekstra] {code} ({info['title']}) eklendi.", flush=True)
        except Exception as e:
            print(f"  [ekstra] {code} hatası: {e}", flush=True)
            
    return extra_funds


def build_site(conn: sqlite3.Connection, out_dir: Path, years: int) -> dict:
    data_dir, hist_dir = out_dir / "data", out_dir / "data" / "history"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    hist_dir.mkdir(parents=True, exist_ok=True)

    calendar = [r[0] for r in conn.execute("SELECT DISTINCT date FROM prices ORDER BY date")]
    if not calendar:
        raise SystemExit("Veritabanında fiyat yok.")
    index_of = {day: i for i, day in enumerate(calendar)}
    last_day = calendar[-1]

    allocations = {c: json.loads(p) for c, p in conn.execute("SELECT code, json FROM allocation")}
    meta = {c: dict(zip(("name", "kind", "shares", "investors", "size", "category", "category_src"), rest))
            for c, *rest in conn.execute("SELECT code, name, kind, shares, investors, size, category, category_src FROM funds")}

    funds_out, para_piyasasi = [], []

    for code, info in sorted(meta.items()):
        rows = conn.execute("SELECT date, price FROM prices WHERE code = ? ORDER BY date", (code,)).fetchall()
        if not rows:
            continue
        
        dates, prices = [r[0] for r in rows], [r[1] for r in rows]
        first_idx, last_idx = index_of[dates[0]], index_of[dates[-1]]
        span = last_idx - first_idx + 1
        series = [None] * span
        for d, p in rows:
            series[index_of[d] - first_idx] = round(p, 6)

        (hist_dir / f"{code}.json").write_text(
            json.dumps({"c": code, "i": first_idx, "p": series}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8"
        )

        returns = {}
        for label, days in RETURN_WINDOWS.items():
            target = (dt.date.fromisoformat(dates[-1]) - dt.timedelta(days=days)).isoformat()
            base = next((p for d, p in reversed(rows) if d <= target), None)
            returns[label] = _pct(prices[-1], base)

        cutoff = (dt.date.fromisoformat(dates[-1]) - dt.timedelta(days=365)).isoformat()
        vol, max_dd = _volatility_and_drawdown([p for d, p in rows if d >= cutoff])

        resmi = (info.get("category") or "").replace(" Şemsiye Fonu", "").strip()
        kategori = resmi or categorize(info["name"])
        if kategori == "Para Piyasası":
            para_piyasasi.append((first_idx, series))

        funds_out.append({
            "code": code, "name": info["name"], "kind": info["kind"], "cat": kategori,
            "catSrc": "tefas" if resmi else "unvan", "price": round(prices[-1], 6), "date": dates[-1],
            "chg": _pct(prices[-1], prices[-2] if len(prices) > 1 else None), "ret": returns,
            "vol": vol, "mdd": max_dd, "size": info["size"], "inv": info["investors"],
            "alloc": allocations.get(code) or {}, "i0": first_idx, "n": span
        })

    # Ekstra Hisse ve ETF'leri sürece dahil et
    funds_out.extend(process_extra_assets(hist_dir, calendar, index_of))
    add_category_percentiles(funds_out)

    (data_dir / "funds.json").write_text(json.dumps(funds_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (data_dir / "calendar.json").write_text(json.dumps(calendar, separators=(",", ":")), encoding="utf-8")

    # Benchmarks
    bench = benchmarks.collect(dt.date.fromisoformat(calendar[0]), dt.date.fromisoformat(last_day), calendar)
    (data_dir / "benchmarks.json").write_text(json.dumps(bench, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    info = {
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "lastDataDate": last_day, "firstDataDate": calendar[0], "days": len(calendar),
        "fundCount": len(funds_out), "years": years, "benchmarks": list(bench), "buckets": buckets.BUCKET_ORDER
    }
    (data_dir / "meta.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")

    shutil.copy2(ROOT / "index.html", out_dir / "index.html")
    shutil.copytree(ROOT / "assets", out_dir / "assets")
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")

    return info


def main() -> int:
    parser = argparse.ArgumentParser(description="TEFAS verisini güncelle ve siteyi üret")
    parser.add_argument("--years", type=int, default=int(os.environ.get("TEFAS_YEARS", 3)))
    parser.add_argument("--kinds", default=os.environ.get("TEFAS_KINDS", "YAT,EMK,BYF"))
    parser.add_argument("--db", default=str(ROOT / "data" / "tefas.sqlite"))
    parser.add_argument("--out", default=str(ROOT / "dist"))
    parser.add_argument("--delay", type=float, default=float(os.environ.get("TEFAS_DELAY", 3.0)))
    parser.add_argument("--days", type=int, default=None)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--skip-fetch", action="store_true")
    args = parser.parse_args()

    started = time.time()
    kinds = [k.strip().upper() for k in args.kinds.split(",") if k.strip()]
    today = dt.date.today()
    cutoff = today - dt.timedelta(days=(args.days or args.years * 365) + RETENTION_BUFFER_DAYS)

    conn = open_db(Path(args.db))

    if not args.skip_fetch:
        client = Tefas(delay=args.delay)
        stored = None if args.full else conn.execute("SELECT MAX(date) FROM prices").fetchone()[0]
        start = max(dt.date.fromisoformat(stored) - dt.timedelta(days=OVERLAP_DAYS), cutoff) if stored else cutoff
        
        fetch_prices(conn, client, kinds, start, today)
        fetch_allocation(conn, client, kinds, today)
        sync_categories(conn, client, today, force=args.full)
        prune(conn, cutoff)

    info = build_site(conn, Path(args.out), args.years)
    conn.commit()
    conn.close()
    print(f"Bitti: {info['fundCount']} varlık işlendi ({time.time() - started:.0f}s).", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())