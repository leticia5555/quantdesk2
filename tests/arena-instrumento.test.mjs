// ═══════════════════════════════════════════════════════════════
// tests/arena-instrumento.test.mjs — ¿ESTO ES UNA ACCIÓN COMÚN?
//
// EL REPORTE (2026-09-15): el canal del día entregó 100 candidatos y se
// admitieron CERO. 69 salieron `data_unavailable` y eran warrants, rights,
// preferentes y unidades.
//
// Dos bugs en uno, y el segundo es el que costó tiempo:
//   1. Entraban instrumentos que no son el universo del Arena.
//   2. Al rebotar se veían como falla de COBERTURA ("no pudimos resolver el
//      market cap") en vez de "no es una acción". Un rechazo con el motivo
//      equivocado manda a buscar el problema al lugar equivocado — y así fue:
//      se sospechó de Finnhub cuando el universo de entrada era el problema.
//
// Correr con `node tests/arena-instrumento.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  esAccionComun, filtrarComunes, normalizarTicker, SUFIJO_CLARO, NOMBRE_NO_COMUN,
} from '../api/_lib/arena-instrumento.js';
import { parseCsv, ubicarEncabezado, fetchHoldings, HOLDINGS_SOURCES } from '../api/_lib/etf-holdings.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const asset = (symbol, name, extra = {}) => ({ symbol, name, class: 'us_equity', status: 'active', tradable: true, ...extra });

console.log('\n── el NOMBRE es el que manda, no el sufijo ──');
{
  ok(esAccionComun(asset('AAPL', 'Apple Inc. Common Stock')).ok, 'una acción común pasa');
  ok(esAccionComun(asset('OKTA', 'Okta, Inc. Class A Common Stock')).ok, 'y una clase A también: sigue siendo la acción');

  const w = esAccionComun(asset('ABCDW', 'Acme Corp Warrant'));
  ok(!w.ok && w.clase === 'warrant',
    'un warrant SIN separador (ABCDW) se atrapa por el nombre — la heurística vieja exigía un punto o un guion y lo dejaba pasar', JSON.stringify(w));
  ok(!esAccionComun(asset('XYZ.RT', 'XYZ Rights')).ok, 'un right, fuera');
  ok(!esAccionComun(asset('QRS.U', 'QRS Units')).ok, 'una unidad, fuera');
  ok(!esAccionComun(asset('BAC.PRA', 'Bank of America Corp Preferred Stock Series A')).ok, 'una preferente, fuera');
  ok(!esAccionComun(asset('T.N', 'AT&T Inc Subordinated Notes due 2061')).ok, 'un baby bond, fuera');

  // LA AMBIGÜEDAD QUE EL SUFIJO SOLO NO PUEDE RESOLVER, y por la que el nombre
  // tiene que ganar: no toda W final es un warrant.
  ok(esAccionComun(asset('ANDW', 'Andrew Widget Co Common Stock')).ok,
    'ANDW NO es un warrant de AND: el nombre dice Common Stock y eso manda sobre el sufijo');
  ok(SUFIJO_CLARO.test('ABCD.WS') && !SUFIJO_CLARO.test('ANDW'),
    'el sufijo INEQUÍVOCO pide separador; el ambiguo no rechaza por sí solo');
  ok(NOMBRE_NO_COMUN.length >= 6, 'las familias de no-comunes están cubiertas', String(NOMBRE_NO_COMUN.length));
}

console.log('\n── lo que el catálogo dice que no se puede operar ──');
{
  ok(!esAccionComun(asset('FOO', 'Foo Inc', { tradable: false })).ok, 'tradable=false, fuera');
  ok(!esAccionComun(asset('BAR', 'Bar Inc', { status: 'inactive' })).ok, 'inactivo, fuera');
  ok(!esAccionComun(asset('BTCUSD', 'Bitcoin', { class: 'crypto' })).ok, 'otra clase de activo, fuera');

  const ausente = esAccionComun(undefined);
  ok(!ausente.ok && ausente.reason === 'catalogo_no_disponible',
    'un símbolo que NO está en el catálogo se rechaza — no se puede operar, venga de donde venga',
    JSON.stringify(ausente));
}

