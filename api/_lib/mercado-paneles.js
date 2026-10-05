// ═══════════════════════════════════════════════════════════════════════
// api/_lib/mercado-paneles.js — "esta semana" y la tarjeta de Arena, puras.
//
// No abre Neon ni pide red: recibe lo que las fuentes contestaron y arma lo que
// la pantalla pinta. Se prueba con fixtures.
//
// POR QUÉ UNA FUENTE CAÍDA NO ES UNA LISTA VACÍA. Las dos mitades de "esta
// semana" vienen de sitios distintos —el calendario macro es una tabla curada
// en Neon y los reportes salen de Finnhub— y cada una se cae por su cuenta. Si
// las dos se funden en una lista, un Finnhub en 429 se lee igual que "no hay
// reportes esta semana", y la semana de resultados más cargada del trimestre
// aparecería como una pantalla tranquila. Cada mitad trae su propio estado.
// ═══════════════════════════════════════════════════════════════════════

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** La ventana de "esta semana": de hoy a hoy+N, en fechas ISO. */
export const DIAS_SEMANA = 7;

/**
 * Hasta dónde se PIDE, que no es lo mismo que hasta dónde se PINTA.
 *
 * `/api/earnings` sin fechas ya trae 30 días, y el calendario macro se pide con
 * el mismo horizonte a propósito: así las dos mitades se miden igual y la
 * pantalla puede decir "sin reportes esta semana · 9 más adelante" en vez de
 * tirar nueve filas en silencio, que es lo que hacía.
 */
export const DIAS_HORIZONTE = 30;

