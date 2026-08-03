// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/macro-markets (batch del tab MACRO) con fetch
// mockeado — sin red. Correr con `node tests/macro-markets.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { MACRO_SYMBOLS, EQUITY_SYMBOLS, ALL_SYMBOLS, extractMacro, mxPrecision } from '../api/macro-markets.js';

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
// timestamps paralelos a los cierres (unix s, diarios) — extractMacro los
// necesita para la serie; sin ellos el punto se descarta.
function chartResponse(meta, closes) {
  const c = closes || [];
  const ts = c.map((_, i) => 1700000000 + i * 86400);
  return { ok: true, json: async () => ({ chart: { result: [{
    meta, timestamp: ts, indicators: { quote: [{ close: c }] } }] } }) };
}
function rawChart(meta, closes) {
  const ts = closes.map((_, i) => 1700000000 + i * 86400);
  return { chart: { result: [{ meta, timestamp: ts, indicators: { quote: [{ close: closes }] } }] } };
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

console.log('EQUITY_SYMBOLS: bloque de riesgo unificado en el mismo batch');
{
  ok(['SPY','QQQ','GLD','TLT','NVDA','TSLA'].every(s => EQUITY_SYMBOLS.includes(s)), 'US incluido');
  ok(['BTC-USD','ETH-USD','SOL-USD','BNB-USD'].every(s => EQUITY_SYMBOLS.includes(s)),
    'cripto en forma Yahoo (BTC-USD), no BTC/USD');
  ok(['MELI','NU','GLOB','AMXB.MX'].every(s => EQUITY_SYMBOLS.includes(s)), 'ADRs LATAM');
  ok(ALL_SYMBOLS.length === MACRO_SYMBOLS.length + EQUITY_SYMBOLS.length &&
     new Set(ALL_SYMBOLS).size === ALL_SYMBOLS.length, 'ALL_SYMBOLS = macro + equity, sin duplicados');
}

// ─────────────────── mxPrecision (bug euro plano) ───────────────────
console.log('mxPrecision: decimales por magnitud — el FX no se aplana');
{
  ok(mxPrecision(1.085) === 4, 'EUR/USD (~1.08) → 4 decimales, no 2');
  ok(mxPrecision(150.3) === 2, 'USD/JPY (~150) → 2 decimales');
  ok(mxPrecision(0.85) === 6, 'sub-paridad (<1) → 6 decimales');
  ok(mxPrecision(38500) === 2, 'índice grande → 2 decimales');
}

// ─────────────────── extractMacro ───────────────────
console.log('extractMacro: precio + cambio de sesión + serie con timestamps');
{
  const m = extractMacro(rawChart(
    { regularMarketPrice: 20, chartPreviousClose: 18.5, currency: 'USD' },
    [17, 18, 18.5, 19, 20]));
  ok(m && m.changePct === 8.11, 'VIX +8.11% (20 vs 18.5)', JSON.stringify(m));
  ok(m && m.price === 20 && m.prevClose === 18.5, 'expone precio y cierre previo');
  ok(m && Array.isArray(m.series) && m.series.length === 5, 'serie con los cierres diarios', JSON.stringify(m.series));
  ok(m && m.series[0].length === 2 && m.series[0][0] === 1700000000 && m.series[4][1] === 20,
    'cada punto es [t(unix s), cierre]', JSON.stringify(m.series[0]));
}

console.log('extractMacro: EUR/USD conserva precisión (no escalones)');
{
  // Cierres FX con moves en la 3ª decimal — con toFixed(2) colapsaban a 1.08.
  const m = extractMacro(rawChart(
    { regularMarketPrice: 1.0872, chartPreviousClose: 1.0850 },
    [1.0840, 1.0852, 1.0861, 1.0858, 1.0872]));
  const vals = m.series.map(p => p[1]);
  ok(new Set(vals).size === 5, '5 valores DISTINTOS (no aplanados a 1.08)', JSON.stringify(vals));
  ok(m.price === 1.0872 && m.prevClose === 1.085, 'precio/cierre con 4 decimales', m.price + '/' + m.prevClose);
  ok(m.changePct === 0.2, 'changePct real (+0.20%), no 0.00 por redondeo', m.changePct);
}

console.log('extractMacro: descarta huecos de sesión (close null / sin timestamp)');
{
  const closes = Array.from({ length: 40 }, (_, i) => i + 1);
  closes[3] = null; closes[7] = 0;
  const m = extractMacro(rawChart({ regularMarketPrice: 40, chartPreviousClose: 39 }, closes));
  ok(m && m.series.length === 38, 'huecos fuera (38 de 40)', m && m.series.length);
  ok(m && m.series.every(p => Number.isFinite(p[1]) && p[1] > 0 && Number.isFinite(p[0])),
    'sin nulls ni ceros, todo con timestamp');
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
    ok(u.includes('range=3mo') && u.includes('interval=1d'), 'pide range=3mo&interval=1d (serie 3M para toggles 1S/1M/3M)');
    if (u.includes('%5EVIX')) return chartResponse({ regularMarketPrice: 20, chartPreviousClose: 18.5 }, [18, 19, 20]);
    return chartResponse({ regularMarketPrice: 100, chartPreviousClose: 99 }, [98, 99, 100]);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  ok(res.code === 200, 'responde 200', res.code);
  ok(calls === ALL_SYMBOLS.length, 'un fetch por símbolo del universo (macro + equity)', calls);
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
