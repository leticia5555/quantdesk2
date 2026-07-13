// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/ticker-search (búsqueda + check de liquidez) con
// fetch mockeado — sin red. Correr con `node tests/ticker-search.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { liquidityCheck, ADV_THRESHOLD_USD } from '../api/ticker-search.js';

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
const realFetch = global.fetch;

// ─────────────────── modo búsqueda ───────────────────
console.log('búsqueda: mapeo y filtrado de Yahoo');
{
  global.fetch = async (url) => {
    ok(String(url).includes('quotesCount=8') && String(url).includes('q=fems'), 'llama al search de Yahoo con la query');
    return { ok: true, json: async () => ({ quotes: [
      { symbol: 'FEMSAUBD.MX', shortname: 'Fomento Economico Mexicano', exchDisp: 'Mexico', quoteType: 'EQUITY' },
      { symbol: 'FMX', longname: 'Fomento Economico Mexicano ADR', exchDisp: 'NYSE', quoteType: 'EQUITY' },
      { symbol: 'FEMS-FUT', shortname: 'Futuro raro', quoteType: 'FUTURE' },   // filtrado
      { symbol: null, shortname: 'basura', quoteType: 'EQUITY' },              // filtrado
    ] }) };
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { q: 'fems' } }, res);
  ok(res.code === 200 && res.body.results.length === 2, 'filtra FUTURE y símbolos nulos', JSON.stringify(res.body));
  const r0 = res.body.results[0];
  ok(r0.symbol === 'FEMSAUBD.MX' && r0.name.includes('Fomento') && r0.exchange === 'Mexico',
    'símbolo exacto + nombre + bolsa', JSON.stringify(r0));
  ok(res.body.results[1].name.includes('ADR'), 'usa longname cuando no hay shortname');
}

console.log('búsqueda: robustez');
{
  const res = mockRes();
  await handler({ method: 'GET', query: { q: '' } }, res);
  ok(res.code === 200 && res.body.results.length === 0, 'query vacía → lista vacía sin llamar a Yahoo');

  global.fetch = async () => { throw new Error('yahoo caído'); };
  const res2 = mockRes();
  await handler({ method: 'GET', query: { q: 'nvda' } }, res2);
  ok(res2.code === 200 && res2.body.results.length === 0, 'Yahoo caído → 200 con lista vacía (el input nunca se rompe)');
}

// ─────────────────── modo liquidez ───────────────────
function chartResponse(closes, volumes, currency) {
  return { ok: true, json: async () => ({ chart: { result: [{
    meta: { currency }, indicators: { quote: [{ close: closes, volume: volumes }] } }] } }) };
}

console.log('liquidez: ADV en USD y umbral de $1M');
{
  // 60 días de $50 × 1M títulos = $50M/día → líquido
  global.fetch = async (url) => chartResponse(Array(60).fill(50), Array(60).fill(1_000_000), 'USD');
  let out = await liquidityCheck('AAPL');
  ok(out.illiquid === false && out.adv_usd === 50_000_000, 'ticker líquido: illiquid=false', JSON.stringify(out));

  // $2 × 100k títulos = $200k/día → ilíquido
  global.fetch = async () => chartResponse(Array(60).fill(2), Array(60).fill(100_000), 'USD');
  out = await liquidityCheck('CHIQUITA');
  ok(out.illiquid === true && out.adv_usd === 200_000 && out.threshold_usd === ADV_THRESHOLD_USD,
    'ticker ilíquido: illiquid=true bajo $1M', JSON.stringify(out));

  // crypto: BTC se mapea a BTC-USD como en los motores
  let urlSeen = null;
  global.fetch = async (url) => { urlSeen = String(url); return chartResponse(Array(60).fill(60000), Array(60).fill(1000), 'USD'); };
  out = await liquidityCheck('BTC');
  ok(urlSeen.includes('BTC-USD'), 'crypto: BTC → BTC-USD en el chart');
}

console.log('liquidez: conversión FX para .MX');
{
  // 40M MXN/día × 0.055 = $2.2M USD → líquido. La segunda llamada es el FX.
  global.fetch = async (url) => {
    if (String(url).includes('MXNUSD')) {
      return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 0.055 } }] } }) };
    }
    return chartResponse(Array(60).fill(400), Array(60).fill(100_000), 'MXN');
  };
  const out = await liquidityCheck('WALMEX.MX');
  ok(out.currency === 'MXN' && out.adv_local === 40_000_000, 'ADV local en MXN', JSON.stringify(out));
  ok(out.adv_usd === 2_200_000 && out.illiquid === false, 'convertido a USD con el FX spot → líquido');

  // Sin FX disponible: no se acusa sin evidencia
  global.fetch = async (url) => {
    if (String(url).includes('ARSUSD')) return { ok: false, json: async () => ({}) };
    return chartResponse(Array(60).fill(400), Array(60).fill(100), 'ARS');
  };
  const out2 = await liquidityCheck('YPFD.BA');
  ok(out2.illiquid === null && out2.adv_usd === null, 'sin FX → illiquid=null (no se acusa)', JSON.stringify(out2));
}

console.log('liquidez: datos insuficientes');
{
  global.fetch = async () => chartResponse([10, 10, null], [0, null, 5], 'USD');
  const out = await liquidityCheck('ZOMBIE');
  ok(out.illiquid === null, 'menos de 5 barras con volumen → illiquid=null', JSON.stringify(out));

  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const out2 = await liquidityCheck('NOEXISTE');
  ok(out2.illiquid === null && out2.error, 'ticker inexistente → illiquid=null con error');
}

global.fetch = realFetch;
console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
