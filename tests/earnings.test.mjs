// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/earnings (modo calendario): enriquecimiento con el
// symbol map de Finnhub (/stock/symbol?exchange=US, free tier) + title-case
// del description. Fetch mockeado — sin red. Correr con
// `node tests/earnings.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { titleCaseName, getSymbolMap, getSymbolTypes, getSymbolTypeStats, _resetSymbolMapCache } from '../api/earnings.js';

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
function jsonResponse(obj, okFlag = true) {
  return { ok: okFlag, status: okFlag ? 200 : 500,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj };
}
const realFetch = global.fetch;
const realKey = process.env.FINNHUB_API_KEY;
process.env.FINNHUB_API_KEY = 'test-key';

// Fechas dinámicas (el date-lint prohíbe literales incluso donde no aplica)
const iso = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

// ─────────────────── title-case ───────────────────
console.log('titleCaseName: descriptions en MAYÚSCULAS de Finnhub');
{
  ok(titleCaseName('APPLE INC') === 'Apple Inc', 'APPLE INC → Apple Inc', titleCaseName('APPLE INC'));
  ok(titleCaseName('AMC ENTERTAINMENT HOLDINGS INC') === 'Amc Entertainment Holdings Inc',
    'AMC ENTERTAINMENT HOLDINGS INC → title-case', titleCaseName('AMC ENTERTAINMENT HOLDINGS INC'));
  ok(titleCaseName('AMAZON.COM INC') === 'Amazon.com Inc', '.COM queda .com', titleCaseName('AMAZON.COM INC'));
  ok(titleCaseName('ALPHABET INC-CL A') === 'Alphabet Inc-Cl A', 'guiones y clase de acción', titleCaseName('ALPHABET INC-CL A'));
  ok(titleCaseName('ISHARES CORE S&P 500 ETF') === 'Ishares Core S&P 500 ETF',
    'S&P conserva mayúsculas por letra suelta y ETF por allowlist', titleCaseName('ISHARES CORE S&P 500 ETF'));
  ok(titleCaseName('GRUPO AEROPORTUARIO SA ADR') === 'Grupo Aeroportuario SA ADR',
    'siglas societarias (SA, ADR) se conservan', titleCaseName('GRUPO AEROPORTUARIO SA ADR'));
  ok(titleCaseName('Apple Inc.') === 'Apple Inc.', 'nombre ya mixto se respeta tal cual');
  ok(titleCaseName('') === null && titleCaseName(null) === null && titleCaseName('   ') === null,
    'vacío/null/espacios → null');
}

// ─────────────────── enriquecimiento del calendario ───────────────────
console.log('calendario: company desde el symbol map');
{
  _resetSymbolMapCache();
  let symbolCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stock/symbol')) {
      symbolCalls++;
      ok(u.includes('exchange=US'), 'pide el universo US al symbol endpoint');
      return jsonResponse([
        { symbol: 'AMC', description: 'AMC ENTERTAINMENT HOLDINGS INC' },
        { symbol: 'AAPL', description: 'APPLE INC' },
        { symbol: 'NONAME', description: '' },        // sin description → fuera del map
      ]);
    }
    if (u.includes('/calendar/earnings')) {
      return jsonResponse({ earningsCalendar: [
        { symbol: 'AMC', date: iso(2), hour: 'amc', epsEstimate: null },
        { symbol: 'ZZFOREIGN', date: iso(3), hour: 'bmo', epsEstimate: 1.2 },
      ] });
    }
    throw new Error('fetch inesperado: ' + u);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { from: iso(0), to: iso(7) } }, res);
  ok(res.code === 200 && res.body.earnings.length === 2, 'calendario responde con los 2 eventos', JSON.stringify(res.body));
  const amc = res.body.earnings.find((e) => e.ticker === 'AMC');
  const zz = res.body.earnings.find((e) => e.ticker === 'ZZFOREIGN');
  ok(amc && amc.company === 'Amc Entertainment Holdings Inc', 'AMC llega con company title-cased', JSON.stringify(amc));
  ok(zz && zz.company === null, 'símbolo fuera del map → company null (se omite, no se inventa)', JSON.stringify(zz));

  // segundo request: el map sale del cache de instancia (TTL 24h) → 0
  // llamadas nuevas a /stock/symbol
  const res2 = mockRes();
  await handler({ method: 'GET', query: { from: iso(0), to: iso(7) } }, res2);
  ok(symbolCalls === 1 && res2.body.earnings[0].company != null,
    'cache 24h: 2 renders = 1 sola llamada al symbol endpoint', symbolCalls + ' llamadas');
}

