// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-spcx-y-series.test.mjs
//
// Los dos defectos que Lety encontró en `/api/mercado-mapa?map=us`
// (2026-10-22):
//
//   1. SPCX no se pintaba. IPO el 2026-09-18, cerró en $147.79 y fue de las
//      más operadas del día ($14.7 mil millones). Gris punteado: la cap de
//      Finnhub era del día de la IPO y difería 8% de acciones×precio, y
//      "EDGAR no tenía" el conteo de acciones.
//
//   2. 292 de 611 cuadros sin serie de precios, y el pie decía sólo "43 sin
//      capitalización verificada", escondiendo los 292.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { accionesDeCompanyConcept, FORMAS_IPO, FORMAS_CON_PORTADA } from '../api/_lib/mercado-edgar.js';
import { simboloYahoo, SQL_SIMBOLOS_MAPA } from '../api/_lib/mercado-precios.js';
import { resumenFaltantes } from '../api/_lib/mercado-mapa.js';

const HOY = new Date('2026-10-22T12:00:00Z');

// ── 1. SPCX: EL CONTEO DE ACCIONES DE UNA EMISORA RECIÉN LISTADA ───────

/**
 * La forma real de `companyconcept` para una emisora que salió a bolsa y
 * todavía no presenta un informe periódico: el conteo vive en la portada del
 * prospecto (424B4) y del 8-K del cierre de la oferta. Los dos lo traen; el
 * del 8-K es POST-oferta y es el que vale.
 */
const SPCX = { units: { shares: [
  { val: 1_750_000_000, end: '2026-09-15', filed: '2026-09-16', form: '424B4' },
  { val: 1_812_500_000, end: '2026-09-18', filed: '2026-09-22', form: '8-K' },
] } };

test('SPCX: el conteo sale del 8-K del cierre de la oferta', () => {
  // Antes esto devolvía `acciones: null` con "EDGAR no reporta el concepto",
  // y era falso: EDGAR lo reportaba, pero sólo en formas que la lista
  // descartaba. `EntityCommonStockSharesOutstanding` es un dato de PORTADA y
  // lo trae cualquier presentación con portada.
  const r = accionesDeCompanyConcept(SPCX, { hoy: HOY });
  assert.equal(r.acciones, 1_812_500_000);
  assert.equal(r.form, '8-K');
  assert.equal(r.fecha_portada, '2026-09-18');
  assert.equal(r.motivo, null, 'con dato no puede haber motivo de falta');
});

test('y declara que vino del escalón de IPO (regla 3: cada número con su fuente)', () => {
  const r = accionesDeCompanyConcept(SPCX, { hoy: HOY });
  assert.equal(r.escalon, 'ipo',
    '"del 424B4 del 18-sep" no es lo mismo que "del 10-Q del 30-jun", y se dice');
});

test('el informe periódico GANA, aunque el 8-K sea más nuevo', () => {
  // El conteo de un prospecto puede ser PREVIO a la oferta y el de un S-1
  // puede quedar viejo entre enmiendas. Mientras haya un informe periódico,
  // ése manda: el escalón de IPO es un respaldo, no una mezcla.
  const conQ = { units: { shares: [
    { val: 900_000_000, end: '2026-06-30', filed: '2026-07-28', form: '10-Q' },
    { val: 999_999_999, end: '2026-09-30', filed: '2026-10-01', form: '8-K' },
  ] } };
  const r = accionesDeCompanyConcept(conQ, { hoy: HOY });
  assert.equal(r.acciones, 900_000_000);
  assert.equal(r.form, '10-Q');
  assert.equal(r.escalon, 'periodico');
});

test('el escalón de IPO no inventa: sin ninguna forma utilizable sigue en null', () => {
  const nada = { units: { shares: [
    { val: 500_000_000, end: '2026-09-18', filed: '2026-09-22', form: 'SC 13G' },
  ] } };
  const r = accionesDeCompanyConcept(nada, { hoy: HOY });
  assert.equal(r.acciones, null);
  assert.match(r.motivo, /no trae/);
  // Y el motivo nombra las DOS listas, para que se sepa qué se buscó.
  assert.match(r.motivo, /424B4|8-K/);
});

test('un conteo de portada viejo sigue rechazándose, venga de donde venga', () => {
  // La guardia de CMCSA —una portada de 2009 por el cierre de hoy— no se
  // afloja por agregar formas. Un 8-K de hace años tampoco sostiene un tamaño.
  const viejo = { units: { shares: [
    { val: 1_000_000_000, end: '2009-12-31', filed: '2010-02-01', form: '8-K' },
  ] } };
  const r = accionesDeCompanyConcept(viejo, { hoy: HOY });
  assert.equal(r.acciones, null);
  assert.match(r.motivo, /sólo tiene portada de 2009|no sostiene un tamaño/);
});

