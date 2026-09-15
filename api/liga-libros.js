// ═══════════════════════════════════════════════════════════════
// /api/liga/libros — B11: el LIBRO de cada agente, y CÓMO llegó a él.
//
// Hermano de `/api/liga/eventos`. Aquel cuenta lo que PASÓ (órdenes, rechazos,
// cambios de líder); éste cuenta lo que el agente DECIDIÓ y, sobre todo, **cómo
// investigó** — que es lo más publicable de todo el proyecto y lo que nadie más
// está mostrando.
//
// Por agente: portafolio objetivo · tesis por posición · secuencia de
// investigación · lente del día. El control MARCADO y las etiquetas de modelo
// correctas — la etiqueta legible del registry (`model_label`), nunca el slug
// crudo de la API. El slug es un detalle de implementación que además cambia
// con un override de env var, y publicarlo haría que la tabla de la liga dijera
// cosas distintas según qué env vars estuvieran puestas ese día. (Además, la
// regla de la casa es que un ID de modelo vive en UN solo archivo: _lib/model.js.)
//
// ── LA SECUENCIA ES UNA HISTORIA, NO OCHO VOLCADOS ───────────────────
//
//   "buscó semis con RVOL alto → leyó las noticias de NVDA → pidió la ficha de
//    AMD → no compró ninguna"
//
// Eso es una historia. Ocho volcados de datos no lo son. Acá viaja el RESUMEN
// de cada llamada (herramienta, argumentos, cuántas filas, si se truncó), nunca
// el resultado completo. El resultado completo sí se journalea —el replay lo
// necesita— pero mover megabytes por un feed público que no los usa sería
// pagarlos en cada carga.
//
// ── LAS DOS FUENTES, SIEMPRE ETIQUETADAS ─────────────────────────────
// Lee `arena_journal` (la liga viva) Y `arena_shadow_journal` (la sombra), y
// CADA fila dice de cuál vino. Mientras el contrato nuevo corra solo en sombra,
// éste es el único lugar donde se puede ver un portafolio objetivo — y
// confundir una decisión de sombra con una real sería exactamente el error que
// las tablas separadas existen para impedir. Por eso `fuente` no es opcional ni
// se infiere: viaja en cada libro.
//
// ── RESTRICCIONES (las mismas que /eventos y /audit, por el mismo motivo) ──
//   · CERO writes. Puros SELECT. NO llama a ensureSchema() (hace CREATE/ALTER)
//     ni a beat() — latir acá enmascararía un cron muerto.
//   · NO importa arena-run ni el guard: el camino de decisión no se toca ni de
//     lectura.
//   · Del `context` se proyecta SOLO lo publicable. Los prompts completos NO
//     salen: son el material con el que se reconstruye la corrida, no material
//     de show, y algunos llevan el libro entero del agente.
//
// Query: ?dias=N (default 3, máx 30) · ?agente=<id> · ?fuente=viva|sombra|ambas
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { ARENA_AGENTS, ARENA_SEASON, seasonStatus, seasonDay } from './_lib/arena-registry.js';

const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

// Identidad publicable de un agente. La ETIQUETA, no el slug: el slug es un
// detalle de implementación que además cambia con un override de env var, y
// publicarlo haría que la tabla de la liga dijera cosas distintas según qué
// env vars estuvieran puestas ese día.
export function identidad(agentId) {
  const a = ARENA_AGENTS.find((x) => x.id === agentId) || null;
  if (!a) return { id: agentId, nombre: agentId, modelo: null, control: false, casa: null };
  return {
    id: a.id,
    nombre: a.name,
    modelo: a.model_label,
    // EL CONTROL VA MARCADO SIEMPRE. Es el piso de ruido: leer su resultado
    // como el de un competidor más invalida la única referencia que hace
    // significativo cualquier delta entre modelos.
    control: !!a.control,
    ...(a.control ? { control_nota: 'CONTROL: mismo modelo, mismo prompt y mismos parámetros que Claude, distinta cuenta. Es el piso de ruido — su resultado NO es el de un competidor, es la medida de cuánto varía el mismo modelo consigo mismo.' } : {}),
    casa: a.house,
    arquetipo: a.archetype ? a.archetype.name : null,
  };
}

// La secuencia, en forma de historia. Cada paso con lo justo para leerse.
export function secuenciaPublicable(ctx) {
  const t = ctx && ctx.tools;
  if (!t) return null;
  if (t.enabled === false) return { usó_herramientas: false, motivo: t.reason || null, pasos: [] };
  const pasos = (t.summary || t.sequence || []).map((s) => ({
    n: s.n, herramienta: s.tool,
    // Los argumentos YA acotados (lo que de verdad se ejecutó), no lo que pidió.
    argumentos: s.args || null,
    filas: s.rows ?? null,
    truncado: !!s.truncated,
    ms: s.ms ?? null,
    ...(s.refused ? { rechazada: s.refused } : {}),
  }));
  return {
    usó_herramientas: pasos.length > 0,
    presupuesto: t.budget ?? null,
    usadas: t.used ?? pasos.length,
    vueltas: t.turns ?? null,
    terminó_por: t.stopped_by || null,
    pasos,
  };
}

