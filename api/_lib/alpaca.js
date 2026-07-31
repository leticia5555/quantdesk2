// ═══════════════════════════════════════════════════════════════
// api/_lib/alpaca.js — cliente HTTP de la Alpaca Paper API (Arena).
//
// Única frontera del repo con Alpaca (mismo criterio que db.js con Neon).
// Habla el REST v2 de trading con fetch, sin SDK.
//
// REGLA DE LA CASA (cicatriz Polymarket): JAMÁS market orders. Este
// cliente no expone `type` — todo lo que sale de aquí es `limit` + `day`.
// Si alguien necesita otra cosa, que lo discuta en un PR, no en un flag.
//
// Fase 2 (dinero real) = cambiar ALPACA_PAPER_BASE + keys. Nada más.
//
// ENV VARS: ALPACA_PAPER_KEY · ALPACA_PAPER_SECRET ·
//           ALPACA_PAPER_BASE (opcional, default paper-api)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_BASE = 'https://paper-api.alpaca.markets';

export function alpacaBase() {
  return process.env.ALPACA_PAPER_BASE || DEFAULT_BASE;
}

// null si faltan keys — los callers deciden su fallback honesto.
export function alpacaCreds() {
  const key = process.env.ALPACA_PAPER_KEY;
  const secret = process.env.ALPACA_PAPER_SECRET;
  return key && secret ? { key, secret } : null;
}

// Cuenta paper SEPARADA para el smoke de venta: ejercita el path real de venta
// sin ensuciar el libro del Agente #6 con posiciones de prueba (Lety tiene 3
// cuentas paper por login; una la dedica al smoke). Mismo host paper.
export function alpacaSmokeCreds() {
  const key = process.env.ALPACA_SMOKE_KEY;
  const secret = process.env.ALPACA_SMOKE_SECRET;
  return key && secret ? { key, secret } : null;
}

// `creds` override (default: las del Arena). Permite apuntar a la cuenta smoke
// sin duplicar el cliente ni la regla de la casa (limit-only) — la escritura
// sigue pasando por createLimitOrder.
export async function alpacaFetch(path, { method = 'GET', body, creds } = {}) {
  creds = creds || alpacaCreds();
  if (!creds) throw new Error('Faltan ALPACA_PAPER_KEY / ALPACA_PAPER_SECRET en las env vars.');
  const r = await fetch(alpacaBase() + path, {
    method,
    headers: {
      'APCA-API-KEY-ID': creds.key,
      'APCA-API-SECRET-KEY': creds.secret,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // DELETE devuelve 204 sin cuerpo; el resto JSON.
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!r.ok) {
    const err = new Error('Alpaca ' + r.status + ': ' + ((data && (data.message || data.error)) || text.slice(0, 200) || 'sin detalle'));
    err.status = r.status;
    throw err;
  }
  return data;
}

// ─────────────────── lectura ───────────────────

// `creds` opcional: default las del Arena; el smoke pasa las de su cuenta aparte.
export function getAccount(creds) { return alpacaFetch('/v2/account', { creds }); }
export function getClock(creds) { return alpacaFetch('/v2/clock', { creds }); }
export function getCalendar(start, end, creds) {
  return alpacaFetch(`/v2/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { creds });
}
export function getPositions(creds) { return alpacaFetch('/v2/positions', { creds }); }
export function getOrders(status = 'open', limit = 100, creds) {
  return alpacaFetch(`/v2/orders?status=${encodeURIComponent(status)}&limit=${limit}`, { creds });
}
export function getOrder(orderId, creds) { return alpacaFetch('/v2/orders/' + encodeURIComponent(orderId), { creds }); }
export function getOrderByClientId(clientOrderId, creds) {
  return alpacaFetch('/v2/orders:by_client_order_id?client_order_id=' + encodeURIComponent(clientOrderId), { creds });
}

// ─────────────────── escritura (limit-only) ───────────────────

// qty en acciones ENTERAS (los fraccionales + limit tienen letra chica en
// Alpaca; el guard del Arena ya descarta qty < 1, aquí solo se defiende).
export function createLimitOrder({ symbol, qty, side, limit_price, client_order_id, extended_hours = false }, creds) {
  if (!symbol || typeof symbol !== 'string') throw new Error('createLimitOrder: falta symbol.');
  if (side !== 'buy' && side !== 'sell') throw new Error('createLimitOrder: side debe ser buy|sell.');
  if (!Number.isInteger(qty) || qty < 1) throw new Error('createLimitOrder: qty debe ser entero ≥ 1.');
  if (!Number.isFinite(limit_price) || limit_price <= 0) throw new Error('createLimitOrder: limit_price inválido.');
  return alpacaFetch('/v2/orders', {
    method: 'POST',
    creds,
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

export function cancelOrder(orderId, creds) {
  return alpacaFetch('/v2/orders/' + encodeURIComponent(orderId), { method: 'DELETE', creds });
}
