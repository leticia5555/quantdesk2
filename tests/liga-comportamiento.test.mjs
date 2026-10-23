// ═══════════════════════════════════════════════════════════════════
// tests/liga-comportamiento.test.mjs — las métricas de /api/liga/comportamiento
// contra la cuenta hecha a mano, y el endpoint por el camino real.
//
// Lo que se blinda:
//   1. Cada métrica contra series chicas que se verifican en papel.
//   2. NULL CUANDO NO HAY DATOS, NUNCA 0 — y 0 solo cuando el dato lo dice
//      (un día con equity y sin órdenes rotó 0%).
//   3. Control al lado: la diferencia sale null si falta cualquiera de los dos.
//   4. Las dos consultas nuevas contra un Postgres real (la DDL del repo).
//   5. El handler: valida agent, lee todo, y si Alpaca no contesta publica
//      igual con persecución y beta en null y el motivo.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
for (const a of ['PAPER', 'CONTROL', 'OPENAI', 'GROK', 'GEMINI', 'DEEPSEEK', 'QWEN']) {
  process.env['ALPACA_' + a + '_KEY'] = 'k'; process.env['ALPACA_' + a + '_SECRET'] = 's';
}

const C = await import('../api/_lib/liga-comportamiento.js');
const { enfoqueDelDia } = await import('../api/_lib/arena-herding.js');
const { SQL_EQUITY_DIARIO, SQL_LIBROS } = await import('../api/liga-comportamiento.js');
const { SCHEMA_EQUITY } = await import('../api/_lib/arena-equity.js');
const { SCHEMA } = await import('../api/_lib/db.js');

const fill = (o) => ({ agent_id: 'claude', lado: 'buy', cantidad: 1, precio_ejecucion: 100, dia_fill: '2026-10-21', filled_at: '2026-10-21T15:00:00Z', ...o });
const serie = (pts) => pts.map(([fecha, equity, cash = null]) => ({ fecha, equity, cash }));

test('rotación: Σ|nocional| / equity del día; sin órdenes = 0 (dato); sin equity = null', () => {
  const r = C.rotacion([
    fill({ cantidad: 10, precio_ejecucion: 100 }),
    fill({ lado: 'sell', cantidad: 5, precio_ejecucion: 200 }),
    fill({ dia_fill: '2026-10-23', cantidad: 1, precio_ejecucion: 50 }),
  ], serie([['2026-10-21', 100000], ['2026-10-22', 101000]]));
  const d = Object.fromEntries(r.por_dia.map((x) => [x.fecha, x]));
  assert.equal(d['2026-10-21'].rotacion_pct, 2, '2000 / 100000');
  assert.equal(d['2026-10-22'].rotacion_pct, 0, 'equity y ninguna orden: rotó 0%, eso es un dato');
  assert.equal(d['2026-10-23'].rotacion_pct, null, 'órdenes sin equity guardado: no se puede medir');
  assert.equal(r.promedio_pct, 1);
  assert.equal(r.dias, 2);
  assert.equal(C.rotacion([], []).promedio_pct, null);
});

test('acierto a 5 sesiones: solo compras con resultado; tamaño del acierto vs el error', () => {
  const a = C.acierto5([
    fill({ resultado_5_pct: 2 }), fill({ resultado_5_pct: -1 }), fill({ resultado_5_pct: 4 }),
    fill({ resultado_5_pct: null }), fill({ lado: 'sell', resultado_5_pct: 3 }),
  ]);
  assert.deepEqual(a, { compras_medidas: 3, pct_arriba: 66.67, acierto_prom_pct: 3, error_prom_pct: -1 });
  assert.deepEqual(C.acierto5([fill({ resultado_5_pct: null })]), { compras_medidas: 0, pct_arriba: null, acierto_prom_pct: null, error_prom_pct: null });
});

