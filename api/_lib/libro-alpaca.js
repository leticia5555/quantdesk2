// ═══════════════════════════════════════════════════════════════════
// api/_lib/libro-alpaca.js — cliente HTTP de la cuenta LIVE de Alpaca (el Libro).
//
// HEREDA EL PATRÓN de _lib/alpaca.js, NO EL ARCHIVO. Aquel cliente está
// amarrado a ALPACA_PAPER_* y al host paper por diseño (es la frontera del
// Arena); el Libro opera DINERO REAL en otro host con otras keys, y mezclar
// las dos familias de credenciales en un mismo módulo es la forma más corta de
// mandar una orden real desde el cron equivocado. Por eso este archivo:
//
//   · solo lee ALPACA_LIVE_KEY / ALPACA_LIVE_SECRET (jamás las del Arena);
//   · host https://api.alpaca.markets (ALPACA_LIVE_BASE solo para tests);
//   · NO expone `type`: todo lo que sale de aquí es `limit` + `day`
//     (regla de la casa, cicatriz Polymarket). No hay closeAllPositions a
//     mercado: el kill switch CANCELA órdenes, no liquida (liquidar a mercado
//     sería una decisión que la casa no delega a un flag).
//
// INTERRUPTOR: libroLiveEnabled() — solo el string 'true' enciende el envío de
// órdenes. Ausente / cualquier otra cosa = MODO SOMBRA: el Libro calcula y
// journalea, y `createLimitOrder` se niega a mandar. Mismo diseño que el
// paywall (_lib/paywall.js): el default seguro es "apagado".
//
// ENV VARS: ALPACA_LIVE_KEY · ALPACA_LIVE_SECRET · ALPACA_LIVE_BASE (opc) ·
//           LIBRO_LIVE_ENABLED ('true' | otra cosa)
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_BASE = 'https://api.alpaca.markets';
const DEFAULT_DATA_BASE = 'https://data.alpaca.markets';

export function libroBase() {
  return process.env.ALPACA_LIVE_BASE || DEFAULT_BASE;
}
export function libroDataBase() {
  return process.env.ALPACA_LIVE_DATA_BASE || DEFAULT_DATA_BASE;
}

// ¿Está permitido ENVIAR órdenes reales? Solo 'true' (sin importar mayúsculas
// ni espacios). Todo lo demás → sombra.
export function libroLiveEnabled() {
  const raw = process.env.LIBRO_LIVE_ENABLED;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

// null si faltan keys — los callers deciden su fallback honesto.
export function libroCreds() {
  const key = process.env.ALPACA_LIVE_KEY;
  const secret = process.env.ALPACA_LIVE_SECRET;
  return key && secret ? { key, secret } : null;
}

async function liveFetch(base, path, { method = 'GET', body } = {}) {
  const creds = libroCreds();
  if (!creds) throw new Error('Faltan ALPACA_LIVE_KEY / ALPACA_LIVE_SECRET en las env vars.');
  const r = await fetch(base + path, {
    method,
    headers: {
      'APCA-API-KEY-ID': creds.key,
      'APCA-API-SECRET-KEY': creds.secret,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!r.ok) {
    const err = new Error('Alpaca live ' + r.status + ': ' + ((data && (data.message || data.error)) || text.slice(0, 200) || 'sin detalle'));
    err.status = r.status;
    throw err;
  }
  return data;
}

export const libroFetch = (path, opts) => liveFetch(libroBase(), path, opts);

// ─────────────────── lectura ───────────────────
export function getAccount() { return libroFetch('/v2/account'); }
export function getClock() { return libroFetch('/v2/clock'); }
export function getCalendar(start, end) {
  return libroFetch(`/v2/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
}
export function getPositions() { return libroFetch('/v2/positions'); }
export function getOrders(status = 'open', limit = 100) {
  return libroFetch(`/v2/orders?status=${encodeURIComponent(status)}&limit=${limit}`);
}
export function getOrder(orderId) { return libroFetch('/v2/orders/' + encodeURIComponent(orderId)); }
export function getOrderByClientId(clientOrderId) {
  return libroFetch('/v2/orders:by_client_order_id?client_order_id=' + encodeURIComponent(clientOrderId));
}

// Último precio (snapshot) de un símbolo, host de datos, feed IEX (el que
// toda cuenta tiene garantizado; SIP exige suscripción y devolvería 403).
export async function getSnapshot(symbol) {
  const s = await liveFetch(libroDataBase(), `/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/snapshot?feed=iex`);
  const close = s && s.dailyBar && Number(s.dailyBar.c);
  const prev = s && s.prevDailyBar && Number(s.prevDailyBar.c);
  const last = s && s.latestTrade && Number(s.latestTrade.p);
  return { symbol: symbol.toUpperCase(), last: Number.isFinite(last) ? last : null, close: Number.isFinite(close) ? close : null, prev_close: Number.isFinite(prev) ? prev : null };
}

// ─────────────────── escritura (limit-only, con interruptor) ───────────────────
// `force` NO existe. Si LIBRO_LIVE_ENABLED no es 'true', esta función lanza
// `LibroSombraError` y el caller journalea la orden como `sombra`. No hay forma
// de mandar una orden real sin la env var — ni desde un test, ni desde un
// admin, ni desde un cron.
export class LibroSombraError extends Error {
  constructor() { super('LIBRO_LIVE_ENABLED no es "true": modo sombra, la orden NO se envía.'); this.sombra = true; }
}

export function createLimitOrder({ symbol, qty, side, limit_price, client_order_id, extended_hours = false }) {
  if (!symbol || typeof symbol !== 'string') throw new Error('createLimitOrder: falta symbol.');
  if (side !== 'buy' && side !== 'sell') throw new Error('createLimitOrder: side debe ser buy|sell.');
  if (!Number.isInteger(qty) || qty < 1) throw new Error('createLimitOrder: qty debe ser entero ≥ 1.');
  if (!Number.isFinite(limit_price) || limit_price <= 0) throw new Error('createLimitOrder: limit_price inválido.');
  if (!libroLiveEnabled()) throw new LibroSombraError();
  return libroFetch('/v2/orders', {
    method: 'POST',
    body: {
      symbol: symbol.toUpperCase(),
      qty: String(qty),
      side,
      type: 'limit',            // regla de la casa: hardcodeado, sin flag
      time_in_force: 'day',
      limit_price: String(limit_price),
      extended_hours,
      ...(client_order_id ? { client_order_id } : {}),
    },
  });
}

export function cancelOrder(orderId) {
  return libroFetch('/v2/orders/' + encodeURIComponent(orderId), { method: 'DELETE' });
}

// Cancela TODAS las órdenes abiertas (kill switch). Alpaca responde 207 con el
// detalle por orden; se devuelve tal cual para confirmar una por una. NO liquida
// posiciones: eso lo hace el breaker con órdenes límite marketable, o Lety a mano.
export function cancelAllOrders() {
  return libroFetch('/v2/orders', { method: 'DELETE' });
}
