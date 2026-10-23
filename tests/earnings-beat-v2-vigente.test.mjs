// ═══════════════════════════════════════════════════════════════
// earnings-beat v2 — diagnóstico del consenso vigente (25-oct).
//
// Con EARNINGS_V2_VIGENTE_ENABLED=1, las 68 filas abiertas seguían con
// consenso_vigente null y el latido de ?job=diario no guardaba qué había
// contestado Alpha Vantage. Esto prueba las herramientas para VERLO:
//   - el resumen que ahora va al latido;
//   - el parser del CSV de EARNINGS_CALENDAR (la fuente alternativa);
//   - ?job=vigente_diag de punta a punta, que no escribe nada.
// Sin cambios de fórmula. Correr con `node tests/earnings-beat-v2-vigente.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resumenCaptura, parseCalendarioCsv, estimadoVigenteDeAv } from '../api/_lib/earnings-beat-v2.js';
import { SCHEMA as SCHEMA_V1 } from '../api/_lib/earnings-beat-db.js';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import { puenteNeon, resFalsa } from './_neon-psql.mjs';

test('el latido de ?job=diario resume qué contestó AV, por estado', () => {
  const r = resumenCaptura({
    activa: true, llamadas: 3, cupo_libre_antes: 12,
    intentos: [
      { symbol: 'CL', estado: 'av_sin_estimado_del_trimestre' },
      { symbol: 'VZ', estado: 'av_sin_estimado_del_trimestre' },
      { symbol: 'KO', estado: 'capturado', valor: 0.81 },
    ],
  });
  assert.deepEqual(r.por_estado, { av_sin_estimado_del_trimestre: 2, capturado: 1 });
  assert.equal(r.llamadas, 3);
  assert.deepEqual(r.muestras, ['CL:av_sin_estimado_del_trimestre', 'VZ:av_sin_estimado_del_trimestre', 'KO:capturado=0.81']);
  assert.deepEqual(resumenCaptura({ activa: false }), { activa: false, error: null, llamadas: 0, cupo_libre_antes: null, por_estado: {}, muestras: [] });
});

test('CSV de EARNINGS_CALENDAR: por nombre de columna, con comas entre comillas y estimado vacío', () => {
  const csv = 'symbol,name,reportDate,fiscalDateEnding,estimate,currency\r\n'
    + 'AAA,"Acme, Inc",2026-10-31,2026-09-30,1.11,USD\r\n'
    + 'BBB,Beta Corp,2026-10-27,2026-09-30,,USD\r\n';
  const r = parseCalendarioCsv(csv);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.filas, [
    { symbol: 'AAA', report_date: '2026-10-31', fiscal_date_ending: '2026-09-30', estimate: 1.11, currency: 'USD' },
    { symbol: 'BBB', report_date: '2026-10-27', fiscal_date_ending: '2026-09-30', estimate: null, currency: 'USD' },
  ]);
  // columnas en otro orden: no se mezclan
  const r2 = parseCalendarioCsv('estimate,symbol,reportDate,fiscalDateEnding\n2.5,CCC,2026-11-02,2026-09-30');
  assert.deepEqual([r2.filas[0].symbol, r2.filas[0].estimate], ['CCC', 2.5]);
});

test('CSV de EARNINGS_CALENDAR: rate limit, vacío y cabecera inesperada se declaran, no se inventan filas', () => {
  assert.equal(parseCalendarioCsv('{"Note":"Thank you for using Alpha Vantage! ..."}').status, 'rate_limited');
  assert.equal(parseCalendarioCsv('').status, 'vacio');
  assert.equal(parseCalendarioCsv('foo,bar\n1,2').status, 'cabecera_inesperada');
  assert.equal(parseCalendarioCsv('{"x":1}').status, 'no_csv');
});