test('días por posición: episodios con signo, cortos, cruce, y lo heredado aparte', () => {
  const t0 = Date.parse('2026-10-20T15:00:00Z');
  const en = (d) => new Date(t0 + d * 86400000).toISOString();
  const r = C.diasPorPosicion([
    fill({ symbol: 'BBB', cantidad: 5, filled_at: en(0) }),
    fill({ symbol: 'BBB', lado: 'sell', cantidad: 5, filled_at: en(2) }),     // cerrada: 2 días
    fill({ symbol: 'CCC', cantidad: 3, filled_at: en(1) }),                   // abierta: 3 días
    fill({ symbol: 'AAA', lado: 'sell', cantidad: 10, filled_at: en(1) }),    // heredada: sin inicio
    fill({ symbol: 'GM', lado: 'sell', cantidad: 3, filled_at: en(0) }),      // corto…
    fill({ symbol: 'GM', cantidad: 3, filled_at: en(0.5) }),                  // …cubierto: 0.5 días
    fill({ symbol: 'DDD', cantidad: 2, filled_at: en(0) }),
    fill({ symbol: 'DDD', lado: 'sell', cantidad: 5, filled_at: en(1) }),     // cierra 1 día y abre corto
  ], [{ symbol: 'AAA', qty: 10 }], new Date(en(4)));
  assert.deepEqual(r.cerradas, { n: 3, dias_prom: +((2 + 0.5 + 1) / 3).toFixed(2), sin_inicio_conocido: 1 });
  assert.deepEqual(r.abiertas, { n: 2, dias_prom: 3, sin_inicio_conocido: 0 }, 'CCC 3 días y el corto de DDD 3 días');
  const nada = C.diasPorPosicion([], [], new Date());
  assert.equal(nada.cerradas.dias_prom, null);
  assert.equal(nada.abiertas.dias_prom, null);
});

test('concentración: peso máximo y posiciones por día; libro vacío = 0 posiciones y peso null', () => {
  const r = C.concentracion([
    { fecha: '2026-10-21', equity: 100000, holdings: [{ market_value: 20000 }, { market_value: -5000 }, { market_value: 10000 }] },
    { fecha: '2026-10-22', equity: 100000, holdings: [] },
  ]);
  assert.equal(r.por_dia[0].peso_max_pct, 20);
  assert.equal(r.por_dia[1].peso_max_pct, null, 'no hay "mayor posición" en un libro vacío');
  assert.equal(r.peso_max_prom_pct, 20);
  assert.equal(r.posiciones_prom, 1.5);
  assert.equal(C.concentracion([]).posiciones_prom, null);
});

test('caja promedio, y caída máxima desde el pico', () => {
  assert.deepEqual(C.cajaPromedio(serie([['a', 100000, 50000], ['b', 120000, 30000]])), { promedio_pct: 37.5, dias: 2 });
  assert.deepEqual(C.cajaPromedio(serie([['a', 100000]])), { promedio_pct: null, dias: 0 });
  const dd = C.caidaMaxima(serie([['d1', 100], ['d2', 120], ['d3', 90], ['d4', 110], ['d5', 80]]));
  assert.deepEqual(dd, { pct: 33.33, desde: 'd2', hasta: 'd5', dias: 5 });
  assert.equal(C.caidaMaxima(serie([['d1', 100]])).pct, null, 'con un día no hay caída que medir');
  assert.equal(C.caidaMaxima(serie([['d1', 100], ['d2', 110]])).pct, 0, 'dos días subiendo: 0 es el dato');
});

test('Sharpe diario sin anualizar: media / desvío muestral', () => {
  const s = C.sharpeDiario(serie([['d1', 100], ['d2', 101], ['d3', 104.03]]));
  // retornos 0.01 y 0.03: media 0.02, desvío √((0.01²+0.01²)/1) = 0.014142
  assert.equal(s.valor, +(0.02 / Math.sqrt(0.0002)).toFixed(4));
  assert.equal(s.retornos, 2);
  assert.match(s.nota, /sin anualizar/);
  assert.equal(C.sharpeDiario(serie([['d1', 100], ['d2', 101]])).valor, null, 'un retorno no tiene desvío');
});