test('las dos listas de formas no se solapan: el escalón sería indistinguible', () => {
  const cruce = FORMAS_IPO.filter((f) => FORMAS_CON_PORTADA.includes(f));
  assert.deepEqual(cruce, [],
    'si una forma estuviera en las dos, `escalon` no diría de dónde salió');
});

// ── 2. LAS SERIES QUE FALTABAN ─────────────────────────────────────────

test('BRK.B se le pide a Yahoo como BRK-B', () => {
  // Yahoo escribe las clases de acción con GUION. La cosecha mandaba el
  // símbolo crudo, así que para Yahoo era un símbolo inexistente y la serie
  // no llegaba nunca. `api/candles.js` ya traducía; esta cosecha no.
  assert.equal(simboloYahoo('BRK.B'), 'BRK-B');
  assert.equal(simboloYahoo('BF.B'), 'BF-B');
  assert.equal(simboloYahoo('brk.b'), 'BRK-B', 'y en mayúsculas');
});

test('un símbolo sin punto no se toca', () => {
  for (const s of ['HBAN', 'GPC', 'GPN', 'AVTR', 'CAG', 'HIMS', 'NVDA']) {
    assert.equal(simboloYahoo(s), s, `${s} no debería cambiar`);
  }
});

test('la lista de símbolos del mapa NO tiene tope', () => {
  // ÉSTE era el defecto grande: la cosecha usaba su propia consulta con
  // `limit 300` y el mapa pintaba 611. 311 símbolos no se intentaban nunca,
  // y 292 aparecían como cuadros sin serie.
  assert.doesNotMatch(SQL_SIMBOLOS_MAPA, /\blimit\b/i,
    'un tope acá no ahorra trabajo: lo esconde');
  assert.match(SQL_SIMBOLOS_MAPA, /sector_etf is not null/);
  assert.match(SQL_SIMBOLOS_MAPA, /market_cap is not null/);
});

test('la cosecha y el mapa usan LA MISMA definición, no dos parecidas', async () => {
  const { readFileSync } = await import('node:fs');
  const cosecha = readFileSync(new URL('../api/mercado-precios.js', import.meta.url), 'utf8');
  const mapa = readFileSync(new URL('../api/mercado-mapa.js', import.meta.url), 'utf8');
  for (const [nombre, src] of [['la cosecha', cosecha], ['el mapa', mapa]]) {
    assert.match(src, /SQL_SIMBOLOS_MAPA/, `${nombre} tiene que importar la definición compartida`);
  }
  // Y que no haya quedado una copia con su propio `limit`.
  assert.doesNotMatch(cosecha, /from mercado_universo_us\s*\n?\s*where sector_etf[\s\S]{0,120}limit/i,
    'quedó una consulta propia con tope en la cosecha');
});

// ── 3. EL PIE DICE TODO LO QUE FALTA ───────────────────────────────────

test('el pie nombra TODOS los motivos, cada uno con su número', () => {
  // Decía sólo "43 sin capitalización verificada" con 292 sin serie afuera.
  const f = [
    ...Array.from({ length: 292 }, () => ({ motivo: 'no_hay_serie' })),
    ...Array.from({ length: 43 }, () => ({ motivo: 'cap_sin_verificar' })),
    ...Array.from({ length: 5 }, () => ({ motivo: 'serie_corta' })),
  ];
  const r = resumenFaltantes(f);
  assert.equal(r.frases.length, 3, 'tres motivos, tres frases');
  assert.ok(r.frases.some((x) => /^292 sin serie de precios/.test(x)), JSON.stringify(r.frases));
  assert.ok(r.frases.some((x) => /^43 sin capitalización verificada/.test(x)));
  assert.ok(r.frases.some((x) => /^5 con la serie demasiado corta/.test(x)));
});

test('cada frase lleva su causa, no sólo el número', () => {
  const r = resumenFaltantes([{ motivo: 'no_hay_serie' }]);
  assert.match(r.frases[0], /\d+ \D+/, 'un número suelto no dice qué arreglar');
});

test('sin faltantes no hay frases: nada que decir es no decir nada', () => {
  assert.deepEqual(resumenFaltantes([]).frases, []);
});

