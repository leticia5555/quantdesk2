// ═══════════════════════════════════════════════════════════════════
// tests/qd-periods.test.mjs — el % de periodo de /mercado.
//
// Dos cosas que este archivo tiene que garantizar:
//
//   1. GEMELAS. `qd-periods.js` (que usa /mercado) y el bloque compartido de
//      `app.html` calculan LO MISMO para los periodos que comparten. No se
//      compara texto: se corren las dos implementaciones REALES sobre las
//      mismas series. Copiar código es aceptable si la copia no puede
//      desviarse en silencio; esto es lo que lo impide.
//
//   2. YTD NO SE ESTIMA. Es una fecha, no un conteo de sesiones. Sin
//      timestamps, o sin alcanzar el año anterior, devuelve pct null CON
//      motivo — nunca un aproximado con 252 sesiones.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { anclaYtd } from '../api/_lib/mercado-fase0.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MERCADO = require(join(ROOT, 'qd-periods.js'));

// El bloque REAL de app.html, extraído como lo hace period-label-lint.
function appHtmlShared() {
  const src = readFileSync(join(ROOT, 'app.html'), 'utf8');
  const from = src.indexOf('const QD_PERIODS=');
  const to = src.indexOf('/* ⟦pct-lint:start⟧');
  assert.ok(from > 0 && to > from, 'no encuentro el bloque compartido en app.html');
  const factory = new Function('qdEscHTML',
    src.slice(from, to) + '\n; return { QD_PERIODS, qdPeriodChange, qdPctTag };');
  return factory((s) => String(s));
}
const APP = appHtmlShared();

const DIA = 86400;
const T0 = Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000);
// Una serie de 60 cierres que arranca el 31-dic-2025 y sube irregularmente.
const SERIE = Array.from({ length: 60 }, (_, i) => ({
  t: T0 + i * DIA,
  c: 100 + i * 0.7 + (i % 7) * 1.3 - (i % 5) * 0.9,
}));
const AHORA = new Date('2026-03-01T12:00:00Z');

// Una serie LARGA para comparar los periodos que no caben en 60 cierres. La
// de 60 sigue siendo la de los casos cortos, que es donde estaba el valor.
const SERIE_LARGA = Array.from({ length: 300 }, (_, i) => ({
  t: T0 + i * DIA,
  c: 100 + i * 0.4 + (i % 11) * 1.1,
}));

test('GEMELAS: 1D, 1S, 1M y 3M dan exactamente lo mismo en las dos implementaciones', () => {
  // Con la serie LARGA: `3M` necesita 64 cierres y la de 60 no los tiene, así
  // que compararlos ahí no medía la paridad — medía el recorte, y desde R4
  // `qd-periods.js` ya no recorta (ver la prueba de la divergencia, al final).
  for (const p of ['1D', '1S', '1M', '3M']) {
    const a = APP.qdPeriodChange(SERIE_LARGA, p);
    const b = MERCADO.qdPeriodChange(SERIE_LARGA, p, AHORA);
    assert.equal(b.pct, a.pct, `${p}: pct distinto`);
    assert.equal(b.value, a.value, `${p}: value distinto`);
    assert.equal(b.refIdx, a.refIdx, `${p}: ancla distinta`);
    assert.equal(b.refValue, a.refValue, `${p}: cierre del ancla distinto`);
    assert.equal(b.periodLabel, a.periodLabel, `${p}: etiqueta distinta`);
    assert.equal(b.window.length, a.window.length, `${p}: ventana distinta`);
  }
});

test('GEMELAS: series cortas o vacías se comportan igual', () => {
  for (const serie of [[], [{ t: T0, c: 100 }], [{ t: T0, c: 0 }, { t: T0 + DIA, c: 10 }]]) {
    for (const p of ['1D', '1S', '1M']) {
      const a = APP.qdPeriodChange(serie, p);
      const b = MERCADO.qdPeriodChange(serie, p, AHORA);
      assert.equal(b.pct, a.pct);
      assert.equal(b.value, a.value);
    }
  }
});

