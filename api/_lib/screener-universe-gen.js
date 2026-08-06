// ═══════════════════════════════════════════════════════════════════
// api/_lib/screener-universe-gen.js — criterios DETERMINISTAS para
// REGENERAR el universo del screener (expansión v2, 2026-08-06).
//
// Misma disciplina que el universo v1 (curado por liquidez), pero SIN nombres
// a mano: esta es la lógica pura (sin I/O, sin red) que
//   1. filtra el symbol map US por TIPO (el mismo gate del guard: equity
//      común + ADR + REIT), y
//   2. rankea a los sobrevivientes por liquidez (ADV en dólares) aplicando los
//      pisos existentes (precio, ADV) + un piso de capitalización, y corta al
//      top-N.
// El script `scripts/gen-screener-universe.mjs` le pone el I/O (symbol map de
// Finnhub, ADV de Yahoo, cap de Finnhub) y escribe el resultado en
// `screener-universe.js`. Aquí vive lo testeable con fixtures (cero red).
//
// FUENTE DE LOS CRITERIOS (no se reinventa ninguno):
//   - precio  → ARENA_RULES.min_price ($1), el piso del guard.
//   - ADV     → ADV_THRESHOLD_USD ($1M), el mismo umbral de liquidez de
//               /api/ticker-search?liquidity=.
//   - tipos   → EXCLUDED_SECURITY_TYPES + NON_EQUITY_TYPES del guard, aquí
//               expresados por INCLUSIÓN explícita (subconjunto estricto de lo
//               que el guard permite → nada generado puede caer por tipo).
//   - cap     → sin constante previa (v1 fue curado a mano). v2 lo codifica.
// ═══════════════════════════════════════════════════════════════════

import { ARENA_RULES, isLeveragedInverseETF } from './arena-guard.js';
import { ADV_THRESHOLD_USD } from '../ticker-search.js';

// ── Universo por TIPO, por INCLUSIÓN explícita ──────────────────────
// El guard filtra por EXCLUSIÓN (excluye ETP/CEF/warrants/…) y PERMITE el tipo
// vacío/desconocido (regla de producto: no descarta un símbolo por falta de
// dato). Para CONSTRUIR el universo desde cero eso es demasiado laxo — el
// symbol map US trae ~25-30k símbolos, muchos OTC con `type` vacío que no
// queremos arrastrar. Así que aquí exigimos que el tipo esté explícitamente en
// este set. Es un SUBCONJUNTO de lo que el guard admite ⇒ nada que este
// generador produzca puede ser rechazado por la regla de tipo del guard.
// (ADR se mantiene a propósito: NU/MELI/ITUB son el corazón de la audiencia.)
export const ALLOWED_SECURITY_TYPES = new Set(['Common Stock', 'ADR', 'REIT']);

// Piso de capitalización (criterio "cap"). No existía constante: el universo v1
// se curó a mano por liquidez + cap. v2 lo codifica; default mid/large-cap.
// Configurable desde el script (--min-cap). null = sin piso de cap.
export const DEFAULT_MIN_CAP_USD = 2_000_000_000;

const up = (s) => String(s || '').trim().toUpperCase();

// ── Gate de tipos sobre el symbol map ───────────────────────────────
// symbolMap = { SYMBOL: nombre }, symbolTypes = { SYMBOL: tipo } (ambos de
// getSymbolMap/getSymbolTypes). Devuelve los candidatos admisibles por tipo:
// [{ symbol, name, type }]. Un símbolo sin tipo, o con tipo fuera de ALLOWED,
// o apalancado/inverso por nombre, NO entra. Determinista, sin red.
export function gateByType(symbolMap, symbolTypes) {
  const map = symbolMap || {};
  const types = symbolTypes || {};
  const out = [];
  const seen = new Set();
  for (const symbol of Object.keys(map)) {
    const sym = up(symbol);
    if (!sym || seen.has(sym)) continue;
    const type = types[symbol] || null;
    if (!type || !ALLOWED_SECURITY_TYPES.has(type)) continue;
    const name = map[symbol] || null;
    // Defensa en profundidad: un ETP apalancado ya cae por tipo (ETP ∉ ALLOWED),
    // pero si Finnhub mistipa alguno como 'Common Stock', el nombre lo atrapa.
    if (isLeveragedInverseETF(sym, name)) continue;
    seen.add(sym);
    out.push({ symbol: sym, name, type });
  }
  return out;
}