test('si EARNINGS solo trae trimestres reportados, la captura no tiene de dónde sacar un vigente', () => {
  const soloReportados = [
    { fiscal_date_ending: '2026-06-30', reported_date: '2026-07-25', reported_eps: 0.92, estimated_eps: 0.89 },
    { fiscal_date_ending: '2026-03-31', reported_date: '2026-04-25', reported_eps: 0.88, estimated_eps: 0.86 },
  ];
  assert.deepEqual(estimadoVigenteDeAv(soloReportados, '2026-09-30'), { valor: null, motivo: 'av_sin_estimado_del_trimestre' });
});

// ── ?job=vigente_diag de punta a punta: AV simulado, Postgres real ──
test('?job=vigente_diag: muestra lo que trae EARNINGS y el CALENDAR, y no escribe nada', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55440 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  psql(readFileSync('docs/sql/earnings-beat-v2.sql', 'utf8'));
  psql(readFileSync('docs/sql/earnings-beat-v2-1.sql', 'utf8'));
  psql(`insert into pm_earnings_markets_v2 (market_id, slug, question, symbol, filtro_motivo, resolved_date)
        values ('cl1', 'cl-quarterly-earnings-nongaap-eps-10-31-2026-0pt96', 'Will Colgate (CL) beat quarterly earnings?', 'CL', 'ok', current_date + 7);`);

  const llamadas = [];
  const neon = puenteNeon(psql);
  const fetchOriginal = globalThis.fetch;
  const env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  process.env.ALPHAVANTAGE_API_KEY = 'demo';
  delete process.env.CRON_SECRET;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.alphavantage.co/query')) {
      const fn = new URL(u).searchParams.get('function');
      llamadas.push(fn);
      if (fn === 'EARNINGS') {
        return { ok: true, status: 200, json: async () => ({ symbol: 'CL', quarterlyEarnings: [
          { fiscalDateEnding: '2026-06-30', reportedDate: '2026-07-31', reportedEPS: '0.95', estimatedEPS: '0.92', surprise: '0.03', surprisePercentage: '3.2' },
          { fiscalDateEnding: '2026-03-31', reportedDate: '2026-04-25', reportedEPS: '0.90', estimatedEPS: '0.88', surprise: '0.02', surprisePercentage: '2.3' },
        ] }) };
      }
      return { ok: true, status: 200, text: async () => 'symbol,name,reportDate,fiscalDateEnding,estimate,currency\nCL,Colgate-Palmolive Co,2026-10-31,2026-09-30,0.94,USD\nZZZ,Otra,2026-11-01,2026-09-30,1.00,USD\n' };
    }
    return neon(url, init);
  };
  try {
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    const antes = psql('select count(*) from pm_earnings_v2_features').trim();
    const r = resFalsa();
    await handler({ method: 'GET', query: { job: 'vigente_diag', symbols: 'cl', calendario: '1' }, headers: {} }, r);
    assert.equal(r.code, 200, JSON.stringify(r.cuerpo));
    const d = r.cuerpo;
    assert.deepEqual(llamadas, ['EARNINGS', 'EARNINGS_CALENDAR']);
    assert.equal(d.escribe, false);
    const cl = d.por_simbolo[0];
    assert.equal(cl.symbol, 'CL');
    assert.equal(cl.ultimos_3.length, 2);
    assert.deepEqual(cl.sin_reportar, []);                                    // EARNINGS no trae el trimestre que viene
    assert.equal(cl.mercados[0].quarter_end, '2026-09-30');
    assert.equal(cl.elegido[0].motivo, 'av_sin_estimado_del_trimestre');
    assert.deepEqual(d.calendario.pedidos, [{ symbol: 'CL', report_date: '2026-10-31', fiscal_date_ending: '2026-09-30', estimate: 0.94, currency: 'USD' }]);
    // cupo gastado: 2 llamadas; tablas de v2: intactas
    assert.equal(psql(`select calls from pead_api_budget where day = current_date`).trim(), '2');
    assert.equal(psql('select count(*) from pm_earnings_v2_features').trim(), antes);
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of ['DATABASE_URL', 'ALPHAVANTAGE_API_KEY']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  }
});
