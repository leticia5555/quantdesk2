// ═══════════════════════════════════════════════════════════════
// api/_lib/finnhub-dive.js — DEEP DIVE del Arena (fase 2, determinista).
//
// El SCAN (fase 1) elige ≤5 tickers candidatos del buffet. Aquí, SIN LLM,
// traemos de Finnhub lo que el PM holdeaba pidiendo: fundamentales básicos,
// analyst recommendations y titulares recientes. Con eso el DIVE decide.
//
// TIER GRATIS DE FINNHUB (verificado): metric, profile2, recommendation y
// company-news son gratis. `stock/price-target` es PREMIUM → NO se llama
// (decisión de producto: `recommendation` ya da la señal de rating —
// strongBuy/buy/hold/sell/strongSell y su tendencia; el número objetivo
// puntual queda para un tier pagado futuro, y reactivarlo sería añadir un
// `safeFetch(.../stock/price-target...)` aquí).
//
// HISTORIAL TEMPORAL (hallazgo T1, sep 2026): `stock/metric` es una FOTO —
// no trae serie. `fetchTemporalInputs` agrega las dos fuentes GRATIS que sí
// tienen tiempo dentro: `stock/earnings` (sorpresa de EPS por trimestre) y
// `stock/financials-reported?freq=quarterly` (ingresos por trimestre → YoY).
// Se llama SOLO para los candidatos que NO están en la tabla del screener
// (el cron ya los precomputó): así el burst extra es de 1-3 tickers, no de
// todos. `stock/revenue-estimate` / `stock/eps-estimate` (revisión de
// estimados) son PREMIUM → NO se llaman; la revisión se construye en casa
// (ver _lib/temporal-fundamentals.js).
//
// Presupuesto de llamadas: 4 endpoints × ≤5 tickers = ~20 req en un burst,
// muy por debajo del cap de 60/min del tier gratis. Los tickers se recorren
// secuencialmente (Promise.all interno por ticker) para no rozar el cap de
// ~30 req/s. BEST-EFFORT: un símbolo sin cobertura Finnhub degrada a datos
// nulos y se marca en `errors`, JAMÁS aborta la corrida.
// ═══════════════════════════════════════════════════════════════

import { parseRevenueHistory, parseEpsSurprises, recommendationTrend, TEMPORAL_RULES } from './temporal-fundamentals.js';

const BASE = 'https://finnhub.io/api/v1';

