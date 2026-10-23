// ═══════════════════════════════════════════════════════════════════════
// pm_kpi_markets / pm_kpi_prices CONTRA UN POSTGRES DE VERDAD.
//
//   · la migración de docs/sql/earnings-kpi.sql == SCHEMA del código;
//   · el upsert no degrada: first_seen se escribe una vez, un resuelto no
//     vuelve a abierto, reported_value no lo toca el cron;
//   · T-24h sale del HISTORIAL: el último punto con ts ≤ end_date − 24h, solo
//     si T-24h ya pasó, y marcado rancio si el punto es muy viejo.
//
// Los parámetros $n se incrustan como literales (psql no habla el protocolo
// de Neon); el SQL que se prueba es el MISMO texto que corre en producción.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import {
  SCHEMA, COLS, preparaFilaKpi, sqlUpsertMercados, sqlInsertPrecios, puntosDeSnapshot, SQL_RECALCULA_T24H,
} from '../api/_lib/earnings-kpi-db.js';

const PUERTO = 55447;
const BIN = SIN_POSTGRES ? null : binDePostgres();

function literal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
// $12 antes que $1: reemplazo de mayor a menor para no partir números.
function incrusta({ query, params }) {
  let q = query;
  for (let i = params.length; i >= 1; i--) q = q.split('$' + i).join(literal(params[i - 1]));
  return q;
}
const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

test('la migración del repo es la misma que SCHEMA', () => {
  const archivo = readFileSync(new URL('../docs/sql/earnings-kpi.sql', import.meta.url), 'utf8');
  const sentencias = norm(archivo).split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(sentencias, SCHEMA.map(norm));
});

test('no toca pm_earnings_markets', () => {
  for (const q of SCHEMA) assert.ok(!/pm_earnings_markets/.test(q));
});

test('preparaFilaKpi: el precio viaja con su timestamp; sin precio, nulls', () => {
  const f = preparaFilaKpi({ market_id: 'x', event_slug: 'e', price_yes_latest: 0.3 }, '2026-10-22T23:20:00.000Z');
  assert.equal(f.price_yes_first_seen, 0.3);
  assert.equal(f.price_yes_first_seen_at, '2026-10-22T23:20:00.000Z');
  assert.equal(f.last_snapshot_at, '2026-10-22T23:20:00.000Z');
  const g = preparaFilaKpi({ market_id: 'x', event_slug: 'e', price_yes_latest: null }, '2026-10-22T23:20:00.000Z');
  assert.equal(g.price_yes_first_seen, null);
  assert.equal(g.last_snapshot_at, null);
  assert.ok(!COLS.includes('reported_value'), 'el upsert no tiene reported_value: no lo puede pisar');
});

