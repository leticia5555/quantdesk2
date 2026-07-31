// ═══════════════════════════════════════════════════════════════
// Tests del cliente Alpaca (_lib/alpaca.js) y del smoke de /api/alpaca
// con TODO el I/O mockeado a nivel fetch. Valida la regla de la casa
// (limit-only hardcodeado) y la secuencia completa del smoke:
// account → clock → calendar → orden límite imposible → lookup → cancel.
// Correr con `node tests/alpaca.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { createLimitOrder, alpacaCreds, alpacaSmokeCreds } from '../api/_lib/alpaca.js';
import { runSmoke, runSellSmoke } from '../api/alpaca.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── sin keys: creds null y el smoke lo dice sin explotar ──
delete process.env.ALPACA_PAPER_KEY;
delete process.env.ALPACA_PAPER_SECRET;
console.log('alpaca: sin keys');
ok(alpacaCreds() === null, 'alpacaCreds() → null sin env vars');
const noKeys = await runSmoke();
ok(noKeys.ok === false && /ALPACA_PAPER_KEY/.test(noKeys.results[0].error), 'smoke sin keys → ok:false honesto');

// ── con keys y Alpaca fake ──
process.env.ALPACA_PAPER_KEY = 'PKTEST';
process.env.ALPACA_PAPER_SECRET = 'SECRETTEST';

const calls = [];
let orderCanceled = false;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  calls.push({ url: u, method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
  const reply = (obj, status = 200) => ({ ok: status < 300, status, text: async () => (obj === null ? '' : JSON.stringify(obj)) });

  if (u.endsWith('/v2/account')) return reply({ status: 'ACTIVE', currency: 'USD', equity: '100000', account_number: 'PA3TEST' });
  if (u.endsWith('/v2/clock')) return reply({ is_open: false, next_open: '2026-07-22T13:30:00Z', next_close: '2026-07-22T20:00:00Z' });
  if (u.includes('/v2/calendar')) return reply([{ date: '2026-07-20', open: '09:30', close: '16:00' }, { date: '2026-07-21', open: '09:30', close: '16:00' }]);
  if (u.endsWith('/v2/orders') && method === 'POST') {
    return reply({ id: 'ord-smoke-1', status: 'accepted', type: opts.body ? JSON.parse(opts.body).type : null, limit_price: '1', time_in_force: 'day' });
  }
  if (u.includes('/v2/orders/ord-smoke-1') && method === 'DELETE') { orderCanceled = true; return reply(null, 204); }
  if (u.includes('/v2/orders/ord-smoke-1')) return reply({ id: 'ord-smoke-1', status: orderCanceled ? 'canceled' : 'new' });
  return reply({ message: 'ruta inesperada: ' + u }, 404);
};

console.log('alpaca: smoke completo contra fake');
const smoke = await runSmoke(new Date('2026-07-21T22:40:00Z'));
ok(smoke.ok === true, 'los 6 pasos en verde', JSON.stringify(smoke.results.filter((r) => !r.ok)));
ok(smoke.results.map((r) => r.name).join(',') === 'account,clock,calendar,limit_order,order_lookup,cancel',
  'secuencia exacta del gate', smoke.results.map((r) => r.name).join(','));

const orderPost = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/orders'));
ok(!!orderPost, 'mandó la orden de prueba');
ok(orderPost.body.type === 'limit' && orderPost.body.time_in_force === 'day', 'orden de smoke: limit + day (regla de la casa)');
ok(orderPost.body.symbol === 'AAPL' && orderPost.body.limit_price === '1', 'orden imposible de llenar (AAPL @ $1)');
ok(orderPost.headers['APCA-API-KEY-ID'] === 'PKTEST' && orderPost.headers['APCA-API-SECRET-KEY'] === 'SECRETTEST',
  'auth por headers APCA-*');
ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('ord-smoke-1')), 'canceló la orden de prueba');

console.log('alpaca: el cliente no deja pasar órdenes inválidas');
for (const [name, args] of [
  ['qty fraccional', { symbol: 'AAPL', qty: 0.5, side: 'buy', limit_price: 100 }],
  ['qty cero', { symbol: 'AAPL', qty: 0, side: 'buy', limit_price: 100 }],
  ['side inválido', { symbol: 'AAPL', qty: 1, side: 'short', limit_price: 100 }],
  ['limit_price inválido', { symbol: 'AAPL', qty: 1, side: 'buy', limit_price: 0 }],
]) {
  let threw = false;
  try { await createLimitOrder(args); } catch (e) { threw = true; }
  ok(threw, 'rechaza ' + name);
}