// ── Selección final: pisos + ranking por ADV, top-N ─────────────────
// rows = [{ symbol, name, type, price, adv_usd, cap_usd }] (con métricas ya
// resueltas por el script). Aplica los pisos existentes y rankea por ADV en
// dólares (la medida de liquidez), corta al top-N.
//
// FAIL-CLOSED (ethos del repo: no inventar): un símbolo con precio/ADV/cap
// faltante NO entra — se cuenta en `rejected` por razón, nunca se asume que
// "seguro pasa". El ranking descendente por ADV ya sesga a los más líquidos;
// los pisos son cotas de sanidad + el gate de cap.
//
// opts: { n, minPrice, minAdvUsd, minCapUsd }. minCapUsd null/undefined ⇒ el
// cap no filtra (se conserva como dato informativo).
export function selectUniverse(rows, opts = {}) {
  const n = Number.isFinite(opts.n) ? opts.n : 300;
  const minPrice = Number.isFinite(opts.minPrice) ? opts.minPrice : ARENA_RULES.min_price;
  const minAdvUsd = Number.isFinite(opts.minAdvUsd) ? opts.minAdvUsd : ADV_THRESHOLD_USD;
  const minCapUsd = opts.minCapUsd === null || opts.minCapUsd === undefined
    ? null
    : Number(opts.minCapUsd);

  // null/undefined/'' → faltante (Number(null) es 0, que enmascararía un dato
  // ausente como "sub-mínimo" y rompería el conteo fail-closed).
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const rejected = { no_price: 0, sub_min_price: 0, no_adv: 0, sub_min_adv: 0, no_cap: 0, sub_min_cap: 0 };
  const passed = [];

  for (const raw of rows || []) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const symbol = up(r.symbol);
    if (!symbol) continue;
    const price = num(r.price);
    const adv = num(r.adv_usd);
    const cap = num(r.cap_usd);

    if (price === null) { rejected.no_price++; continue; }
    if (price < minPrice) { rejected.sub_min_price++; continue; }
    if (adv === null) { rejected.no_adv++; continue; }
    if (adv < minAdvUsd) { rejected.sub_min_adv++; continue; }
    if (minCapUsd !== null) {
      if (cap === null) { rejected.no_cap++; continue; }
      if (cap < minCapUsd) { rejected.sub_min_cap++; continue; }
    }
    passed.push({ symbol, name: r.name || null, type: r.type || null, price, adv_usd: adv, cap_usd: cap });
  }

  // Ranking por ADV en dólares desc; desempate por símbolo (estable, determinista).
  passed.sort((a, b) => (b.adv_usd - a.adv_usd) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const selected = passed.slice(0, n);

  return {
    selected,
    symbols: selected.map((s) => s.symbol),
    stats: {
      candidates: (rows || []).length,
      passed_floors: passed.length,
      selected: selected.length,
      rejected,
      thresholds: { n, minPrice, minAdvUsd, minCapUsd },
    },
  };
}

// ── Serializa el array del universo al formato de screener-universe.js ──
// Agrupa en filas de 10 tickers, en el mismo estilo del archivo curado, para
// que el diff del `--write` sea legible.
export function formatUniverseArray(symbols, perLine = 10) {
  const uniq = [...new Set((symbols || []).map(up).filter(Boolean))];
  const lines = [];
  for (let i = 0; i < uniq.length; i += perLine) {
    lines.push('  ' + uniq.slice(i, i + perLine).map((s) => `'${s}'`).join(', ') + ',');
  }
  return lines.join('\n');
}
