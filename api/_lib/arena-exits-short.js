// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-exits-short.js — B7: la RED DETERMINISTA, del lado corto.
//
// Hermano de `_lib/arena-exits.js`, no un reemplazo. Aquel lleva meses
// corriendo sobre libros largos y no se toca: produce las mismas salidas con
// los mismos números. Éste agrega el lado corto con LA MISMA FORMA de salida,
// para que `buildRiskExits` las mezcle sin saber de dónde vino cada una.
//
// Podría haber sido un `if (esCorto)` adentro del otro archivo. No lo es a
// propósito: la red es la única pieza que no se puede apagar, y meterle ramas a
// un módulo que ya funciona es la forma más barata de romper el lado que
// andaba. Acá el lado corto se lee entero y se prueba solo.
//
// ── POR QUÉ LOS NÚMEROS NO SON SIMÉTRICOS ────────────────────────────
//
//     Un largo que sale mal SE ENCOGE. Un corto que sale mal CRECE.
//
// | Red | Largo (vigente) | Corto |
// |---|---|---|
// | Stop catastrófico | −22% desde la entrada | **+20% en contra** |
// | Trailing: ARMA | pico +15% a favor | **el piso llegó a −15%** |
// | Trailing: DISPARA | −8% desde el pico | **+8% desde el piso** |
// | Time stop | 45 días | 45 días (igual: es atención, no riesgo) |
//
// El stop del corto es +20% y no +22% por la asimetría: a 20% en contra la
// posición ya creció de 15% a ~18% del libro, y los dos puntos extra cuestan
// más en un corto que en un largo. No es prudencia decorativa — es que el mismo
// porcentaje de movimiento pesa distinto según de qué lado estés.
//
// ── EL ESPEJO DEL PICO ───────────────────────────────────────────────
// En un largo, "el pico" es el máximo desde la entrada y el trailing protege
// contra la caída. En un corto la dirección favorable es HACIA ABAJO, así que
// lo que hay que recordar es el MÍNIMO desde la entrada, y el trailing protege
// contra el rebote. Usar el máximo acá —o el mismo campo `peak` sin invertir la
// comparación— daría un trailing que dispara cuando la posición VA BIEN.
// ═══════════════════════════════════════════════════════════════

// ── POR QUÉ ESTE MÓDULO NO IMPORTA NADA DE `arena-exits.js` ──────────
// Lo hacía: traía las reglas del lado LARGO y las threadeaba como default de
// `rules` en cada firma... sin leerlas nunca. Los números del lado corto son
// OTROS (SHORT_RULES) justamente porque la asimetría es el punto de todo este
// archivo.
//
// El import era decorativo Y peligroso: al cablear la red corta dentro de
// `buildRiskExits`, `arena-exits.js` pasa a importar ESTE archivo, y el import
// de vuelta cerraba un CICLO. ESM lo resuelve —los `const` de arriba se leen en
// tiempo de LLAMADA, no de evaluación— pero "funciona por cómo ordena el loader
// las TDZ" no es una garantía sobre la que se cuelga la única pieza que no se
// puede apagar. La dependencia va en UNA sola dirección: exits → exits-short.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const up = (s) => String(s || '').trim().toUpperCase();

// Un corto tiene qty NEGATIVA en Alpaca. La cantidad a CUBRIR es el valor
// absoluto. Devuelve 0 para un largo — así un llamador que pase el libro entero
// obtiene solo los cortos, sin tener que filtrar antes.
export function shortQty(position) {
  const q = num(position && position.qty);
  return q != null && q < 0 ? Math.floor(Math.abs(q)) : 0;
}

export const isShort = (p) => shortQty(p) > 0;

export const SHORT_RULES = {
  // +20%, no +22%. Ver el encabezado: a 20% en contra el corto ya creció de 15%
  // a ~18% del libro.
  catastrophic_stop_pct: (() => {
    const v = Number(process.env.ARENA_SHORT_CATASTROPHIC_PCT);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.20;
  })(),
  // El PISO desde la entrada llegó a −15% → arma el trailing.
  trailing_arm_drop: (() => {
    const v = Number(process.env.ARENA_SHORT_TRAILING_ARM);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.15;
  })(),
  // Armado: rebota +8% desde ese piso → cubre. Por construcción NUNCA cubre en
  // pérdida: entrada × 0.85 × 1.08 = entrada × 0.918 — el techo del trailing
  // está siempre POR DEBAJO de la entrada, que en un corto es ganancia.
  trailing_give_back: (() => {
    const v = Number(process.env.ARENA_SHORT_TRAILING_GIVE_BACK);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.08;
  })(),
};

// ── STOP CATASTRÓFICO del corto ──────────────────────────────────────
// Nivel POR ENCIMA de la entrada. Un cierre por encima → cubrir.
export function shortCatastrophicLevel(position, rules = SHORT_RULES, override = null) {
  const sym = up(position && position.symbol);
  if (override && num(override[sym]) != null) return num(override[sym]);
  const entry = num(position && position.avg_entry_price);
  if (entry == null || entry <= 0) return null;
  return entry * (1 + SHORT_RULES.catastrophic_stop_pct);
}

