// ═══════════════════════════════════════════════════════════════════
// /api/libro — EL LIBRO (cuenta real de Lety): salud, smoke, kill switch,
// siembra y foto diaria de equity. Fase 0: PLOMERÍA. Este endpoint NO manda
// una sola orden de estrategia (no hay adaptadores enchufados); lo único que
// escribe en Alpaca es el smoke (orden límite imposible + cancel) y el kill
// (cancelar órdenes abiertas).
//
//   GET /api/libro                  → salud: cuenta (paper|live), ¿hay keys?,
//                                     envío (sombra|encendido), ¿halt?
//   GET /api/libro?smoke=1          → ADMIN. auth (paper|live) · clock · calendar ·
//                                     orden límite IMPOSIBLE (AAPL @ $1) ·
//                                     lookup · cancel. Verde = 6/6. Igual que
//                                     el smoke del Arena, contra la cuenta del Libro.
//                                     Requiere LIBRO_LIVE_ENABLED=true para
//                                     la pata de escritura: en sombra, ese
//                                     paso reporta `sombra:true` (no es error).
//   GET /api/libro?sembrar=1        → ADMIN. ensureSchema + siembra estrategias.
//   GET /api/libro?abrir=1          → ADMIN. Abre el benchmark UNA vez:
//                                     spy_unidades = equity_live / SPY.
//   GET /api/libro?kill=1           → ADMIN. Cancela TODAS las órdenes abiertas
//                                     y pone LIBRO_HALT=1. Nada se manda con halt.
//   GET /api/libro?reanudar=1       → ADMIN. LIBRO_HALT=0 (decisión humana).
//   GET /api/libro?equity=1         → CRON o ADMIN. Foto diaria: equity, cash,
//                                     SPY close, # posiciones → libro_equity_diario.
//
// Gate ADMIN: `Authorization: Bearer <ADMIN_SECRET>` o header `x-admin-key` o
// `?secret=`. Fallback CRON_SECRET (el cron de Vercel manda ese Bearer). Sin
// secret configurado → 401 siempre (fail closed), igual que bmv-harvest.
//
// ENV VARS: LIBRO_MODO (paper|live) · ALPACA_LIBRO_PAPER_KEY/SECRET ·
//           ALPACA_LIVE_KEY/SECRET · LIBRO_LIVE_ENABLED · DATABASE_URL ·
//           ADMIN_SECRET (o CRON_SECRET)
// ═══════════════════════════════════════════════════════════════════

import {
  libroBase, libroCreds, libroCredsFaltantes, libroModo, libroLiveEnabled, getAccount, getClock, getCalendar,
  getPositions, getOrder, createLimitOrder, cancelOrder, cancelAllOrders, getSnapshot,
  LibroSombraError,
} from './_lib/libro-alpaca.js';
import {
  ensureLibroSchema, sembrarEstrategias, abrirBenchmark, estaEnHalt, leerEstado,
  kill, reanudar, registrarEquityDiario, LIBRO_RULES, LIBRO_EXIT_RULES,
} from './_lib/libro.js';
import { beat } from './_lib/heartbeat.js';

export const maxDuration = 60;

function secretoAdmin() { return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null; }
function autorizado(req, q) {
  const s = secretoAdmin();
  if (!s) return false;
  const h = (req.headers && req.headers.authorization) || '';
  if (h === `Bearer ${s}`) return true;
  if ((req.headers && req.headers['x-admin-key']) === s) return true;
  if (String((q && q.secret) || '') === s) return true;
  // El cron de Vercel manda CRON_SECRET aunque ADMIN_SECRET exista.
  const c = process.env.CRON_SECRET;
  return !!c && h === `Bearer ${c}`;
}

async function step(name, fn) {
  const t0 = Date.now();
  try { return { name, ok: true, ms: Date.now() - t0, detail: await fn() }; }
  catch (err) {
    if (err && err.sombra) return { name, ok: true, sombra: true, ms: Date.now() - t0, detail: err.message };
    return { name, ok: false, ms: Date.now() - t0, status: err.status || null, error: String((err && err.message) || err) };
  }
}