export function ventanaSemana(ahora = new Date(), dias = DIAS_SEMANA) {
  const hoy = ahora.toISOString().slice(0, 10);
  const fin = new Date(Date.parse(`${hoy}T12:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
  return { desde: hoy, hasta: fin, dias };
}

/**
 * Macro + reportes en una sola línea de tiempo, ordenada por día.
 *
 * Las dos fuentes entran como `{ filas, error }`. Un `error` no se traga: sale
 * en `fuentes` con su texto, y la pantalla lo dice en vez de enseñar un hueco.
 *
 * LA HORA VA EN CT, que es lo que pide el encargo, y por eso los reportes
 * conservan su `BMO`/`AMC` en lugar de inventarles una hora: "antes de la
 * apertura" es un hecho del calendario, y "08:00 CT" sería una hora que
 * Finnhub no dio. Un `TBD` se dice TBD.
 */
export function armaEstaSemana({ macro = {}, reportes = {}, ahora = new Date(), dias = DIAS_SEMANA,
  horizonte = DIAS_HORIZONTE } = {}) {
  const v = ventanaSemana(ahora, dias);
  const dentro = (f) => {
    const d = String(f || '').slice(0, 10);
    return d >= v.desde && d <= v.hasta;
  };
  const despues = (f) => String(f || '').slice(0, 10) > v.hasta;

  const eventos = [];
  let macroDespues = 0;
  let reportesDespues = 0;

  for (const e of (macro.filas || [])) {
    if (despues(e.event_date)) { macroDespues++; continue; }
    if (!dentro(e.event_date)) continue;
    eventos.push({
      tipo: 'macro',
      fecha: String(e.event_date).slice(0, 10),
      titulo: e.title || '',
      detalle: e.note || null,
      importancia: e.importance || null,
      categoria: e.category || null,
      fuente: 'neon:macro_events',
    });
  }
  for (const r of (reportes.filas || [])) {
    if (despues(r.date)) { reportesDespues++; continue; }
    if (!dentro(r.date)) continue;
    eventos.push({
      tipo: 'reporte',
      fecha: String(r.date).slice(0, 10),
      titulo: r.ticker || '',
      detalle: r.company || null,
      // BMO/AMC/TBD tal cual: es lo que la fuente afirma.
      cuando: r.time || 'TBD',
      eps_estimado: num(r.eps_est),
      fuente: 'finnhub:earnings-calendar',
    });
  }

  eventos.sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
    // Macro antes que reportes el mismo día: un dato de la Fed mueve todo y un
    // reporte mueve un ticker.
    if (a.tipo !== b.tipo) return a.tipo === 'macro' ? -1 : 1;
    return String(a.titulo).localeCompare(String(b.titulo));
  });

  return {
    ventana: v,
    eventos,
    // POR SEPARADO, nunca fundidas: ver la cabecera del archivo.
    fuentes: {
      macro: estadoFuente(macro, 'neon:macro_events', macroDespues, horizonte),
      reportes: estadoFuente(reportes, 'finnhub:earnings-calendar', reportesDespues, horizonte),
    },
  };
}

// La FRASE que acompaña a cada mitad no vive acá: está en `qd-tablas.js`, con
// las de las tablas. Este módulo corre en el servidor (ESM) y el navegador no
// lo puede cargar; además el reparto ya era ése — el servidor manda HECHOS y la
// pantalla arma la oración, igual que con `faltanteDeTabla`.

function estadoFuente(f, nombre, masAdelante = 0, horizonte = DIAS_HORIZONTE) {
  if (f && f.error) {
    return { fuente: nombre, ok: false, motivo: String(f.error), filas: 0, en_ventana: 0, mas_adelante: 0, horizonte_dias: horizonte };
  }
  const n = (f && f.filas ? f.filas.length : 0);
  return {
    fuente: nombre, ok: true, motivo: null,
    // `filas` es lo que la fuente DEVOLVIÓ y `en_ventana` lo que se pinta. Que
    // sean distintos es información, no un descuadre: es la respuesta a "¿dónde
    // se perdieron los 9?".
    filas: n,
    en_ventana: n - masAdelante,
    mas_adelante: masAdelante,
    // Hasta dónde se miró: sin esto, "no hay nada" no dice "nada ¿hasta cuándo?".
    horizonte_dias: horizonte,
  };
}

/**
 * La tarjeta de Arena. El encargo fija el shape de entrada: `{agents:[…]}`,
 * que es lo que `/api/leaderboard` ya devuelve.
 *
 * Se queda con lo que la tarjeta pinta y NADA más: nombre, modelo y el
 * rendimiento que la fuente ya calculó. Acá no se calcula ningún %— si el
 * leaderboard no lo trae, la fila sale sin número y con su motivo, que es la
 * regla 2 y además evita tener dos definiciones de "rendimiento" en el repo.
 */
export function armaArena({ agents = [], error = null, n = 5 } = {}) {
  if (error) return { agentes: [], motivo: String(error), fuente: 'api:leaderboard' };
  const filas = (Array.isArray(agents) ? agents : []).slice(0, n).map((a) => {
    const pct = num(a.return_pct);
    return {
      id: a.id || null,
      nombre: a.name || a.id || '—',
      modelo: a.model || null,
      casa: a.house || null,
      // `return_pct` es como lo llama el leaderboard. Si no viene, va null con
      // su CAUSA REAL: nunca se despeja de `equity` acá, que sería una segunda
      // definición del mismo número.
      pct,
      pct_motivo: pct == null ? motivoSinRetorno(a) : null,
    };
  });
  return {
    agentes: filas,
    motivo: filas.length ? null : 'el leaderboard no devolvió agentes',
    fuente: 'api:leaderboard',
  };
}

/**
 * POR QUÉ A ESTE AGENTE LE FALTA EL RENDIMIENTO.
 *
 * Son tres causas distintas y se arreglan distinto, así que decir una sola
 * —"el leaderboard no trajo el rendimiento"— manda a revisar el leaderboard
 * cuando el problema puede estar en las llaves o en el baseline. Cuatro de
 * cinco agentes salían con esa frase genérica (Lety, 2026-10-05) y la verdad
 * era la primera: no tienen cuenta de Alpaca conectada.
 */
function motivoSinRetorno(a) {
  if (a && a.has_keys === false) return 'este agente no tiene llaves de Alpaca configuradas';
  if (num(a && a.equity) == null) return 'no se pudo leer su cuenta de Alpaca';
  if (num(a && a.baseline_equity) == null) return 'no se pudo leer su capital inicial';
  return 'el leaderboard no trajo el rendimiento de este agente';
}