// ─────────────────── filtro mega-cap (?mega=1, calendario de /hoy) ───────────────────
console.log('calendario: ?mega=1 filtra a mega-caps curadas');
{
  _resetSymbolMapCache();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stock/symbol')) {
      return jsonResponse([
        { symbol: 'NVDA', description: 'NVIDIA CORP' },
        { symbol: 'AAPL', description: 'APPLE INC' },
        { symbol: 'NU', description: 'NU HOLDINGS LTD' },
      ]);
    }
    if (u.includes('/calendar/earnings')) {
      return jsonResponse({ earningsCalendar: [
        { symbol: 'NVDA', date: iso(2), hour: 'amc', epsEstimate: 1.0 },   // mega
        { symbol: 'ZZTINYCO', date: iso(2), hour: 'bmo', epsEstimate: 0.1 }, // NO mega
        { symbol: 'NU', date: iso(4), hour: 'amc', epsEstimate: 0.1 },      // mega (ADR LATAM)
        { symbol: 'AAPL', date: iso(5), hour: 'amc', epsEstimate: 2.0 },    // mega
      ] });
    }
    throw new Error('fetch inesperado: ' + u);
  };
  const resM = mockRes();
  await handler({ method: 'GET', query: { from: iso(0), to: iso(7), mega: '1' } }, resM);
  const syms = (resM.body.earnings || []).map((e) => e.ticker).sort();
  ok(resM.code === 200 && syms.length === 3, '?mega=1 devuelve solo las 3 mega-caps', JSON.stringify(syms));
  ok(!syms.includes('ZZTINYCO'), 'descarta el small-cap fuera del set curado', JSON.stringify(syms));
  ok(syms.includes('NU'), 'conserva el ADR LATAM (NU) del set curado', JSON.stringify(syms));

  // sin mega: el mismo calendario devuelve los 4
  const resAll = mockRes();
  await handler({ method: 'GET', query: { from: iso(0), to: iso(7) } }, resAll);
  ok((resAll.body.earnings || []).length === 4, 'sin ?mega=1 pasa el calendario completo (4)', (resAll.body.earnings || []).length);
}

console.log('calendario: robustez cuando el symbol endpoint falla');
{
  _resetSymbolMapCache();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stock/symbol')) throw new Error('finnhub 429');
    if (u.includes('/calendar/earnings')) {
      return jsonResponse({ earningsCalendar: [{ symbol: 'AMC', date: iso(2), hour: 'amc', epsEstimate: null }] });
    }
    throw new Error('fetch inesperado: ' + u);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { from: iso(0), to: iso(7) } }, res);
  ok(res.code === 200 && res.body.earnings.length === 1 && res.body.earnings[0].company === null,
    'symbol map caído → calendario sale igual con company null', JSON.stringify(res.body));

  // el fallo NO se cachea: la siguiente llamada reintenta y puebla el map
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stock/symbol')) return jsonResponse([{ symbol: 'AMC', description: 'AMC ENTERTAINMENT HOLDINGS INC' }]);
    return jsonResponse({ earningsCalendar: [{ symbol: 'AMC', date: iso(2), hour: 'amc', epsEstimate: null }] });
  };
  const map = await getSymbolMap('test-key');
  ok(map && map.AMC === 'Amc Entertainment Holdings Inc', 'tras el fallo, el retry puebla el map', JSON.stringify(map));
}

