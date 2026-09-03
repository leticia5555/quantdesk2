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

import { deriveTemporal } from './temporal-fundamentals.js';

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

// ── Estado de los DATOS del screener (para un post-mortem honesto) ───
// Distingue "la tabla no tiene datos utilizables" de "los tiene y ninguna
// screen disparó". El bug que lo motivó: `ARENA_SCREENER_ENABLED` faltaba en
// Vercel → el cron de precompute nunca corrió → `arena_screener` vacía, pero el
// floor reportaba `no_qualifying_candidates`, que se LEE como "ninguna acción
// calificó" cuando la verdad era "no hay datos". Estados:
//   'disabled' → tabla vacía Y el flag del cron apagado (el caso exacto del bug).
//   'empty'    → tabla vacía con el cron prendido (aún no llenó / sin filas).
//   'stale'    → hay filas pero la más fresca supera SCREENER_STALE_HOURS
//                (rancia: el cron dejó de refrescar y la tabla quedó congelada).
//   'fresh'    → hay filas vigentes (la screen SÍ evaluó datos frescos).
// El caller mapea esto al `floor.reason` (screener_disabled/empty/stale) para
// que el journal no mienta cuando el canal simplemente no tenía qué evaluar.
export const SCREENER_STALE_HOURS = 24;

export function screenerDataState(rows, { now = new Date(), enabled = true, maxAgeHours = SCREENER_STALE_HOURS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return enabled ? 'empty' : 'disabled';
  let newest = null;
  for (const r of list) {
    const t = r && r.refreshed_at ? Date.parse(r.refreshed_at) : NaN;
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  // Filas sin `refreshed_at` válido = nunca se refrescaron de verdad → rancia.
  if (newest === null) return 'stale';
  const ageMs = now.getTime() - newest;
  return ageMs > maxAgeHours * 3600 * 1000 ? 'stale' : 'fresh';
}

// ── DIMENSIÓN TIEMPO del universo (hallazgo T1) ──────────────────────
// Las filas del screener ya traen las SERIES crudas por símbolo (historial de
// ingresos/EPS, tendencia del rating, snapshots de estimados, retornos). Aquí
// se convierten en ETIQUETAS (`revenue_trend`, `revisions`, `falling_knife`)
// con las mismas reglas puras que usa el deep dive — una sola definición de
// "qué es desacelerar", compartida por el canal precomputado y el live.
//
// El percentil de P/E es CROSS-SECCIONAL (depende del universo entero), así
// que se calcula aquí, al leer la tabla, y no se almacena: el universo cambia.

// Momentum guardado por el cron → la misma forma que produce priceMomentum().
// `above_sma200` se DERIVA de last_close vs ma200 (la ma200 de la tabla ES la
// SMA200 de cierres) — dato DESCRIPTIVO, jamás un breaker (acta dualmom).
export function storedMomentum(row) {
  const close = num(row.last_close), ma200 = num(row.ma200);
  const m = {
    ret_1m: num(row.ret_1m), ret_3m: num(row.ret_3m), ret_6m: num(row.ret_6m),
    dist_52w_high_pct: num(row.dist_52w_high_pct),
    above_sma200: close != null && ma200 != null && ma200 > 0 ? close > ma200 : null,
    as_of: row.refreshed_at ? String(row.refreshed_at).slice(0, 10) : null,
  };
  const hasAny = ['ret_1m', 'ret_3m', 'ret_6m', 'dist_52w_high_pct'].some((k) => m[k] != null) || m.above_sma200 != null;
  return hasAny ? m : null;
}

// rows → { SYMBOL: temporal }. Solo los símbolos con ALGO temporal (serie de
// ingresos, sorpresas, rating o momentum): una fila sin nada no entra al índice
// en vez de entrar con todo en null.
export function temporalIndex(rows, { now = new Date() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const universePes = list.map((r) => num(r.pe_ttm)).filter((v) => v != null && v > 0);
  const out = {};
  for (const r of list) {
    if (!r || !r.symbol) continue;
    const revenueHistory = Array.isArray(r.rev_yoy_history) ? r.rev_yoy_history : [];
    const epsSurprises = Array.isArray(r.eps_surprise_history) ? r.eps_surprise_history : [];
    const momentum = storedMomentum(r);
    const recTrend = r.rec_trend && typeof r.rec_trend === 'object' ? r.rec_trend : null;
    const estimateHistory = Array.isArray(r.estimate_history) ? r.estimate_history : null;
    if (!revenueHistory.length && !epsSurprises.length && !momentum && !recTrend && !(estimateHistory && estimateHistory.length)) continue;
    out[String(r.symbol).trim().toUpperCase()] = deriveTemporal({
      revenueHistory, epsSurprises, recTrend, estimateHistory, momentum,
      peTtm: num(r.pe_ttm), universePes, now,
    });
  }
  return out;
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
