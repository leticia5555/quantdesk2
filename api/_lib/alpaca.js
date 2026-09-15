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

// ─────────────────── APLANADO DE CUENTA (solo RESET) ───────────────────
// LA EXCEPCIÓN A LA REGLA DE LA CASA, declarada acá y en un solo lugar.
//
// Todo lo que decide el Arena sale por `createLimitOrder`: límite, day, sin
// flag que lo cambie (cicatriz Polymarket). Estas dos funciones NO son un
// camino de decisión — son el APLANADO de una cuenta antes de arrancar una
// temporada, y lo dispara una persona con ARENA_ADMIN_KEY, nunca un cron ni un
// LLM. Alpaca cierra posiciones con orden de MERCADO en `DELETE /v2/positions`
// y no ofrece una variante límite; un aplanado por límites sería N órdenes que
// pueden no llenar, y una temporada que arranca con media cartera vieja
// adentro es peor que un fill unos centavos peor.
//
// El candado que queda: estas funciones viven fuera del harness de decisión
// (nadie en arena-run.js las importa) y hay un test que verifica que
// `createLimitOrder` sigue siendo el único camino de escritura del runner.

// Cancela TODAS las órdenes abiertas. Alpaca responde 207 con el detalle por
// orden; el cliente devuelve ese array tal cual para poder confirmar una por
// una en vez de reportar un "listo" que no se verificó.
export function cancelAllOrders(creds) {
  return alpacaFetch('/v2/orders', { method: 'DELETE', creds });
}

// Cierra TODAS las posiciones a mercado y, de paso, cancela las órdenes
// abiertas (`cancel_orders=true`) para que una venta vieja no compita con el
// aplanado. Devuelve el detalle por símbolo que manda Alpaca.
export function closeAllPositions(creds, { cancelOrders = true } = {}) {
  return alpacaFetch('/v2/positions?cancel_orders=' + (cancelOrders ? 'true' : 'false'), { method: 'DELETE', creds });
}

// ─────────────────── datos de mercado (Market Data API) ───────────────────
// HOST DISTINTO del de trading: data.alpaca.markets, mismas keys. Lo usa el
// VIGILANTE (api/arena-watch.js) para mirar precios intradía sin gastar un solo
// token. El resto del Arena sigue decidiendo con el CIERRE completo de Yahoo
// (_lib/sim.js) — no se cambia la fuente de verdad del guard, se agrega una
// fuente INTRADÍA para detectar que algo pasó.
//
// `feed`: 'iex' por default. Es el que el tier gratis/paper tiene garantizado;
// pedir SIP sin suscripción devuelve 403 y dejaría al vigilante ciego. Se puede
// subir con ALPACA_DATA_FEED=sip el día que haya suscripción, sin tocar código.
const DEFAULT_DATA_BASE = 'https://data.alpaca.markets';

export function alpacaDataBase() {
  return process.env.ALPACA_DATA_BASE || DEFAULT_DATA_BASE;
}
export function alpacaDataFeed() {
  const f = String(process.env.ALPACA_DATA_FEED || '').trim().toLowerCase();
  return f === 'sip' || f === 'iex' || f === 'delayed_sip' ? f : 'iex';
}

async function alpacaDataFetch(path, creds) {
  creds = creds || alpacaCreds();
  if (!creds) throw new Error('Faltan keys de Alpaca para la Market Data API.');
  const r = await fetch(alpacaDataBase() + path, {
    headers: { 'APCA-API-KEY-ID': creds.key, 'APCA-API-SECRET-KEY': creds.secret },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!r.ok) {
    const err = new Error('Alpaca data ' + r.status + ': ' + ((data && (data.message || data.error)) || text.slice(0, 200) || 'sin detalle'));
    err.status = r.status;
    throw err;
  }
  return data;
}

// La URL lleva los símbolos en el query string: se parte en lotes para no
// construir una URL kilométrica (y porque Alpaca tiene su propio tope por
// request). 100 es holgado para la unión de los 7 libros + el buffet.
const DATA_CHUNK = 100;
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// SNAPSHOT por símbolo: último trade, barra del día y barra del día anterior.
// De aquí salen los tres números del vigilante de una sola llamada: precio
// VIVO, volumen acumulado de HOY y cierre ANTERIOR (el ancla de la marca).
// Devuelve { SYMBOL: { price, day_volume, prev_close, day_open, as_of } }.
// Un símbolo sin datos sale AUSENTE del mapa, nunca con ceros.
export async function getSnapshots(symbols = [], creds) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return {};
  const feed = alpacaDataFeed();
  const out = {};
  for (const batch of chunk(wanted, DATA_CHUNK)) {
    const data = await alpacaDataFetch(`/v2/stocks/snapshots?symbols=${encodeURIComponent(batch.join(','))}&feed=${feed}`, creds);
    // Alpaca ha servido este endpoint con y sin envoltorio `snapshots`; se
    // aceptan las dos formas en vez de acoplarse a una versión del API.
    const map = (data && data.snapshots) || data || {};
    for (const [sym, snap] of Object.entries(map)) {
      if (!snap || typeof snap !== 'object') continue;
      const trade = snap.latestTrade || snap.latest_trade || null;
      const day = snap.dailyBar || snap.daily_bar || null;
      const prev = snap.prevDailyBar || snap.prev_daily_bar || null;
      const minute = snap.minuteBar || snap.minute_bar || null;
      // Precio vivo: el último trade manda; si no llegó, la barra de minuto y
      // luego el cierre de la barra del día. Sin ninguno → el símbolo se omite.
      const price = Number(trade && trade.p) || Number(minute && minute.c) || Number(day && day.c) || null;
      if (!Number.isFinite(price) || price <= 0) continue;
      out[String(sym).toUpperCase()] = {
        price,
        day_volume: Number(day && day.v) || null,
        day_open: Number(day && day.o) || null,
        prev_close: Number(prev && prev.c) || null,
        as_of: (trade && trade.t) || (minute && minute.t) || (day && day.t) || null,
      };
    }
  }
  return out;
}

// Promedio de volumen de las últimas `days` sesiones COMPLETAS. La barra de HOY
// se excluye: comparar el volumen del día contra un promedio que ya lo incluye
// diluiría justo el pico que se quiere detectar.
// Devuelve { SYMBOL: promedio }. Símbolo sin historia suficiente → ausente.
export async function getAvgDailyVolume(symbols = [], { days = 20, today = null, creds } = {}) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return {};
  const feed = alpacaDataFeed();
  const out = {};
  for (const batch of chunk(wanted, DATA_CHUNK)) {
    const data = await alpacaDataFetch(
      `/v2/stocks/bars?symbols=${encodeURIComponent(batch.join(','))}&timeframe=1Day&limit=${days + 5}&feed=${feed}`, creds);
    const bars = (data && data.bars) || {};
    for (const [sym, list] of Object.entries(bars)) {
      if (!Array.isArray(list) || !list.length) continue;
      const completed = list.filter((b) => b && (!today || String(b.t || '').slice(0, 10) !== today));
      const vols = completed.slice(-days).map((b) => Number(b.v)).filter((v) => Number.isFinite(v) && v > 0);
      if (!vols.length) continue;
      out[String(sym).toUpperCase()] = vols.reduce((a, b) => a + b, 0) / vols.length;
    }
  }
  return out;
}
