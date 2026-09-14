// ═══════════════════════════════════════════════════════════════
// /api/liga/eventos — la CRÓNICA de la liga, solo lectura.
//
// (El archivo vive plano como `api/liga-eventos.js` y `vercel.json` reescribe
// `/api/liga/eventos` hacia acá: el glob de `functions` en vercel.json es
// `api/*.js`, así que un archivo anidado quedaría fuera de esa config.)
//
// Devuelve el FEED de lo que pasó en la liga, en un solo array ordenado del más
// reciente al más viejo, con cuatro tipos de evento:
//
//   compra        — una orden de compra que se envió a Alpaca
//   venta         — una venta: del PM, o de la red determinista (trailing,
//                   stop catastrófico, breaker) con su `origen`
//   rechazo       — una acción que NO se ejecutó, con la razón verbatim
//   cambio_lider  — el #1 por equity cambió de manos
//   disparador    — (cadencia por evento) el vigilante detectó algo que concierne a un agente:
//                   qué fue, en qué nombre, y si lo despertó o lo frenó un tope.
//                   Es el ÚNICO tipo que puede existir SIN una orden detrás —
//                   y ése es el punto: "el mercado hizo esto y el PM decidió no
//                   moverse" es una decisión, y la crónica de la liga la cuenta.
//
// PARA QUÉ: es la capa de DATOS de la narración de la liga. Hoy no hay UI ni
// notificaciones que la consuman — a propósito: primero los datos, estables y
// auditables; el resto después, sin tener que rehacer el backend.
//
// RESTRICCIONES (las mismas que /api/arena-audit, y por el mismo motivo):
//   - CERO writes. Puros SELECT. NO llama a ensureSchema() (hace CREATE/ALTER)
//     ni a beat() — latir acá enmascararía un cron muerto, porque el latido
//     dejaría de significar "el cron corrió".
//   - NO importa arena-run ni el guard: el camino de decisión no se toca ni de
//     lectura.
//   - Del `context` del journal se proyecta SOLO `headline`. El resto son los
//     prompts completos de las dos fases: traerlos sería mover megabytes por
//     un feed que no los usa.
//
// PÚBLICO como /api/leaderboard (es el mismo material de show, sin keys ni
// datos de cuenta más allá del equity que el leaderboard ya publica).
//
// Query: ?dias=N (default 14, máx 90) · ?agente=<id> · ?tipo=compra,venta,...
//        · ?limit=N (default 200, máx 1000)
//
// ENV VARS: DATABASE_URL · ARENA_BASELINE_EQUITY (opc, default 100000).
// ═══════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { ARENA_AGENTS, ARENA_SEASON, seasonStatus, seasonDay } from './_lib/arena-registry.js';

export const TIPOS = ['compra', 'venta', 'rechazo', 'cambio_lider', 'disparador'];

const BASELINE = (() => {
  const n = Number(process.env.ARENA_BASELINE_EQUITY);
  return Number.isFinite(n) && n > 0 ? n : 100000;
})();

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

// Por qué NO se ejecutó una acción. Se clasifica contra los mensajes que
// escribe el propio runner (los tres son nuestros, no de un tercero): el guard
// que descarta por regla, la salida determinista que tiene precedencia sobre el
// PM, y la supresión de compras (breaker desapalancando o corrida por evento).
export function clasificarRechazo(razon) {
  const r = String(razon || '');
  if (/salida de riesgo determinista/i.test(r)) return 'precedencia_riesgo';
  if (/suprimida/i.test(r)) return 'supresion';
  return 'guard';
}

