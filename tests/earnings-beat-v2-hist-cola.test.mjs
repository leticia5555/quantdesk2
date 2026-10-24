// ═══════════════════════════════════════════════════════════════
// earnings-beat v2 — orden de la cola de ?job=hist (24-oct).
//
// El cupo de AV es de 10 por corrida y la cola llegó a 46: el orden decide
// quién tiene historial antes de su reporte. Antes iba por orden de aparición
// y HLT (reporta el lunes 27) quedaba atrás. Ahora: primero el mercado
// abierto que resuelve antes. Sin tocar fórmulas.
// Correr con `node tests/earnings-beat-v2-hist-cola.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { ordenaColaHist, CONSULTAS } from '../api/earnings-beat-v2.js';
import { SCHEMA_V2 } from '../api/_lib/earnings-beat-v2-db.js';
import { SCHEMA as SCHEMA_V1 } from '../api/_lib/earnings-beat-db.js';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

test('primero los que reportan antes; después los ya pasados (más reciente primero); al final los sin mercado', () => {
  const fechas = [
    { symbol: 'YELP', proxima: '2026-11-05', ultima: null },
    { symbol: 'HLT', proxima: '2026-10-27', ultima: null },
    { symbol: 'EBAY', proxima: '2026-10-28', ultima: null },
    { symbol: 'WDFC', proxima: null, ultima: '2026-10-21' },
    { symbol: 'TFX', proxima: null, ultima: '2026-10-22' },
  ];
  // orden de aparición, como venía antes
  const cola = ['WDFC', 'SSNC', 'YELP', 'TFX', 'EBAY', 'HLT', 'PJT'];
  assert.deepEqual(ordenaColaHist(cola, fechas), ['HLT', 'EBAY', 'YELP', 'TFX', 'WDFC', 'PJT', 'SSNC']);
});

test('empates por fecha: alfabético, para que el orden sea reproducible', () => {
  const fechas = [{ symbol: 'RDDT', proxima: '2026-10-29' }, { symbol: 'HGV', proxima: '2026-10-29' }];
  assert.deepEqual(ordenaColaHist(['RDDT', 'HGV'], fechas), ['HGV', 'RDDT']);
  assert.deepEqual(ordenaColaHist(['B', 'A'], []), ['A', 'B']);
});

test('la consulta de fechas, contra Postgres: abierto más cercano, ignora resueltos para "proxima"', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55439 });
  for (const q of SCHEMA_V1) psql(q + ';');
  for (const q of SCHEMA_V2) { try { psql(q + ';'); } catch { /* las que dependen de tablas de v2 previas */ } }
  psql(`insert into pm_earnings_markets_v2 (market_id, symbol, filtro_motivo, resolved_date, outcome) values
    ('h1', 'HLT',  'ok', current_date + 3,  null),
    ('h2', 'HLT',  'ok', current_date + 90, null),
    ('y1', 'YELP', 'ok', current_date + 12, null),
    ('w1', 'WDFC', 'ok', current_date - 2,  'no'),
    ('t1', 'TFX',  'ok', current_date - 1,  null),
    ('x1', 'XYZ',  'ok', current_date - 5,  'yes');`);
  const filas = psql(`select coalesce(json_agg(t), '[]') from (${CONSULTAS.fechasPorSimbolo()}) t;`);
  const fechas = JSON.parse(filas.trim());
  const hlt = fechas.find((f) => f.symbol === 'HLT');
  assert.ok(hlt.proxima && !hlt.ultima);                         // el abierto más cercano, no el de +90
  assert.equal(fechas.find((f) => f.symbol === 'WDFC').proxima, null);  // resuelto: no cuenta como próximo
  assert.ok(fechas.find((f) => f.symbol === 'TFX').proxima);      // abierto de ayer: reporta hoy, sigue en cola
  assert.deepEqual(ordenaColaHist(['XYZ', 'WDFC', 'YELP', 'TFX', 'HLT', 'SSNC'], fechas), ['TFX', 'HLT', 'YELP', 'WDFC', 'XYZ', 'SSNC']);
});
