// ═══════════════════════════════════════════════════════════════
// /api/arena-admin — operaciones MANUALES sobre los libros del Arena.
//
// Lo que Lety dispara a mano con curl, con nombre y con rastro. Hoy tiene una
// sola acción, la que hace falta para limpiar la mesa antes del relanzamiento
// del lunes 21:
//
//   GET  /api/arena-admin?action=cancel_open_orders   → ENSAYO. Lista qué se
//        cancelaría, por cuenta, y no toca nada.
//   POST /api/arena-admin?action=cancel_open_orders   → CANCELA de verdad las
//        órdenes abiertas de las SIETE cuentas.
//
// ── POR QUÉ EL GET NO CANCELA ────────────────────────────────────────
// Un GET lo dispara cualquier cosa que toque la URL: un prefetch del navegador,
// un bot que siga un link de un log, un retry de un proxy. Cancelar las órdenes
// abiertas de siete libros no es una lectura, y la regla de la casa para lo que
// no se puede deshacer es que haya que pedirlo explícitamente. Así que el verbo
// separa las dos cosas: GET enseña, POST hace. El GET además devuelve el curl
// exacto del POST, para no tener que recordarlo.
//
// ── AUTENTICACIÓN: FAIL CLOSED ───────────────────────────────────────
// `ARENA_ADMIN_KEY` es OBLIGATORIA. Sin ella el endpoint responde 503 y no
// hace nada — al revés que el patrón `CRON_SECRET` del resto del repo ("si
// está puesta, se valida"), que para un endpoint de LECTURA es razonable y
// para uno que cancela órdenes sería una puerta abierta si alguien olvida la
// variable en un proyecto nuevo. La key viaja por header (Bearer o
// `x-arena-admin-key`), NUNCA por query: un secret en la URL queda en los logs
// de Vercel y en el historial de la shell.
//
// ── LAS SIETE CUENTAS, NO LAS ACTIVAS ────────────────────────────────
// Se recorre `ARENA_AGENTS` (el registry completo), no `activeAgents()`. Si
// `ARENA_LEAGUE` estuviera recortada en Vercel, un agente apagado seguiría
// teniendo órdenes vivas en su cuenta de Alpaca — y ésas son justo las que hay
// que limpiar antes de resetear. Un agente sin keys se reporta como tal y no
// tumba a los demás.
//
// ── RASTRO ───────────────────────────────────────────────────────────
// Toda ejecución real journalea UNA fila de liga (`agent_id='league'`,
// status `admin_cancel_open_orders`) con el detalle por cuenta. El ensayo NO
// journalea: no pasó nada.
//
// ENV VARS: ARENA_ADMIN_KEY (obligatoria) · ALPACA_<AGENTE>_KEY/SECRET ·
//           DATABASE_URL (para el rastro; si falla, la cancelación NO se
//           revierte — se reporta el fallo del journal y ya).
// ═══════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto';
import { sql } from './_lib/db.js';
import { getOrders, cancelOrder } from './_lib/alpaca.js';
import { ARENA_AGENTS, agentAlpacaCreds } from './_lib/arena-registry.js';

// Siete cuentas × (1 listado + N cancelaciones). Con el default de 60s de
// Vercel, un día con muchas órdenes abiertas se pasaría a mitad de la tercera
// cuenta y dejaría la limpieza incompleta sin decirlo. Mismo techo que el resto
// del Arena (plan Pro).
export const maxDuration = 300;

