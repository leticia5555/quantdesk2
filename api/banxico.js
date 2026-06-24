// ═══════════════════════════════════════════════════════════════
// /api/banxico — Mexican macro data via Banxico SIE API
// Free, official source. Token: https://www.banxico.org.mx/SieAPIRest
//
// Usage:
//   /api/banxico?series=USDMXN              → latest value
//   /api/banxico?series=USDMXN&days=30      → last 30 days
//   /api/banxico?series=all                 → all key indicators
//
// Available series (canonical names → Banxico SIE codes):
//   USDMXN     — FX rate (interbank close)
//   CETES28    — 28-day Treasury rate
//   CETES91    — 91-day Treasury rate
//   CETES182   — 182-day Treasury rate
//   TIIE28     — 28-day interbank rate
//   INPC       — Consumer Price Index (inflation)
//   M2         — M2 money supply
//   IGAE       — Global Indicator of Economic Activity
//   POLICY     — Banxico policy rate (target)
// ═══════════════════════════════════════════════════════════════
 
// In-memory cache (per Vercel function instance)
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — macro data doesn't change intraday
 
// Map our canonical series names to Banxico SIE series codes
// Source: https://www.banxico.org.mx/SieAPIRest/service/v1/doc/catalogoSeries
const SERIES_MAP = {
  USDMXN:   'SF43718',  // Tipo de cambio FIX
  CETES28:  'SF43936',  // CETES 28 días — tasa de rendimiento
  CETES91:  'SF43939',  // CETES 91 días
  CETES182: 'SF43942',  // CETES 182 días
  TIIE28:   'SF43783',  // TIIE 28 días
  INPC:     'SP1',      // Índice Nacional de Precios al Consumidor
  M2:       'SF311408', // Agregado monetario M2
  IGAE:     'SR16734',  // Indicador Global de la Actividad Económica
  POLICY:   'SF61745',  // Tasa objetivo de Banxico
};
 
// Human-readable metadata for each series
const SERIES_META = {
  USDMXN:   { name: 'USD/MXN',                    unit: 'pesos per dollar',    decimals: 4 },
  CETES28:  { name: 'CETES 28d',                  unit: '% annual',            decimals: 2 },
  CETES91:  { name: 'CETES 91d',                  unit: '% annual',            decimals: 2 },
  CETES182: { name: 'CETES 182d',                 unit: '% annual',            decimals: 2 },
  TIIE28:   { name: 'TIIE 28d',                   unit: '% annual',            decimals: 4 },
  INPC:     { name: 'INPC (inflation)',           unit: 'index',               decimals: 3 },
  M2:       { name: 'M2 money supply',            unit: 'million pesos',       decimals: 0 },
  IGAE:     { name: 'IGAE (economic activity)',   unit: 'index',               decimals: 2 },
  POLICY:   { name: 'Banxico policy rate',        unit: '% annual',            decimals: 2 },
};
 
// Format YYYY-MM-DD for Banxico API date params
function fmtDate(d) {
  return d.toISOString().split('T')[0];
}
 
// Fetch one series from Banxico
async function fetchSeries(seriesCode, token, fromDate, toDate) {
  const cacheKey = `${seriesCode}|${fromDate}|${toDate}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.data, _cached: true };
  }
 
  const url = `https://www.banxico.org.mx/SieAPIRest/service/v1/series/${seriesCode}/datos/${fromDate}/${toDate}?token=${token}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) {
    throw new Error(`Banxico API ${r.status} for ${seriesCode}`);
  }
  const data = await r.json();
  const series = data?.bmx?.series?.[0];
  if (!series) {
    throw new Error(`No data returned for ${seriesCode}`);
  }
  const datos = (series.datos || [])
    .filter(d => d.dato && d.dato !== 'N/E')  // N/E = "No Existe" — Banxico's null
    .map(d => ({
      // Banxico returns dates as DD/MM/YYYY — convert to ISO
      date: d.fecha.split('/').reverse().join('-'),
      value: parseFloat(d.dato.replace(/,/g, ''))
    }))
    .filter(d => !isNaN(d.value));
 
  const result = {
    code: seriesCode,
    title: series.titulo || '',
    points: datos,
    latest: datos.length ? datos[datos.length - 1] : null,
    fetched_at: new Date().toISOString()
  };
  cache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const token = process.env.BANXICO_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'BANXICO_TOKEN not set in environment',
      help: 'Get a free token at https://www.banxico.org.mx/SieAPIRest/service/v1/token'
    });
  }
 
  const { series = 'all', days = '30' } = req.query;
  const daysNum = Math.min(Math.max(parseInt(days) || 30, 1), 3650); // max 10 years
 
  const today = new Date();
  const from = new Date(today.getTime() - daysNum * 24 * 60 * 60 * 1000);
  const fromStr = fmtDate(from);
  const toStr = fmtDate(today);
 
  try {
    // Single series query
    if (series !== 'all') {
      const upper = series.toUpperCase();
      const code = SERIES_MAP[upper];
      if (!code) {
        return res.status(400).json({
          error: `Unknown series: ${series}`,
          available: Object.keys(SERIES_MAP)
        });
      }
      const data = await fetchSeries(code, token, fromStr, toStr);
      return res.status(200).json({
        series: upper,
        meta: SERIES_META[upper],
        ...data
      });
    }
 
    // All key series — fetch in parallel
    const keySeries = ['USDMXN', 'POLICY', 'CETES28', 'TIIE28', 'INPC'];
    const results = await Promise.allSettled(
      keySeries.map(s => fetchSeries(SERIES_MAP[s], token, fromStr, toStr))
    );
 
    const out = {};
    keySeries.forEach((s, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') {
        out[s] = {
          meta: SERIES_META[s],
          latest: r.value.latest,
          // Compact: only return latest + 30d change for "all" view
          change_30d: computeChange(r.value.points, 30),
          fetched_at: r.value.fetched_at
        };
      } else {
        out[s] = { error: r.reason?.message || 'fetch failed' };
      }
    });
 
    return res.status(200).json({
      country: 'Mexico',
      source: 'Banxico SIE',
      indicators: out,
      generated_at: new Date().toISOString()
    });
 
  } catch (e) {
    return res.status(500).json({
      error: e.message || 'Banxico fetch failed',
      hint: 'Verify BANXICO_TOKEN is valid'
    });
  }
}
 
// % change between earliest and latest point in window
function computeChange(points, daysWindow) {
  if (!points || points.length < 2) return null;
  const latest = points[points.length - 1];
  const target = new Date(latest.date);
  target.setDate(target.getDate() - daysWindow);
  // Find closest point on or before target date
  const reversed = [...points].reverse();
  const earlier = reversed.find(p => new Date(p.date) <= target) || points[0];
  if (!earlier || !Number.isFinite(earlier.value) || earlier.value === 0) return null;
  if (!Number.isFinite(latest.value)) return null;
  // Report the actual elapsed days. When no point reaches back a full
  // `daysWindow` (e.g. monthly series like INPC in a short window), `earlier`
  // falls back to the oldest available point, so labeling it `daysWindow`
  // would overstate the period the change actually covers.
  const actualDays = Math.round((new Date(latest.date) - new Date(earlier.date)) / 86400000);
  return {
    from: earlier.value,
    to: latest.value,
    pct: +(((latest.value - earlier.value) / earlier.value) * 100).toFixed(2),
    days: actualDays
  };
}