test('contra Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: PUERTO });
  for (const q of SCHEMA) psql(q + ';');
  for (const q of SCHEMA) psql(q + ';');   // idempotente

  const T1 = '2026-10-20T23:20:00.000Z';
  const T2 = '2026-10-21T23:20:00.000Z';
  const base = (id, extra = {}) => ({
    market_id: id, event_slug: 'ev', event_title: 'MA cross-border', range_label: '22% to 24%',
    range_low: 22, range_high: 24, range_unit: '%', symbol: 'MA', end_date: '2026-10-22T20:00:00Z',
    created_at_pm: '2026-10-01T00:00:00Z', yes_token_id: 'tok-' + id, price_yes_latest: 0.3, volume: 100, liquidity: 50,
    resolved: false, winning_range: null, semilla: 'cross-border', _raw: { id }, ...extra,
  });

  await t.test('upsert: inserta y luego actualiza sin degradar', () => {
    const q1 = incrusta(sqlUpsertMercados([preparaFilaKpi(base('a'), T1), preparaFilaKpi(base('b', { range_low: null, range_high: 22 }), T1)]));
    const ins = psql(q1).trim().split('\n');
    assert.deepEqual(ins, ['t', 't'], 'dos insertados');

    psql(`update pm_kpi_markets set reported_value = 23.1 where market_id = 'a';`);
    // Segunda corrida: precio nuevo, y 'a' resuelto ganador.
    const q2 = incrusta(sqlUpsertMercados([
      preparaFilaKpi(base('a', { price_yes_latest: 0.9, resolved: true, winning_range: true }), T2),
      preparaFilaKpi(base('b', { range_low: null, range_high: 22, price_yes_latest: null }), T2),
    ]));
    assert.deepEqual(psql(q2).trim().split('\n'), ['f', 'f'], 'dos actualizados');

    const a = psql(`select price_yes_first_seen, price_yes_latest, resolved, winning_range, reported_value,
                           to_char(price_yes_first_seen_at at time zone 'UTC', 'YYYY-MM-DD') from pm_kpi_markets where market_id='a';`).trim();
    assert.equal(a, '0.3|0.9|t|t|23.1|2026-10-20', 'first_seen intacto, latest nuevo, resuelto, reported_value intacto');
    const b = psql(`select price_yes_latest, range_low is null, range_high,
                           to_char(last_snapshot_at at time zone 'UTC', 'YYYY-MM-DD') from pm_kpi_markets where market_id='b';`).trim();
    assert.equal(b, '0.3|t|22|2026-10-20', 'sin precio nuevo → se queda el último, y su timestamp');

    // Tercera corrida: Gamma (cache) lo ve abierto otra vez → NO vuelve a abierto.
    psql(incrusta(sqlUpsertMercados([preparaFilaKpi(base('a', { resolved: false, winning_range: null }), T2)])));
    assert.equal(psql(`select resolved, winning_range from pm_kpi_markets where market_id='a';`).trim(), 't|t');
  });

  await t.test('pm_kpi_prices: idempotente por (market_id, ts, fuente)', () => {
    const pts = [
      { market_id: 'b', ts: '2026-10-19T20:00:00Z', price_yes: 0.20, fuente: 'clob' },
      { market_id: 'b', ts: '2026-10-21T19:00:00Z', price_yes: 0.25, fuente: 'clob' },   // T-25h: el bueno
      { market_id: 'b', ts: '2026-10-21T21:00:00Z', price_yes: 0.60, fuente: 'gamma' },  // T-23h: posterior, no vale
    ];
    psql(incrusta(sqlInsertPrecios(pts)));
    psql(incrusta(sqlInsertPrecios(pts)));
    assert.equal(psql(`select count(*) from pm_kpi_prices where market_id='b';`).trim(), '3');
    assert.deepEqual(puntosDeSnapshot([{ market_id: 'z', resolved: true, price_yes_latest: 1 }], T2), [], 'resuelto no se snapshotea');
  });

  await t.test('T-24h: último punto ≤ end_date − 24h; solo si ya pasó; rancio si es viejo', () => {
    // 'c' cierra en el futuro lejano: su T-24h no pasó, no se fija aunque haya puntos.
    psql(incrusta(sqlUpsertMercados([preparaFilaKpi(base('c', { end_date: '2099-01-01T00:00:00Z' }), T1)])));
    psql(incrusta(sqlInsertPrecios([{ market_id: 'c', ts: '2026-10-21T00:00:00Z', price_yes: 0.5, fuente: 'gamma' }])));
    // 'd' solo tiene un punto 3 días antes del cierre → rancio.
    psql(incrusta(sqlUpsertMercados([preparaFilaKpi(base('d'), T1)])));
    psql(incrusta(sqlInsertPrecios([{ market_id: 'd', ts: '2026-10-19T20:00:00Z', price_yes: 0.1, fuente: 'clob' }])));

    const actualizados = psql(SQL_RECALCULA_T24H + ';').trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(actualizados, ['b', 'd']);
    assert.equal(psql(`select price_yes_t24h, to_char(price_yes_t24h_ts at time zone 'UTC', 'HH24:MI'), price_yes_t24h_estado
                         from pm_kpi_markets where market_id='b';`).trim(), '0.25|19:00|valido', 'b: el de T-25h, no el de T-23h');
    assert.equal(psql(`select price_yes_t24h_estado from pm_kpi_markets where market_id='d';`).trim(), 'rancio');
    assert.equal(psql(`select price_yes_t24h is null from pm_kpi_markets where market_id='c';`).trim(), 't', 'c: T-24h futuro → null');
    // Re-correr sin datos nuevos no reescribe nada.
    assert.equal(psql(SQL_RECALCULA_T24H + ';').trim(), '');
  });
});
