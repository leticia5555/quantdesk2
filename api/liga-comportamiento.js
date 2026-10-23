// ═══════════════════════════════════════════════════════════════
// /api/liga/comportamiento?agent= — cómo juega cada agente en la temporada,
// cada métrica con CONTROL al lado (la diferencia claude − control es el
// ruido del sistema). Las definiciones viven en _lib/liga-comportamiento.js.
//
// SOLO LECTURA. Lo único que escribe es la definición de la vista
// `liga_decisiones` (`create or replace`, idempotente), igual que
// /api/liga/decisiones. Nada de esto viaja a ningún prompt.
//
//   agent — opcional, un id del registro. Sin él, los siete.
//
// La ventana es la TEMPORADA: desde el arranque real (lo escribe el reset) o,
// si no corrió, desde el declarado.
// ═══════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_SEASON, temporadaEfectiva } from './_lib/arena-registry.js';
import { leerInicioTemporada } from './_lib/arena-baseline.js';
import { getBarrasDiarias } from './_lib/alpaca.js';
import { VISTA_DECISIONES, filaDecision } from './_lib/liga-decisiones.js';
import { comportamientoDe, ladoALado } from './_lib/liga-comportamiento.js';

export const CONTROL = 'control';
export const BENCHMARK = 'SPY';

// La ÚLTIMA muestra de cada sesión: es el equity de cierre del día.
export const SQL_EQUITY_DIARIO = `select distinct on (agent_id, session_date)
       agent_id, session_date as fecha, equity, cash
  from arena_equity_intraday
 where session_date >= $1::date
 order by agent_id, session_date, minuto desc`;

// Los libros de cada corrida en vivo (snapshotCuenta al inicio de la corrida).
export const SQL_LIBROS = `select agent_id, run_date as fecha, created_at as creado, account
  from arena_journal
 where run_date >= $1::date and account is not null and agent_id is not null`;

export const SQL_DECISIONES_TEMPORADA = `select * from liga_decisiones where dia_fill >= $1::date`;

let vistaLista = false;
const dia = (x) => (x == null ? null : (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)));

// Las barras de Alpaca con tope de tiempo: si no contestan, persecución y beta
// salen null con el motivo; el resto se publica igual.
async function barras(simbolos, { creds, desde, deps }) {
  let corte;
  const reloj = new Promise((resolve) => { corte = setTimeout(() => resolve({ error: 'Alpaca no contestó las barras en 9s' }), 9000); });
  try {
    const r = await Promise.race([(deps.getBarrasDiarias || getBarrasDiarias)(simbolos, { creds, start: desde }), reloj]);
    if (r.error) return { aperturas: {}, spy: {}, error: r.error };
    const aperturas = {};
    for (const [s, list] of Object.entries(r.data || {})) aperturas[s] = Object.fromEntries(list.filter((b) => b.o).map((b) => [b.fecha, b.o]));
    const spy = Object.fromEntries(((r.data || {})[BENCHMARK] || []).map((b) => [b.fecha, b.c]));
    return { aperturas, spy, error: null };
  } catch (e) {
    return { aperturas: {}, spy: {}, error: String((e && e.message) || e) };
  } finally { clearTimeout(corte); }
}

export async function leerDatos({ desde, deps = {} } = {}) {
  if (!vistaLista) { await sql(VISTA_DECISIONES); vistaLista = true; }
  const [decisiones, equity, libros] = await Promise.all([
    sql(SQL_DECISIONES_TEMPORADA, [desde]),
    sql(SQL_EQUITY_DIARIO, [desde]),
    sql(SQL_LIBROS, [desde]),
  ]);
  const ds = decisiones.map(filaDecision);
  const compras = [...new Set(ds.filter((d) => d.lado === 'buy').map((d) => d.symbol))];
  const creds = activeAgents().map(agentAlpacaCreds).find(Boolean) || null;
  const b = await barras([...compras, BENCHMARK], { creds, desde, deps });
  return {
    decisiones: ds,
    equityDiario: equity.map((r) => ({ agent_id: r.agent_id, fecha: dia(r.fecha), equity: r.equity, cash: r.cash })),
    libros: libros.map((r) => {
      const a = r.account || {};
      return { agent_id: r.agent_id, fecha: dia(r.fecha), creado: r.creado instanceof Date ? r.creado.toISOString() : String(r.creado), equity: a.equity, cash: a.cash, holdings: Array.isArray(a.holdings) ? a.holdings : [] };
    }),
    spy: b.spy,
    aperturas: b.aperturas,
    barras_error: b.error,
  };
}

export function armarRespuesta({ datos, agentes, desde, ahora }) {
  const control = comportamientoDe(CONTROL, datos, { ahora });
  return {
    desde, ahora: ahora.toISOString(),
    control: { agent: CONTROL, metricas: control },
    agentes: agentes.map((id) => {
      const m = id === CONTROL ? control : comportamientoDe(id, datos, { ahora });
      return {
        agent: id,
        metricas: m,
        // Control contra sí mismo no es un piso: la columna sale vacía.
        con_control: id === CONTROL ? null : ladoALado(m, control),
      };
    }),
    ...(datos.barras_error ? { barras_error: datos.barras_error } : {}),
    notas: {
      ruido: 'diferencia = agente − control. claude y control son el mismo modelo con el mismo prompt y el mismo enfoque: su diferencia es el ruido del sistema. Una diferencia entre otro agente y control que no supere la de claude no distingue al modelo.',
      sharpe: 'diario, sin anualizar y sin tasa libre de riesgo.',
      concentracion: 'libro al inicio de la última corrida de cada día.',
      enfoque: 'el enfoque de una compra es el enfoque del agente el día del fill (control hereda el de claude).',
      nulos: 'null = no hay datos para medirlo (nunca 0).',
    },
  };
}

export default async function handler(req, res, deps = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });
  const agent = String((req.query || {}).agent || '').trim().toLowerCase() || null;
  if (agent && !agentById(agent)) return res.status(400).json({ error: `agent desconocido: "${agent}".` });
  try {
    let temporada = temporadaEfectiva(null);
    try { temporada = temporadaEfectiva(await leerInicioTemporada(ARENA_SEASON.id)); } catch { /* cae a la declarada */ }
    const desde = temporada.start;
    const ahora = deps.ahora || new Date();
    const datos = await leerDatos({ desde, deps });
    const agentes = agent ? [agent] : activeAgents().map((a) => a.id);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ temporada_abierta: !!temporada.abierta, ...armarRespuesta({ datos, agentes, desde, ahora }) });
  } catch (err) {
    return res.status(500).json({ error: 'liga-comportamiento: ' + ((err && err.message) || 'unknown') });
  }
}
