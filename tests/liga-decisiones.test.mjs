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
const lit = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

function base(t, puerto) {
  const psql = levantaPostgres(t, { bin: BIN, puerto });
  for (const q of [...SCHEMA, ...SCHEMA_PRECIOS_US]) {
    try { psql(q + ';'); } catch { /* migración que no aplica en vacío */ }
  }
  const journal = (rows) => rows.forEach((r) => psql(`insert into arena_journal (id, run_date, phase, status, agent_id, actions)
      values (${lit(r.id)}, ${lit(r.run_date)}, 'objetivo', 'ok_target', ${lit(r.agent_id)}, ${lit(JSON.stringify(r.actions))}::jsonb);`));
  const cierres = (rows) => psql('insert into mercado_precios_us (symbol, fecha, cierre, cierre_ajustado) values '
    + rows.map(([s, f, c]) => `(${lit(s)}, ${lit(f)}, ${c}, ${c})`).join(', ') + ';');
  const leer = () => JSON.parse(psql(`select coalesce(json_agg(d order by filled_at, corrida_id, orden_n), '[]') from liga_decisiones d;`).trim()).map(filaDecision);
  return { psql, journal, cierres, leer };
}

// ── EL DÍA REAL: 2026-10-21 ─────────────────────────────────────────────
// 42 corridas, 124 órdenes llenas, 36 símbolos. Cierres guardados: 21 y 22-oct.
test('el día real (21-oct) contra un Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(BIN, FALTA_POSTGRES);
  const { psql, journal, cierres, leer } = base(t, 55449);
  journal(FIX.journal);
  cierres(FIX.cierres);
  psql(VISTA_DECISIONES + ';');
  // Dos veces: es `create or replace`, el endpoint la corre en cada lambda.
  psql(VISTA_DECISIONES + ';');

  const ordenes = FIX.journal.flatMap((r) => r.actions.map((a) => ({ ...a, agent_id: r.agent_id, corrida_id: r.id })));
  const cierre22 = new Map(FIX.cierres.filter(([, f]) => f === '2026-10-22').map(([s, , c]) => [s, Number(c)]));
  const filas = leer();
  const clave = (x) => (x.corrida_id + '|' + (x.client_order_id || ''));

  await t.test('las 124 órdenes llenas están, una fila cada una', () => {
    assert.equal(ordenes.length, 124);
    assert.equal(filas.length, 124);
    assert.deepEqual(new Set(filas.map(clave)), new Set(ordenes.map(clave)));
    assert.ok(filas.every((f) => f.dia_fill === '2026-10-21'), 'todas del 21 en hora del Este');
  });

  await t.test('resultado a 1 sesión = cierre del 22 contra el precio de ejecución, con signo por lado (las 120 con cierre)', () => {
    let comprobadas = 0;
    for (const o of ordenes) {
      if (o.symbol === 'ANET') continue;
      const f = filas.find((x) => clave(x) === clave(o));
      const c = cierre22.get(o.symbol);
      const signo = o.side === 'sell' ? -1 : 1;
      assert.equal(f.fecha_1, '2026-10-22', o.client_order_id);
      assert.equal(f.cierre_1, c, o.client_order_id);
      assert.ok(Math.abs(f.resultado_1_pct - signo * ((c - o.filled_avg_price) / o.filled_avg_price) * 100) < 1e-4, o.client_order_id);
      comprobadas++;
    }
    assert.equal(comprobadas, 120);
  });

  await t.test('a mano, una: claude vendió 2 MU a 918.04 y MU cerró el 22 en 856.49 → la venta ganó +6.70%', () => {
    const f = filas.find((x) => x.client_order_id === 'arena-claude-d1930-2026-10-21-MU-sell');
    assert.equal(f.lado, 'sell');
    assert.equal(f.resultado_1_pct, 6.7045);
  });

  await t.test('ANET (no está en mercado_precios_us): sus 4 órdenes salen, con resultado null — no desaparecen', () => {
    const anet = filas.filter((f) => f.symbol === 'ANET');
    assert.equal(anet.length, 4, 'deepseek: 1 compra y 3 ventas');
    for (const f of anet) {
      assert.equal(f.agent_id, 'deepseek');
      assert.equal(f.fecha_1, '2026-10-22', 'la sesión existe; lo que falta es el cierre de ANET');
      assert.deepEqual([f.cierre_1, f.resultado_1_pct, f.resultado_3_pct, f.resultado_5_pct], [null, null, null, null]);
      assert.ok(f.precio_ejecucion > 0 && f.cantidad > 0, 'la orden está entera');
    }
  });

  await t.test('a 3 y 5 sesiones: null, porque esas sesiones todavía no ocurrieron', () => {
    for (const f of filas) assert.deepEqual([f.fecha_3, f.resultado_3_pct, f.fecha_5, f.resultado_5_pct], [null, null, null, null], f.client_order_id);
  });

  await t.test('los null NO se guardan: cuando llegan los cierres, la misma consulta los llena sola', () => {
    // Llegan las sesiones 23, 24, 27 y 28-oct, solo para MU y VRT.
    cierres([['MU', '2026-10-23', 870], ['MU', '2026-10-24', 880], ['MU', '2026-10-27', 890], ['MU', '2026-10-28', 900],
      ['VRT', '2026-10-23', 200], ['VRT', '2026-10-24', 205], ['VRT', '2026-10-27', 210], ['VRT', '2026-10-28', 220]]);
    const despues = leer();
    const mu = despues.find((x) => x.client_order_id === 'arena-claude-d1930-2026-10-21-MU-sell');
    assert.deepEqual([mu.fecha_3, mu.cierre_3, mu.fecha_5, mu.cierre_5], ['2026-10-24', 880, '2026-10-28', 900]);
    assert.equal(mu.resultado_3_pct, +(-(880 - 918.04) / 918.04 * 100).toFixed(4));
    const vrt = despues.find((x) => x.client_order_id === 'arena-deepseek-w1335-2026-10-21-VRT-buy');
    assert.equal(vrt.resultado_5_pct, +((220 - 217.691959) / 217.691959 * 100).toFixed(4));
    // Los demás símbolos no tienen cierre del 24: siguen null (el calendario
    // avanzó, su cierre no llegó) — y ANET sigue null en todo.
    const dell = despues.find((x) => x.symbol === 'DELL');
    assert.equal(dell.fecha_3, '2026-10-24');
    assert.equal(dell.resultado_3_pct, null);
    assert.ok(despues.filter((x) => x.symbol === 'ANET').every((x) => x.resultado_1_pct === null && x.resultado_5_pct === null));
    assert.equal(despues.length, 124);
  });

  await t.test('la consulta del endpoint, con parámetros reales: agent y desde', () => {
    const contar = (a, d) => psql(`prepare q_${a || 'x'}_${(d || 'x').replace(/-/g, '')} as ${SQL_DECISIONES};
      execute q_${a || 'x'}_${(d || 'x').replace(/-/g, '')}(${lit(a)}, ${lit(d)});`).trim().split('\n').filter(Boolean).length;
    const deAgente = (a) => ordenes.filter((o) => o.agent_id === a).length;
    assert.equal(contar(null, null), 124);
    assert.equal(contar('deepseek', null), deAgente('deepseek'));
    assert.equal(contar('claude', null), deAgente('claude'));
    assert.equal(contar('claude', '2026-10-22'), 0, 'desde filtra por día del fill');
  });
});

