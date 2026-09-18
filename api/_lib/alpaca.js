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
// ── LA TRAMPA DE PAGAR SIP Y SEGUIR EN IEX ───────────────────────────
// Esto usaba `alpacaDataFeed()` a secas, que sin `ALPACA_DATA_FEED` devuelve
// 'iex' y NO prueba nada más. El universo (`getPriceAndDollarVolume`) sí
// intenta SIP primero y cae a IEX con un 403 — así que las dos mitades del
// Arena podían estar leyendo feeds distintos, y el día que se contratara SIP
// los PRECIOS DE REFERENCIA DE LOS LÍMITES habrían seguido saliendo de IEX sin
// que nada lo dijera. Se paga el consolidado y se siguen preciando las órdenes
// con una bolsa que es el ~2-3% del volumen.
//
// Misma disciplina que el universo: se intenta el consolidado, se cae a IEX
// solo con los status que significan "no tenés el plan", y el feed que de
// verdad contestó VIAJA en el resultado (`getSnapshotsConFeed`) en vez de
// quedar implícito. `getSnapshots` conserva su firma y su forma de retorno:
// ningún llamador cambia.
//
// La caché es por proceso y dura lo que dura la lambda: sin ella cada llamada
// pagaría otra vez el 403 de SIP. No se cachea un fallo de red (eso sí hay que
// reintentarlo), solo el veredicto "esta cuenta no tiene SIP".
let feedSnapshotsResuelto = null;

export function resetFeedSnapshots() { feedSnapshotsResuelto = null; }   // para los tests

export async function getSnapshotsConFeed(symbols = [], creds) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return { data: {}, feed: null };
  // Una preferencia explícita no se pisa; si no hay, se prueba el consolidado.
  const pinned = String(process.env.ALPACA_DATA_FEED || '').trim().toLowerCase();
  const orden = pinned ? [alpacaDataFeed()]
    : (feedSnapshotsResuelto ? [feedSnapshotsResuelto] : ['sip', 'iex']);

  let ultimo = null;
  for (const feed of orden) {
    try {
      const data = await snapshotsPorFeed(wanted, creds, feed);
      if (!pinned) feedSnapshotsResuelto = feed;
      return { data, feed };
    } catch (e) {
      ultimo = e;
      // 403 de SIP = "no tenés el plan" → se baja a IEX. Un 500 o un timeout
      // NO: reintentar con otro feed taparía una caída de Alpaca.
      if (!FEED_FALLBACK_STATUS.has((e && e.status) || 0)) throw e;
    }
  }
  throw ultimo || new Error('Alpaca snapshots: ningún feed contestó');
}

export async function getSnapshots(symbols = [], creds) {
  const { data } = await getSnapshotsConFeed(symbols, creds);
  return data;
}

