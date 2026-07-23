// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/stock-tracker: parsing Form 4 (atom + XML),
// filtro de compras destacadas, clusters, infotable 13F + diff por
// CUSIP, caché en memoria + stale, y 400 de cat inválida.
// Fetch mockeado — sin red. Correr con `node tests/stock-tracker.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, {
  parseForm4Atom, parseForm4Xml, extractNotableBuy, markClusters,
  parse13FInfotable, diff13F, classify13FPositions, buildSymbolIndex, pickInfotableFile,
  _resetTrackerCache, _expireTrackerCache,
} from '../api/stock-tracker.js';

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
function textResponse(text, status = 200, ct = 'application/xml') {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    text: async () => text, json: async () => JSON.parse(text) };
}

const realFetch = global.fetch;
// Fechas dinámicas: el acumulador de insider poda por edad (7 días), así
// que los fixtures deben ser recientes de verdad.
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);

// ─────────────────── fixtures Form 4 ───────────────────
const ACC = '0001127602-26-000111';
const ATOM_LINK = `https://www.sec.gov/Archives/edgar/data/1318605/000112760226000111/${ACC}-index.htm`;
function form4AtomXml() {
  // getcurrent lista el mismo filing bajo Issuer y Reporting → se dedupe.
  return '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
    `<entry><title>4 - ACME CORP (0001318605) (Issuer)</title>` +
    `<link rel="alternate" href="${ATOM_LINK}"/><updated>${iso(1)}T18:00:00-04:00</updated></entry>` +
    `<entry><title>4 - DOE JANE (0009999999) (Reporting)</title>` +
    `<link rel="alternate" href="${ATOM_LINK}"/><updated>${iso(1)}T18:00:00-04:00</updated></entry>` +
    '</feed>';
}
function form4Xml({ code = 'P', ad = 'A', shares = 10000, price = 25, officer = true, ticker = 'ACME' } = {}) {
  return '<?xml version="1.0"?><ownershipDocument><aff10b5One>0</aff10b5One>' +
    '<issuer><issuerCik>0001318605</issuerCik><issuerName>Acme Corp</issuerName>' +
    `<issuerTradingSymbol>${ticker}</issuerTradingSymbol></issuer>` +
    '<reportingOwner><reportingOwnerId><rptOwnerCik>0009999999</rptOwnerCik>' +
    '<rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>' +
    '<reportingOwnerRelationship>' +
    (officer ? '<isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle>'
      : '<isOfficer>0</isOfficer><isTenPercentOwner>1</isTenPercentOwner>') +
    '</reportingOwnerRelationship></reportingOwner>' +
    '<nonDerivativeTable><nonDerivativeTransaction>' +
    `<transactionDate><value>${iso(3)}</value></transactionDate>` +
    `<transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>` +
    `<transactionAmounts><transactionShares><value>${shares}</value></transactionShares>` +
    `<transactionPricePerShare><value>${price}</value></transactionPricePerShare>` +
    `<transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts>` +
    '</nonDerivativeTransaction><nonDerivativeTransaction>' +
    `<transactionDate><value>${iso(3)}</value></transactionDate>` +
    '<transactionCoding><transactionCode>S</transactionCode></transactionCoding>' +
    '<transactionAmounts><transactionShares><value>500</value></transactionShares>' +
    '<transactionPricePerShare><value>30</value></transactionPricePerShare>' +
    '<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>' +
    '</nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>';
}

console.log('parseForm4Atom: dedupe Issuer/Reporting por accession');
{
  const entries = parseForm4Atom(form4AtomXml());
  ok(entries.length === 1, '2 entries del mismo filing → 1 único', entries.length);
  ok(entries[0].accession === ACC, 'accession extraído', entries[0].accession);
  ok(entries[0].cik === '1318605', 'cik del path', entries[0].cik);
  ok(parseForm4Atom('<html>no feed</html>').length === 0 && parseForm4Atom('').length === 0, 'no-feed/vacío → []');
}

