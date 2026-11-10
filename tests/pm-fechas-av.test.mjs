// ═══════════════════════════════════════════════════════════════════════
// Tests de PM-FECHAS-AV (api/_lib/pm-trimestre-av.js + /api/pm-fechas-av).
//
//   1. Criterios pineados.
//   2. Regla: mercado CON fecha → trimestre AV más cercano a ≤ 3 días;
//      SIN fecha → primer reporte ≥ día de creación, ≤ 120 días, no después
//      de la resolución (+1). Cada motivo de "no recuperado".
//   3. Base: unión sin duplicados, resueltos, liquidez, token; la hora del
//      reporte se busca en la fecha EFECTIVA.
//   4. Resumen: recuperados, motivos, validación de la regla, pead informativo.
//   5. Endpoint: gate, escribe SOLO pm_fecha_av, &escribir=0.
//   6. Postgres real: todo el SQL corre; el upsert es idempotente.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import { mockRed, mockRes, GET, soloEscribe } from './_pm-red.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const T = await import('../api/_lib/pm-trimestre-av.js');
const { default: handler } = await import('../api/pm-fechas-av.js');
const { SCHEMA: SCHEMA_V1 } = await import('../api/_lib/earnings-beat-db.js');
const { SCHEMA_V2 } = await import('../api/_lib/earnings-beat-v2-db.js');
const { PEAD_SCHEMA } = await import('../api/_lib/pead-db.js');
const C = T.CRITERIOS_TRIMESTRE_AV;

const HIST = [
  { symbol: 'AAA', fiscal_quarter_end: '2026-03-31', reported_date: '2026-04-28', reported_eps: 1.0, estimated_eps: 0.95 },
  { symbol: 'AAA', fiscal_quarter_end: '2026-06-30', reported_date: '2026-07-29', reported_eps: 1.1, estimated_eps: 1.05 },
  { symbol: 'AAA', fiscal_quarter_end: '2026-09-30', reported_date: '2026-10-28', reported_eps: 1.2, estimated_eps: 1.18 },
];

// ═══════════════════ 1. criterios ═══════════════════

test('criterios congelados', () => {
  assert.ok(Object.isFrozen(C));
  assert.deepEqual({ ...C }, { tolerancia_dias_tabla: 3, max_dias_tras_creacion: 120, holgura_resolucion_dias: 1 });
});

// ═══════════════════ 2. regla ═══════════════════