test('beta contra SPY: un agente que se mueve el doble que SPY tiene beta 2', () => {
  const spy = { d1: 100, d2: 101, d3: 99, d4: 102 };
  const eq = [['d1', 1000]];
  const dias = ['d1', 'd2', 'd3', 'd4'];
  for (let i = 1; i < dias.length; i++) eq.push([dias[i], eq[i - 1][1] * (1 + 2 * (spy[dias[i]] / spy[dias[i - 1]] - 1))]);
  assert.deepEqual(C.betaSpy(serie(eq), spy), { valor: 2, dias: 3 });
  assert.deepEqual(C.betaSpy(serie(eq), { d1: 100, d2: 101 }), { valor: null, dias: 1 }, 'un solo par no alcanza');
});

test('persecución: (ejecución − apertura del día) / apertura, solo compras con apertura', () => {
  const p = C.persecucion([
    fill({ symbol: 'A', precio_ejecucion: 102 }), fill({ symbol: 'B', precio_ejecucion: 99 }),
    fill({ symbol: 'C', precio_ejecucion: 50 }), fill({ symbol: 'A', lado: 'sell', precio_ejecucion: 120 }),
  ], { A: { '2026-10-21': 100 }, B: { '2026-10-21': 100 } });
  assert.deepEqual(p, { promedio_pct: 0.5, compras_medidas: 2 });
  assert.deepEqual(C.persecucion([fill({ symbol: 'C' })], {}), { promedio_pct: null, compras_medidas: 0 });
});

test('retorno por enfoque: el enfoque es el del día del fill; control hereda el de claude', () => {
  const f1 = '2026-10-20T15:00:00Z', f2 = '2026-10-21T15:00:00Z';
  const r = C.retornoPorEnfoque([
    fill({ filled_at: f1, resultado_1_pct: 1, resultado_5_pct: null }),
    fill({ filled_at: f1, resultado_1_pct: 3, resultado_5_pct: 5 }),
    fill({ filled_at: f2, resultado_1_pct: -2 }),
  ], 'claude');
  const l1 = enfoqueDelDia('claude', new Date(f1)).id, l2 = enfoqueDelDia('claude', new Date(f2)).id;
  assert.notEqual(l1, l2, 'la rotación cambia el enfoque de un día al otro');
  assert.deepEqual(r[l1], { compras: 2, ret_1_prom_pct: 2, ret_5_prom_pct: 5 });
  assert.deepEqual(r[l2], { compras: 1, ret_1_prom_pct: -2, ret_5_prom_pct: null });
  const otra = Object.keys(r).find((k) => k !== l1 && k !== l2);
  assert.deepEqual(r[otra], { compras: 0, ret_1_prom_pct: null, ret_5_prom_pct: null }, 'un enfoque sin compras es null, no 0');
  assert.deepEqual(C.retornoPorEnfoque([fill({ filled_at: f1, resultado_1_pct: 1 })], 'control'), C.retornoPorEnfoque([fill({ filled_at: f1, resultado_1_pct: 1 })], 'claude'));
});

test('lado a lado: diferencia = agente − control; null si falta cualquiera', () => {
  const datos = {
    decisiones: [fill({ agent_id: 'claude', resultado_5_pct: 2 }), fill({ agent_id: 'control', resultado_5_pct: -1 })],
    equityDiario: [{ agent_id: 'claude', fecha: '2026-10-21', equity: 100000, cash: 40000 }],
    libros: [], spy: {}, aperturas: {},
  };
  const m = C.comportamientoDe('claude', datos), c = C.comportamientoDe('control', datos);
  const l = C.ladoALado(m, c);
  assert.deepEqual(l.acierto_5_pct_arriba, { agente: 100, control: 0, diferencia: 100 });
  assert.deepEqual(l.caja_prom_pct, { agente: 40, control: null, diferencia: null }, 'control sin equity: null, no 40 − 0');
  assert.equal(Object.keys(l).length, C.ESCALARES.length);
});

