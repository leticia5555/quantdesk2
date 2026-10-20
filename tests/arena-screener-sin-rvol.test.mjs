// ═══════════════════════════════════════════════════════════════════
// tests/arena-screener-sin-rvol.test.mjs — sin RVOL es un dato faltante.
//
// EL CASO (29-sep): openai pidió `rvol_top:true` (con y sin `sector:XLK`) y
// recibió 0 filas las dos veces. Con el tablero presente eso sólo pasa si
// NINGÚN nombre tuvo RVOL — si falló el promedio de 20 sesiones. Y entonces:
//   · la sección de volumen inusual desaparecía del tablero sin explicación;
//   · el screener contestaba "ninguno cumple", que es falso.
// Ahora el tablero lo marca (`sin_rvol`, avisos), el render se lo dice a los
// agentes, el screener contesta "screener sin RVOL hoy" con el motivo, y
// /liga lo publica como "sin dato: rvol" — no como 0 ni como falla.
//
// Se usa `buildBoard` REAL con Alpaca inyectado: lo que se prueba es la
// cadena entera, no una copia del predicado.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildBoard, renderBoard, TOP_RVOL } from '../api/_lib/arena-board.js';
import { diagnosticoScreener } from '../api/_lib/arena-screener-diag.js';
import { secuenciaPublicable } from '../api/liga-libros.js';
import { createToolExecutor } from '../api/_lib/arena-tools.js';

const NOW = new Date('2026-10-20T15:30:00Z');
const SIMS = Array.from({ length: 40 }, (_, i) => 'S' + i);
const universe = {
  symbols: SIMS, fifty_two_week: {},
  // La mitad en Information Technology (→ XLK), la otra mitad en Energy.
  sectores: Object.fromEntries(SIMS.map((s, i) => [s, i % 2 ? 'Energy' : 'Information Technology'])),
};
const deps = (avg) => ({
  getSnapshotsConFeed: async (syms) => ({ feed: 'iex', data: Object.fromEntries(syms.map((s, i) => [s, { price: 10 + i, prev_close: 10, day_volume: 1000 * (i + 1) }])) }),
  getSnapshots: async () => ({}),
  getDailyCloses: async () => ({}),
  getNews: async () => [],
  getAvgDailyVolume: avg,
});
const sano = deps(async (syms) => Object.fromEntries(syms.map((s) => [s, 5000])));
const roto = deps(async () => { throw new Error('HTTP 429 de Alpaca en bars'); });
const vacio = deps(async () => ({}));

test('tablero sano: hay RVOL, no hay aviso', async () => {
  const b = await buildBoard({ universe, now: NOW, deps: sano });
  assert.equal(b.sin_rvol, null);
  assert.equal(b.rvol_top.length, TOP_RVOL);
  assert.deepEqual(b.avisos, []);
  assert.doesNotMatch(renderBoard(b).text, /NOT AVAILABLE TODAY/);
});

for (const [caso, d, motivo] of [['el promedio LANZA', roto, /HTTP 429/], ['el promedio vuelve vacío sin lanzar', vacio, /no devolvió dato para ninguno de los 40/]]) {
  test(`${caso}: el tablero lo marca y se lo dice a los agentes`, async () => {
    const b = await buildBoard({ universe, now: NOW, deps: d });
    assert.ok(b.sin_rvol, 'sin_rvol marcado');
    assert.match(b.sin_rvol.motivo, motivo);
    assert.match(b.avisos[0], /^Tablero sin RVOL hoy/);
    const txt = renderBoard(b).text;
    assert.match(txt, /== UNUSUAL VOLUME: NOT AVAILABLE TODAY ==/);
    assert.match(txt, /MISSING DATA, not an absence of unusual volume/);
  });
}

test('los filtros de openai sobre un tablero SIN RVOL: "screener sin RVOL hoy", no una lista vacía', async () => {
  const board = await buildBoard({ universe, now: NOW, deps: roto });
  const d = await diagnosticoScreener({ universe, board });
  assert.equal(d.resultados.length, 2);
  for (const r of d.resultados) {
    assert.match(r.texto, /^Screener sin RVOL hoy: HTTP 429/);
    assert.match(r.texto, /NO significa que no haya volumen inusual/);
    assert.deepEqual(r.datos_faltantes, ['rvol']);
    assert.equal(r.filas, 0);
  }
  assert.match(d.lectura, /SIN RVOL/);
  assert.deepEqual(d.tablero.avisos.length, 1);
});

test('los filtros de openai sobre un tablero SANO devuelven filas, y XLK filtra de verdad', async () => {
  const board = await buildBoard({ universe, now: NOW, deps: sano });
  const d = await diagnosticoScreener({ universe, board });
  const [sinSector, conXlk] = d.resultados;
  assert.equal(sinSector.filas, TOP_RVOL, 'rvol_top solo = el top 20');
  assert.ok(conXlk.filas > 0 && conXlk.filas < TOP_RVOL, `con XLK es un subconjunto (${conXlk.filas})`);
  assert.equal(d.universo.con_sector, 40);
  assert.match(d.lectura, /El screener funciona hoy/);
});

test('/liga lo publica "sin dato: rvol" — ni 0 nombres ni falla (de punta a punta: ejecutor → journal → proyección)', async () => {
  const board = await buildBoard({ universe, now: NOW, deps: roto });
  const ex = createToolExecutor({ budget: 2, board, universe, cache: false });
  await ex.call('screener', { rvol_top: true });
  const s = secuenciaPublicable({ tools: { summary: ex.summary() } });
  assert.deepEqual(ex.summary()[0].datos_faltantes, ['rvol'], 'el journal guarda qué dato faltó');
  assert.equal(s.pasos[0].resultado, 'sin dato: rvol');
  assert.equal(s.pasos[0].falló, undefined);
});

test('cableado: ?job=screener va antes de la compuerta del cron y con la llave de lectura', () => {
  const src = readFileSync(new URL('../api/arena-screener.js', import.meta.url), 'utf8');
  const iJob = src.indexOf("=== 'screener'");
  const iCron = src.indexOf('const secret = process.env.CRON_SECRET;');
  assert.ok(iJob > 0 && iJob < iCron, 'antes de la compuerta del cron');
  assert.match(src.slice(iJob, iCron), /checkLecturaAuth\(req\)/);
});