test('los conteos por motivo no se suman en un total engañoso', () => {
  // La decisión anterior era correcta y se conserva: 292 sin serie y 43 sin
  // cap verificada son DOS problemas con dos arreglos. Lo que estaba mal era
  // callar uno, no separarlos.
  const r = resumenFaltantes([
    ...Array.from({ length: 292 }, () => ({ motivo: 'no_hay_serie' })),
    ...Array.from({ length: 43 }, () => ({ motivo: 'cap_sin_verificar' })),
  ]);
  assert.equal(r.sin_precio, 292);
  assert.equal(r.sin_cap_verificada, 43);
  assert.ok(!r.frases.some((x) => /^335/.test(x)), 'nunca una frase con la suma');
});

// ═══════════════════════════════════════════════════════════════════════
// LA SEGUNDA RONDA (Lety, 2026-10-22, contra producción con #315 puesto)
// ═══════════════════════════════════════════════════════════════════════

import { cikDe, REGLA_EDGAR_VERSION, candidatosParaEdgar } from '../api/_lib/mercado-edgar.js';
import { frescuraPorSimbolo } from '../api/mercado-mapa.js';

// ── BRK.B: LA SEC USA GUION, NOSOTROS PUNTO ────────────────────────────

test('BRK.B encuentra su CIK con la ortografía de la SEC', () => {
  // `company_tickers.json` escribe `BRK-B`. La búsqueda era directa, así que
  // BRK.B salía `sin_cik` y nunca llegaba a consultar sus acciones.
  //
  // Y de paso: en el PR anterior escribí que el punto era "la forma de la
  // SEC". Es al revés — la SEC usa guion, igual que Yahoo.
  const mapa = new Map([['BRK-B', '0001067983'], ['NVDA', '0001045810']]);
  const r = cikDe(mapa, 'BRK.B');
  assert.equal(r.cik, '0001067983');
  assert.equal(r.como, 'BRK-B', 'y dice con qué ortografía casó');
});

test('un símbolo normal casa directo, sin rodeos', () => {
  const mapa = new Map([['NVDA', '0001045810']]);
  assert.deepEqual(cikDe(mapa, 'NVDA'), { cik: '0001045810', como: 'NVDA' });
});

test('también al revés: un universo con guion y una SEC con punto', () => {
  const mapa = new Map([['BRK.B', '0001067983']]);
  assert.equal(cikDe(mapa, 'BRK-B').cik, '0001067983');
});

test('lo que EDGAR no conoce sigue sin CIK, no se inventa', () => {
  assert.deepEqual(cikDe(new Map(), 'XXXX'), { cik: null, como: null });
  assert.deepEqual(cikDe(null, 'NVDA'), { cik: null, como: null });
});

// ── AAL: UNA PORTADA DEL FUTURO NO EXISTE ──────────────────────────────

test('AAL: una portada posterior a hoy se rechaza con su causa', () => {
  // `portada: 2027-07-17` en un 10-Q presentado el 2026-07-23. Un conteo
  // fechado un año adelante por el cierre de hoy es un tamaño inventado con
  // dos datos reales: el mismo modo de falla que la portada de 2009 de
  // CMCSA, por el otro extremo.
  const aal = { units: { shares: [
    { val: 662_000_000, end: '2027-07-17', filed: '2026-07-23', form: '10-Q' },
  ] } };
  const r = accionesDeCompanyConcept(aal, { hoy: HOY });
  assert.equal(r.acciones, null);
  assert.match(r.motivo, /POSTERIOR a hoy/);
  assert.match(r.motivo, /2027-07-17/, 'el motivo trae la fecha, para poder ir a ver el filing');
});

test('y si hay una portada buena además de la futura, gana la buena', () => {
  const mixto = { units: { shares: [
    { val: 999_000_000, end: '2027-07-17', filed: '2026-07-23', form: '10-Q' },
    { val: 662_000_000, end: '2026-06-30', filed: '2026-07-23', form: '10-Q' },
  ] } };
  const r = accionesDeCompanyConcept(mixto, { hoy: HOY });
  assert.equal(r.acciones, 662_000_000, 'descartar la futura no descarta el filing entero');
  assert.equal(r.fecha_portada, '2026-06-30');
});

// ── SPCX: CUANDO CAMBIA LA REGLA, SE VUELVE A PREGUNTAR ────────────────

const entrada = (symbol, extra = {}) => ({ symbol, precio_usd: 100, acciones: 1e9, ...extra });
const veredicto = (symbol, extra = {}) => ({ symbol, estado: 'gris_punteado', moneda: 'USD', ...extra });