console.log('parseForm4Xml: valores anidados, filtro P+A, flags de owner');
{
  const doc = parseForm4Xml(form4Xml());
  ok(doc.issuer.name === 'Acme Corp' && doc.issuer.ticker === 'ACME', 'issuer + ticker', JSON.stringify(doc.issuer));
  ok(doc.owners[0].isOfficer && doc.owners[0].officerTitle === 'Chief Executive Officer', 'cargo real del XML', JSON.stringify(doc.owners[0]));
  ok(doc.buys.length === 1 && doc.buys[0].shares === 10000 && doc.buys[0].price === 25,
    'solo la compra P+A entra (la venta S/D no)', JSON.stringify(doc.buys));
  ok(doc.planned10b5 === false, 'aff10b5One=0 → false');
  ok(parseForm4Xml(form4Xml({ ticker: 'N/A' })).issuer.ticker === null, 'ticker N/A → null (degrada a nombre)');
  ok(parseForm4Xml('<html>nope</html>') === null, 'sin ownershipDocument → null');
}

console.log('extractNotableBuy: umbral, officer/director, lag');
{
  const meta = { accession: ACC, link: ATOM_LINK, updated: iso(1) + 'T18:00:00-04:00' };
  const notable = extractNotableBuy(parseForm4Xml(form4Xml()), meta);
  ok(!!notable && notable.value === 250000, '10k × $25 = $250k pasa el umbral', notable && notable.value);
  ok(notable.role === 'Chief Executive Officer', 'cargo en el item', notable.role);
  ok(notable.lagDays === 2, 'lag trade→filing calculado (3d - 1d = 2)', notable.lagDays);
  ok(extractNotableBuy(parseForm4Xml(form4Xml({ shares: 100 })), meta) === null, '100 × $25 = $2.5k → null (bajo umbral)');
  ok(extractNotableBuy(parseForm4Xml(form4Xml({ officer: false })), meta) === null, '10%-owner sin cargo → null');
  ok(extractNotableBuy(parseForm4Xml(form4Xml({ code: 'A' })), meta) === null, 'award (A) → null: solo open-market');
}

console.log('markClusters: ≥2 insiders mismo issuer');
{
  const mk = (insider, issuerCik) => ({ insider, insiderCik: insider, issuer: 'X', issuerCik, value: 1 });
  const out = markClusters([mk('a', '1'), mk('b', '1'), mk('c', '2')]);
  ok(out[0].cluster && out[1].cluster, 'dos insiders en issuer 1 → cluster');
  ok(!out[2].cluster, 'insider solo en issuer 2 → no cluster');
}

// ─────────────────── fixtures 13F ───────────────────
function infotableXml(rows) {
  return '<?xml version="1.0"?><informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">' +
    rows.map((r) =>
      `<ns1:infoTable><ns1:nameOfIssuer>${r.name}</ns1:nameOfIssuer><ns1:cusip>${r.cusip}</ns1:cusip>` +
      `<ns1:value>${r.value}</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>${r.shares}</ns1:sshPrnamt>` +
      `<ns1:sshPrnamtType>${r.type || 'SH'}</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>` +
      (r.putCall ? `<ns1:putCall>${r.putCall}</ns1:putCall>` : '') +
      '</ns1:infoTable>').join('') +
    '</informationTable>';
}

console.log('parse13FInfotable: namespaces, agregación por CUSIP, sin opciones');
{
  const m = parse13FInfotable(infotableXml([
    { name: 'APPLE INC', cusip: '037833100', value: 5000, shares: 100 },
    { name: 'APPLE INC', cusip: '037833100', value: 1000, shares: 20 },
    { name: 'SPY PUTS', cusip: '78462F103', value: 9999, shares: 50, putCall: 'Put' },
    { name: 'BOND', cusip: '191216100', value: 500, shares: 10, type: 'PRN' },
  ]));
  ok(m.size === 1, 'puts y PRN fuera; duplicados agregados', m.size);
  const aapl = m.get('037833100');
  ok(aapl.value === 6000 && aapl.shares === 120, 'suma de filas duplicadas', JSON.stringify(aapl));
  ok(parse13FInfotable('').size === 0, 'vacío → mapa vacío');
}