// Una fila del journal → sus eventos de orden. `headline` (el titular de esa
// corrida) viaja pegado a cada evento: es la voz del agente sobre esa decisión,
// y así la UI no tiene que cruzar dos colecciones para mostrarla.
export function eventosDeFila(row, nombre) {
  const out = [];
  const fecha = row.created_at || row.run_date;
  const titular = row.headline && row.headline.text ? row.headline.text : null;
  for (const a of (row.actions || [])) {
    if (!a || !a.symbol) continue;
    const base = {
      fecha, agente: row.agent_id, agente_nombre: nombre, simbolo: a.symbol,
      lado: a.side || null, titular, run_status: row.status,
    };
    if (a.result === 'discarded') {
      out.push({
        tipo: 'rechazo', ...base,
        motivo: clasificarRechazo(a.reason),
        razon: a.reason || null,
        // La qty/precio existen solo si la acción llegó a aprobarse y la
        // suprimió una capa posterior; en un descarte del guard son las crudas
        // del LLM y pueden faltar. null honesto, nunca un cero.
        qty: num(a.qty), precio: num(a.limit_price),
      });
      continue;
    }
    if (a.result !== 'approved') continue; // submit_failed: no llegó al mercado
    out.push({
      tipo: a.side === 'sell' ? 'venta' : 'compra', ...base,
      qty: num(a.qty), precio: num(a.limit_price), notional: num(a.notional),
      // De dónde salió: canal del buffet para una compra del PM, o la regla
      // determinista que la disparó para una venta de la red de seguridad.
      origen: a.origin || null,
      canales: Array.isArray(a.channels) ? a.channels : [],
      // T2 #5: si la venta se re-precio a marketable, se ve el antes y el después.
      ...(a.repriced ? { repreciada: a.repriced, precio_pedido: num(a.limit_price_proposed) } : {}),
      razonamiento: a.reasoning || null,
      estado_orden: a.order_status || null,
      fill: a.filled_avg_price != null ? { precio: num(a.filled_avg_price), qty: num(a.filled_qty), fecha: a.filled_at || null } : null,
    });
  }
  return out;
}

// Una fila de `arena_watch` → su evento de crónica. El titular NO viaja acá: el
// disparador es anterior a la decisión, así que a esta altura todavía no existe
// una voz que narre nada — la narración llega con la orden, en su propio evento.
export function eventoDeDisparo(row, nombre) {
  const d = row.detail || {};
  return {
    tipo: 'disparador', fecha: row.fired_at,
    agente: row.agent_id, agente_nombre: nombre, simbolo: row.symbol,
    disparador: row.trigger_type,
    // `desperto` distingue los dos finales posibles de un disparo: el agente se
    // pronunció, o un tope lo frenó (y entonces `razon` dice cuál).
    desperto: !!row.fired,
    razon: row.fired ? null : (row.skip_reason || null),
    precio: num(d.price),
    // Los números que hicieron que disparara, tal como se midieron. Viajan solo
    // los que aplican a ese tipo: un disparo por volumen no tiene move_pct.
    movimiento_pct: num(d.move_pct),
    referencia: num(d.mark),
    nivel: num(d.level),
    puntos_al_nivel: num(d.points_to_level),
    multiplo_volumen: num(d.multiple),
  };
}

