// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-admission.js — FILTRO DE ADMISIÓN del universo del Arena.
//
// EL BUG QUE LO ORIGINA (journal del 14): DDDX, un OTC de $0.01, llegó al
// buffet y el PM lo consideró. No entró por el canal de movers —ése ya filtra
// precio ≥ $5 desde julio— sino por el canal INSIDER, que no filtraba NADA:
// `trimInsiders` tomaba los Form 4 de la SEC tal cual, y la SEC no distingue
// entre un director de Apple comprando $2M y el dueño de una shell OTC
// comprándose $3,000 de su propia empresa. Los canales tenían criterios de
// admisión distintos —uno estricto, dos inexistentes— y el más flojo mandaba.
//
// Acá vive UN solo criterio, y lo aplican TODOS los canales:
//
//   precio ≥ $5 · market cap ≥ $1B · volumen en dólares ≥ $10M/día (20 sesiones)
//
// FAIL CLOSED, y esto es una decisión de producto, no un accidente: un ticker
// cuyos datos de admisión NO se pueden resolver NO entra. La alternativa
// ("si no sé, que pase") es exactamente cómo entró DDDX. Un nombre rechazado
// por falta de datos se journalea con `reason: 'data_unavailable'` y aparte de
// los rechazados por criterio, para que se vea si el filtro está tirando cosas
// buenas por una falla de cobertura y no por micro-cap.
//
// POINT-IN-TIME: el volumen se computa sobre velas CERRADAS (`completedSlice`),
// nunca con la del día que se opera.
//
// COSTO: ~26 llamadas a Finnhub profile2 + ~8 series de Yahoo por corrida, con
// caché por día en memoria. El deep dive gasta ~20 más; el total queda bajo el
// cap de 60/min del tier gratis. Los movers ya traen precio y volumen del
// endpoint, así que de ésos solo se pide el market cap.
// ═══════════════════════════════════════════════════════════════

import { extractYahooCandles, toYahooSymbol } from '../candles.js';

export const ADMISSION = {
  min_price: 5,
  min_market_cap_usd: 1_000_000_000,
  min_dollar_volume: 10_000_000,
  volume_lookback_days: 20,
};

// Caché por DÍA. La admisión es una propiedad lenta del nombre (market cap y
// volumen medio no cambian de una corrida a la otra); recalcularla en cada tick
// del vigilante sería quemar el rate limit de Finnhub sin aprender nada.
const cache = new Map(); // 'YYYY-MM-DD:SYMBOL' → { price, marketCap, dollarVolume }
const dayKey = (sym, now) => now.toISOString().slice(0, 10) + ':' + sym;

export function _resetAdmissionCache() { cache.clear(); }

// ── El criterio, puro y testeable sin red ────────────────────────────
export function isAdmissible(d, rules = ADMISSION) {
  if (!d || !d.symbol) return { ok: false, reason: 'sin símbolo' };
  const miss = [];
  if (!Number.isFinite(d.price)) miss.push('precio');
  if (!Number.isFinite(d.marketCap)) miss.push('market cap');
  if (!Number.isFinite(d.dollarVolume)) miss.push('volumen en dólares');
  if (miss.length) {
    return { ok: false, reason: 'data_unavailable', missing: miss };
  }
  if (d.price < rules.min_price) {
    return { ok: false, reason: `precio $${d.price.toFixed(2)} < $${rules.min_price}` };
  }
  if (d.marketCap < rules.min_market_cap_usd) {
    return { ok: false, reason: `market cap $${(d.marketCap / 1e6).toFixed(0)}M < $${(rules.min_market_cap_usd / 1e9).toFixed(0)}B` };
  }
  if (d.dollarVolume < rules.min_dollar_volume) {
    return { ok: false, reason: `volumen $${(d.dollarVolume / 1e6).toFixed(1)}M/día < $${(rules.min_dollar_volume / 1e6).toFixed(0)}M` };
  }
  return { ok: true };
}

// ── Resolución de datos (best-effort, nunca lanza) ───────────────────
function safeJson(r) {
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}