// Una fila del journal (viva o de sombra) → el libro publicable.
export function libroDeFila(row, fuente) {
  const ctx = row.context || {};
  const target = row.target || null;
  const reb = row.rebalance || null;
  return {
    fuente,                                   // 'viva' | 'sombra' — NUNCA se infiere
    fecha: row.created_at || row.run_date,
    agente: identidad(row.agent_id),
    estado: row.status,
    plan: row.plan || null,
    // El portafolio objetivo. null cuando la corrida usó el contrato viejo
    // (órdenes) — y eso también es información: dice qué contrato corrió ese día.
    portafolio: target ? {
      pesos: target.weights || null,
      cash: target.cash ?? null,
      tesis: target.theses || null,
    } : null,
    // La LENTE del día (B8). Es un confound deliberado y se publica como tal:
    // dos agentes con lentes distintas el mismo día no son comparables ese día.
    lente: ctx.lens || null,
    lente_nota: ctx.lens ? 'La lente rota por agente y por día (momentum/catalizador/valor/reversión). Es un confound DELIBERADO: dos agentes con lentes distintas el mismo día no son comparables ese día.' : null,
    // CÓMO INVESTIGÓ.
    investigacion: secuenciaPublicable(ctx),
    // Qué habría hecho el motor con ese objetivo.
    rebalanceo: reb ? {
      ordenes: (reb.legs || []).length,
      turnover: reb.turnover ?? null,
      recortes_de_riel: (reb.rail_trims || []).length,
      canceladas: (reb.cancel || []).length,
    } : null,
    error: row.error || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const dias = int(q.dias, 3, 1, 30);
  const agente = String(q.agente || '').trim().toLowerCase() || null;
  const fuente = ['viva', 'sombra', 'ambas'].includes(String(q.fuente || '')) ? String(q.fuente) : 'ambas';
  const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);

  const libros = [];
  const avisos = [];

  if (fuente === 'viva' || fuente === 'ambas') {
    try {
      const rows = await sql(
        `select run_date, created_at, agent_id, status, plan, error,
                jsonb_build_object('lens', context->>'lens', 'tools', context->'tools') as context
         from arena_journal
         where phase = 'decide' and agent_id <> 'league' and run_date >= $1::date
           ${agente ? 'and agent_id = $2' : ''}
         order by created_at desc limit 200`,
        agente ? [desde, agente] : [desde],
      );
      for (const r of rows || []) libros.push(libroDeFila(r, 'viva'));
    } catch (e) {
      avisos.push('No se pudo leer la liga viva: ' + String((e && e.message) || e));
    }
  }

  if (fuente === 'sombra' || fuente === 'ambas') {
    try {
      const rows = await sql(
        `select run_date, created_at, agent_id, status, plan, error, target, rebalance,
                jsonb_build_object('lens', context->>'lens', 'tools', context->'tools') as context
         from arena_shadow_journal
         where run_date >= $1::date ${agente ? 'and agent_id = $2' : ''}
         order by created_at desc limit 200`,
        agente ? [desde, agente] : [desde],
      );
      for (const r of rows || []) libros.push(libroDeFila(r, 'sombra'));
    } catch (e) {
      // La tabla puede no existir todavía (la sombra nunca corrió). Eso NO es
      // un error del endpoint: es un estado, y se dice como tal.
      avisos.push('Todavía no hay journal de sombra (la sombra no corrió nunca, o la tabla no existe).');
    }
  }

  libros.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  const conObjetivo = libros.filter((l) => l.portafolio);
  const conHerramientas = libros.filter((l) => l.investigacion && l.investigacion.usó_herramientas);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    temporada: {
      id: ARENA_SEASON.id, nombre: ARENA_SEASON.name,
      start: ARENA_SEASON.start, end: ARENA_SEASON.end,
      estado: seasonStatus(), dia: seasonDay(),
    },
    ventana: { dias, desde },
    filtros: { agente, fuente },
    conteos: {
      libros: libros.length,
      con_portafolio_objetivo: conObjetivo.length,
      con_investigacion: conHerramientas.length,
      de_sombra: libros.filter((l) => l.fuente === 'sombra').length,
    },
    nota_fuente: 'Cada libro dice si viene de la liga VIVA o de la SOMBRA. Una decisión de sombra NO movió dinero: es el contrato nuevo corriendo en paralelo, sin órdenes.',
    avisos: avisos.length ? avisos : null,
    libros,
  });
}