// ─────────────────── tipos de instrumento (gate de universo) ───────────────────
console.log('symbol map: types + cobertura (mismo fetch que el name map)');
{
  _resetSymbolMapCache();
  let symbolCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stock/symbol')) {
      symbolCalls++;
      return jsonResponse([
        { symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
        { symbol: 'NU', description: 'NU HOLDINGS LTD', type: 'ADR' },
        { symbol: 'SPY', description: 'SPDR S&P 500 ETF TRUST', type: 'ETP' },
        { symbol: 'PDI', description: 'PIMCO DYNAMIC INCOME FUND', type: 'Closed-End Fund' },
        { symbol: 'OEFX', description: 'SAMPLE OPEN END FUND', type: 'Open-End Fund' },
        { symbol: 'ACMEU', description: 'ACME CORP UNIT', type: 'Unit' },
        { symbol: 'PUBX', description: 'MYSTERY PUBLIC CO', type: 'PUBLIC' },
        { symbol: 'NOTYPE', description: 'Mystery Co' },  // sin type → no entra a types
      ]);
    }
    throw new Error('fetch inesperado: ' + u);
  };
  const types = await getSymbolTypes('test-key');
  ok(types && types.AAPL === 'Common Stock' && types.NU === 'ADR' && types.SPY === 'ETP', 'getSymbolTypes mapea symbol→type', JSON.stringify(types));
  ok(types && types.NOTYPE === undefined, 'símbolo sin type no entra al mapa de tipos');
  // getSymbolMap reusa el MISMO fetch/cache → no dispara otra llamada
  const map = await getSymbolMap('test-key');
  ok(symbolCalls === 1 && map.AAPL === 'Apple Inc', 'name map y types comparten un solo fetch', symbolCalls + ' llamadas');
  const stats = await getSymbolTypeStats('test-key');
  ok(stats && stats.total === 8 && stats.populated === 7 && stats.populated_pct === 87.5,
    'stats de cobertura: 7/8 con type = 87.5%', JSON.stringify(stats));
  // would_exclude suma fondos (ETP+CEF+OEF) + no-equity (Unit + PUBLIC) = 5.
  // PUBLIC entró a la exclusión: las muestras en prod fueron preferentes/baby bonds.
  ok(stats && stats.would_exclude === 5 && stats.distribution['Open-End Fund'] === 1 && stats.distribution.PUBLIC === 1,
    'would_exclude refleja la política real (fondos + no-equity, incl. PUBLIC)', JSON.stringify(stats));
  // samples: ejemplos por tipo para inspeccionar (p.ej. PUBLIC)
  ok(stats && Array.isArray(stats.samples.PUBLIC) && stats.samples.PUBLIC[0].symbol === 'PUBX' && stats.samples.PUBLIC[0].name === 'Mystery Public Co',
    'samples trae tickers de ejemplo por tipo (con nombre)', JSON.stringify(stats.samples.PUBLIC));
}

// ─────────────────── diag handler: ?sample=N (cap por tipo) ───────────────────
console.log('diag symboltypes: handler + parámetro sample');
{
  _resetSymbolMapCache();
  global.fetch = async (url) => {
    if (String(url).includes('/stock/symbol')) return jsonResponse([
      { symbol: 'PUB1', description: 'PUB ONE', type: 'PUBLIC' },
      { symbol: 'PUB2', description: 'PUB TWO', type: 'PUBLIC' },
      { symbol: 'PUB3', description: 'PUB THREE', type: 'PUBLIC' },
      { symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
    ]);
    throw new Error('fetch inesperado: ' + String(url));
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { diag: 'symboltypes', sample: '2' } }, res);
  ok(res.code === 200 && res.body.samples.PUBLIC.length === 2, 'diag respeta ?sample=2 (cap por tipo)', JSON.stringify(res.body && res.body.samples));
  ok(res.headers['Cache-Control'] === 'no-store', 'diag en vivo (no-store)');
  const res2 = mockRes();
  await handler({ method: 'GET', query: { diag: 'symboltypes' } }, res2);
  ok(res2.body.samples.PUBLIC.length === 3, 'sin param → default 30 trae los 3 PUBLIC disponibles', JSON.stringify(res2.body && res2.body.samples));
}

