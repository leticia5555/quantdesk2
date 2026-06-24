// ═══════════════════════════════════════════════════════════════════
// Risk Anomaly Agent (Sprint 6 — final RFS #2 research agent)
//
//   GET /api/risk-agent?ticker=NVDA
//
// Quantifies the risk regime around a ticker via:
//   • Realized volatility (7d/30d/90d/252d, annualized log-return σ)
//   • Vol regime bucket (DEEPLY_COMPRESSED … ELEVATED)
//   • Beta vs SPY at 30d / 90d / 252d horizons + drift detection
//   • Correlation vs sector ETF + SPY at 30/90/252d horizons
//     → BREAKDOWN / MILD_BREAKDOWN / INTACT
//   • 252d max drawdown + current drawdown from 52-week high
//   • Short interest (best-effort via Finnhub; many tickers have none
//     under the free tier)
//   • Composite anomaly score (0–13) → LOW / MODERATE / ELEVATED /
//     EXTREME risk regime
//   • Claude writes the narrative on top (risk_summary,
//     dominant_risk_factor, asymmetric_risks, positioning, insight)
//
// 30-minute CDN cache.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// ── Bilingual support ─────────────────────────────────────────────
function langDirective(lang) {
  return lang === 'es'
    ? '\n\nIMPORTANTE: Responde completamente en español (español latinoamericano neutral). Todos los campos en lenguaje natural deben estar en español. Mantén los tickers, números, símbolos griegos (β, σ, ρ) y siglas (EPS, FX, ADR, BUY/HOLD/PASS, BEAT/MISS) en su forma original. Los nombres de empresas se mantienen en su idioma original. Las categorías cuantitativas (LOW/MODERATE/ELEVATED/EXTREME, INTACT/BREAKDOWN, etc.) se mantienen en inglés porque son códigos de estado del sistema; el resto del texto narrativo debe ser español.'
    : '';
}

// ── Operational country override (kept in sync with macro/event/sentiment) ──
const OPERATIONAL_COUNTRY_OVERRIDE = {
  STNE: { country: 'BR', name: 'Brazil' },
  PAGS: { country: 'BR', name: 'Brazil' },
  XP:   { country: 'BR', name: 'Brazil' },
  VTEX: { country: 'BR', name: 'Brazil' },
  INTR: { country: 'BR', name: 'Brazil' },
  NU:   { country: 'BR', name: 'Brazil' },
  GLOB: { country: 'AR', name: 'Argentina' },
  TS:   { country: 'AR', name: 'Argentina' },
  TX:   { country: 'AR', name: 'Argentina' },
  MELI: { country: 'BR', name: 'Brazil (primary)' },
  DLO:  { country: 'BR', name: 'Brazil (primary)' }
};

// ── Sector → Select-Sector SPDR ETF classifier ───────────────────
// Substring rules over Finnhub's finnhubIndustry. First hit wins.
const SECTOR_ETF_RULES = [
  ['XLK',  ['semiconductor','software','technology','internet software','cloud','computer hardware','it services']],
  ['XLF',  ['bank','insurance','financial services','capital markets','asset management','credit services','fintech']],
  ['XLE',  ['oil','gas','energy','petroleum']],
  ['XLY',  ['internet retail','specialty retail','auto','consumer cyclical','restaurant','apparel','leisure','homebuilding']],
  ['XLP',  ['beverage','food','consumer defensive','consumer staples','household','tobacco','personal product']],
  ['XLV',  ['pharma','biotech','health','medical','life sciences']],
  ['XLI',  ['industrial','aerospace','machinery','transport','airline','rail','defense','engineering']],
  ['XLB',  ['mining','materials','metals','steel','chemicals','paper','packaging']],
  ['XLU',  ['utilities','utility','water','electric utility']],
  ['XLRE', ['real estate','reit']],
  ['XLC',  ['telecom','media','communication services','entertainment','broadcasting','interactive media']]
];
function sectorToEtf(industry) {
  const s = (industry || '').toLowerCase();
  if (!s) return { etf: 'SPY', fallback: true };
  for (const [etf, pats] of SECTOR_ETF_RULES) {
    if (pats.some(p => s.includes(p))) return { etf, fallback: false };
  }
  return { etf: 'SPY', fallback: true };
}

