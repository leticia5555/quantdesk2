// ═══════════════════════════════════════════════════════════════
// /api/alpaca — salud y smoke de la Alpaca Paper API.
//
//   GET ?smoke=1 → el gate de la casa antes de construir sobre una fuente
//     (mismo patrón que vc-feed/stock-tracker/movers): corre EN VIVO, desde
//     el Vercel real, la secuencia mínima que prueba todo el path:
//       1. auth        GET  /v2/account
//       2. clock       GET  /v2/clock
//       3. calendar    GET  /v2/calendar (hoy ± 5 días)
//       4. orden       POST /v2/orders — límite IMPOSIBLE de llenar
//                      (buy 1 AAPL @ $1.00, day) — prueba escritura sin
//                      riesgo de fill
//       5. lookup      GET  /v2/orders/{id}
//       6. cancel      DELETE + re-GET confirmando canceled
//     Verde = los 6 pasos ok:true. Sin esto, el cron del Arena no se prende.
//
//   GET (sin smoke) → health barato: hay keys / responde account / clock.
//
// ENV VARS: ALPACA_PAPER_KEY · ALPACA_PAPER_SECRET · ALPACA_PAPER_BASE (opc)
// ═══════════════════════════════════════════════════════════════

import {
  alpacaBase, alpacaCreds, getAccount, getClock, getCalendar,
  getOrder, createLimitOrder, cancelOrder,
} from './_lib/alpaca.js';

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - t0, detail };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - t0, status: err.status || null, error: String((err && err.message) || err) };
  }
}

export async function runSmoke(now = new Date()) {
  const results = [];
  if (!alpacaCreds()) {
    return {
      smoke: true, base: alpacaBase(), ok: false,
      results: [{ name: 'env', ok: false, error: 'Faltan ALPACA_PAPER_KEY / ALPACA_PAPER_SECRET.' }],
      generated_at: now.toISOString(),
    };
  }

  results.push(await step('account', async () => {
    const a = await getAccount();
    return { status: a.status, currency: a.currency, equity: a.equity, account_number: a.account_number };
  }));
  results.push(await step('clock', async () => {
    const c = await getClock();
    return { is_open: c.is_open, next_open: c.next_open, next_close: c.next_close };
  }));
  results.push(await step('calendar', async () => {
    const iso = (d) => d.toISOString().slice(0, 10);
    const days = await getCalendar(iso(new Date(now.getTime() - 5 * 86400000)), iso(new Date(now.getTime() + 5 * 86400000)));
    return { sessions: Array.isArray(days) ? days.length : 0, first: days && days[0] };
  }));

  // Orden límite imposible de llenar: prueba el path de escritura completo
  // sin riesgo de ejecución (AAPL jamás cotiza a $1).
  let orderId = null;
  results.push(await step('limit_order', async () => {
    const o = await createLimitOrder({
      symbol: 'AAPL', qty: 1, side: 'buy', limit_price: 1,
      client_order_id: 'qd-smoke-' + now.getTime(),
    });
    orderId = o.id;
    return { id: o.id, status: o.status, type: o.type, limit_price: o.limit_price, time_in_force: o.time_in_force };
  }));
  results.push(await step('order_lookup', async () => {
    if (!orderId) throw new Error('sin orden previa que consultar.');
    const o = await getOrder(orderId);
    return { id: o.id, status: o.status };
  }));
  results.push(await step('cancel', async () => {
    if (!orderId) throw new Error('sin orden previa que cancelar.');
    await cancelOrder(orderId);
    const o = await getOrder(orderId);
    const done = o.status === 'canceled' || o.status === 'pending_cancel';
    if (!done) throw new Error('status tras cancel: ' + o.status);
    return { status: o.status };
  }));

  return {
    smoke: true, base: alpacaBase(),
    ok: results.every((r) => r.ok),
    results,
    generated_at: now.toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query && req.query.smoke) {
    // Resultados en vivo siempre — el smoke pierde sentido cacheado.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await runSmoke());
  }

  // Health barato para la UI / debugging.
  res.setHeader('Cache-Control', 'no-store');
  if (!alpacaCreds()) return res.status(200).json({ has_keys: false, base: alpacaBase() });
  try {
    const [account, clock] = await Promise.all([getAccount(), getClock()]);
    return res.status(200).json({
      has_keys: true, base: alpacaBase(),
      account: { status: account.status, equity: account.equity, cash: account.cash, currency: account.currency },
      clock: { is_open: clock.is_open, next_open: clock.next_open },
    });
  } catch (err) {
    return res.status(200).json({ has_keys: true, base: alpacaBase(), error: String((err && err.message) || err) });
  }
}
