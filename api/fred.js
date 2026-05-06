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

// Map our canonical names to FRED series IDs
// Browse: https://fred.stlouisfed.org/categories
const SERIES_MAP = {
  FEDFUNDS:  'FEDFUNDS',     // Federal Funds Effective Rate
  DGS10:     'DGS10',        // 10-Year Treasury yield
  DGS2:      'DGS2',          // 2-Year Treasury yield
  DGS30:     'DGS30',         // 30-Year Treasury yield
  CPI:       'CPIAUCSL',      // CPI All Urban Consumers
  CORE_CPI:  'CPILFESL',      // Core CPI (ex food/energy)
  UNRATE:    'UNRATE',        // Unemployment rate
  DXY:       'DTWEXBGS',      // Trade-weighted USD index (broad)
  GDP:       'GDP',           // Gross Domestic Product
  M2:        'M2SL',          // M2 money supply
  VIX:       'VIXCLS',        // CBOE Volatility Index
  SP500:     'SP500',         // S&P 500 index
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
    .filter(o => o.value && o.value !== '.')  // FRED uses '.' for missing
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

    // Key indicators in parallel
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

    // Compute real Fed Funds rate (nominal − YoY CPI inflation) — useful for spread widget
    let real_rate = null;
    try {
      if (out.FEDFUNDS?.latest && out.CPI?.latest) {
        // Need CPI from 12 months ago to compute YoY
        const yearAgo = new Date(today.getTime() - 380 * 24 * 60 * 60 * 1000);
        const cpiYear = await fetchSeries(SERIES_MAP.CPI, apiKey, fmtDate(yearAgo), toStr);
        if (cpiYear.points.length >= 2) {
          const oldCpi = cpiYear.points[0].value;
          const newCpi = cpiYear.points[cpiYear.points.length - 1].value;
          const cpi_yoy = ((newCpi - oldCpi) / oldCpi) * 100;
          real_rate = +(out.FEDFUNDS.latest.value - cpi_yoy).toFixed(2);
          out.CPI_YOY = {
            meta: { name: 'CPI YoY', unit: '%', decimals: 2 },
            latest: { date: out.CPI.latest.date, value: +cpi_yoy.toFixed(2) }
          };
        }
      }
    } catch (e) { /* skip if CPI YoY fails */ }

    return res.status(200).json({
      country: 'United States',
      source: 'FRED · St. Louis Fed',
      indicators: out,
      derived: {
        real_fed_funds: real_rate,
        nominal_fed_funds: out.FEDFUNDS?.latest?.value || null,
        cpi_yoy: out.CPI_YOY?.latest?.value || null
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
  if (!earlier || earlier.value === 0) return null;
  return {
    from: earlier.value,
    to: latest.value,
    pct: +(((latest.value - earlier.value) / earlier.value) * 100).toFixed(2),
    abs: +(latest.value - earlier.value).toFixed(4),
    days: daysWindow
  };
}