async function snapshotsPorFeed(wanted, creds, feed) {
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
// ── EL FEED TIENE QUE SER EL MISMO QUE EL DEL NUMERADOR ──────────────
// Este promedio es el DENOMINADOR del RVOL; el numerador es el volumen del día
// que sale de `getSnapshots`. Hasta ahora los dos salían de IEX y la cuota de
// IEX se CANCELABA en el cociente: el RVOL estaba bien aunque el volumen
// absoluto fuera una fracción.
//
// Desde que los snapshots intentan SIP, dejar esto en `alpacaDataFeed()` sería
// dividir volumen CONSOLIDADO entre volumen de UNA bolsa: un RVOL inflado ~30-50×
// que marcaría el mercado entero como "volumen inusual". Por eso el llamador
// pasa el feed que de verdad contestó arriba, y el default sigue siendo el de
// siempre para quien no lo pase.
export async function getAvgDailyVolume(symbols = [], { days = 20, today = null, creds, feed: feedPedido = null } = {}) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return {};
  const feed = feedPedido || alpacaDataFeed();
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

// ─────────────────── SCREENER (Buffet v1.5) ───────────────────
// Alpaca publica su propio screener en el host de datos: movers (gainers y
// losers del día) y most-actives (por volumen o por número de trades). Son
// listas YA RANKEADAS por el proveedor — nosotros no recalculamos nada.
//
// POR QUÉ ESTE CANAL Y NO SOLO /api/movers: el buffet traía movers de UNA
// fuente, recortados a top-8 por lado. El screener de Alpaca devuelve hasta 50
// por lado y los most-actives aparte, que es otra pregunta ("qué se está
// negociando" ≠ "qué se movió"). Con los dos, el universo del día pasa de ~24
// nombres a ~100 sin una llamada más por símbolo.
//
// SIN KEYS DE PAGO: estos endpoints responden con las mismas keys paper. El
// `feed` no aplica acá (el ranking lo hace Alpaca sobre consolidado).
const SCREENER_BASE = '/v1beta1/screener/stocks';

// Tope de Alpaca por lado. Pedir más no falla, pero tampoco devuelve más.
export const SCREENER_MAX_MOVERS = 50;
export const SCREENER_MAX_ACTIVES = 100;

// { gainers: [{symbol, price, change, percent_change}], losers: [...], last_updated }
export async function getMovers({ top = SCREENER_MAX_MOVERS, creds } = {}) {
  const n = Math.max(1, Math.min(SCREENER_MAX_MOVERS, Math.floor(top) || SCREENER_MAX_MOVERS));
  const data = await alpacaDataFetch(`${SCREENER_BASE}/movers?top=${n}`, creds);
  const norm = (list) => (Array.isArray(list) ? list : []).map((m) => ({
    symbol: String(m.symbol || '').toUpperCase(),
    price: Number(m.price),
    change: Number(m.change),
    percent_change: Number(m.percent_change),
  })).filter((m) => m.symbol && Number.isFinite(m.price));
  return {
    gainers: norm(data && data.gainers),
    losers: norm(data && data.losers),
    last_updated: (data && data.last_updated) || null,
  };
}

// { most_actives: [{symbol, volume, trade_count}], last_updated }
// `by`: 'volume' (acciones negociadas) o 'trades' (número de operaciones). El
// default es volumen: es el que se compara contra el promedio de 20 días para
// el RVOL, así que es el que alimenta la misma pregunta.
export async function getMostActives({ top = SCREENER_MAX_ACTIVES, by = 'volume', creds } = {}) {
  const n = Math.max(1, Math.min(SCREENER_MAX_ACTIVES, Math.floor(top) || SCREENER_MAX_ACTIVES));
  const modo = by === 'trades' ? 'trades' : 'volume';
  const data = await alpacaDataFetch(`${SCREENER_BASE}/most-actives?by=${modo}&top=${n}`, creds);
  const list = (data && (data.most_actives || data.mostActives)) || [];
  return {
    most_actives: (Array.isArray(list) ? list : []).map((m) => ({
      symbol: String(m.symbol || '').toUpperCase(),
      volume: Number(m.volume) || null,
      trade_count: Number(m.trade_count) || null,
    })).filter((m) => m.symbol),
    by: modo,
    last_updated: (data && data.last_updated) || null,
  };
}

// ── PRECIO Y VOLUMEN EN DÓLARES, POR LOTES ──────────────────────────
// Los dos datos que el filtro de admisión necesita por nombre, para ~600
// nombres, en SEIS requests en vez de seiscientos.
//
// EL PROBLEMA QUE RESUELVE: `_lib/arena-admission.js` pedía precio y volumen a
// Yahoo UNO POR UNO. Estaba bien dimensionado para lo que tenía enfrente —su
// propio encabezado dice "~8 series de Yahoo por corrida"— pero el universo de
// B1 le pone 600 nombres delante. A un request por nombre eso es media hora de
// wall-clock contra una función de 300s.
//
// Alpaca sirve barras de hasta 100 símbolos por request, así que 600 nombres
// son 6 requests. Es el mismo endpoint y el mismo lote que ya usa
// getAvgDailyVolume: acá se devuelven las DOS cosas que la admisión mira.
//
// POINT-IN-TIME: la barra de HOY se excluye. El filtro decide con velas
// CERRADAS — si entrara la viva, un nombre podría admitirse por el volumen del
// día que se está operando, que es justo lo que no se puede usar.
//
// Devuelve { SYMBOL: { price, dollarVolume, sessions } }. Un símbolo sin barras
// suficientes sale AUSENTE del mapa, nunca con ceros: la admisión distingue
// "no califica" de "no hay datos", y un cero lo convertiría en lo primero.
// ── EL FEED IMPORTA, Y MUCHO MÁS DE LO QUE PARECE ────────────────────
// EL BUG QUE LO ORIGINA: el universo rechazó 218 nombres por volumen, y entre
// ellos AIG con "$8.7M/día". AIG negocia cientos de millones por día.
//
// La causa: las velas salían del feed IEX, que es UNA bolsa —~2-3% del volumen
// consolidado—. O sea que el piso de $10M/día se estaba aplicando sobre el 2-3%
// del volumen real: en la práctica pedía ~$400M consolidados. El filtro no
// estaba midiendo liquidez, estaba midiendo cuota de mercado de IEX.
//
// Lo traicionero es que el PRECIO de IEX está bien: solo el VOLUMEN es una
// fracción. Así que todo se veía correcto salvo el número que decidía.
//
// SIP es el consolidado (todas las bolsas) y requiere plan de datos. Se intenta
// SIP primero y se cae a IEX si la cuenta no lo tiene — pero NUNCA en silencio:
// el feed que de verdad contestó viaja en el resultado, porque el umbral que
// hay que aplicar depende de él.
export const FEED_FALLBACK_STATUS = new Set([401, 403, 404, 422]);

export async function getPriceAndDollarVolume(symbols = [], { creds, now = new Date(), days = 20, feed: feedPreferido = null } = {}) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return { data: {}, feed: null, symbols: 0 };
  // Si ALPACA_DATA_FEED está puesta a mano, se respeta y no se prueba nada más:
  // una preferencia explícita no se pisa. Si no, se intenta el consolidado.
  const pinned = String(process.env.ALPACA_DATA_FEED || '').trim().toLowerCase();
  const orden = feedPreferido ? [feedPreferido]
    : (pinned ? [alpacaDataFeed()] : ['sip', 'iex']);

  const intentos = [];
  for (const feed of orden) {
    try {
      const data = await barsPorFeed(wanted, { creds, now, days, feed });
      intentos.push({ feed, ok: true, symbols: Object.keys(data).length });
      return { data, feed, symbols: Object.keys(data).length, intentos };
    } catch (e) {
      const status = (e && e.status) || 0;
      intentos.push({ feed, ok: false, status, error: String((e && e.message) || e) });
      // Un 403 de SIP es "no tenés el plan", y ahí SÍ se baja a IEX. Un 500 o un
      // timeout no: reintentar con otro feed taparía una caída de Alpaca.
      if (!FEED_FALLBACK_STATUS.has(status)) throw e;
    }
  }
  return { data: {}, feed: null, symbols: 0, intentos };
}

