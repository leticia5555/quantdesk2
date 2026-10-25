// ═══════════════════════════════════════════════════════════════
// earnings-beat v2 — diagnóstico del consenso vigente (25-oct).
//
// Con EARNINGS_V2_VIGENTE_ENABLED=1, las 68 filas abiertas seguían con
// consenso_vigente null y el latido de ?job=diario no guardaba qué había
// contestado Alpha Vantage. Esto prueba las herramientas para VERLO:
//   - el parser del CSV de EARNINGS_CALENDAR (la fuente alternativa);
//   - ?job=vigente_diag de punta a punta, que no escribe nada.
// Sin cambios de fórmula. Correr con `node tests/earnings-beat-v2-vigente.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCalendarioCsv, estimadoVigenteDeAv, vigenteDeSnapshots, filaV21, trimestreDelReporte, vigenteSospechoso, UMBRAL_VIGENTE_VS_BARRA } from '../api/_lib/earnings-beat-v2.js';
import { historia } from './fixtures/earnings-beat-v2-resueltos.mjs';
import { descripcionPlantilla } from './fixtures/earnings-beat-v2-plantilla-oct26.mjs';
import { SCHEMA as SCHEMA_V1 } from '../api/_lib/earnings-beat-db.js';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import { puenteNeon, resFalsa } from './_neon-psql.mjs';

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

// ═══════════ 26-oct: consenso vigente desde los snapshots de EARNINGS_CALENDAR ═══════════

const SNAPS = [
  { fiscal_date_ending: '2026-09-30', estimate: 0.94, capturado_en: '2026-10-24T23:55:00Z' },
  { fiscal_date_ending: '2026-09-30', estimate: 0.92, capturado_en: '2026-10-25T23:55:00Z' },
  { fiscal_date_ending: '2026-09-30', estimate: 0.90, capturado_en: '2026-10-30T23:55:00Z' },   // después del T-24h
  { fiscal_date_ending: '2026-06-30', estimate: 0.80, capturado_en: '2026-10-25T23:59:00Z' },   // otro trimestre
  { fiscal_date_ending: '2026-09-30', estimate: null, capturado_en: '2026-10-26T01:00:00Z' },   // sin estimate
];

test('vigente = snapshot más reciente ANTES del T-24h, del trimestre del mercado; después no se mueve', () => {
  // mercado del 31-oct: T-24h = 30-oct 00:00 UTC
  const v = vigenteDeSnapshots(SNAPS, { fecha: '2026-10-31', quarter_end: '2026-09-30' });
  assert.deepEqual([v.valor, v.snap_ts, v.fiscal_date_ending], [0.92, '2026-10-25T23:55:00Z', '2026-09-30']);
  // mercado del 26-oct: T-24h = 25-oct 00:00 → solo cuenta el del 24
  assert.equal(vigenteDeSnapshots(SNAPS, { fecha: '2026-10-26', quarter_end: '2026-09-30' }).valor, 0.94);
  // mercado del 25-oct: ningún snapshot antes del T-24h (24-oct 00:00)
  assert.deepEqual(vigenteDeSnapshots(SNAPS, { fecha: '2026-10-25', quarter_end: '2026-09-30' }),
    { valor: null, motivo: 'sin_snapshot_antes_de_t24h', snap_ts: null });
  assert.equal(vigenteDeSnapshots([], { fecha: '2026-10-31', quarter_end: '2026-09-30' }).valor, null);
});