// Comparación en tiempo constante. Longitudes distintas → false sin comparar
// (timingSafeEqual lanza si difieren, y esa excepción ya filtraría el largo).
function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// La key SOLO por header. Bearer (como los crons) o `x-arena-admin-key`.
function presentedKey(req) {
  const h = (req && req.headers) || {};
  const auth = String(h.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return String(h['x-arena-admin-key'] || '');
}

// Órdenes ABIERTAS de una cuenta → forma compacta y auditable.
const compact = (o) => ({
  id: o.id,
  client_order_id: o.client_order_id || null,
  symbol: o.symbol,
  side: o.side,
  qty: o.qty != null ? Number(o.qty) : null,
  limit_price: o.limit_price != null ? Number(o.limit_price) : null,
  status: o.status,
  submitted_at: o.submitted_at || o.created_at || null,
});

// ── la acción ────────────────────────────────────────────────────────
// `dry` = solo lista. Devuelve SIEMPRE una entrada por agente del registry,
// incluso si no tiene keys o Alpaca se cayó: "no se pudo mirar esta cuenta" es
// un resultado que hay que ver, no una fila que falte.
export async function cancelOpenOrders({ dry = false, agents = ARENA_AGENTS } = {}) {
  const cuentas = await Promise.all(agents.map(async (agent) => {
    const base = { agent: agent.id, name: agent.name, alpaca: agent.alpaca };
    const creds = agentAlpacaCreds(agent);
    if (!creds) return { ...base, status: 'sin_keys', open: 0, canceled: 0, failed: 0, orders: [] };

    let open;
    try {
      open = await getOrders('open', 500, creds);
    } catch (err) {
      return { ...base, status: 'error_listado', open: null, canceled: 0, failed: 0, orders: [], error: String((err && err.message) || err) };
    }
    const orders = (open || []).map(compact);
    if (!orders.length) return { ...base, status: 'sin_ordenes_abiertas', open: 0, canceled: 0, failed: 0, orders: [] };
    if (dry) return { ...base, status: 'ensayo', open: orders.length, canceled: 0, failed: 0, orders };

    // En SERIE dentro de cada cuenta: Alpaca limita por cuenta y una ráfaga de
    // DELETE paralelos sobre el mismo libro se gana un 429 que haría fallar
    // cancelaciones que sí se podían hacer. Entre cuentas sí hay paralelismo
    // (son logins distintos) — de eso se encarga el Promise.all de arriba.
    const out = [];
    let canceled = 0;
    let failed = 0;
    for (const o of orders) {
      try {
        await cancelOrder(o.id, creds);
        out.push({ ...o, result: 'canceled' });
        canceled++;
      } catch (err) {
        // 422 = la orden ya no es cancelable (llenó o ya estaba cancelada entre
        // el listado y el DELETE). No es un fallo de la limpieza: el objetivo
        // —que no quede abierta— se cumplió igual, y se reporta distinto para
        // no leerlo como un error que hay que reintentar.
        const status = err && err.status;
        const result = status === 422 ? 'ya_no_cancelable' : 'failed';
        out.push({ ...o, result, error: String((err && err.message) || err) });
        if (result === 'failed') failed++;
      }
    }
    return {
      ...base,
      status: failed ? 'parcial' : 'ok',
      open: orders.length, canceled, failed,
      orders: out,
    };
  }));

  const totals = cuentas.reduce((acc, c) => ({
    open: acc.open + (c.open || 0),
    canceled: acc.canceled + (c.canceled || 0),
    failed: acc.failed + (c.failed || 0),
    sin_keys: acc.sin_keys + (c.status === 'sin_keys' ? 1 : 0),
    errores: acc.errores + (c.status === 'error_listado' ? 1 : 0),
  }), { open: 0, canceled: 0, failed: 0, sin_keys: 0, errores: 0 });

  return { dry, cuentas, totals };
}

// Rastro de una ejecución REAL. Best-effort y con id único por timestamp: si el
// journal falla, la cancelación ya ocurrió y no se deshace — se reporta.
async function journalCancel(result, now) {
  const plan = [
    `ADMIN — cancelación manual de órdenes abiertas en las ${result.cuentas.length} cuentas del Arena.`,
    `Abiertas al momento: ${result.totals.open}. Canceladas: ${result.totals.canceled}. Fallidas: ${result.totals.failed}.`,
    result.totals.sin_keys ? `Cuentas sin keys (no se miraron): ${result.cuentas.filter((c) => c.status === 'sin_keys').map((c) => c.agent).join(', ')}.` : null,
    result.totals.errores ? `Cuentas que no se pudieron listar: ${result.cuentas.filter((c) => c.status === 'error_listado').map((c) => c.agent).join(', ')}.` : null,
    'Disparada a mano (curl con ARENA_ADMIN_KEY), no por un cron.',
  ].filter(Boolean).join('\n');
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, plan, context, agent_id)
       values ($1,$2,'decide','admin_cancel_open_orders',$3,$4,'league')`,
      ['arena-admin-cancel-' + now.toISOString(), now.toISOString().slice(0, 10), plan, JSON.stringify(result)]);
    return { journaled: true };
  } catch (err) {
    return { journaled: false, error: String((err && err.message) || err) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-arena-admin-key');
  // Nunca cacheado: lleva estado de cuentas y una acción destructiva.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Método no soportado.' });

  const expected = process.env.ARENA_ADMIN_KEY;
  if (!expected) {
    // FAIL CLOSED, y lo dice: sin la variable el endpoint no existe.
    return res.status(503).json({ error: 'ARENA_ADMIN_KEY no configurada en el server — este endpoint está cerrado.' });
  }
  if (!secretMatches(presentedKey(req), expected)) {
    return res.status(401).json({ error: 'No autorizado. La key va por header: Authorization: Bearer <ARENA_ADMIN_KEY> (o x-arena-admin-key), nunca en la URL.' });
  }

  const action = String((req.query && req.query.action) || '').toLowerCase();
  if (action !== 'cancel_open_orders') {
    return res.status(400).json({
      error: 'Acción no soportada.',
      acciones: ['cancel_open_orders'],
    });
  }

  const dry = req.method === 'GET';
  try {
    const now = new Date();
    const result = await cancelOpenOrders({ dry });
    if (dry) {
      return res.status(200).json({
        action, dry: true,
        hint: 'Esto es un ENSAYO: no se canceló nada. Para ejecutar de verdad, el mismo curl con -X POST.',
        curl: `curl -X POST -H "Authorization: Bearer $ARENA_ADMIN_KEY" "https://quantdesk2.vercel.app/api/arena-admin?action=cancel_open_orders"`,
        ...result,
      });
    }
    const trace = await journalCancel(result, now);
    return res.status(200).json({ action, dry: false, ...result, journal: trace });
  } catch (err) {
    return res.status(500).json({ error: 'arena-admin: ' + ((err && err.message) || 'unknown') });
  }
}
