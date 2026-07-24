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
// Presupuesto de llamadas: 4 endpoints × ≤5 tickers = ~20 req en un burst,
// muy por debajo del cap de 60/min del tier gratis. Los tickers se recorren
// secuencialmente (Promise.all interno por ticker) para no rozar el cap de
// ~30 req/s. BEST-EFFORT: un símbolo sin cobertura Finnhub degrada a datos
// nulos y se marca en `errors`, JAMÁS aborta la corrida.
// ═══════════════════════════════════════════════════════════════

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