test('sin vigente, A y B quedan `sin_vigente`: el consenso de creación NO se usa como vigente', () => {
  const mercado = { market_id: 'x', symbol: 'CL', fecha: '2026-10-27', metrica_barra: 'NONGAAP', barra: 0.96, consenso_creacion: 0.96, consenso_vigente: null };
  const hist = historia([0.01, 0.02, 0.02, 0.03, 0.03, 0.03, 0.04, 0.05], 0.9);
  const f = filaV21({ mercado, historial: hist, fuenteHist: 'pead', exigeVigente: true });
  assert.deepEqual([f.prob_A, f.prob_B, f.faltante, f.consenso_usado], [null, null, 'sin_vigente', null]);
  // con vigente: la fórmula de siempre, con el vigente en lugar del de creación
  const con = filaV21({ mercado: { ...mercado, consenso_vigente: 0.92 }, historial: hist, fuenteHist: 'pead', exigeVigente: true });
  assert.equal(con.consenso_usado, 'vigente');
  assert.equal(con.estimado_A, 0.95);           // 0.92 + mediana 0.03
  assert.ok(con.prob_A < 0.5);                    // 0.95 < 0.96: ya no es "barra + sorpresa"
  // el piloto (exigeVigente = false) sigue como siempre: usa el de creación
  const piloto = filaV21({ mercado, historial: hist, fuenteHist: 'pead', exigeVigente: false });
  assert.equal(piloto.consenso_usado, 'creacion');
  assert.notEqual(piloto.prob_A, null);
});

test('?job=diario: una llamada a EARNINGS_CALENDAR por día, snapshot completo, vigente congelado al T-24h', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55441 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  for (const f of ['', '-1', '-2', '-3', '-4']) psql(readFileSync(`docs/sql/earnings-beat-v2${f}.sql`, 'utf8'));
  // ensurePeadSchema() se cachea por proceso y la prueba anterior la corrió
  // contra OTRO Postgres: la tabla del cupo se crea acá.
  psql('create table if not exists pead_api_budget (day date primary key, calls int not null default 0);');

  // Dos mercados abiertos de CL: uno resuelve en 6 días (su T-24h no pasó) y
  // otro mañana (su T-24h ya pasó: hoy 00:00 UTC, antes del snapshot de hoy).
  const fechaLejos = psql(`select to_char(current_date + 6, 'YYYY-MM-DD');`).trim();
  const fechaManana = psql(`select to_char(current_date + 1, 'YYYY-MM-DD');`).trim();
  const q = trimestreDelReporte(fechaLejos);
  const raw = (id, monto) => JSON.stringify({ id, description: descripcionPlantilla({ empresa: 'Colgate', fecha: 'October 31, 2026', monto }) }).replace(/'/g, "''");
  psql(`insert into pm_earnings_markets_v2 (market_id, slug, question, symbol, filtro_motivo, resolved_date, raw) values
    ('cl-lejos', 'cl-quarterly-earnings-nongaap-eps-10-31-2026-0pt96', 'Will Colgate (CL) beat quarterly earnings?', 'CL', 'ok', '${fechaLejos}', '${raw('cl-lejos', '$0.96')}'::jsonb),
    ('cl-manana', 'cl-quarterly-earnings-nongaap-eps-10-31-2026-0pt96', 'Will Colgate (CL) beat quarterly earnings?', 'CL', 'ok', '${fechaManana}', '${raw('cl-manana', '$0.96')}'::jsonb);`);

  const llamadas = [];
  const neon = puenteNeon(psql);
  const fetchOriginal = globalThis.fetch;
  const env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  process.env.ALPHAVANTAGE_API_KEY = 'demo';
  process.env.EARNINGS_V2_VIGENTE_ENABLED = '1';
  delete process.env.CRON_SECRET;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.alphavantage.co/query')) {
      llamadas.push(new URL(u).searchParams.get('function'));
      return { ok: true, status: 200, text: async () => `symbol,name,reportDate,fiscalDateEnding,estimate,currency\nCL,Colgate-Palmolive Co,${fechaLejos},${q},0.92,USD\nVZ,Verizon,${fechaLejos},${q},1.28,USD\nQQQ,Sin estimado,${fechaLejos},${q},,USD\n` };
    }
    return neon(url, init);
  };
  try {
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    const r1 = resFalsa();
    await handler({ method: 'GET', query: { job: 'diario' }, headers: {} }, r1);
    assert.equal(r1.code, 200, JSON.stringify(r1.cuerpo));
    assert.deepEqual(llamadas, ['EARNINGS_CALENDAR']);
    assert.equal(r1.cuerpo.captura.insertadas, 3);
    assert.equal(r1.cuerpo.captura.con_estimate, 2);
    assert.equal(psql('select count(*) from pm_v2_consenso_snap').trim(), '3');

    // segundo run el mismo día: no llama, no duplica
    const r2 = resFalsa();
    await handler({ method: 'GET', query: { job: 'diario' }, headers: {} }, r2);
    assert.deepEqual(llamadas, ['EARNINGS_CALENDAR']);
    assert.equal(r2.cuerpo.captura.ya_habia_hoy, 3);
    assert.equal(psql('select count(*) from pm_v2_consenso_snap').trim(), '3');
    assert.equal(psql(`select calls from pead_api_budget where day = current_date`).trim(), '1');

    // el mercado lejano toma el vigente; el de mañana no (su T-24h ya pasó)
    assert.equal(psql(`select consenso_vigente || '|' || (consenso_vigente_snap is not null) from pm_earnings_v2_features where market_id = 'cl-lejos'`).trim(), '0.92|true');
    assert.equal(psql(`select coalesce(consenso_vigente::text, 'null') || '|' || faltante from pm_earnings_v2_features where market_id = 'cl-manana'`).trim(), 'null|sin_vigente');

    // y la vista de abiertos dice lo mismo
    const r3 = resFalsa();
    await handler({ method: 'GET', query: {}, headers: {} }, r3);
    const filas = new Map(r3.cuerpo.filas.map((f) => [f.market_id, f]));
    assert.equal(filas.get('cl-lejos').consenso_usado, 'vigente');
    assert.equal(filas.get('cl-lejos').consenso_vigente, 0.92);
    assert.equal(filas.get('cl-manana').faltante, 'sin_vigente');
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of ['DATABASE_URL', 'ALPHAVANTAGE_API_KEY', 'EARNINGS_V2_VIGENTE_ENABLED']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  }
});

