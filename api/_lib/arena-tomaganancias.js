// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-tomaganancias.js — LA CAPA DE TOMA DE GANANCIAS.
//
// Pregunta: ¿qué habría pasado si cada agente vendiera TODO al llegar a +X% en
// el día y se quedara en efectivo hasta el cierre?
//
// Mismas decisiones, resultado alternativo. No toca la liga: lee la serie de
// equity intradía que ya se guarda y calcula una contrafactual.
//
// ── LO QUE ESTO ES Y LO QUE NO ──────────────────────────────────────
// ES: una comparación honesta entre "lo que pasó" y "lo que habría pasado con
// una regla mecánica encima", sobre los MISMOS datos.
//
// NO ES: un backtest. Un backtest tiene costos, slippage y un modelo de
// ejecución. Esto asume que vender el libro entero al tocar el umbral se
// ejecuta AL EQUITY DE ESA MUESTRA, sin costo. Eso es optimista, y el sesgo va
// SIEMPRE a favor de la regla — que es la dirección peligrosa, porque hace
// parecer mejor de lo que es a la estrategia que se está evaluando.
//
// ── LA RESOLUCIÓN DECIDE QUÉ SE PUEDE AFIRMAR ───────────────────────
// La serie se muestrea cada ~5 min. El umbral se evalúa contra MUESTRAS:
//
//   · si una muestra llegó a +X%, la regla habría disparado → eso es un HECHO
//   · si NINGUNA muestra llegó, el equity pudo haber tocado +X% entre dos
//     muestras y haber vuelto → eso es un NO SÉ, no un "no pasó"
//
// O sea que el conteo de disparos es un PISO. Cada resultado viaja con sus
// muestras y con esa advertencia, porque la conclusión "la regla no habría
// servido" es exactamente la que el muestreo no permite sacar.
//
// ENV VARS: ninguna. Es una función pura sobre la serie.
// ═══════════════════════════════════════════════════════════════

// El umbral por defecto. Parametrizable en la llamada y en el endpoint: el
// punto del ejercicio es barrer varios y ver la forma, no defender uno.
export const UMBRAL_DEFAULT = 0.02;   // +2% sobre la apertura del día

// ── UNA CORRIDA DE LA REGLA SOBRE UN DÍA DE UN AGENTE ────────────────
// `serie` = la salida de `serieDe()` en arena-equity: {puntos[], apertura, …}.
//
// La regla: desde la apertura, en la PRIMERA muestra cuyo equity toque
// `apertura × (1 + umbral)`, se vende todo y se queda en efectivo. A partir de
// ahí el equity de la contrafactual es constante hasta el cierre.
export function simularUmbral(serie, { umbral = UMBRAL_DEFAULT } = {}) {
  const puntos = (serie && serie.puntos) || [];
  const apertura = serie && serie.apertura ? Number(serie.apertura.equity) : NaN;

  if (!puntos.length || !Number.isFinite(apertura) || apertura <= 0) {
    return { aplicable: false, motivo: 'sin serie de equity para este día', muestras: puntos.length };
  }

  const objetivo = apertura * (1 + umbral);
  const real = Number(puntos[puntos.length - 1].equity);

  const idx = puntos.findIndex((p) => Number(p.equity) >= objetivo);
  if (idx === -1) {
    return {
      aplicable: true, disparo: false,
      umbral, apertura, objetivo: +objetivo.toFixed(2),
      equity_real: real, equity_con_regla: real,
      diferencia: 0, diferencia_pct: 0,
      muestras: puntos.length,
      // El límite del muestreo, dicho donde se lee la conclusión.
      nota: `Ninguna de las ${puntos.length} muestras del día tocó ${(umbral * 100).toFixed(1)}%. Con muestreo cada ~5 min eso NO prueba que el equity nunca llegó: pudo tocarlo entre dos muestras y volver. Es un "no lo vimos", no un "no pasó".`,
    };
  }

  const p = puntos[idx];
  const conRegla = Number(p.equity);
  const dif = +(conRegla - real).toFixed(2);
  return {
    aplicable: true, disparo: true,
    umbral, apertura, objetivo: +objetivo.toFixed(2),
    // Cuándo y a cuánto habría salido.
    disparo_ts: p.ts, disparo_equity: conRegla,
    // Cuántas muestras quedaban después: si disparó en la última, la regla no
    // cambió nada y decir "ganó 0" sería contar un acierto que no ocurrió.
    muestras_despues: puntos.length - idx - 1,
    equity_real: real,
    equity_con_regla: conRegla,
    diferencia: dif,
    diferencia_pct: real > 0 ? +((dif / real) * 100).toFixed(3) : null,
    muestras: puntos.length,
    lectura: dif > 0
      ? `Habría salido a las ${String(p.ts).slice(11, 16)} con $${conRegla.toFixed(0)} y el día cerró en $${real.toFixed(0)}: la regla gana $${dif.toFixed(0)}.`
      : dif < 0
        ? `Habría salido a las ${String(p.ts).slice(11, 16)} con $${conRegla.toFixed(0)} y el día siguió hasta $${real.toFixed(0)}: la regla cuesta $${Math.abs(dif).toFixed(0)}.`
        : 'La regla habría disparado en la última muestra del día: no cambió nada.',
  };
}

// ── EL BARRIDO ──────────────────────────────────────────────────────
// Un solo umbral es una anécdota. La forma de la curva —a partir de qué nivel
// la regla deja de ayudar— es lo que se puede mirar.
export function barrer(serie, { umbrales = [0.01, 0.015, 0.02, 0.03, 0.05] } = {}) {
  return umbrales.map((u) => ({ umbral: u, ...simularUmbral(serie, { umbral: u }) }));
}

// ── EL AGREGADO DE UN DÍA, POR AGENTE ───────────────────────────────
// `porAgente` = { id: serieDe(...) }.
export function simularDia(porAgente = {}, { umbral = UMBRAL_DEFAULT } = {}) {
  const filas = [];
  for (const [id, serie] of Object.entries(porAgente)) {
    filas.push({ agente: id, ...simularUmbral(serie, { umbral }) });
  }
  filas.sort((a, b) => (b.diferencia || 0) - (a.diferencia || 0));

  const aplicables = filas.filter((f) => f.aplicable);
  const dispararon = aplicables.filter((f) => f.disparo);
  const suma = +aplicables.reduce((s, f) => s + (f.diferencia || 0), 0).toFixed(2);

  return {
    umbral,
    agentes: filas.length,
    con_serie: aplicables.length,
    dispararon: dispararon.length,
    // El neto en dólares sobre los agentes que tienen serie. NO es un retorno:
    // sumar dólares de siete cuentas con baselines distintos no es una media
    // de nada, es un total — y así se nombra.
    diferencia_total_usd: suma,
    mejor: filas[0] && filas[0].aplicable ? { agente: filas[0].agente, diferencia: filas[0].diferencia } : null,
    peor: aplicables.length ? { agente: aplicables[aplicables.length - 1].agente, diferencia: aplicables[aplicables.length - 1].diferencia } : null,
    filas,
    advertencia: 'Contrafactual sin costos ni slippage: asume que vender el libro entero al tocar el umbral se ejecuta al equity de esa muestra. El sesgo va SIEMPRE a favor de la regla. Y los disparos son un PISO: el muestreo cada ~5 min no ve lo que pasó entre dos muestras.',
  };
}