test('GEMELAS: las dos LANZAN si el periodo no existe', () => {
  assert.throws(() => APP.qdPeriodChange(SERIE, 'XX'));
  assert.throws(() => MERCADO.qdPeriodChange(SERIE, 'XX', AHORA));
});

test('GEMELAS: las dos LANZAN si se pinta un % sin etiqueta de periodo', () => {
  assert.throws(() => APP.qdPctTag(1.5, ''), /etiqueta de periodo obligatoria/);
  assert.throws(() => MERCADO.qdPctTag(1.5, ''), /etiqueta de periodo obligatoria/);
  assert.throws(() => MERCADO.qdPctTag(1.5, null), /etiqueta de periodo obligatoria/);
});

test('YTD ancla en el último cierre del año anterior, no en N sesiones', () => {
  const r = MERCADO.qdPeriodChange(SERIE, 'YTD', AHORA);
  assert.equal(r.refIdx, 0);              // el 31-dic-2025 es el primer punto
  assert.equal(r.refValue, SERIE[0].c);
  assert.equal(r.periodLabel, 'YTD');
  const esperado = ((SERIE[59].c - SERIE[0].c) / SERIE[0].c) * 100;
  assert.ok(Math.abs(r.pct - esperado) < 1e-9);
});

test('YTD: con varios cierres del año pasado toma el ÚLTIMO', () => {
  const serie = [
    { t: Math.floor(Date.parse('2025-12-29T00:00:00Z') / 1000), c: 90 },
    { t: Math.floor(Date.parse('2025-12-30T00:00:00Z') / 1000), c: 95 },
    { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 100 },
    { t: Math.floor(Date.parse('2026-01-02T00:00:00Z') / 1000), c: 110 },
  ];
  const r = MERCADO.qdPeriodChange(serie, 'YTD', AHORA);
  assert.equal(r.refValue, 100);
  assert.ok(Math.abs(r.pct - 10) < 1e-9);
});

test('YTD sin timestamps: "—" CON motivo, no un aproximado', () => {
  const r = MERCADO.qdPeriodChange([{ c: 100 }, { c: 120 }], 'YTD', AHORA);
  assert.equal(r.pct, null);
  assert.match(r.motivo, /no trae fechas/);
  // Y el "—" que se pinta lleva la causa encima.
  const html = MERCADO.qdPctTag(r.pct, r.periodLabel, { motivo: r.motivo });
  assert.match(html, /—/);
  assert.match(html, /title="[^"]*no trae fechas/);
});

test('YTD que no llega al año anterior: "—" con la fecha en que empieza la serie', () => {
  const serie = [1, 2, 3].map((d) => ({ t: Math.floor(Date.parse(`2026-02-0${d}T00:00:00Z`) / 1000), c: 100 + d }));
  const r = MERCADO.qdPeriodChange(serie, 'YTD', AHORA);
  assert.equal(r.pct, null);
  assert.match(r.motivo, /empieza en 2026-02-01/);
  assert.match(r.motivo, /no llega al año anterior/);
});

test('el ancla YTD del navegador y la del servidor coinciden', () => {
  // Dos implementaciones de la misma regla en dos lenguajes de ejecución
  // distintos: si divergen, el mapa y el censo contarían cosas distintas.
  for (const serie of [SERIE, SERIE.slice(30), SERIE.slice(0, 5)]) {
    const srv = anclaYtd(serie, AHORA);
    const nav = MERCADO.qdAnclaYtd(serie.filter((p) => p.c > 0), AHORA);
    assert.equal(nav.refIdx, srv.refIdx, 'el índice del ancla difiere entre navegador y servidor');
  }
});