test('comportamientoDe: el libro inicial es el PRIMERO de la ventana y la concentración usa el ÚLTIMO de cada día', () => {
  const datos = {
    decisiones: [fill({ symbol: 'AAA', lado: 'sell', cantidad: 10, filled_at: '2026-10-21T16:00:00Z' })],
    equityDiario: [],
    libros: [
      { agent_id: 'claude', fecha: '2026-10-21', creado: '2026-10-21T18:00:00Z', equity: 100000, holdings: [{ symbol: 'BBB', qty: 1, market_value: 50000 }] },
      { agent_id: 'claude', fecha: '2026-10-21', creado: '2026-10-21T14:00:00Z', equity: 100000, holdings: [{ symbol: 'AAA', qty: 10, market_value: 10000 }] },
    ],
    spy: {}, aperturas: {},
  };
  const m = C.comportamientoDe('claude', datos, { ahora: new Date('2026-10-22T00:00:00Z') });
  assert.equal(m.dias_por_posicion.cerradas.sin_inicio_conocido, 1, 'AAA venía del libro de las 14:00 (el primero)');
  assert.equal(m.concentracion.por_dia[0].peso_max_pct, 50, 'el libro de las 18:00 (el último del día)');
});

// ── Las consultas, contra un Postgres de verdad ─────────────────────────
const BIN = binDePostgres();
test('SQL: equity de CIERRE de cada sesión y libros de la temporada, contra Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55453 });
  for (const q of [...SCHEMA, ...SCHEMA_EQUITY]) { try { psql(q + ';'); } catch { /* migración que no aplica en vacío */ } }
  psql(`insert into arena_equity_intraday (agent_id, minuto, session_date, equity, cash) values
    ('claude', '2026-10-21T14:00:00Z', '2026-10-21', 100000, 50000),
    ('claude', '2026-10-21T19:55:00Z', '2026-10-21', 101000, 40000),
    ('claude', '2026-10-22T19:55:00Z', '2026-10-22', 99000, 30000),
    ('claude', '2026-10-17T19:55:00Z', '2026-10-17', 1, 1);`);
  psql(`insert into arena_journal (id, run_date, phase, status, agent_id, account, created_at) values
    ('r1', '2026-10-21', 'objetivo', 'ok_target', 'claude', '{"equity":100000,"cash":50000,"holdings":[{"symbol":"MU","qty":2,"market_value":1800}]}', '2026-10-21T14:00:00Z'),
    ('r2', '2026-10-21', 'objetivo', 'ok_target', 'claude', null, '2026-10-21T15:00:00Z'),
    ('r0', '2026-10-17', 'objetivo', 'ok_target', 'claude', '{"equity":1}', '2026-10-17T14:00:00Z');`);
  const eq = psql(`prepare e as ${SQL_EQUITY_DIARIO}; execute e('2026-10-20');`).trim().split('\n');
  assert.deepEqual(eq, ['claude|2026-10-21|101000|40000', 'claude|2026-10-22|99000|30000'], 'la última muestra de cada día, desde el inicio');
  const li = psql(`prepare l as ${SQL_LIBROS}; execute l('2026-10-20');`).trim().split('\n');
  assert.equal(li.length, 1, 'sin account no entra, y antes de la temporada tampoco');
  assert.match(li[0], /^claude\|2026-10-21\|.*"MU"/);
});

