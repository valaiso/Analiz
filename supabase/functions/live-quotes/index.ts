// Canlı fiyat (Supabase Edge Function): telefonda Midas eklentisi olmadığı için hisse / ETF / kripto
// fiyatları sunucudan alınır. Fiyat kodu eklentideki (midas-reader/service-worker.js) ile aynıdır:
// Yahoo Finance 1 dakikalık grafik, son geçerli kapanış ve önceki kapanış.
//
// Yalnızca Analiz hesabında oturum açmış kullanıcı çağırabilir (Supabase JWT doğrulaması, varsayılan açık).
// Yayınlama: Supabase → Edge Functions → Deploy a new function → adı "live-quotes", bu dosyayı yapıştır.
// ya da: npx supabase functions deploy live-quotes --project-ref jqmfvinbzgqyitqquzdc

const ALLOWED_ORIGIN = "https://valaiso.github.io";
const CODE_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const MAX_CODES = 60;

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && (origin === ALLOWED_ORIGIN || origin.startsWith("http://localhost")) ? origin : ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

function isoDate(timestamp: number, timezone?: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

async function chart(ticker: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Analiz live quotes)" } });
  if (!res.ok) return null;
  const chart = (await res.json())?.chart?.result?.[0];
  if (!chart) return null;
  const timestamps: number[] = chart.timestamp || [];
  const closes: number[] = chart.indicators?.quote?.[0]?.close || [];
  let last = -1;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (Number.isFinite(Number(closes[i])) && Number(closes[i]) > 0) { last = i; break; }
  }
  const price = last >= 0 ? Number(closes[last]) : Number(chart.meta?.regularMarketPrice);
  const previousClose = Number(chart.meta?.chartPreviousClose ?? chart.meta?.previousClose);
  if (!(price > 0) || !(previousClose > 0)) return null;
  const timestamp = timestamps[last] || chart.meta?.regularMarketTime || Date.now() / 1000;
  return { chart, price, previousClose, timestamp };
}

async function stockQuote(code: string) {
  for (const ticker of [`${code}.IS`, code]) {
    try {
      const q = await chart(ticker);
      if (!q) continue;
      const regular = q.chart.meta?.currentTradingPeriod?.regular;
      const now = Date.now() / 1000;
      const has = Number.isFinite(regular?.start) && Number.isFinite(regular?.end);
      return {
        code, price: q.price, previousClose: q.previousClose,
        date: isoDate(q.timestamp, q.chart.meta?.exchangeTimezoneName),
        timestamp: q.timestamp * 1000,
        exchangeTimezoneName: q.chart.meta?.exchangeTimezoneName || "UTC",
        isRegularSessionNow: has ? now >= regular.start && now < regular.end : null,
        isRegularSessionBar: has ? q.timestamp >= regular.start && q.timestamp <= regular.end : null,
        currency: q.chart.meta?.currency || (ticker.endsWith(".IS") ? "TRY" : "USD"),
        source: "Yahoo Finance (sunucu)",
      };
    } catch { /* sonraki yazımı dene */ }
  }
  return null;
}

async function cryptoQuote(code: string) {
  const normalized = code.replace(/[-_/]?(TRY|USD|USDT|USDC)$/, "");
  if (!normalized || ["USDT", "USDC"].includes(normalized)) return null;
  for (const ticker of [`${normalized}-TRY`, `${normalized}-USD`]) {
    try {
      const q = await chart(ticker);
      if (!q) continue;
      return {
        code: normalized, price: q.price, previousClose: q.previousClose,
        date: isoDate(q.timestamp, q.chart.meta?.exchangeTimezoneName || "UTC"),
        timestamp: q.timestamp * 1000,
        exchangeTimezoneName: q.chart.meta?.exchangeTimezoneName || "UTC",
        isRegularSessionNow: true, isRegularSessionBar: true,
        currency: q.chart.meta?.currency || (ticker.endsWith("-TRY") ? "TRY" : "USD"),
        source: "Yahoo Finance (sunucu)",
      };
    } catch { /* dolar paritesini dene */ }
  }
  return null;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("Origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "POST gerekli" }), { status: 405, headers });
  let body: { codes?: unknown[]; cryptoCodes?: unknown[] } = {};
  try { body = await req.json(); } catch { /* boş gövde */ }
  const clean = (list: unknown[] = []) => [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter((c) => CODE_RE.test(c)))];
  const codes = clean(body.codes).slice(0, MAX_CODES);
  const cryptoCodes = new Set(clean(body.cryptoCodes).slice(0, 20));
  const all = [...new Set([...codes, ...cryptoCodes])];
  const entries = await Promise.all(all.map(async (code) => [code, await (cryptoCodes.has(code) ? cryptoQuote(code) : stockQuote(code))] as const));
  const quotes = Object.fromEntries(entries.filter(([, q]) => q));
  return new Response(JSON.stringify({ ok: true, quotes }), { headers });
});
