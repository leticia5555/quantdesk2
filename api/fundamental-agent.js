// ═══════════════════════════════════════════════════════════════════
// Fundamental Agent (Sprint 2 + 2.5 calibration)
//
//   GET /api/fundamental-agent?ticker=NVDA
//
// Pipeline:
//   1. Pull Finnhub: profile2, metric/all, financials-reported (annual,
//      5y), peers, quote, price-target. Parallel, graceful nulls.
//   2. Compute multiples for the ticker + up to 4 peers and a sector
//      median. Manual peer fallback for sparse LATAM ADRs.
//   3. Compute Altman Z, Piotroski F, Beneish M from 5y annual
//      statements (GAAP + IFRS via flexible substring matching).
//   4. Build a CALIBRATED 5-year DCF:
//      · Stage-based revenue fade with sector growth caps
//      · Trimmed-mean FCF margin with sector caps + 2% floor
//      · Bounded WACC (7.5–14%) with LATAM-ADR EM premium
//      · Sector-aware terminal growth (2.0–3.0%)
//      · Bull/base/bear scenarios + 3x3 sensitivity grid
//   5. Wall Street consensus comparison from /stock/price-target.
//   6. Margin-of-safety category + confidence score from data quality.
//   7. Claude composes nuanced narrative (consensus + scenario aware).
//
// Calibration target: outputs should be DEFENSIBLE to a sell-side
// analyst — typically within 30–50% of consensus. Wild outputs signal
// mis-calibration, not insight.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// ── Bilingual support ─────────────────────────────────────────────
function langDirective(lang) {
  return lang === 'es'
    ? '\n\nIMPORTANTE: Responde completamente en español (español latinoamericano neutral). Todos los campos en lenguaje natural deben estar en español. Mantén los tickers, números, símbolos griegos (β, σ, ρ) y siglas (EPS, FX, ADR, BUY/HOLD/PASS, BEAT/MISS) en su forma original. Los nombres de empresas se mantienen en su idioma original. Las categorías cuantitativas (LOW/MODERATE/ELEVATED/EXTREME, INTACT/BREAKDOWN, etc.) se mantienen en inglés porque son códigos de estado del sistema; el resto del texto narrativo debe ser español.'
    : '';
}

// Risk-free / equity-risk-premium base. All cash flows are USD-denominated
// (US-listed names + ADRs), so we use the US 10Y as the risk-free anchor.
const RISK_FREE_RATE = 0.045;
const EQUITY_RISK_PREMIUM_US = 0.055;
// Country/region ERP add-ons applied to LATAM ADRs and foreign developed.
const ERP_LATAM_ADJ = 0.015;
const ERP_FOREIGN_DEV_ADJ = 0.005;

// WACC guard rails — extreme WACCs blow up DCFs in both directions.
const WACC_FLOOR = 0.075;
const WACC_CAP = 0.140;

// Tax-rate bounds
const TAX_FLOOR = 0.15;
const TAX_CAP = 0.35;

// Beta bounds (Finnhub regression betas occasionally come back at 2.5+ or 0.4)
const BETA_FLOOR = 0.7;
const BETA_CAP = 2.0;
const DEFAULT_BETA = 1.0;
const DEFAULT_COST_OF_DEBT = 0.05;

// FCF margin: minimum positive floor (2%) when the firm is fundamentally profitable.
const FCF_MARGIN_FLOOR = 0.02;

