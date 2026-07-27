// ═══════════════════════════════════════════════════════════════════
// api/_lib/screens.js — screens DETERMINISTAS del canal screener (Arena).
//
// Puro, sin I/O: entran las filas de arena_screener (métricas precomputadas)
// y salen los top-N por screen, ya rankeados, con los NÚMEROS que calificaron
// a cada candidato. El SCAN recibe esto ya cocinado — no rankea el LLM.
//
// CANDADO DE PRECIO (condición dura del producto): los qualifiers que salen
// de aquí son RATIOS/porcentajes (P/E, ROE, deuda, % sobre la media móvil),
// NUNCA un precio absoluto. El precio del screener está 1-2 días stale y no
// debe tocar la decisión de limit_price — ese número sale de lastCompletedClose
// (fresco, el mismo del guard) en la fase DIVE. Ver assert en los tests.
//
// Trial (time-boxed): dos screens, value + momentum. Tres diluiría la
// atribución justo cuando se estrena. Expansión con datos, en un mes.
// ═══════════════════════════════════════════════════════════════════

// Tipos que NO son equity común/ADR/REIT — defensa en profundidad (el universo
// ya viene curado, pero si un símbolo resuelve a fondo/no-equity lo saltamos).
const NON_EQUITY = new Set(['ETP', 'Closed-End Fund', 'Open-End Fund', 'Unit', 'Equity WRT', 'Right', 'Preference', 'PUBLIC']);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function isEquity(row) {
  return !row.security_type || !NON_EQUITY.has(row.security_type);
}

// ── VALUE: P/E bajo + ROE alto + deuda baja ──────────────────────────
// Margen de Finnhub en % (roe_ttm 15 = 15%); deuda como ratio (1.0 = 1x equity).
// Rank: roe_ttm / pe_ttm → calidad barata (más ROE por unidad de P/E).
function valueScreen(rows, topN) {
  const out = [];
  for (const r of rows) {
    if (!isEquity(r)) continue;
    const pe = num(r.pe_ttm), roe = num(r.roe_ttm), de = num(r.debt_to_equity);
    if (pe == null || pe <= 0 || pe >= 20) continue;
    if (roe == null || roe <= 15) continue;
    if (de == null || de >= 1.0) continue;
    out.push({
      symbol: r.symbol,
      screen: 'value',
      rank_score: roe / pe,
      qualifiers: { pe_ttm: round2(pe), roe_ttm: round1(roe), debt_to_equity: round2(de) },
    });
  }
  return out.sort((a, b) => b.rank_score - a.rank_score).slice(0, topN);
}

// ── MOMENTUM: precio sobre media móvil, tendencia alcista sana ───────
// Filtro: close > MA50 > MA200 (uptrend). Qualifier: % sobre MA50 (SIN precio
// absoluto). Rank por % sobre MA50, pero se EXCLUYEN extendidos (>30%) para no
// perseguir blowoffs. La MA es precomputada (stale 1-2d) — para una MA50 el lag
// es despreciable, y de todas formas es una señal dimensionless, no un precio.
function momentumScreen(rows, topN) {
  const out = [];
  for (const r of rows) {
    if (!isEquity(r)) continue;
    const close = num(r.last_close), ma50 = num(r.ma50), ma200 = num(r.ma200);
    if (close == null || ma50 == null || ma200 == null || ma50 <= 0 || ma200 <= 0) continue;
    if (!(close > ma50 && ma50 > ma200)) continue;
    const aboveMa50 = (close / ma50 - 1) * 100;
    if (aboveMa50 > 30) continue; // extendido/blowoff → fuera
    out.push({
      symbol: r.symbol,
      screen: 'momentum',
      rank_score: aboveMa50,
      qualifiers: { above_ma50_pct: round1(aboveMa50), above_ma200: true },
    });
  }
  return out.sort((a, b) => b.rank_score - a.rank_score).slice(0, topN);
}

// ── computeScreens(rows) → { value:[...], momentum:[...] } ───────────
// Cada entry: { symbol, screen, qualifiers } (sin rank_score — es interno).
// Los qualifiers NO llevan precio absoluto (candado condición #3).
export function computeScreens(rows, { topN = 5 } = {}) {
  const strip = (arr) => arr.map(({ rank_score, ...keep }) => keep);
  const list = Array.isArray(rows) ? rows : [];
  return { value: strip(valueScreen(list, topN)), momentum: strip(momentumScreen(list, topN)) };
}

// Unión rankeada de símbolos del screener (para el floor): value primero,
// luego momentum, dedupe. El orden = prioridad de reserva del floor.
export function screenerRankedSymbols(screens) {
  const seen = new Set();
  const ranked = [];
  for (const list of [screens.value || [], screens.momentum || []]) {
    for (const c of list) {
      if (seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      ranked.push(c.symbol);
    }
  }
  return ranked;
}
