// ═══════════════════════════════════════════════════════════════
// /api/candles — OHLC para el chart modal (SOLO display).
// · Cripto (BTC/USD, ETH/USD, …) → Binance klines vía el mirror de
//   solo-datos data-api.binance.vision (sin key, sin geobloqueo US;
//   fallback api.binance.com). Tiempo real.
// · Acciones US + LATAM (.MX/.SA/.BA/.SN) → Yahoo v8 chart (la misma
//   fuente que ya usan /api/price y /api/tape — cero Finnhub, cero
//   exposición al rate limit de 60/min).
// Caché CDN por intervalo (s-maxage + stale-while-revalidate): todos
// los usuarios comparten UNA request por símbolo/intervalo/ventana.
// El refresh "en vivo" del chart NO repollea esto — el cliente solo
// actualiza la vela viva con el quote de /api/tape o el WS de Binance.
// ═══════════════════════════════════════════════════════════════

// intervalo → ventana por fuente + caché CDN (segundos)
export const INTERVALS = {
  '1d': { yahoo: { interval: '1d',  range: '1y'  }, binance: { interval: '1d', limit: 365 }, smaxage: 300, swr: 600 },
  '1h': { yahoo: { interval: '60m', range: '1mo' }, binance: { interval: '1h', limit: 720 }, smaxage: 120, swr: 300 },
  '5m': { yahoo: { interval: '5m',  range: '5d'  }, binance: { interval: '5m', limit: 576 }, smaxage: 60,  swr: 120 },
};

// El mismo universo cripto de la app (normalizeTicker/startBinanceFeed).
// MATIC queda fuera a propósito: Binance retiró MATICUSDT tras la
// migración a POL — cae a la ruta Yahoo (MATIC-USD) como el resto.
const BINANCE_MAP = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT',
  XRP: 'XRPUSDT', ADA: 'ADAUSDT', DOGE: 'DOGEUSDT', AVAX: 'AVAXUSDT',
  DOT: 'DOTUSDT', LINK: 'LINKUSDT', LTC: 'LTCUSDT',
};

export function toBinanceSymbol(sym) {
  const t = String(sym || '').toUpperCase().trim().replace('/USD', '');
  return BINANCE_MAP[t] || null;
}

// 'BTC/USD' → 'BTC-USD' (mismo mapeo que /api/tape); acciones pasan tal cual
export function toYahooSymbol(sym) {
  const t = String(sym || '').toUpperCase().trim();
  return t.endsWith('/USD') ? t.replace('/USD', '-USD') : t;
}

// Yahoo v8 → [{t,o,h,l,c,v}] — descarta filas con OHLC incompleto (Yahoo
// mete nulls en huecos de sesión); jamás se inventa una vela.
export function extractYahooCandles(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return null;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) continue;
    out.push({
      t: ts[i],
      o: +o.toFixed(o < 1 ? 6 : 2), h: +h.toFixed(h < 1 ? 6 : 2),
      l: +l.toFixed(l < 1 ? 6 : 2), c: +c.toFixed(c < 1 ? 6 : 2),
      v: Number.isFinite(q.volume?.[i]) ? q.volume[i] : 0,
    });
  }
  return out.length ? { candles: out, currency: r.meta?.currency || null } : null;
}

// Binance klines: [[openTime(ms), "o","h","l","c","v", ...], …] → [{t,o,h,l,c,v}]
export function extractBinanceCandles(json) {
  if (!Array.isArray(json)) return null;
  const out = [];
  for (const k of json) {
    if (!Array.isArray(k) || k.length < 6) continue;
    const [ot, o, h, l, c, v] = k;
    const [no, nh, nl, nc] = [o, h, l, c].map(Number);
    if (![no, nh, nl, nc].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ t: Math.floor(ot / 1000), o: no, h: nh, l: nl, c: nc, v: Number(v) || 0 });
  }
  return out.length ? { candles: out, currency: 'USD' } : null;
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = String((req.query && req.query.symbol) || '').toUpperCase().trim();
  const interval = String((req.query && req.query.interval) || '1d');
  if (!symbol) return res.status(400).json({ error: 'symbol required, e.g. ?symbol=MELI&interval=1d' });
  const iv = INTERVALS[interval];
  if (!iv) return res.status(400).json({ error: `interval must be one of: ${Object.keys(INTERVALS).join(', ')}` });

  try {
    let extracted = null;
    let source = null;

    const binSym = toBinanceSymbol(symbol);
    if (binSym) {
      source = 'binance';
      const qs = `symbol=${binSym}&interval=${iv.binance.interval}&limit=${iv.binance.limit}`;
      let r = await fetch(`https://data-api.binance.vision/api/v3/klines?${qs}`).catch(() => null);
      if (!r || !r.ok) r = await fetch(`https://api.binance.com/api/v3/klines?${qs}`).catch(() => null);
      if (r && r.ok) extracted = extractBinanceCandles(await r.json().catch(() => null));
    } else {
      source = 'yahoo';
      const ySym = toYahooSymbol(symbol);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}`
        + `?interval=${iv.yahoo.interval}&range=${iv.yahoo.range}`;
      const r = await fetch(url, { headers: UA }).catch(() => null);
      if (r && r.ok) extracted = extractYahooCandles(await r.json().catch(() => null));
    }

    if (!extracted) {
      // Honesto: sin velas reales no hay chart — el cliente pinta su fallback.
      return res.status(502).json({ error: `No candle data for ${symbol} (${source})` });
    }

    res.setHeader('Cache-Control', `public, s-maxage=${iv.smaxage}, stale-while-revalidate=${iv.swr}`);
    return res.status(200).json({
      symbol, interval, source,
      currency: extracted.currency,
      candles: extracted.candles,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(502).json({ error: `Candle fetch failed for ${symbol}: ${err.message}` });
  }
}
