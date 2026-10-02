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
export function armaEstaSemana({ macro = {}, reportes = {}, ahora = new Date(), dias = DIAS_SEMANA } = {}) {
  const v = ventanaSemana(ahora, dias);
  const dentro = (f) => {
    const d = String(f || '').slice(0, 10);
    return d >= v.desde && d <= v.hasta;
  };

  const eventos = [];
  for (const e of (macro.filas || [])) {
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
      macro: estadoFuente(macro, 'neon:macro_events'),
      reportes: estadoFuente(reportes, 'finnhub:earnings-calendar'),
    },
  };
}

function estadoFuente(f, nombre) {
  if (f && f.error) return { fuente: nombre, ok: false, motivo: String(f.error), filas: 0 };
  const n = (f && f.filas ? f.filas.length : 0);
  return { fuente: nombre, ok: true, motivo: null, filas: n };
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
  const filas = (Array.isArray(agents) ? agents : []).slice(0, n).map((a) => ({
    id: a.id || null,
    nombre: a.name || a.id || '—',
    modelo: a.model || null,
    casa: a.house || null,
    // `return_pct` es como lo llama el leaderboard. Si no viene, va null con
    // motivo: nunca se despeja de `equity` acá, que sería una segunda
    // definición del mismo número.
    pct: num(a.return_pct),
    pct_motivo: num(a.return_pct) == null ? 'el leaderboard no trajo el rendimiento de este agente' : null,
  }));
  return {
    agentes: filas,
    motivo: filas.length ? null : 'el leaderboard no devolvió agentes',
    fuente: 'api:leaderboard',
  };
}