// ── BORDES QUE EL DÍA REAL NO TRAE (sintéticos, a propósito) ─────────────
// El 21-oct todo llenó completo, en horario de mercado, y sin huecos de
// calendario. Estas reglas igual tienen que valer, y solo se pueden probar con
// filas armadas para cada borde. Forma exacta del reconcile.
test('bordes: parcial, cancelada, fill de noche (UTC del día siguiente) y un día que le falta al símbolo', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(BIN, FALTA_POSTGRES);
  const { psql, journal, cierres, leer } = base(t, 55451);
  const orden = (o) => ({ result: 'approved', origin: 'objetivo', intencion: o.side, ...o });
  journal([
    { id: 'b1', agent_id: 'control', run_date: '2026-10-21', actions: [
      orden({ symbol: 'MU', side: 'buy', qty: 50, order_status: 'partially_filled', filled_qty: 20, filled_avg_price: 118.5, filled_at: '2026-10-22T00:30:00Z', client_order_id: 'parcial-noche' }),
      orden({ symbol: 'DVA', side: 'buy', qty: 30, order_status: 'canceled', filled_qty: 0, filled_avg_price: null, filled_at: null, client_order_id: 'cancelada' }),
      orden({ symbol: 'PGR', side: 'sell', qty: 10, order_status: 'filled', filled_qty: 10, filled_avg_price: 265.1, filled_at: '2026-10-21T19:58:05Z', client_order_id: 'venta-hueco' }),
    ] },
  ]);
  cierres([['MU', '2026-10-21', 118], ['MU', '2026-10-22', 120], ['MU', '2026-10-23', 117], ['MU', '2026-10-24', 122],
    ['PGR', '2026-10-21', 265], ['PGR', '2026-10-22', 260], ['PGR', '2026-10-23', 266]]);
  psql(VISTA_DECISIONES + ';');
  const filas = leer();
  const de = (c) => filas.find((f) => f.client_order_id === c);

  assert.equal(filas.length, 2, 'la cancelada sin fill no entra');
  const p = de('parcial-noche');
  assert.equal(p.dia_fill, '2026-10-21', '00:30 UTC del 22 es el 21 en el Este');
  assert.equal(p.order_status, 'partially_filled');
  assert.equal(p.cantidad, 20, 'la parcial entra con lo que se llenó');
  assert.deepEqual([p.fecha_1, p.cierre_1, p.fecha_3, p.cierre_3], ['2026-10-22', 120, '2026-10-24', 122]);
  const v = de('venta-hueco');
  assert.equal(v.resultado_1_pct, +(-(260 - 265.1) / 265.1 * 100).toFixed(4), 'venta: gana si baja');
  assert.equal(v.fecha_3, '2026-10-24', 'la sesión 3 es la del calendario, no "la tercera fila de PGR"');
  assert.equal(v.resultado_3_pct, null, 'sin cierre de PGR ese día: null, no se corre al siguiente');
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
