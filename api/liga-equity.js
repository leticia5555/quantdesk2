// ═══════════════════════════════════════════════════════════════
// /api/liga/equity — LA CURVA DEL DÍA, por agente.
//
// El equity de cada agente muestreado cada ~5 min por el tick de arena-watch,
// con los tres números que se miran primero: apertura, MÁXIMO y último. El
// máximo del día es lo que contesta "¿llegó a estar arriba y lo devolvió?",
// que antes no se podía contestar: el equity existía en la corrida nocturna y
// en lo que /leaderboard lee en vivo sin guardar.
//
// ── EL MÁXIMO ES EL DE LAS MUESTRAS, Y SE DICE EN LA RESPUESTA ───────
// Con muestreo cada 5 min, un pico entre dos muestras no está. Para la capa de
// toma de ganancias eso significa que la respuesta a "¿tocó +X% hoy?" es un
// PISO: si las muestras dicen que sí, sí; si dicen que no, pudo haber pasado
// igual. Por eso `muestreo` viaja en cada respuesta — un análisis que trate
// esto como una serie continua está sacando conclusiones de una resolución que
// no tiene.
//
// ── RESTRICCIONES (las mismas que /liga/libros) ─────────────────────
//   · CERO writes fuera del `create table if not exists` de la lectura, que es
//     idempotente y necesario para que el primer día no reviente. NO llama a
//     beat(): latir acá enmascararía un cron muerto.
//   · NO importa arena-run ni arena-watch: el camino de decisión no se toca.
//
// Query: ?dia=YYYY-MM-DD (default: el último con muestras) · ?agente=<id>
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { leerEquityDia, diasConMuestras, MUESTREO_MS } from './_lib/arena-equity.js';
import { ARENA_AGENTS } from './_lib/arena-registry.js';
import { readBaselines, returnPct, baselineDe, indexarEquity, BASE_INDEX_USD } from './_lib/arena-baseline.js';

function identidad(agentId) {
  const a = ARENA_AGENTS.find((x) => x.id === agentId) || null;
  if (!a) return { id: agentId, nombre: agentId, modelo: null, control: false, casa: null };
  return {
    id: a.id, nombre: a.name, modelo: a.model_label,
    control: !!a.control, casa: a.house,
    ...(a.control ? { control_nota: 'CONTROL: mismo modelo y mismo prompt que Claude, distinta cuenta. Es el piso de ruido, no un competidor.' } : {}),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const agente = String(q.agente || '').trim().toLowerCase() || null;
  const pedido = /^\d{4}-\d{2}-\d{2}$/.test(String(q.dia || '')) ? String(q.dia) : null;

  const dias = await diasConMuestras({ limite: 30 });
  // Sin día pedido, el ÚLTIMO que tiene muestras — no "hoy". Un domingo, "hoy"
  // devolvería una gráfica vacía que se lee como una liga caída.
  const dia = pedido || (dias[0] ? dias[0].dia : null);

  if (!dia) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({
      dia: null, dias: [], por_agente: {},
      nota: 'Todavía no hay muestras de equity intradía. La primera entra en el próximo tick de arena-watch dentro de la sesión.',
      muestreo: { intervalo_ms: MUESTREO_MS, fuente: 'tick de /api/arena-watch' },
    });
  }

  const { ok, por_agente, motivo } = await leerEquityDia({ sessionDate: dia, agentId: agente });
  // El baseline de temporada de cada cuenta, para publicar TAMBIÉN el retorno
  // total al lado del intradía. Son dos preguntas distintas: "cómo va hoy" y
  // "cómo va la temporada", y mezclarlas es el error del que nacieron los
  // baselines por agente.
  let baselines = {};
  try { baselines = await readBaselines(); } catch { baselines = {}; }

  const salida = {};
  for (const [id, serie] of Object.entries(por_agente)) {
    const base = baselineDe(baselines, id);
    // ── LA SERIE INDEXADA ────────────────────────────────────────────
    // Cada punto escalado contra el baseline de SU cuenta, para que las siete
    // curvas se lean en la misma regla. La forma de cada curva no cambia —es
    // multiplicar por una constante— y el equity real viaja en cada punto.
    const puntosIndexados = (serie.puntos || []).map((p2) => ({
      ...p2, equity_indexado: indexarEquity(p2.equity, base),
    }));
    const idx = (x) => (x ? { ...x, equity_indexado: indexarEquity(x.equity, base) } : x);

    salida[id] = {
      agente: identidad(id),
      ...serie,
      puntos: puntosIndexados,
      apertura: idx(serie.apertura), maximo: idx(serie.maximo),
      minimo: idx(serie.minimo), ultimo: idx(serie.ultimo),
      baseline_equity: base,
      retorno_temporada_pct: serie.ultimo ? returnPct(serie.ultimo.equity, base) : null,
    };
  }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  return res.status(200).json({
    dia,
    dias: dias.map((d) => d.dia),
    filtros: { agente },
    // Qué significa el número indexado, al lado del número.
    indexado: {
      base: BASE_INDEX_USD,
      nota: 'Cada cuenta arrancó la temporada con un equity distinto (el reset aplanó y aplanar no las dejó parejas). `equity_indexado` escala cada una a 100,000 contra SU baseline para que las siete se lean en la misma regla. Los porcentajes y el orden son idénticos: indexar es multiplicar por una constante por cuenta. El `equity` real viaja en cada punto y es el que mira el breaker.',
    },
    // La resolución de la serie, explícita. Ver la cabecera: sin esto, el
    // máximo del día se lee como el máximo real y no lo es.
    muestreo: {
      intervalo_ms: MUESTREO_MS,
      fuente: 'tick de /api/arena-watch (*/5 durante la sesión)',
      nota: 'El máximo es el máximo de las MUESTRAS. Un pico entre dos muestras no está: para "¿tocó +X% hoy?" esto es un PISO, no la respuesta exacta.',
    },
    por_agente: salida,
    ...(ok ? {} : { aviso: 'No se pudo leer la serie: ' + motivo }),
  });
}
