// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-exits.js — REGLA DE SALIDA determinista del Arena.
//
// Hermano del guard (arena-guard.js): JS puro, sin I/O, sin LLM. Las
// SALIDAS que NO decide el PM viven aquí — son la red de seguridad del
// libro, no gestión de caídas normales:
//   1. CIRCUIT BREAKER de portafolio (escalonado desde el pico de equity).
//   2. STOP CATASTRÓFICO ANCHO por posición (cierre bajo el nivel → salida).
//   3. TRAILING STOP de GANANCIA (T2, 2026-09-13): pico ≥ +15% desde la entrada
//      ARMA un trailing del 8% sobre ese pico. Ver la nota en EXIT_RULES: por
//      construcción nunca vende en pérdida, así que NO es el stop apretado que
//      Kaminski & Lo desaconsejan — es lo contrario, evita que una ganadora
//      vuelva a plano sin que nadie decida nada.
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
// Entero positivo (días). Inválido → default, en silencio (mismo criterio que envFrac).
function envInt(name, def) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) return def;
  return v;
}

export const EXIT_RULES = {
  // Circuit breaker de portafolio (desde el PICO de equity):
  breaker_delever_dd: envFrac('ARENA_BREAKER_DELEVER_DD', 0.15), // empieza a desapalancar
  breaker_broadcut_dd: envFrac('ARENA_BREAKER_BROADCUT_DD', 0.20), // corte amplio (análogo del DEATH -20% de la flota)
  breaker_delever_trim: envFrac('ARENA_BREAKER_DELEVER_TRIM', 0.33), // fracción a recortar PRO-RATA de CADA posición en stage-1
  // Stop catastrófico ANCHO por posición (desde la ENTRADA):
  catastrophic_stop_pct: envFrac('ARENA_CATASTROPHIC_STOP_PCT', 0.22), // ~20-25% — NO gestiona caídas normales
  // ── DOS bandas del MARKETABLE LIMIT (≠ ±2% de entrada) ──
  // El límite en una venta protectora NO busca buen precio: evita un fill
  // absurdo tipo flash crash. Por eso son ANCHAS, y hay DOS:
  //   - breaker (12%): desapalancamiento de portafolio, gap por-nombre menor.
  //   - catastrophic (32%): emergencia de UN nombre — TIENE que llenar; un
  //     límite 32% abajo del cierre llena en cualquier gap realista.
  exit_band_breaker: envFrac('ARENA_EXIT_BAND_BREAKER', 0.12),
  exit_band_catastrophic: envFrac('ARENA_EXIT_BAND_CATASTROPHIC', 0.32),
  // ESCALAMIENTO: si un stop catastrófico NO llenó (gap peor que la banda), la
  // próxima corrida lo re-emite MÁS abajo (banda += step por reintento fallido),
  // con tope exit_band_max. El intento fallido queda journaleado para medirlo.
  exit_escalation_step: envFrac('ARENA_EXIT_ESCALATION_STEP', 0.13),
  exit_band_max: envFrac('ARENA_EXIT_BAND_MAX', 0.70),
  // ── TEMPORADA 2 (2026-09-13) ──
  // TRAILING STOP (regla T2 #3). NO contradice el hallazgo Kaminski & Lo: no es
  // un stop apretado sobre una posición perdedora, es protección de GANANCIA. Se
  // ARMA solo cuando el pico desde la entrada llegó a +15%, y entonces sale si
  // devuelve 8% desde ESE pico. Por construcción NUNCA vende en pérdida:
  // entrada × 1.15 × 0.92 = entrada × 1.058 — el piso del trailing está siempre
  // ARRIBA de la entrada. Lo que mata es el otro caso (stop apretado sobre una
  // posición que revierte); éste es el caso que el libro estaba perdiendo:
  // ganadoras que subían 20% y volvían a plano sin que el PM se pronunciara.
  trailing_arm_gain: envFrac('ARENA_TRAILING_ARM_GAIN', 0.15),   // pico ≥ +15% desde la entrada → ARMA
  trailing_give_back: envFrac('ARENA_TRAILING_GIVE_BACK', 0.08), // armado: devuelve 8% del pico → SALE
  // Banda del marketable limit del trailing: salida ORDENADA de un nombre (no
  // emergencia como el catastrófico, no desapalancamiento como el breaker).
  // NO escala: si no llena, la corrida siguiente lo re-evalúa con el cierre
  // nuevo y lo re-emite — el nivel se mueve con el pico, no con los intentos.
  exit_band_trailing: envFrac('ARENA_EXIT_BAND_TRAILING', 0.12),
  // TIME STOP (regla T2 #4). NO vende: OBLIGA A PRONUNCIARSE. A los 45 días una
  // tesis que no se movió es una tesis muerta o una que el PM ya no recuerda;
  // la regla lo fuerza a decir hold/trim/exit con razón (el pronunciamiento lo
  // audita _lib/arena-memory.js, no este módulo). Días CALENDARIO desde la
  // apertura de la posición — no sesiones: es una regla de atención, no de
  // ejecución, y el calendario es lo que el PM lee.
  time_stop_days: envInt('ARENA_TIME_STOP_DAYS', 45),
};