console.log('diff13F: nuevas / cerradas / aumentos / recortes');
{
  const prev = parse13FInfotable(infotableXml([
    { name: 'KO', cusip: '191216100', value: 4000, shares: 100 },
    { name: 'GONE CORP', cusip: '000000000', value: 700, shares: 7 },
  ]));
  const curr = parse13FInfotable(infotableXml([
    { name: 'APPLE INC', cusip: '037833100', value: 5000, shares: 100 },
    { name: 'KO', cusip: '191216100', value: 2000, shares: 50 },
  ]));
  const d = diff13F(prev, curr);
  ok(d.added.length === 1 && d.added[0].cusip === '037833100', 'AAPL es nueva', JSON.stringify(d.added));
  ok(d.closed.length === 1 && d.closed[0].name === 'GONE CORP', 'GONE cerrada', JSON.stringify(d.closed));
  ok(d.reduced.length === 1 && d.reduced[0].deltaShares === -50 && d.reduced[0].deltaPct === -50, 'KO recortada −50%', JSON.stringify(d.reduced));
  ok(d.increased.length === 0, 'sin aumentos');
  ok(d.counts.held === 2 && d.counts.closed === 1, 'counts', JSON.stringify(d.counts));
}

console.log('classify13FPositions: new / increased / reduced / held / closed');
{
  const prev = parse13FInfotable(infotableXml([
    { name: 'KO', cusip: '191216100', value: 4000, shares: 100 },
    { name: 'MSFT', cusip: '594918104', value: 3000, shares: 60 },
    { name: 'GONE CORP', cusip: '000000000', value: 700, shares: 7 },
  ]));
  const curr = parse13FInfotable(infotableXml([
    { name: 'APPLE INC', cusip: '037833100', value: 5000, shares: 100 }, // nueva
    { name: 'KO', cusip: '191216100', value: 2000, shares: 50 },         // recorte
    { name: 'MSFT', cusip: '594918104', value: 3000, shares: 60 },       // held (sin cambio)
  ]));
  const pos = classify13FPositions(prev, curr);
  const by = Object.fromEntries(pos.map((p) => [p.cusip, p]));
  ok(pos.length === 4, 'new + reduced + held + closed = 4', pos.length);
  ok(by['037833100'].change === 'new', 'AAPL nueva', by['037833100'].change);
  ok(by['191216100'].change === 'reduced' && by['191216100'].deltaPct === -50, 'KO recorte −50%', JSON.stringify(by['191216100']));
  ok(by['594918104'].change === 'held' && by['594918104'].deltaPct === null, 'MSFT held (mantiene)', JSON.stringify(by['594918104']));
  ok(by['000000000'].change === 'closed' && by['000000000'].value === 0 && by['000000000'].prevValue === 700, 'GONE cerrada: value 0, prevValue 700', JSON.stringify(by['000000000']));
}

