// ═══════════════════════════════════════════════════════════════
// /api/arena-audit — auditoría SOLO-LECTURA del rastro del Arena.
//
// Responde "¿qué ha analizado el Agente #6 desde el arranque?" sin abrir
// una sesión de SQL: Claude Code no alcanza Neon desde el sandbox, la app en
// Vercel sí. Este endpoint lee `arena_journal` (+ `arena_state`) y devuelve,
// POR CORRIDA: qué canales del buffet llegaron y con cuántos ítems reales,
// qué nombró el scout, el slate final (con las marcas floor_reserved), las
// acciones propuestas, el veredicto del guard con su razón, los fills, la
// prosa del plan y el resultado del detector de fabricación (#93).
//
//   GET /api/arena-audit                      → JSON, corrida por corrida
//   GET /api/arena-audit?format=md            → markdown en español
//   GET /api/arena-audit?view=resumen         → métricas de todo el run
//   GET /api/arena-audit?view=resumen&format=md
//   GET /api/arena-audit?agent=openai         → otro competidor de la liga
//   GET /api/arena-audit?agent=todos          → todas las filas, sin filtro
//   GET /api/arena-audit?desde=2026-08-01&limit=200
//   GET /api/arena-audit?deploy=<ISO>         → re-corta el antes/después
//
// ── SOLO LECTURA, en serio ────────────────────────────────────────────
// Cero writes a cualquier tabla: puros SELECT. En particular NO llama a
// `ensureSchema()` (hace CREATE/ALTER/UPDATE de migración) ni a `beat()` —
// latir aquí enmascararía un cron muerto, porque el latido dejaría de
// significar "el cron corrió". Tampoco importa arena-run, el guard ni el
// prompt del PM: el camino de decisión no se toca ni de lectura.
//
// ── Gate ──────────────────────────────────────────────────────────────
// Mismo patrón de CRON_SECRET que arena-run/ai-usage: si la env var está
// puesta, sin el secret correcto → 401 "No autorizado.". Se acepta por
// header (`Authorization: Bearer <secret>`, como los crons) O por query
// (`?secret=<secret>`), porque el caso de uso es abrir el markdown DIRECTO
// en el navegador y ahí no hay forma de mandar headers. El secret en la URL
// queda en logs/historial: es un endpoint de lectura, sin datos de cuenta
// más allá de lo que ya publica /api/arena, y se responde con `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional, mismo patrón de la casa)
// ═══════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { FLAGSHIP_AGENT_ID } from './_lib/arena-registry.js';
import {
  auditaFila, agrupaCorridas, construyeResumen,
  renderCorridasMarkdown, renderResumenMarkdown, BUFFET_QUALITY_DEPLOY,
} from './_lib/arena-audit.js';

// El journal ya es largo (semanas de corridas × contexto completo por fila:
// ambos prompts, datos de Finnhub, respuestas del LLM). Traerlo y
// reconstruirlo puede pasarse del default de 60s de Vercel, así que —misma
// medicina que arena-run/pead-harvest— se le da el tope del plan Pro.
export const maxDuration = 300;

// `llm_response` NO se selecciona: es el texto crudo del modelo, pesa y ya
// está destilado en plan/actions/context. `context` sí, pero sus prompts se
// quedan en el server (solo salen conteos y estructura) — la respuesta tiene
// que caber en el límite de Vercel y leerse en un chat.
const COLUMNS = 'id, run_date, phase, status, prompt_version, prompt_hash, model, plan, actions, account, error, context, created_at, agent_id';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = (req.query || {});
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) return res.status(401).json({ error: 'No autorizado.' });
  }

  const agentParam = String(q.agent || FLAGSHIP_AGENT_ID).toLowerCase();
  const todos = agentParam === 'todos' || agentParam === 'all';
  const format = String(q.format || 'json').toLowerCase();
  const view = String(q.view || '').toLowerCase();
  const esResumen = view === 'resumen' || view === 'summary';
  const deploy = String(q.deploy || BUFFET_QUALITY_DEPLOY);
  // Fecha ISO o nada. Se valida acá (nunca se interpola cruda: viaja como $2).
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(q.desde || '')) ? String(q.desde) : null;
  // Interpolado, no parametrizado: Neon tipa mal un $n en LIMIT. Seguro
  // porque pasa por Number + clamp — nunca llega texto del cliente al SQL.
  const limit = Math.max(1, Math.min(2000, Number(q.limit) || 500));

  try {
    // Filas del agente. La rama `agent_id is null` cubre el historial legado
    // del insignia por si la migración de agent_id no ha corrido en esta DB
    // (arena-run la aplica, pero esta ruta no escribe ni para arreglarlo).
    const rows = await sql(
      `select ${COLUMNS} from arena_journal
        where ($1::text = 'todos' or agent_id = $1 or (agent_id is null and $1 = 'claude'))
          and ($2::date is null or run_date >= $2::date)
        order by created_at asc limit ${limit}`,
      [todos ? 'todos' : agentParam, desde]);

    // Estado de HALT (el breaker −20% detiene al agente). Lectura pura.
    let halt = [];
    try {
      halt = await sql('select agent_id, halted, halted_at, halted_reason, resumed_at from arena_state order by agent_id');
      if (!todos) halt = halt.filter((h) => (h.agent_id || FLAGSHIP_AGENT_ID) === agentParam);
    } catch (e) { halt = []; }

    const filas = rows.map(auditaFila);
    const fechas = [...new Set(filas.map((f) => String(f.fecha)))].sort();
    const audit = {
      agente: todos ? 'todos' : agentParam,
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      total_filas: filas.length,
      limite: limit,
      truncado: filas.length === limit,   // honesto: hay más journal del que cupo
      desde: desde,
      rango: { desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null },
      halt,
      corridas: agrupaCorridas(filas),
    };

    // Sin cache: lleva el secret en la URL y es una auditoría puntual.
    res.setHeader('Cache-Control', 'no-store');

    if (esResumen) {
      const resumen = construyeResumen(filas, { deploy });
      // La vista agregada NO re-emite el detalle: es el panorama del run.
      const salida = { ...audit, resumen };
      delete salida.corridas;
      if (format === 'md' || format === 'markdown') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(renderResumenMarkdown(salida));
      }
      return res.status(200).json(salida);
    }

    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderCorridasMarkdown(audit));
    }
    return res.status(200).json(audit);
  } catch (err) {
    return res.status(500).json({ error: 'arena-audit: ' + ((err && err.message) || 'unknown') });
  }
}
