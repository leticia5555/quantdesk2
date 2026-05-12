// ═══════════════════════════════════════════════════════════════════
// Macro Agent (Sprint 3)
//
//   GET /api/macro-agent?ticker=MELI
//
// Pulls macro context appropriate to the ticker's country + sector:
//   • US macro (always)  — Fed Funds, 10Y/2Y, CPI YoY, VIX, DXY
//                          via the existing /api/fred?series=all
//   • Local FX (if foreign issuer)  — USD/local pair from Yahoo
//                                     Finance, 1y change + realized vol
//   • Commodities (if sector-applicable)  — Brent/WTI for energy,
//                                            Copper/Gold for mining,
//                                            Soy/Corn for agribusiness
//
// Derived metrics:
//   yield curve slope + regime, real rate, VIX regime, Fed cycle
//   position (vs 12-month avg), FX regime, per-ticker macro
//   sensitivities (FX / rate / commodity).
//
// Claude composes the narrative panels + institutional insight,
// weighted toward EM-specific factors for LATAM ADRs.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// ── Country / region context ─────────────────────────────────────
// Finnhub `profile.country` returns ISO-2. For LATAM ADRs and a few
// other commonly-relevant emerging markets we surface a local FX
// pair from Yahoo. Anything else falls back to US macro only.
const COUNTRY_META = {
  US: { name: 'United States',   currency: 'USD', fxYahoo: null,         em: false },
  AR: { name: 'Argentina',       currency: 'ARS', fxYahoo: 'ARS=X',      em: true },
  BR: { name: 'Brazil',          currency: 'BRL', fxYahoo: 'BRL=X',      em: true },
  MX: { name: 'Mexico',          currency: 'MXN', fxYahoo: 'MXN=X',      em: true },
  CL: { name: 'Chile',           currency: 'CLP', fxYahoo: 'CLP=X',      em: true },
  CO: { name: 'Colombia',        currency: 'COP', fxYahoo: 'COP=X',      em: true },
  PE: { name: 'Peru',            currency: 'PEN', fxYahoo: 'PEN=X',      em: true },
  UY: { name: 'Uruguay',         currency: 'UYU', fxYahoo: 'UYU=X',      em: true },
  EC: { name: 'Ecuador',         currency: 'USD', fxYahoo: null,         em: true },  // dollarized
  // Non-LATAM but worth surfacing
  NL: { name: 'Netherlands',     currency: 'EUR', fxYahoo: 'EUR=X',      em: false },
  GB: { name: 'United Kingdom',  currency: 'GBP', fxYahoo: 'GBP=X',      em: false },
  CN: { name: 'China',           currency: 'CNY', fxYahoo: 'CNY=X',      em: true },
  JP: { name: 'Japan',           currency: 'JPY', fxYahoo: 'JPY=X',      em: false },
  KR: { name: 'South Korea',     currency: 'KRW', fxYahoo: 'KRW=X',      em: false }
};
function countryMeta(code) {
  const c = (code || '').toUpperCase();
  return COUNTRY_META[c] || { name: c || 'Unknown', currency: 'USD', fxYahoo: null, em: false };
}

// ── Sector → macro driver classification ─────────────────────────
// Returns { key, label, fxSens, rateSens, commoditySens, commodities }.
// `commodities` is an array of Yahoo tickers to pull (empty = skip block).
const SECTOR_RULES = [
  ['tech',         ['semiconductor','software','technology','internet software','cloud','computer']],
  ['ecommerce',    ['internet retail','e-commerce','specialty retail','consumer cyclical']],
  ['comms',        ['communication services','media','telecom','entertainment']],
  ['healthcare',   ['health','pharma','biotech','medical','life sciences']],
  ['banking',      ['bank','financial services','insurance','asset management','capital markets','fintech','credit services']],
  ['consumer_def', ['beverage','food','consumer defensive','consumer staples','household','tobacco']],
  ['industrials',  ['industrial','aerospace','machinery','transport','airline','rail']],
  ['mining',       ['mining','materials','metals','steel','chemicals']],
  ['energy',       ['energy','oil','gas','petroleum']],
  ['agriculture',  ['agriculture','farm','crops']],
  ['realestate',   ['real estate','reit']],
  ['utilities',    ['utilities','utility','water','electric']]
];
function classifySector(industry) {
  const s = (industry || '').toLowerCase();
  if (!s) return 'default';
  for (const [key, patterns] of SECTOR_RULES) {
    if (patterns.some(p => s.includes(p))) return key;
  }
  return 'default';
}

