// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/tape (quotes batched para la cinta) con fetch
// mockeado — sin red. Correr con `node tests/tape.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { toYahooSymbol, extractQuote } from '../api/tape.js';

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
function chartResponse(meta) {
  return { ok: true, json: async () => ({ chart: { result: [{ meta }] } }) };
}

// ─────────────────── mapeo de símbolos ───────────────────
console.log('toYahooSymbol: mapea al formato de Yahoo');
{
  ok(toYahooSymbol('BTC/USD') === 'BTC-USD', 'cripto BTC/USD → BTC-USD');
  ok(toYahooSymbol('eth/usd') === 'ETH-USD', 'lowercase también se normaliza');
  ok(toYahooSymbol(' nvda ') === 'NVDA', 'trim + uppercase para acciones');
  ok(toYahooSymbol('FEMSAUBD.MX') === 'FEMSAUBD.MX', 'tickers LATAM pasan sin tocar');
}

// ─────────────────── cálculo del cambio intradía ───────────────────
console.log('extractQuote: % = precio actual vs previous close');
{
  const q = extractQuote({ chart: { result: [{ meta: {
    regularMarketPrice: 190.00, chartPreviousClose: 185.25 } }] } });
  ok(q && q.changePct === 2.56, 'usa regularMarketPrice vs chartPreviousClose (+2.56%)', JSON.stringify(q));
  ok(q && q.price === 190 && q.prevClose === 185.25, 'expone precio y previous close');

  const q2 = extractQuote({ chart: { result: [{ meta: {
    regularMarketPrice: 100, regularMarketPreviousClose: 104, chartPreviousClose: 50 } }] } });
  ok(q2 && q2.changePct === -3.85, 'prefiere regularMarketPreviousClose cuando existe', JSON.stringify(q2));

  const q3 = extractQuote({ chart: { result: [{ meta: {
    regularMarketPrice: 118000, chartPreviousClose: 115000 } }] } });
  ok(q3 && q3.changePct === 2.61, 'cripto: previous close de Yahoo (cambio 24h)', JSON.stringify(q3));
}

console.log('extractQuote: nunca inventa un +0.00%');
{
  ok(extractQuote(null) === null, 'payload nulo → null');
  ok(extractQuote({ chart: { result: [] } }) === null, 'sin result → null');
  ok(extractQuote({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } }) === null,
    'sin previous close → null (la cinta conserva el último valor)');
  ok(extractQuote({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 0 } }] } }) === null,
    'previous close 0 → null (no divide por cero)');
  ok(extractQuote({ chart: { result: [{ meta: { chartPreviousClose: 100 } }] } }) === null,
    'sin precio actual → null');
}

// ─────────────────── handler batched ───────────────────
const realFetch = global.fetch;

console.log('handler: batch feliz');
{
  global.fetch = async (url) => {
    const u = String(url);
    ok(u.includes('range=1d'), 'pide range=1d (previous close = sesión anterior)');
    if (u.includes('NVDA')) return chartResponse({ regularMarketPrice: 190, chartPreviousClose: 185.25 });
    if (u.includes('BTC-USD')) return chartResponse({ regularMarketPrice: 118000, chartPreviousClose: 115000 });
    return { ok: false };
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbols: 'NVDA,BTC/USD' } }, res);
  ok(res.code === 200, 'responde 200', res.code);
  ok(res.body.quotes.NVDA && res.body.quotes.NVDA.changePct === 2.56, 'NVDA con % intradía', JSON.stringify(res.body));
  ok(res.body.quotes['BTC/USD'] && res.body.quotes['BTC/USD'].changePct === 2.61,
    'la respuesta se indexa por el símbolo original (BTC/USD), no el de Yahoo');
}

console.log('handler: Yahoo caído parcial o total');
{
  global.fetch = async (url) => {
    if (String(url).includes('AAPL')) throw new Error('yahoo caído');
    return chartResponse({ regularMarketPrice: 190, chartPreviousClose: 185.25 });
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { symbols: 'NVDA,AAPL' } }, res);
  ok(res.code === 200 && res.body.quotes.NVDA && !('AAPL' in res.body.quotes),
    'símbolo caído se omite (sin +0.0%), el resto llega', JSON.stringify(res.body.quotes));

  global.fetch = async () => { throw new Error('yahoo caído'); };
  const res2 = mockRes();
  await handler({ method: 'GET', query: { symbols: 'NVDA,AAPL' } }, res2);
  ok(res2.code === 200 && Object.keys(res2.body.quotes).length === 0,
    'todo caído → 200 con quotes vacío (la cinta conserva los últimos valores)');
}

console.log('handler: validación de entrada');
{
  global.fetch = async () => { throw new Error('no debería llamar a la red'); };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  ok(res.code === 400, 'sin symbols → 400');

  let calls = 0;
  global.fetch = async () => { calls++; return chartResponse({ regularMarketPrice: 10, chartPreviousClose: 9 }); };
  const res2 = mockRes();
  await handler({ method: 'GET', query: { symbols: 'nvda, NVDA ,,aapl' } }, res2);
  ok(calls === 2 && res2.body.quotes.NVDA && res2.body.quotes.AAPL,
    'dedup + trim + uppercase: 2 llamadas para "nvda, NVDA ,,aapl"', calls);

  calls = 0;
  const many = Array.from({ length: 30 }, (_, i) => 'T' + i).join(',');
  const res3 = mockRes();
  await handler({ method: 'GET', query: { symbols: many } }, res3);
  ok(calls === 20, 'cap de 20 símbolos por request', calls);
}

global.fetch = realFetch;
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
