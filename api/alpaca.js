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
  alpacaBase, alpacaCreds, alpacaSmokeCreds, getAccount, getClock, getCalendar,
  getPositions, getOrder, createLimitOrder, cancelOrder,
} from './_lib/alpaca.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';

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

// ── smoke de VENTA (cuenta paper SEPARADA) ───────────────────────────
// Ejercita el path REAL de venta contra Alpaca antes de confiarlo — no quiero
// que el primer sell de la historia sea un stop disparando sobre una posición
// viva. Cuenta APARTE (ALPACA_SMOKE_*) para no ensuciar el libro del Agente #6.
//   Mercado ABIERTO → ROUND-TRIP: compra 1 acción de algo líquido con marketable
//     limit (llena al ask), y la vende con marketable limit (llena al bid). Las
//     dos patas llenan en segundos. Sigue siendo LIMIT (regla de la casa).
//   Mercado CERRADO → RESTING: sobre una posición existente coloca una venta
//     límite imposible (muy arriba), confirma aceptación y cancela (sin fill).
const round2 = (n) => Math.round(n * 100) / 100;

// Último cierre completo (referencia para los marketable limits). El fill es al
// NBBO, no al límite, así que el margen ±20% solo garantiza que sea marketable.
async function smokeRefClose(symbol, now) {
  try {
    const raw = await fetchDailySeries(symbol, '3mo');
    const s = raw ? completedSlice(raw, now) : null;
    if (s && s.closes.length) return s.closes[s.closes.length - 1];
  } catch (e) { /* sin referencia */ }
  return null;
}

async function pollFill(orderId, creds, { pollDelayMs, maxPolls }) {
  let last = null;
  for (let i = 0; i < maxPolls; i++) {
    const o = await getOrder(orderId, creds);
    last = o;
    if (o.status === 'filled') return o;
    if (o.status === 'canceled' || o.status === 'rejected' || o.status === 'expired') return o;
    if (pollDelayMs > 0) await new Promise((r) => setTimeout(r, pollDelayMs));
  }
  return last || { status: 'unknown' };
}

export async function runSellSmoke({ now = new Date(), pollDelayMs = 1500, maxPolls = 6 } = {}) {
  const creds = alpacaSmokeCreds();
  const symbol = String(process.env.ALPACA_SMOKE_SYMBOL || 'F').toUpperCase();
  const results = [];
  const done = (mode, sym) => ({ smoke: 'sell', mode, account: 'separate', symbol: sym, ok: results.every((r) => r.ok), results, generated_at: now.toISOString() });

  if (!creds) {
    results.push({ name: 'env', ok: false, error: 'Faltan ALPACA_SMOKE_KEY / ALPACA_SMOKE_SECRET (cuenta paper SEPARADA para el smoke de venta).' });
    return done('none', symbol);
  }

  results.push(await step('account', async () => {
    const a = await getAccount(creds);
    return { status: a.status, equity: a.equity, account_number: a.account_number };
  }));
  let isOpen = false;
  results.push(await step('clock', async () => {
    const c = await getClock(creds);
    isOpen = !!c.is_open;
    return { is_open: c.is_open, next_open: c.next_open };
  }));
  let ref = null;
  results.push(await step('reference_price', async () => {
    ref = await smokeRefClose(symbol, now);
    if (!ref) throw new Error('sin cierre de referencia para ' + symbol);
    return { symbol, ref };
  }));

  const cid = (suffix) => `qd-smoke-sell-${now.getTime()}-${suffix}`;

  if (isOpen && ref) {
    let buyId = null, sellId = null;
    results.push(await step('buy_1', async () => {
      const o = await createLimitOrder({ symbol, qty: 1, side: 'buy', limit_price: round2(ref * 1.20), client_order_id: cid('buy') }, creds);
      buyId = o.id; return { id: o.id, status: o.status, limit_price: o.limit_price };
    }));
    results.push(await step('buy_fill', async () => {
      const f = await pollFill(buyId, creds, { pollDelayMs, maxPolls });
      if (f.status !== 'filled') throw new Error('la compra no llenó (status ' + f.status + ')');
      return { status: f.status, filled_avg_price: f.filled_avg_price };
    }));
    results.push(await step('sell_1', async () => {
      const o = await createLimitOrder({ symbol, qty: 1, side: 'sell', limit_price: round2(ref * 0.80), client_order_id: cid('sell') }, creds);
      sellId = o.id; return { id: o.id, status: o.status, limit_price: o.limit_price };
    }));
    results.push(await step('sell_fill', async () => {
      const f = await pollFill(sellId, creds, { pollDelayMs, maxPolls });
      if (f.status !== 'filled') throw new Error('la VENTA no llenó (status ' + f.status + ')');
      return { status: f.status, filled_avg_price: f.filled_avg_price };
    }));
    return done('round_trip', symbol);
  }

  // Mercado CERRADO → variante RESTING sobre una posición ya existente.
  const positions = await getPositions(creds).catch(() => []);
  const held = (positions || []).find((p) => Number(p.qty) >= 1);
  if (!held) {
    results.push({ name: 'sell_resting', ok: false, error: 'mercado cerrado y sin posición en la cuenta smoke — corré con mercado ABIERTO para el round-trip completo.' });
    return done('resting', symbol);
  }
  let restId = null;
  results.push(await step('sell_resting', async () => {
    const price = round2(Number(held.current_price || held.avg_entry_price || 1) * 5); // límite imposible (no llena)
    const o = await createLimitOrder({ symbol: held.symbol, qty: 1, side: 'sell', limit_price: price, client_order_id: cid('rest') }, creds);
    restId = o.id; return { id: o.id, status: o.status, symbol: held.symbol };
  }));
  results.push(await step('cancel', async () => {
    await cancelOrder(restId, creds);
    const o = await getOrder(restId, creds);
    const ok = o.status === 'canceled' || o.status === 'pending_cancel';
    if (!ok) throw new Error('status tras cancel: ' + o.status);
    return { status: o.status };
  }));
  return done('resting', held.symbol);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query && req.query.smoke) {
    // Resultados en vivo siempre — el smoke pierde sentido cacheado.
    res.setHeader('Cache-Control', 'no-store');
    // ?smoke=sell → ejercita la VENTA real en la cuenta paper separada.
    if (String(req.query.smoke).toLowerCase() === 'sell') {
      return res.status(200).json(await runSellSmoke());
    }
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