// Sensitivity matrix. HIGH/MEDIUM/LOW per axis. `commodities` lists
// Yahoo tickers; commodity block is skipped if empty.
function sectorSensitivities(sectorKey, isForeignIssuer) {
  const baseFxForForeign = isForeignIssuer ? 'HIGH' : 'LOW';
  const m = {
    tech:         { rate:'HIGH',   fx: isForeignIssuer ? 'HIGH' : 'MEDIUM', commodity:'LOW',   commodities: [] },
    ecommerce:    { rate:'MEDIUM', fx: baseFxForForeign,                     commodity:'LOW',   commodities: [] },
    comms:        { rate:'MEDIUM', fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'LOW',   commodities: [] },
    healthcare:   { rate:'MEDIUM', fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'LOW',   commodities: [] },
    banking:      { rate:'HIGH',   fx: baseFxForForeign,                     commodity:'LOW',   commodities: [] },
    consumer_def: { rate:'LOW',    fx: isForeignIssuer ? 'HIGH' : 'MEDIUM', commodity:'MEDIUM',commodities: [] },
    industrials:  { rate:'MEDIUM', fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'MEDIUM',commodities: ['CL=F'] },
    mining:       { rate:'MEDIUM', fx: isForeignIssuer ? 'HIGH' : 'MEDIUM', commodity:'HIGH',  commodities: ['HG=F','GC=F'] },
    energy:       { rate:'MEDIUM', fx: 'MEDIUM',                             commodity:'HIGH',  commodities: ['BZ=F','CL=F'] },
    agriculture:  { rate:'MEDIUM', fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'HIGH',  commodities: ['ZS=F','ZC=F'] },
    realestate:   { rate:'HIGH',   fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'LOW',   commodities: [] },
    utilities:    { rate:'HIGH',   fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'MEDIUM',commodities: [] },
    default:      { rate:'MEDIUM', fx: isForeignIssuer ? 'MEDIUM' : 'LOW',  commodity:'LOW',   commodities: [] }
  };
  return m[sectorKey] || m.default;
}

// Primary-driver labels used in the structured response
function sectorDrivers(sectorKey, isForeignIssuer) {
  const map = {
    tech:        ['real_rates', 'risk_appetite', isForeignIssuer ? 'fx' : 'consumer_strength'],
    ecommerce:   ['consumer_confidence', isForeignIssuer ? 'fx_volatility' : 'real_rates', 'risk_appetite'],
    comms:       ['real_rates', 'consumer_confidence'],
    healthcare:  ['real_rates', 'regulatory_environment'],
    banking:     ['nominal_rates', 'yield_curve', 'credit_cycle'],
    consumer_def:['inflation', isForeignIssuer ? 'fx' : 'consumer_strength'],
    industrials: ['global_growth', 'oil_prices'],
    mining:      ['commodity_prices', 'usd_index', 'china_demand'],
    energy:      ['oil_prices', 'usd_index', 'geopolitics'],
    agriculture: ['commodity_prices', 'weather', 'usd_index'],
    realestate:  ['real_rates', 'mortgage_rates'],
    utilities:   ['nominal_rates', 'inflation'],
    default:     ['nominal_rates', 'usd_index']
  };
  return map[sectorKey] || map.default;
}