test('el % sigue siendo imposible de pintar mudo, y el "—" no miente', () => {
  const sub = MERCADO.qdPctTag(-1.234, '1M');
  assert.match(sub, /-1\.23%/);
  assert.match(sub, />1M</);
  // Sin motivo, el "—" no inventa un title vacío.
  const sin = MERCADO.qdPctTag(null, 'YTD');
  assert.match(sin, /—/);
  assert.doesNotMatch(sin, /title=/);
});

test('fmtPrice: dos decimales, cuatro abajo de un dólar, "—" si no hay', () => {
  assert.equal(MERCADO.fmtPrice(13.857), '13.86');
  assert.equal(MERCADO.fmtPrice(0.5), '0.5000');
  assert.equal(MERCADO.fmtPrice(null), '—');
  assert.equal(MERCADO.fmtPrice('x'), '—');
});

// ───── el chip de estado se fue a `qd-mercados.js` ─────
//
// Vivía acá con su propia tabla de dos bolsas. R2 pide ocho, y dos tablas
// decidiendo si un mercado está abierto es el bug de #241/#245 con otro traje.
// La tabla es una sola y las pruebas del chip viven con ella, en
// `tests/mercado-bolsas.test.mjs`. Lo que se prueba ACÁ es que no quedó una
// segunda copia: si alguien vuelve a definir `QD_BOLSAS` o `qdEstadoMercado`
// en este archivo, esto se pone rojo.
test('el chip NO se define dos veces: qd-periods ya no lo exporta', () => {
  assert.equal(MERCADO.QD_BOLSAS, undefined, 'la tabla de bolsas vive en qd-mercados.js');
  assert.equal(MERCADO.qdEstadoMercado, undefined, 'y el cálculo también');
  assert.equal(MERCADO.qdHoraEn, undefined);
});


// ═══════════════════════════════════════════════════════════════════════
// R4: LA SERIE TIENE QUE CUBRIR EL PERIODO
//
// EL BUG, encontrado al armar la ficha de índice: el ancla salía de
// `Math.max(0, n - 1 - tradingDays)`, así que con la serie más corta que el
// periodo caía en el PRIMER punto y el resultado se pintaba con la etiqueta
// del periodo PEDIDO. Con 180 sesiones, pedir "5A" devolvía el cambio de ocho
// meses rotulado "5A".
//
// No se había visto porque hasta R4 los únicos periodos eran 1D, 1S y 1M, que
// casi siempre caben. Un % con la etiqueta equivocada es peor que un "—": el
// "—" se nota y éste no.
// ═══════════════════════════════════════════════════════════════════════
test('una serie más corta que el periodo da "—" CON su causa, no el cambio entero', () => {
  const serie = Array.from({ length: 180 }, (_, i) => ({ t: 1000 + i * 86400, c: 100 + i }));
  const r = MERCADO.qdPeriodChange(serie, '5A');
  assert.equal(r.pct, null, 'no puede dar un número');
  assert.match(r.motivo, /180 sesiones y 5A necesita 1261/, r.motivo);
  // Y la etiqueta sigue siendo la pedida: el "—" dice de qué periodo es.
  assert.equal(r.periodLabel, '5A');
});

test('y cuando SÍ cubre, el ancla es el punto exacto, no el primero', () => {
  const serie = Array.from({ length: 300 }, (_, i) => ({ t: 1000 + i * 86400, c: 100 + i }));
  const r = MERCADO.qdPeriodChange(serie, '1A');
  // 300 puntos, 1A = 252 sesiones atrás → ancla en el índice 47.
  assert.equal(r.refIdx, 300 - 1 - 252);
  assert.equal(r.refValue, 100 + 47);
});

