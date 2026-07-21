// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/candles (OHLC para el chart modal) con fetch
// mockeado — sin red. Correr con `node tests/candles.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, {
  INTERVALS, toBinanceSymbol, toYahooSymbol,
  extractYahooCandles, extractBinanceCandles,
} from '../api/candles.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}

// ─────────────────── mapeo de símbolos ───────────────────
console.log('toBinanceSymbol: solo el universo cripto de la app');
{
  ok(toBinanceSymbol('BTC/USD') === 'BTCUSDT', 'BTC/USD → BTCUSDT');
  ok(toBinanceSymbol('eth') === 'ETHUSDT', 'bare lowercase eth → ETHUSDT');
  ok(toBinanceSymbol('NVDA') === null, 'acción → null (va por Yahoo)');
  ok(toBinanceSymbol('WALMEX.MX') === null, 'BMV → null (va por Yahoo)');
  ok(toBinanceSymbol('MATIC/USD') === null, 'MATIC fuera del map (Binance retiró MATICUSDT) → Yahoo');
}
console.log('toYahooSymbol: mismo mapeo que /api/tape');
{
  ok(toYahooSymbol('MATIC/USD') === 'MATIC-USD', 'cripto no-Binance → formato Yahoo');
  ok(toYahooSymbol('FEMSAUBD.MX') === 'FEMSAUBD.MX', 'tickers LATAM pasan sin tocar');
}

// ─────────────────── extracción Yahoo ───────────────────
console.log('extractYahooCandles: OHLC real, filas incompletas fuera');
{
  const json = { chart: { result: [{ meta: { currency: 'MXN' },
    timestamp: [1000, 2000, 3000],
    indicators: { quote: [{
      open:  [10, null, 12], high: [11, 5, 13],
      low:   [9, 4, 11.5],   close: [10.5, 4.5, 12.75],
      volume:[100, 50, null],
    }] } }] } };
  const r = extractYahooCandles(json);
  ok(r && r.candles.length === 2, 'fila con open null descartada (2 de 3)', JSON.stringify(r));
  ok(r && r.candles[0].t === 1000 && r.candles[0].o === 10 && r.candles[0].c === 10.5, 'shape {t,o,h,l,c}');
  ok(r && r.candles[1].v === 0, 'volumen null → 0, nunca inventado');
  ok(r && r.currency === 'MXN', 'currency del meta (BMV en pesos)');
  ok(extractYahooCandles(null) === null, 'payload nulo → null');
  ok(extractYahooCandles({ chart: { result: [{}] } }) === null, 'sin timestamps → null');
}

// ─────────────────── extracción Binance ───────────────────
console.log('extractBinanceCandles: klines → {t,o,h,l,c,v} numéricos');
{
  const json = [
    [1700000000000, '50000.1', '50100', '49900', '50050.5', '12.5', 1700000059999],
    [1700000060000, '0', '1', '1', '1', '1'],           // open 0 → descartada
    'basura',                                            // fila no-array → descartada
  ];
  const r = extractBinanceCandles(json);
  ok(r && r.candles.length === 1, 'solo la vela válida sobrevive', JSON.stringify(r));
  ok(r && r.candles[0].t === 1700000000 && r.candles[0].o === 50000.1 && r.candles[0].v === 12.5,
    'openTime ms → unix seconds, strings → números');
  ok(extractBinanceCandles({ code: -1121 }) === null, 'error de Binance (objeto) → null');
  ok(extractBinanceCandles([]) === null, 'array vacío → null');
}

// ─────────────────── handler ───────────────────
const realFetch = global.fetch;

console.log('handler: validación de entrada (sin red)');
{
  global.fetch = async () => { throw new Error('no debería llamar a la red'); };
  const r1 = mockRes();
  await handler({ method: 'GET', query: {} }, r1);
  ok(r1.code === 400, 'sin symbol → 400', r1.code);
  const r2 = mockRes();
  await handler({ method: 'GET', query: { symbol: 'MELI', interval: '3m' } }, r2);
  ok(r2.code === 400, 'intervalo desconocido → 400 (jamás un fetch a ciegas)', r2.code);
}

