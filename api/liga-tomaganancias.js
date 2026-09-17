// ═══════════════════════════════════════════════════════════════
// /api/liga/toma-ganancias — LA CAPA DE TOMA DE GANANCIAS.
//
// ¿Qué habría pasado si cada agente vendiera todo al llegar a +X% en el día y
// se quedara en efectivo? Mismas decisiones, resultado alternativo.
//
// APARTE DE LA LIGA, y de verdad: lee la serie de equity intradía y calcula.
// No manda órdenes, no toca el journal, no altera ninguna decisión. Es una
// contrafactual, y la respuesta lo dice en cada nivel.
//
// Query:
//   ?umbral=0.02        un umbral (fracción, no %) · default 2%
//   ?barrido=1          varios umbrales de una, para ver la FORMA
//   ?umbrales=0.01,0.03 el barrido, a medida
//   ?dia=YYYY-MM-DD     default: el último día con muestras
//   ?agente=<id>
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { leerEquityDia, diasConMuestras, MUESTREO_MS } from './_lib/arena-equity.js';
import { simularDia, barrer, UMBRAL_DEFAULT } from './_lib/arena-tomaganancias.js';
import { ARENA_AGENTS } from './_lib/arena-registry.js';

const nombre = (id) => {
  const a = ARENA_AGENTS.find((x) => x.id === id);
  return a ? a.name : id;
};

// Una fracción entre 0 y 1. Se acepta "2" y "2%" como 2% porque es el error de
// dedo obvio, y un umbral de 200% no es una petición: es un malentendido.
function fraccion(v, def) {
  if (v == null || v === '') return def;
  const s = String(v).trim().replace('%', '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return def;
  return n > 1 ? n / 100 : n;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const agente = String(q.agente || '').trim().toLowerCase() || null;
  const pedido = /^\d{4}-\d{2}-\d{2}$/.test(String(q.dia || '')) ? String(q.dia) : null;
  const umbral = fraccion(q.umbral, UMBRAL_DEFAULT);
  const quiereBarrido = String(q.barrido || '') === '1' || !!q.umbrales;
  const umbrales = String(q.umbrales || '').trim()
    ? String(q.umbrales).split(',').map((x) => fraccion(x, null)).filter((x) => x != null)
    : [0.01, 0.015, 0.02, 0.03, 0.05];

  const dias = await diasConMuestras({ limite: 30 });
  const dia = pedido || (dias[0] ? dias[0].dia : null);

  const cabecera = {
    dia, dias: dias.map((d) => d.dia),
    // La resolución de la serie manda sobre lo que se puede afirmar.
    muestreo: {
      intervalo_ms: MUESTREO_MS,
      nota: 'El umbral se evalúa contra MUESTRAS cada ~5 min. Un disparo es un hecho; la AUSENCIA de disparo no prueba que el equity nunca tocó el umbral — pudo tocarlo entre dos muestras. El conteo de disparos es un PISO.',
    },
    contrafactual: 'Esto NO es un backtest: no hay costos, ni slippage, ni modelo de ejecución. Asume que vender el libro entero al tocar el umbral se ejecuta al equity de esa muestra. El sesgo va SIEMPRE a favor de la regla.',
    no_toca_la_liga: 'Solo lectura. No manda órdenes, no escribe en el journal y no cambia ninguna decisión de ningún agente.',
  };

  if (!dia) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({
      ...cabecera,
      nota: 'Todavía no hay muestras de equity intradía: la simulación no tiene sobre qué correr. La primera serie se llena en la próxima sesión.',
      por_agente: {},
    });
  }

  const { por_agente } = await leerEquityDia({ sessionDate: dia, agentId: agente });

  if (quiereBarrido) {
    // El barrido es POR AGENTE: un promedio entre siete cuentas con baselines
    // distintos escondería justo lo que se quiere ver, que es si la regla
    // ayuda a unos y estorba a otros.
    const salida = {};
    for (const [id, serie] of Object.entries(por_agente)) {
      salida[id] = { agente: { id, nombre: nombre(id) }, muestras: (serie.puntos || []).length, barrido: barrer(serie, { umbrales }) };
    }
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ ...cabecera, modo: 'barrido', umbrales, por_agente: salida });
  }

  const sim = simularDia(por_agente, { umbral });
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  return res.status(200).json({
    ...cabecera,
    modo: 'umbral',
    ...sim,
    filas: sim.filas.map((f) => ({ ...f, nombre: nombre(f.agente) })),
  });
}