export async function runSmoke(now = new Date()) {
  const results = [];
  if (!libroCreds()) {
    return { smoke: true, base: libroBase(), modo: libroModo(), ok: false, live: libroLiveEnabled(),
      results: [{ name: 'env', ok: false, error: 'Faltan ' + libroCredsFaltantes() + '.' }], generated_at: now.toISOString() };
  }
  results.push(await step('account', async () => {
    const a = await getAccount();
    return { status: a.status, currency: a.currency, equity: a.equity, cash: a.cash, account_number: a.account_number, trading_blocked: a.trading_blocked, options_approved_level: a.options_approved_level ?? null, crypto_status: a.crypto_status ?? null };
  }));
  results.push(await step('clock', async () => { const c = await getClock(); return { is_open: c.is_open, next_open: c.next_open, next_close: c.next_close }; }));
  results.push(await step('calendar', async () => {
    const iso = (d) => d.toISOString().slice(0, 10);
    const days = await getCalendar(iso(new Date(now.getTime() - 5 * 86400000)), iso(new Date(now.getTime() + 5 * 86400000)));
    return { sessions: Array.isArray(days) ? days.length : 0, first: days && days[0] };
  }));
  // Orden límite IMPOSIBLE de llenar: prueba el path de escritura sin riesgo
  // (AAPL jamás cotiza a $1). En SOMBRA el cliente se niega y el paso lo dice.
  let orderId = null;
  results.push(await step('limit_order', async () => {
    const o = await createLimitOrder({ symbol: 'AAPL', qty: 1, side: 'buy', limit_price: 1, client_order_id: 'libro-smoke-' + now.getTime() });
    orderId = o.id;
    return { id: o.id, status: o.status, type: o.type, limit_price: o.limit_price, time_in_force: o.time_in_force };
  }));
  results.push(await step('order_lookup', async () => {
    if (!orderId) { if (!libroLiveEnabled()) throw new LibroSombraError(); throw new Error('sin orden previa que consultar.'); }
    const o = await getOrder(orderId); return { id: o.id, status: o.status };
  }));
  results.push(await step('cancel', async () => {
    if (!orderId) { if (!libroLiveEnabled()) throw new LibroSombraError(); throw new Error('sin orden previa que cancelar.'); }
    await cancelOrder(orderId);
    const o = await getOrder(orderId);
    if (!(o.status === 'canceled' || o.status === 'pending_cancel')) throw new Error('status tras cancel: ' + o.status);
    return { status: o.status };
  }));
  return { smoke: true, base: libroBase(), modo: libroModo(), live: libroLiveEnabled(), ok: results.every((r) => r.ok), results, generated_at: now.toISOString() };
}

// Foto diaria de equity. El cron la toma después del cierre (21:05 UTC).
export async function fotoEquity(now = new Date()) {
  const a = await getAccount();
  const pos = await getPositions();
  let spy = null;
  try { spy = (await getSnapshot('SPY')).close; } catch (e) { spy = null; }
  const fecha = now.toISOString().slice(0, 10);
  await registrarEquityDiario({ fecha, equity: Number(a.equity), cash: Number(a.cash), spy_close: spy, posiciones: Array.isArray(pos) ? pos.length : 0 });
  return { fecha, equity: Number(a.equity), cash: Number(a.cash), spy_close: spy, posiciones: Array.isArray(pos) ? pos.length : 0 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });
  const q = req.query || {};
  const now = new Date();
  const esAdmin = ['smoke', 'sembrar', 'abrir', 'kill', 'reanudar', 'equity'].some((k) => String(q[k] || '') === '1');

  if (!esAdmin) {
    let halt = null;
    try { halt = await estaEnHalt(); } catch (e) { halt = null; }
    return res.status(200).json({
      libro: true, base: libroBase(), cuenta: libroModo(), keys: !!libroCreds(), keys_esperadas: libroCredsFaltantes(),
      envio: libroLiveEnabled() ? 'ENCENDIDO' : 'SOMBRA', live: libroLiveEnabled(),
      halt, rules: LIBRO_RULES, exit_rules: { catastrophic_stop_pct: LIBRO_EXIT_RULES.catastrophic_stop_pct, breaker_delever_dd: LIBRO_EXIT_RULES.breaker_delever_dd, breaker_broadcut_dd: LIBRO_EXIT_RULES.breaker_broadcut_dd },
      generated_at: now.toISOString(),
    });
  }
  if (!autorizado(req, q)) {
    return res.status(401).json({ error: 'No autorizado.', como: secretoAdmin() ? 'header Authorization: Bearer <ADMIN_SECRET>' : 'ADMIN_SECRET no configurado — fail closed' });
  }

  try {
    if (String(q.smoke || '') === '1') return res.status(200).json(await runSmoke(now));
    if (String(q.sembrar || '') === '1') { await ensureLibroSchema(); return res.status(200).json({ ok: true, ...(await sembrarEstrategias()) }); }
    if (String(q.abrir || '') === '1') {
      await ensureLibroSchema();
      const a = await getAccount();
      const spy = await getSnapshot('SPY');
      const precio = spy.close ?? spy.last;
      return res.status(200).json(await abrirBenchmark({ equity: Number(a.equity), spyPrice: precio, now }));
    }
    if (String(q.kill || '') === '1') {
      const r = await kill({ cancelAll: cancelAllOrders, motivo: String(q.motivo || 'kill switch manual'), now });
      return res.status(200).json({ ok: true, ...r });
    }
    if (String(q.reanudar || '') === '1') return res.status(200).json({ ok: true, ...(await reanudar()), motivo_halt_previo: await leerEstado('LIBRO_HALT_MOTIVO') });
    if (String(q.equity || '') === '1') {
      await ensureLibroSchema();
      const r = await fotoEquity(now);
      await beat('libro:equity', 'ok', r);
      return res.status(200).json({ ok: true, ...r });
    }
    return res.status(400).json({ error: 'acción desconocida' });
  } catch (err) {
    if (String(q.equity || '') === '1') await beat('libro:equity', 'error', { error: String(err && err.message || err) });
    return res.status(502).json({ error: String((err && err.message) || err), status: err && err.status || null });
  }
}
