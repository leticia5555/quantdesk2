// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-opciones-y-cusip.test.mjs
//
// Dos cosas que Lety vio en producción (2026-10-22):
//
//   1. `/api/options?ticker=NVDA` → `available: false, "Fuente de opciones
//      no disponible"`. Un mensaje que no permite arreglar nada.
//   2. En `?cat=13f` de Berkshire, Constellation Brands salía como `CB1A`
//      —su cotización en Fráncfort— y una posición de $6.4 mil millones
//      salía como `TRL`, un ticker que nadie reconoce.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { tickerDeOpenFigi, tickerValidado } from '../api/stock-tracker.js';

// ── CUSIP → TICKER ─────────────────────────────────────────────────────
//
// `res.data[0].ticker`, el PRIMER resultado a ciegas. OpenFIGI devuelve TODAS
// las cotizaciones del mundo para un CUSIP y el orden no es una promesa de la
// API. Para un 13F —un formulario de la SEC sobre tenencias en bolsas de
// EE.UU.— la que vale es la de EE.UU.

/** La forma real: varias plazas, y la de Fráncfort puede venir primera. */
const STZ = [
  { ticker: 'CB1A', exchCode: 'GR', marketSector: 'Equity', name: 'CONSTELLATION BRANDS INC-A' },
  { ticker: 'STZ', exchCode: 'US', marketSector: 'Equity', name: 'CONSTELLATION BRANDS INC-A' },
  { ticker: 'STZ', exchCode: 'UN', marketSector: 'Equity' },
];

test('Constellation Brands resuelve a STZ, no a su cotización de Fráncfort', () => {
  const r = tickerDeOpenFigi(STZ);
  assert.equal(r.ticker, 'STZ');
  assert.equal(r.exch, 'US');
  assert.equal(r.via, 'openfigi:US', 'y la procedencia dice de qué plaza salió');
});

test('el orden de la respuesta no decide: la plaza decide', () => {
  // La misma lista al revés tiene que dar lo mismo. Si el resultado cambia
  // con el orden, el defecto sigue ahí con otra cara.
  assert.equal(tickerDeOpenFigi([...STZ].reverse()).ticker, 'STZ');
});

test('sólo plazas de fuera: NO se elige por descarte, se dice', () => {
  // Es el caso de `TRL`. Un CUSIP de un 13F que sólo aparece en Fráncfort es
  // una señal de que algo no cuadra, no un ticker alternativo.
  const r = tickerDeOpenFigi([{ ticker: 'TRL', exchCode: 'GR', marketSector: 'Equity' }],
    { nombre: 'ALGUNA EMISORA' });
  assert.equal(r.ticker, null);
  assert.match(r.motivo, /fuera de EE\.UU\./);
  assert.match(r.motivo, /GR/, 'el motivo nombra las plazas que sí llegaron');
  assert.match(r.motivo, /ALGUNA EMISORA/, 'y de qué emisora se trata');
});

test('los bonos del mismo CUSIP no se cuelan como ticker', () => {
  const conBono = [
    { ticker: 'XYZ 5 1/2 30', exchCode: 'US', marketSector: 'Corp' },
    { ticker: 'XYZ', exchCode: 'US', marketSector: 'Equity' },
  ];
  assert.equal(tickerDeOpenFigi(conBono).ticker, 'XYZ');
});

test('una respuesta ÚNICA sin plaza declarada se acepta, y lo dice', () => {
  // No hay ambigüedad que resolver: es la única respuesta que hay. Lo que no
  // se acepta es elegir entre varias sin saber cuál es de EE.UU.
  const r = tickerDeOpenFigi([{ ticker: 'AAPL', marketSector: 'Equity' }]);
  assert.equal(r.ticker, 'AAPL');
  assert.equal(r.via, 'openfigi:sin-plaza-declarada');
  assert.equal(r.exch, null, 'la plaza no se inventa');
});

test('varias sin plaza declarada NO se resuelven: ahí sí hay que decidir', () => {
  const r = tickerDeOpenFigi([
    { ticker: 'AAA', marketSector: 'Equity' },
    { ticker: 'BBB', marketSector: 'Equity' },
  ]);
  assert.equal(r.ticker, null);
});

test('sin respuesta no se inventa nada', () => {
  assert.equal(tickerDeOpenFigi([]).ticker, null);
  assert.equal(tickerDeOpenFigi(null).ticker, null);
  assert.match(tickerDeOpenFigi(null).motivo, /no devolvió/);
});

// ── Y CONTRA NUESTRO UNIVERSO ──────────────────────────────────────────

test('un ticker que no está en el universo sale SIN RESOLVER, no inventado', () => {
  // Lety: *"que un ticker que no existe en el universo salga como «sin
  // resolver», no inventado"*. Un símbolo que no cotizamos no se puede abrir
  // en ninguna ficha nuestra, así que mostrarlo promete una pantalla que no
  // existe.
  const r = tickerValidado({ ticker: 'XYZ', exch: 'US', via: 'openfigi:US' }, new Set(['STZ', 'NVDA']));
  assert.equal(r.ticker, null);
  assert.equal(r.en_universo, false);
  assert.match(r.motivo, /no está en nuestro universo/);
  assert.match(r.motivo, /XYZ/, 'el motivo dice cuál era, para poder investigarlo');
});