test('los cinco periodos largos de la ficha existen, con sus sesiones del año bursátil', () => {
  const largos = { '3M': 63, '6M': 126, '1A': 252, '3A': 756, '5A': 1260 };
  for (const [k, dias] of Object.entries(largos)) {
    // Con exactamente `dias + 1` puntos alcanza, y con uno menos no: es la
    // forma de fijar el número de sesiones sin leerlo de la tabla.
    const justo = Array.from({ length: dias + 1 }, (_, i) => ({ t: 1000 + i * 86400, c: 100 + i }));
    assert.ok(Number.isFinite(MERCADO.qdPeriodChange(justo, k).pct), `${k} con ${dias + 1} puntos debería alcanzar`);
    assert.equal(MERCADO.qdPeriodChange(justo.slice(1), k).pct, null, `${k} con ${dias} puntos NO debería alcanzar`);
  }
});

test('1D sigue siendo contra el cierre anterior, no contra el primero de la serie', () => {
  const serie = [{ t: 1, c: 100 }, { t: 2, c: 110 }, { t: 3, c: 121 }];
  const r = MERCADO.qdPeriodChange(serie, '1D');
  assert.ok(Math.abs(r.pct - 10) < 1e-9, String(r.pct));
});

test('LA DIVERGENCIA CON app.html, declarada y acotada', () => {
  // `app.html` lleva su PROPIA copia del calculador —por eso existe la prueba
  // de paridad de arriba— y esta rebanada NO la toca: el encargo dice que
  // app.html no se rediseña en este trabajo, salvo el cambio a TRACKER de R5.
  //
  // Entonces la divergencia se declara acá en vez de quedar escondida:
  //   · los periodos largos (3M…5A) existen en `qd-periods.js` y NO en
  //     app.html, que no los usa;
  //   · el guardia de cobertura está sólo de este lado. app.html sigue
  //     devolviendo el cambio de la serie entera con la etiqueta del periodo
  //     cuando la serie es más corta — un bug REAL que vive ahí desde antes y
  //     que hay que decidir si se arregla (ver el PR de R4).
  //
  // Esta prueba se pone roja el día que alguien toque uno de los dos lados
  // sin mirar al otro, que es justo lo que hay que evitar.
  // `3M` YA existía en app.html —con las mismas 63 sesiones, por suerte— así
  // que lo que esta rebanada estrena son los CUATRO de arriba.
  assert.equal(MERCADO.QD_PERIODS['3M'].tradingDays, APP.QD_PERIODS['3M'].tradingDays,
    '3M tiene que medir lo mismo en los dos lados');
  for (const largo of ['6M', '1A', '3A', '5A']) {
    assert.ok(MERCADO.QD_PERIODS[largo], `qd-periods.js debería conocer ${largo}`);
    assert.ok(!APP.QD_PERIODS[largo], `app.html NO conoce ${largo} todavía: si ya lo conoce, actualizá esta prueba`);
  }
  // Y al revés: `YTD` existe de este lado y NO en app.html, que lo resuelve
  // por otro camino. Se deja anotado para que nadie "unifique" a ciegas.
  assert.ok(MERCADO.QD_PERIODS.YTD && !APP.QD_PERIODS.YTD);
  const corta = Array.from({ length: 10 }, (_, i) => ({ t: 1000 + i * 86400, c: 100 + i }));
  assert.equal(MERCADO.qdPeriodChange(corta, '1M').pct, null, '/mercado: "—" porque 10 sesiones no son un mes');
  assert.ok(Number.isFinite(APP.qdPeriodChange(corta, '1M').pct),
    'app.html todavía devuelve un número ahí: es el bug declarado arriba');
});

test('y en series que SÍ cubren el periodo los dos siguen dando lo mismo', () => {
  // La paridad que importa: donde las dos pueden contestar, contestan igual.
  const larga = Array.from({ length: 300 }, (_, i) => ({ t: T0 + i * DIA, c: 100 + i * 0.4 }));
  for (const p of ['1D', '1S', '1M']) {
    const a = APP.qdPeriodChange(larga, p);
    const b = MERCADO.qdPeriodChange(larga, p);
    assert.ok(Math.abs(a.pct - b.pct) < 1e-12, `${p}: ${a.pct} vs ${b.pct}`);
  }
});
