// ═══════════════════════════════════════════════════════════════════
// api/_lib/screener-universe.js — universo del canal SCREENER del Arena.
//
// Extraído de SCREENER_UNIVERSE.us (app.html): los ~150 nombres líquidos de
// equity común + ADR, SIN los ~27 ETFs (SPY/QQQ/XLK/SOXX/GLD…) que el bloque
// "Big ETFs" de app.html incluye y que el guard ya excluye por tipo (ETP).
// Los ADR se mantienen a propósito (BABA/JD/PDD/BIDU/NIO/XPEV/ASML/ARM/SHOP)
// — el mismo criterio de universo del guard (equity común + ADR + REIT).
//
// FUENTE DE LA VERDAD (por ahora): este archivo. app.html conserva SU copia;
// el dedup (que app.html consuma esta lista) queda como follow-up. El riesgo
// de drift es bajo — la lista es estable y curada por liquidez.
//
// El cron arena-screener precomputa métricas por cada uno de estos símbolos
// en Neon (arena_screener); el arena-run SOLO LEE esa tabla.
//
// ── EXPANSIÓN DE UNIVERSO v2 (2026-08-06) ───────────────────────────
// La expansión ya no es a mano: `scripts/gen-screener-universe.mjs` REGENERA
// esta lista corriendo los criterios de liquidez existentes (precio ≥ $1 de
// ARENA_RULES, ADV ≥ $1M de ticker-search, + piso de cap configurable) contra
// el symbol map US de HOY, con el mismo gate de tipos del guard (equity común +
// ADR + REIT). La lógica pura y testeada vive en `_lib/screener-universe-gen.js`.
// Target v2: ~300 nombres (tope cómodo — ver docs/screener-product-scope.md §3:
// el cron los cicla en <1 día a PER_RUN=80, muy bajo el cap Finnhub 60/min).
// Para regenerar:  FINNHUB_API_KEY=… node scripts/gen-screener-universe.mjs \
//                    --n=300 --min-cap=2e9 --write   (luego ?job=seed).
// Mientras no se corra con la key, esta lista queda como el universo v1 curado.
// ═══════════════════════════════════════════════════════════════════

const US_SCREENER_UNIVERSE = [
  // Mega-cap tech / software
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'TSLA', 'AVGO', 'ORCL',
  'CRM', 'ADBE', 'NOW', 'CSCO', 'INTC', 'AMD', 'QCOM', 'TXN', 'MU', 'AMAT',
  'LRCX', 'KLAC', 'ASML', 'ARM', 'MRVL', 'SMCI', 'PLTR', 'SNOW', 'DDOG', 'NET',
  'CRWD', 'ZS', 'PANW', 'FTNT', 'OKTA', 'TEAM', 'MDB', 'ZM', 'DOCU', 'HUBS',
  // Financials
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'V', 'MA', 'PYPL',
  'COF', 'USB', 'PNC', 'TFC', 'SPGI', 'MCO', 'CB', 'PGR', 'MET', 'PRU', 'AIG',
  // Healthcare / pharma
  'JNJ', 'UNH', 'LLY', 'PFE', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN',
  'GILD', 'CVS', 'CI', 'HUM', 'ELV', 'REGN', 'VRTX', 'ISRG', 'MDT', 'SYK', 'BSX',
  // Consumer / retail / staples
  'WMT', 'HD', 'COST', 'LOW', 'TGT', 'NKE', 'LULU', 'SBUX', 'MCD', 'CMG', 'YUM',
  'KO', 'PEP', 'PG', 'CL', 'KMB', 'MDLZ', 'MNST', 'EL', 'PM', 'MO',
  // Energy (HES removida: Hess absorbida por Chevron —CVX ya está en la lista—,
  // delisted 2025; el ledger la marca not_found y el refresh dejó de reintentarla)
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'VLO', 'OXY',
  // Industrials / defense / transport
  'BA', 'LMT', 'RTX', 'GE', 'CAT', 'DE', 'HON', 'UPS', 'FDX', 'UBER', 'LYFT',
  // Media / entertainment
  'NFLX', 'DIS', 'SPOT', 'RBLX', 'EA', 'TTWO', 'PINS', 'SNAP',
  // Speculative / fintech / ADRs
  'COIN', 'HOOD', 'RIVN', 'LCID', 'NIO', 'XPEV', 'BABA', 'JD', 'PDD', 'BIDU',
  // XYZ = Block (antes SQ): rebrand con cambio de ticker en NYSE, ene-2025.
  'SHOP', 'XYZ', 'AFRM', 'SOFI', 'UPST', 'RKT',
];

// entries para seedLedger(): dedupe defensivo por si la lista crece con copiar/pegar.
function universeLedgerEntries() {
  return [...new Set(US_SCREENER_UNIVERSE)].map((symbol) => ({ symbol }));
}

// ── Auditoría del universo vs. el symbol map US de Finnhub ────────────
// Un símbolo del universo que NO aparece en el symbol map de Finnhub ya no
// cotiza con ese ticker: delisted (p.ej. HES, absorbida por Chevron) o
// renombrado (p.ej. SQ → XYZ tras el rebrand de Block). Los tickers muertos
// hacían que el refresh gastara Finnhub/Yahoo en ellos cada ciclo y fallara.
// El cron usa esto para marcarlos `not_found` (terminal, sin reintentos) y
// `?job=audit` lo reporta.
//
// `symbolMap` = { SYMBOL: nombre } de getSymbolMap. NO adivina: si el map llegó
// vacío (Finnhub caído) devuelve todos como "missing" y el caller DEBE tratar
// el resultado como no autoritativo (ver el gate en arena-screener/refresh).
function auditUniverse(symbolMap) {
  const map = symbolMap || {};
  const universe = [...new Set(US_SCREENER_UNIVERSE)];
  const missing = universe.filter((s) => !(s in map));
  return { total: universe.length, present: universe.length - missing.length, missing };
}

export { US_SCREENER_UNIVERSE, universeLedgerEntries, auditUniverse };
