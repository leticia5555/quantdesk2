// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-exits.js — REGLA DE SALIDA determinista del Arena.
//
// Hermano del guard (arena-guard.js): JS puro, sin I/O, sin LLM. Las
// SALIDAS que NO decide el PM viven aquí — son la red de seguridad del
// libro, no gestión de caídas normales:
//   1. CIRCUIT BREAKER de portafolio (escalonado desde el pico de equity).
//   2. STOP CATASTRÓFICO ANCHO por posición (cierre bajo el nivel → salida).
//
// POR QUÉ DETERMINISTA (no del LLM): la investigación (Kaminski & Lo, JFM
// 2014) muestra que un stop APRETADO por nombre DESTRUYE valor en posiciones
// que revierten a la media — te saca justo cuando la ventaja es mayor. Un
// stop del 10% habría vendido MU en el fondo (-13.1%) el día antes de que
// rebotara a +3.9%. Así que el libro NO usa stops apretados; usa (a) un
// breaker de portafolio (mejor soportado para 8 posiciones que los stops por
// nombre) y (b) un stop por nombre DELIBERADAMENTE ANCHO (~20-25%) que solo
// existe para que un desastre de un solo nombre no destruya el libro.
//
// ── LAS DOS BANDAS (¡no confundir!) ──────────────────────────────────
// El guard valida las ENTRADAS (y las ventas DISCRECIONALES del PM) con la
// banda ±2% (ARENA_RULES.price_band): es un sanity check sobre el anclaje de
// precio del LLM. Una venta PROTECTORA la genera este módulo, NO el LLM, así
// que ese sanity check no aplica: usa EXIT_PRICE_BAND (~12%), un MARKETABLE
// LIMIT ANCHO (limit = referencia × (1 − banda), por DEBAJO del mercado) para
// asegurar el fill acotando el deslizamiento catastrófico. Sigue siendo una
// orden LÍMITE — respeta la regla de la casa (cicatriz Polymarket: JAMÁS
// market orders); la banda ancha existe para salir, no para ser precisa.
// ═══════════════════════════════════════════════════════════════

// ── constantes, configurables por env (time-boxed del trial) ─────────
// Defaults elegidos por la investigación; se pueden ajustar sin tocar código.
// Fracciones en (0,1). El breaker escalonado: delever < broadcut.
function envFrac(name, def) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v <= 0 || v >= 1) return def;
  return v;
}