// ── CUÁNTAS VELAS HACEN FALTA, Y POR QUÉ ESTABA MAL ──────────────────
// EL BUG (visto en el diag del 2026-09-16: `ret_1m: null` para DELL y COP, o
// sea para los 535 nombres): las velas se recortaban con `.slice(-days)` y
// `days` es 20 —la ventana del PROMEDIO DE VOLUMEN—, así que quedaban 20 velas.
// El retorno a 1 mes mira 21 sesiones atrás: `cerradas[20 - 1 - 21]` es
// `cerradas[-2]`, o sea `undefined`. `ret_1m` era null SIEMPRE, por
// construcción, y por eso el screener con `ret_1m_min` devolvía 0 filas.
// `ret_5d` funcionaba porque `cerradas[14]` sí existe — y eso hacía que el bug
// se leyera como "a veces no hay dato" en vez de "nunca lo hubo".
//
// DOS VENTANAS DISTINTAS que se estaban pisando:
//   · el promedio de volumen quiere las últimas `days` sesiones (20),
//   · el retorno a 1 mes quiere 22 velas (la de hoy-21 y la última).
// Se conservan las que alcanzan para la más larga, y el promedio sigue usando
// SOLO sus 20: mezclarlas cambiaría en silencio qué mide el filtro de liquidez.
export const RET_1M_SESIONES = 21;

