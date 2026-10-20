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

test('GEMELAS: 1D, 1S y 1M dan exactamente lo mismo en las dos implementaciones', () => {
  // `3M` SALIÓ de esta lista el 2026-10-21. Los tres que quedan se miden en
  // SESIONES en los dos lados y tienen que dar lo mismo al dígito; `3M` pasó
  // a anclarse por calendario de este lado —ver la prueba de la divergencia,
  // al final— porque un periodo de calendario medido en sesiones nunca
  // cuadra: para "1 año" hacían falta 253 cierres y un año sólo trae ~252.
  for (const p of ['1D', '1S', '1M']) {
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
  assert.match(r.motivo, /faltan \d+ días/, r.motivo);
  // Y la etiqueta sigue siendo la pedida: el "—" dice de qué periodo es.
  assert.equal(r.periodLabel, '5A');
});

// ═══════════════════════════════════════════════════════════════════════
// "1A" CON UN AÑO DE DATOS TIENE QUE DAR UN NÚMERO
//
// Lety, 2026-10-21: *"1A sale — con 252 sesiones."* 252 son exactamente un
// año bursátil. La cuenta pedía 253 porque `tradingDays` es la DISTANCIA en
// sesiones hasta el ancla y entre 252 cierres hay 251 saltos.
//
// Subir el número a 251 lo habría tapado un día: un año de Yahoo trae 250,
// 252 o 253 cierres según cuántos feriados cayeron en días hábiles, y con 250
// la tabla volvería a decir "—" sobre un año entero de datos. La causa de
// fondo es que "un año" es una distancia de CALENDARIO y se medía en
// sesiones.
// ═══════════════════════════════════════════════════════════════════════

// Una serie como la de Yahoo: cubre `dias` de calendario con `cierres`
// puntos, que es la forma real (fines de semana y feriados fuera).
const comoYahoo = (dias, cierres, fin = Date.parse('2026-10-19T00:00:00Z') / 1000) => {
  const paso = (dias * 86400) / (cierres - 1);
  return Array.from({ length: cierres }, (_, i) => ({
    t: Math.round(fin - (cierres - 1 - i) * paso), c: 100 + i * 0.2,
  }));
};

test('1A con un año de calendario y 252 cierres da un número, no "—"', () => {
  const r = MERCADO.qdPeriodChange(comoYahoo(365, 252), '1A');
  assert.ok(Number.isFinite(r.pct), 'el caso de Lety: ' + r.motivo);
  assert.equal(r.nota, null, 'cubre el año entero: no hay nada que advertir');
});

test('y con 250 cierres también: el año no se mide contando sesiones', () => {
  // Un año con más feriados en día hábil trae menos cierres y sigue siendo un
  // año. Es lo que hacía frágil al conteo.
  assert.ok(Number.isFinite(MERCADO.qdPeriodChange(comoYahoo(365, 250), '1A').pct));
  assert.ok(Number.isFinite(MERCADO.qdPeriodChange(comoYahoo(366, 253), '1A').pct));
});

test('si la serie se queda corta por unos días, el número sale y se DICE cuánto mide', () => {
  // La serie de un año empieza el primer día hábil DESPUÉS del corte, así que
  // casi nunca hay un cierre en o antes del ancla exacta. Sin gracia, "1A"
  // sobre un año de datos diría "—" siempre.
  const r = MERCADO.qdPeriodChange(comoYahoo(362, 250), '1A');
  assert.ok(Number.isFinite(r.pct));
  assert.match(r.nota, /362 días/);
  // `nota` NO es `motivo`: motivo es "no hay número", nota es "hay número y
  // esto es lo que mide". Confundirlos pintaría un hueco donde hay dato.
  assert.equal(r.motivo, null);
});

test('pero una serie de diez meses NO se pinta como "1A"', () => {
  // La protección que el guardia vino a dar sigue viva: lo que se afloja son
  // días, no meses.
  const r = MERCADO.qdPeriodChange(comoYahoo(300, 207), '1A');
  assert.equal(r.pct, null);
  assert.match(r.motivo, /faltan \d+ días/);
  assert.match(r.motivo, /2025-10-19/, 'dice a qué fecha tenía que llegar');
});

test('el ancla es la última sesión en o antes de la fecha de hace N meses', () => {
  const fin = Date.parse('2026-10-19T00:00:00Z') / 1000;
  const serie = comoYahoo(500, 340, fin);
  const r = MERCADO.qdPeriodChange(serie, '1A');
  const anclaT = serie[r.refIdx].t;
  const objetivo = new Date(fin * 1000);
  objetivo.setUTCMonth(objetivo.getUTCMonth() - 12);
  assert.ok(anclaT <= objetivo.getTime() / 1000, 'el ancla no puede ser posterior al objetivo');
  assert.ok(serie[r.refIdx + 1].t > objetivo.getTime() / 1000, 'y tiene que ser la ÚLTIMA que cumple');
});

test('los cinco periodos largos se anclan por calendario, con sus meses', () => {
  const largos = { '3M': 3, '6M': 6, '1A': 12, '3A': 36, '5A': 60 };
  for (const [k, meses] of Object.entries(largos)) {
    assert.equal(MERCADO.QD_PERIODS[k].meses, meses, `${k} son ${meses} meses`);
    // Con el calendario justo cubierto alcanza; con la mitad, no.
    const dias = Math.round(meses * 30.44);
    assert.ok(Number.isFinite(MERCADO.qdPeriodChange(comoYahoo(dias + 3, 40 + meses * 2), k).pct),
      `${k} con ${dias + 3} días debería alcanzar`);
    assert.equal(MERCADO.qdPeriodChange(comoYahoo(Math.round(dias / 2), 40), k).pct, null,
      `${k} con medio periodo NO debería alcanzar`);
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
  // `3M` existe en los dos lados y DESDE EL 2026-10-21 NO SE MIDE IGUAL:
  // acá se ancla por calendario —tres meses son tres meses— y en app.html
  // sigue contando 63 sesiones. Es el precio de arreglar el "1A" que salía
  // "—" con un año entero de datos: un periodo de calendario medido en
  // sesiones nunca cuadra, porque para "1 año" hacen falta 253 cierres y un
  // año sólo trae ~252.
  //
  // La divergencia se declara acá en vez de esconderse. Portarla a app.html
  // es una rebanada aparte: el encargo dice que app.html no se rediseña.
  assert.equal(APP.QD_PERIODS['3M'].tradingDays, 63, 'app.html sigue contando sesiones');
  assert.equal(MERCADO.QD_PERIODS['3M'].meses, 3, 'y acá se mide por calendario');
  assert.equal(MERCADO.QD_PERIODS['3M'].tradingDays, undefined,
    'si vuelve `tradingDays`, hay dos formas de medir lo mismo en el mismo archivo');
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
