// ═══════════════════════════════════════════════════════════════════
// tests/liga-decisiones.test.mjs — la vista `liga_decisiones` y su endpoint
// /api/liga/decisiones, contra un Postgres DE VERDAD.
//
// La DDL es la del repo (db.js SCHEMA para arena_journal, SCHEMA_PRECIOS_US
// para mercado_precios_us) y la vista es la que crea el endpoint. Los datos:
// tests/fixtures/liga-decisiones-dia.json (ver su `_nota`).
//
// Lo que se blinda:
//   1. Solo órdenes LLENAS (las parciales con su cantidad llena; una
//      cancelada sin fill no entra).
//   2. Sesión k = k-ésimo día con cierres DESPUÉS del día del fill, en hora
//      del Este (un fill a las 00:30 UTC es del día anterior).
//   3. Signo según lado: una venta gana si el precio baja.
//   4. NULL, NUNCA 0: símbolo sin cierres guardados, un día que le falta a
//      ESE símbolo (no se corre a la sesión siguiente), sesión que no ocurrió.
//   5. El endpoint filtra por agent y desde con parámetros, y rechaza basura.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const { SCHEMA } = await import('../api/_lib/db.js');
const { SCHEMA_PRECIOS_US } = await import('../api/_lib/mercado-precios.js');
const { VISTA_DECISIONES, SQL_DECISIONES, filaDecision } = await import('../api/_lib/liga-decisiones.js');

const FIX = JSON.parse(readFileSync(new URL('./fixtures/liga-decisiones-dia.json', import.meta.url), 'utf8'));
const BIN = binDePostgres();
const PUERTO = 55449;
const lit = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

test('la vista contra un Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: PUERTO });
  for (const q of [...SCHEMA, ...SCHEMA_PRECIOS_US]) {
    try { psql(q + ';'); } catch { /* migración que no aplica en vacío */ }
  }
  for (const r of FIX.journal) {
    psql(`insert into arena_journal (id, run_date, phase, status, agent_id, actions)
          values (${lit(r.id)}, ${lit(r.run_date)}, 'objetivo', 'ok_target', ${lit(r.agent_id)}, ${lit(JSON.stringify(r.actions))}::jsonb);`);
  }
  psql('insert into mercado_precios_us (symbol, fecha, cierre, cierre_ajustado) values '
    + FIX.cierres.map(([s, f, c]) => `(${lit(s)}, ${lit(f)}, ${c}, ${c})`).join(', ') + ';');
  psql(VISTA_DECISIONES + ';');
  // Dos veces: es `create or replace`, el endpoint la corre en cada lambda.
  psql(VISTA_DECISIONES + ';');

  const filas = JSON.parse(psql(`select coalesce(json_agg(d order by filled_at, corrida_id, orden_n), '[]') from liga_decisiones d;`).trim()).map(filaDecision);
  const de = (agent, symbol, lado) => filas.find((f) => f.agent_id === agent && f.symbol === symbol && f.lado === lado);

  await t.test('solo las llenas: 5 de 6 órdenes (la cancelada sin fill no entra)', () => {
    assert.equal(filas.length, 5);
    assert.equal(filas.find((f) => f.symbol === 'DVA'), undefined);
  });

  await t.test('compra: 1, 3 y 5 sesiones después del día del fill', () => {
    const f = de('claude', 'MU', 'buy');
    assert.equal(f.dia_fill, '2026-10-21');
    assert.deepEqual([f.fecha_1, f.fecha_3, f.fecha_5], ['2026-10-22', '2026-10-24', '2026-10-28'], 'el cierre del día del fill no cuenta');
    assert.deepEqual([f.cierre_1, f.cierre_3, f.cierre_5], [120, 122, 125]);
    assert.equal(f.resultado_1_pct, +((120 - 118.4) / 118.4 * 100).toFixed(4));
    assert.equal(f.resultado_3_pct, +((122 - 118.4) / 118.4 * 100).toFixed(4));
    assert.equal(f.resultado_5_pct, +((125 - 118.4) / 118.4 * 100).toFixed(4));
    assert.equal(f.cantidad, 40);
  });

  await t.test('venta: el signo se invierte (gana si baja) y un día que le falta al símbolo es null', () => {
    const f = de('claude', 'PGR', 'sell');
    assert.equal(f.resultado_1_pct, +(-(260 - 265.1) / 265.1 * 100).toFixed(4));
    assert.ok(f.resultado_1_pct > 0, 'bajó de 265.10 a 260: la venta acertó');
    assert.equal(f.fecha_3, '2026-10-24', 'la sesión 3 es la del calendario, no "la tercera fila de PGR"');
    assert.equal(f.cierre_3, null);
    assert.equal(f.resultado_3_pct, null, 'sin cierre de PGR ese día: null, no se corre al día siguiente ni se pone 0');
    assert.equal(f.resultado_5_pct, +(-(262 - 265.1) / 265.1 * 100).toFixed(4));
  });

  await t.test('el día del fill es el del Este: 00:30 UTC del 22 es el 21', () => {
    const f = de('control', 'MU', 'buy');
    assert.equal(f.dia_fill, '2026-10-21');
    assert.equal(f.order_status, 'partially_filled');
    assert.equal(f.cantidad, 20, 'la parcial entra con lo que se llenó, no con lo pedido');
    assert.equal(f.fecha_1, '2026-10-22');
    assert.equal(f.resultado_1_pct, +((120 - 118.5) / 118.5 * 100).toFixed(4));
  });

  await t.test('símbolo sin cierres guardados: todo null, con las fechas de sesión igual', () => {
    const f = de('control', 'ZZZQ', 'buy');
    assert.equal(f.fecha_1, '2026-10-22');
    assert.deepEqual([f.cierre_1, f.resultado_1_pct, f.resultado_3_pct, f.resultado_5_pct], [null, null, null, null]);
  });

  await t.test('sesiones que todavía no ocurrieron: null', () => {
    const f = de('claude', 'MU', 'sell');
    assert.equal(f.fecha_1, '2026-10-28');
    assert.equal(f.resultado_1_pct, +(-(125 - 121) / 121 * 100).toFixed(4));
    assert.deepEqual([f.fecha_3, f.resultado_3_pct, f.fecha_5, f.resultado_5_pct], [null, null, null, null]);
  });

  await t.test('la consulta del endpoint, con parámetros reales: agent y desde', () => {
    const contar = (a, d) => psql(`prepare q_${a || 'x'}_${(d || 'x').replace(/-/g, '')} as ${SQL_DECISIONES};
      execute q_${a || 'x'}_${(d || 'x').replace(/-/g, '')}(${lit(a)}, ${lit(d)});`).trim().split('\n').filter(Boolean).length;
    assert.equal(contar(null, null), 5);
    assert.equal(contar('claude', null), 3);
    assert.equal(contar('control', null), 2);
    assert.equal(contar('claude', '2026-10-22'), 1, 'desde filtra por día del fill');
  });
});