// Mismo patrón tolerante que fundamental-agent.js: la red nunca lanza hacia
// arriba; una respuesta no-JSON o no-ok se vuelve null y el DIVE opera con
// menos contexto, nunca con contexto inventado.
function safeFetch(url) {
  return fetch(url, { signal: AbortSignal.timeout(12000) }).catch(() => null);
}
async function safeJson(r) {
  if (!r || !r.ok) return null;
  try {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch (_) { return null; }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// metric.metric → subconjunto compacto (P/E, márgenes, deuda). Los campos de
// deuda de Finnhub llevan slash en la clave, de ahí el acceso por corchetes.
function pickFundamentals(metricResp) {
  const m = (metricResp && metricResp.metric) || {};
  const g = (k) => (k in m ? num(m[k]) : null);
  return {
    peTTM: g('peTTM'),
    psTTM: g('psTTM'),
    pb: g('pbQuarterly') ?? g('pbAnnual'),
    grossMarginTTM: g('grossMarginTTM'),
    netMarginTTM: g('netProfitMarginTTM'),
    operatingMarginTTM: g('operatingMarginTTM'),
    debtToEquity: g('totalDebt/totalEquityQuarterly') ?? g('totalDebt/totalEquityAnnual'),
    currentRatio: g('currentRatioQuarterly') ?? g('currentRatioAnnual'),
    roeTTM: g('roeTTM'),
    revenueGrowthTTMYoy: g('revenueGrowthTTMYoy'),
    week52High: g('52WeekHigh'),
    week52Low: g('52WeekLow'),
    beta: g('beta'),
  };
}

// recommendation[] → el período más reciente. La señal de rating que el PM
// pedía como "analyst ratings": el reparto de analistas por recomendación.
function pickRecommendation(recResp) {
  if (!Array.isArray(recResp) || !recResp.length) return null;
  // Finnhub ya ordena desc por período, pero re-ordenamos por si acaso.
  const sorted = [...recResp].sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
  const r = sorted[0] || {};
  return {
    period: r.period || null,
    strongBuy: num(r.strongBuy) ?? 0,
    buy: num(r.buy) ?? 0,
    hold: num(r.hold) ?? 0,
    sell: num(r.sell) ?? 0,
    strongSell: num(r.strongSell) ?? 0,
  };
}

// company-news → top-5 titulares de los últimos 7 días, priorizando por fecha
// más reciente (en temporada de earnings los titulares se amontonan).
function pickNews(newsResp, now) {
  if (!Array.isArray(newsResp)) return [];
  const cutoff = (now.getTime() - 7 * 86400000) / 1000;
  return newsResp
    .filter((n) => n && typeof n.headline === 'string' && num(n.datetime) != null && n.datetime >= cutoff)
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 5)
    .map((n) => ({
      headline: n.headline.slice(0, 200),
      date: new Date(n.datetime * 1000).toISOString().slice(0, 10),
      source: n.source || null,
    }));
}

// profile2 → identidad + market cap (Finnhub lo da en MILLONES de USD).
function pickProfile(profileResp) {
  const p = profileResp || {};
  return {
    name: p.name || null,
    marketCapM: num(p.marketCapitalization),
    industry: p.finnhubIndustry || null,
    country: p.country || null,
  };
}

// ── fundamentales de UN símbolo (para el precompute del screener) ─────
// Reusa la MISMA extracción que el deep dive (pickFundamentals) — una sola
// definición de "qué es un fundamental". 1 request Finnhub (stock/metric).
// null si no hay cobertura/cae la red (best-effort, el cron marca el ledger).
export async function fetchFundamentals(symbol, finnhubKey) {
  if (!symbol || !finnhubKey) return null;
  const r = await safeFetch(`${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${finnhubKey}`);
  const metric = await safeJson(r);
  if (!metric) return null;
  return pickFundamentals(metric);
}

// ── deep dive de ≤5 tickers ──────────────────────────────────────────
// Devuelve { data: { TICKER: {profile,fundamentals,recommendation,news} | null },
//            errors: { TICKER: motivo } }. `errors` alimenta el post-mortem
// (símbolo sin cobertura, red caída) sin frenar la corrida.
export async function fetchDeepDive(tickers, finnhubKey, now = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = iso(new Date(now.getTime() - 7 * 86400000));
  const to = iso(now);
  const data = {};
  const errors = {};

  if (!finnhubKey) {
    for (const t of tickers || []) { data[t] = null; errors[t] = 'FINNHUB_API_KEY no configurada'; }
    return { data, errors };
  }

  // Secuencial por ticker (Promise.all interno) para no rozar el cap de ~30 req/s.
  for (const t of tickers || []) {
    const sym = encodeURIComponent(t);
    try {
      const [metricR, profileR, recR, newsR] = await Promise.all([
        safeFetch(`${BASE}/stock/metric?symbol=${sym}&metric=all&token=${finnhubKey}`),
        safeFetch(`${BASE}/stock/profile2?symbol=${sym}&token=${finnhubKey}`),
        safeFetch(`${BASE}/stock/recommendation?symbol=${sym}&token=${finnhubKey}`),
        safeFetch(`${BASE}/company-news?symbol=${sym}&from=${from}&to=${to}&token=${finnhubKey}`),
      ]);
      const [metric, profile, rec, news] = await Promise.all([
        safeJson(metricR), safeJson(profileR), safeJson(recR), safeJson(newsR),
      ]);
      const entry = {
        profile: pickProfile(profile),
        fundamentals: pickFundamentals(metric),
        recommendation: pickRecommendation(rec),
        // TENDENCIA del rating (hoy vs. 30/90 días atrás) del MISMO array que ya
        // bajamos: cero requests extra. `recommendation` es la foto del rating;
        // esto es su película, y es el fallback día-0 de la etiqueta `revisions`.
        recommendation_trend: recommendationTrend(rec, { now }),
        news: pickNews(news, now),
      };
      data[t] = entry;
      // Cobertura pobre (símbolo que Finnhub no cubre): se marca para el
      // post-mortem, pero el entry (con nulls) igual viaja al prompt.
      const empty = !metric && !profile && !Array.isArray(rec) && !entry.news.length;
      if (empty) errors[t] = 'sin cobertura Finnhub';
    } catch (e) {
      data[t] = null;
      errors[t] = String((e && e.message) || e);
    }
  }
  return { data, errors };
}

// ── historial temporal de UN símbolo (gratis) ────────────────────────
// Dos endpoints del tier gratis que el deep dive NO traía:
//   stock/earnings                     → sorpresa de EPS por trimestre
//   stock/financials-reported?quarterly → ingresos por trimestre (→ YoY)
// Devuelve { revenueHistory, epsSurprises } ya parseados y recortados a los
// ≤8 trimestres del pedido. Best-effort: sin cobertura → arrays vacíos.
export async function fetchEarningsHistory(symbol, finnhubKey, { maxQuarters = TEMPORAL_RULES.max_quarters } = {}) {
  if (!symbol || !finnhubKey) return { revenueHistory: [], epsSurprises: [] };
  const sym = encodeURIComponent(symbol);
  // 12 trimestres de reportes para poder derivar 8 YoY (cada YoY necesita su
  // comparable del año anterior); `limit`/`count` son params documentados.
  const [epsR, finR] = await Promise.all([
    safeFetch(`${BASE}/stock/earnings?symbol=${sym}&limit=${maxQuarters}&token=${finnhubKey}`),
    safeFetch(`${BASE}/stock/financials-reported?symbol=${sym}&freq=quarterly&count=${maxQuarters + 4}&token=${finnhubKey}`),
  ]);
  const [eps, fin] = await Promise.all([safeJson(epsR), safeJson(finR)]);
  return {
    revenueHistory: parseRevenueHistory(fin, { maxQuarters }),
    epsSurprises: parseEpsSurprises(eps, { maxQuarters }),
  };
}

// Igual, para N símbolos con CONCURRENCIA ACOTADA. El cap del tier gratis es
// 60 req/min y el deep dive ya gasta 4/ticker: este pase va de a 2 tickers
// (4 requests en vuelo) para no empujar el burst por encima del cap.
export async function fetchTemporalInputs(symbols, finnhubKey, { maxQuarters = TEMPORAL_RULES.max_quarters, concurrency = 2 } = {}) {
  const out = {};
  const queue = [...new Set(symbols || [])];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try { out[s] = await fetchEarningsHistory(s, finnhubKey, { maxQuarters }); }
      catch (e) { out[s] = { revenueHistory: [], epsSurprises: [] }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

// ── recomendaciones de analistas, la SERIE completa (gratis) ─────────
// `pickRecommendation` (arriba) se queda con el periodo más reciente para
// mostrarle el rating al PM. Aquí devolvemos el ARRAY entero: la TENDENCIA
// del rating (hoy vs. 30/90 días atrás) es el fallback día-0 de la etiqueta
// `revisions` mientras el historial de estimados propio se acumula.
export async function fetchRecommendations(symbol, finnhubKey) {
  if (!symbol || !finnhubKey) return null;
  const r = await safeFetch(`${BASE}/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`);
  const data = await safeJson(r);
  return Array.isArray(data) ? data : null;
}

// ── estimado de consenso del PRÓXIMO reporte (gratis) ────────────────
// `calendar/earnings?symbol=` trae, para el próximo reporte, `epsEstimate` y
// `revenueEstimate` con su fecha y periodo fiscal. Un snapshot solo no dice
// nada; guardado por el cron del screener en cada refresh, la SERIE de
// snapshots del MISMO periodo fiscal es una revisión de estimados de verdad
// (ver _lib/temporal-fundamentals.js → estimateRevisions). Devuelve
// { date, period, eps, revenue } o null.
export async function fetchNextEstimate(symbol, finnhubKey, now = new Date()) {
  if (!symbol || !finnhubKey) return null;
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = iso(now);
  const to = iso(new Date(now.getTime() + 120 * 86400000));
  const r = await safeFetch(`${BASE}/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`);
  const data = await safeJson(r);
  const list = (data && Array.isArray(data.earningsCalendar)) ? data.earningsCalendar : [];
  if (!list.length) return null;
  // El más próximo en el tiempo (el feed no garantiza orden).
  const next = [...list].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[0];
  const eps = num(next.epsEstimate);
  const revenue = num(next.revenueEstimate);
  if (eps == null && revenue == null) return null;
  return {
    // `date` es CUÁNDO tomamos el snapshot (hoy), no la fecha del reporte:
    // es el eje temporal de la revisión. El reporte va en `period`/`report_date`.
    date: iso(now),
    period: next.date || null,
    report_date: next.date || null,
    quarter: next.quarter ?? null, year: next.year ?? null,
    eps, revenue,
  };
}