console.log('\n── el filtro sobre un lote, con los motivos separados ──');
{
  const assets = Object.fromEntries([
    asset('AAPL', 'Apple Inc. Common Stock'),
    asset('OKTA', 'Okta, Inc. Class A Common Stock'),
    asset('SPACW', 'SPAC Acquisition Warrant'),
    asset('SPACU', 'SPAC Acquisition Unit'),
    asset('XYZ.RT', 'XYZ Rights'),
    asset('BAC.PRA', 'Bank of America Preferred Stock'),
  ].map((a) => [a.symbol, a]));
  const catalogo = { assets, count: Object.keys(assets).length };

  const r = await filtrarComunes(['AAPL', 'OKTA', 'SPACW', 'SPACU', 'XYZ.RT', 'BAC.PRA', 'FANTASMA'], { catalogo });
  ok(r.comunes.length === 2 && r.comunes.includes('AAPL') && r.comunes.includes('OKTA'),
    'pasan las dos acciones y nada más', JSON.stringify(r.comunes));
  ok(r.rechazados.filter((x) => x.reason === 'no_es_comun').length === 4,
    'los cuatro instrumentos salen por `no_es_comun` — NO por falta de datos',
    JSON.stringify(r.rechazados.map((x) => `${x.symbol}:${x.reason}`)));
  ok(r.rechazados.some((x) => x.symbol === 'FANTASMA' && x.reason === 'catalogo_no_disponible'),
    'y el que no existe sale con SU motivo, distinto del anterior');
  ok(r.diagnostics.por_clase.warrant === 1 && r.diagnostics.por_clase.unidad === 1,
    'el diagnóstico cuenta POR CLASE: así se ve de qué está hecho el ruido del canal',
    JSON.stringify(r.diagnostics.por_clase));
  ok(/no son una falla de cobertura/i.test(r.diagnostics.note || ''),
    'y la nota dice explícitamente que esto NO es una falla de cobertura', r.diagnostics.note);
}

console.log('\n── sin catálogo: fail closed, y se dice que es culpa NUESTRA ──');
{
  const r = await filtrarComunes(['AAPL', 'MSFT'], { catalogo: { assets: null, error: 'Alpaca 500' } });
  ok(r.comunes.length === 0, 'sin catálogo no pasa nada: fail closed, igual que la admisión');
  ok(r.rechazados.every((x) => x.reason === 'catalogo_no_disponible'),
    'y el motivo distingue "no pudimos preguntar" de "no es una acción"',
    JSON.stringify(r.rechazados.map((x) => x.reason)));
  ok(/falla NUESTRA/i.test(r.diagnostics.note || ''),
    'la nota lo dice con esas palabras — si no, mañana alguien lee 0 admitidos y culpa a los nombres', r.diagnostics.note);
}

console.log('\n── BRKB → BRK.B: se le pregunta al catálogo, no a una tabla ──');
{
  const assets = { 'BRK.B': asset('BRK.B', 'Berkshire Hathaway Inc. Class B'), ANDW: asset('ANDW', 'Andrew Widget Co Common Stock') };
  ok(normalizarTicker('BRKB', assets) === 'BRK.B',
    'las tenencias del ETF escriben BRKB y Alpaca BRK.B: se resuelve preguntando');
  ok(normalizarTicker('ANDW', assets) === 'ANDW',
    'y un símbolo que SÍ existe no se toca — la normalización solo corre cuando el original no está');
  ok(normalizarTicker('NOEXISTE', assets) === 'NOEXISTE',
    'si ninguna forma existe, se devuelve el original y el filtro lo rechaza después');
}