console.log('handler: acción vía Yahoo con caché CDN por intervalo');
{
  let urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ chart: { result: [{ meta: { currency: 'USD' },
      timestamp: [1000], indicators: { quote: [{ open: [10], high: [11], low: [9], close: [10.5], volume: [7] }] } }] } }) };
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol: 'meli', interval: '1h' } }, res);
  ok(res.code === 200, 'responde 200', JSON.stringify(res.body));
  ok(urls.length === 1 && /query1\.finance\.yahoo\.com/.test(urls[0]), 'una sola llamada, a Yahoo', urls.join());
  ok(/interval=60m&range=1mo/.test(urls[0]), '1h → interval=60m range=1mo de Yahoo', urls[0]);
  ok(res.body.symbol === 'MELI' && res.body.source === 'yahoo' && res.body.candles.length === 1,
    'payload {symbol,source,candles}');
  ok(res.headers['Cache-Control'] === `public, s-maxage=${INTERVALS['1h'].smaxage}, stale-while-revalidate=${INTERVALS['1h'].swr}`,
    's-maxage del intervalo (CDN compartido entre usuarios)', res.headers['Cache-Control']);
}

console.log('handler: BMV pasa el sufijo .MX tal cual');
{
  let url = '';
  global.fetch = async (u) => { url = String(u);
    return { ok: true, json: async () => ({ chart: { result: [{ meta: { currency: 'MXN' },
      timestamp: [1000], indicators: { quote: [{ open: [10], high: [11], low: [9], close: [10.5], volume: [0] }] } }] } }) }; };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol: 'WALMEX.MX' } }, res);
  ok(/WALMEX\.MX/.test(url) && /interval=1d&range=1y/.test(url), 'Yahoo v8 con WALMEX.MX, default 1d/1y', url);
  ok(res.body && res.body.currency === 'MXN', 'currency MXN llega al cliente');
}

console.log('handler: cripto vía Binance (mirror de datos primero)');
{
  let urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ([[1700000000000, '50000', '50100', '49900', '50050', '12']]) };
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol: 'BTC/USD', interval: '5m' } }, res);
  ok(urls.length === 1 && /data-api\.binance\.vision\/api\/v3\/klines/.test(urls[0]),
    'primera opción: data-api.binance.vision', urls.join());
  ok(/symbol=BTCUSDT&interval=5m/.test(urls[0]), 'símbolo y intervalo de Binance', urls[0]);
  ok(res.code === 200 && res.body.source === 'binance' && res.body.currency === 'USD', 'payload binance OK');
}

console.log('handler: fallback a api.binance.com si el mirror falla');
{
  let urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    if (/binance\.vision/.test(String(url))) return { ok: false, status: 451 };
    return { ok: true, json: async () => ([[1700000000000, '3000', '3100', '2900', '3050', '5']]) };
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol: 'ETH' } }, res);
  ok(urls.length === 2 && /api\.binance\.com/.test(urls[1]), 'mirror caído → api.binance.com', urls.join(' | '));
  ok(res.code === 200 && res.body.candles.length === 1, 'las velas llegan igual');
}

console.log('handler: fallo honesto — jamás velas inventadas');
{
  global.fetch = async () => ({ ok: false, status: 429 });
  const res = mockRes();
  await handler({ method: 'GET', query: { symbol: 'MELI' } }, res);
  ok(res.code === 502 && /No candle data/.test(res.body.error), 'Yahoo 429 → 502 con error', JSON.stringify(res.body));
  ok(res.headers['Cache-Control'] === undefined, 'el fallo NO se cachea en CDN', res.headers['Cache-Control']);

  global.fetch = async () => { throw new Error('DNS down'); };
  const res2 = mockRes();
  await handler({ method: 'GET', query: { symbol: 'BTC' } }, res2);
  ok(res2.code === 502, 'red caída en ambos hosts de Binance → 502, nunca throw', res2.code);
}

global.fetch = realFetch;
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
