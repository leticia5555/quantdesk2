// ═══════════════════════════════════════════════════════════════
// /api/ticker-search — tres modos:
//
//   ?profile=SYM    IDENTIDAD de la empresa para el popover del calendario
//                   de earnings: passthrough de Finnhub profile2 (free
//                   tier). Devuelve { symbol, name, industry, country,
//                   exchange, currency, market_cap_m, ipo, weburl }. Los
//                   campos que Finnhub no traiga van null — se omiten en
//                   UI, nunca se inventan. (La descripción de negocio es
//                   premium: la UI compone una línea con estos campos
//                   reales.) Cache CDN 24h — la identidad no cambia.
//
//   ?q=fems         BÚSQUEDA global de símbolos (fallback del autocomplete
//                   cuando la lista curada local no alcanza). Cubre
//                   cualquier bolsa: .MX (BMV), .SA (B3), etc. Devuelve
//                   { results: [{symbol, name, exchange, type}] } con el
//                   símbolo EXACTO que Yahoo espera.
//
//   ?liquidity=SYM  CHECK de liquidez para el aviso de honestidad: volumen
//                   promedio diario en USD de los últimos 3 meses
//                   (Σ volumen·cierre / n, del chart v8). Si la moneda no
//                   es USD se convierte con el FX spot de Yahoo (cacheado
//                   por instancia). illiquid = ADV < $1M USD/día — bajo
//                   eso, el cierre diario es ruidoso y el slippage real
//                   sería mayor: datos poco confiables para validar edges.
//                   Devuelve { symbol, currency, adv_usd, illiquid,
//                   threshold_usd }. Si no se puede calcular (sin datos,
//                   sin FX), illiquid = null — no se acusa sin evidencia.
// ═══════════════════════════════════════════════════════════════

const ADV_THRESHOLD_USD = 1_000_000;
const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'CRYPTOCURRENCY', 'INDEX', 'MUTUALFUND']);
// Mismo mapeo crypto que los motores: BTC → BTC-USD (canónico compartido).
import { toYahooSymbol } from './_lib/crypto-map.js';

const YH = { headers: { 'User-Agent': 'Mozilla/5.0' } };

async function yahooSearch(q) {
  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) +
    '&quotesCount=8&newsCount=0&listsCount=0';
  const r = await fetch(url, YH);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.quotes || [])
    .filter((x) => x.symbol && SEARCH_TYPES.has(x.quoteType))
    .slice(0, 8)
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || '',
      exchange: x.exchDisp || x.exchange || '',
      type: x.quoteType,
    }));
}

// FX spot → USD, cacheado 6h por instancia de lambda.
const fxCache = new Map();
async function fxToUsd(currency) {
  if (!currency || currency === 'USD') return 1;
  const hit = fxCache.get(currency);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.rate;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(currency + 'USD=X')}?range=1d&interval=1d`;
    const r = await fetch(url, YH);
    if (!r.ok) return null;
    const data = await r.json();
    const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    fxCache.set(currency, { rate, at: Date.now() });
    return rate;
  } catch (e) {
    return null;
  }
}

async function liquidityCheck(ticker) {
  const symbol = toYahooSymbol(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const r = await fetch(url, YH);
  if (!r.ok) return { symbol: ticker, illiquid: null, error: `Yahoo HTTP ${r.status}` };
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return { symbol: ticker, illiquid: null, error: 'sin datos' };

  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const volumes = quote.volume || [];
  let sum = 0, n = 0;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] > 0 && volumes[i] > 0) { sum += closes[i] * volumes[i]; n++; }
  }
  if (n < 5) return { symbol: ticker, illiquid: null, error: 'muy pocas barras con volumen' };

  const currency = result.meta?.currency || 'USD';
  const advLocal = sum / n;
  const rate = await fxToUsd(currency);
  const advUsd = rate != null ? advLocal * rate : null;

  return {
    symbol: ticker,
    currency,
    adv_local: Math.round(advLocal),
    adv_usd: advUsd != null ? Math.round(advUsd) : null,
    // Sin FX no se acusa: illiquid solo cuando hay número en USD.
    illiquid: advUsd != null ? advUsd < ADV_THRESHOLD_USD : null,
    threshold_usd: ADV_THRESHOLD_USD,
    n_days: n,
  };
}

// Identidad de empresa vía Finnhub profile2 (todo free tier). null donde
// Finnhub no traiga dato — la UI omite, no rellena.
async function companyProfile(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { symbol: ticker, error: 'FINNHUB_API_KEY not set' };
  const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`);
  if (!r.ok) return { symbol: ticker, error: `Finnhub ${r.status}` };
  const p = await r.json();
  if (!p || !p.name) return { symbol: ticker, error: 'sin profile' };
  return {
    symbol: ticker,
    name: p.name || null,
    industry: p.finnhubIndustry || null,
    country: p.country || null,
    exchange: p.exchange || null,
    currency: p.currency || null,
    market_cap_m: Number.isFinite(p.marketCapitalization) ? Math.round(p.marketCapitalization) : null,
    ipo: p.ipo || null,
    weburl: p.weburl || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  try {
    if (q.profile) {
      const out = await companyProfile(q.profile.toString().trim().toUpperCase());
      res.setHeader('Cache-Control', 's-maxage=86400');
      return res.status(200).json(out);
    }
    if (q.liquidity) {
      const out = await liquidityCheck(q.liquidity.toString().trim().toUpperCase());
      res.setHeader('Cache-Control', 's-maxage=3600');
      return res.status(200).json(out);
    }
    const query = (q.q || '').toString().trim();
    if (query.length < 1) return res.status(200).json({ results: [] });
    const results = await yahooSearch(query);
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ results });
  } catch (err) {
    // El autocomplete nunca debe romper el input: errores → lista vacía.
    return res.status(200).json({ results: [], error: (err && err.message) || 'unknown' });
  }
}

export { yahooSearch, liquidityCheck, fxToUsd, companyProfile, ADV_THRESHOLD_USD };
