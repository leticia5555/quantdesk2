// ═══════════════════════════════════════════════════════════════════
// Fundamental Agent (Sprint 2)
//
//   GET /api/fundamental-agent?ticker=NVDA
//
// Pipeline:
//   1. Pull Finnhub: profile2, metric/all, financials-reported (annual,
//      5y), peers, quote. All in parallel with graceful nulls.
//   2. Compute multiples for the ticker + up to 4 peers and a sector
//      median.
//   3. Compute Altman Z, Piotroski F, Beneish M from the 5y annual
//      statements. Concepts are matched flexibly so both US-GAAP
//      (10-K filers) and IFRS (20-F filers) work.
//   4. Build a 5-year DCF: revenue grows from 3y CAGR fading to 5%,
//      FCF margin from 3y average, WACC from CAPM + after-tax cost
//      of debt, terminal value via Gordon Growth at 2.5%. Sensitivity
//      grid 3x3 (WACC ±1pp × g ±0.5pp).
//   5. Signal: upside vs current price → PREMIUM / FAIR / DISCOUNT.
//   6. Claude composes the narrative panels + institutional insight.
//
// Loss-making / data-poor companies: skip DCF, return multiples +
// scores + a Claude narrative that acknowledges the limitation.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// DCF defaults
const RISK_FREE_RATE = 0.045;
const EQUITY_RISK_PREMIUM = 0.055;
const TERMINAL_GROWTH = 0.025;
const DEFAULT_TAX_RATE = 0.25;
const DEFAULT_BETA = 1.0;
const DEFAULT_COST_OF_DEBT = 0.05;
const MAX_REVENUE_GROWTH = 0.30;  // dampen early-year growth
const TERMINAL_FADE_GROWTH = 0.05; // final-year revenue growth target

// ── Manual peer fallback ──────────────────────────────────────────
// Finnhub /stock/peers is sparse for LATAM ADRs and a handful of other
// names. When it returns fewer than 2 peers we fall back to this map.
// Tickers must be US-listed so /stock/metric resolves cleanly.
const MANUAL_PEER_FALLBACK = {
  // LATAM e-commerce / fintech
  MELI: ['AMZN', 'BABA', 'PDD', 'EBAY'],
  NU:   ['SOFI', 'AFRM', 'V', 'MA'],
  STNE: ['SQ', 'PYPL', 'AFRM', 'SOFI'],
  PAGS: ['SQ', 'PYPL', 'STNE', 'SOFI'],
  // LATAM mining / materials
  VALE: ['RIO', 'BHP', 'FCX', 'NEM'],
  SQM:  ['ALB', 'LAC', 'PLL', 'MP'],
  // LATAM banking
  ITUB: ['BBD', 'BSBR', 'BAP', 'BCH'],
  BBD:  ['ITUB', 'BSBR', 'BAP', 'BCH'],
  BBAR: ['GGAL', 'SUPV', 'BAP', 'BMA'],
  GGAL: ['BBAR', 'SUPV', 'BMA', 'BAP'],
  BSAC: ['BCH', 'BAP', 'BBD', 'ITUB'],
  // LATAM energy
  PBR:  ['XOM', 'CVX', 'BP', 'TTE'],
  EC:   ['XOM', 'CVX', 'BP', 'PBR'],
  // LATAM consumer / beverage
  FMX:  ['KOF', 'ABEV', 'BUD', 'CCEP'],
  KOF:  ['FMX', 'ABEV', 'BUD', 'CCEP'],
  ABEV: ['BUD', 'CCEP', 'KOF', 'FMX'],
  // LATAM telecom / media
  AMX:  ['VOD', 'T', 'VZ', 'TMUS'],
  TV:   ['DIS', 'PARA', 'WBD', 'CMCSA'],
  // LATAM airports
  ASR:  ['PAC', 'OMAB', 'CAAP', 'GOL'],
  PAC:  ['ASR', 'OMAB', 'CAAP', 'GOL'],
  // LATAM steel / industrial
  GGB:  ['TX', 'SID', 'X', 'STLD'],
  TX:   ['GGB', 'SID', 'X', 'NUE'],
  SUZ:  ['IP', 'WRK', 'PKG', 'KS'],
  ERJ:  ['BA', 'AIR', 'LMT', 'GD']
};