test('una fila decidida con la regla VIEJA vuelve a ser candidata', () => {
  // SPCX quedó marcado "EDGAR consultado el 2026-09-29, sin dato" con la
  // regla que sólo aceptaba informes periódicos. Al agregar las formas de IPO
  // el arreglo no le llegaba: nadie vuelve a preguntar algo que ya tiene
  // respuesta. Ahora la respuesta lleva la VERSIÓN de la regla que la produjo.
  const { candidatos, diagnostico } = candidatosParaEdgar({
    entradas: [entrada('SPCX')],
    veredictos: [veredicto('SPCX')],
    universoPorSymbol: new Map([['SPCX', {
      acciones_edgar_millones: null,
      edgar_consultada_en: '2026-09-29T00:00:00Z',
      edgar_regla: REGLA_EDGAR_VERSION - 1,
    }]]),
  });
  assert.deepEqual(candidatos, ['SPCX']);
  assert.equal(diagnostico.repregunta_por_regla, 1);
});

test('una fila YA decidida con la regla de ahora no se vuelve a preguntar', () => {
  // La repregunta es por cambio de criterio, no un "reintentar todo": pedirle
  // a la SEC lo mismo cada corrida gasta su cuota y no agrega nada.
  const { candidatos, diagnostico } = candidatosParaEdgar({
    entradas: [entrada('ACME')],
    veredictos: [veredicto('ACME')],
    universoPorSymbol: new Map([['ACME', {
      acciones_edgar_millones: 500,
      edgar_consultada_en: '2026-10-20T00:00:00Z',
      edgar_regla: REGLA_EDGAR_VERSION,
    }]]),
  });
  assert.deepEqual(candidatos, []);
  assert.equal(diagnostico.ya_con_edgar, 1);
});

test('el diagnóstico dice POR SÍMBOLO por qué quedó fuera, no sólo cuántos', () => {
  // Con SPCX gris y 52 candidatos, "N sin acciones" no permite saber si SPCX
  // es uno de ellos: hubo que inferirlo, y la inferencia podía estar mal.
  const { diagnostico } = candidatosParaEdgar({
    entradas: [entrada('SINPRECIO', { precio_usd: 0 }), entrada('SINACC', { acciones: 0 })],
    veredictos: [veredicto('SINPRECIO'), veredicto('SINACC')],
    universoPorSymbol: new Map(),
  });
  assert.deepEqual(diagnostico.excluidos, [
    { symbol: 'SINPRECIO', motivo: 'sin precio en USD' },
    { symbol: 'SINACC', motivo: 'sin conteo de acciones de Finnhub' },
  ]);
});

// ── CUÁNTOS LLEGARON AL ÚLTIMO CIERRE ──────────────────────────────────

test('el pie puede decir cuántos tienen el último cierre y cuántos no', () => {
  // La cosecha son 611 símbolos y una corrida alcanza ~416: el reparto en
  // varias corridas es la norma. Sin este conteo, un símbolo que se quedó con
  // el cierre de ayer se ve idéntico a uno al día.
  const r = frescuraPorSimbolo([
    { symbol: 'NVDA', fecha_precio: '2026-10-21' },
    { symbol: 'AAPL', fecha_precio: '2026-10-21' },
    { symbol: 'HOLX', fecha_precio: '2026-10-14' },
  ], '2026-10-21');
  assert.equal(r.con_ultimo_cierre, 2);
  assert.equal(r.atrasados, 1);
  assert.deepEqual(r.ejemplos, [{ symbol: 'HOLX', hasta: '2026-10-14' }],
    'con nombre, para poder ir a mirar');
});

test('un cuadro sin serie no cuenta como atrasado: ya se dice aparte', () => {
  const r = frescuraPorSimbolo([{ symbol: 'SINSERIE', fecha_precio: null }], '2026-10-21');
  assert.equal(r.con_ultimo_cierre, 0);
  assert.equal(r.atrasados, 0, 'dos motivos para una causa inflan el conteo');
});

test('se mide contra el último cierre que hay, no contra "hoy"', () => {
  // Un feriado no es un atraso. Comparar contra el calendario pondría las 611
  // en rojo cada día que la bolsa no abre.
  const r = frescuraPorSimbolo([{ symbol: 'NVDA', fecha_precio: '2026-10-21' }], '2026-10-21');
  assert.equal(r.atrasados, 0);
  assert.equal(r.ultimo_cierre, '2026-10-21');
});

test('sin último cierre no se afirma nada', () => {
  const r = frescuraPorSimbolo([{ symbol: 'NVDA', fecha_precio: '2026-10-21' }], null);
  assert.equal(r.ultimo_cierre, null);
  assert.equal(r.con_ultimo_cierre, 0);
});