// ── Fetch helpers ────────────────────────────────────────────────
function safeFetch(url, opts) {
  return fetch(url, opts || {}).catch(() => null);
}
async function safeJson(r) {
  if (!r || !r.ok) return null;
  try {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch (_) { return null; }
}

// ── Yahoo Finance: 1y daily history for FX or commodity ────────
async function fetchYahooHistory(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const oneYearAgo = now - 365 * 24 * 3600;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?period1=${oneYearAgo}&period2=${now}&interval=1d&range=1y`;
  const r = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r || !r.ok) return null;
  let j;
  try { j = await r.json(); } catch (_) { return null; }
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result) return null;
  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = (quote.close || []).map((v, i) => ({ ts: ts[i], close: v }))
                                    .filter(p => typeof p.close === 'number' && isFinite(p.close));
  if (closes.length === 0) return null;
  return { symbol, meta, points: closes };
}

// ── FX summary: latest, 1y change, 1y realized vol, regime ──────
function summarizeFx(history) {
  if (!history || !history.points || history.points.length < 30) return null;
  const pts = history.points;
  const first = pts[0].close;
  const last  = pts[pts.length - 1].close;
  const change1y = (last - first) / first;

  // Daily log returns → annualized vol
  const rets = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].close, b = pts[i].close;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  let vol = null;
  if (rets.length > 10) {
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const variance = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rets.length - 1);
    vol = Math.sqrt(variance) * Math.sqrt(252);
  }

  // Regime classification — USD/X up means local currency depreciating
  // (since the pair is denominated as local-per-USD).
  let regime = 'STABLE';
  if (change1y > 0.10)  regime = 'DEPRECIATING';
  else if (change1y < -0.10) regime = 'APPRECIATING';
  else if (vol != null && vol > 0.20) regime = 'VOLATILE';

  let volBand = 'LOW';
  if (vol != null) {
    if (vol > 0.25) volBand = 'HIGH';
    else if (vol > 0.12) volBand = 'MEDIUM';
  }

  return {
    rate: +last.toFixed(4),
    change_1y_pct: +(change1y * 100).toFixed(2),
    volatility_1y_pct: vol != null ? +(vol * 100).toFixed(2) : null,
    volatility_band: volBand,
    regime
  };
}

// ── Commodity summary ────────────────────────────────────────────
const COMMODITY_LABELS = {
  'BZ=F': 'Brent Crude',
  'CL=F': 'WTI Crude',
  'HG=F': 'Copper',
  'GC=F': 'Gold',
  'ZS=F': 'Soybean',
  'ZC=F': 'Corn',
  'NG=F': 'Natural Gas',
  'SI=F': 'Silver'
};
function summarizeCommodity(history) {
  if (!history || !history.points || history.points.length < 30) return null;
  const pts = history.points;
  const first = pts[0].close;
  const last  = pts[pts.length - 1].close;
  return {
    symbol: history.symbol,
    label: COMMODITY_LABELS[history.symbol] || history.symbol,
    price: +last.toFixed(2),
    change_1y_pct: +(((last - first) / first) * 100).toFixed(2)
  };
}

// ── Macro derivations ────────────────────────────────────────────
function yieldCurve(t10, t2) {
  if (t10 == null || t2 == null) return { slope: null, category: 'N/A' };
  const slope = +(t10 - t2).toFixed(2);
  let category;
  if (slope < -0.10) category = 'INVERTED';
  else if (slope < 0.25) category = 'FLAT';
  else if (slope < 1.50) category = 'STEEPENING';
  else category = 'STEEP';
  return { slope, category };
}

function vixRegime(vix) {
  if (vix == null) return 'N/A';
  if (vix < 13) return 'LOW';
  if (vix < 20) return 'NORMAL';
  if (vix < 30) return 'ELEVATED';
  return 'HIGH';
}

// Fed cycle position from FedFunds + its 30/90d change
function fedCyclePosition(ffLatest, ff30dChange, ff90dChange) {
  if (ffLatest == null) return 'N/A';
  const d30 = ff30dChange && ff30dChange.abs != null ? ff30dChange.abs : 0;
  const d90 = ff90dChange && ff90dChange.abs != null ? ff90dChange.abs : 0;
  // Use the larger-magnitude window so a 1-meeting move shows up
  const change = Math.abs(d30) > Math.abs(d90) ? d30 : d90;
  if (change > 0.10)  return 'TIGHTENING';
  if (change < -0.10) return 'EASING';
  // No move in 90 days — distinguish "neutral" (rates near long-run avg) vs "hold"
  if (ffLatest > 4.5) return 'HOLD';   // restrictive territory, no change = holding tight
  if (ffLatest < 2.5) return 'HOLD';   // accommodative, no change = holding low
  return 'NEUTRAL';
}

// ── Claude narrative ─────────────────────────────────────────────
async function runClaude(apiKey, brief) {
  const system = `You are a senior macro strategist at a top-tier hedge fund. You will be given a structured JSON macro brief covering a specific ticker: its country, sector, current US rate environment, local FX context (if foreign), commodity backdrop (if sector-applicable), and pre-classified macro sensitivities.

Produce a concise institutional-grade narrative. Return ONLY a JSON object, no preamble:

{
  "macro_summary": "<2-3 sentences on the overall macro environment relevant to this ticker. Reference Fed cycle position, yield curve regime, and (if applicable) local-currency regime.>",
  "ticker_specific_impact": "<2-3 sentences on HOW the current macro setup hits THIS ticker via its primary drivers. Quantify where you can (e.g., 'every 10% peso depreciation translates to roughly X% USD-revenue headwind').>",
  "key_risks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "key_opportunities": ["<tailwind 1>", "<tailwind 2>", "<tailwind 3>"],
  "institutional_insight": "<3-4 sentences of NON-OBVIOUS contrarian macro read. For LATAM ADRs weight FX, capital-controls, and home-country rate cycles. For US names focus on real rates, yield curve, and what the consensus is mis-pricing.>"
}

Be quantitative. Reference actual values from the brief. No fluff. Avoid generic statements like "rates affect tech valuations" — instead say which specific level/move matters here.`;

  const user = `Analyze this macro brief and return the JSON narrative.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 1400, system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await r.json();
  if (!r.ok) return { error: 'Claude API call failed', detail: data && data.error ? data.error : data };
  const raw = (data.content || []).map(b => (b && b.text) || '').join('').trim();
  try { return { ok: JSON.parse(raw) }; } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) { try { return { ok: JSON.parse(fenced[1]) }; } catch (_) {} }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return { ok: JSON.parse(raw.slice(first, last + 1)) }; } catch (_) {}
  }
  return { error: 'Non-JSON response from Claude', raw_preview: raw.slice(0, 400) };
}