// Sesiones → días de calendario. 5 de cada 7 son hábiles, más margen para
// festivos: pedir 31 días para 22 sesiones sale justo y un feriado lo rompe.
function diasDeCalendario(sesiones) {
  return Math.ceil((sesiones * 7) / 5) + 12;
}

async function barsPorFeed(wanted, { creds, now, days, feed }) {
  const hoy = now.toISOString().slice(0, 10);
  // La ventana de velas a CONSERVAR: la mayor de las dos que se calculan.
  const sesiones = Math.max(days, RET_1M_SESIONES + 1);
  const start = new Date(now.getTime() - diasDeCalendario(sesiones) * 86400000).toISOString().slice(0, 10);
  const out = {};
  for (const batch of chunk(wanted, DATA_CHUNK)) {
    const data = await alpacaDataFetch(
      `/v2/stocks/bars?symbols=${encodeURIComponent(batch.join(','))}&timeframe=1Day&start=${start}&limit=${diasDeCalendario(sesiones) * batch.length}&feed=${feed}`, creds);
    for (const [sym, list] of Object.entries((data && data.bars) || {})) {
      if (!Array.isArray(list) || !list.length) continue;
      const cerradas = list.filter((b) => b && String(b.t || '').slice(0, 10) !== hoy).slice(-sesiones);
      if (!cerradas.length) continue;
      const ultima = cerradas[cerradas.length - 1];
      const price = Number(ultima.c);
      if (!Number.isFinite(price) || price <= 0) continue;
      // El promedio de volumen sigue siendo de `days` sesiones, no de las 22
      // que ahora se conservan: ensanchar la ventana de liquidez sin decirlo
      // cambiaría a quién admite el universo.
      const dvs = cerradas.slice(-days)
        .map((b) => (Number(b.c) || 0) * (Number(b.v) || 0))
        .filter((x) => Number.isFinite(x) && x > 0);
      // ── LOS RETORNOS SALEN GRATIS DE LAS MISMAS VELAS ────────────
      // Ya se bajan ~35 sesiones para el promedio de volumen. Calcular el
      // retorno a 5 días y a ~1 mes acá no cuesta una request más, y sin ellos
      // el screener declaraba filtros (`ret_5d_min`, `ret_1m_min`) que NO
      // estaban implementados: el modelo los pedía, el harness los ignoraba en
      // silencio, y la respuesta se leía como si el filtro hubiera corrido.
      const retorno = (n) => {
        const base = cerradas[cerradas.length - 1 - n];
        const c0 = base && Number(base.c);
        return Number.isFinite(c0) && c0 > 0 ? +(((price - c0) / c0) * 100).toFixed(2) : null;
      };
      out[String(sym).toUpperCase()] = {
        price: +price.toFixed(4),
        dollarVolume: dvs.length ? Math.round(dvs.reduce((a, b) => a + b, 0) / dvs.length) : null,
        ret_5d: retorno(5),
        ret_1m: retorno(RET_1M_SESIONES),
        // Cuántas velas cerradas hubo de verdad. Un `ret_1m: null` con
        // `sessions: 22` sería un bug nuestro; con `sessions: 8` es una acción
        // que cotiza hace ocho sesiones. Sin este número no se distinguen.
        sessions: cerradas.length,
        sessions_volumen: Math.min(days, cerradas.length),
      };
    }
  }
  return out;
}

