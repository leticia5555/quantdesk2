// ═══════════════════════════════════════════════════════════════════════
// qd-pesos.js — EL RENDIMIENTO EN PESOS
//
// El encargo (R2): "en MXN, el % de todo activo en dólares se recalcula con la
// serie USD/MXN del mismo periodo. En cuadros: número grande = en pesos, chico
// = local. Etiqueta visible 'rendimiento en pesos'".
//
// Lo que se convierte NO es el precio: es el RENDIMIENTO. Un mexicano que
// compró el S&P gana lo que subió el índice MÁS lo que subió el dólar contra
// su peso, y las dos cosas se multiplican, no se suman:
//
//     r_pesos = (1 + r_local) × (1 + r_moneda/MXN) − 1
//
// Sumarlas es el error clásico y se nota en cuanto los números son grandes:
// +20% del índice con +10% del dólar no es +30%, es +32%. El término cruzado
// (0.20 × 0.10 = 2 puntos) es rendimiento real, no redondeo.
//
// ── UNA SOLA CALCULADORA, TAMBIÉN ACÁ ─────────────────────────────────
// La regla 1 dice que todo % sale de `qdPeriodChange`. Así que esta función
// NO toca series ni precios: recibe DOS rendimientos ya calculados con esa
// función —el del activo y el de su moneda contra el peso, del MISMO periodo—
// y los compone. Si compusiera desde precios habría dos implementaciones del
// ancla del periodo, que es exactamente el bug que la regla 1 previene.
//
// ── EL CRUCE, CUANDO LA MONEDA NO ES EL DÓLAR ─────────────────────────
// El Nikkei está en yenes y no existe una serie JPY/MXN: se arma con las dos
// que sí hay. Yahoo da `JPY=X` como USD/JPY (yenes por dólar) y Banxico da el
// FIX como MXN/USD (pesos por dólar), así que
//
//     r_JPY/MXN = (1 + r_USD/MXN) / (1 + r_USD/JPY) − 1
//
// El dólar se cancela. Y cuando el cruce NO se puede armar —del FTSE en libras
// no tenemos GBP— el rendimiento en pesos es **null con causa**, nunca el
// local disfrazado ni una estimación: regla 2.
// ═══════════════════════════════════════════════════════════════════════

// `Number(null)` es 0 y `Number('')` TAMBIÉN es 0. Con el guardia ingenuo, un
// rendimiento ausente entraba como "no se movió" —una afirmación— donde lo que
// hay es una ausencia: `rendimientoEnPesos(null, 10)` devolvía +10% como si el
// activo hubiera estado plano. Quinta vez que esta coerción cuesta un bug en
// este proyecto, y la primera que una prueba la caza antes de subirla.
const numPesos = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** La etiqueta que el encargo pide que se vea. No se abrevia. */
const ETIQUETA_PESOS = 'rendimiento en pesos';

/**
 * Compone el rendimiento en pesos a partir de dos rendimientos en POR CIENTO.
 *
 * Los dos entran como los devuelve `qdPeriodChange` (porcentaje: 20 = +20%) y
 * el resultado sale en la misma unidad. Un rendimiento de −100% (un activo a
 * cero) es válido y da −100%; cualquiera de los dos ausente devuelve null con
 * su motivo, porque un rendimiento a medias no es un rendimiento.
 */
function rendimientoEnPesos(pctLocal, pctMonedaMxn) {
  const rl = numPesos(pctLocal);
  const rm = numPesos(pctMonedaMxn);
  if (rl == null) return { pct: null, motivo: 'falta el rendimiento local del activo' };
  if (rm == null) return { pct: null, motivo: 'falta el rendimiento de la moneda contra el peso' };
  const pct = ((1 + rl / 100) * (1 + rm / 100) - 1) * 100;
  return {
    pct,
    // Los dos sumandos viajan para poder auditar el número sin recalcularlo:
    // el cruzado es el que la suma ingenua se come.
    local_pct: rl,
    moneda_pct: rm,
    cruzado_pct: pct - rl - rm,
    motivo: null,
  };
}