test('el que sí está pasa, con su marca', () => {
  const r = tickerValidado({ ticker: 'STZ', exch: 'US', via: 'openfigi:US' }, new Set(['STZ']));
  assert.equal(r.ticker, 'STZ');
  assert.equal(r.en_universo, true);
});

test('si el universo no cargó, NO se descarta nada: sería cambiar una causa por otra', () => {
  // Convertir una caída de Neon en "ningún ticker se pudo resolver" es
  // afirmar algo distinto y falso.
  const r = tickerValidado({ ticker: 'STZ', exch: 'US', via: 'openfigi:US' }, new Set());
  assert.equal(r.ticker, 'STZ');
  assert.equal(r.en_universo, null);
  assert.match(r.nota, /no se pudo contrastar/);
});

// ── EL DIAGNÓSTICO DE LAS OPCIONES ─────────────────────────────────────
//
// `available: false, "Fuente de opciones no disponible"` no permite arreglar
// nada: puede ser Yahoo cerrado, el ticker sin opciones, cuota agotada o
// nuestra salida de red, y las cuatro se arreglan en lugares distintos.
//
// `/v7/` es la familia que Yahoo cerró detrás de cookie + `crumb`; el
// `/v8/finance/chart` que usa el resto de esta casa sigue abierto. Esa es la
// sospecha, y el diagnóstico existe para confirmarla o descartarla con el
// cuerpo que Yahoo devuelva.

import handler, { fetchOptionChain } from '../api/options.js';

const respuesta = (status, cuerpo, ct = 'application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => ct },
  text: async () => cuerpo,
});

function conFetch(fn, prueba) {
  const real = global.fetch;
  global.fetch = fn;
  return Promise.resolve(prueba()).finally(() => { global.fetch = real; });
}

const mockRes = () => ({
  code: null, body: null, headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; return this; },
  json(o) { this.body = o; return this; },
  end() { return this; },
});

test('un 401 de Yahoo se reporta como 401, con su cuerpo y los dos hosts', async () => {
  await conFetch(
    async () => respuesta(401, '{"finance":{"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}'),
    async () => {
      const r = await fetchOptionChain('NVDA');
      assert.equal(r.res, null);
      assert.equal(r.intentos.length, 2, 'los DOS hosts, no sólo el último');
      assert.equal(r.intentos[0].status, 401);
      assert.equal(r.intentos[0].error_yahoo, 'Invalid Crumb',
        'el cuerpo de Yahoo dice si pide crumb, y es el dato que decide');
    },
  );
});

test('y el endpoint lo traduce a una causa accionable, no a "no disponible"', async () => {
  await conFetch(
    async () => respuesta(401, '{"finance":{"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}'),
    async () => {
      const res = mockRes();
      await handler({ method: 'GET', query: { ticker: 'NVDA' } }, res);
      assert.equal(res.body.available, false);
      assert.match(res.body.note, /401\/403|crumb/i);
      assert.ok(Array.isArray(res.body.intentos) && res.body.intentos.length === 2,
        'los intentos viajan en la respuesta');
    },
  );
});

test('un 429 se distingue de un cierre: es cuota y se reintenta', async () => {
  await conFetch(async () => respuesta(429, 'Too Many Requests', 'text/plain'), async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { ticker: 'NVDA' } }, res);
    assert.match(res.body.note, /429/);
    assert.match(res.body.note, /cuota|Reintentar/i);
  });
});

test('sin respuesta de ningún host se dice que parece la red, no un rechazo', async () => {
  await conFetch(async () => { throw new Error('getaddrinfo ENOTFOUND'); }, async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { ticker: 'NVDA' } }, res);
    assert.match(res.body.note, /salida de red/);
  });
});

test('un 404 sigue siendo "este ticker no tiene opciones", y no prueba el otro host', async () => {
  let llamadas = 0;
  await conFetch(async () => { llamadas++; return respuesta(404, '{}'); }, async () => {
    const r = await fetchOptionChain('ALGO');
    assert.equal(r.status, 404);
    assert.equal(llamadas, 1, 'un 404 no es una caída del host: no se reintenta en el otro');
    assert.equal(r.intentos.length, 1);
  });
});

test('el cuerpo que no es JSON se recorta y viaja: un HTML de error dice de qué', async () => {
  const html = '<html><body>Unauthorized</body></html>'.padEnd(500, ' ');
  await conFetch(async () => respuesta(403, html, 'text/html'), async () => {
    const r = await fetchOptionChain('NVDA');
    assert.equal(r.intentos[0].json, false);
    assert.ok(r.intentos[0].cuerpo.length <= 200, 'recortado, no el cuerpo entero');
    assert.match(r.intentos[0].cuerpo, /Unauthorized/);
    assert.equal(r.intentos[0].bytes, html.length, 'y el tamaño real, por si el recorte engaña');
  });
});
