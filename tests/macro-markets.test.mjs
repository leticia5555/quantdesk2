// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/macro-markets (batch del tab MACRO) con fetch
// mockeado — sin red. Correr con `node tests/macro-markets.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { MACRO_SYMBOLS, extractMacro } from '../api/macro-markets.js';

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
function chartResponse(meta, closes) {
  return { ok: true, json: async () => ({ chart: { result: [{
    meta, indicators: { quote: [{ close: closes || [] }] } }] } }) };
}

// ─────────────────── universo de símbolos ───────────────────
console.log('MACRO_SYMBOLS: universo curado y coherente');
{
  ok(MACRO_SYMBOLS.includes('^VIX'), 'incluye el VIX');
  ok(MACRO_SYMBOLS.includes('^TNX') && MACRO_SYMBOLS.includes('^TYX'),
    'rendimientos 10Y (^TNX) y 30Y (^TYX)');
  ok(MACRO_SYMBOLS.includes('2YY=F'),
    'el 2Y usa el futuro de rendimiento CBOT (no hay ^index limpio en Yahoo)');
  ok(MACRO_SYMBOLS.includes('DX-Y.NYB') && MACRO_SYMBOLS.includes('JPY=X') && MACRO_SYMBOLS.includes('EURUSD=X'),
    'FX global: DXY, USD/JPY, EUR/USD');
  ok(MACRO_SYMBOLS.includes('CL=F') && MACRO_SYMBOLS.includes('BZ=F'), 'commodities: WTI + Brent');
  ok(['^N225','^KS11','^HSI','^GDAXI','^FTSE','^MXX','^BVSP'].every(s => MACRO_SYMBOLS.includes(s)),
    'índices globales por región (Asia/Europa/LATAM)');
  ok(['ES=F','NQ=F','YM=F'].every(s => MACRO_SYMBOLS.includes(s)), 'futuros EE.UU.');
  ok(new Set(MACRO_SYMBOLS).size === MACRO_SYMBOLS.length, 'sin duplicados');
}

// ─────────────────── extractMacro ───────────────────
console.log('extractMacro: precio + cambio de sesión + sparkline');
{
  const m = extractMacro({ chart: { result: [{
    meta: { regularMarketPrice: 20, chartPreviousClose: 18.5, currency: 'USD' },
    indicators: { quote: [{ close: [17, 18, 18.5, 19, 20] }] } }] } });
  ok(m && m.changePct === 8.11, 'VIX +8.11% (20 vs 18.5)', JSON.stringify(m));
  ok(m && m.price === 20 && m.prevClose === 18.5, 'expone precio y cierre previo');
  ok(m && Array.isArray(m.spark) && m.spark.length === 5, 'sparkline con los cierres diarios', JSON.stringify(m.spark));
}

console.log('extractMacro: descarta cierres inválidos y toma últimos 30');
{
  const closes = Array.from({ length: 40 }, (_, i) => i + 1);
  closes[3] = null; closes[7] = 0;
  const raw = { chart: { result: [{
    meta: { regularMarketPrice: 40, chartPreviousClose: 39 },
    indicators: { quote: [{ close: closes }] } }] } };
  const m = extractMacro(raw);
  ok(m && m.spark.length === 30, 'sparkline acotada a 30 puntos', m && m.spark.length);
  ok(m && m.spark.every(v => Number.isFinite(v) && v > 0), 'sin nulls ni ceros en la sparkline');
}

console.log('extractMacro: nunca inventa un +0.00%');
{
  ok(extractMacro(null) === null, 'payload nulo → null');
  ok(extractMacro({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } }) === null,
    'sin cierre previo → null');
  ok(extractMacro({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 0 } }] } }) === null,
    'cierre previo 0 → null (no divide por cero)');
  ok(extractMacro({ chart: { result: [{ meta: { chartPreviousClose: 100 } }] } }) === null,
    'sin precio actual → null');
}

// ─────────────────── handler batched ───────────────────
const realFetch = global.fetch;

console.log('handler: batch feliz sobre el universo fijo');
{
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const u = String(url);
    ok(u.includes('range=1mo') && u.includes('interval=1d'), 'pide range=1mo&interval=1d (spark + meta en 1 fetch)');
    if (u.includes('%5EVIX')) return chartResponse({ regularMarketPrice: 20, chartPreviousClose: 18.5 }, [18, 19, 20]);
    return chartResponse({ regularMarketPrice: 100, chartPreviousClose: 99 }, [98, 99, 100]);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  ok(res.code === 200, 'responde 200', res.code);
  ok(calls === MACRO_SYMBOLS.length, 'un fetch por símbolo del universo', calls);
  ok(res.body.data['^VIX'] && res.body.data['^VIX'].changePct === 8.11, 'VIX indexado por su símbolo Yahoo', JSON.stringify(res.body.data['^VIX']));
  ok(/s-maxage=\d+/.test(res.headers['Cache-Control'] || ''), 'setea caché CDN compartida', res.headers['Cache-Control']);
}

console.log('handler: Yahoo caído parcial o total');
{
  global.fetch = async (url) => {
    if (String(url).includes('%5EVIX')) throw new Error('yahoo caído');
    return chartResponse({ regularMarketPrice: 100, chartPreviousClose: 99 }, [99, 100]);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  ok(res.code === 200 && !('^VIX' in res.body.data) && Object.keys(res.body.data).length > 0,
    'símbolo caído se omite, el resto llega (sin +0.0%)', Object.keys(res.body.data).length);

  global.fetch = async () => { throw new Error('yahoo caído'); };
  const res2 = mockRes();
  await handler({ method: 'GET', query: {} }, res2);
  ok(res2.code === 200 && Object.keys(res2.body.data).length === 0,
    'todo caído → 200 con data vacía (el cliente omite las tarjetas)');
}

console.log('handler: OPTIONS (CORS preflight)');
{
  global.fetch = async () => { throw new Error('no debería llamar a la red'); };
  const res = mockRes();
  await handler({ method: 'OPTIONS', query: {} }, res);
  ok(res.code === 200, 'preflight → 200 sin red');
}

global.fetch = realFetch;
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