export function planShortCatastrophicStops({ positions = [], closes = {}, rules = SHORT_RULES, stopLevels = null }) {
  const exits = [];
  for (const p of positions) {
    const qty = shortQty(p);
    if (qty < 1) continue;
    const sym = up(p.symbol);
    const level = shortCatastrophicLevel(p, rules, stopLevels);
    const close = num(closes[sym]);
    // Sin nivel o sin cierre NO se dispara a ciegas: un dato faltante no puede
    // cerrar una posición por sorpresa (mismo fail-safe que el lado largo).
    if (level == null || close == null || close <= 0) continue;
    if (close > level) {
      exits.push({
        symbol: sym, qty, side: 'cover', reason_code: 'short_catastrophic_stop',
        stop_level: +level.toFixed(2), close,
        detail: `stop catastrófico del CORTO: cierre ${close} > nivel ${level.toFixed(2)} (entrada ${num(p.avg_entry_price)}, +${(SHORT_RULES.catastrophic_stop_pct * 100).toFixed(0)}% en contra) → cubre ${qty}. Un corto que sale mal crece: su pérdida no tiene techo teórico.`,
      });
    }
  }
  return { exits };
}

// ── TRAILING del corto, con el pico invertido ────────────────────────
// `lows[sym]` = el MÍNIMO cierre desde la entrada, techado a la entrada (el
// espejo de `peaks` del lado largo, que va pisado a la entrada por abajo).
export function shortTrailingState(position, low, rules = SHORT_RULES) {
  const entry = num(position && position.avg_entry_price);
  const piso = num(low);
  if (entry == null || entry <= 0 || piso == null || piso <= 0) return null;
  const armLevel = entry * (1 - SHORT_RULES.trailing_arm_drop);
  const armed = piso <= armLevel;
  const level = piso * (1 + SHORT_RULES.trailing_give_back);   // techo: si el precio SUBE hasta acá, se cubre
  return {
    armed, low: +piso.toFixed(2),
    arm_level: +armLevel.toFixed(2),
    level: +level.toFixed(2),
    gain_at_low_pct: +(((entry - piso) / entry) * 100).toFixed(1),
  };
}

export function planShortTrailingStops({ positions = [], closes = {}, lows = {}, rules = SHORT_RULES }) {
  const exits = [];
  for (const p of positions) {
    const qty = shortQty(p);
    if (qty < 1) continue;
    const sym = up(p.symbol);
    const st = shortTrailingState(p, lows[sym], rules);
    if (!st || !st.armed) continue;
    const close = num(closes[sym]);
    if (close == null || close <= 0) continue;
    if (close >= st.level) {
      exits.push({
        symbol: sym, qty, side: 'cover', reason_code: 'short_trailing_stop',
        stop_level: st.level, close, low: st.low,
        detail: `trailing del CORTO: el mínimo desde la entrada fue ${st.low} (${st.gain_at_low_pct}% a favor, armó bajo ${st.arm_level}) y el cierre ${close} rebotó ≥${(SHORT_RULES.trailing_give_back * 100).toFixed(0)}% desde ese piso (nivel ${st.level}) → cubre ${qty}. Por construcción cubre con ganancia.`,
      });
    }
  }
  return { exits };
}

// ── EL MÍNIMO desde la entrada, derivado de la serie ─────────────────
// Espejo de `peaksFromMeta` del lado largo. Techado a la ENTRADA: si el nombre
// nunca bajó de donde se abrió el corto, el "piso" es la entrada y el trailing
// no arma. Sin ese techo, un corto abierto en un máximo local tendría un piso
// igual al precio de entrada y armaría el trailing por aritmética, no por
// haber ganado nada.
export function lowsFromSeries(positions, seriesBySymbol, opens = {}) {
  const out = {};
  for (const p of positions || []) {
    const qty = shortQty(p);
    if (qty < 1) continue;
    const sym = up(p.symbol);
    const entry = num(p.avg_entry_price);
    const serie = seriesBySymbol && seriesBySymbol[sym];
    if (!serie || !Array.isArray(serie.closes) || !serie.closes.length) continue;
    const desde = opens[sym] || null;
    const cierres = desde && Array.isArray(serie.dates)
      ? serie.closes.filter((_, i) => String(serie.dates[i]).slice(0, 10) >= desde)
      : serie.closes;
    const validos = cierres.filter((c) => Number.isFinite(c) && c > 0);
    if (!validos.length) continue;
    const min = Math.min(...validos);
    out[sym] = entry != null && entry > 0 ? Math.min(min, entry) : min;
  }
  return out;
}

// ── FORCED BUY-IN (R11) ──────────────────────────────────────────────
// Un corto que desaparece del libro SIN una orden nuestra es el broker
// ejecutando un buy-in forzado (se le acabó el préstamo). Eso NO es una
// decisión del PM y no puede journalearse como si lo fuera: contaminaría el
// post-mortem con una "salida" que el modelo nunca eligió.
//
// Se detecta por diferencia: estaba corto ayer, no está hoy, y no hay una orden
// nuestra de cobertura que lo explique.
export function detectForcedBuyIns({ previousShorts = [], currentPositions = [], ourCovers = [] } = {}) {
  const hoy = new Set((currentPositions || []).map((p) => up(p.symbol)));
  const nuestras = new Set((ourCovers || []).map((o) => up(o.symbol || o)));
  const out = [];
  for (const sym of previousShorts.map(up)) {
    if (hoy.has(sym) || nuestras.has(sym)) continue;
    out.push({
      symbol: sym, reason_code: 'forced_buy_in',
      detail: `${sym} estaba corto y ya no está, y no hay una cobertura nuestra que lo explique: es un buy-in forzado del broker (se acabó el préstamo). NO es una decisión del PM y no se cuenta como tal en el post-mortem.`,
    });
  }
  return out;
}