// Banda del marketable limit según la NATURALEZA de la salida + escalamiento.
// Catastrófico (emergencia de un nombre) → banda ancha que ESCALA con cada
// reintento fallido. Trailing (T2: protección de ganancia, salida ordenada de UN
// nombre) → su propia banda, SIN escalamiento. Breaker (delever/broadcut,
// desapalancamiento ordenado) → banda fija más angosta. Cap en exit_band_max.
// Precedencia cuando un nombre cae en varias reglas: catastrófico > trailing >
// breaker (la más severa manda, igual que SEVERITY en mergeExits).
export function exitBand(reasonCodes, rules = EXIT_RULES, escalationAttempts = 0) {
  const codes = reasonCodes || [];
  if (codes.includes('catastrophic_stop')) {
    const escalated = rules.exit_band_catastrophic + Math.max(0, escalationAttempts) * rules.exit_escalation_step;
    return Math.round(Math.min(escalated, rules.exit_band_max) * 10000) / 10000; // sin ruido FP en el journal
  }
  if (codes.includes('trailing_stop')) return rules.exit_band_trailing;
  return rules.exit_band_breaker;
}

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
    // PRO-RATA en TODAS las posiciones: recorta la misma fracción de cada una.
    // NO se venden "los perdedores" (eso es una apuesta direccional que la
    // evidencia —Kaminski & Lo— dice que sale mal en un libro de reversión, y
    // que MU refutó en vivo: −13% y al día siguiente +19%). El objetivo del
    // delever es BAJAR EXPOSICIÓN, no adivinar cuál rebota: menos de todo, sin
    // apostar a nada.
    for (const p of positions) {
      const held = heldQty(p);
      const qty = Math.floor(held * rules.breaker_delever_trim);
      if (qty < 1) continue; // recorte que no alcanza 1 acción → no se ajusta en silencio
      exits.push({
        symbol: up(p.symbol), qty, reason_code: 'breaker_delever',
        detail: `desapalanca PRO-RATA: drawdown ${(drawdown * 100).toFixed(1)}% ≥ ${(rules.breaker_delever_dd * 100).toFixed(0)}% desde el pico → recorta ${(rules.breaker_delever_trim * 100).toFixed(0)}% de ${up(p.symbol)} (${qty}/${held}), sin apostar a cuál rebota`,
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

// ── TRAILING STOP (T2 #3): protección de GANANCIA, no stop apretado ──
// Estado del trailing de UNA posición, a partir del PICO de precio desde la
// entrada (`peak`, que deriva _lib/arena-memory.js de la serie diaria acotada
// por la fecha de apertura). Devuelve SIEMPRE la misma forma para que el mismo
// cálculo alimente (a) la decisión determinista de salir y (b) el bloque que el
// PM ve en el prompt — un solo número, sin que el modelo haga aritmética:
//   { armed, arm_level, level, peak, gain_at_peak_pct, from_peak_pct }
// `armed` es false mientras el pico no haya llegado a entrada×(1+arm_gain): sin
// armar NO hay salida por trailing (ahí es donde un stop apretado destruiría
// valor). `level` es null mientras no esté armado.
// null si falta la entrada o el pico (fail-safe: sin dato no se dispara nada).
export function trailingState(position, peak, rules = EXIT_RULES) {
  const entry = num(position && position.avg_entry_price);
  const pk = num(peak);
  if (entry == null || entry <= 0 || pk == null || pk <= 0) return null;
  const arm_level = entry * (1 + rules.trailing_arm_gain);
  const armed = pk >= arm_level;
  const current = num(position && position.current_price);
  return {
    armed,
    peak: +pk.toFixed(2),
    arm_level: +arm_level.toFixed(2),
    level: armed ? +(pk * (1 - rules.trailing_give_back)).toFixed(2) : null,
    gain_at_peak_pct: +(((pk - entry) / entry) * 100).toFixed(1),
    from_peak_pct: current != null && current > 0 ? +(((current - pk) / pk) * 100).toFixed(1) : null,
  };
}

// Salidas por trailing: por cada posición ARMADA cuyo último cierre COMPLETO
// cayó a `level` o por debajo → vender la posición ENTERA en la apertura
// siguiente (misma regla de ejecución de fin de día que el stop catastrófico).
// `peaks` es { SYMBOL: pico_desde_la_entrada }. Sin pico o sin cierre → no se
// evalúa (fail-safe: un dato faltante NO liquida por sorpresa).
export function planTrailingStops({ positions = [], closes = {}, peaks = {}, rules = EXIT_RULES }) {
  const exits = [];
  for (const p of positions) {
    const sym = up(p.symbol);
    const qty = heldQty(p);
    if (qty < 1) continue;
    const st = trailingState(p, peaks[sym], rules);
    if (!st || !st.armed) continue;
    const close = num(closes[sym]);
    if (close == null || close <= 0) continue;
    if (close <= st.level) {
      exits.push({
        symbol: sym, qty, reason_code: 'trailing_stop', stop_level: st.level, close, peak: st.peak,
        detail: `trailing stop: el pico desde la entrada fue ${st.peak} (+${st.gain_at_peak_pct}%, armó sobre ${st.arm_level}) y el cierre ${close} devolvió ≥${(rules.trailing_give_back * 100).toFixed(0)}% de ese pico (nivel ${st.level}) → liquida ${qty} con ganancia, no la deja volver a plano`,
      });
    }
  }
  return { exits };
}

// ── TIME STOP (T2 #4): NO vende — obliga a pronunciarse ──────────────
// Estado por posición para el prompt y la auditoría: { days, limit, due }.
// `days` = días CALENDARIO desde la apertura (null si no se pudo reconstruir la
// fecha de apertura → `due` false: nunca se exige sobre un dato que no existe).
export function timeStopState(daysInPosition, rules = EXIT_RULES) {
  // OJO: `num(null)` daría 0 (Number(null) === 0) y el prompt leería "0 días en
  // posición" para una posición cuya apertura NO se pudo reconstruir — un cero
  // que parece un hecho. Un dato ausente se queda en null.
  const d = daysInPosition == null ? null : num(daysInPosition);
  return { days: d, limit: rules.time_stop_days, due: d != null && d >= rules.time_stop_days };
}

// ── merge de exits deterministas (breaker + stops) ───────────────────
// Un nombre puede caer en más de una regla (débil recortada por el breaker Y
// bajo su stop). Se toma la qty MAYOR (capada a lo que hay), y se combinan los
// reason_codes. El `origin` (para journaling/atribución) es el más severo:
// broadcut > catastrophic_stop > delever.
const SEVERITY = { breaker_broadcut: 4, catastrophic_stop: 3, trailing_stop: 2, breaker_delever: 1 };
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
// para asegurar el fill. `band` ya resuelto (por naturaleza + escalamiento, ver
// exitBand). Redondeo a centavos (Alpaca exige tick de $0.01).
export function riskExitLimit(reference, band) {
  const r = num(reference), bnd = num(band);
  if (r == null || r <= 0 || bnd == null || bnd < 0 || bnd >= 1) return null;
  return Math.round(r * (1 - bnd) * 100) / 100;
}

// ── orquestador: estado del libro → órdenes de venta ejecutables ─────
// Entradas: equity/peak (para el breaker), positions (Alpaca), closes (último
// cierre completo por símbolo del libro), rules. Salida:
//   { stage, drawdown, approved:[{ symbol, side:'sell', qty, limit_price,
//     reference, origin, reason_codes, reasoning }], discarded:[{...,reason}] }
// approved lleva `side:'sell'` para que el camino de ejecución sea idéntico al
// del guard. Cada exit journalea reasoning (sintético, verbatim en la card),
// reason_codes y origin — como pide el post-mortem a 30 días.
// `escalation` (symbol → # de reintentos catastróficos fallidos previos) ensancha
// la banda del stop de ese nombre (ver exitBand) — el caller lo deriva del journal.
export function buildRiskExits({ equity, peak, positions = [], closes = {}, rules = EXIT_RULES, escalation = {}, peaks = {} }) {
  const breaker = planBreaker({ equity, peak, positions, rules });
  // Broadcut domina: no tiene sentido evaluar stops por nombre si se liquida todo.
  const lists = breaker.stage === 'broadcut'
    ? [breaker.exits]
    : [
      breaker.exits,
      planCatastrophicStops({ positions, closes, rules }).exits,
      // T2 #3: el trailing corre junto a los otros por-nombre. `peaks` vacío
      // (sin memoria de picos) → lista vacía, comportamiento idéntico al de T1.
      planTrailingStops({ positions, closes, peaks, rules }).exits,
    ];
  const merged = mergeExits(lists, positions);

  const approved = [];
  const discarded = [];
  for (const e of merged) {
    const pos = positions.find((p) => up(p.symbol) === e.symbol);
    const reference = exitReference(pos, closes);
    const attempts = Math.max(0, Number(escalation[e.symbol]) || 0);
    const band = exitBand(e.reason_codes, rules, attempts);
    const limit_price = riskExitLimit(reference, band);
    if (limit_price == null) {
      // Sin ninguna referencia de precio → no se puede preciar el marketable
      // limit. Se DESCARTA y se journalea (fail closed, pero RUIDOSO).
      discarded.push({ symbol: e.symbol, qty: e.qty, origin: e.origin, reason_codes: e.reason_codes, reason: `${e.symbol}: sin referencia de precio para el marketable limit — fail closed` });
      continue;
    }
    const escNote = attempts > 0 ? `[reintento ${attempts + 1}, banda ${(band * 100).toFixed(0)}% tras ${attempts} sin llenar] ` : '';
    approved.push({
      symbol: e.symbol, side: 'sell', qty: e.qty, limit_price,
      reference: +Number(reference).toFixed(2),
      origin: e.origin, reason_codes: e.reason_codes,
      exit_band: band, exit_attempt: attempts + 1, // journaleados: mide con qué frecuencia no llena
      reasoning: (escNote + e.details.join(' | ')).slice(0, 600),
    });
  }
  return { stage: breaker.stage, drawdown: breaker.drawdown, approved, discarded };
}