console.log('buildSymbolIndex: invierte por ticker + cobertura, salta CUSIP sin ticker');
{
  const fund = {
    fund: 'Berkshire Hathaway', persona: 'Warren Buffett', cik: 1067983,
    quarterEnd: '2026-03-31', prevQuarterEnd: '2025-12-31', filedDate: '2026-05-15', lagDays: 45,
    link: 'https://sec.gov/x',
    _positions: [
      { cusip: '037833100', name: 'APPLE INC', value: 5000, shares: 100, change: 'increased', deltaPct: 12.3 },
      { cusip: '191216100', name: 'KO', value: 2000, shares: 50, change: 'held', deltaPct: null },
      { cusip: '000000000', name: 'GONE CORP', value: 0, prevValue: 700, shares: 0, change: 'closed', deltaPct: null },
    ],
  };
  const tickers = new Map([['037833100', 'AAPL'], ['000000000', 'GONE'], ['191216100', null]]);
  const { bySymbol, coverage } = buildSymbolIndex([fund], tickers);
  ok(bySymbol.AAPL && bySymbol.AAPL.length === 1 && bySymbol.AAPL[0].change === 'increased' && bySymbol.AAPL[0].deltaPct === 12.3, 'AAPL: Berkshire aumentó +12.3%', JSON.stringify(bySymbol.AAPL));
  ok(bySymbol.AAPL[0].fund === 'Berkshire Hathaway' && bySymbol.AAPL[0].value === 5000, 'fondo + valor de la posición', JSON.stringify(bySymbol.AAPL[0]));
  ok(bySymbol.GONE && bySymbol.GONE[0].change === 'closed' && bySymbol.GONE[0].value === 0 && bySymbol.GONE[0].prevValue === 700, 'cerrada indexada con prevValue', JSON.stringify(bySymbol.GONE));
  ok(!bySymbol.KO, 'KO sin ticker (OpenFIGI) → no entra al índice');
  ok(coverage.length === 1 && coverage[0].positions_total === 2 && coverage[0].positions_mapped === 1, 'cobertura honesta: 1 de 2 posiciones actuales resueltas (closed no cuenta)', JSON.stringify(coverage[0]));
  ok(!('_positions' in fund), '_positions borrado tras indexar (payload por fondo queda limpio)');
}

console.log('pickInfotableFile: primary_doc fuera, nombre o tamaño');
{
  ok(pickInfotableFile({ directory: { item: [
    { name: 'primary_doc.xml', size: '3000' }, { name: 'infotable.xml', size: '50' },
  ] } }) === 'infotable.xml', 'prefiere nombre infotable aunque sea chico');
  ok(pickInfotableFile({ directory: { item: [
    { name: 'primary_doc.xml', size: '3000' }, { name: 'a.xml', size: '50' }, { name: 'b.xml', size: '90000' },
  ] } }) === 'b.xml', 'sin nombre obvio → el XML más grande');
  ok(pickInfotableFile({ directory: { item: [{ name: 'primary_doc.xml', size: '3000' }] } }) === null, 'solo primary_doc → null');
}

// ─────────────────── handler end-to-end (fetch mockeado) ───────────────────
const SUB_OK = JSON.stringify({
  name: 'BERKSHIRE HATHAWAY INC', filings: { recent: {
    form: ['13F-HR', '10-K', '13F-HR'],
    accessionNumber: ['0001067983-26-000001', '0001067983-26-000009', '0001067983-26-000002'],
    reportDate: [iso(60), iso(30), iso(150)],
    filingDate: [iso(20), iso(29), iso(110)],
  } },
});
const IDX_13F = JSON.stringify({ directory: { item: [
  { name: 'primary_doc.xml', size: '3000' }, { name: 'infotable.xml', size: '50000' },
] } });
const IDX_FORM4 = JSON.stringify({ directory: { item: [
  { name: 'form4.xml', size: '5000' }, { name: 'index.htm', size: '900' },
] } });