// El handler: valida y pasa los parámetros, nunca los interpola.
test('/api/liga/decisiones: valida agent y desde, y manda los parámetros', async () => {
  const consultas = [];
  global.fetch = async (url, opts = {}) => {
    const { query, params } = JSON.parse(opts.body);
    consultas.push({ query, params });
    const fila = /from liga_decisiones/.test(query)
      ? { fields: ['corrida_id', 'agent_id', 'symbol', 'lado', 'precio_ejecucion', 'resultado_1_pct', 'dia_fill'].map((name) => ({ name, dataTypeID: 25 })),
        rows: [['c1', 'claude', 'MU', 'buy', '118.4', '1.3514', '2026-10-21']] }
      : { fields: [], rows: [] };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => fila, text: async () => JSON.stringify(fila) };
  };
  const handler = (await import('../api/liga-decisiones.js')).default;
  const res = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

  const malo = res();
  await handler({ method: 'GET', query: { agent: "claude'; drop table x;--" } }, malo);
  assert.equal(malo.code, 400);
  const fecha = res();
  await handler({ method: 'GET', query: { desde: '21-10-2026' } }, fecha);
  assert.equal(fecha.code, 400);
  assert.equal(consultas.length, 0, 'lo inválido no llega a la base');

  const ok = res();
  await handler({ method: 'GET', query: { agent: 'claude', desde: '2026-10-21' } }, ok);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.match(consultas[0].query, /create or replace view liga_decisiones/);
  const sel = consultas.find((c) => /from liga_decisiones/.test(c.query));
  assert.deepEqual(sel.params, ['claude', '2026-10-21']);
  assert.equal(ok.body.n, 1);
  assert.equal(ok.body.decisiones[0].precio_ejecucion, 118.4, 'el numeric llega como número');
  assert.equal(ok.body.decisiones[0].resultado_1_pct, 1.3514);
  assert.match(ok.body.definiciones, /nunca 0/);
});