// ── El handler, por el camino real con la red simulada ──────────────────
const json = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => 'application/json' }, json: async () => b, text: async () => JSON.stringify(b) });
let alpacaCaida = false;
const consultas = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/v2/stocks/bars')) {
    if (alpacaCaida) return json({ message: 'internal' }, 500);
    return json({ bars: {
      SPY: [{ t: '2026-10-20T04:00:00Z', o: 600, c: 600 }, { t: '2026-10-21T04:00:00Z', o: 600, c: 606 }, { t: '2026-10-22T04:00:00Z', o: 606, c: 600 }],
      MU: [{ t: '2026-10-21T04:00:00Z', o: 900, c: 913 }],
    }, next_page_token: null });
  }
  if (u.includes('neon.tech')) {
    const { query, params } = JSON.parse(opts.body);
    consultas.push({ query, params });
    const filas = (fields, rows) => json({ fields: fields.map((name) => ({ name, dataTypeID: 25 })), rows });
    if (/from liga_decisiones/.test(query)) {
      return filas(['agent_id', 'symbol', 'lado', 'cantidad', 'precio_ejecucion', 'filled_at', 'dia_fill', 'resultado_1_pct', 'resultado_5_pct'], [
        ['claude', 'MU', 'buy', '2', '918.04', '2026-10-21T19:31:11Z', '2026-10-21', '-6.7', null],
        ['control', 'MU', 'buy', '1', '909', '2026-10-21T19:31:11Z', '2026-10-21', '-5.8', null],
      ]);
    }
    if (/from arena_equity_intraday/.test(query)) {
      return filas(['agent_id', 'fecha', 'equity', 'cash'], [
        ['claude', '2026-10-20', '100000', '50000'], ['claude', '2026-10-21', '101000', '40000'], ['claude', '2026-10-22', '99990', '40000'],
        ['control', '2026-10-20', '100000', '60000'], ['control', '2026-10-21', '100500', '60000'], ['control', '2026-10-22', '100000', '60000'],
      ]);
    }
    if (/from arena_journal/.test(query)) return filas(['agent_id', 'fecha', 'creado', 'account'], []);
    return json({ fields: [], rows: [] });
  }
  return json({});
};

const mkRes = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

test('/api/liga/comportamiento: valida agent, trae Control al lado, y no inventa', async () => {
  const handler = (await import('../api/liga-comportamiento.js')).default;
  const malo = mkRes();
  await handler({ method: 'GET', query: { agent: 'nadie' } }, malo);
  assert.equal(malo.code, 400);

  const r = mkRes();
  await handler({ method: 'GET', query: { agent: 'claude' } }, r, { ahora: new Date('2026-10-23T00:00:00Z') });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const desde = consultas.find((c) => /from arena_equity_intraday/.test(c.query)).params[0];
  assert.match(desde, /^\d{4}-\d{2}-\d{2}$/, 'la ventana arranca en la temporada');
  const [a] = r.body.agentes;
  assert.equal(a.agent, 'claude');
  // Persecución: claude compró MU a 918.04 con apertura 900 → +2.0044%.
  assert.deepEqual(a.con_control.persecucion_prom_pct, { agente: 2, control: 1, diferencia: 1 });
  // Caja de control: 60000/100000, 60000/100500, 60000/100000 → (60 + 59.70 + 60) / 3.
  assert.equal(a.con_control.caja_prom_pct.control, +((60 + (60000 / 100500) * 100 + 60) / 3).toFixed(2));
  assert.equal(a.con_control.caja_prom_pct.agente, +((50 + (40000 / 101000) * 100 + (40000 / 99990) * 100) / 3).toFixed(2));
  assert.equal(a.metricas.beta_spy.dias, 2);
  assert.notEqual(a.metricas.beta_spy.valor, null);
  assert.equal(a.con_control.acierto_5_pct_arriba.agente, null, 'sin resultado a 5 sesiones todavía: null, no 0');
  assert.match(r.body.notas.sharpe, /sin anualizar/);
  assert.equal(r.body.barras_error, undefined);

  // La tarjeta de control no se compara consigo misma.
  const rc = mkRes();
  await handler({ method: 'GET', query: { agent: 'control' } }, rc);
  assert.equal(rc.body.agentes[0].con_control, null);
});

test('/api/liga/comportamiento: Alpaca caída → se publica igual, persecución y beta null con el motivo', async () => {
  alpacaCaida = true;
  const handler = (await import('../api/liga-comportamiento.js')).default;
  const r = mkRes();
  await handler({ method: 'GET', query: { agent: 'claude' } }, r);
  assert.equal(r.code, 200);
  const a = r.body.agentes[0];
  assert.equal(a.metricas.persecucion.promedio_pct, null);
  assert.equal(a.metricas.beta_spy.valor, null);
  assert.notEqual(a.metricas.caja.promedio_pct, null, 'lo que no depende de Alpaca sale igual');
  assert.match(r.body.barras_error, /Alpaca data 500/);
  alpacaCaida = false;
});
