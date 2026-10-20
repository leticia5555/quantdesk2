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
//   GET /api/arena-audit?fuente=prueba        → sólo arena_shadow_journal
//   GET /api/arena-audit?view=shadow          → lo mismo (atajo)
//   GET /api/arena-audit?view=resumen&fuente=prueba → el resumen de la puerta
//   GET /api/arena-audit?view=cierres&agent=todos&fuente=prueba&dia=…
//        → cada cierre con sus tokens, y a cuánto subir ARENA_MAX_TOKENS
//
// Las corridas leen las DOS tablas por defecto (cada fila con su sello); el
// resumen, sólo EN VIVO salvo `fuente=prueba` (no mezcla poblaciones).
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
import { FLAGSHIP_AGENT_ID, estadoDeCompuertas, ARENA_SEASON, ARENA_MAX_TOKENS, temporadaEfectiva } from './_lib/arena-registry.js';
import { leerInicioTemporada } from './_lib/arena-baseline.js';
import { RESERVA_CIERRE_MS } from './_lib/arena-tool-loop.js';
import { buildInfo } from './_lib/build-info.js';
import { checkLecturaAuth } from './_lib/arena-admin.js';
import {
  auditaFila, agrupaCorridas, construyeResumen, resolverFuente, resumenDeCierres,
  renderCorridasMarkdown, renderResumenMarkdown, BUFFET_QUALITY_DEPLOY,
  cadenciaPorAgente, renderCadenciaMarkdown,
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
  // ── DOS LLAVES, LAS DOS VÁLIDAS ────────────────────────────────────
  // `CRON_SECRET` (la del cron) o `ARENA_ADMIN_KEY` (la de admin, por
  // `x-admin-key`, `Authorization: Bearer` o `?key=`). En Vercel `CRON_SECRET`
  // quedó marcada como Secret y no se puede volver a leer, así que la única
  // llave del endpoint era ilegible para quien lo necesita. Dos llaves
  // secretas no debilitan nada; una llave ilegible sí, porque termina pegada
  // en un archivo para no perderla.
  const auth = checkLecturaAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  // ── ?compuertas=1 — ¿ESTÁ APAGADA LA LIGA? SIN EFECTO ──────────────
  // Va PRIMERO, antes de tocar la base: la pregunta "¿agarró la pausa?" tiene
  // que poder contestarse aunque Neon esté caído, y sin leer una sola fila.
  //
  // POR QUÉ ACÁ Y NO EN arena-run. Preguntarle a arena-run si está apagado
  // costaba una ronda entera si la compuerta estaba rota — el chequeo pagaba
  // exactamente el accidente que quería descartar. Este endpoint es
  // SOLO-LECTURA (cero `insert`, cero `update`, cero `delete`) y no importa
  // nada del camino de decisión.
  //
  // Y lo que contesta NO es una copia del predicado: es `estadoDeCompuertas`,
  // que usa la MISMA función que las dos compuertas. Una respuesta que
  // describe lo que la compuerta "debería" hacer no sirve para verificar un
  // deploy.
  //
  // Lee `process.env` del proceso que atiende ESTE request, en el MISMO
  // deployment que atiende a arena-run y arena-watch. Eso es justo lo que uno
  // quiere saber después de tocar una env var en Vercel: no si el panel dice
  // que se guardó, sino si el código desplegado la está viendo.
  if (String(q.compuertas || q.gates || '') === '1') {
    // La temporada que el runtime VE: después del reset, `end` es inicio + N
    // sesiones (2026-10-20 → 2026-11-18), no la constante.
    let temporada;
    try {
      const t = temporadaEfectiva(await leerInicioTemporada(ARENA_SEASON.id));
      temporada = { id: t.id, start: t.start, end: t.end, sesiones: t.sesiones, abierta: t.abierta };
    } catch (e) {
      temporada = { id: ARENA_SEASON.id, start: ARENA_SEASON.start, end: ARENA_SEASON.end, abierta: null,
        error: `no se pudo leer el inicio real (${String((e && e.message) || e)}): esta es la ventana PLANEADA` };
    }
    return res.status(200).json({
      // El SHA, para confirmar que el deploy que contesta es el que se subió.
      build: buildInfo(),
      ahora: new Date().toISOString(),
      compuertas: estadoDeCompuertas(),
      temporada,
    });
  }

  // ── LOS NOMBRES QUE LA GENTE ESCRIBE, NO SOLO LOS CANÓNICOS ────────
  // Un parámetro mal escrito se IGNORABA EN SILENCIO y el endpoint devolvía
  // otra cosa sin decirlo: `agente=todos&resumen=1&dia=...` dio el historial
  // completo de claude desde julio, porque los tres nombres reales son otros.
  // Media hora perdida mirando datos que no eran los pedidos.
  //
  // Dos arreglos: se aceptan los alias naturales, y lo que NO se reconoce se
  // DICE en la respuesta. Un endpoint de diagnóstico que miente por omisión
  // sobre qué entendió es peor que uno que falla.
  const agentParam = String(q.agent || q.agente || FLAGSHIP_AGENT_ID).toLowerCase();
  const todos = agentParam === 'todos' || agentParam === 'all';
  const format = String(q.format || 'json').toLowerCase();
  const view = String(q.view || '').toLowerCase();
  const esResumen = view === 'resumen' || view === 'summary'
    || ['1', 'true', 'si', 'sí'].includes(String(q.resumen || '').toLowerCase());
  const deploy = String(q.deploy || BUFFET_QUALITY_DEPLOY);
  const esFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  // `dia` IMPLICA `desde`. Sin esto, pedir `dia=2026-09-18` traía las filas más
  // VIEJAS del journal (la consulta ordena asc y corta por `limit`), así que la
  // cadencia del día pedido salía vacía mientras la respuesta mostraba julio.
  const diaParam = esFecha(q.dia) ? String(q.dia) : null;
  const desde = esFecha(q.desde) ? String(q.desde) : diaParam;

  // Qué llegó y no se entendió. `key` va aparte porque es una de las llaves.
  const CONOCIDOS = new Set(['agent', 'agente', 'format', 'view', 'resumen', 'deploy', 'desde', 'dia', 'limit', 'key', 'fuente']);
  const ignorados = Object.keys(q).filter((k) => !CONOCIDOS.has(k));
  const avisos = [];
  if (ignorados.length) avisos.push(`Parámetros no reconocidos (se IGNORARON): ${ignorados.join(', ')}. Los válidos son: agent, view=resumen|shadow|cierres, fuente=en_vivo|prueba|ambas, dia, desde, format, limit.`);
  const { fuente, avisos: avisosFuente } = resolverFuente({ fuente: q.fuente, view, esResumen });
  avisos.push(...avisosFuente);
  if (q.dia && !diaParam) avisos.push(`\`dia=${q.dia}\` no es una fecha AAAA-MM-DD y se ignoró.`);
  if (q.desde && !esFecha(q.desde)) avisos.push(`\`desde=${q.desde}\` no es una fecha AAAA-MM-DD y se ignoró.`);
  // Interpolado, no parametrizado: Neon tipa mal un $n en LIMIT. Seguro
  // porque pasa por Number + clamp — nunca llega texto del cliente al SQL.
  const limit = Math.max(1, Math.min(2000, Number(q.limit) || 500));

  try {
    // Filas del agente. La rama `agent_id is null` cubre el historial legado
    // del insignia por si la migración de agent_id no ha corrido en esta DB
    // (arena-run la aplica, pero esta ruta no escribe ni para arreglarlo).
    const params = [todos ? 'todos' : agentParam, desde];
    let rows = [];
    if (fuente === 'en_vivo' || fuente === 'ambas') {
      const viva = await sql(
        `select ${COLUMNS} from arena_journal
          where ($1::text = 'todos' or agent_id = $1 or (agent_id is null and $1 = 'claude'))
            and ($2::date is null or run_date >= $2::date)
          order by created_at asc limit ${limit}`, params);
      rows.push(...viva.map((r) => ({ ...r, fuente: 'en_vivo' })));
    }
    if (fuente === 'prueba' || fuente === 'ambas') {
      // La sombra no tiene `actions` (no manda órdenes) y guarda el objetivo y
      // el rebalanceo en COLUMNAS, no en context. Se meten en context para que
      // `objetivoDeFila` los lea igual que en la tabla viva.
      try {
        const sombra = await sql(
          `select id, run_date, phase, status, prompt_version, prompt_hash, model, plan,
                  null::jsonb as actions, account, error, created_at, agent_id,
                  coalesce(context, '{}'::jsonb)
                    || jsonb_strip_nulls(jsonb_build_object('target', target, 'rebalance', rebalance)) as context
             from arena_shadow_journal
            where ($1::text = 'todos' or agent_id = $1)
              and ($2::date is null or run_date >= $2::date)
            order by created_at asc limit ${limit}`, params);
        rows.push(...sombra.map((r) => ({ ...r, fuente: 'prueba' })));
      } catch (e) {
        // Se DICE: una tabla que no se pudo leer y una tabla vacía se ven igual.
        avisos.push('No se pudo leer arena_shadow_journal (las corridas de PRUEBA): ' + String((e && e.message) || e));
      }
    }
    // Un solo orden cronológico y un solo tope: con las dos tablas, el `limit`
    // es del total, no de cada una.
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const truncadoPorTabla = rows.length > limit;
    const antes = { en_vivo: 0, prueba: 0 };
    for (const r of rows) antes[r.fuente]++;
    rows = rows.slice(0, limit);
    if (truncadoPorTabla) {
      const despues = { en_vivo: 0, prueba: 0 };
      for (const r of rows) despues[r.fuente]++;
      const perdidas = Object.keys(antes).filter((k) => despues[k] < antes[k])
        .map((k) => `${antes[k] - despues[k]} de ${k === 'prueba' ? 'PRUEBA' : 'EN VIVO'}`);
      // El orden es cronológico ascendente: lo que se corta es lo MÁS NUEVO.
      avisos.push(`El límite (${limit}) cortó ${perdidas.join(' y ')} — las más recientes. Acotá con \`desde\`/\`dia\` o pedí una sola \`fuente\`.`);
    }

    // Estado de HALT (el breaker −20% detiene al agente). Lectura pura.
    let halt = [];
    try {
      halt = await sql('select agent_id, halted, halted_at, halted_reason, resumed_at from arena_state order by agent_id');
      if (!todos) halt = halt.filter((h) => (h.agent_id || FLAGSHIP_AGENT_ID) === agentParam);
    } catch (e) { halt = []; }

    // ── ?view=cierres: el techo de salida, con dato ──
    if (view === 'cierres') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        pedido: { agent: agentParam, view: 'cierres', fuente, dia: diaParam, desde, limit },
        ...(avisos.length ? { avisos } : {}),
        ...resumenDeCierres(rows, { techoActual: ARENA_MAX_TOKENS, reservaMs: RESERVA_CIERRE_MS }),
      });
    }

    const filas = rows.map(auditaFila);
    const fechas = [...new Set(filas.map((f) => String(f.fecha)))].sort();
    const audit = {
      agente: todos ? 'todos' : agentParam,
      generado_en: new Date().toISOString(),
      solo_lectura: true,
      total_filas: filas.length,
      limite: limit,
      truncado: filas.length === limit || truncadoPorTabla,   // honesto: hay más journal del que cupo
      desde: desde,
      // Lo que el endpoint ENTENDIÓ de la consulta. Va siempre, no solo cuando
      // hay avisos: así se ve de un vistazo si contestó lo que se le pidió.
      pedido: { agent: agentParam, view: esResumen ? 'resumen' : 'corridas', fuente, dia: diaParam, desde, format, limit },
      // Cuántas filas de cada tabla. Una puerta de 21 corridas que no aparece
      // acá es una puerta que no se leyó.
      por_fuente: {
        en_vivo: filas.filter((f) => f.fuente === 'en_vivo').length,
        prueba: filas.filter((f) => f.fuente === 'prueba').length,
      },
      ...(avisos.length ? { avisos } : {}),
      rango: { desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null },
      halt,
      corridas: agrupaCorridas(filas),
    };

    // Sin cache: lleva el secret en la URL y es una auditoría puntual.
    res.setHeader('Cache-Control', 'no-store');

    // ── CADENCIA: por qué un agente corrió más veces de las que debía ──
    // Se lee `arena_watch` del día pedido y se compara contra las corridas del
    // journal. Es la comparación que el viernes hubo que hacer a mano en Neon
    // para saber si falló el tope diario o el enfriamiento por agente.
    //
    // Best-effort: una auditoría que no puede leer esta tabla sigue siendo
    // útil, así que su fallo se reporta y no tumba el reporte.
    let cadencia = null;
    if (esResumen) {
      const diaCadencia = String(q.dia || '').trim() || fechas[fechas.length - 1] || null;
      let watchRows = [];
      let watchError = null;
      if (diaCadencia) {
        try {
          watchRows = await sql(
            `select agent_id, fired from arena_watch where run_date = $1::date`, [diaCadencia]);
        } catch (e) { watchError = String((e && e.message) || e); }
      }
      cadencia = {
        ...cadenciaPorAgente(filas, watchRows, { dia: diaCadencia }),
        ...(watchError ? { watch_error: watchError } : {}),
      };
    }

    if (esResumen) {
      const resumen = construyeResumen(filas, { deploy });
      // La vista agregada NO re-emite el detalle: es el panorama del run.
      const salida = { ...audit, resumen, ...(cadencia ? { cadencia } : {}) };
      delete salida.corridas;
      if (format === 'md' || format === 'markdown') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(renderResumenMarkdown(salida) + renderCadenciaMarkdown(cadencia));
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
