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

// ESTAS DOS PRUEBAS FIJABAN EL COMPORTAMIENTO EQUIVOCADO, y las escribí yo
// en la misma ronda: exigían que un ticker fuera del universo saliera "sin
// resolver". Eso es lo que hizo que NYT y ALLY mostraran su CUSIP. Quedan
// reescritas con la promesa correcta, que vive en el bloque de abajo:
// existir y poder abrirse son dos preguntas distintas.

test('el que está en el mapa pasa y es enlazable', () => {
  const r = tickerValidado({ ticker: 'STZ', exch: 'US', via: 'openfigi:US' },
    { sec: new Set(['STZ']), universo: new Set(['STZ']) });
  assert.equal(r.ticker, 'STZ');
  assert.equal(r.en_universo, true);
  assert.equal(r.enlazable, true);
});

test('si el universo no cargó, NO se descarta nada: sería cambiar una causa por otra', () => {
  // Convertir una caída de Neon en "ningún ticker se pudo resolver" es
  // afirmar algo distinto y falso.
  const r = tickerValidado({ ticker: 'STZ', exch: 'US', via: 'openfigi:US' },
    { sec: new Set(['STZ']), universo: new Set() });
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

// ═══════════════════════════════════════════════════════════════════════
// LA CORRECCIÓN: "EXISTE" Y "LO PODEMOS ABRIR" SON DOS PREGUNTAS
//
// Mi primera versión contrastaba contra el universo del mapa, y con eso NYT y
// ALLY —tickers perfectamente reales, fuera del mapa por tamaño— salieron
// como "no está en nuestro universo" y la tarjeta mostró su CUSIP (Lety,
// 2026-10-22). Peor que antes del arreglo: antes al menos salía el ticker.
//
// El error fue conceptual: confundí existir con poder abrirle una ficha.
// Lety: *"si existe pero no tiene ficha, muestra el ticker sin link"*.
// ═══════════════════════════════════════════════════════════════════════

const SEC = new Set(['STZ', 'NYT', 'ALLY', 'NVDA', 'DVA']);
const MAPA = new Set(['STZ', 'NVDA', 'DVA']);

test('NYT existe y no está en el mapa: se muestra, sin enlace', () => {
  const r = tickerValidado({ ticker: 'NYT', exch: 'US', via: 'openfigi:US' }, { sec: SEC, universo: MAPA });
  assert.equal(r.ticker, 'NYT', 'el ticker se muestra');
  assert.equal(r.existe, true);
  assert.equal(r.en_universo, false);
  assert.equal(r.enlazable, false, 'pero sin enlace: no hay ficha que abrir');
  assert.match(r.nota, /sin enlace/);
});

test('STZ existe y está en el mapa: se muestra y es enlazable', () => {
  const r = tickerValidado({ ticker: 'STZ', exch: 'US', via: 'openfigi:US' }, { sec: SEC, universo: MAPA });
  assert.equal(r.ticker, 'STZ');
  assert.equal(r.enlazable, true);
  assert.equal(r.nota, null, 'sin nota: no hay nada que advertir');
});

test('un ticker que la SEC no conoce SÍ se rechaza: el CUSIP resolvió mal', () => {
  const r = tickerValidado({ ticker: 'ZZZZ', exch: 'US', via: 'openfigi:US' }, { sec: SEC, universo: MAPA });
  assert.equal(r.ticker, null);
  assert.equal(r.existe, false);
  assert.match(r.motivo, /company_tickers\.json/);
  assert.match(r.motivo, /ZZZZ/, 'el motivo dice cuál era');
});

test('si la lista de la SEC no cargó, NO se descarta nada', () => {
  // Convertir una caída de la SEC en "este ticker no existe" es cambiar una
  // causa por otra: el mismo error que esta prueba vino a corregir.
  const r = tickerValidado({ ticker: 'NYT', exch: 'US', via: 'openfigi:US' },
    { sec: new Set(), universo: MAPA });
  assert.equal(r.ticker, 'NYT');
  assert.equal(r.existe, null);
  assert.match(r.nota, /no se pudo contrastar contra company_tickers/);
});

test('sin ninguna de las dos listas, el ticker pasa tal cual', () => {
  const r = tickerValidado({ ticker: 'NYT', exch: 'US', via: 'openfigi:US' }, {});
  assert.equal(r.ticker, 'NYT');
  assert.equal(r.existe, null);
  assert.equal(r.en_universo, null);
});

// ═══════════════════════════════════════════════════════════════════════
// VARIAS CLASES: LA CAP ES LA SUMA, CLASE POR CLASE
// ═══════════════════════════════════════════════════════════════════════

import { capPorClases, esReferenciaDeClases } from '../api/_lib/mercado-cap-us.js';

// Los conteos son de EJEMPLO, no los reales: los reales los captura Lety de
// la portada del 10-Q, y este archivo no es el lugar para números inventados.
const BRK = {
  clave: 'BRK.B', cotizada: 'BRK.B',
  clases: [
    { nombre: 'Class A', acciones: 540_000, equivalencia_en_cotizada: 1500 },
    { nombre: 'Class B', acciones: 1_290_000_000, equivalencia_en_cotizada: 1 },
  ],
};

test('la cap suma cada clase llevada a la clase cotizada', () => {
  const r = capPorClases(BRK, 470.25);
  // 540.000 × 1500 = 810 millones en equivalentes B, más 1,290 millones.
  assert.equal(r.acciones_equivalentes, 2_100_000_000);
  assert.equal(r.cap_usd, 2_100_000_000 * 470.25);
  assert.equal(r.via, 'clases_declaradas');
});

test('la equivalencia es lo que evita el ×1,482: sin ella, la clase A se cuenta como B', () => {
  // El defecto que Lety vio tenía un múltiplo de 1,482, que es casi
  // exactamente la razón A→B. Si la equivalencia fuera 1 para las dos, la
  // clase A aportaría 540 mil en vez de 810 millones.
  const sinEquivalencia = { ...BRK, clases: BRK.clases.map((c) => ({ ...c, equivalencia_en_cotizada: 1 })) };
  const r = capPorClases(sinEquivalencia, 470.25);
  assert.equal(r.acciones_equivalentes, 1_290_540_000);
  assert.ok(r.acciones_equivalentes < 2_100_000_000, 'cuenta de menos, que es el otro lado del mismo error');
});

test('el detalle permite rehacer la cuenta a mano', () => {
  const r = capPorClases(BRK, 100);
  assert.equal(r.detalle.length, 2);
  assert.deepEqual(r.detalle[0],
    { nombre: 'Class A', acciones: 540_000, equivalencia_en_cotizada: 1500, equivalentes: 810_000_000 });
  assert.equal(r.precio_usado, 100, 'y con qué precio se multiplicó');
});

test('una clase sin conteo INVALIDA la suma entera, no se salta', () => {
  // Con una clase de menos el tamaño sale corto y nadie lo nota: es la misma
  // razón por la que la suma de `companyconcept` no se pinta sola.
  const incompleta = { ...BRK, clases: [BRK.clases[0], { nombre: 'Class B', equivalencia_en_cotizada: 1 }] };
  const r = capPorClases(incompleta, 470.25);
  assert.equal(r.cap_usd, null);
  assert.match(r.motivo, /Class B/);
  assert.match(r.motivo, /la suma sale corta/);
});

test('sin cierre nuestro no se pinta nada', () => {
  assert.equal(capPorClases(BRK, null).cap_usd, null);
  assert.match(capPorClases(BRK, 0).motivo, /sin cierre nuestro/);
});

test('una referencia de ADR no se confunde con una de clases', () => {
  assert.equal(esReferenciaDeClases(BRK), true);
  assert.equal(esReferenciaDeClases({ clave: 'TSM', market_cap_usd: 2.3e12 }), false);
  assert.equal(esReferenciaDeClases(null), false);
});

test('el registro documenta qué capturar y no inventa los números', async () => {
  const { readFileSync } = await import('node:fs');
  const reg = JSON.parse(readFileSync(
    new URL('../api/_lib/mercado-cap-us-referencia.json', import.meta.url), 'utf8'));
  assert.ok(reg._clases_de_acciones, 'la sección que explica la cuenta');
  assert.match(reg._clases_de_acciones.la_cuenta, /Σ acciones_clase × equivalencia/);
  // BRK.B está en pendientes y NO en `referencias`: escribir conteos de
  // memoria en un archivo que se pinta es justo lo que la regla 2 prohíbe.
  assert.ok(reg._pendientes_de_captura.some((x) => x.clave === 'BRK.B'));
  assert.ok(!(reg.referencias || []).some((x) => x.clave === 'BRK.B'),
    'BRK.B no entra al registro hasta que sus conteos sean reales');
});
