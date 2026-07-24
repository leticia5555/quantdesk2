// ═══════════════════════════════════════════════════════════════════
// api/_lib/pead-universe.js — universo v0 del backtest PEAD.
//
// ~100 nombres más líquidos de equity común US (sin ETFs, sin ADRs con
// suffix, sin micro-caps). Todos priority=0 → se cosechan primero (25/día
// de AV → ~4 días). La expansión al universo completo se agrega después con
// priority>=1; el mismo cron la drena por prioridad (docs §"Plan de cosecha").
//
// RECORDATORIO (regla dura, docs §2.2): este universo está definido por
// liquidez de HOY. Sirve para analizar ~3 años. Ir más profundo exige un
// universo point-in-time o los resultados no son válidos por survivorship.
// ═══════════════════════════════════════════════════════════════════

// Curado por liquidez (ADV en dólares) y capitalización, cruzando sectores para
// no sesgar el estudio a tech. Solo tickers US sin punto (excluye .MX/.SA ADRs).
const V0_UNIVERSE = [
  // Mega-cap tech / comms
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'ORCL', 'ADBE',
  'CRM', 'AMD', 'CSCO', 'ACN', 'INTC', 'QCOM', 'TXN', 'IBM', 'NOW', 'INTU',
  'MU', 'AMAT', 'ADI', 'LRCX', 'KLAC', 'PANW', 'SNPS', 'CDNS', 'MRVL', 'FTNT',
  // Consumer discretionary / retail
  'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'BKNG', 'TJX', 'CMG', 'ABNB',
  // Communication / media
  'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS',
  // Financials
  'MMC', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'BLK',
  'C', 'SCHW', 'SPGI', 'PYPL', 'COF',
  // Healthcare
  'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'DHR', 'BMY',
  'AMGN', 'GILD', 'CVS', 'ISRG', 'VRTX',
  // Industrials / energy / materials
  'XOM', 'CVX', 'CAT', 'BA', 'GE', 'HON', 'UNP', 'RTX', 'LMT', 'DE',
  'COP', 'SLB', 'UPS', 'GEV',
  // Consumer staples
  'WMT', 'PG', 'KO', 'PEP', 'COST', 'PM', 'MO', 'MDLZ', 'CL',
];

// entries para seedLedger(): todos priority 0.
function v0LedgerEntries() {
  return V0_UNIVERSE.map((symbol) => ({ symbol, priority: 0 }));
}

export { V0_UNIVERSE, v0LedgerEntries };