console.log('\n── el CSV de tenencias: preámbulo, comillas y columnas variables ──');
{
  // iShares: varias líneas de preámbulo, comas DENTRO de los nombres, columna
  // de clase de activo.
  const ivv = [
    'iShares Core S&P 500 ETF',
    'Fund Holdings as of,"Sep 15, 2026"',
    ' ',
    'Ticker,Name,Sector,Asset Class,Weight (%)',
    'AAPL,"Apple Inc.",Information Technology,Equity,7.12',
    'BRKB,"Berkshire Hathaway Inc, Class B",Financials,Equity,1.70',
    'USD,"USD CASH",-,Cash and/or Derivatives,0.01',
    'ESU6,"S&P500 EMINI SEP 26",-,Futures,0.00',
  ].join('\n');

  const filas = parseCsv(ivv);
  const cab = ubicarEncabezado(filas);
  ok(cab && cab.fila === 3,
    'el encabezado se ENCUENTRA, no se asume: el preámbulo de iShares no tiene largo fijo', cab && cab.fila);
  ok(filas[5][1] === 'Berkshire Hathaway Inc, Class B',
    'la coma DENTRO de las comillas no corre las columnas — `split(",")` habría roto justo las filas que importan',
    JSON.stringify(filas[5][1]));

  const r = await fetchHoldings('sp500', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => ivv }),
  });
  ok(r.symbols.length === 2 && r.symbols.includes('AAPL') && r.symbols.includes('BRKB'),
    'salen las dos acciones; el cash y el futuro quedan afuera por la columna de clase', JSON.stringify(r.symbols));
  ok(r.diagnostics.saltadas_por_clase === 2, 'y se cuenta cuántas se saltaron por clase', String(r.diagnostics.saltadas_por_clase));

  // Invesco: sin preámbulo, otros nombres de columna, SIN columna de clase.
  const qqq = 'Fund Ticker,Holding Ticker,Name,Weight\nQQQ,NVDA,NVIDIA Corp,8.9\nQQQ,AAPL,Apple Inc,7.7';
  const r2 = await fetchHoldings('nasdaq100', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => qqq }),
  });
  ok(r2.symbols.length === 2 && r2.symbols.includes('NVDA'),
    'otro proveedor, otros nombres de columna: el mapeo por alternativas lo absorbe', JSON.stringify(r2.symbols));
  ok(r2.diagnostics.tenia_columna_de_clase === false && /catálogo de Alpaca/.test(r2.diagnostics.note || ''),
    'sin columna de clase NO se rompe: el que decide qué es una acción es el catálogo de Alpaca, y la nota lo dice',
    r2.diagnostics.note);
}

console.log('\n── cuando las tenencias no sirven, se dice POR QUÉ ──');
{
  const r = await fetchHoldings('sp500', { fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }) });
  ok(!r.diagnostics.ok && r.diagnostics.reason === 'http_error' && r.diagnostics.status === 403,
    'un 403 se reporta como 403, con los primeros bytes del cuerpo', JSON.stringify(r.diagnostics.body_sample));

  // EL CASO QUE MÁS ENGAÑA: la URL se movió y devuelve una página HTML.
  const r2 = await fetchHoldings('sp500', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html><body>Page not found</body></html>' }) });
  ok(r2.diagnostics.reason === 'html_no_csv',
    'HTML en vez de CSV se nombra como tal: "0 filas" mandaría a revisar el parser cuando la URL se movió',
    r2.diagnostics.reason);
  ok(/ARENA_HOLDINGS_URL_SP500/.test(r2.diagnostics.detail || ''),
    'y el detalle dice cómo corregirlo SIN un deploy', r2.diagnostics.detail);

  const r3 = await fetchHoldings('sp500', { fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); } });
  ok(r3.diagnostics.reason === 'timeout', 'un timeout se distingue de un rechazo');

  const r4 = await fetchHoldings('sp500', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'una,cosa\notra,fila' }) });
  ok(r4.diagnostics.reason === 'sin_encabezado' && Array.isArray(r4.diagnostics.primeras_lineas),
    'un CSV sin columna de ticker se nombra, y viajan las primeras líneas para poder mirarlo',
    JSON.stringify(r4.diagnostics.primeras_lineas));

  // ESTE LO ENCONTRÓ EL TEST, NO YO. `ubicarEncabezado` pedía UNA columna
  // reconocible, así que una fila de DATOS que contuviera la palabra "ticker"
  // se tomaba por encabezado y el parseo quedaba corrido un renglón —
  // devolviendo cero símbolos con cara de "el CSV vino vacío". Ahora pide dos
  // columnas: un encabezado real siempre trae ticker + algo más.
  const trampa = 'reporte,generado\nfuente,ticker\nTicker,Name,Asset Class\nAAPL,Apple Inc,Equity';
  const r5 = await fetchHoldings('sp500', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => trampa }) });
  ok(r5.diagnostics.encabezado_en_linea === 2 && r5.symbols.includes('AAPL'),
    'una fila de datos que dice "ticker" NO se confunde con el encabezado',
    `encabezado en ${r5.diagnostics.encabezado_en_linea}, símbolos ${JSON.stringify(r5.symbols)}`);
}

console.log('\n── las fuentes declaradas ──');
{
  ok(HOLDINGS_SOURCES.sp500.etf === 'IVV' && HOLDINGS_SOURCES.nasdaq100.etf === 'QQQ',
    'S&P 500 ← IVV (iShares) · Nasdaq 100 ← QQQ (Invesco)');
  ok(Object.values(HOLDINGS_SOURCES).every((s) => /^https:\/\//.test(s.url)),
    'las dos URLs son https y NO llevan key: son públicas');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