export const EXIT_RULES = {
  // Circuit breaker de portafolio (desde el PICO de equity):
  breaker_delever_dd: envFrac('ARENA_BREAKER_DELEVER_DD', 0.15), // empieza a desapalancar
  breaker_broadcut_dd: envFrac('ARENA_BREAKER_BROADCUT_DD', 0.20), // corte amplio (análogo del DEATH -20% de la flota)
  breaker_delever_trim: envFrac('ARENA_BREAKER_DELEVER_TRIM', 0.33), // fracción a recortar de cada posición DÉBIL en stage-1
  // Stop catastrófico ANCHO por posición (desde la ENTRADA):
  catastrophic_stop_pct: envFrac('ARENA_CATASTROPHIC_STOP_PCT', 0.22), // ~20-25% — NO gestiona caídas normales
  // Banda del MARKETABLE LIMIT para ventas de riesgo (≠ ±2% de entrada):
  exit_price_band: envFrac('ARENA_EXIT_PRICE_BAND', 0.12),
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
const up = (s) => String(s || '').trim().toUpperCase();

// qty entera larga de una posición ({ qty } de Alpaca, string o número).
function heldQty(position) {
  const q = num(position && position.qty);
  return q && q > 0 ? Math.floor(q) : 0;
}

// ── drawdown desde el pico ───────────────────────────────────────────
// Fracción ≥ 0. peak ≤ 0 (libro nuevo/sin historia) → 0, nunca dispara.
export function computeDrawdown(equity, peak) {
  const e = num(equity), p = num(peak);
  if (p == null || p <= 0 || e == null) return 0;
  return Math.max(0, (p - e) / p);
}

// ── CIRCUIT BREAKER de portafolio (escalonado) ───────────────────────
// Devuelve { stage, drawdown, exits:[{ symbol, qty, reason_code, detail }] }.
//   stage 'broadcut' (dd ≥ broadcut_dd): liquida TODAS las posiciones.
//   stage 'delever'  (dd ≥ delever_dd):  recorta una fracción de cada posición
//                                        DÉBIL (unrealized_plpc < 0). No toca a
//                                        los ganadores — sube efectivo sin nukear.
//   stage 'none':    exits vacío.
// Determinista y auditable; NO confía en el LLM.
export function planBreaker({ equity, peak, positions = [], rules = EXIT_RULES }) {
  const drawdown = computeDrawdown(equity, peak);
  const exits = [];

  if (drawdown >= rules.breaker_broadcut_dd) {
    for (const p of positions) {
      const qty = heldQty(p);
      if (qty < 1) continue;
      exits.push({
        symbol: up(p.symbol), qty, reason_code: 'breaker_broadcut',
        detail: `corte amplio: drawdown ${(drawdown * 100).toFixed(1)}% ≥ ${(rules.breaker_broadcut_dd * 100).toFixed(0)}% desde el pico → liquida ${qty}`,
      });
    }
    return { stage: 'broadcut', drawdown, exits };
  }

  if (drawdown >= rules.breaker_delever_dd) {
    // Solo las DÉBILES (en rojo): recorta `trim` de cada una. Los ganadores
    // se preservan — el objetivo es subir efectivo, no vender la tesis buena.
    const weak = positions
      .map((p) => ({ p, plpc: num(p.unrealized_plpc) }))
      .filter((x) => x.plpc != null && x.plpc < 0)
      .sort((a, b) => a.plpc - b.plpc); // más débil primero
    for (const { p, plpc } of weak) {
      const held = heldQty(p);
      const qty = Math.floor(held * rules.breaker_delever_trim);
      if (qty < 1) continue; // recorte que no alcanza 1 acción → no se ajusta en silencio
      exits.push({
        symbol: up(p.symbol), qty, reason_code: 'breaker_delever',
        detail: `desapalanca: drawdown ${(drawdown * 100).toFixed(1)}% ≥ ${(rules.breaker_delever_dd * 100).toFixed(0)}% desde el pico → recorta ${(rules.breaker_delever_trim * 100).toFixed(0)}% de la débil ${up(p.symbol)} (P&L ${(plpc * 100).toFixed(1)}%): ${qty}/${held}`,
      });
    }
    return { stage: 'delever', drawdown, exits };
  }

  return { stage: 'none', drawdown, exits };
}

// ── nivel del STOP CATASTRÓFICO por posición ─────────────────────────
// FIJO desde la entrada: entry × (1 − pct). Deliberadamente ANCHO. `override`
// (mapa symbol→nivel) permite inyectar un nivel vol-escalado (~3× ATR) en una
// capa futura sin tocar esta firma — el plumbing de high/low aún no existe, así
// que la Capa 1 envía el modo fijo. null si no hay entrada de referencia.
export function catastrophicStopLevel(position, rules = EXIT_RULES, override = null) {
  const sym = up(position && position.symbol);
  if (override && num(override[sym]) != null) return num(override[sym]);
  const entry = num(position && position.avg_entry_price);
  if (entry == null || entry <= 0) return null;
  return entry * (1 - rules.catastrophic_stop_pct);
}

// ── STOP CATASTRÓFICO por posición ───────────────────────────────────
// Regla de ejecución (sistemas de fin de día): CIERRE completo por DEBAJO del
// nivel → vender en la apertura siguiente (el gap es costo inevitable). El
// `close` que entra es el ÚLTIMO CIERRE COMPLETO (misma fuente que valida el
// guard). Salida de la posición ENTERA — el stop ancho no es para recortar.
// Devuelve { exits:[{ symbol, qty, reason_code, detail, stop_level, close }] }.
export function planCatastrophicStops({ positions = [], closes = {}, rules = EXIT_RULES, stopLevels = null }) {
  const exits = [];
  for (const p of positions) {
    const sym = up(p.symbol);
    const qty = heldQty(p);
    if (qty < 1) continue;
    const level = catastrophicStopLevel(p, rules, stopLevels);
    const close = num(closes[sym]);
    // Sin nivel (sin entrada) o sin cierre → no se puede evaluar el stop; NO se
    // dispara a ciegas (fail-safe: un dato faltante no liquida por sorpresa).
    if (level == null || close == null || close <= 0) continue;
    if (close < level) {
      exits.push({
        symbol: sym, qty, reason_code: 'catastrophic_stop', stop_level: +level.toFixed(2), close,
        detail: `stop catastrófico: cierre ${close} < nivel ${level.toFixed(2)} (entrada ${num(p.avg_entry_price)}, −${(rules.catastrophic_stop_pct * 100).toFixed(0)}%) → liquida ${qty}`,
      });
    }
  }
  return { exits };
}

// ── merge de exits deterministas (breaker + stops) ───────────────────
// Un nombre puede caer en más de una regla (débil recortada por el breaker Y
// bajo su stop). Se toma la qty MAYOR (capada a lo que hay), y se combinan los
// reason_codes. El `origin` (para journaling/atribución) es el más severo:
// broadcut > catastrophic_stop > delever.
const SEVERITY = { breaker_broadcut: 3, catastrophic_stop: 2, breaker_delever: 1 };
export function mergeExits(lists, positions = []) {
  const heldBySym = new Map();
  for (const p of positions) { const s = up(p.symbol); if (s) heldBySym.set(s, heldQty(p)); }
  const bySym = new Map();
  for (const list of lists) {
    for (const e of (list || [])) {
      const sym = up(e.symbol);
      if (!sym) continue;
      const prev = bySym.get(sym);
      if (!prev) { bySym.set(sym, { symbol: sym, qty: e.qty, reason_codes: [e.reason_code], details: [e.detail], origin: e.reason_code }); continue; }
      prev.qty = Math.max(prev.qty, e.qty);
      if (!prev.reason_codes.includes(e.reason_code)) prev.reason_codes.push(e.reason_code);
      prev.details.push(e.detail);
      if ((SEVERITY[e.reason_code] || 0) > (SEVERITY[prev.origin] || 0)) prev.origin = e.reason_code;
    }
  }
  // Capa la qty a lo que realmente hay (nunca sobrevende).
  for (const v of bySym.values()) {
    const held = heldBySym.get(v.symbol) ?? v.qty;
    v.qty = Math.min(v.qty, held);
  }
  return [...bySym.values()].filter((v) => v.qty >= 1);
}

// ── referencia de precio para el marketable limit ────────────────────
// Prioridad: cierre completo (misma fuente que el guard) → current_price de
// Alpaca (la posición vive) → avg_entry_price. Así un nombre delisted/ilíquido
// (sin serie Yahoo) IGUAL se puede cerrar mientras Alpaca lo cotice. null solo
// si NO hay ninguna referencia — ahí sí fail closed (no se puede preciar).
export function exitReference(position, closes = {}) {
  const sym = up(position && position.symbol);
  return num(closes[sym]) ?? num(position && position.current_price) ?? num(position && position.avg_entry_price);
}

// limit del marketable-limit: referencia × (1 − banda), por DEBAJO del mercado
// para asegurar el fill. Redondeo a centavos (Alpaca exige tick de $0.01).
export function riskExitLimit(reference, rules = EXIT_RULES) {
  const r = num(reference);
  if (r == null || r <= 0) return null;
  return Math.round(r * (1 - rules.exit_price_band) * 100) / 100;
}

// ── orquestador: estado del libro → órdenes de venta ejecutables ─────
// Entradas: equity/peak (para el breaker), positions (Alpaca), closes (último
// cierre completo por símbolo del libro), rules. Salida:
//   { stage, drawdown, approved:[{ symbol, side:'sell', qty, limit_price,
//     reference, origin, reason_codes, reasoning }], discarded:[{...,reason}] }
// approved lleva `side:'sell'` para que el camino de ejecución sea idéntico al
// del guard. Cada exit journalea reasoning (sintético, verbatim en la card),
// reason_codes y origin — como pide el post-mortem a 30 días.
export function buildRiskExits({ equity, peak, positions = [], closes = {}, rules = EXIT_RULES }) {
  const breaker = planBreaker({ equity, peak, positions, rules });
  // Broadcut domina: no tiene sentido evaluar stops por nombre si se liquida todo.
  const lists = breaker.stage === 'broadcut'
    ? [breaker.exits]
    : [breaker.exits, planCatastrophicStops({ positions, closes, rules }).exits];
  const merged = mergeExits(lists, positions);

  const approved = [];
  const discarded = [];
  for (const e of merged) {
    const pos = positions.find((p) => up(p.symbol) === e.symbol);
    const reference = exitReference(pos, closes);
    const limit_price = riskExitLimit(reference, rules);
    if (limit_price == null) {
      // Sin ninguna referencia de precio → no se puede preciar el marketable
      // limit. Se DESCARTA y se journalea (fail closed, pero RUIDOSO).
      discarded.push({ symbol: e.symbol, qty: e.qty, origin: e.origin, reason_codes: e.reason_codes, reason: `${e.symbol}: sin referencia de precio para el marketable limit — fail closed` });
      continue;
    }
    approved.push({
      symbol: e.symbol, side: 'sell', qty: e.qty, limit_price,
      reference: +Number(reference).toFixed(2),
      origin: e.origin, reason_codes: e.reason_codes,
      reasoning: e.details.join(' | ').slice(0, 600),
    });
  }
  return { stage: breaker.stage, drawdown: breaker.drawdown, approved, discarded };
}
