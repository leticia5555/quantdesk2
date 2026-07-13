// ═══════════════════════════════════════════════════════════════
// /api/ticker-search — dos modos, ambos proxy de Yahoo Finance (sin key):
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
// Mismo mapeo crypto que los motores: BTC → BTC-USD.
const CRYPTO = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT'];

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
  const symbol = CRYPTO.includes(ticker) ? `${ticker}-USD` : ticker;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  try {
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

export { yahooSearch, liquidityCheck, fxToUsd, ADV_THRESHOLD_USD };