function routeFetch(url, opts) {
  const u = String(url);
  if (u.includes('action=getcurrent&type=4')) {
    // Página 2 (start=100) vacía: el build tolera páginas sin entries.
    return Promise.resolve(textResponse(u.includes('start=100') ? '<feed></feed>' : form4AtomXml()));
  }
  if (u.includes('/edgar/data/1318605/') && u.endsWith('index.json')) return Promise.resolve(textResponse(IDX_FORM4, 200, 'application/json'));
  if (u.includes('/edgar/data/1318605/') && u.endsWith('form4.xml')) return Promise.resolve(textResponse(form4Xml()));
  if (u.includes('submissions/CIK0001067983')) return Promise.resolve(textResponse(SUB_OK, 200, 'application/json'));
  if (u.includes('submissions/CIK')) return Promise.resolve(textResponse('not found', 404, 'text/html'));
  if (u.includes('/edgar/data/1067983/000106798326000001/index.json')) return Promise.resolve(textResponse(IDX_13F, 200, 'application/json'));
  if (u.includes('/edgar/data/1067983/000106798326000001/infotable.xml')) {
    return Promise.resolve(textResponse(infotableXml([
      { name: 'APPLE INC', cusip: '037833100', value: 5000, shares: 100 },
      { name: 'KO', cusip: '191216100', value: 2000, shares: 50 },
    ])));
  }
  if (u.includes('/edgar/data/1067983/000106798326000002/index.json')) return Promise.resolve(textResponse(IDX_13F, 200, 'application/json'));
  if (u.includes('/edgar/data/1067983/000106798326000002/infotable.xml')) {
    return Promise.resolve(textResponse(infotableXml([
      { name: 'KO', cusip: '191216100', value: 4000, shares: 100 },
    ])));
  }
  if (u.includes('api.openfigi.com')) {
    const jobs = JSON.parse(opts.body);
    return Promise.resolve(textResponse(JSON.stringify(jobs.map((j) =>
      j.idValue === '037833100' ? { data: [{ ticker: 'AAPL' }] } : { warning: 'No identifier found.' }
    )), 200, 'application/json'));
  }
  return Promise.resolve(textResponse('unmocked ' + u, 500, 'text/plain'));
}

console.log('handler: cat=insider end-to-end');
{
  global.fetch = routeFetch;
  _resetTrackerCache();
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'insider' } }, res);
  const b = res.body;
  ok(res.code === 200 && b.cat === 'insider', '200 con cat', res.code);
  ok(b.items.length === 1, '1 compra destacada', JSON.stringify(b.items));
  ok(b.items[0].insider === 'DOE JANE' && b.items[0].value === 250000, 'insider y valor', JSON.stringify(b.items[0]));
  ok(b.items[0].role === 'Chief Executive Officer', 'cargo real');
  ok(typeof b.items[0].lagDays === 'number', 'lag por item (honestidad)');
  ok(b.scan.atom_entries === 1 && b.scan.accumulated === 1, 'scan flags honestos', JSON.stringify(b.scan));
  ok((res.headers['Cache-Control'] || '').includes('s-maxage=1800'), 'CDN cache insider', res.headers['Cache-Control']);
}

console.log('handler: cat=13f end-to-end (5 fondos caídos, Berkshire OK)');
{
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: '13f' } }, res);
  const b = res.body;
  ok(res.code === 200 && b.cat === '13f', '200 con cat', res.code);
  ok(b.funds.length === 1 && b.funds[0].fund === 'Berkshire Hathaway', 'solo el fondo con datos', JSON.stringify(b.funds.map((f) => f.fund)));
  const f = b.funds[0];
  ok(f.top.added.length === 1 && f.top.added[0].ticker === 'AAPL', 'nueva con ticker vía OpenFIGI', JSON.stringify(f.top.added));
  ok(f.top.reduced.length === 1 && f.top.reduced[0].deltaPct === -50, 'recorte −50%', JSON.stringify(f.top.reduced));
  ok(typeof f.lagDays === 'number' && f.quarterEnd === iso(60), 'lag cierre→filing (honestidad)', f.lagDays);
  ok(Object.values(b.sources).filter((s) => !s.ok).length === 5, '5 fuentes caídas con flag', JSON.stringify(Object.keys(b.sources)));
  ok((res.headers['Cache-Control'] || '').includes('s-maxage=86400'), 'CDN cache 13f', res.headers['Cache-Control']);
}