test('SIN fecha: el primer reporte en o después del día de creación', () => {
  const e = T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-07-05', resolved_date: '2026-07-30' }, HIST);
  assert.equal(e.fecha, '2026-07-29');
  assert.equal(e.fuente_fecha, 'av_hist');
  assert.equal(e.av.estimated_eps, 1.05);
  assert.equal(e.av.fiscal_quarter_end, '2026-06-30');
  // creado el MISMO día del reporte cuenta (≥)
  assert.equal(T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-07-29' }, HIST).fecha, '2026-07-29');
  // el día siguiente ya apunta al trimestre que viene
  assert.equal(T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-07-30' }, HIST).fecha, '2026-10-28');
  // el orden de llegada de las filas no importa
  assert.equal(T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-04-01' }, [...HIST].reverse()).fecha, '2026-04-28');
});

test('SIN fecha: cada motivo de no recuperado', () => {
  const m = (o) => T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-07-05', ...o }, HIST);
  assert.equal(T.emparejaTrimestre({ symbol: null, creado: '2026-07-05' }, HIST).motivo_fecha, 'sin_simbolo');
  assert.equal(m({ creado: null }).motivo_fecha, 'sin_creado');
  assert.equal(T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-07-05' }, []).motivo_fecha, 'simbolo_sin_hist');
  assert.equal(T.emparejaTrimestre({ symbol: 'AAA', creado: '2026-07-05' }, undefined).motivo_fecha, 'simbolo_sin_hist');
  assert.equal(m({ creado: '2026-11-01' }).motivo_fecha, 'hist_desactualizado', 'el último reporte de AV es anterior a la creación');
  assert.equal(m({ creado: '2025-12-28' }).motivo_fecha, 'sin_reporte_cercano', '121 días > 120');
  assert.equal(m({ creado: '2025-12-29' }).fecha, '2026-04-28', '120 días exactos entra');
  assert.equal(m({ resolved_date: '2026-07-27' }).motivo_fecha, 'posterior_a_resolucion', 'resuelto 2 días antes del reporte');
  assert.equal(m({ resolved_date: '2026-07-28' }).fecha, '2026-07-29', '+1 día de holgura');
  for (const x of [m({ creado: null }), m({ creado: '2026-11-01' })]) { assert.equal(x.fecha, null); assert.equal(x.av, null); }
});

test('CON fecha en la tabla: la fecha queda, el trimestre AV es el más cercano a ≤ 3 días', () => {
  const e = T.emparejaTrimestre({ symbol: 'AAA', report_date: '2026-07-31', creado: '2026-01-01' }, HIST);
  assert.equal(e.fecha, '2026-07-31', 'la fecha de la tabla manda');
  assert.equal(e.fuente_fecha, 'tabla');
  assert.equal(e.av.reported_date, '2026-07-29');
  const lejos = T.emparejaTrimestre({ symbol: 'AAA', report_date: '2026-08-02' }, HIST);
  assert.equal(lejos.fecha, '2026-08-02');
  assert.equal(lejos.av, null, '4 días > 3');
  assert.equal(lejos.motivo_av, 'sin_trimestre_av');
  assert.equal(T.emparejaTrimestre({ symbol: 'ZZZ', report_date: '2026-08-02' }, []).motivo_av, 'simbolo_sin_hist');
  // dos candidatos: gana el más cercano
  const dos = [{ symbol: 'B', reported_date: '2026-05-01', estimated_eps: 1 }, { symbol: 'B', reported_date: '2026-05-04', estimated_eps: 2 }];
  assert.equal(T.emparejaTrimestre({ symbol: 'B', report_date: '2026-05-03' }, dos).av.estimated_eps, 2);
});

// ═══════════════════ 3. base ═══════════════════

const fila = (o) => ({ market_id: 'x', symbol: 'AAA', slug: null, question: null, descripcion: null, report_date: null, resolved_date: null,
  creado: '2026-07-05', outcome: 'yes', volume: 1000, yes_token_id: 'tok', cosecha: 'v2', ...o });

test('base: unión sin duplicados, resueltos, liquidez, token; hora en la fecha efectiva', () => {
  const filas = [
    fila({ market_id: '1' }),
    fila({ market_id: '1', cosecha: 'v1', report_date: '2026-01-01' }),
    fila({ market_id: '2', outcome: null }),
    fila({ market_id: '3', volume: 499 }),
    fila({ market_id: '4', yes_token_id: null }),
    fila({ market_id: '5', report_date: '2026-07-29', outcome: 'NO', volume: 500 }),
  ];
  const histPorSimbolo = new Map([['AAA', HIST]]);
  const horas = new Map([['AAA|2026-07-29', 'bmo']]);
  const b = T.baseMercados(filas, { histPorSimbolo, horas });
  assert.deepEqual(b.excluidos, { duplicado: 1, no_resuelto: 1, liquidez: 1, sin_token: 1 });
  assert.deepEqual(b.mercados.map((m) => [m.market_id, m.fecha, m.fuente_fecha, m.hour, m.y]),
    [['1', '2026-07-29', 'av_hist', 'bmo', 1], ['5', '2026-07-29', 'tabla', 'bmo', 0]]);
  assert.equal(b.mercados[0].cosecha, 'v2');
  assert.equal(b.mercados[0].av.estimated_eps, 1.05);
});

// ═══════════════════ 4. resumen ═══════════════════

test('resumen: recuperados, motivos, validación de la regla y pead informativo', () => {
  const filas = [
    fila({ market_id: 'r1', creado: '2026-07-05' }),                                 // recuperado
    fila({ market_id: 'r2', creado: '2026-04-01' }),                                 // recuperado
    fila({ market_id: 'n1', creado: '2026-11-01' }),                                 // hist_desactualizado
    fila({ market_id: 'n2', symbol: 'PPP', creado: '2026-07-05' }),                  // simbolo_sin_hist, pero en pead
    fila({ market_id: 'n3', symbol: null }),                                         // sin_simbolo
    fila({ market_id: 't1', report_date: '2026-07-29', creado: '2026-07-01' }),      // tabla: la regla coincide
    fila({ market_id: 't2', report_date: '2026-07-29', creado: '2026-07-30' }),      // tabla: la regla NO coincide
  ];
  const histPorSimbolo = new Map([['AAA', HIST]]);
  const peadPorSimbolo = new Map([['PPP', [{ symbol: 'PPP', reported_date: '2026-07-20' }]]]);
  const b = T.baseMercados(filas, { histPorSimbolo });
  const r = T.resumenFechas(b, { histPorSimbolo, peadPorSimbolo });
  assert.equal(r.sin_fecha_tabla, 5);
  assert.equal(r.con_fecha_tabla, 2);
  assert.equal(r.recuperados, 2);
  assert.equal(r.no_recuperados, 3);
  assert.deepEqual(r.motivos_no_recuperado, { hist_desactualizado: 1, simbolo_sin_hist: 1, sin_simbolo: 1 });
  assert.equal(r.no_recuperados_que_estan_en_pead_earnings, 1);
  assert.equal(r.validacion_regla.evaluables, 2);
  assert.equal(r.validacion_regla.coincide, 1);
  assert.equal(r.validacion_regla.no_coincide, 1);
  assert.equal(r.validacion_regla.ejemplos_no_coincide[0].market_id, 't2');
  assert.equal(r.con_estimado_av.av_hist, 2);
  assert.equal(r.con_estimado_av.tabla, 2);
  const md = T.renderFechasMarkdown({ generado_en: 'x', resumen: r });
  assert.match(md, /\*\*Recuperados: 2 de 5\*\*/);
  assert.match(md, /50\.0% de acierto/);
});

// ═══════════════════ 5. endpoint ═══════════════════

function red() {
  return mockRed({
    mercados: [fila({ market_id: '1' }), fila({ market_id: '2', report_date: '2026-10-28' }), fila({ market_id: '3', creado: '2026-11-05' })],
    hist: HIST, horas: [{ symbol: 'AAA', reported_date: '2026-07-29', hour: 'amc' }], pead: [],
  });
}

test('endpoint: gate', async () => {
  const r = red();
  globalThis.fetch = r.fetch;
  const a = mockRes();
  await handler(GET({}), a);
  assert.equal(a.code, 401);
  assert.equal(r.queries.length, 0);
});

test('endpoint: rellena, marca la fuente y escribe SOLO pm_fecha_av', async () => {
  const r = red();
  globalThis.fetch = r.fetch;
  const a = mockRes();
  await handler(GET({ secret: SECRET, format: 'md' }), a);
  assert.equal(a.code, 200, a.body && a.body.error);
  assert.match(a.text, /\*\*Recuperados: 1 de 2\*\*/);
  soloEscribe(assert, r.queries, ['pm_fecha_av']);
  assert.deepEqual(r.db.fechas.get('1').slice(5, 8), ['2026-07-29', 'av_hist', null]);
  assert.deepEqual(r.db.fechas.get('2').slice(5, 8), ['2026-10-28', 'tabla', null]);
  assert.deepEqual(r.db.fechas.get('3').slice(5, 8), [null, null, 'hist_desactualizado']);

  const r2 = red();
  globalThis.fetch = r2.fetch;
  const b = mockRes();
  await handler(GET({ secret: SECRET, escribir: '0' }), b);
  assert.equal(b.code, 200);
  assert.equal(r2.db.fechas.size, 0, '&escribir=0 no escribe');
  assert.equal(b.body.resumen.recuperados, 1);
});

// ═══════════════════ 6. Postgres real ═══════════════════

function literal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
const incrusta = (q, params = []) => { for (let i = params.length; i >= 1; i--) q = q.split('$' + i).join(literal(params[i - 1])); return q; };

test('contra Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = SIN_POSTGRES ? null : binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55455 });
  for (const q of SCHEMA_V1) psql(q + ';');
  for (const q of PEAD_SCHEMA) psql(q + ';');
  for (const q of SCHEMA_V2) psql(q + ';');
  for (const q of T.SCHEMA_FECHAS) psql(q + ';');
  for (const q of T.SCHEMA_FECHAS) psql(q + ';');
  psql(`insert into pm_earnings_markets (market_id, symbol, slug, filtro_motivo, creado, report_date, resolved_date, outcome, volume, yes_token_id, raw) values
          ('1', 'AAA', 's1', 'ok', '2026-07-05T23:30:00Z', null, '2026-07-30', 'yes', 900, 't1', '{"description":"d1"}');
        insert into pm_earnings_markets_v2 (market_id, symbol, slug, filtro_motivo, creado, report_date, outcome, volume, yes_token_id) values
          ('2', 'AAA', 's2', 'ok', '2026-10-01T00:00:00Z', '2026-10-28', 'no', 1000, 't2');
        insert into pm_v2_hist (symbol, fiscal_quarter_end, reported_date, reported_eps, estimated_eps) values
          ('AAA', '2026-06-30', '2026-07-29', 1.1, 1.05), ('AAA', '1900-01-01', null, null, null);
        insert into pead_event_hour (symbol, reported_date, hour, source) values ('AAA', '2026-07-29', 'amc', 'sec_8k');
        insert into pead_earnings (symbol, fiscal_date_ending, reported_date) values ('AAA', '2026-06-30', '2026-07-29');`);
  const filas = psql(`select market_id, coalesce(report_date, ''), coalesce(resolved_date, ''), creado, descripcion, cosecha from (${T.SQL_MERCADOS}) x;`).trim().split('\n');
  assert.deepEqual(filas, ['2|2026-10-28||2026-10-01||v2', '1||2026-07-30|2026-07-05|d1|v1'], 'v2 primero; creado en UTC; descripción desde raw');
  assert.equal(psql(incrusta(T.sqlHist(1), ['AAA']) + ';').trim(), 'AAA|2026-06-30|2026-07-29|1.1|1.05', 'el centinela sin fecha no sale');
  assert.equal(psql(incrusta(T.sqlHoras(1), ['AAA']) + ';').trim(), 'AAA|2026-07-29|amc');
  assert.equal(psql(incrusta(T.sqlPead(1), ['AAA']) + ';').trim(), 'AAA|2026-07-29');
  const m = { market_id: '1', symbol: 'AAA', cosecha: 'v1', creado: '2026-07-05', report_date_tabla: null, fecha: '2026-07-29', fuente_fecha: 'av_hist',
    motivo_fecha: null, av: { fiscal_quarter_end: '2026-06-30', estimated_eps: 1.05, reported_eps: 1.1 } };
  const up = T.sqlUpsertFechas([m]);
  psql(incrusta(up.query, up.params) + ';');
  psql(incrusta(up.query, up.params) + ';');
  assert.equal(psql(`select market_id, report_date, fuente_fecha, estimated_eps from pm_fecha_av;`).trim(), '1|2026-07-29|av_hist|1.05');
});
