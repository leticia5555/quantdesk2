// ═══════════════════════════════════════════════════════════════
// /api/fred — US macro data via FRED API (St. Louis Fed)
// Free, official source. Key: https://fredaccount.stlouisfed.org/apikey
//
// Usage:
//   /api/fred?series=FEDFUNDS         → latest value
//   /api/fred?series=DGS10&days=90    → US 10Y yield, 90 days
//   /api/fred?series=all              → key indicators (FEDFUNDS, DGS10, CPI, DXY)
//
// Response shape mirrors /api/banxico for consistent client integration.
// ═══════════════════════════════════════════════════════════════
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
 
const SERIES_MAP = {
  FEDFUNDS:  'FEDFUNDS',
  DGS10:     'DGS10',
  DGS2:      'DGS2',
  DGS30:     'DGS30',
  CPI:       'CPIAUCSL',
  CORE_CPI:  'CPILFESL',
  UNRATE:    'UNRATE',
  DXY:       'DTWEXBGS',
  GDP:       'GDP',
  M2:        'M2SL',
  VIX:       'VIXCLS',
  SP500:     'SP500',
};
const SERIES_META = {
  FEDFUNDS:  { name: 'Fed Funds Rate',         unit: '% annual',     decimals: 2 },
  DGS10:     { name: 'US 10Y Treasury',        unit: '% annual',     decimals: 2 },
  DGS2:      { name: 'US 2Y Treasury',         unit: '% annual',     decimals: 2 },
  DGS30:     { name: 'US 30Y Treasury',        unit: '% annual',     decimals: 2 },
  CPI:       { name: 'CPI (headline)',         unit: 'index',        decimals: 3 },
  CORE_CPI:  { name: 'Core CPI',               unit: 'index',        decimals: 3 },
  UNRATE:    { name: 'Unemployment',           unit: '%',            decimals: 1 },
  DXY:       { name: 'USD Index (broad)',      unit: 'index',        decimals: 2 },
  GDP:       { name: 'US GDP',                 unit: 'billion USD',  decimals: 1 },
  M2:        { name: 'M2 money supply',        unit: 'billion USD',  decimals: 1 },
  VIX:       { name: 'VIX volatility',         unit: 'index',        decimals: 2 },
  SP500:     { name: 'S&P 500',                unit: 'index',        decimals: 2 },
};
 
function fmtDate(d) {
  return d.toISOString().split('T')[0];
}
 
async function fetchSeries(seriesId, apiKey, fromDate, toDate) {
  const cacheKey = `${seriesId}|${fromDate}|${toDate}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.data, _cached: true };
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=${fromDate}&observation_end=${toDate}&sort_order=asc`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`FRED API ${r.status} for ${seriesId}`);
  }
  const data = await r.json();
  const obs = data?.observations || [];
  const points = obs
    .filter(o => o.value && o.value !== '.')
    .map(o => ({
      date: o.date,
      value: parseFloat(o.value)
    }))
    .filter(p => !isNaN(p.value));
  const result = {
    code: seriesId,
    points,
    latest: points.length ? points[points.length - 1] : null,
    fetched_at: new Date().toISOString()
  };
  cache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}
 
// ──── Compute YoY change from a series of points (with ±60d tolerance) ────
function computeYoYFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points[points.length - 1];
  if (!latest?.value) return null;
  const targetDate = new Date(latest.date);
  targetDate.setDate(targetDate.getDate() - 365);
  let baseline = null;
  let minDiff = Infinity;
  for (const p of points) {
    if (!p?.value) continue;
    const diff = Math.abs(new Date(p.date) - targetDate);
    if (diff < minDiff) { minDiff = diff; baseline = p; }
  }
  if (!baseline?.value) return null;
  return ((latest.value - baseline.value) / baseline.value) * 100;
}
 