// ═══════════ 25-oct: candado del vigente (pre-registrado el 24-oct) ═══════════

test('candado: umbral 0.20 congelado; los casos del 25-oct', () => {
  assert.equal(UMBRAL_VIGENTE_VS_BARRA, 0.20);
  const caso = (v, b) => vigenteSospechoso(v, b);
  // GAAP del calendario contra barra non-GAAP: fuera
  assert.equal(caso(1.11, 1.44).sospechoso, true);    // EBAY
  assert.equal(caso(0.02, 0.35).sospechoso, true);    // NET
  assert.equal(caso(0.44, 0.74).sospechoso, true);    // DBX
  assert.equal(caso(0.07, 0.18).sospechoso, true);    // COUR
  assert.equal(caso(21.50, 8.34).sospechoso, true);   // MSTR
  assert.deepEqual(caso(5.38, 7.01), { sospechoso: true, motivo: 'lejos_de_la_barra', distancia: 0.2325 });   // LLY: el que no sabemos leer
  // los que sí: adentro
  assert.equal(caso(0.92, 0.96).sospechoso, false);   // CL
  assert.equal(caso(1.20, 1.00).sospechoso, false);   // justo 20%: no es "más de"
  // signo
  assert.deepEqual(caso(-0.05, 0.10), { sospechoso: true, motivo: 'cambia_signo', distancia: null });
  assert.equal(caso(-0.30, -0.34).sospechoso, false);
  // sin dato: no hay nada que marcar
  assert.equal(caso(null, 1).sospechoso, false);
});