// ── Country / region classification ──────────────────────────────
// Finnhub profile.country returns ISO-2. LATAM-ADR ERP add-on applies
// to common-stock ADRs originating in MX/BR/AR/CL/CO/PE. Anything else
// non-US gets the foreign-developed adjustment.
const LATAM_COUNTRIES = new Set(['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'EC', 'BO', 'PY', 'VE']);
function classifyRegion(country) {
  const c = (country || '').toUpperCase();
  if (!c || c === 'US') return { code: 'US', erpAdj: 0, label: 'US' };
  if (LATAM_COUNTRIES.has(c)) return { code: 'LATAM_ADR', erpAdj: ERP_LATAM_ADJ, label: `LATAM ADR (${c})` };
  return { code: 'FOREIGN_DEV', erpAdj: ERP_FOREIGN_DEV_ADJ, label: `Foreign developed (${c})` };
}

// ── Sector classifier ────────────────────────────────────────────
// Maps Finnhub's `finnhubIndustry` strings into stable keys we use for
// growth/margin/terminal caps. Match is case-insensitive substring; first
// hit wins, then 'default'.
const SECTOR_RULES = [
  ['tech',         ['semiconductor', 'software', 'technology', 'internet software', 'cloud', 'computer']],
  ['ecommerce',    ['internet retail', 'e-commerce', 'specialty retail', 'consumer cyclical']],
  ['comms',        ['communication services', 'media', 'telecom', 'entertainment']],
  ['healthcare',   ['health', 'pharma', 'biotech', 'medical', 'life sciences']],
  ['financial',    ['bank', 'financial services', 'insurance', 'asset management', 'capital markets', 'fintech', 'credit services']],
  ['consumer_def', ['beverage', 'food', 'consumer defensive', 'consumer staples', 'household', 'tobacco']],
  ['industrials',  ['industrial', 'aerospace', 'machinery', 'transport', 'airline', 'rail']],
  ['mining',       ['mining', 'materials', 'metals', 'steel', 'chemicals']],
  ['energy',       ['energy', 'oil', 'gas', 'petroleum']],
  ['realestate',   ['real estate', 'reit']],
  ['utilities',    ['utilities', 'utility', 'water', 'electric']]
];
function classifySector(finnhubIndustry) {
  const s = (finnhubIndustry || '').toLowerCase();
  if (!s) return 'default';
  for (const [key, patterns] of SECTOR_RULES) {
    if (patterns.some(p => s.includes(p))) return key;
  }
  return 'default';
}

// Sector growth caps (year-1 ceiling on revenue growth)
const SECTOR_GROWTH_CAP = {
  tech: 0.40, ecommerce: 0.35, comms: 0.25, healthcare: 0.30,
  financial: 0.20, consumer_def: 0.12, industrials: 0.18, mining: 0.18,
  energy: 0.15, realestate: 0.08, utilities: 0.08, default: 0.25
};

// Sector FCF-margin ceilings (avoid extrapolating one stellar year)
const SECTOR_FCF_CAP = {
  tech: 0.35, ecommerce: 0.18, comms: 0.25, healthcare: 0.22,
  financial: null,  // banks: FCF margin is not a useful concept — handled separately
  consumer_def: 0.12, industrials: 0.22, mining: 0.22,
  energy: 0.18, realestate: 0.25, utilities: 0.20, default: 0.20
};

// Sector terminal growth rates
const SECTOR_TERMINAL_G = {
  tech: 0.030, ecommerce: 0.025, comms: 0.025, healthcare: 0.030,
  financial: 0.025, consumer_def: 0.025, industrials: 0.025, mining: 0.025,
  energy: 0.025, realestate: 0.020, utilities: 0.020, default: 0.025
};

// ── Manual peer fallback (LATAM ADRs Finnhub /stock/peers misses) ─
const MANUAL_PEER_FALLBACK = {
  MELI: ['AMZN', 'BABA', 'PDD', 'EBAY'],
  NU:   ['SOFI', 'AFRM', 'V', 'MA'],
  STNE: ['SQ', 'PYPL', 'AFRM', 'SOFI'],
  PAGS: ['SQ', 'PYPL', 'STNE', 'SOFI'],
  VALE: ['RIO', 'BHP', 'FCX', 'NEM'],
  SQM:  ['ALB', 'LAC', 'PLL', 'MP'],
  ITUB: ['BBD', 'BSBR', 'BAP', 'BCH'],
  BBD:  ['ITUB', 'BSBR', 'BAP', 'BCH'],
  BBAR: ['GGAL', 'SUPV', 'BAP', 'BMA'],
  GGAL: ['BBAR', 'SUPV', 'BMA', 'BAP'],
  BSAC: ['BCH', 'BAP', 'BBD', 'ITUB'],
  PBR:  ['XOM', 'CVX', 'BP', 'TTE'],
  EC:   ['XOM', 'CVX', 'BP', 'PBR'],
  FMX:  ['KOF', 'ABEV', 'BUD', 'CCEP'],
  KOF:  ['FMX', 'ABEV', 'BUD', 'CCEP'],
  ABEV: ['BUD', 'CCEP', 'KOF', 'FMX'],
  AMX:  ['VOD', 'T', 'VZ', 'TMUS'],
  TV:   ['DIS', 'PARA', 'WBD', 'CMCSA'],
  ASR:  ['PAC', 'OMAB', 'CAAP', 'GOL'],
  PAC:  ['ASR', 'OMAB', 'CAAP', 'GOL'],
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

function extractSnapshot(report) {
  const r = report && report.report ? report.report : {};
  const ic = Array.isArray(r.ic) ? r.ic : [];
  const bs = Array.isArray(r.bs) ? r.bs : [];
  const cf = Array.isArray(r.cf) ? r.cf : [];

  const revenue = findConcept(ic, [
    'us-gaap_revenuefromcontractwithcustomerexcludingassessedtax',
    'us-gaap_revenues', 'us-gaap_salesrevenuenet',
    'ifrs-full_revenue', 'revenuefromcontractswithcustomers',
    'totalrevenue', 'revenue', 'sales'
  ]);
  const grossProfit = findConcept(ic, ['grossprofit', 'gross profit']);
  const cogs = findConcept(ic, [
    'costofrevenue', 'costofgoodsandservicessold', 'costofsales',
    'cost of revenue', 'cost of sales'
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

  const directFcf = findConcept(cf, [
    'us-gaap_freecashflow', 'freecashflow', 'free_cash_flow', 'free cash flow'
  ]);
  const cfo = findConcept(cf, [
    'us-gaap_netcashprovidedbyusedinoperatingactivities',
    'netcashprovidedbyusedinoperatingactivities',
    'netcashprovidedbyoperatingactivities',
    'cashflowfromoperations',
    'ifrs-full_cashflowsfromusedinoperatingactivities',
    'cashflowsfromusedinoperatingactivities',
    'cashflowsfromoperatingactivities',
    'netcashfromoperatingactivities',
    'operatingactivities',
    'cash from operating', 'cash flow from operating',
    'net cash provided by operating'
  ]);
  const capex = findConcept(cf, [
    'us-gaap_paymentstoacquirepropertyplantandequipment',
    'paymentstoacquirepropertyplantandequipment',
    'paymentsforpropertyplantandequipment',
    'paymentstoacquireproductiveassets',
    'ifrs-full_purchaseofpropertyplantandequipmentclassifiedasinvestingactivities',
    'ifrs-full_purchaseofpropertyplantandequipment',
    'purchaseofpropertyplantandequipment',
    'purchasesofpropertyandequipment',
    'purchaseofpropertyandequipment',
    'capitalexpenditures', 'capital expenditure', 'purchases of property'
  ]);

  let totalDebt = findConcept(bs, ['longtermdebt', 'totaldebt']);
  if (totalDebt == null) totalDebt = longTermDebt;

  let fcf = null, fcfSource = null;
  if (typeof directFcf === 'number' && isFinite(directFcf)) {
    fcf = directFcf; fcfSource = 'direct';
  } else if (typeof cfo === 'number' && typeof capex === 'number') {
    fcf = cfo - Math.abs(capex); fcfSource = 'cfo-capex';
  } else if (typeof cfo === 'number') {
    fcf = cfo; fcfSource = 'cfo-only';
  }

  return {
    year: report.year || null,
    endDate: report.endDate || null,
    revenue, grossProfit, cogs, sga,
    operatingIncome, interestExpense, incomeTax, netIncome, depreciation,
    totalAssets, currentAssets, totalLiabilities, currentLiabilities,
    retainedEarnings, stockholdersEquity, longTermDebt, totalDebt,
    cash, inventory, receivables, ppe,
    cfo, capex, fcf, fcfSource
  };
}

// ═══════ Financial health scores (unchanged from Sprint 2) ═══════
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
  let score = 0, used = 0;
  const inc = () => { score++; };
  if (curr.netIncome != null) { used++; if (curr.netIncome > 0) inc(); }
  if (curr.netIncome != null && curr.totalAssets) { used++; if ((curr.netIncome / curr.totalAssets) > 0) inc(); }
  if (curr.cfo != null) { used++; if (curr.cfo > 0) inc(); }
  if (curr.cfo != null && curr.netIncome != null) { used++; if (curr.cfo > curr.netIncome) inc(); }
  if (prev && curr.longTermDebt != null && prev.longTermDebt != null && curr.totalAssets && prev.totalAssets) {
    used++;
    if ((curr.longTermDebt / curr.totalAssets) <= (prev.longTermDebt / prev.totalAssets)) inc();
  }
  if (prev && curr.currentAssets != null && curr.currentLiabilities && prev.currentAssets != null && prev.currentLiabilities) {
    used++;
    if ((curr.currentAssets / curr.currentLiabilities) >= (prev.currentAssets / prev.currentLiabilities)) inc();
  }
  if (prev && curr.grossProfit != null && curr.revenue && prev.grossProfit != null && prev.revenue) {
    used++;
    if ((curr.grossProfit / curr.revenue) >= (prev.grossProfit / prev.revenue)) inc();
  }
  if (prev && curr.revenue && curr.totalAssets && prev.revenue && prev.totalAssets) {
    used++;
    if ((curr.revenue / curr.totalAssets) >= (prev.revenue / prev.totalAssets)) inc();
  }
  if (used < 4) return null;
  return { raw: score, used, scaled: Math.round((score / used) * 9) };
}
function piotroskiInterpretation(f) {
  if (!f) return { band: 'N/A', desc: 'Insufficient data' };
  if (f.scaled >= 7) return { band: 'STRONG', desc: 'Improving fundamentals' };
  if (f.scaled >= 4) return { band: 'NEUTRAL', desc: 'Mixed signals' };
  return { band: 'WEAK', desc: 'Deteriorating fundamentals' };
}
function beneishM(curr, prev) {
  if (!curr || !prev) return null;
  const safeDiv = (a, b, fb = null) => (a == null || b == null || b === 0) ? fb : a / b;
  const safeRatio = (n0, d0, n1, d1) => {
    if (n0 == null || d0 == null || n1 == null || d1 == null || d0 === 0 || d1 === 0) return null;
    const b = n1 / d1; return b === 0 ? null : (n0 / d0) / b;
  };
  let missing = 0;
  let DSRI = safeRatio(curr.receivables, curr.revenue, prev.receivables, prev.revenue); if (DSRI == null) { DSRI = 1; missing++; }
  const gm0 = (prev.grossProfit != null && prev.revenue) ? prev.grossProfit / prev.revenue : null;
  const gm1 = (curr.grossProfit != null && curr.revenue) ? curr.grossProfit / curr.revenue : null;
  let GMI = (gm0 != null && gm1 != null && gm1 !== 0) ? gm0 / gm1 : null; if (GMI == null) { GMI = 1; missing++; }
  const aq0 = (prev.totalAssets && prev.currentAssets != null && prev.ppe != null) ? 1 - (prev.currentAssets + prev.ppe) / prev.totalAssets : null;
  const aq1 = (curr.totalAssets && curr.currentAssets != null && curr.ppe != null) ? 1 - (curr.currentAssets + curr.ppe) / curr.totalAssets : null;
  let AQI = (aq0 != null && aq1 != null && aq0 !== 0) ? aq1 / aq0 : null; if (AQI == null) { AQI = 1; missing++; }
  let SGI = safeDiv(curr.revenue, prev.revenue, null); if (SGI == null) { SGI = 1; missing++; }
  const dep0 = (prev.depreciation != null && prev.ppe != null && (prev.depreciation + prev.ppe) > 0) ? prev.depreciation / (prev.depreciation + prev.ppe) : null;
  const dep1 = (curr.depreciation != null && curr.ppe != null && (curr.depreciation + curr.ppe) > 0) ? curr.depreciation / (curr.depreciation + curr.ppe) : null;
  let DEPI = (dep0 != null && dep1 != null && dep1 !== 0) ? dep0 / dep1 : null; if (DEPI == null) { DEPI = 1; missing++; }
  let SGAI = safeRatio(curr.sga, curr.revenue, prev.sga, prev.revenue); if (SGAI == null) { SGAI = 1; missing++; }
  let TATA = (curr.netIncome != null && curr.cfo != null && curr.totalAssets) ? (curr.netIncome - curr.cfo) / curr.totalAssets : null; if (TATA == null) { TATA = 0; missing++; }
  let LVGI = safeRatio(curr.totalLiabilities, curr.totalAssets, prev.totalLiabilities, prev.totalAssets); if (LVGI == null) { LVGI = 1; missing++; }
  if (missing >= 5) return null;
  const m = -4.84 + 0.92*DSRI + 0.528*GMI + 0.404*AQI + 0.892*SGI + 0.115*DEPI - 0.172*SGAI + 4.679*TATA - 0.327*LVGI;
  return { m, missing };
}
function beneishInterpretation(b) {
  if (!b) return { band: 'N/A', desc: 'Insufficient data' };
  if (b.m > -1.78) return { band: 'MANIPULATION RISK', desc: 'Earnings quality flag' };
  return { band: 'CLEAN', desc: 'No earnings-manipulation signal' };
}

// ═══════ Multiples (unchanged) ═══════
function extractMultiples(metric) {
  const m = (metric && metric.metric) || {};
  return {
    pe_fwd:    m.peExclExtraTTM || m.peTTM || m.peInclExtraTTM || null,
    pe_trail:  m.peBasicExclExtraTTM || m.peNormalizedAnnual || m.peTTM || null,
    ps:        m.psTTM || m.psAnnual || null,
    pb:        m.pbAnnual || m.pbQuarterly || null,
    ev_ebitda: m['enterpriseValueOverEBITDATTM'] || m['currentEvOverEbitdaTTM'] || null,
    p_fcf:     m.pfcfShareTTM || m.priceToFreeCashFlowTTM || null
  };
}
function median(xs) {
  const arr = xs.filter(x => typeof x === 'number' && isFinite(x) && x > 0).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// ═══════════════════════════════════════════════════════════════════
// CALIBRATED DCF
// ═══════════════════════════════════════════════════════════════════
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Revenue base growth: 3y CAGR capped at sector ceiling.
function baseRevenueGrowth(snapshots, sectorKey) {
  const revs = snapshots.map(s => s.revenue).filter(v => typeof v === 'number' && v > 0);
  if (revs.length < 2) return { skipped: true };
  const years = Math.min(3, revs.length - 1);
  const start = revs[years];
  const end = revs[0];
  const rawCagr = years > 0 && start > 0 ? Math.pow(end / start, 1 / years) - 1 : 0;
  const cap = SECTOR_GROWTH_CAP[sectorKey] || SECTOR_GROWTH_CAP.default;
  // Floor at -10% (one bad year shouldn't permanently sink the model).
  // If CAGR > cap, log so practitioners see the cap binding.
  const wasCapped = rawCagr > cap;
  const baseG = clamp(rawCagr, -0.10, cap);
  return { skipped: false, rawCagr, baseG, cap, wasCapped, years };
}

// Three-stage fade per spec:
// Y1 = base_g, Y2 = base_g*0.80, Y3 = base_g*0.55, Y4 = base_g*0.30,
// Y5 = max(base_g*0.15, 4%)
function stageFade(baseG) {
  const ratios = [1.00, 0.80, 0.55, 0.30, 0.15];
  const out = ratios.map(r => baseG * r);
  out[4] = Math.max(out[4], 0.04);  // year 5 floor
  return out;
}

function projectRevenuesStaged(startRev, growths) {
  let r = startRev;
  return growths.map((g, i) => {
    r = r * (1 + g);
    return { year: i + 1, revenue: r, growth: g };
  });
}

// Trimmed-mean FCF margin per spec, then sector-cap, then 2% floor.
function fcfMarginCalibrated(snapshots, sectorKey) {
  const ratios = [];
  for (const s of snapshots) {
    if (s.fcf != null && s.revenue && s.revenue > 0) {
      ratios.push(s.fcf / s.revenue);
    }
  }
  if (ratios.length === 0) return { margin: null, method: 'none', count: 0 };

  let margin, method;
  if (ratios.length >= 5) {
    // Drop highest + lowest, average the middle 3
    const sorted = ratios.slice().sort((a, b) => a - b);
    const mid = sorted.slice(1, -1);
    margin = mid.reduce((a, b) => a + b, 0) / mid.length;
    method = 'trimmed_mean';
  } else if (ratios.length >= 3) {
    const sorted = ratios.slice().sort((a, b) => a - b);
    margin = sorted[Math.floor(sorted.length / 2)];
    method = 'median';
  } else {
    margin = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    method = ratios.length === 1 ? 'single_year' : 'avg_2y';
  }

  // Negative margin → caller decides whether to skip DCF
  if (margin < 0) return { margin, method, count: ratios.length, capped: false };

  // Sector cap (banks have null cap — caller routes them differently)
  const cap = SECTOR_FCF_CAP[sectorKey];
  let capped = false;
  if (cap != null && margin > cap) {
    margin = cap;
    method = method + '_capped';
    capped = true;
  }
  // Floor
  if (margin < FCF_MARGIN_FLOOR) margin = FCF_MARGIN_FLOOR;
  return { margin, method, count: ratios.length, capped };
}

// Bounded, region-adjusted WACC. Returns a full decomposition for transparency.
function computeWaccCalibrated({ beta, marketCap, totalDebt, interestExpense, taxRate, region }) {
  // Beta bounds
  const rawBeta = (typeof beta === 'number' && isFinite(beta)) ? beta : DEFAULT_BETA;
  const adjBeta = clamp(rawBeta, BETA_FLOOR, BETA_CAP);

  // Tax rate bounds
  let tax;
  if (taxRate != null && isFinite(taxRate) && taxRate >= 0 && taxRate < 1) {
    tax = clamp(taxRate, TAX_FLOOR, TAX_CAP);
  } else {
    tax = 0.25;  // default
  }

  // Equity risk premium with country/region adjustment
  const erp = EQUITY_RISK_PREMIUM_US + (region && region.erpAdj ? region.erpAdj : 0);

  // Cost of equity
  const ke = RISK_FREE_RATE + adjBeta * erp;

  // Cost of debt
  let kdPretax;
  if (totalDebt && totalDebt > 0 && interestExpense) {
    const implied = Math.abs(interestExpense) / totalDebt;
    // Implied yields above 15% suggest data issue; cap at that
    kdPretax = Math.min(0.15, implied);
  } else {
    kdPretax = DEFAULT_COST_OF_DEBT;
  }
  const kd = kdPretax * (1 - tax);

  // Capital structure weights
  const equity = marketCap || 0;
  const debt = totalDebt || 0;
  const v = equity + debt;
  let we, wd, rawWacc;
  if (v <= 0) {
    we = 1; wd = 0; rawWacc = ke;
  } else {
    we = equity / v; wd = debt / v;
    rawWacc = we * ke + wd * kd;
  }

  // Bounded WACC
  let wacc = clamp(rawWacc, WACC_FLOOR, WACC_CAP);
  const bounded = wacc !== rawWacc;
  if (bounded) {
    console.log(`[fundamental-agent] WACC out of bounds: raw=${rawWacc.toFixed(4)} bounded=${wacc.toFixed(4)}`);
  }

  return {
    wacc, rawWacc, bounded, ke, kd, kdPretax, tax,
    beta: adjBeta, rawBeta, erp,
    weights: { e: we, d: wd },
    region: region ? region.code : 'US'
  };
}

// Sector terminal growth with WACC-safety constraint.
function terminalGrowthCalibrated(sectorKey, wacc) {
  let g = SECTOR_TERMINAL_G[sectorKey] || SECTOR_TERMINAL_G.default;
  // Must be < WACC - 1pp. If too close, dial back.
  const ceiling = wacc - 0.01;
  let adjusted = false;
  if (g >= ceiling) {
    g = wacc - 0.015;
    adjusted = true;
    console.log(`[fundamental-agent] terminal g lowered: sector=${sectorKey} wacc=${wacc.toFixed(4)} g=${g.toFixed(4)}`);
  }
  // Hard floor at 0.5% — terminal can't go negative
  if (g < 0.005) g = 0.005;
  return { g, adjusted };
}

function valueFcfStream(fcfs, wacc, terminalG) {
  if (wacc <= terminalG) return null;
  let pv = 0;
  for (let i = 0; i < fcfs.length; i++) {
    pv += fcfs[i] / Math.pow(1 + wacc, i + 1);
  }
  const last = fcfs[fcfs.length - 1];
  const tv = last * (1 + terminalG) / (wacc - terminalG);
  const pvTv = tv / Math.pow(1 + wacc, fcfs.length);
  return { pvFcf: pv, pvTv, ev: pv + pvTv, tv };
}

// One scenario = one full DCF run with a specific (growths, margin, wacc, g) set.
function runScenario({ startRev, growths, fcfMargin, waccObj, terminalG,
                       sharesOut, totalDebt, cash, currentPrice }) {
  const projections = projectRevenuesStaged(startRev, growths);
  const fcfs = projections.map(p => p.revenue * fcfMargin);
  const tg = terminalGrowthCalibrated(null, waccObj.wacc);  // placeholder; caller overrides
  const useG = terminalG != null ? terminalG : tg.g;
  const v = valueFcfStream(fcfs, waccObj.wacc, useG);
  if (!v) return null;
  const netDebt = (totalDebt || 0) - (cash || 0);
  const equityValue = v.ev - netDebt;
  const fairValue = equityValue / sharesOut;
  const upside = currentPrice ? (fairValue - currentPrice) / currentPrice : null;
  return {
    projections: projections.map((p, i) => ({ ...p, fcf: fcfs[i] })),
    pvFcf: v.pvFcf, pvTv: v.pvTv, ev: v.ev, tv: v.tv,
    netDebt, equityValue, fairValue, upside,
    assumptions: {
      growths, fcfMargin, terminalG: useG,
      wacc: waccObj.wacc, ke: waccObj.ke, kd: waccObj.kd,
      taxRate: waccObj.tax, beta: waccObj.beta
    }
  };
}

// Bull / base / bear factory.
//   Base = baseline calibrated inputs
//   Bull = growth ×1.25 (re-capped at sector+5pp), FCF +200bps, WACC −100bps, g +50bps
//   Bear = growth ×0.75,                          FCF −200bps, WACC +100bps, g −50bps
function buildScenarios(inputs) {
  const { snapshots, sectorKey, baseGObj, fcfMarginObj, waccBase, terminalGBase,
          sharesOut, totalDebt, cash, currentPrice, beta, marketCap,
          interestExpense, taxRate, region } = inputs;
  const startRev = snapshots[0].revenue;

  // Scenario builder helper.
  const mk = (gMult, marginDelta, waccDelta, gDelta) => {
    // Cap multiplier still respects sector cap + 5pp upper bound on bull
    const cap = SECTOR_GROWTH_CAP[sectorKey] || SECTOR_GROWTH_CAP.default;
    const bullCeiling = cap + 0.05;
    let baseG = baseGObj.baseG * gMult;
    if (gMult > 1) baseG = Math.min(baseG, bullCeiling);
    if (gMult < 1) baseG = Math.max(baseG, -0.10);
    const growths = stageFade(baseG);

    // FCF margin adjustment with same sector cap (relaxed by 5pp on bull)
    let fcfMargin = fcfMarginObj.margin + marginDelta;
    const fcfCap = SECTOR_FCF_CAP[sectorKey];
    if (fcfCap != null) {
      const ceiling = marginDelta > 0 ? fcfCap + 0.05 : fcfCap;
      if (fcfMargin > ceiling) fcfMargin = ceiling;
    }
    if (fcfMargin < FCF_MARGIN_FLOOR) fcfMargin = FCF_MARGIN_FLOOR;

    // WACC: recompute with bounded knobs
    const waccObj = computeWaccCalibrated({
      beta, marketCap, totalDebt, interestExpense, taxRate, region
    });
    waccObj.wacc = clamp(waccObj.wacc + waccDelta, WACC_FLOOR, WACC_CAP);

    // Terminal: sector default + delta, with WACC-safety
    let terminalG = (SECTOR_TERMINAL_G[sectorKey] || SECTOR_TERMINAL_G.default) + gDelta;
    const tg = terminalGrowthCalibrated(sectorKey, waccObj.wacc);
    if (terminalG > waccObj.wacc - 0.01) terminalG = tg.g;
    if (terminalG < 0.005) terminalG = 0.005;

    return runScenario({
      startRev, growths, fcfMargin, waccObj, terminalG,
      sharesOut, totalDebt, cash, currentPrice
    });
  };

  return {
    bull_case: mk(1.25,  0.02, -0.01,  0.005),
    base_case: mk(1.00,  0.00,  0.00,  0.000),
    bear_case: mk(0.75, -0.02,  0.01, -0.005)
  };
}

// ── Margin of safety ─────────────────────────────────────────────
function marginOfSafety(fairValue, currentPrice) {
  if (fairValue == null || currentPrice == null || currentPrice <= 0 || fairValue <= 0) {
    return null;
  }
  const upside = (fairValue - currentPrice) / currentPrice;
  const discount = (fairValue - currentPrice) / fairValue;
  let category;
  if (upside > 0.50)       category = 'STRONG MARGIN OF SAFETY';
  else if (upside > 0.25)  category = 'GOOD MARGIN OF SAFETY';
  else if (upside > 0.10)  category = 'ADEQUATE MARGIN';
  else if (upside >= -0.10) category = 'FAIR VALUE';
  else if (upside >= -0.25) category = 'PREMIUM PRICING';
  else                      category = 'OVERVALUED PER MODEL';
  return { category, discount_pct: discount, upside_pct: upside };
}

// ── Wall Street consensus ────────────────────────────────────────
function buildConsensus(priceTargetData, ourFairValue) {
  if (!priceTargetData) return null;
  const mean   = priceTargetData.targetMean   || null;
  const median = priceTargetData.targetMedian || null;
  const high   = priceTargetData.targetHigh   || null;
  const low    = priceTargetData.targetLow    || null;
  if (mean == null && median == null) return null;
  const consensusValue = mean || median;
  const delta = (ourFairValue && consensusValue)
    ? (ourFairValue - consensusValue) / consensusValue
    : null;
  return {
    target_mean: mean,
    target_high: high,
    target_low: low,
    target_median: median,
    vs_our_fair_value: ourFairValue != null && consensusValue != null
      ? { our_value: ourFairValue, consensus_value: consensusValue, delta_pct: delta }
      : null
  };
}

// ── Confidence score ─────────────────────────────────────────────
function buildConfidence({ snapshotCount, bestFcfSource, ttmFallbackUsed,
                            peerCount, consensusAvailable, betaAvailable }) {
  let score = 0;
  const factors = [];

  if (snapshotCount >= 5)      { score += 30; factors.push('5y data'); }
  else if (snapshotCount >= 3) { score += 20; factors.push(`${snapshotCount}y data`); }
  else if (snapshotCount >= 1) { score += 10; factors.push(`${snapshotCount}y data (sparse)`); }

  if (ttmFallbackUsed) {
    score += 5; factors.push('TTM fallback FCF');
  } else if (bestFcfSource === 'direct') {
    score += 25; factors.push('direct FCF');
  } else if (bestFcfSource === 'cfo-capex') {
    score += 20; factors.push('CFO − CapEx');
  } else if (bestFcfSource === 'cfo-only') {
    score += 10; factors.push('CFO-only proxy');
  }

  if (peerCount >= 4)      { score += 20; factors.push(`${peerCount} peers`); }
  else if (peerCount === 3){ score += 15; factors.push('3 peers'); }
  else if (peerCount === 2){ score += 10; factors.push('2 peers'); }

  if (consensusAvailable) { score += 15; factors.push('consensus available'); }
  if (betaAvailable)      { score += 10; factors.push('beta from Finnhub'); }

  let category;
  if (score >= 80)      category = 'HIGH CONFIDENCE';
  else if (score >= 50) category = 'MEDIUM CONFIDENCE';
  else                  category = 'LOW CONFIDENCE';
  return { score, category, factors };
}

// ── 3x3 sensitivity grid built off the BASE scenario ─────────────
function sensitivityGrid({ startRev, growths, fcfMargin, baseWacc, baseTerminalG,
                            netDebt, sharesOut, currentPrice }) {
  const projections = projectRevenuesStaged(startRev, growths);
  const fcfs = projections.map(p => p.revenue * fcfMargin);
  const wDeltas = [-0.01, 0, 0.01];
  const gDeltas = [-0.005, 0, 0.005];
  const grid = [];
  for (const dw of wDeltas) {
    const row = [];
    for (const dg of gDeltas) {
      const ww = baseWacc + dw;
      const gg = baseTerminalG + dg;
      const v = valueFcfStream(fcfs, ww, gg);
      if (!v) { row.push(null); continue; }
      const fv = (v.ev - netDebt) / sharesOut;
      row.push({ wacc: ww, g: gg, fairValue: fv,
                 upside: currentPrice ? (fv - currentPrice) / currentPrice : null });
    }
    grid.push(row);
  }
  return { grid, axes: { wacc: wDeltas.map(d => baseWacc + d), g: gDeltas.map(d => baseTerminalG + d) } };
}

// ═══════════════════════════════════════════════════════════════════
// Claude narrative (calibration-aware prompt)
// ═══════════════════════════════════════════════════════════════════
async function runClaude(apiKey, brief, lang) {
  const system = `You are a senior fundamental research analyst at a top-tier hedge fund. You will be given a structured JSON brief containing pre-computed valuation multiples, financial health scores (Altman Z, Piotroski F, Beneish M), and a calibrated 5-year DCF with bull/base/bear scenarios, Wall Street consensus, margin-of-safety category, and a confidence score.

Produce a concise institutional-grade narrative. Return ONLY a JSON object, no preamble:

{
  "valuation_summary": "<2-3 sentence bottom line referencing margin-of-safety category, confidence level, AND the scenario range (bull/bear). Use 'model suggests' phrasing rather than 'stock is overvalued'.>",
  "peer_takeaway":     "<2 sentences on multiples vs peers / sector median; flag any unusually rich or cheap multiple.>",
  "health_observation":"<2 sentences interpreting Altman Z + Piotroski F + Beneish M together — not in isolation.>",
  "dcf_note":          "<1-2 sentences. If base-case fair value differs from current price by >30%, explicitly call out WHICH assumption (revenue CAGR, FCF margin, WACC, or terminal growth) drives the gap. If consensus is available, contextualize: 'Our model suggests X while Wall Street consensus targets Y because Z.' If DCF was skipped, explain in 1 sentence why.>",
  "institutional_insight": "<3-4 sentences of NON-OBVIOUS contrarian read. Reference specific multiples/scores/scenario range. For LATAM ADRs, weight the EM risk premium adjustment built into WACC. Avoid overconfident language — the bull/bear gap is your uncertainty band.>"
}

Calibration guidance: our DCF is intentionally bounded (WACC 7.5–14%, sector-aware growth caps, terminal 2.0–3.0%). Output ranges that differ >50% from consensus on either side suggest model fragility, not insight. Surface that fragility honestly in dcf_note when it occurs.

Be quantitative. Be specific. No fluff.`;

  const user = `Analyze this fundamentals brief and return the JSON narrative.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 1500, system: system + langDirective(lang),
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
    // ── 1. Parallel Finnhub pulls (now includes /price-target) ──
    const [profileRes, metricRes, finRes, peersRes, quoteRes, ptRes] = await Promise.all([
      safeFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/financials-reported?symbol=${ticker}&freq=annual&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/peers?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${ticker}&token=${finnhubKey}`)
    ]);
    const [profile, metric, fin, peersRaw, quote, priceTarget] = await Promise.all([
      safeJson(profileRes), safeJson(metricRes), safeJson(finRes),
      safeJson(peersRes), safeJson(quoteRes), safeJson(ptRes)
    ]);

    if (!profile && !metric) {
      return res.status(200).json({
        ticker,
        error: 'No Finnhub data for this ticker. Coverage limited to US-listed names.'
      });
    }

    const companyName = (profile && profile.name) || ticker;
    const industry = (profile && profile.finnhubIndustry) || null;
    const sector = industry;  // Finnhub doesn't give GICS sector cleanly
    const country = (profile && profile.country) || null;
    const region = classifyRegion(country);
    const sectorKey = classifySector(industry);

    const currentPrice = (quote && typeof quote.c === 'number' && quote.c > 0) ? quote.c : null;
    const marketCap = (profile && profile.marketCapitalization)
      ? profile.marketCapitalization * 1e6 : null;
    const sharesOut = (profile && profile.shareOutstanding)
      ? profile.shareOutstanding * 1e6 : null;
    const rawBeta = (metric && metric.metric && metric.metric.beta) || null;

    // ── 2. Annual snapshots (5y) ──
    const snapshots = (fin && Array.isArray(fin.data) ? fin.data : [])
      .filter(r => r && r.report)
      .slice(0, 5)
      .map(extractSnapshot);
    const latest = snapshots[0] || null;
    const prior  = snapshots[1] || null;

    // ── 3. Peer resolution ──
    let peerTickers = Array.isArray(peersRaw)
      ? peersRaw.filter(p => typeof p === 'string' && p.toUpperCase() !== ticker).slice(0, 4)
      : [];
    let peerSource = 'finnhub';
    if (peerTickers.length < 2 && MANUAL_PEER_FALLBACK[ticker]) {
      console.log(`[fundamental-agent] ${ticker}: using manual peer fallback (finnhub returned ${peerTickers.length})`);
      peerTickers = MANUAL_PEER_FALLBACK[ticker].filter(p => p.toUpperCase() !== ticker).slice(0, 4);
      peerSource = 'manual';
    }
    const peerMetricRes = await Promise.all(peerTickers.map(p =>
      safeFetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(p)}&metric=all&token=${finnhubKey}`)
    ));
    const peerMetrics = await Promise.all(peerMetricRes.map(safeJson));
    const peers = peerTickers.map((sym, i) => ({ ticker: sym, multiples: extractMultiples(peerMetrics[i]) }));

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
    const z = altmanZ(latest || {}, marketCap);
    const f = piotroskiF(latest, prior);
    const b = beneishM(latest, prior);
    const scores = {
      altmanZ:   { value: z, ...altmanInterpretation(z) },
      piotroski: { value: f ? f.scaled : null, raw: f ? f.raw : null, used: f ? f.used : null, ...piotroskiInterpretation(f) },
      beneishM:  { value: b ? b.m : null, missing: b ? b.missing : null, ...beneishInterpretation(b) }
    };

    // ── 5. Calibrated DCF ──
    // Effective tax rate = tax / pretax income, pretax = netIncome + tax.
    // Use explicit null checks (not truthiness) so a legitimate zero tax or
    // zero net income isn't treated as missing data.
    const pretaxIncome = (latest && latest.incomeTax != null && latest.netIncome != null)
      ? latest.incomeTax + latest.netIncome : null;
    const taxRate = (pretaxIncome != null && pretaxIncome > 0)
      ? latest.incomeTax / pretaxIncome : null;
    const totalDebt = latest ? latest.totalDebt : null;
    const cash      = latest ? latest.cash : null;
    const interestExpense = latest ? latest.interestExpense : null;

    // TTM fallback margin from Finnhub's normalized metric
    const mm = (metric && metric.metric) || {};
    const fcfTtm = mm.freeCashFlowTTM || mm.freeCashFlowAnnual || null;
    // fcfTtm and revenueTTM are in millions; revenuePerShareTTM is per share in
    // actual currency, so multiply by shares-in-millions (profile.shareOutstanding,
    // not the ×1e6 sharesOut) to keep the fallback revenue in millions too —
    // otherwise the margin comes out ~1e6 too small and collapses to ~0.
    const sharesOutMM = (profile && profile.shareOutstanding) ? profile.shareOutstanding : null;
    const revTtm = mm.revenueTTM || (mm.revenuePerShareTTM != null && sharesOutMM ? mm.revenuePerShareTTM * sharesOutMM : null);
    const fallbackFcfMargin = (fcfTtm != null && revTtm != null && revTtm > 0) ? fcfTtm / revTtm : null;

    let dcf = null;
    let scenarios = null;
    let sensitivity = null;
    let ttmFallbackUsed = false;

    const baseGObj = baseRevenueGrowth(snapshots, sectorKey);
    if (baseGObj.skipped) {
      dcf = { skipped: true, reason: 'Insufficient revenue history' };
    } else if (!sharesOut || sharesOut <= 0) {
      dcf = { skipped: true, reason: 'Shares outstanding unavailable' };
    } else {
      let fcfMarginObj = fcfMarginCalibrated(snapshots, sectorKey);
      if (fcfMarginObj.margin == null && fallbackFcfMargin != null && isFinite(fallbackFcfMargin)) {
        fcfMarginObj = {
          margin: clamp(fallbackFcfMargin, FCF_MARGIN_FLOOR, SECTOR_FCF_CAP[sectorKey] || 1),
          method: 'ttm_fallback', count: 0, capped: false
        };
        ttmFallbackUsed = true;
      }
      if (fcfMarginObj.margin == null) {
        dcf = { skipped: true, reason: 'No FCF history available' };
      } else if (fcfMarginObj.margin < 0) {
        dcf = { skipped: true, reason: 'Negative average FCF margin — DCF not meaningful for current cash burn profile' };
      } else {
        const waccBase = computeWaccCalibrated({
          beta: rawBeta, marketCap, totalDebt, interestExpense, taxRate, region
        });
        const tgBase = terminalGrowthCalibrated(sectorKey, waccBase.wacc);

        scenarios = buildScenarios({
          snapshots, sectorKey, baseGObj, fcfMarginObj, waccBase, terminalGBase: tgBase.g,
          sharesOut, totalDebt, cash, currentPrice,
          beta: rawBeta, marketCap, interestExpense, taxRate, region
        });

        const baseScen = scenarios.base_case;
        if (!baseScen) {
          dcf = { skipped: true, reason: 'WACC ≤ terminal growth — model degenerates' };
        } else {
          // 3x3 sensitivity off the base scenario's inputs
          const sens = sensitivityGrid({
            startRev: snapshots[0].revenue,
            growths: stageFade(baseGObj.baseG),
            fcfMargin: fcfMarginObj.margin,
            baseWacc: waccBase.wacc,
            baseTerminalG: tgBase.g,
            netDebt: baseScen.netDebt,
            sharesOut, currentPrice
          });
          sensitivity = sens.grid;

          dcf = {
            skipped: false,
            assumptions: {
              sectorKey, sectorLabel: industry,
              region: region.code, regionLabel: region.label,
              startRevenue: snapshots[0].revenue,
              revenueCagr: baseGObj.rawCagr,
              revenueCagrCapped: baseGObj.wasCapped,
              revenueGrowthCap: baseGObj.cap,
              stageGrowths: stageFade(baseGObj.baseG),
              fcfMargin: fcfMarginObj.margin,
              fcfMarginMethod: fcfMarginObj.method,
              fcfMarginCapped: fcfMarginObj.capped,
              fcfMarginSource: ttmFallbackUsed
                ? 'TTM (Finnhub metric)'
                : (fcfMarginObj.method.includes('trimmed') ? 'historical trimmed mean'
                  : fcfMarginObj.method.includes('median') ? 'historical median'
                  : 'historical avg'),
              wacc: waccBase.wacc,
              waccRaw: waccBase.rawWacc,
              waccBounded: waccBase.bounded,
              costOfEquity: waccBase.ke,
              costOfDebtAfterTax: waccBase.kd,
              costOfDebtPretax: waccBase.kdPretax,
              taxRate: waccBase.tax,
              weightEquity: waccBase.weights.e,
              weightDebt: waccBase.weights.d,
              beta: waccBase.beta,
              betaRaw: waccBase.rawBeta,
              erp: waccBase.erp,
              terminalGrowth: tgBase.g,
              terminalGrowthAdjusted: tgBase.adjusted
            },
            projections: baseScen.projections,
            ev: baseScen.ev,
            pvFcf: baseScen.pvFcf,
            pvTv: baseScen.pvTv,
            terminalValue: baseScen.tv,
            netDebt: baseScen.netDebt,
            equityValue: baseScen.equityValue,
            sharesOut,
            fairValuePerShare: baseScen.fairValue,
            currentPrice,
            upside: baseScen.upside,
            sensitivity,
            sensitivityAxes: sens.axes
          };
        }
      }
    }

    // ── 6. Margin of safety + signal ──
    const mos = (dcf && !dcf.skipped)
      ? marginOfSafety(dcf.fairValuePerShare, currentPrice)
      : null;
    // Backward-compat "signal" chip — collapses MoS to 3 bands.
    const signal = dcf && dcf.skipped
      ? { band: 'N/A', color: 'grey', reason: dcf.reason }
      : (mos == null
          ? { band: 'N/A', color: 'grey' }
          : mos.upside_pct > 0.15 ? { band: 'DISCOUNT', color: 'green' }
          : mos.upside_pct < -0.15 ? { band: 'PREMIUM', color: 'red' }
          : { band: 'FAIR', color: 'amber' });

    // ── 7. Consensus ──
    const consensus = buildConsensus(priceTarget, dcf && !dcf.skipped ? dcf.fairValuePerShare : null);

    // ── 8. Confidence ──
    const bestFcfSource = snapshots.map(s => s.fcfSource).find(s => s === 'direct')
      || snapshots.map(s => s.fcfSource).find(s => s === 'cfo-capex')
      || snapshots.map(s => s.fcfSource).find(s => s === 'cfo-only')
      || null;
    const confidence = buildConfidence({
      snapshotCount: snapshots.length,
      bestFcfSource,
      ttmFallbackUsed,
      peerCount: peers.length,
      consensusAvailable: !!consensus,
      betaAvailable: rawBeta != null
    });

    // Diagnostic log
    console.log(`[fundamental-agent] ${ticker}: sector=${sectorKey} region=${region.code} ` +
      `cagr=${baseGObj.skipped ? 'n/a' : (baseGObj.rawCagr*100).toFixed(1)+'%'} ` +
      `cap_bind=${!!baseGObj.wasCapped} ` +
      `fcf=${dcf && !dcf.skipped ? (dcf.assumptions.fcfMargin*100).toFixed(1)+'%' : 'skip'} ` +
      `wacc=${dcf && !dcf.skipped ? (dcf.assumptions.wacc*100).toFixed(2)+'%' : 'skip'} ` +
      `tg=${dcf && !dcf.skipped ? (dcf.assumptions.terminalGrowth*100).toFixed(2)+'%' : 'skip'} ` +
      `fv=${dcf && !dcf.skipped ? dcf.fairValuePerShare.toFixed(2) : 'skip'} ` +
      `confidence=${confidence.score}`);

    // ── 9. Claude narrative ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let narrative = null;
    if (apiKey) {
      const brief = {
        ticker, company: companyName, sector: industry, sectorKey,
        region: region.label, peers: peers.map(p => ({ ticker: p.ticker, multiples: p.multiples })),
        currentPrice, multiples: selfMultiples, sectorMedians, scores,
        dcf, scenarios, margin_of_safety: mos, consensus, confidence, signal
      };
      const out = await runClaude(apiKey, brief, lang);
      if (out.ok) narrative = out.ok;
      else console.log(`[fundamental-agent] ${ticker}: claude error`, out.error, out.raw_preview || out.detail);
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json({
      ticker,
      companyName,
      sector,
      industry,
      sectorKey,
      country,
      region: region.label,
      currentPrice,
      marketCap,
      sharesOut,
      beta: rawBeta,
      peers: peers.map(p => p.ticker),
      multiples: { self: selfMultiples, peers, sectorMedians },
      scores,
      dcf,
      scenarios,
      margin_of_safety: mos,
      consensus,
      confidence,
      signal,
      narrative,
      source: 'Finnhub + Custom DCF + Claude',
      stats: {
        snapshots_used: snapshots.length,
        peer_count: peers.length,
        peer_source: peerSource,
        ttm_fallback_used: ttmFallbackUsed
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
