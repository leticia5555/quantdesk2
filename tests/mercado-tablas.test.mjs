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

// ═══════════════════════════════════════════════════════════════════════
// SIN DATO NO ES CERO
//
// Con el mapa roto no llega ninguna fila, los conteos quedan todos en 0 y las
// frases decían "ninguna subieron en este periodo": una afirmación SOBRE EL
// MERCADO que nadie midió, y que encima manda a mirar la bolsa en vez de la
// consulta que falló. Lo vio Lety en el preview (2026-10-05) con el mapa caído
// por una columna que no existía.
// ═══════════════════════════════════════════════════════════════════════
test('con el mapa roto, cada tabla dice "sin dato" y la causa', () => {
  const t = tablasDeMercado([], { error: 'no se pudieron leer los datos del mapa' });
  for (const b of ['suben', 'bajan', 'operadas']) {
    const f = faltanteDeTabla(b, t.conteo);
    assert.match(f, /^sin dato: no se pudieron leer los datos del mapa$/, b);
    // Y NUNCA la frase del día plano, que es la que afirmaba de más.
    assert.doesNotMatch(f, /en este periodo/, b);
  }
});

test('sin una sola emisora tampoco se afirma nada del periodo', () => {
  const t = tablasDeMercado([]);
  assert.match(faltanteDeTabla('suben', t.conteo), /sin dato: el mapa no trajo ninguna emisora/);
});

test('el error le gana a cualquier otra explicación', () => {
  // Con error Y con filas —una lectura parcial— manda el error: lo que se
  // pinta es incompleto y decir "sólo 2 subieron" lo daría por completo.
  const t = tablasDeMercado([{ symbol: 'A', pct: 1 }], { error: 'timeout de Neon' });
  assert.match(faltanteDeTabla('suben', t.conteo), /^sin dato: timeout de Neon$/);
});

test('las frases concuerdan en número: "ninguna subió", "sólo 1 bajó"', () => {
  // "ninguna subieron" se lee como un error de la pantalla y hace dudar del
  // número que está al lado.
  const uno = tablasDeMercado([{ symbol: 'A', pct: 1 }, { symbol: 'B', pct: -1 }]);
  assert.match(faltanteDeTabla('suben', uno.conteo), /^sólo 1 subió en este periodo$/);
  assert.match(faltanteDeTabla('bajan', uno.conteo), /^sólo 1 bajó en este periodo$/);

  const dos = tablasDeMercado([{ symbol: 'A', pct: 1 }, { symbol: 'B', pct: 2 }]);
  assert.match(faltanteDeTabla('suben', dos.conteo), /^sólo 2 subieron en este periodo$/);
  assert.match(faltanteDeTabla('bajan', dos.conteo), /^ninguna bajó en este periodo$/);

  const unoOperado = tablasDeMercado([{ symbol: 'A', pct: 1, importe: 5 }, { symbol: 'B', pct: 2 }]);
  assert.match(faltanteDeTabla('operadas', unoOperado.conteo), /^sólo 1 de 2 trae lo operado$/);
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

  // Y cuando el llamador SABE que la causa es otra —la columna todavía no
  // existe— la dice él: mandar a revisar Yahoo en vez de correr el job es
  // exactamente el gris que parece resuelto y no lo está.
  const sinColumna = importeDeFilas([{ fecha: '2026-10-01', cierre: 100 }],
    { motivoSinDato: 'la columna de volumen todavía no existe en la tabla: corré /api/mercado-precios?job=us' });
  assert.match(sinColumna.motivo, /la columna de volumen todavía no existe/);

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

// ═══════════════════════════════════════════════════════════════════════
// "ESTA SEMANA": TRES ESTADOS QUE SE CONFUNDÍAN EN UNO
//
// La pantalla decía "sin eventos ni reportes" mientras el endpoint traía
// `reportes.filas: 9`. Los nueve caían después de los siete días que se pintan
// y el filtro los tiraba sin contarlos (Lety, 2026-10-05).
// ═══════════════════════════════════════════════════════════════════════
const { fraseDeFuente } = require(join(ROOT, 'qd-tablas.js'));

test('"¿dónde se perdieron los 9?": se dice cuántos caen más adelante', () => {
  const f = fraseDeFuente('reportes', {
    reportes: { ok: true, en_ventana: 0, mas_adelante: 9, horizonte_dias: 30 },
  });
  assert.equal(f, 'sin reportes esta semana · 9 más adelante');
});

test('la tabla macro vacía dice "sin cargar", no "sin eventos"', () => {
  // `macro_events` se carga A MANO desde el admin: cero eventos significa que
  // nadie la cargó, no que no vaya a pasar nada. Mandar a mirar otra semana
  // cuando hace falta abrir el admin es mandar al lugar equivocado.
  const f = fraseDeFuente('macro', {
    macro: { ok: true, en_ventana: 0, mas_adelante: 0, horizonte_dias: 30 },
  });
  assert.match(f, /calendario macro sin cargar/);
  assert.match(f, /próximos 30 días/, 'y dice hasta dónde se miró');
});

test('una fuente caída manda sobre todo lo demás', () => {
  const f = fraseDeFuente('reportes', {
    reportes: { ok: false, motivo: 'el handler respondió 401', en_ventana: 0, mas_adelante: 0 },
  });
  assert.match(f, /no respondió: el handler respondió 401/);
});

test('con eventos en la ventana no hay nada que explicar', () => {
  assert.equal(fraseDeFuente('macro', { macro: { ok: true, en_ventana: 2, mas_adelante: 7 } }), null);
});

test('las dos mitades se explican por separado', () => {
  // Si se funden, un Finnhub en 429 se lee igual que "no hay reportes", y la
  // semana más cargada del trimestre sale como una pantalla tranquila.
  const fuentes = {
    macro: { ok: true, en_ventana: 3, mas_adelante: 1 },
    reportes: { ok: false, motivo: 'HTTP 429' },
  };
  assert.equal(fraseDeFuente('macro', fuentes), null, 'macro llenó lo suyo');
  assert.match(fraseDeFuente('reportes', fuentes), /429/);
});