// Precio del último cierre COMPLETO + volumen en dólares promedio de las
// últimas N sesiones cerradas. Una sola request por símbolo.
export async function fetchPriceAndVolume(symbol, now = new Date(), fetchImpl = fetch) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}?range=3mo&interval=1d`;
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    const j = await safeJson(r);
    // `extractYahooCandles` devuelve { candles, currency }, NO un array pelado.
    const extracted = extractYahooCandles(j);
    const candles = extracted && extracted.candles;
    if (!candles || !candles.length) return { price: null, dollarVolume: null };
    // Solo velas CERRADAS: la del día en curso no cuenta (point-in-time).
    const todayUtc = now.toISOString().slice(0, 10);
    const closed = candles.filter((c) => {
      const d = new Date((c.t || 0) * 1000).toISOString().slice(0, 10);
      return d < todayUtc || (d === todayUtc && now.getUTCHours() >= 22);
    });
    if (!closed.length) return { price: null, dollarVolume: null };
    const last = closed[closed.length - 1];
    const window = closed.slice(-ADMISSION.volume_lookback_days);
    const dvs = window.map((c) => (Number(c.c) || 0) * (Number(c.v) || 0)).filter((x) => x > 0);
    const dollarVolume = dvs.length ? dvs.reduce((a, b) => a + b, 0) / dvs.length : null;
    return { price: Number(last.c) || null, dollarVolume };
  } catch (_) { return { price: null, dollarVolume: null }; }
}

// Market cap en USD desde Finnhub profile2 (`marketCapitalization` viene en
// MILLONES — el ×1e6 es la trampa clásica de ese campo).
export async function fetchMarketCap(symbol, finnhubKey, fetchImpl = fetch) {
  if (!finnhubKey) return null;
  try {
    const r = await fetchImpl(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`,
      { signal: AbortSignal.timeout(12000) });
    const j = await safeJson(r);
    const m = j && Number(j.marketCapitalization);
    return Number.isFinite(m) && m > 0 ? m * 1e6 : null;
  } catch (_) { return null; }
}

// Resuelve los datos de admisión de un lote. `known` trae lo que el canal ya
// sabe (los movers vienen con precio y volumen del endpoint: eso ahorra una
// request por nombre y no se vuelve a pedir).
export async function resolveAdmission(symbols, { finnhubKey, now = new Date(), known = {}, fetchImpl = fetch, concurrency = 4 } = {}) {
  const out = {};
  const todo = [];
  for (const raw of symbols || []) {
    const sym = String(raw || '').trim().toUpperCase();
    if (!sym || out[sym]) continue;
    const hit = cache.get(dayKey(sym, now));
    if (hit) { out[sym] = hit; continue; }
    out[sym] = null;
    todo.push(sym);
  }
  // Lotes chicos y secuenciales entre lotes: el tier gratis de Finnhub corta a
  // 60/min y un burst de 30 en paralelo lo roza con el deep dive del mismo run.
  for (let i = 0; i < todo.length; i += concurrency) {
    const batch = todo.slice(i, i + concurrency);
    await Promise.all(batch.map(async (sym) => {
      const k = known[sym] || {};
      const needPV = !Number.isFinite(k.price) || !Number.isFinite(k.dollarVolume);
      const [pv, mcap] = await Promise.all([
        needPV ? fetchPriceAndVolume(sym, now, fetchImpl) : Promise.resolve({ price: k.price, dollarVolume: k.dollarVolume }),
        Number.isFinite(k.marketCap) ? Promise.resolve(k.marketCap) : fetchMarketCap(sym, finnhubKey, fetchImpl),
      ]);
      const row = {
        symbol: sym,
        price: Number.isFinite(pv.price) ? pv.price : (Number.isFinite(k.price) ? k.price : null),
        dollarVolume: Number.isFinite(pv.dollarVolume) ? pv.dollarVolume : null,
        marketCap: Number.isFinite(mcap) ? mcap : null,
      };
      out[sym] = row;
      cache.set(dayKey(sym, now), row);
    }));
  }
  return out;
}

// Parte una lista de items en admitidos y rechazados, conservando el porqué de
// cada rechazo. `symbolOf` dice de qué campo sacar el ticker (los canales
// tienen forma distinta: `symbol` en movers, `ticker` en insiders/earnings).
export function partitionByAdmission(items, data, symbolOf = (x) => x && x.symbol, rules = ADMISSION) {
  const admitted = [];
  const rejected = [];
  for (const it of items || []) {
    const sym = String(symbolOf(it) || '').trim().toUpperCase();
    const verdict = isAdmissible({ symbol: sym, ...(data[sym] || {}) }, rules);
    if (verdict.ok) admitted.push(it);
    else rejected.push({ symbol: sym, reason: verdict.reason, ...(verdict.missing ? { missing: verdict.missing } : {}) });
  }
  return { admitted, rejected };
}