// ── MÁXIMOS Y MÍNIMOS DE 52 SEMANAS ─────────────────────────────────
// Se calculan con barras SEMANALES, no diarias, y eso NO pierde precisión: el
// high de una barra semanal ES el máximo de sus cinco días, así que el máximo
// de 52 semanas sale exacto. Lo que cambia es el costo — 52 barras por símbolo
// en vez de ~250. Con ~150 nombres eso es la diferencia entre una llamada que
// cabe en el buffet y una que no.
//
// LA BARRA VIVA SE EXCLUYE (point-in-time). La semana en curso todavía se está
// formando: incluirla haría que un nombre "marque nuevo máximo" contra un
// máximo que incluye el precio de este momento, o sea contra sí mismo.
// Devuelve { SYMBOL: { high_52w, low_52w, last, pct_from_high, pct_from_low, weeks } }.
export async function getFiftyTwoWeek(symbols = [], { creds, now = new Date(), weeks = 52 } = {}) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return {};
  const feed = alpacaDataFeed();
  const start = new Date(now.getTime() - (weeks + 2) * 7 * 86400000).toISOString().slice(0, 10);
  const semanaViva = new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const out = {};
  for (const batch of chunk(wanted, DATA_CHUNK)) {
    const data = await alpacaDataFetch(
      `/v2/stocks/bars?symbols=${encodeURIComponent(batch.join(','))}&timeframe=1Week&start=${start}&limit=${(weeks + 2) * batch.length}&feed=${feed}`, creds);
    const bars = (data && data.bars) || {};
    for (const [sym, list] of Object.entries(bars)) {
      if (!Array.isArray(list) || !list.length) continue;
      const cerradas = list.filter((b) => b && String(b.t || '').slice(0, 10) < semanaViva).slice(-weeks);
      if (!cerradas.length) continue;
      const highs = cerradas.map((b) => Number(b.h)).filter(Number.isFinite);
      const lows = cerradas.map((b) => Number(b.l)).filter((v) => Number.isFinite(v) && v > 0);
      if (!highs.length || !lows.length) continue;
      const high = Math.max(...highs);
      const low = Math.min(...lows);
      // El último cierre COMPLETO, de la misma serie: comparar el máximo de
      // barras cerradas contra un precio vivo mezclaría dos relojes.
      const last = Number(cerradas[cerradas.length - 1].c);
      if (!Number.isFinite(last) || last <= 0) continue;
      out[String(sym).toUpperCase()] = {
        high_52w: +high.toFixed(4), low_52w: +low.toFixed(4), last: +last.toFixed(4),
        pct_from_high: +(((last - high) / high) * 100).toFixed(2),   // ≤ 0
        pct_from_low: +(((last - low) / low) * 100).toFixed(2),      // ≥ 0
        weeks: cerradas.length,
      };
    }
  }
  return out;
}

// ─────────────────── NOTICIAS (tablero B2 · herramientas B3) ───────────────────
// Alpaca sirve el feed de Benzinga en el host de datos. Se usa ESTE y no
// Finnhub para el tablero por una razón concreta: Alpaca devuelve las noticias
// de UNA LISTA de símbolos en UNA llamada, y el tablero necesita los titulares
// de ~600 nombres. Finnhub es por símbolo — 600 llamadas.
//
// Finnhub sigue siendo el respaldo POR TICKER (la herramienta `noticias` de B3),
// donde la pregunta es otra y una llamada alcanza.
//
// `symbols` vacío = el feed general del mercado. El `limit` es de Alpaca y tope
// 50 por página; acá NO se pagina a propósito — el tablero quiere los titulares
// de hoy, no el archivo.
// Tope de símbolos que caben en la URL sin que el servidor la rechace.
export const NEWS_SYMBOL_CAP = 100;

// `pages` > 1 pagina el feed con `next_page_token`. Existe para la búsqueda
// POR TEMA: el endpoint tope a 50 por página, y filtrar un tema sobre 50
// titulares y contestar "no hay noticias de Hormuz" es una afirmación fuerte
// sobre una muestra chica. Con 4 páginas son 200 y la respuesta significa algo.
export async function getNews({ symbols = [], limit = 50, start = null, creds, includeContent = false, pages = 1 } = {}) {
  const params = new URLSearchParams();
  const syms = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  // La URL tiene un largo máximo y ~600 símbolos no entran. Con más de
  // NEWS_SYMBOL_CAP se pide el feed GENERAL y se filtra del lado nuestro: es
  // preferible a mandar una URL que el servidor va a rechazar entera.
  if (syms.length && syms.length <= NEWS_SYMBOL_CAP) params.set('symbols', syms.join(','));
  params.set('limit', String(Math.max(1, Math.min(50, Math.floor(limit) || 50))));
  params.set('include_content', includeContent ? 'true' : 'false');
  params.set('exclude_contentless', 'true');
  if (start) params.set('start', start);
  const acumulado = [];
  let token = null;
  for (let i = 0; i < Math.max(1, Math.floor(pages) || 1); i++) {
    if (token) params.set('page_token', token); else params.delete('page_token');
    const data = await alpacaDataFetch('/v1beta1/news?' + params.toString(), creds);
    const pagina = (data && data.news) || [];
    if (Array.isArray(pagina)) acumulado.push(...pagina);
    token = (data && data.next_page_token) || null;
    if (!token) break;
  }
  const list = acumulado;
  return (Array.isArray(list) ? list : []).map((n) => ({
    id: n.id,
    headline: String(n.headline || '').trim(),
    summary: String(n.summary || '').trim(),
    source: n.source || null,
    created_at: n.created_at || n.updated_at || null,
    symbols: (n.symbols || []).map((x) => String(x).toUpperCase()),
    url: n.url || null,
  })).filter((n) => n.headline);
}