// ── Fetch helpers ────────────────────────────────────────────────
function safeFetch(url, opts) { return fetch(url, opts || {}).catch(() => null); }
async function safeJson(r) {
  if (!r || !r.ok) return null;
  try {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch (_) { return null; }
}

// Yahoo Finance v8 chart — 252 daily closes.
async function fetchYahooSeries(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const yearAgo = now - 380 * 24 * 3600;  // pad a bit so we have ≥252 trading days
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?period1=${yearAgo}&period2=${now}&interval=1d&range=1y`;
  const r = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await safeJson(r);
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result) return null;
  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const volumes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].volume) || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && isFinite(c) && c > 0) {
      points.push({ ts: ts[i], close: c, volume: volumes[i] || 0 });
    }
  }
  return { symbol, meta, points };
}

// ── Stat helpers (defensive: every helper returns null on bad input) ──
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}
function mean(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0; for (const x of arr) s += x;
  return s / arr.length;
}
function stdev(arr) {
  if (!arr || arr.length < 2) return null;
  const m = mean(arr);
  let v = 0;
  for (const x of arr) v += (x - m) * (x - m);
  return Math.sqrt(v / (arr.length - 1));
}
function covariance(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 2) return null;
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}
function correlation(a, b) {
  const sa = stdev(a), sb = stdev(b), cov = covariance(a, b);
  if (sa == null || sb == null || cov == null || sa === 0 || sb === 0) return null;
  return cov / (sa * sb);
}
function beta(asset, mkt) {
  const v = covariance(asset, mkt);
  const mv = stdev(mkt);
  if (v == null || mv == null || mv === 0) return null;
  return v / (mv * mv);
}

// Annualized vol from log returns
function annualizedVol(returns) {
  const s = stdev(returns);
  return s == null ? null : s * Math.sqrt(252);
}

// Align two Yahoo point series on their common trading days (UTC day buckets)
// and return the paired log-return series. Aligning by date — rather than by
// tail position — keeps beta/correlation correct when the two series have a
// missing/extra bar somewhere in the middle (holidays, halts, LATAM calendars).
function alignReturnsByDate(pointsA, pointsB) {
  if (!pointsA || !pointsB) return [[], []];
  const mapB = new Map();
  for (const p of pointsB) mapB.set(Math.floor(p.ts / 86400), p.close);
  const closesA = [];
  const closesB = [];
  for (const p of pointsA) {            // pointsA is chronological (Yahoo ascending)
    const day = Math.floor(p.ts / 86400);
    if (mapB.has(day)) { closesA.push(p.close); closesB.push(mapB.get(day)); }
  }
  return [logReturns(closesA), logReturns(closesB)];
}

// ── Categorizers ─────────────────────────────────────────────────
function volRegime(v30, v252) {
  if (v30 == null || v252 == null || v252 === 0) return { regime: 'UNKNOWN', ratio: null };
  const r = v30 / v252;
  let regime;
  if (r > 1.5)      regime = 'ELEVATED';
  else if (r > 1.2) regime = 'MILDLY_ELEVATED';
  else if (r >= 0.8) regime = 'NORMAL';
  else if (r > 0.6) regime = 'COMPRESSED';
  else              regime = 'DEEPLY_COMPRESSED';
  return { regime, ratio: r };
}

function betaDrift(b30, b252) {
  if (b30 == null || b252 == null) return { drift: null, category: 'UNKNOWN', direction: 'UNKNOWN' };
  const drift = b30 - b252;
  const mag = Math.abs(drift);
  let category;
  if (mag > 0.4) category = 'SIGNIFICANT_DRIFT';
  else if (mag > 0.2) category = 'MODERATE_DRIFT';
  else category = 'STABLE_BETA';
  return { drift, category, direction: drift > 0 ? 'INCREASING' : drift < 0 ? 'DECREASING' : 'FLAT' };
}

function correlationBreakdown(c30, c252) {
  if (c30 == null || c252 == null) return 'UNKNOWN';
  if (c252 > 0.7 && c30 < 0.4) return 'BREAKDOWN';
  if (c252 > 0.5 && c30 < 0.3) return 'MILD_BREAKDOWN';
  return 'INTACT';
}

function drawdownCategory(currentDrawdown) {
  if (currentDrawdown == null) return 'UNKNOWN';
  // currentDrawdown is negative or zero (e.g. -0.12 = 12% below high)
  const dd = Math.abs(currentDrawdown);
  if (dd <= 0.05) return 'NEAR_HIGHS';
  if (dd <= 0.15) return 'MILD_PULLBACK';
  if (dd <= 0.30) return 'CORRECTION';
  return 'BEAR_MARKET';
}

function shortInterestCategory(pct) {
  if (pct == null) return 'UNKNOWN';
  if (pct > 20) return 'EXTREMELY_HIGH';
  if (pct > 10) return 'HIGH';
  if (pct > 5)  return 'MODERATE';
  return 'LOW';
}

// ── Anomaly composite score ──────────────────────────────────────
function anomalyScore({ vol, betaA, corr, ddCat, siCat }) {
  let score = 0;
  const breakdown = {};

  // Vol regime: extremes score high (both directions)
  const vp = vol.regime === 'ELEVATED' || vol.regime === 'DEEPLY_COMPRESSED' ? 3
           : vol.regime === 'MILDLY_ELEVATED' || vol.regime === 'COMPRESSED' ? 2 : 0;
  breakdown.volatility = vp; score += vp;

  // Beta drift
  const bp = betaA.category === 'SIGNIFICANT_DRIFT' ? 3
           : betaA.category === 'MODERATE_DRIFT' ? 2 : 0;
  breakdown.beta = bp; score += bp;

  // Correlation
  const cp = corr === 'BREAKDOWN' ? 3 : corr === 'MILD_BREAKDOWN' ? 2 : 0;
  breakdown.correlation = cp; score += cp;

  // Drawdown
  const dp = (ddCat === 'BEAR_MARKET' || ddCat === 'CORRECTION') ? 2
           : ddCat === 'MILD_PULLBACK' ? 1 : 0;
  breakdown.drawdown = dp; score += dp;

  // Short interest (unavailable = 0, not penalized)
  const sp = siCat === 'EXTREMELY_HIGH' ? 2
           : siCat === 'HIGH' || siCat === 'MODERATE' ? 1 : 0;
  breakdown.short_interest = sp; score += sp;

  return { score, breakdown };
}

function riskRegime(score) {
  if (score >= 10) return 'EXTREME_RISK_REGIME';
  if (score >= 7)  return 'ELEVATED_RISK_REGIME';
  if (score >= 4)  return 'MODERATE_RISK_REGIME';
  return 'LOW_RISK_REGIME';
}

// Find the single highest-scoring concern for `primary_concern` field
function primaryConcern(breakdown, vol, betaA, corr, ddCat) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (!entries.length || entries[0][1] === 0) return 'no_material_concern';
  const top = entries[0][0];
  // Decorate with the second-highest if also material (>=2) — compound
  // labels like "vol_expansion_with_correlation_breakdown" land here.
  const second = entries.find((e, i) => i > 0 && e[1] >= 2);
  const lbl = name => {
    if (name === 'volatility')   return vol.regime === 'ELEVATED' || vol.regime === 'MILDLY_ELEVATED' ? 'vol_expansion' : 'vol_compression';
    if (name === 'beta')         return betaA.direction === 'INCREASING' ? 'rising_beta' : 'falling_beta';
    if (name === 'correlation')  return corr === 'BREAKDOWN' ? 'correlation_breakdown' : 'correlation_softening';
    if (name === 'drawdown')     return (ddCat === 'BEAR_MARKET') ? 'bear_market_drawdown' : 'correction_drawdown';
    if (name === 'short_interest') return 'crowded_short';
    return name;
  };
  if (second) return `${lbl(top)}_with_${lbl(second[0])}`;
  return lbl(top);
}

// ── Drawdown helpers ─────────────────────────────────────────────
// Returns max drawdown over the window (worst peak-to-trough as a
// negative number, e.g. -0.32), plus current drawdown from running
// peak, plus dated 52w high/low.
function drawdownAnalysis(points) {
  if (!points || points.length === 0) {
    return { max_drawdown: null, current_drawdown: null, high_date: null, low_date: null };
  }
  let peak = -Infinity, peakIdx = -1;
  let trough = Infinity, troughIdx = -1;
  let maxDd = 0;  // 0 = no drawdown; negative numbers worse
  let runningPeak = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const c = points[i].close;
    if (c > peak)   { peak = c; peakIdx = i; }
    if (c < trough) { trough = c; troughIdx = i; }
    if (c > runningPeak) runningPeak = c;
    const dd = (c - runningPeak) / runningPeak;
    if (dd < maxDd) maxDd = dd;
  }
  const lastClose = points[points.length - 1].close;
  const cur = peak > 0 ? (lastClose - peak) / peak : null;
  const fmtDate = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  return {
    max_drawdown: +maxDd.toFixed(4),
    current_drawdown: cur != null ? +cur.toFixed(4) : null,
    high_date: peakIdx >= 0 ? fmtDate(points[peakIdx].ts) : null,
    low_date: troughIdx >= 0 ? fmtDate(points[troughIdx].ts) : null
  };
}

// ── Short interest (best-effort) ─────────────────────────────────
// Finnhub's free tier doesn't always expose /stock/short-interest.
// We try it; if absent / empty, return null and skip the section
// without penalizing the anomaly score.
async function fetchShortInterest(ticker, finnhubKey) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/stock/short-interest?symbol=${ticker}&from=${monthAgo}&to=${today}&token=${finnhubKey}`;
  const r = await safeFetch(url);
  const j = await safeJson(r);
  const items = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
  if (!items.length) return null;
  // Sort ascending by settlementDate
  items.sort((a, b) => new Date(a.settlementDate || 0) - new Date(b.settlementDate || 0));
  const last = items[items.length - 1];
  // Compare the latest reading against the immediately-preceding one, not the
  // oldest record in the fetch window.
  const prev = items.length > 1 ? items[items.length - 2] : null;
  // Finnhub fields: shortInterest, daysToCover, settlementDate
  const pct = typeof last.shortInterestRatio === 'number' ? last.shortInterestRatio
            : (typeof last.percentOfFloat === 'number' ? last.percentOfFloat : null);
  if (pct == null) return null;
  const prevPct = prev && (typeof prev.shortInterestRatio === 'number' ? prev.shortInterestRatio
                : typeof prev.percentOfFloat === 'number' ? prev.percentOfFloat : null);
  const change = prevPct != null ? pct - prevPct : null;
  return {
    available: true,
    pct_of_float: +Number(pct).toFixed(2),
    days_to_cover: typeof last.daysToCover === 'number' ? +last.daysToCover.toFixed(2) : null,
    change_30d: change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}pp` : null,
    category: shortInterestCategory(pct)
  };
}

// ── Claude narrative ─────────────────────────────────────────────
async function runClaude(apiKey, brief, lang) {
  const system = `You are a senior risk-portfolio manager at a top-tier hedge fund. You will be given a structured JSON risk brief covering a specific ticker: realized volatility regime, beta drift vs SPY, sector + SPY correlations, drawdown analysis, short interest (if available), and a composite anomaly score.

Produce a concise institutional-grade risk narrative. Return ONLY a JSON object, no preamble:

{
  "risk_summary": "<2-3 sentences. What is the current risk regime, and what's the headline number that proves it? Reference the anomaly score out of 13.>",
  "dominant_risk_factor": "<2-3 sentences. WHICH of the five risk dimensions is screaming loudest right now (vol regime / beta drift / correlation breakdown / drawdown / short interest), and what does it imply?>",
  "asymmetric_risks": "<2-3 sentences. Where is the risk skewed? Upside-asymmetric (vol compressed at lows with positive catalysts) or downside-asymmetric (crowded long with beta drift up)?>",
  "positioning_considerations": [
    "<actionable consideration 1 — be specific about position sizing, hedge, or timing>",
    "<actionable consideration 2>",
    "<actionable consideration 3>"
  ],
  "institutional_insight": "<5 sentences. NON-OBVIOUS contrarian read. Reference specific numbers (β drift in points, vol expansion ratio, correlation drop). For LATAM ADRs explicitly weight that correlation breakdown vs the US sector ETF often signals home-country idiosyncratic catalyst (BCB rate move, election, capital controls). For US names: tie vol regime to options pricing implications.>"
}

Be quantitative. Use the actual numbers (β, σ, ρ, drawdown %) in the brief. No fluff. If a section has no data (e.g. short interest unavailable), don't invent — pivot to what's there.`;

  const user = `Analyze this risk brief and return the JSON narrative.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 1600, system: system + langDirective(lang),
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
  const lang = (req.query.lang || 'en').toString().toLowerCase();
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set', ticker });

  try {
    // ── 1. Profile (sector → ETF, country override) ──
    const profileRes = await safeFetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`
    );
    const profile = await safeJson(profileRes);
    if (!profile || !profile.name) {
      return res.status(200).json({
        ticker,
        error: 'No Finnhub profile for this ticker. Risk Agent covers US-listed names (incl. ADRs).'
      });
    }

    const company = profile.name;
    const industry = profile.finnhubIndustry || null;
    const { etf: sectorEtf, fallback: etfFallback } = sectorToEtf(industry);

    const finnhubCountry = (profile.country || 'US').toUpperCase();
    const override = OPERATIONAL_COUNTRY_OVERRIDE[ticker];
    const effectiveCountry = override ? override.country : finnhubCountry;
    const countryName = override ? override.name : finnhubCountry;
    const countryOverrideApplied = !!override;

    // ── 2. Price series (parallel) ──
    const [tickerSeries, spySeries, sectorSeries, shortInterest] = await Promise.all([
      fetchYahooSeries(ticker),
      fetchYahooSeries('SPY'),
      sectorEtf === 'SPY' ? Promise.resolve(null) : fetchYahooSeries(sectorEtf),
      fetchShortInterest(ticker, finnhubKey)
    ]);

    if (!tickerSeries || !tickerSeries.points || tickerSeries.points.length < 30) {
      return res.status(200).json({
        ticker,
        error: 'Insufficient price history for risk analysis (need ≥30 trading days).'
      });
    }

    const insufficient = tickerSeries.points.length < 60;
    const avgVolume = tickerSeries.points.length
      ? tickerSeries.points.reduce((s, p) => s + p.volume, 0) / tickerSeries.points.length
      : null;
    const lowVolumeFlag = avgVolume != null && avgVolume < 100_000;

    // ── 3. Returns + realized vol ──
    const tickerCloses = tickerSeries.points.map(p => p.close);
    const tickerRets = logReturns(tickerCloses);

    const tail = (a, n) => a.slice(-n);
    const v7   = annualizedVol(tail(tickerRets, 6));    // 6 returns ≈ 7 days
    const v30  = annualizedVol(tail(tickerRets, 29));
    const v90  = annualizedVol(tail(tickerRets, 89));
    const v252 = annualizedVol(tail(tickerRets, 251));

    const vol = volRegime(v30, v252);
    const expansionRatio = vol.ratio;

    // ── 4. Beta vs SPY (need aligned return series) ──
    let b30 = null, b90 = null, b252 = null;
    let corrSpy30 = null, corrSpy252 = null;
    if (spySeries && spySeries.points && spySeries.points.length >= 30) {
      // Align ticker and SPY on common trading days before taking tails
      const [taRets, spyRets] = alignReturnsByDate(tickerSeries.points, spySeries.points);
      const ta252 = taRets.slice(-251), sp252 = spyRets.slice(-251);
      const ta90  = taRets.slice(-89),  sp90  = spyRets.slice(-89);
      const ta30  = taRets.slice(-29),  sp30  = spyRets.slice(-29);
      b252       = beta(ta252, sp252);
      b90        = beta(ta90,  sp90);
      b30        = beta(ta30,  sp30);
      corrSpy30  = correlation(ta30,  sp30);
      corrSpy252 = correlation(ta252, sp252);
    }
    const betaA = betaDrift(b30, b252);

    // ── 5. Sector correlation ──
    let corrSec30 = null, corrSec90 = null, corrSec252 = null;
    if (sectorSeries && sectorSeries.points && sectorSeries.points.length >= 30) {
      const [taRets, secRets] = alignReturnsByDate(tickerSeries.points, sectorSeries.points);
      const ta252 = taRets.slice(-251), sc252 = secRets.slice(-251);
      const ta90  = taRets.slice(-89),  sc90  = secRets.slice(-89);
      const ta30  = taRets.slice(-29),  sc30  = secRets.slice(-29);
      corrSec252 = correlation(ta252, sc252);
      corrSec90  = correlation(ta90,  sc90);
      corrSec30  = correlation(ta30,  sc30);
    } else if (sectorEtf === 'SPY') {
      // Sector was already SPY (default fallback for unknown sectors);
      // reuse the SPY correlations.
      corrSec252 = corrSpy252;
      corrSec30 = corrSpy30;
      if (spySeries && spySeries.points) {
        const [taRets, spyRets] = alignReturnsByDate(tickerSeries.points, spySeries.points);
        const ta90 = taRets.slice(-89), sp90 = spyRets.slice(-89);
        corrSec90 = correlation(ta90, sp90);
      }
    }
    const corrStatus = correlationBreakdown(corrSec30, corrSec252);

    // ── 6. Drawdown ──
    const dd = drawdownAnalysis(tickerSeries.points);
    const ddCat = drawdownCategory(dd.current_drawdown);

    // ── 7. Composite anomaly score ──
    const siCat = shortInterest ? shortInterest.category : 'UNKNOWN';
    const { score, breakdown } = anomalyScore({ vol, betaA, corr: corrStatus, ddCat, siCat });
    const regime = riskRegime(score);
    const primary = primaryConcern(breakdown, vol, betaA, corrStatus, ddCat);

    // ── 8. Build response payload ──
    const volInterp = v30 != null && v252 != null
      ? `Recent vol ${Math.abs((expansionRatio - 1) * 100).toFixed(0)}% ${expansionRatio >= 1 ? 'above' : 'below'} 1-year baseline`
      : 'Vol regime unavailable';
    const betaInterp = b252 != null && b30 != null
      ? `${betaA.direction === 'INCREASING' ? 'Risk profile rising' : betaA.direction === 'DECREASING' ? 'Risk profile easing' : 'Stable beta'} — β ${betaA.direction === 'INCREASING' ? 'up' : betaA.direction === 'DECREASING' ? 'down' : 'flat'} ${Math.abs((b30 - b252) / Math.max(0.1, Math.abs(b252)) * 100).toFixed(0)}% over baseline`
      : 'Insufficient data for beta analysis';
    const corrInterp = corrStatus === 'BREAKDOWN'
      ? `Idiosyncratic move — sector correlation halved from ${corrSec252 != null ? corrSec252.toFixed(2) : 'N/A'} to ${corrSec30 != null ? corrSec30.toFixed(2) : 'N/A'}`
      : corrStatus === 'MILD_BREAKDOWN'
        ? 'Mild decoupling from sector — name acting more idiosyncratic'
        : corrStatus === 'INTACT'
          ? 'Correlation profile intact — moving with the sector'
          : 'Sector correlation data unavailable';

    const payload = {
      ticker,
      company_name: company,
      sector: industry,
      sector_etf: sectorEtf,
      sector_etf_fallback: etfFallback,
      country: effectiveCountry,
      country_name: countryName,
      country_legal: finnhubCountry,
      country_override_applied: countryOverrideApplied,
      data_quality: {
        trading_days: tickerSeries.points.length,
        avg_volume: avgVolume != null ? +avgVolume.toFixed(0) : null,
        low_volume_flag: lowVolumeFlag,
        insufficient_history: insufficient
      },
      risk_overview: {
        regime,
        anomaly_score: score,
        max_anomaly_score: 13,
        primary_concern: primary,
        breakdown
      },
      volatility: {
        realized_7d:   v7   != null ? +v7.toFixed(4)   : null,
        realized_30d:  v30  != null ? +v30.toFixed(4)  : null,
        realized_90d:  v90  != null ? +v90.toFixed(4)  : null,
        realized_252d: v252 != null ? +v252.toFixed(4) : null,
        regime: vol.regime,
        expansion_ratio: expansionRatio != null ? +expansionRatio.toFixed(3) : null,
        interpretation: volInterp
      },
      beta_analysis: {
        beta_252d: b252 != null ? +b252.toFixed(3) : null,
        beta_90d:  b90  != null ? +b90.toFixed(3)  : null,
        beta_30d:  b30  != null ? +b30.toFixed(3)  : null,
        drift: betaA.drift != null ? +betaA.drift.toFixed(3) : null,
        drift_category: betaA.category,
        direction: betaA.direction,
        interpretation: betaInterp
      },
      correlation: {
        ticker_vs_sector_30d:  corrSec30  != null ? +corrSec30.toFixed(3)  : null,
        ticker_vs_sector_90d:  corrSec90  != null ? +corrSec90.toFixed(3)  : null,
        ticker_vs_sector_252d: corrSec252 != null ? +corrSec252.toFixed(3) : null,
        ticker_vs_spy_30d:     corrSpy30  != null ? +corrSpy30.toFixed(3)  : null,
        ticker_vs_spy_252d:    corrSpy252 != null ? +corrSpy252.toFixed(3) : null,
        breakdown_status: corrStatus,
        interpretation: corrInterp
      },
      drawdown_analysis: {
        max_drawdown_252d: dd.max_drawdown,
        current_drawdown_from_52w_high: dd.current_drawdown,
        category: ddCat,
        '52w_high_date': dd.high_date,
        '52w_low_date': dd.low_date
      },
      short_interest: shortInterest || { available: false }
    };

    console.log(`[risk-agent] ${ticker}: sector=${industry || '—'}→${sectorEtf} country=${effectiveCountry} ` +
      `v30=${v30 ? v30.toFixed(3) : 'n/a'} v252=${v252 ? v252.toFixed(3) : 'n/a'} ratio=${expansionRatio ? expansionRatio.toFixed(2) : 'n/a'} ` +
      `β30=${b30 ? b30.toFixed(2) : 'n/a'} β252=${b252 ? b252.toFixed(2) : 'n/a'} drift=${betaA.category} ` +
      `corr30/252=${corrSec30 ? corrSec30.toFixed(2) : 'n/a'}/${corrSec252 ? corrSec252.toFixed(2) : 'n/a'} ${corrStatus} ` +
      `dd=${ddCat} score=${score}/13 ${regime}`);

    // ── 9. Claude narrative ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let narrative = null;
    if (apiKey) {
      const out = await runClaude(apiKey, payload, lang);
      if (out.ok) narrative = out.ok;
      else console.log(`[risk-agent] ${ticker}: claude error`, out.error, out.raw_preview || out.detail);
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=1800'); // 30min
    return res.status(200).json({
      ...payload,
      risk_summary:               narrative ? narrative.risk_summary               : null,
      dominant_risk_factor:       narrative ? narrative.dominant_risk_factor       : null,
      asymmetric_risks:           narrative ? narrative.asymmetric_risks           : null,
      positioning_considerations: narrative ? narrative.positioning_considerations : null,
      institutional_insight:      narrative ? narrative.institutional_insight      : null,
      source: 'Yahoo Finance + Finnhub + Claude'
    });
  } catch (err) {
    console.log(`[risk-agent] exception for ${ticker}:`, err && err.message);
    return res.status(500).json({
      ticker,
      error: 'Risk Agent failure: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