// ═══════════════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set', ticker });

  try {
    // ── 1. Identify ticker (country + sector) ──
    const profileRes = await safeFetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`
    );
    const profile = await safeJson(profileRes);
    if (!profile || !profile.name) {
      return res.status(200).json({
        ticker,
        error: 'No Finnhub profile for this ticker. Macro Agent covers US-listed names (incl. ADRs).'
      });
    }
    const company = profile.name;
    const industry = profile.finnhubIndustry || null;
    const countryCode = (profile.country || 'US').toUpperCase();
    const country = countryMeta(countryCode);
    const isForeignIssuer = countryCode !== 'US';
    const sectorKey = classifySector(industry);
    const sens = sectorSensitivities(sectorKey, isForeignIssuer);
    const drivers = sectorDrivers(sectorKey, isForeignIssuer);

    // ── 2. Build absolute /api/fred URL for the internal call ──
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
    const base = host ? `${proto}://${host}` : '';
    const fredUrl = `${base}/api/fred?series=all&days=400`;

    // ── 3. Fan-out: FRED + FX + commodities ──
    const fxSymbol = country.fxYahoo;
    const commoditySymbols = sens.commodities || [];

    const [fredJson, fxHistory, ...commodityHistories] = await Promise.all([
      safeFetch(fredUrl).then(safeJson),
      fxSymbol ? fetchYahooHistory(fxSymbol) : Promise.resolve(null),
      ...commoditySymbols.map(s => fetchYahooHistory(s))
    ]);

    // ── 4. Distill US macro ──
    const ind = (fredJson && fredJson.indicators) || {};
    const der = (fredJson && fredJson.derived) || {};
    const ffLatest    = ind.FEDFUNDS && ind.FEDFUNDS.latest ? ind.FEDFUNDS.latest.value : null;
    const t10         = ind.DGS10    && ind.DGS10.latest    ? ind.DGS10.latest.value    : null;
    const t2          = ind.DGS2     && ind.DGS2.latest     ? ind.DGS2.latest.value     : null;
    const vix         = ind.VIX      && ind.VIX.latest      ? ind.VIX.latest.value      : null;
    const dxy         = ind.DXY      && ind.DXY.latest      ? ind.DXY.latest.value      : null;
    const cpiYoy      = der.cpi_yoy != null ? der.cpi_yoy : null;
    const realRate    = der.real_fed_funds != null ? der.real_fed_funds : null;
    const cpiSource   = der.cpi_source || null;
    const ff30        = ind.FEDFUNDS ? ind.FEDFUNDS.change_30d : null;
    const ff90        = ind.FEDFUNDS ? ind.FEDFUNDS.change_90d : null;

    const yc = yieldCurve(t10, t2);
    const vixBand = vixRegime(vix);
    const cyclePosition = fedCyclePosition(ffLatest, ff30, ff90);

    const us_macro = {
      fed_funds_rate: ffLatest,
      treasury_10y: t10,
      treasury_2y: t2,
      yield_curve_slope: yc.slope,
      yield_curve_category: yc.category,
      cpi_yoy: cpiYoy,
      cpi_source: cpiSource,
      real_rate: realRate,
      vix: vix,
      vix_regime: vixBand,
      dxy: dxy,
      cycle_position: cyclePosition,
      fred_available: !!fredJson && !fredJson.error
    };

    // ── 5. Local macro (foreign issuers only) ──
    let local_macro = null;
    if (isForeignIssuer && fxSymbol) {
      const fx = summarizeFx(fxHistory);
      local_macro = fx
        ? { country: countryCode, country_name: country.name, currency: country.currency,
            yahoo_pair: fxSymbol, ...fx }
        : { country: countryCode, country_name: country.name, currency: country.currency,
            yahoo_pair: fxSymbol, error: 'Yahoo FX history unavailable' };
    }

    // ── 6. Commodity context ──
    let commodity_context;
    if (commoditySymbols.length === 0) {
      commodity_context = { applicable: false, reason: `${industry || 'Sector'} — no direct commodity exposure` };
    } else {
      const summaries = commodityHistories.map(summarizeCommodity).filter(Boolean);
      commodity_context = summaries.length
        ? { applicable: true, commodities: summaries }
        : { applicable: true, commodities: [], error: 'Yahoo commodity history unavailable' };
    }

    // ── 7. Ticker macro correlations ──
    const ticker_macro_correlations = {
      primary_drivers: drivers,
      fx_sensitivity: sens.fx,
      rate_sensitivity: sens.rate,
      commodity_sensitivity: sens.commodity
    };

    // Diagnostic log
    console.log(`[macro-agent] ${ticker}: country=${countryCode} sector=${sectorKey} ` +
      `ff=${ffLatest} t10-t2=${yc.slope} cpi=${cpiYoy} vix=${vix} ` +
      `fx_pair=${fxSymbol || 'none'} fx_chg=${local_macro && local_macro.change_1y_pct} ` +
      `commodities=${commoditySymbols.join(',') || 'none'}`);

    // ── 8. Claude narrative ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let narrative = null;
    if (apiKey) {
      const brief = {
        ticker, company, sector: industry, sectorKey,
        country: countryCode, country_name: country.name, currency: country.currency,
        is_foreign_issuer: isForeignIssuer, is_em: country.em,
        us_macro, local_macro, commodity_context, ticker_macro_correlations
      };
      const out = await runClaude(apiKey, brief);
      if (out.ok) narrative = out.ok;
      else console.log(`[macro-agent] ${ticker}: claude error`, out.error, out.raw_preview || out.detail);
    }

    // 6h CDN cache — macro data is slow-moving
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600');
    return res.status(200).json({
      ticker,
      company_name: company,
      sector: industry,
      sector_key: sectorKey,
      country: countryCode,
      country_name: country.name,
      is_foreign_issuer: isForeignIssuer,
      is_em: country.em,
      us_macro,
      local_macro,
      commodity_context,
      ticker_macro_correlations,
      macro_summary: narrative ? narrative.macro_summary : null,
      ticker_specific_impact: narrative ? narrative.ticker_specific_impact : null,
      key_risks: narrative ? narrative.key_risks : null,
      key_opportunities: narrative ? narrative.key_opportunities : null,
      institutional_insight: narrative ? narrative.institutional_insight : null,
      source: 'FRED + Yahoo Finance + Claude'
    });
  } catch (err) {
    console.log(`[macro-agent] exception for ${ticker}:`, err && err.message);
    return res.status(500).json({
      ticker,
      error: 'Macro Agent failure: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