/**
 * El rendimiento de una moneda contra el peso, en el mismo periodo.
 *
 * `usdMxnPct` es el rendimiento del FIX (pesos por dólar). `usdPorUnidadPct`
 * es el rendimiento de la serie estilo `JPY=X` (unidades de esa moneda por
 * dólar) y sólo hace falta cuando la moneda no es USD ni MXN.
 *
 * Los tres casos, y ninguno se adivina:
 *   - MXN  → 0 por definición: el peso contra el peso no se mueve.
 *   - USD  → el rendimiento del FIX, tal cual.
 *   - otra → se arma con el FIX y la serie de esa moneda contra el dólar.
 */
function cruceContraPeso(moneda, { usdMxnPct, usdPorUnidadPct } = {}) {
  const m = String(moneda || '').toUpperCase();
  if (!m) return { pct: null, motivo: 'el activo no declara en qué moneda cotiza' };
  if (m === 'MXN') return { pct: 0, via: 'mxn_es_el_peso', motivo: null };

  const fix = numPesos(usdMxnPct);
  if (fix == null) return { pct: null, via: null, motivo: 'no hay rendimiento del FIX USD/MXN para este periodo' };
  if (m === 'USD') return { pct: fix, via: 'fix', motivo: null };

  const u = numPesos(usdPorUnidadPct);
  if (u == null) {
    return {
      pct: null, via: null,
      motivo: `no hay serie ${m}/USD para armar el cruce contra el peso en este periodo`,
    };
  }
  // (1 + r_USD/MXN) / (1 + r_USD/moneda) − 1. Si la moneda se devaluó contra el
  // dólar tanto como el peso, el cruce es ~0 y el rendimiento en pesos es el
  // local: eso es correcto, no un error.
  if (1 + u / 100 === 0) return { pct: null, via: null, motivo: `la serie ${m}/USD pasa por cero y el cruce no se puede despejar` };
  const pct = ((1 + fix / 100) / (1 + u / 100) - 1) * 100;
  return { pct, via: `fix÷${m}usd`, motivo: null };
}

/**
 * El paquete completo para un activo: local, en pesos, y de dónde salió cada
 * mitad. `fix` describe el dato de Banxico que se usó, y viaja SIEMPRE para
 * que cada número en pesos pueda decir qué FIX usó y de qué fecha (regla 3).
 */
function enPesos({ pctLocal, moneda, usdMxnPct, usdPorUnidadPct, fix = null } = {}) {
  const cruce = cruceContraPeso(moneda, { usdMxnPct, usdPorUnidadPct });
  if (cruce.pct == null) {
    return {
      pct: null, local_pct: numPesos(pctLocal), moneda: String(moneda || '').toUpperCase() || null,
      etiqueta: ETIQUETA_PESOS, fuente: null, motivo: cruce.motivo,
    };
  }
  const r = rendimientoEnPesos(pctLocal, cruce.pct);
  return {
    ...r,
    moneda: String(moneda || '').toUpperCase(),
    via: cruce.via,
    etiqueta: ETIQUETA_PESOS,
    // La procedencia del número, no un adorno: dice QUÉ FIX y DE QUÉ DÍA.
    fuente: r.pct == null ? null
      : (fix && fix.fecha ? `calc: banxico:${fix.serie || 'SF43718'} (FIX del ${fix.fecha})` : 'calc: banxico:SF43718 (FIX sin fecha declarada)'),
    fix_fecha: fix && fix.fecha ? fix.fecha : null,
    fix_valor: fix && numPesos(fix.valor) != null ? numPesos(fix.valor) : null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ETIQUETA_PESOS, rendimientoEnPesos, cruceContraPeso, enPesos };
}