// ── Finnhub fetch helpers ─────────────────────────────────────────
function safeFetch(url) {
  return fetch(url).catch(() => null);
}
async function safeJson(r) {
  if (!r || !r.ok) return null;
  try {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch (_) { return null; }
}

// ── Concept lookup (handles US-GAAP and IFRS conventions) ────────
// Each pattern is a lowercased substring matched against `concept`
// AND `label`. Patterns are tried in order; first hit wins per report.
function findConcept(items, patterns) {
  if (!Array.isArray(items)) return null;
  const norm = items.map(it => ({
    it,
    concept: (it.concept || '').toLowerCase(),
    label: (it.label || '').toLowerCase()
  }));
  for (const pat of patterns) {
    const p = pat.toLowerCase();
    for (const row of norm) {
      if (row.concept.includes(p) || row.label.includes(p)) {
        const v = row.it.value;
        if (typeof v === 'number' && isFinite(v)) return v;
      }
    }
  }
  return null;
}

// Extract a normalized annual snapshot from one financials-reported entry.
function extractSnapshot(report) {
  const r = report && report.report ? report.report : {};
  const ic = Array.isArray(r.ic) ? r.ic : [];
  const bs = Array.isArray(r.bs) ? r.bs : [];
  const cf = Array.isArray(r.cf) ? r.cf : [];

  const revenue = findConcept(ic, [
    'us-gaap_revenuefromcontractwithcustomerexcludingassessedtax',
    'us-gaap_revenues',
    'us-gaap_salesrevenuenet',
    'ifrs-full_revenue',
    'revenuefromcontractswithcustomers',
    'totalrevenue',
    'revenue', 'sales'
  ]);
  const grossProfit = findConcept(ic, ['grossprofit', 'gross profit']);
  const cogs = findConcept(ic, [
    'costofrevenue', 'costofgoodsandservicessold', 'costofsales', 'cost of revenue', 'cost of sales'
  ]);
  const sga = findConcept(ic, [
    'sellinggeneralandadministrative', 'sga', 'selling, general'
  ]);
  const operatingIncome = findConcept(ic, [
    'operatingincomeloss', 'profitlossfromoperatingactivities',
    'operating income', 'operating profit'
  ]);
  const interestExpense = findConcept(ic, [
    'interestexpense', 'financecosts', 'interest expense'
  ]);
  const incomeTax = findConcept(ic, [
    'incometaxexpensebenefit', 'incometaxexpensecontinuingoperations',
    'incometaxexpense', 'income tax'
  ]);
  const netIncome = findConcept(ic, [
    'netincomeloss', 'profitloss', 'net income', 'profit (loss)'
  ]);
  const depreciation = findConcept(ic, [
    'depreciationdepletionandamortization', 'depreciationandamortization',
    'depreciation and amortization'
  ]) || findConcept(cf, [
    'depreciationdepletionandamortization', 'depreciationandamortization',
    'depreciation and amortization'
  ]);

  const totalAssets = findConcept(bs, ['us-gaap_assets', 'ifrs-full_assets', 'total assets']);
  const currentAssets = findConcept(bs, ['assetscurrent', 'currentassets', 'total current assets']);
  const totalLiabilities = findConcept(bs, ['us-gaap_liabilities', 'ifrs-full_liabilities', 'total liabilities']);
  const currentLiabilities = findConcept(bs, ['liabilitiescurrent', 'currentliabilities', 'total current liabilities']);
  const retainedEarnings = findConcept(bs, ['retainedearnings', 'retained earnings']);
  const stockholdersEquity = findConcept(bs, ['stockholdersequity', 'ifrs-full_equity', 'total equity', 'shareholders equity', 'equity attributable']);
  const longTermDebt = findConcept(bs, ['longtermdebtnoncurrent', 'longtermdebt', 'noncurrentborrowings', 'long-term debt', 'long term debt']);
  const cash = findConcept(bs, ['cashandcashequivalents', 'cash and cash equivalents', 'cash']);
  const inventory = findConcept(bs, ['inventorynet', 'inventories', 'inventory']);
  const receivables = findConcept(bs, ['accountsreceivablenetcurrent', 'tradeandotherreceivables', 'accounts receivable', 'receivables']);
  const ppe = findConcept(bs, ['propertyplantandequipmentnet', 'ppe', 'property, plant']);

  const cfo = findConcept(cf, [
    'netcashprovidedbyusedinoperatingactivities',
    'cashflowsfromusedinoperatingactivities',
    'operatingactivities', 'cash from operating'
  ]);
  const capex = findConcept(cf, [
    'paymentstoacquirepropertyplantandequipment',
    'purchaseofpropertyplantandequipment',
    'paymentsforpropertyplantandequipment',
    'capital expenditure'
  ]);

  // Total debt: try direct total; else sum LT + current portion of LTD
  let totalDebt = findConcept(bs, ['longtermdebt', 'totaldebt']);
  if (totalDebt == null) totalDebt = longTermDebt;

  return {
    year: report.year || null,
    endDate: report.endDate || null,
    revenue, grossProfit, cogs, sga,
    operatingIncome, interestExpense, incomeTax, netIncome, depreciation,
    totalAssets, currentAssets, totalLiabilities, currentLiabilities,
    retainedEarnings, stockholdersEquity, longTermDebt, totalDebt,
    cash, inventory, receivables, ppe,
    cfo, capex,
    fcf: (typeof cfo === 'number' && typeof capex === 'number')
      ? cfo - Math.abs(capex)  // capex is reported as negative in many filings
      : null
  };
}

// ── Score calculations ───────────────────────────────────────────
function altmanZ(snap, marketCap) {
  const { totalAssets: TA, currentAssets: CA, currentLiabilities: CL,
          retainedEarnings: RE, operatingIncome: EBIT,
          totalLiabilities: TL, revenue } = snap;
  if (!TA || !TL || TL <= 0 || TA <= 0) return null;
  const WC = (CA != null && CL != null) ? (CA - CL) : null;
  const parts = {
    a: WC != null ? 1.2 * (WC / TA) : null,
    b: RE != null ? 1.4 * (RE / TA) : null,
    c: EBIT != null ? 3.3 * (EBIT / TA) : null,
    d: marketCap != null && marketCap > 0 ? 0.6 * (marketCap / TL) : null,
    e: revenue != null ? 1.0 * (revenue / TA) : null
  };
  // Need at least 3 of 5 components to produce a meaningful score
  const present = Object.values(parts).filter(v => v != null);
  if (present.length < 3) return null;
  return present.reduce((s, v) => s + v, 0);
}

function altmanInterpretation(z) {
  if (z == null) return { band: 'N/A', desc: 'Insufficient data' };
  if (z > 2.99) return { band: 'SAFE', desc: 'Low distress risk' };
  if (z >= 1.81) return { band: 'GREY', desc: 'Monitor for distress' };
  return { band: 'DISTRESS', desc: 'Elevated bankruptcy risk' };
}

function piotroskiF(curr, prev) {
  if (!curr) return null;
  let score = 0;
  let used = 0;
  const inc = () => { score++; };

  // Profitability
  if (curr.netIncome != null)            { used++; if (curr.netIncome > 0) inc(); }
  if (curr.netIncome != null && curr.totalAssets) {
    used++;
    if ((curr.netIncome / curr.totalAssets) > 0) inc();
  }
  if (curr.cfo != null)                  { used++; if (curr.cfo > 0) inc(); }
  if (curr.cfo != null && curr.netIncome != null) {
    used++; if (curr.cfo > curr.netIncome) inc();
  }

  // Leverage / liquidity / funding
  if (prev && curr.longTermDebt != null && prev.longTermDebt != null
      && curr.totalAssets && prev.totalAssets) {
    used++;
    const r0 = prev.longTermDebt / prev.totalAssets;
    const r1 = curr.longTermDebt / curr.totalAssets;
    if (r1 <= r0) inc();
  }
  if (prev && curr.currentAssets != null && curr.currentLiabilities
      && prev.currentAssets != null && prev.currentLiabilities) {
    used++;
    const c0 = prev.currentAssets / prev.currentLiabilities;
    const c1 = curr.currentAssets / curr.currentLiabilities;
    if (c1 >= c0) inc();
  }
  // Shares: not available in financials-reported reliably — skip (was: "no new shares").

  // Operating efficiency
  if (prev && curr.grossProfit != null && curr.revenue
      && prev.grossProfit != null && prev.revenue) {
    used++;
    const g0 = prev.grossProfit / prev.revenue;
    const g1 = curr.grossProfit / curr.revenue;
    if (g1 >= g0) inc();
  }
  if (prev && curr.revenue && curr.totalAssets
      && prev.revenue && prev.totalAssets) {
    used++;
    const a0 = prev.revenue / prev.totalAssets;
    const a1 = curr.revenue / curr.totalAssets;
    if (a1 >= a0) inc();
  }

  if (used < 4) return null;
  // Normalize to /9 even if we didn't have all signals
  return { raw: score, used, scaled: Math.round((score / used) * 9) };
}

function piotroskiInterpretation(f) {
  if (!f) return { band: 'N/A', desc: 'Insufficient data' };
  const s = f.scaled;
  if (s >= 7) return { band: 'STRONG', desc: 'Improving fundamentals' };
  if (s >= 4) return { band: 'NEUTRAL', desc: 'Mixed signals' };
  return { band: 'WEAK', desc: 'Deteriorating fundamentals' };
}

function beneishM(curr, prev) {
  // Beneish needs prior-year data and several ratios. If any divisor is
  // missing/zero, fall back to neutral (1.0) for that index so the score
  // still computes, but flag if too many components missing.
  if (!curr || !prev) return null;
  const safeDiv = (a, b, fallback = null) => {
    if (a == null || b == null || b === 0) return fallback;
    return a / b;
  };
  const safeRatio = (n0, d0, n1, d1) => {
    if (n0 == null || d0 == null || n1 == null || d1 == null || d0 === 0 || d1 === 0) return null;
    const a = n0 / d0;
    const b = n1 / d1;
    if (b === 0) return null;
    return a / b;
  };

  let missing = 0;

  // DSRI = (Receivables_t / Revenue_t) / (Receivables_t-1 / Revenue_t-1)
  let DSRI = safeRatio(curr.receivables, curr.revenue, prev.receivables, prev.revenue);
  if (DSRI == null) { DSRI = 1; missing++; }

  // GMI = GM_t-1 / GM_t  (gross margin)
  const gm0 = (prev.grossProfit != null && prev.revenue) ? prev.grossProfit / prev.revenue : null;
  const gm1 = (curr.grossProfit != null && curr.revenue) ? curr.grossProfit / curr.revenue : null;
  let GMI = (gm0 != null && gm1 != null && gm1 !== 0) ? gm0 / gm1 : null;
  if (GMI == null) { GMI = 1; missing++; }

  // AQI = (1 - (CA+PPE)/TA)_t / same_t-1
  const aq0 = (prev.totalAssets && prev.currentAssets != null && prev.ppe != null)
    ? 1 - (prev.currentAssets + prev.ppe) / prev.totalAssets : null;
  const aq1 = (curr.totalAssets && curr.currentAssets != null && curr.ppe != null)
    ? 1 - (curr.currentAssets + curr.ppe) / curr.totalAssets : null;
  let AQI = (aq0 != null && aq1 != null && aq0 !== 0) ? aq1 / aq0 : null;
  if (AQI == null) { AQI = 1; missing++; }

  // SGI = Revenue_t / Revenue_t-1
  let SGI = safeDiv(curr.revenue, prev.revenue, null);
  if (SGI == null) { SGI = 1; missing++; }

  // DEPI = (Dep_t-1 / (Dep_t-1 + PPE_t-1)) / (Dep_t / (Dep_t + PPE_t))
  const dep0 = (prev.depreciation != null && prev.ppe != null && (prev.depreciation + prev.ppe) > 0)
    ? prev.depreciation / (prev.depreciation + prev.ppe) : null;
  const dep1 = (curr.depreciation != null && curr.ppe != null && (curr.depreciation + curr.ppe) > 0)
    ? curr.depreciation / (curr.depreciation + curr.ppe) : null;
  let DEPI = (dep0 != null && dep1 != null && dep1 !== 0) ? dep0 / dep1 : null;
  if (DEPI == null) { DEPI = 1; missing++; }

  // SGAI = (SGA_t / Rev_t) / (SGA_t-1 / Rev_t-1)
  let SGAI = safeRatio(curr.sga, curr.revenue, prev.sga, prev.revenue);
  if (SGAI == null) { SGAI = 1; missing++; }

  // TATA = (NI - CFO) / TA   (total accruals to total assets, current year)
  let TATA = (curr.netIncome != null && curr.cfo != null && curr.totalAssets)
    ? (curr.netIncome - curr.cfo) / curr.totalAssets : null;
  if (TATA == null) { TATA = 0; missing++; }

  // LVGI = (TL_t/TA_t) / (TL_t-1/TA_t-1)
  let LVGI = safeRatio(curr.totalLiabilities, curr.totalAssets, prev.totalLiabilities, prev.totalAssets);
  if (LVGI == null) { LVGI = 1; missing++; }

  if (missing >= 5) return null;  // too many fallbacks → score is meaningless

  const m = -4.84
    + 0.92  * DSRI
    + 0.528 * GMI
    + 0.404 * AQI
    + 0.892 * SGI
    + 0.115 * DEPI
    - 0.172 * SGAI
    + 4.679 * TATA
    - 0.327 * LVGI;
  return { m, missing };
}

function beneishInterpretation(b) {
  if (!b) return { band: 'N/A', desc: 'Insufficient data' };
  if (b.m > -1.78) return { band: 'MANIPULATION RISK', desc: 'Earnings quality flag' };
  return { band: 'CLEAN', desc: 'No earnings-manipulation signal' };
}

// ── Multiples for ticker + peers ─────────────────────────────────
function extractMultiples(metric) {
  const m = (metric && metric.metric) || {};
  return {
    pe_fwd:     m.peExclExtraTTM || m.peTTM || m.peInclExtraTTM || null,
    pe_trail:   m.peBasicExclExtraTTM || m.peNormalizedAnnual || m.peTTM || null,
    ps:         m.psTTM || m.psAnnual || null,
    pb:         m.pbAnnual || m.pbQuarterly || null,
    ev_ebitda:  m['enterpriseValueOverEBITDATTM'] || m['currentEvOverEbitdaTTM'] || null,
    p_fcf:      m.pfcfShareTTM || m.priceToFreeCashFlowTTM || null
  };
}

function median(xs) {
  const arr = xs.filter(x => typeof x === 'number' && isFinite(x) && x > 0).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// ── DCF model ─────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function buildRevenueProjection(snapshots) {
  // snapshots are in DESCENDING year order (most recent first)
  const revs = snapshots.map(s => s.revenue).filter(v => typeof v === 'number' && v > 0);
  if (revs.length < 2) return null;
  // 3-year CAGR (revs[0] is most recent, revs[2] is 3 years back)
  const years = Math.min(3, revs.length - 1);
  const start = revs[years];
  const end = revs[0];
  const cagr = years > 0 && start > 0 ? Math.pow(end / start, 1 / years) - 1 : 0;
  return { startRevenue: end, cagr, years };
}

function projectRevenues(startRev, baseGrowth) {
  // Fade base growth linearly toward TERMINAL_FADE_GROWTH (5%) by year 5.
  // Cap each year's growth at MAX_REVENUE_GROWTH (30%) to avoid hyperbolic
  // projections off a single great year.
  const out = [];
  let r = startRev;
  const g0 = clamp(baseGrowth, -0.1, MAX_REVENUE_GROWTH);
  for (let y = 1; y <= 5; y++) {
    const t = (y - 1) / 4;  // 0 at y=1, 1 at y=5
    const g = g0 * (1 - t) + TERMINAL_FADE_GROWTH * t;
    r = r * (1 + g);
    out.push({ year: y, revenue: r, growth: g });
  }
  return out;
}

function avgFcfMargin(snapshots) {
  const ratios = [];
  for (const s of snapshots) {
    if (s.fcf != null && s.revenue && s.revenue > 0) {
      ratios.push(s.fcf / s.revenue);
    }
    if (ratios.length >= 3) break;
  }
  if (ratios.length === 0) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function computeWacc(beta, marketCap, totalDebt, interestExpense, taxRate) {
  const ke = RISK_FREE_RATE + (beta || DEFAULT_BETA) * EQUITY_RISK_PREMIUM;
  const tax = (taxRate != null && taxRate >= 0 && taxRate < 1) ? taxRate : DEFAULT_TAX_RATE;
  const kdPretax = (totalDebt && totalDebt > 0 && interestExpense)
    ? Math.min(0.15, Math.abs(interestExpense) / totalDebt)
    : DEFAULT_COST_OF_DEBT;
  const kd = kdPretax * (1 - tax);
  const equity = marketCap || 0;
  const debt = totalDebt || 0;
  const v = equity + debt;
  if (v <= 0) return { wacc: ke, ke, kd, kdPretax, tax, weights: { e: 1, d: 0 } };
  const we = equity / v;
  const wd = debt / v;
  const wacc = we * ke + wd * kd;
  return { wacc, ke, kd, kdPretax, tax, weights: { e: we, d: wd } };
}

function valueFcfStream(fcfs, wacc, terminalGrowth) {
  if (wacc <= terminalGrowth) return null;
  let pv = 0;
  for (let i = 0; i < fcfs.length; i++) {
    const t = i + 1;
    pv += fcfs[i] / Math.pow(1 + wacc, t);
  }
  const lastFcf = fcfs[fcfs.length - 1];
  const tv = lastFcf * (1 + terminalGrowth) / (wacc - terminalGrowth);
  const pvTv = tv / Math.pow(1 + wacc, fcfs.length);
  return { pvFcf: pv, pvTv, ev: pv + pvTv, tv };
}

function buildDcf({ snapshots, marketCap, sharesOut, totalDebt, cash, beta,
                    interestExpense, taxRate, currentPrice }) {
  const proj = buildRevenueProjection(snapshots);
  if (!proj) return { skipped: true, reason: 'Insufficient revenue history' };
  const fcfMargin = avgFcfMargin(snapshots);
  if (fcfMargin == null || fcfMargin <= 0) {
    return {
      skipped: true,
      reason: fcfMargin == null ? 'No FCF history available' : 'Negative average FCF margin — DCF not meaningful for current cash burn profile'
    };
  }
  if (!sharesOut || sharesOut <= 0) return { skipped: true, reason: 'Shares outstanding unavailable' };

  const revProjection = projectRevenues(proj.startRevenue, proj.cagr);
  const fcfs = revProjection.map(r => r.revenue * fcfMargin);

  const w = computeWacc(beta, marketCap, totalDebt, interestExpense, taxRate);

  const base = valueFcfStream(fcfs, w.wacc, TERMINAL_GROWTH);
  if (!base) return { skipped: true, reason: 'WACC ≤ terminal growth — model degenerates' };
  const netDebt = (totalDebt || 0) - (cash || 0);
  const equityValue = base.ev - netDebt;
  const fairValuePerShare = equityValue / sharesOut;
  const upside = currentPrice ? (fairValuePerShare - currentPrice) / currentPrice : null;

  // 3x3 sensitivity grid
  const wDeltas = [-0.01, 0, 0.01];
  const gDeltas = [-0.005, 0, 0.005];
  const sensitivity = [];
  for (const dw of wDeltas) {
    const row = [];
    for (const dg of gDeltas) {
      const ww = w.wacc + dw;
      const gg = TERMINAL_GROWTH + dg;
      const v = valueFcfStream(fcfs, ww, gg);
      if (!v) { row.push(null); continue; }
      const fv = (v.ev - netDebt) / sharesOut;
      row.push({ wacc: ww, g: gg, fairValue: fv,
                 upside: currentPrice ? (fv - currentPrice) / currentPrice : null });
    }
    sensitivity.push(row);
  }

  return {
    skipped: false,
    assumptions: {
      startRevenue: proj.startRevenue,
      revenueCagr: proj.cagr,
      revenueCagrYears: proj.years,
      fcfMargin,
      wacc: w.wacc,
      costOfEquity: w.ke,
      costOfDebtAfterTax: w.kd,
      costOfDebtPretax: w.kdPretax,
      taxRate: w.tax,
      weightEquity: w.weights.e,
      weightDebt: w.weights.d,
      terminalGrowth: TERMINAL_GROWTH,
      beta: beta || DEFAULT_BETA
    },
    projections: revProjection.map((r, i) => ({ ...r, fcf: fcfs[i] })),
    ev: base.ev,
    pvFcf: base.pvFcf,
    pvTv: base.pvTv,
    terminalValue: base.tv,
    netDebt,
    equityValue,
    sharesOut,
    fairValuePerShare,
    currentPrice,
    upside,
    sensitivity,
    sensitivityAxes: { wacc: wDeltas.map(d => w.wacc + d), g: gDeltas.map(d => TERMINAL_GROWTH + d) }
  };
}

function valuationSignal(upside) {
  if (upside == null) return { band: 'N/A', color: 'grey' };
  if (upside > 0.15)  return { band: 'DISCOUNT', color: 'green' };
  if (upside < -0.15) return { band: 'PREMIUM',  color: 'red' };
  return { band: 'FAIR', color: 'amber' };
}

// ── Claude narrative ─────────────────────────────────────────────
function buildClaudePayload(data) {
  const ticker = data.ticker;
  const company = data.companyName || ticker;
  // Build a compact JSON brief for Claude — calculated numbers, no raw filings
  return {
    ticker, company,
    sector: data.sector,
    industry: data.industry,
    peers: data.peers,
    currentPrice: data.currentPrice,
    multiples: data.multiples,
    sectorMedians: data.sectorMedians,
    scores: data.scores,
    dcf: data.dcf,
    signal: data.signal
  };
}

async function runClaude(apiKey, brief) {
  const system = `You are a senior fundamental research analyst at a top-tier hedge fund. You will be given a structured JSON brief containing pre-computed valuation multiples, financial health scores (Altman Z, Piotroski F, Beneish M), and a 5-year DCF model. Produce a concise, institutional-grade narrative.

Return ONLY a JSON object, no preamble:

{
  "valuation_summary": "<2-3 sentence bottom line on fair value vs current price; reference the signal>",
  "peer_takeaway":     "<2 sentences on how multiples compare to peers and sector median; flag any specific multiple that is unusually rich/cheap>",
  "health_observation":"<2 sentences interpreting Altman Z, Piotroski F, Beneish M together — not in isolation>",
  "dcf_note":          "<1-2 sentences on the most sensitive DCF assumption (typically WACC or terminal growth) and where the model is most fragile; if DCF was skipped, explain in 1 sentence WHY>",
  "institutional_insight": "<3-4 sentences of NON-OBVIOUS contrarian read. What would a buy-side analyst notice that retail misses? Reference specific multiples/scores. For foreign issuers, weight FX, home-country macro, regulatory regime appropriately.>"
}

Be quantitative. Be specific. Use the actual numbers in the brief. No fluff.`;

  const user = `Analyze this fundamentals brief and return the JSON narrative.\n\n` +
    `\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await r.json();
  if (!r.ok) {
    return { error: 'Claude API call failed', detail: data && data.error ? data.error : data };
  }
  const raw = (data.content || []).map(b => (b && b.text) || '').join('').trim();
  // JSON extraction
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

// ── Main handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return res.status(500).json({ error: 'FINNHUB_API_KEY not set', ticker });
  }

  try {
    // ── 1. Parallel Finnhub pulls ──
    const [profileRes, metricRes, finRes, peersRes, quoteRes] = await Promise.all([
      safeFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/financials-reported?symbol=${ticker}&freq=annual&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/peers?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`)
    ]);
    const [profile, metric, fin, peersRaw, quote] = await Promise.all([
      safeJson(profileRes), safeJson(metricRes), safeJson(finRes),
      safeJson(peersRes), safeJson(quoteRes)
    ]);

    if (!profile && !metric) {
      return res.status(200).json({
        ticker,
        error: 'No Finnhub data for this ticker. Coverage limited to US-listed names.'
      });
    }

    const companyName = (profile && profile.name) || ticker;
    const sector = (profile && (profile.finnhubIndustry || profile.gicsSector)) || null;
    const industry = (profile && profile.finnhubIndustry) || null;
    const currentPrice = (quote && typeof quote.c === 'number' && quote.c > 0) ? quote.c : null;

    // marketCapitalization is in millions on Finnhub profile2
    const marketCap = (profile && profile.marketCapitalization)
      ? profile.marketCapitalization * 1e6
      : null;
    const sharesOut = (profile && profile.shareOutstanding)
      ? profile.shareOutstanding * 1e6
      : null;
    const beta = (metric && metric.metric && metric.metric.beta) || null;

    // ── 2. Annual snapshots (5y) ──
    const snapshots = (fin && Array.isArray(fin.data) ? fin.data : [])
      .filter(r => r && r.report)
      .slice(0, 5)
      .map(extractSnapshot);

    const latest = snapshots[0] || null;
    const prior  = snapshots[1] || null;

    // ── 3. Peer resolution (Finnhub first, manual map as fallback) ──
    // Finnhub /stock/peers is sparse / empty for many LATAM ADRs. If it
    // returns fewer than 2 usable peers, fall back to the curated map.
    let peerTickers = Array.isArray(peersRaw)
      ? peersRaw.filter(p => typeof p === 'string' && p.toUpperCase() !== ticker).slice(0, 4)
      : [];
    let peerSource = 'finnhub';
    if (peerTickers.length < 2 && MANUAL_PEER_FALLBACK[ticker]) {
      console.log(`[fundamental-agent] ${ticker}: using manual peer fallback (finnhub returned ${peerTickers.length})`);
      peerTickers = MANUAL_PEER_FALLBACK[ticker]
        .filter(p => p.toUpperCase() !== ticker)
        .slice(0, 4);
      peerSource = 'manual';
    }
    const peerMetricRes = await Promise.all(peerTickers.map(p =>
      safeFetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(p)}&metric=all&token=${finnhubKey}`)
    ));
    const peerMetrics = await Promise.all(peerMetricRes.map(safeJson));
    const peers = peerTickers.map((sym, i) => ({
      ticker: sym,
      multiples: extractMultiples(peerMetrics[i])
    }));

    const selfMultiples = extractMultiples(metric);
    const allForMedian = [selfMultiples, ...peers.map(p => p.multiples)];
    const sectorMedians = {
      pe_fwd:    median(allForMedian.map(x => x.pe_fwd)),
      pe_trail:  median(allForMedian.map(x => x.pe_trail)),
      ps:        median(allForMedian.map(x => x.ps)),
      pb:        median(allForMedian.map(x => x.pb)),
      ev_ebitda: median(allForMedian.map(x => x.ev_ebitda)),
      p_fcf:     median(allForMedian.map(x => x.p_fcf))
    };

    // ── 4. Financial health scores ──
    const z   = altmanZ(latest || {}, marketCap);
    const f   = piotroskiF(latest, prior);
    const b   = beneishM(latest, prior);
    const scores = {
      altmanZ:   { value: z, ...altmanInterpretation(z) },
      piotroski: { value: f ? f.scaled : null, raw: f ? f.raw : null, used: f ? f.used : null, ...piotroskiInterpretation(f) },
      beneishM:  { value: b ? b.m : null, missing: b ? b.missing : null, ...beneishInterpretation(b) }
    };

    // ── 5. DCF ──
    const taxRate = (latest && latest.incomeTax && latest.netIncome && (latest.incomeTax + latest.netIncome) > 0)
      ? latest.incomeTax / (latest.incomeTax + latest.netIncome) : null;
    const totalDebt = latest ? latest.totalDebt : null;
    const cash     = latest ? latest.cash : null;
    const interestExpense = latest ? latest.interestExpense : null;

    const dcf = buildDcf({
      snapshots, marketCap, sharesOut, totalDebt, cash, beta,
      interestExpense, taxRate, currentPrice
    });

    const signal = dcf.skipped ? { band: 'N/A', color: 'grey', reason: dcf.reason }
                                : valuationSignal(dcf.upside);

    // ── 6. Compose Claude narrative ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let narrative = null;
    if (apiKey) {
      const brief = buildClaudePayload({
        ticker, companyName, sector, industry,
        peers: peers.map(p => ({ ticker: p.ticker, multiples: p.multiples })),
        currentPrice,
        multiples: selfMultiples,
        sectorMedians,
        scores,
        dcf,
        signal
      });
      const out = await runClaude(apiKey, brief);
      if (out.ok) narrative = out.ok;
      else console.log(`[fundamental-agent] ${ticker}: claude error`, out.error, out.raw_preview || out.detail);
    }

    // 24h CDN cache — fundamentals don't move intraday
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json({
      ticker,
      companyName,
      sector,
      industry,
      currentPrice,
      marketCap,
      sharesOut,
      beta,
      peers: peers.map(p => p.ticker),
      multiples: { self: selfMultiples, peers, sectorMedians },
      scores,
      dcf,
      signal,
      narrative,
      source: 'Finnhub + Custom DCF + Claude',
      stats: {
        snapshots_used: snapshots.length,
        peer_count: peers.length,
        peer_source: peerSource
      }
    });
  } catch (err) {
    console.log(`[fundamental-agent] exception for ${ticker}:`, err && err.message);
    return res.status(500).json({
      ticker,
      error: 'Fundamental Agent failure: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
