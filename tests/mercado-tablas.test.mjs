// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-tablas.test.mjs — R3: más suben, más bajan, más operadas.
//
// Lo que se fija acá son las TRES decisiones de la tabla, que son la regla 2
// aplicada a una lista: una fila sin número no entra y se cuenta; "más suben"
// sólo lleva las que suben; y el empate se rompe por ticker para que la tabla
// no se reacomode sola entre repintados.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { tablasDeMercado, faltanteDeTabla, FILAS_TABLA } = require(join(ROOT, 'qd-tablas.js'));
const { importeDeFilas } = await import(join(ROOT, 'api/_lib/mercado-mapa.js'));

/** N emisoras con % repartido de -n/2 a +n/2, todas con importe. */
function universo(n) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'S' + String(i).padStart(2, '0'),
    nombre: 'Empresa ' + i,
    pct: i - Math.floor(n / 2),
    importe: (n - i) * 1e9,
  }));
}

test('las tres tablas traen 8 filas y están ordenadas', () => {
  const t = tablasDeMercado(universo(40));
  assert.equal(FILAS_TABLA, 8);
  assert.equal(t.suben.length, 8);
  assert.equal(t.bajan.length, 8);
  assert.equal(t.operadas.length, 8);
  // Suben: de mayor a menor. Bajan: de la peor hacia arriba.
  assert.deepEqual(t.suben.map((f) => f.pct), [19, 18, 17, 16, 15, 14, 13, 12]);
  assert.deepEqual(t.bajan.map((f) => f.pct), [-20, -19, -18, -17, -16, -15, -14, -13]);
  assert.deepEqual(t.operadas.map((f) => f.importe), [40e9, 39e9, 38e9, 37e9, 36e9, 35e9, 34e9, 33e9]);
});

test('una fila SIN % no entra a suben/bajan, y se cuenta', () => {
  // Ordenarla con las demás la colaría al medio de la lista como si valiera
  // cero: un cuadro que no se pudo medir no es "el que menos subió".
  const filas = [
    { symbol: 'A', pct: 3, importe: 1e9 },
    { symbol: 'B', pct: null, motivo: 'la serie no alcanza para este periodo', importe: 2e9 },
    { symbol: 'C', pct: -2, importe: 3e9 },
  ];
  const t = tablasDeMercado(filas);
  assert.deepEqual(t.suben.map((f) => f.symbol), ['A']);
  assert.deepEqual(t.bajan.map((f) => f.symbol), ['C']);
  assert.equal(t.conteo.sin_pct, 1);
  assert.equal(t.conteo.con_pct, 2);
  // Pero SÍ entra a "más operadas": lo operado se midió aunque el % no.
  assert.ok(t.operadas.some((f) => f.symbol === 'B'));
});

test('una fila SIN importe no entra a "más operadas", y se cuenta', () => {
  const filas = [
    { symbol: 'A', pct: 1, importe: 5e9 },
    { symbol: 'B', pct: 2, importe: null, importe_motivo: 'la fuente no trae volumen para este símbolo' },
  ];
  const t = tablasDeMercado(filas);
  assert.deepEqual(t.operadas.map((f) => f.symbol), ['A']);
  assert.equal(t.conteo.sin_importe, 1);
});

test('"más suben" NO se rellena con las que bajan', () => {
  // En un universo chico —México tiene 27 emisoras— un día rojo deja la tabla
  // corta. Rellenar hasta ocho pondría números rojos bajo un título que
  // promete verdes, que es lo que la regla 2 prohíbe.
  const filas = [
    { symbol: 'A', pct: 0.4 }, { symbol: 'B', pct: -1 }, { symbol: 'C', pct: -2 },
    { symbol: 'D', pct: -3 }, { symbol: 'E', pct: -4 },
  ];
  const t = tablasDeMercado(filas);
  assert.equal(t.suben.length, 1);
  assert.ok(t.suben.every((f) => f.pct > 0));
  assert.match(faltanteDeTabla('suben', t.conteo), /sólo 1 subió|sólo 1 subieron/);
});

test('un día plano: cero suben y cero bajan, y se dice', () => {
  const t = tablasDeMercado([{ symbol: 'A', pct: 0 }, { symbol: 'B', pct: 0 }]);
  assert.equal(t.suben.length, 0);
  assert.equal(t.bajan.length, 0);
  assert.equal(t.conteo.sin_cambio, 2);
  assert.match(faltanteDeTabla('suben', t.conteo), /ninguna subió|ninguna subieron/);
  assert.match(faltanteDeTabla('bajan', t.conteo), /ninguna bajó|ninguna bajaron/);
});

