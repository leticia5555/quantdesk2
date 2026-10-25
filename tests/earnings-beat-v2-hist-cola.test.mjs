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
import { readFileSync } from 'node:fs';
import { puenteNeon, resFalsa } from './_neon-psql.mjs';
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

// ── 25-oct: un `empty` de AV marca el símbolo y lo saca de la cola ──
test('?job=hist: tras un empty, CFLT queda sin_datos_av y no se vuelve a pedir (salvo &forzar=1)', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55442 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  for (const f of ['', '-1', '-2', '-3', '-4']) psql(readFileSync(`docs/sql/earnings-beat-v2${f}.sql`, 'utf8'));
  psql('create table if not exists pead_api_budget (day date primary key, calls int not null default 0);');

  let respuesta = {};   // lo que contesta AV: {} = empty
  const llamadas = [];
  const neon = puenteNeon(psql);
  const fetchOriginal = globalThis.fetch;
  const env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  process.env.ALPHAVANTAGE_API_KEY = 'demo';
  process.env.EARNINGS_V2_HIST_ENABLED = '1';
  delete process.env.CRON_SECRET;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.alphavantage.co/query')) {
      llamadas.push(new URL(u).searchParams.get('symbol'));
      return { ok: true, status: 200, json: async () => respuesta };
    }
    return neon(url, init);
  };
  const corre = async (query) => {
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    const r = resFalsa();
    await handler({ method: 'GET', query: { job: 'hist', ...query }, headers: {} }, r);
    assert.equal(r.code, 200, JSON.stringify(r.cuerpo));
    return r.cuerpo;
  };
  try {
    const d1 = await corre({ symbols: 'CFLT' });
    assert.deepEqual(llamadas, ['CFLT']);
    assert.equal(d1.resultado[0].estado, 'sin_datos_av');
    assert.equal(psql(`select fuente || '|' || fiscal_quarter_end || '|' || coalesce(reported_date::text, 'null') from pm_v2_hist where symbol = 'CFLT'`).trim(),
      'sin_datos_av|1900-01-01|null');

    // segundo día: no gasta llamada
    const d2 = await corre({ symbols: 'CFLT' });
    assert.deepEqual(llamadas, ['CFLT']);
    assert.equal(d2.llamadas, 0);
    assert.deepEqual(d2.frescos_sin_llamar, ['CFLT']);

    // &forzar=1: vuelve a pedir; si AV ahora trae datos, el marcador se va
    respuesta = { symbol: 'CFLT', quarterlyEarnings: [
      { fiscalDateEnding: '2026-06-30', reportedDate: '2026-07-30', reportedEPS: '0.10', estimatedEPS: '0.08', surprise: '0.02', surprisePercentage: '25' },
    ] };
    const d3 = await corre({ symbols: 'CFLT', forzar: '1' });
    assert.deepEqual(llamadas, ['CFLT', 'CFLT']);
    assert.equal(d3.resultado[0].estado, 'ok');
    assert.equal(psql(`select count(*) from pm_v2_hist where symbol = 'CFLT' and fuente = 'sin_datos_av'`).trim(), '0');
    assert.equal(psql(`select count(*) from pm_v2_hist where symbol = 'CFLT' and reported_date is not null`).trim(), '1');
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of ['DATABASE_URL', 'ALPHAVANTAGE_API_KEY', 'EARNINGS_V2_HIST_ENABLED']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  }
});

// ── 25-oct: goteo PEAD (pead_earnings viejo o nulo, mercado abierto más cercano primero) ──
import { maxPeadManual } from '../api/earnings-beat-v2.js';

test('?job=pead_al_dia: &max default 3, tope 6', () => {
  assert.equal(maxPeadManual(undefined), 3);
  assert.equal(maxPeadManual('6'), 6);
  assert.equal(maxPeadManual('25'), 6);
  assert.equal(maxPeadManual('0'), 3);
  assert.equal(maxPeadManual('x'), 3);
});

test('?job=pead_al_dia: pide solo PEAD viejo/nulo, en orden de mercado abierto, y escribe pead_earnings', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55443 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  for (const f of ['', '-1', '-2', '-3', '-4']) psql(readFileSync(`docs/sql/earnings-beat-v2${f}.sql`, 'utf8'));
  psql('create table if not exists pead_api_budget (day date primary key, calls int not null default 0);');
  const viejo = `now() - interval '30 days'`;
  psql(`insert into pead_earnings (symbol, fiscal_date_ending, reported_date, reported_eps, estimated_eps, ingested_at) values
    ('LLY',  current_date - 90,  current_date - 60,  null, 7.0, ${viejo}),   -- último sin reportar, mercado abierto en +4
    ('AAPL', current_date - 150, current_date - 120, 1.5,  1.4, ${viejo}),   -- viejo, mercado abierto en +2
    ('MSFT', current_date - 150, current_date - 120, 3.0,  2.9, ${viejo}),   -- viejo, sin mercado
    ('KO',   current_date - 150, current_date - 120, 0.7,  0.7, ${viejo}),   -- viejo, mercado ya pasado
    ('PG',   current_date - 60,  current_date - 30,  1.9,  1.8, ${viejo}),   -- al día: no se pide
    ('XOM',  current_date - 150, current_date - 120, 1.8,  1.7, now() - interval '2 days');  -- pedido hace 2 días: no se repite`);
  psql(`insert into pm_earnings_markets_v2 (market_id, symbol, filtro_motivo, resolved_date, outcome) values
    ('l1', 'LLY',  'ok', current_date + 4,  null),
    ('a1', 'AAPL', 'ok', current_date + 2,  null),
    ('k1', 'KO',   'ok', current_date - 3,  'yes');`);

  const llamadas = [];
  const neon = puenteNeon(psql);
  const fetchOriginal = globalThis.fetch;
  const env = { ...process.env };
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  process.env.ALPHAVANTAGE_API_KEY = 'demo';
  process.env.EARNINGS_V2_HIST_ENABLED = '1';
  delete process.env.CRON_SECRET;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.alphavantage.co/query')) {
      const sym = new URL(u).searchParams.get('symbol');
      llamadas.push(sym);
      return { ok: true, status: 200, json: async () => ({ symbol: sym, quarterlyEarnings: [
        { fiscalDateEnding: '2026-09-30', reportedDate: '2026-10-20', reportedEPS: '1.00', estimatedEPS: '0.90', surprise: '0.10', surprisePercentage: '11.1' },
      ] }) };
    }
    return neon(url, init);
  };
  try {
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    const r = resFalsa();
    await handler({ method: 'GET', query: { job: 'pead_al_dia' }, headers: {} }, r);
    assert.equal(r.code, 200, JSON.stringify(r.cuerpo));
    // default 3: abierto más cercano primero (AAPL +2, LLY +4), después el ya pasado (KO); MSFT queda en cola
    assert.deepEqual(llamadas, ['AAPL', 'LLY', 'KO']);
    assert.deepEqual([r.cuerpo.max, r.cuerpo.llamadas, r.cuerpo.viejos, r.cuerpo.quedan_en_cola], [3, 3, 4, 1]);
    assert.equal(psql(`select calls from pead_api_budget where day = current_date`).trim(), '3');
    assert.equal(psql(`select count(*) from pead_earnings where symbol in ('AAPL','LLY','KO') and reported_date = '2026-10-20'`).trim(), '3'); /* date-lint-ok: dato de la respuesta falsa de AV */
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of ['DATABASE_URL', 'ALPHAVANTAGE_API_KEY', 'EARNINGS_V2_HIST_ENABLED']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  }
});