// No existe forma de pedir una market order: type no es parámetro.
const before = calls.length;
await createLimitOrder({ symbol: 'msft', qty: 2, side: 'buy', limit_price: 500, type: 'market' });
const last = calls[calls.length - 1];
ok(calls.length === before + 1 && last.body.type === 'limit', 'un "type:market" colado se ignora — siempre sale limit');
ok(last.body.symbol === 'MSFT', 'símbolo normalizado a mayúsculas');

// ── smoke de VENTA en cuenta paper SEPARADA ──────────────────────────
console.log('alpaca: smoke de venta — sin keys smoke → honesto');
delete process.env.ALPACA_SMOKE_KEY;
delete process.env.ALPACA_SMOKE_SECRET;
ok(alpacaSmokeCreds() === null, 'alpacaSmokeCreds() → null sin ALPACA_SMOKE_*');
const sellNoKeys = await runSellSmoke({ pollDelayMs: 0 });
ok(sellNoKeys.ok === false && /ALPACA_SMOKE_KEY/.test(sellNoKeys.results[0].error), 'smoke de venta sin keys smoke → ok:false honesto');

console.log('alpaca: smoke de venta — round-trip con mercado abierto');
process.env.ALPACA_SMOKE_KEY = 'SMOKEKEY';
process.env.ALPACA_SMOKE_SECRET = 'SMOKESECRET';
process.env.ALPACA_SMOKE_SYMBOL = 'F';
const sellCalls = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  sellCalls.push({ url: u, method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
  const reply = (obj, status = 200) => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => (obj === null ? '' : JSON.stringify(obj)) });
  if (u.endsWith('/v2/account')) return reply({ status: 'ACTIVE', currency: 'USD', equity: '5000', account_number: 'PA-SMOKE' });
  if (u.endsWith('/v2/clock')) return reply({ is_open: true, next_open: '2026-07-22T13:30:00Z' });
  if (u.includes('yahoo')) {
    const ts = Array.from({ length: 10 }, (_, i) => (Date.UTC(2026, 4, 1) + i * 86400000) / 1000);
    return reply({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: Array.from({ length: 10 }, () => 12) }] } }] } });
  }
  if (u.endsWith('/v2/orders') && method === 'POST') {
    const b = JSON.parse(opts.body);
    const id = b.side === 'buy' ? 'sm-buy' : 'sm-sell';
    return reply({ id, status: 'accepted', side: b.side, type: b.type, limit_price: b.limit_price });
  }
  if (u.includes('/v2/orders/sm-')) {
    const id = u.split('/v2/orders/')[1];
    return reply({ id, status: 'filled', filled_qty: '1', filled_avg_price: '12.00' });
  }
  return reply({ message: 'ruta inesperada: ' + u }, 404);
};
const sell = await runSellSmoke({ now: new Date('2026-07-21T15:00:00Z'), pollDelayMs: 0 });
ok(sell.ok === true && sell.mode === 'round_trip', 'round-trip: todos los pasos verdes', JSON.stringify(sell.results.filter((r) => !r.ok)));
ok(sell.results.map((r) => r.name).join(',') === 'account,clock,reference_price,buy_1,buy_fill,sell_1,sell_fill',
  'secuencia: compra 1 + fill, vende 1 + fill', sell.results.map((r) => r.name).join(','));
const smokeBuy = sellCalls.find((c) => c.method === 'POST' && c.body && c.body.side === 'buy');
const smokeSell = sellCalls.find((c) => c.method === 'POST' && c.body && c.body.side === 'sell');
ok(smokeBuy && smokeSell && smokeBuy.body.type === 'limit' && smokeSell.body.type === 'limit',
  'ambas patas son LIMIT (marketable, no market — regla de la casa)');
ok(smokeSell.body.qty === '1' && smokeSell.body.symbol === 'F', 'vende exactamente 1 acción de F');
ok(sellCalls.filter((c) => c.url.includes('alpaca.markets')).every((c) => c.headers['APCA-API-KEY-ID'] === 'SMOKEKEY'),
  'usa las creds de la cuenta SMOKE (separada), no las del Arena');
ok(Number(smokeSell.body.limit_price) === round2Test(12 * 0.80) && Number(smokeBuy.body.limit_price) === round2Test(12 * 1.20),
  'marketable: compra 12×1.20=14.4, venta 12×0.80=9.6 (llena al NBBO)', JSON.stringify({ b: smokeBuy.body.limit_price, s: smokeSell.body.limit_price }));

function round2Test(n) { return Math.round(n * 100) / 100; }

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