test('con la tabla llena, no hay nada que explicar', () => {
  // Una explicación que sobra es ruido: la pantalla no la pinta.
  const t = tablasDeMercado(universo(40));
  assert.equal(faltanteDeTabla('suben', t.conteo), null);
  assert.equal(faltanteDeTabla('bajan', t.conteo), null);
  assert.equal(faltanteDeTabla('operadas', t.conteo), null);
});

test('sin una sola emisora con volumen, "más operadas" dice que la columna se está llenando', () => {
  // Es el estado del día del despliegue: la columna de volumen nació después
  // que la tabla y se rellena en la cosecha siguiente. Decir "no hay datos"
  // mandaría a buscar un bug donde hay una cosecha pendiente.
  const t = tablasDeMercado([{ symbol: 'A', pct: 1 }, { symbol: 'B', pct: 2 }]);
  assert.equal(t.operadas.length, 0);
  assert.match(faltanteDeTabla('operadas', t.conteo), /se llena en la próxima cosecha/);
});

test('el empate se rompe por ticker, y no por el orden de llegada', () => {
  // Dos cuadros con el mismo % tienen que salir siempre igual, o la tabla se
  // reacomoda sola entre repintados y parece que algo se movió.
  const a = tablasDeMercado([{ symbol: 'ZZZ', pct: 5 }, { symbol: 'AAA', pct: 5 }]);
  const b = tablasDeMercado([{ symbol: 'AAA', pct: 5 }, { symbol: 'ZZZ', pct: 5 }]);
  assert.deepEqual(a.suben.map((f) => f.symbol), ['AAA', 'ZZZ']);
  assert.deepEqual(a.suben.map((f) => f.symbol), b.suben.map((f) => f.symbol));
});

// ═══════════════════════════════════════════════════════════════════════
// LO OPERADO EN DINERO: las dos tablas guardan cosas distintas
// ═══════════════════════════════════════════════════════════════════════
test('México trae el importe medido; EE.UU. se despeja de volumen × cierre', () => {
  // Decisión de Lety (2026-10-02): los dos lados en IMPORTE, para que el
  // toggle de país no cambie la pregunta.
  const mx = importeDeFilas([{ fecha: '2026-10-01', cierre: 50, importe: 123_456_789 }]);
  assert.equal(mx.importe, 123_456_789, 'el de la BMV no se recalcula');
  assert.equal(mx.fecha, '2026-10-01');

  const us = importeDeFilas([{ fecha: '2026-10-01', cierre: 140, volumen: 1_000_000 }]);
  assert.equal(us.importe, 140_000_000);
});

test('si la última fila no trae con qué, se usa la última que SÍ, con su fecha', () => {
  // La cosecha de hoy puede no haber alcanzado el volumen. Lo honesto es el
  // importe de ayer CON SU FECHA, no un hueco.
  const r = importeDeFilas([
    { fecha: '2026-09-30', cierre: 100, volumen: 2_000_000 },
    { fecha: '2026-10-01', cierre: 101, volumen: null },
  ]);
  assert.equal(r.importe, 200_000_000);
  assert.equal(r.fecha, '2026-09-30');
});

test('sin volumen en ninguna fila, null CON MOTIVO — nunca un cero', () => {
  // Un cero diría "no se operó nada", que es un dato y además falso.
  const r = importeDeFilas([{ fecha: '2026-10-01', cierre: 100 }]);
  assert.equal(r.importe, null);
  assert.match(r.motivo, /no trae volumen/);

  const vacia = importeDeFilas([]);
  assert.equal(vacia.importe, null);
  assert.match(vacia.motivo, /no hay serie/);
});

test('un volumen de CERO es un dato, no un hueco', () => {
  // Un día sin operaciones existe, y su importe es 0. Confundirlo con "falta
  // el dato" lo sacaría de la tabla en vez de ponerlo último.
  const r = importeDeFilas([{ fecha: '2026-10-01', cierre: 100, volumen: 0 }]);
  assert.equal(r.importe, 0);
  assert.equal(r.motivo, null);
});

test('las filas llegan desordenadas y manda la FECHA, no la posición', () => {
  const r = importeDeFilas([
    { fecha: '2026-10-01', cierre: 101, volumen: 3_000_000 },
    { fecha: '2026-09-30', cierre: 100, volumen: 2_000_000 },
  ]);
  assert.equal(r.fecha, '2026-10-01');
  assert.equal(r.importe, 303_000_000);
});