// ──── Try CPI first, fall back to CORE_CPI if CPI is unavailable ────
async function computeInflationYoY(apiKey, fromStr, toStr, today) {
  const yearAgo = new Date(today.getTime() - 380 * 24 * 60 * 60 * 1000);
  const yearAgoStr = fmtDate(yearAgo);
 
  // Attempt 1: headline CPI
  try {
    const cpiYear = await fetchSeries(SERIES_MAP.CPI, apiKey, yearAgoStr, toStr);
    const yoy = computeYoYFromPoints(cpiYear.points);
    if (yoy != null) return { value: yoy, source: 'CPI', date: cpiYear.latest?.date };
  } catch (e) {
    console.warn('CPI YoY failed, trying Core CPI:', e.message);
  }
 
  // Attempt 2: Core CPI fallback (Fed actually prefers this for policy)
  try {
    const coreYear = await fetchSeries(SERIES_MAP.CORE_CPI, apiKey, yearAgoStr, toStr);
    const yoy = computeYoYFromPoints(coreYear.points);
    if (yoy != null) return { value: yoy, source: 'Core CPI', date: coreYear.latest?.date };
  } catch (e) {
    console.warn('Core CPI YoY failed:', e.message);
  }
 
  return null;
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'FRED_API_KEY not set in environment',
      help: 'Get a free key at https://fredaccount.stlouisfed.org/apikey'
    });
  }
 
  const { series = 'all', days = '365' } = req.query;
  const daysNum = Math.min(Math.max(parseInt(days) || 365, 1), 3650);
  const today = new Date();
  const from = new Date(today.getTime() - daysNum * 24 * 60 * 60 * 1000);
  const fromStr = fmtDate(from);
  const toStr = fmtDate(today);
 
  try {
    if (series !== 'all') {
      const upper = series.toUpperCase();
      const code = SERIES_MAP[upper];
      if (!code) {
        return res.status(400).json({
          error: `Unknown series: ${series}`,
          available: Object.keys(SERIES_MAP)
        });
      }
      const data = await fetchSeries(code, apiKey, fromStr, toStr);
      return res.status(200).json({
        series: upper,
        meta: SERIES_META[upper],
        ...data
      });
    }
 
    const keySeries = ['FEDFUNDS', 'DGS10', 'DGS2', 'CPI', 'CORE_CPI', 'UNRATE', 'DXY', 'VIX'];
    const results = await Promise.allSettled(
      keySeries.map(s => fetchSeries(SERIES_MAP[s], apiKey, fromStr, toStr))
    );
    const out = {};
    keySeries.forEach((s, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') {
        out[s] = {
          meta: SERIES_META[s],
          latest: r.value.latest,
          change_30d: computeChange(r.value.points, 30),
          change_90d: computeChange(r.value.points, 90),
          fetched_at: r.value.fetched_at
        };
      } else {
        out[s] = { error: r.reason?.message || 'fetch failed' };
      }
    });
 
    // ──── Compute real Fed Funds rate with CPI → Core CPI fallback ────
    let real_rate = null;
    let cpi_yoy_value = null;
    let cpi_source = null;
 
    if (out.FEDFUNDS?.latest) {
      const inflationResult = await computeInflationYoY(apiKey, fromStr, toStr, today);
      if (inflationResult != null) {
        cpi_yoy_value = +inflationResult.value.toFixed(2);
        cpi_source = inflationResult.source;
        real_rate = +(out.FEDFUNDS.latest.value - inflationResult.value).toFixed(2);
        out.CPI_YOY = {
          meta: { name: `${inflationResult.source} YoY`, unit: '%', decimals: 2 },
          latest: { date: inflationResult.date, value: cpi_yoy_value },
          source: inflationResult.source
        };
      }
    }
 
    return res.status(200).json({
      country: 'United States',
      source: 'FRED · St. Louis Fed',
      indicators: out,
      derived: {
        real_fed_funds: real_rate,
        nominal_fed_funds: out.FEDFUNDS?.latest?.value || null,
        cpi_yoy: cpi_yoy_value,
        cpi_source: cpi_source  // 'CPI' or 'Core CPI' so client knows which was used
      },
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || 'FRED fetch failed',
      hint: 'Verify FRED_API_KEY is valid'
    });
  }
}
 
function computeChange(points, daysWindow) {
  if (!points || points.length < 2) return null;
  const latest = points[points.length - 1];
  const target = new Date(latest.date);
  target.setDate(target.getDate() - daysWindow);
  const reversed = [...points].reverse();
  const earlier = reversed.find(p => new Date(p.date) <= target) || points[0];
  if (!earlier || !Number.isFinite(earlier.value) || earlier.value === 0) return null;
  if (!Number.isFinite(latest.value)) return null;
  // Report the actual elapsed days. When no point reaches back a full
  // `daysWindow` (e.g. monthly series in a short window), `earlier` falls back
  // to the oldest available point, so labeling it `daysWindow` would overstate
  // the period the change actually covers.
  const actualDays = Math.round((new Date(latest.date) - new Date(earlier.date)) / 86400000);
  return {
    from: earlier.value,
    to: latest.value,
    pct: +(((latest.value - earlier.value) / earlier.value) * 100).toFixed(2),
    abs: +(latest.value - earlier.value).toFixed(4),
    days: actualDays
  };
}