console.log('handler: cat=13f&symbol=X → índice invertido (mismo cache)');
{
  // El cache de 13f quedó poblado por el test anterior (Berkshire: AAPL nueva
  // con ticker vía OpenFIGI, KO recorte sin ticker). Sin tocar la red.
  let calls = 0;
  global.fetch = (u, o) => { calls++; return routeFetch(u, o); };
  const resA = mockRes();
  await handler({ method: 'GET', query: { cat: '13f', symbol: 'aapl' } }, resA);
  const a = resA.body;
  ok(calls === 0, 'reutiliza el cache: 0 fetches', calls);
  ok(a.mode === 'by-symbol' && a.symbol === 'AAPL', 'vista por-ticker, símbolo normalizado', JSON.stringify({ mode: a.mode, symbol: a.symbol }));
  ok(Array.isArray(a.holders) && a.holders.length === 1 && a.holders[0].fund === 'Berkshire Hathaway', 'Berkshire reportado en AAPL', JSON.stringify(a.holders));
  ok(a.holders[0].change === 'new' && a.holders[0].value === 5000, 'cambio de trimestre + valor de la posición', JSON.stringify(a.holders[0]));
  ok(a.holders[0].quarterEnd === iso(60) && typeof a.holders[0].lagDays === 'number', 'lag honesto por holder (cierre + reportado)', JSON.stringify({ q: a.holders[0].quarterEnd, lag: a.holders[0].lagDays }));
  ok(a.funds_tracked === 6, 'funds_tracked = universo completo (para el estado vacío honesto)', a.funds_tracked);
  ok(a.bySymbol === undefined && a.funds === undefined, 'la vista por-ticker no arrastra bySymbol/funds', JSON.stringify(Object.keys(a)));

  // Ticker que ningún fondo del universo reporta → holders vacío + cobertura
  // real (el estado vacío honesto se arma con estos números en el frontend).
  const resB = mockRes();
  await handler({ method: 'GET', query: { cat: '13f', symbol: 'TSLA' } }, resB);
  const b = resB.body;
  ok(b.holders.length === 0, 'TSLA: ningún fondo lo reporta → []', JSON.stringify(b.holders));
  ok(Array.isArray(b.coverage) && b.coverage.length >= 1 && b.coverage[0].positions_total > 0, 'cobertura con números reales (no "data unavailable")', JSON.stringify(b.coverage[0]));

  // La vista por FONDO (TRACKER) sigue sin el índice invertido.
  const resC = mockRes();
  await handler({ method: 'GET', query: { cat: '13f' } }, resC);
  ok(Array.isArray(resC.body.funds) && resC.body.bySymbol === undefined && resC.body.coverage === undefined, 'vista por-fondo intacta y sin bySymbol/coverage', JSON.stringify(Object.keys(resC.body)));
}

console.log('handler: memoria + stale-on-fail');
{
  // Cache en memoria: segunda llamada no toca la red.
  let calls = 0;
  global.fetch = (u, o) => { calls++; return routeFetch(u, o); };
  const res1 = mockRes();
  await handler({ method: 'GET', query: { cat: 'insider' } }, res1);
  ok(calls === 0 && res1.body.items.length === 1, 'cache hit: 0 fetches', calls);
  // Expira + todas las fuentes caídas → sirve stale con flag.
  _expireTrackerCache('insider');
  global.fetch = () => Promise.resolve(textResponse('boom', 500, 'text/html'));
  const res2 = mockRes();
  await handler({ method: 'GET', query: { cat: 'insider' } }, res2);
  ok(res2.code === 200 && res2.body.stale === true, 'stale servido con flag', JSON.stringify({ code: res2.code, stale: res2.body.stale }));
  ok(res2.body.items.length === 1, 'items stale conservados');
  ok(res2.body.sources.edgar_form4_atom.ok === false, 'flag fresco de qué falló');
}

console.log('handler: cat inválida → 400 con uso');
{
  const res = mockRes();
  await handler({ method: 'GET', query: { cat: 'congreso' } }, res);
  ok(res.code === 400 && /insider \| 13f/.test(res.body.error), '400 con hint', JSON.stringify(res.body));
  const res2 = mockRes();
  await handler({ method: 'GET', query: {} }, res2);
  ok(res2.code === 400, 'sin cat → 400');
}

global.fetch = realFetch;
if (failures) { console.error(`\n${failures} FALLAS`); process.exit(1); }
console.log('\nTODOS LOS TESTS PASAN');
