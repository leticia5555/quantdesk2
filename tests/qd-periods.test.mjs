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

test('GEMELAS: 1D, 1S y 1M dan exactamente lo mismo en las dos implementaciones', () => {
  for (const p of ['1D', '1S', '1M']) {
    const a = APP.qdPeriodChange(SERIE, p);
    const b = MERCADO.qdPeriodChange(SERIE, p, AHORA);
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

// ───── el chip de estado, uno por bolsa ─────

test('las dos bolsas NO abren ni cierran a la misma hora', () => {
  // 20:30 UTC = 16:30 en Nueva York (cerrado) y 14:30 en la CDMX (abierto).
  const t = new Date('2026-09-21T20:30:00Z');   // lunes
  const us = MERCADO.qdEstadoMercado('us', t);
  const mx = MERCADO.qdEstadoMercado('mx', t);
  assert.equal(us.abierto, false, 'NY ya cerró a las 16:30 locales');
  assert.equal(mx.abierto, true, 'la BMV sigue abierta a las 14:30 locales');
  assert.equal(us.etiqueta, 'NYSE/Nasdaq');
  assert.equal(mx.etiqueta, 'BMV');
});

test('en sesión, las dos abiertas', () => {
  const t = new Date('2026-09-21T17:00:00Z');   // 13:00 NY, 11:00 CDMX
  assert.equal(MERCADO.qdEstadoMercado('us', t).abierto, true);
  assert.equal(MERCADO.qdEstadoMercado('mx', t).abierto, true);
});

test('el fin de semana dice de qué día es el cierre que se está viendo', () => {
  const dom = new Date('2026-09-20T17:00:00Z');   // domingo
  for (const b of ['us', 'mx']) {
    const e = MERCADO.qdEstadoMercado(b, dom);
    assert.equal(e.abierto, false);
    assert.match(e.texto, /cierre del viernes/);
  }
});

test('antes de abrir, el cierre que se ve es el del día hábil anterior', () => {
  const lunesTemprano = new Date('2026-09-21T12:00:00Z');   // 8:00 NY, 6:00 CDMX
  for (const b of ['us', 'mx']) {
    assert.equal(MERCADO.qdEstadoMercado(b, lunesTemprano).abierto, false);
    assert.match(MERCADO.qdEstadoMercado(b, lunesTemprano).texto, /cierre del viernes/);
  }
});

test('una bolsa que no existe LANZA en vez de inventar un horario', () => {
  assert.throws(() => MERCADO.qdEstadoMercado('xx', new Date()), /bolsa desconocida/);
});