// ── METADATA DE ACTIVO (shortable / easy-to-borrow) ──────────────────
// R9 del reglamento de la T2 falla CERRADO: sin confirmación de que un nombre
// es shortable Y easy-to-borrow, el corto no se abre. Ese dato vive en
// /v2/assets/{symbol} del host de TRADING (no del de datos) y es por nombre:
// no hay endpoint multi-símbolo que lo devuelva sin bajar el catálogo entero
// (~11.000 activos), que es mucho más caro que pedir los pocos que importan.
//
// `easy_to_borrow` de Alpaca se recalcula una vez por día a la apertura, así
// que pedirlo más de una vez por día no trae nada nuevo — la caché por día vive
// un nivel más arriba (_lib/arena-meta.js).
//
// Un símbolo que no existe o que falla NO entra al mapa: R9 lo va a leer como
// "sin dato" y va a rechazar el corto, que es exactamente lo que tiene que
// pasar. Un default optimista acá sería un permiso inventado.
export async function getAssets(symbols = [], { creds, concurrency = 6 } = {}) {
  const wanted = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  const out = {};
  for (let i = 0; i < wanted.length; i += concurrency) {
    await Promise.all(wanted.slice(i, i + concurrency).map(async (sym) => {
      try {
        const a = await alpacaFetch('/v2/assets/' + encodeURIComponent(sym), { creds });
        if (!a || !a.symbol) return;
        out[String(a.symbol).toUpperCase()] = {
          shortable: a.shortable === true,
          easy_to_borrow: a.easy_to_borrow === true,
          tradable: a.tradable === true,
          fractionable: a.fractionable === true,
          exchange: a.exchange || null,
          status: a.status || null,
        };
      } catch (_) { /* ausente = sin dato = R9 rechaza. Ver el encabezado. */ }
    }));
  }
  return out;
}

// ── EL CATÁLOGO COMPLETO DE ACTIVOS (una sola request) ───────────────
// /v2/assets sin símbolo devuelve el catálogo entero: ~11.000 filas con
// `class`, `status`, `tradable`, `name`, `exchange` y `symbol`. Es UNA request
// para lo que de otro modo serían cientos de `/v2/assets/{symbol}`.
//
// POR QUÉ IMPORTA: el canal del día trae warrants, rights, preferentes y
// unidades mezclados con acciones comunes, y el sufijo del ticker NO alcanza
// para distinguirlos (Alpaca escribe warrants como `ABCDW`, sin separador, así
// que cualquier regex que exija un punto o un guion los deja pasar). Esta lista
// es la fuente AUTORITATIVA: dice qué es cada símbolo y si se puede operar.
//
// También sirve de padrón de símbolos válidos: un ticker que no está acá no se
// puede comprar, venga de donde venga.
//
// El caller lo cachea por día (_lib/arena-instrumento.js). Acá no se cachea
// nada: este módulo habla con Alpaca y no sabe de Neon.
export async function getAllAssets({ creds, status = 'active', assetClass = 'us_equity' } = {}) {
  const qs = new URLSearchParams({ status, asset_class: assetClass });
  const data = await alpacaFetch('/v2/assets?' + qs.toString(), { creds });
  return Array.isArray(data) ? data : [];
}