// ─────────────────── ficha ?ticker= : IPO sin historial de EPS ───────────────────
// Bug: una IPO que aún no reporta su 1er trimestre no tiene stock/earnings, y la
// rama ?ticker= cortaba en seco con history:[] SIN calcular next_earnings — la
// ficha nunca mostraba el próximo reporte. Fix: el próximo sale del calendario
// aunque no haya historial (y aunque el estimate venga null en el free tier).
console.log('ficha ?ticker=: IPO sin historial igual devuelve next_earnings');
{
  // dispatcher común: stock/earnings vacío, yahoo/financials no-ok, calendario con SPCX.
  const mkFetch = (calendarEntry) => async (url) => {
    const u = String(url);
    if (u.includes('/stock/earnings')) return jsonResponse([]);                 // sin historial de EPS
    if (u.includes('query1.finance.yahoo.com')) return jsonResponse({}, false); // sin precios
    if (u.includes('/stock/financials-reported')) return jsonResponse({}, false);
    if (u.includes('/calendar/earnings')) return jsonResponse({ earningsCalendar: calendarEntry });
    throw new Error('fetch inesperado: ' + u);
  };

  // Caso 1: calendario trae SPCX con estimate → next_earnings poblado, sin error.
  global.fetch = mkFetch([
    { symbol: 'SPCX', date: iso(1), hour: 'amc', epsEstimate: 0.42, revenueEstimate: 1.2e10, quarter: 2, year: 2026 }, // date-lint-ok: iso() calcula la fecha en runtime
  ]);
  const r1 = mockRes();
  await handler({ method: 'GET', query: { ticker: 'SPCX' } }, r1);
  ok(r1.code === 200 && Array.isArray(r1.body.history) && r1.body.history.length === 0, 'sin historial → history:[]', JSON.stringify(r1.body && r1.body.history));
  ok(r1.body.next_earnings && r1.body.next_earnings.date === iso(1), 'next_earnings sale del calendario aunque no haya historial', JSON.stringify(r1.body.next_earnings));
  ok(r1.body.next_earnings && r1.body.next_earnings.eps_estimate === 0.42 && r1.body.next_earnings.time === 'After market close', 'next_earnings conserva estimate y traduce hour=amc', JSON.stringify(r1.body.next_earnings));
  ok(!('error' in r1.body) || r1.body.error === undefined, 'con próximo confirmado NO se marca error', JSON.stringify(r1.body.error));

  // Caso 2: mismo escenario pero estimate null (free tier) → el próximo SIGUE saliendo.
  _resetSymbolMapCache();
  global.fetch = mkFetch([
    { symbol: 'SPCX', date: iso(1), hour: 'bmo', epsEstimate: null }, // date-lint-ok: iso() calcula la fecha en runtime
  ]);
  const r2 = mockRes();
  await handler({ method: 'GET', query: { ticker: 'SPCX' } }, r2);
  ok(r2.body.next_earnings && r2.body.next_earnings.date === iso(1) && r2.body.next_earnings.eps_estimate === null,
    'estimate null no descarta el próximo (no se filtra por epsEstimate)', JSON.stringify(r2.body.next_earnings));

  // Caso 3: sin historial Y sin próximo en el calendario → next_earnings null + error informativo.
  global.fetch = mkFetch([]);
  const r3 = mockRes();
  await handler({ method: 'GET', query: { ticker: 'ZZNOPE' } }, r3);
  ok(r3.body.history.length === 0 && r3.body.next_earnings === null && typeof r3.body.error === 'string',
    'sin historial y sin próximo → next_earnings null + error', JSON.stringify(r3.body));
}

// ─────────────────── ?mega=1 incluye SPCX (calendario /hoy) ───────────────────
console.log('calendario: ?mega=1 conserva SPCX (primer earnings post-IPO)');
{
  _resetSymbolMapCache();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/stock/symbol')) return jsonResponse([{ symbol: 'SPCX', description: 'SPACEX INC' }]);
    if (u.includes('/calendar/earnings')) return jsonResponse({ earningsCalendar: [
      { symbol: 'SPCX', date: iso(1), hour: 'amc', epsEstimate: 0.42 },   // mega (IPO reciente) // date-lint-ok: iso() runtime
      { symbol: 'ZZTINYCO', date: iso(1), hour: 'bmo', epsEstimate: 0.1 }, // NO mega // date-lint-ok: iso() runtime
    ] });
    throw new Error('fetch inesperado: ' + u);
  };
  const resMega = mockRes();
  await handler({ method: 'GET', query: { from: iso(0), to: iso(7), mega: '1' } }, resMega);
  const syms = (resMega.body.earnings || []).map((e) => e.ticker);
  ok(resMega.code === 200 && syms.includes('SPCX') && !syms.includes('ZZTINYCO'),
    'SPCX está en MEGA_CAPS: ?mega=1 lo conserva y descarta el small-cap', JSON.stringify(syms));
}

global.fetch = realFetch;
if (realKey === undefined) delete process.env.FINNHUB_API_KEY; else process.env.FINNHUB_API_KEY = realKey;
console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