// Serie de equity por (fecha, agente) → eventos de CAMBIO DE LÍDER.
// Solo se evalúa un día con AL MENOS DOS agentes reportando equity: con uno
// solo, "líder" no significa nada y el feed se llenaría de cambios falsos el
// día que los demás fallan. El primer día con datos NO es un cambio: es el
// arranque, y se marca como tal.
export function cambiosDeLider(porFecha, nombres = {}) {
  const fechas = Object.keys(porFecha).sort();
  const out = [];
  let anterior = null;
  for (const fecha of fechas) {
    const fila = porFecha[fecha];
    const conEquity = Object.entries(fila).filter(([, eq]) => Number.isFinite(eq) && eq > 0);
    if (conEquity.length < 2) continue;
    conEquity.sort((a, b) => b[1] - a[1]);
    const [lider, equity] = conEquity[0];
    if (anterior && lider === anterior.lider) { anterior = { lider, equity, fecha }; continue; }
    out.push({
      tipo: 'cambio_lider', fecha, agente: lider, agente_nombre: nombres[lider] || lider,
      equity: +equity.toFixed(2),
      return_pct: +(((equity - BASELINE) / BASELINE) * 100).toFixed(2),
      anterior: anterior ? { agente: anterior.lider, agente_nombre: nombres[anterior.lider] || anterior.lider, equity: +anterior.equity.toFixed(2) } : null,
      // Sin líder previo no hubo "cambio": es el primer día medible de la serie.
      arranque: !anterior,
    });
    anterior = { lider, equity, fecha };
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const dias = int(q.dias, 14, 1, 90);
  const limite = int(q.limit, 200, 1, 1000);
  const agente = q.agente ? String(q.agente).trim().toLowerCase() : null;
  const tipos = q.tipo
    ? new Set(String(q.tipo).split(',').map((t) => t.trim().toLowerCase()).filter((t) => TIPOS.includes(t)))
    : new Set(TIPOS);

  const nombres = Object.fromEntries(ARENA_AGENTS.map((a) => [a.id, a.name]));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();

  let rows;
  try {
    // Proyección MÍNIMA: del context solo el titular (el resto son los prompts
    // completos). `agent_id <> 'league'` deja fuera las filas marcadoras de liga
    // (mercado cerrado, anuncios, cierre de temporada): no son eventos de orden.
    rows = await sql(
      `select id, agent_id, run_date, status, created_at, actions,
              (account->>'equity')::numeric as equity,
              context->'headline' as headline
       from arena_journal
       where phase = 'decide' and coalesce(agent_id, 'claude') <> 'league'
         and created_at >= $1::timestamptz
       order by created_at asc`,
      [desde]);
  } catch (err) {
    return res.status(200).json({ error: 'journal no disponible: ' + String((err && err.message) || err), eventos: [] });
  }

  const eventos = [];
  const porFecha = {};
  for (const row of rows) {
    const id = row.agent_id || 'claude';
    if (Number.isFinite(Number(row.equity))) {
      const f = String(row.run_date || '').slice(0, 10);
      if (f) {
        porFecha[f] = porFecha[f] || {};
        porFecha[f][id] = Number(row.equity); // la última fila del día gana
      }
    }
    if (agente && id !== agente) continue;
    for (const e of eventosDeFila({ ...row, agent_id: id }, nombres[id] || id)) {
      if (tipos.has(e.tipo)) eventos.push(e);
    }
  }

  // DISPARADORES del vigilante (cadencia por evento). Tabla aparte del journal a propósito: son
  // muchos más que las corridas (uno por nombre y por tipo, incluidos los que
  // un tope frenó) y mezclarlos en la consulta del journal la volvería pesada
  // para el 95% de las lecturas que no los piden. Best-effort: si la tabla no
  // existe todavía (deploy previo a la migración), el feed sirve igual sin ellos.
  let disparos = [];
  if (tipos.has('disparador')) {
    try {
      const filas = await sql(
        `select agent_id, symbol, trigger_type, fired, skip_reason, detail, fired_at
         from arena_watch
         where fired_at >= $1::timestamptz ${agente ? 'and agent_id = $2' : ''}
         order by fired_at asc limit 2000`,
        agente ? [desde, agente] : [desde]);
      disparos = filas.map((f) => eventoDeDisparo(f, nombres[f.agent_id] || f.agent_id));
    } catch (err) { disparos = []; }
    for (const e of disparos) eventos.push(e);
  }

  // El liderazgo es un hecho de la LIGA: se calcula con todos los agentes
  // aunque se haya filtrado por uno, y solo después se filtra el evento.
  if (tipos.has('cambio_lider')) {
    for (const e of cambiosDeLider(porFecha, nombres)) {
      if (!agente || e.agente === agente || (e.anterior && e.anterior.agente === agente)) eventos.push(e);
    }
  }

  eventos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const truncado = eventos.length > limite;
  const pagina = eventos.slice(0, limite);

  const conteos = {};
  for (const t of TIPOS) conteos[t] = eventos.filter((e) => e.tipo === t).length;

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    temporada: {
      id: ARENA_SEASON.id, nombre: ARENA_SEASON.name,
      start: ARENA_SEASON.start, end: ARENA_SEASON.end,
      estado: seasonStatus(), dia: seasonDay(),
    },
    ventana: { dias, desde, corridas: rows.length },
    filtros: { agente, tipos: [...tipos] },
    conteos,
    truncado,
    eventos: pagina,
  });
}