test('candado de punta a punta: EBAY queda sin_vigente con AV aparte; vigente_fuente lo lee como otra métrica', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55443 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  for (const f of ['', '-1', '-2', '-3', '-4']) psql(readFileSync(`docs/sql/earnings-beat-v2${f}.sql`, 'utf8'));

  const fecha = psql(`select to_char(current_date + 6, 'YYYY-MM-DD');`).trim();
  const q = trimestreDelReporte(fecha);
  const raw = (id, empresa, monto) => JSON.stringify({ id, description: descripcionPlantilla({ empresa, fecha: 'October 28, 2026', monto }) }).replace(/'/g, "''");
  psql(`insert into pm_earnings_markets_v2 (market_id, slug, question, symbol, filtro_motivo, resolved_date, raw) values
    ('ebay1', 'ebay-quarterly-earnings-nongaap-eps-10-28-2026-1pt44', 'Will eBay (EBAY) beat quarterly earnings?', 'EBAY', 'ok', '${fecha}', '${raw('ebay1', 'eBay', '$1.44')}'::jsonb),
    ('cl1', 'cl-quarterly-earnings-nongaap-eps-10-31-2026-0pt96', 'Will Colgate (CL) beat quarterly earnings?', 'CL', 'ok', '${fecha}', '${raw('cl1', 'Colgate', '$0.96')}'::jsonb);`);
  // snapshot de ayer (antes del T-24h de los dos)
  psql(`insert into pm_v2_consenso_snap (symbol, fiscal_date_ending, report_date, estimate, capturado_en, dia) values
    ('EBAY', '${q}', '${fecha}', 1.11, now() - interval '1 day', current_date - 1),
    ('CL',   '${q}', '${fecha}', 0.92, now() - interval '1 day', current_date - 1);`);
  // histórico AV de EBAY (ajustado): estimados ~1.3–1.4
  psql(`insert into pm_v2_hist (symbol, fiscal_quarter_end, reported_date, reported_eps, estimated_eps) values
    ('EBAY', '2026-06-30', '2026-07-30', 1.40, 1.37), ('EBAY', '2026-03-31', '2026-04-29', 1.38, 1.34);`);

  const neon = puenteNeon(psql);
  const fetchOriginal = globalThis.fetch;
  const env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  delete process.env.CRON_SECRET;
  globalThis.fetch = async (url, init) => {
    assert.ok(!String(url).includes('alphavantage'), 'el diagnóstico no llama a AV');
    return neon(url, init);
  };
  try {
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    const r = resFalsa();
    await handler({ method: 'GET', query: {}, headers: {} }, r);
    const filas = new Map(r.cuerpo.filas.map((f) => [f.market_id, f]));
    const ebay = filas.get('ebay1');
    assert.deepEqual([ebay.consenso_vigente, ebay.vigente_av, ebay.vigente_sospechoso, ebay.faltante, ebay.prob_A],
      [null, 1.11, true, 'sin_vigente', null]);
    assert.equal(ebay.consenso_usado, null);            // tampoco cae al de creación
    const cl = filas.get('cl1');
    assert.deepEqual([cl.consenso_vigente, cl.vigente_sospechoso, cl.consenso_usado], [0.92, false, 'vigente']);

    const md = resFalsa();
    await handler({ method: 'GET', query: { format: 'md' }, headers: {} }, md);
    assert.match(md.cuerpo, /\| EBAY \|[^\n]*\| — \(AV 1\.11 ⚠\) \|/);

    const d = resFalsa();
    await handler({ method: 'GET', query: { job: 'vigente_fuente', symbols: 'EBAY,CL' }, headers: {} }, d);
    assert.equal(d.cuerpo.escribe, false);
    assert.equal(d.cuerpo.llamadas_av, 0);
    const e = d.cuerpo.por_simbolo.find((x) => x.symbol === 'EBAY');
    assert.equal(e.fuente_hist, 'pm_v2_hist');
    assert.equal(e.mercados[0].lectura, 'calendario_en_otra_metrica_probable');
    assert.equal(e.mercados[0].calendario_vs_barra, 0.229);
    assert.equal(d.cuerpo.por_simbolo.find((x) => x.symbol === 'CL').mercados[0].lectura, 'calendario_consistente');
  } finally {
    globalThis.fetch = fetchOriginal;
    if (env.DATABASE_URL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = env.DATABASE_URL;
  }
});

// ═══════════ 25-oct: candado del historial (métrica mixta en pm_v2_hist) ═══════════
import { histMetricaMixta, UMBRAL_SALTO_HIST } from '../api/_lib/earnings-beat-v2.js';

const FECHAS_8 = ['2024-08-01', '2024-11-01', '2025-02-10', '2025-05-08', '2025-08-07', '2025-11-06', '2026-02-12', '2026-05-07', '2026-08-06'];
const serie = (estimados, reportados = estimados) => estimados.map((e, i) => ({ reported_date: FECHAS_8[i], estimated_eps: e, reported_eps: reportados[i] }));

test('candado historial: umbral 0.50 congelado; NET (non-GAAP → GAAP) cae, EBAY (estable) no', () => {
  assert.equal(UMBRAL_SALTO_HIST, 0.50);
  // NET: non-GAAP hasta may-26 (0.25), GAAP en ago-26 (−0.05)
  const net = serie([0.16, 0.18, 0.19, 0.20, 0.21, 0.22, 0.24, 0.25, -0.05], [0.17, 0.20, 0.20, 0.21, 0.22, 0.24, 0.25, 0.23, -0.03]);
  const r = histMetricaMixta(net, '2026-10-30');
  assert.deepEqual([r.mixta, r.motivo, r.trimestre, r.estimado], [true, 'cambia_signo', '2026-08-06', -0.05]);
  // EBAY: el histórico de AV está en otra base que la barra (1.25 vs ~1.40), pero es ESTABLE: no cae acá
  const ebay = serie([1.08, 1.12, 1.15, 1.18, 1.20, 1.22, 1.24, 1.25, 1.27]);
  assert.equal(histMetricaMixta(ebay, '2026-10-28').mixta, false);
  // lo que pasa después del mercado no cuenta (cero look-ahead)
  assert.equal(histMetricaMixta(net, '2026-07-01').mixta, false);
  // con menos de 5 trimestres no hay contra qué comparar
  assert.equal(histMetricaMixta(net.slice(-4), '2026-10-30').mixta, false);
});

test('candado historial: también cae un salto > 50% sin cambio de signo (y un EPS chico que crece rápido)', () => {
  const salto = serie([0.50, 0.52, 0.51, 0.53, 0.52, 0.54, 0.53, 0.55, 1.10]);
  assert.equal(histMetricaMixta(salto, '2026-10-30').motivo, 'salto');
  // ojo, documentado: un EPS chico que crece rápido también cruza 50% (0.08 vs mediana 0.045)
  const chico = serie([0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.10, 0.12]);
  assert.equal(histMetricaMixta(chico, '2026-10-30').mixta, true);
});

test('candado historial en la fila: solo pm_v2_hist; sale sin_historial con el detalle, A y B sin número', () => {
  const net = serie([0.16, 0.18, 0.19, 0.20, 0.21, 0.22, 0.24, 0.25, -0.05], [0.17, 0.20, 0.20, 0.21, 0.22, 0.24, 0.25, 0.23, -0.03]);
  const mercado = { market_id: 'net1', symbol: 'NET', fecha: '2026-10-30', metrica_barra: 'NONGAAP', barra: 0.35, consenso_creacion: 0.35, consenso_vigente: 0.36 };
  const f = filaV21({ mercado, historial: net, fuenteHist: 'pm_v2_hist', exigeVigente: true });
  assert.deepEqual([f.prob_A, f.prob_B, f.faltante, f.hist_metrica_mixta, f.hist_metrica_mixta_detalle.motivo], [null, null, 'sin_historial', true, 'cambia_signo']);
  // la misma serie desde pead_earnings: el candado NO aplica (pre-registrado solo para pm_v2_hist)
  const pead = filaV21({ mercado, historial: net, fuenteHist: 'pead', exigeVigente: true });
  assert.equal(pead.hist_metrica_mixta, false);
  assert.notEqual(pead.prob_A, null);
});
