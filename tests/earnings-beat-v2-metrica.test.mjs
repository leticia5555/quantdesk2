// ═══════════════════════════════════════════════════════════════
// earnings-beat v2 — la métrica de la barra y el cruce del piloto.
//
// Piloto oct-26: 9 de 22 en `sin_metrica`. Las 9 descripciones son la MISMA
// plantilla de Polymarket (tests/fixtures/earnings-beat-v2-plantilla-oct26.mjs,
// verbatim) y traen dos menciones a GAAP que el lector v1 no aparta. Estas
// pruebas fijan:
//   - cada una de las dos redacciones, por separado;
//   - los 10 mercados con esa plantilla → NONGAAP vía la oración principal;
//   - el lector v1 sigue igual (no se toca), y sigue sin poder;
//   - lo que NO se adivina: `metrica_ambigua`;
//   - el cruce del piloto: fecha del slug y corte del 21-oct (IMAX 10-22,
//     LLY, XOM), contra un Postgres real y el endpoint de punta a punta.
// Correr con `node tests/earnings-beat-v2-metrica.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extraeMetricaMercado } from '../api/_lib/earnings-beat.js';
import {
  leeMetrica, metricaBarra, oracionPrincipal, fechaDelSlug, eligeMercadoPiloto, leeMercado, filaV2, CORTE_VALIDACION,
} from '../api/_lib/earnings-beat-v2.js';
import { SCHEMA as SCHEMA_V1 } from '../api/_lib/earnings-beat-db.js';
import { DESCRIPCION_BA, MERCADOS_PLANTILLA } from './fixtures/earnings-beat-v2-plantilla-oct26.mjs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import { puenteNeon, resFalsa } from './_neon-psql.mjs';

// Las dos redacciones exactas que hacían chocar la descripción.
const REDACCION_COLA_RESPALDO = 'or, if not published there, according to the GAAP EPS provided by SeekingAlpha.';
const REDACCION_NOTA_IFRS = 'Note: For the purposes of this market, IFRS EPS will be treated as GAAP EPS.';

const PRINCIPAL = 'This market will resolve to "Yes" if Acme reports non-GAAP EPS greater than $1.00 for the relevant quarter in its next quarterly earnings release.';
const mercado = (descripcion, extra = {}) => ({
  slug: 'acme-quarterly-earnings-nongaap-eps-10-27-2026-1pt00', pregunta: 'Will Acme (ACME) beat quarterly earnings?', descripcion, ...extra,
});

test('las dos redacciones exactas están, tal cual, en la plantilla real', () => {
  assert.ok(DESCRIPCION_BA.includes('; ' + REDACCION_COLA_RESPALDO));
  assert.ok(DESCRIPCION_BA.includes(REDACCION_NOTA_IFRS));
});

test('redacción 1 — la cola «; or, if not published there, … GAAP EPS …»: v1 choca, v2 lee NONGAAP', () => {
  const desc = `${PRINCIPAL} If no such figure is published, the market will resolve according to the GAAP EPS listed in the release; ${REDACCION_COLA_RESPALDO}`;
  assert.equal(extraeMetricaMercado(mercado(desc)).metrica, 'indeterminada');
  const r = leeMetrica(mercado(desc));
  assert.deepEqual([r.metrica, r.via], ['NONGAAP', 'oracion_principal']);
});

test('redacción 2 — «Note: … IFRS EPS will be treated as GAAP EPS.»: v1 choca, v2 lee NONGAAP', () => {
  const desc = `${PRINCIPAL} ${REDACCION_NOTA_IFRS}`;
  assert.equal(extraeMetricaMercado(mercado(desc)).metrica, 'indeterminada');
  assert.equal(metricaBarra(mercado(desc)), 'NONGAAP');
});

test('los 10 mercados con la plantilla real → NONGAAP por la oración principal (v1 sigue sin poder)', () => {
  assert.equal(MERCADOS_PLANTILLA.length, 10);
  for (const m of MERCADOS_PLANTILLA) {
    const v1 = extraeMetricaMercado(m);
    assert.equal(v1.metrica, 'indeterminada', m.symbol);
    assert.equal(v1.motivo, 'conflicto', m.symbol);
    const l = leeMercado(m);
    assert.equal(l.metrica_barra, 'NONGAAP', m.symbol);
    assert.equal(l.metrica_via, 'oracion_principal', m.symbol);
    assert.equal(l.barra, m.barra, m.symbol);
    assert.equal(l.consenso_creacion, m.barra, m.symbol);   // "Street consensus … is $X" = barra
  }
});

test('la oración principal es la que define el mercado, no las de respaldo', () => {
  assert.equal(oracionPrincipal(DESCRIPCION_BA),
    'This market will resolve to "Yes" if Boeing reports non-GAAP EPS greater than $-0.20 for the relevant quarter in its next quarterly earnings release.');
  assert.equal(oracionPrincipal('Otherwise, it will resolve to "No."'), null);
});

test('lo que v1 ya leía bien no cambia (GAAP y NONGAAP limpios)', () => {
  const gaap = mercado('This market will resolve to "Yes" if Meta reports GAAP EPS greater than $6.31.', { slug: 'meta-quarterly-earnings-gaap-eps-10-21-2026-6pt31' });
  assert.deepEqual([leeMetrica(gaap).metrica, leeMetrica(gaap).via], ['GAAP', 'v1']);
  const non = mercado(PRINCIPAL);
  assert.deepEqual([leeMetrica(non).metrica, leeMetrica(non).via], ['NONGAAP', 'v1']);
});

test('NO se adivina: metrica_ambigua', () => {
  // principal non-GAAP pero slug GAAP: el testigo contradice
  const contra = mercado(`${PRINCIPAL} ${REDACCION_NOTA_IFRS}`, { slug: 'acme-quarterly-earnings-gaap-eps-10-27-2026-1pt00' });
  assert.equal(leeMetrica(contra).motivo, 'metrica_ambigua');
  // conflicto sin oración principal
  const sinPrincipal = mercado(`Acme non-GAAP EPS is the strike. ${REDACCION_NOTA_IFRS}`, { slug: 'acme-q3' });
  assert.equal(leeMetrica(sinPrincipal).motivo, 'metrica_ambigua');
  // la oración principal nombra las dos
  const ambas = mercado('This market will resolve to "Yes" if Acme reports non-GAAP EPS or GAAP EPS greater than $1.00.', { slug: 'acme-q3' });
  assert.equal(leeMetrica(ambas).motivo, 'metrica_ambigua');
  // y nada que leer: sigue siendo sin_metrica
  assert.equal(leeMetrica(mercado('Will Acme beat?', { slug: 'acme-q3' })).motivo, 'sin_metrica');
});

test('la fila dice por qué falta: metrica_ambigua ≠ sin_metrica', () => {
  const base = { symbol: 'AAPL', fecha: '2026-10-27', barra: 1, consenso_creacion: 1 };
  assert.equal(filaV2({ mercado: { ...base, metrica_motivo: 'metrica_ambigua' } }).faltante, 'metrica_ambigua');
  assert.equal(filaV2({ mercado: { ...base, metrica_motivo: 'sin_metrica' } }).faltante, 'sin_metrica');
});

test('fecha del slug', () => {
  assert.equal(fechaDelSlug('imax-quarterly-earnings-nongaap-eps-10-22-2026-0pt88'), '2026-10-22');
  assert.equal(fechaDelSlug('ba-quarterly-earnings-nongaap-eps-10-27-2026-neg0pt20'), '2026-10-27');
  assert.equal(fechaDelSlug('aal-quarterly-earnings-nongaap-eps-10-22-2026-neg-0pt34'), '2026-10-22');
  assert.equal(fechaDelSlug('meta-q3'), null);
});

// Los candidatos tal como los pegó Lety (fecha = coalesce(report_date, resolved_date)).
const CAND = [
  { market_id: '5778294', symbol: 'IMAX', slug: 'imax-quarterly-earnings-nongaap-eps-10-22-2026-0pt88', fecha: '2026-11-05', creado_ts: '2026-10-16T15:00:00Z' },
  { market_id: '5999287', symbol: 'IMAX', slug: 'imax-quarterly-earnings-nongaap-eps-11-05-2026-0pt89', fecha: '2026-11-05', creado_ts: '2026-10-21T18:00:00Z' },
  { market_id: '6070769', symbol: 'LLY', slug: 'lly-quarterly-earnings-nongaap-eps-10-29-2026-7pt01', fecha: '2026-10-29', creado_ts: '2026-10-23T12:00:00Z' },
  { market_id: '5778687', symbol: 'LLY', slug: 'lly-quarterly-earnings-nongaap-eps-10-29-2026-7pt49', fecha: '2026-10-29', creado_ts: '2026-10-16T15:00:00Z' },
  { market_id: '5778597', symbol: 'XOM', slug: 'xom-quarterly-earnings-nongaap-eps-10-23-2026-3pt87', fecha: '2026-10-30', creado_ts: '2026-10-16T15:00:00Z' },
  { market_id: '5999289', symbol: 'XOM', slug: 'xom-quarterly-earnings-nongaap-eps-10-30-2026-4pt11', fecha: '2026-10-30', creado_ts: '2026-10-21T18:00:00Z' },
];

test('cruce del piloto: IMAX 10-22 se encuentra por la fecha del slug aunque la tabla diga 11-05', () => {
  const r = eligeMercadoPiloto(CAND, { symbol: 'IMAX', fecha: '2026-10-22', barraSemilla: 0.88 });
  assert.equal(r.mercado.market_id, '5778294');
  assert.equal(r.via, 'fecha_slug');
  assert.equal(eligeMercadoPiloto(CAND, { symbol: 'IMAX', fecha: '2026-11-05', barraSemilla: 0.89 }).mercado.market_id, '5999287');
});

test('cruce del piloto: un mercado creado DESPUÉS del corte no entra (LLY 7.01 del 23-oct)', () => {
  assert.equal(CORTE_VALIDACION, '2026-10-21T20:00:00-05:00');
  const r = eligeMercadoPiloto(CAND, { symbol: 'LLY', fecha: '2026-10-29' });
  assert.equal(r.mercado.market_id, '5778687');
  assert.equal(r.descartados_por_corte, 1);
});

test('cruce del piloto: XOM depende de cuándo nació el de 4.11', () => {
  // Si existía al corte, gana por fecha del slug (10-30).
  assert.equal(eligeMercadoPiloto(CAND, { symbol: 'XOM', fecha: '2026-10-30' }).mercado.market_id, '5999289');
  // Si nació después, queda el único que había: el de slug 10-23 (3.87), por fecha de tabla.
  const tarde = CAND.map((c) => (c.market_id === '5999289' ? { ...c, creado_ts: '2026-10-22T03:00:00Z' } : c));
  const r = eligeMercadoPiloto(tarde, { symbol: 'XOM', fecha: '2026-10-30' });
  assert.deepEqual([r.mercado.market_id, r.via], ['5778597', 'fecha_tabla']);
});

test('cruce del piloto: sin candidatos → null, sin inventar', () => {
  assert.equal(eligeMercadoPiloto(CAND, { symbol: 'TFX', fecha: '2026-10-22' }).mercado, null);
});

// ── de punta a punta: la plantilla real en pm_earnings_markets_v2 ──
test('?validacion=1 contra Postgres: los 10 de la plantilla salen NONGAAP y IMAX 10-22 encuentra su mercado', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55438 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  psql(readFileSync('docs/sql/earnings-beat-v2.sql', 'utf8'));
  psql(readFileSync('docs/sql/earnings-beat-v2-1.sql', 'utf8'));

  const lit = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const fila = (m, creado, fecha) => `(${lit(m.market_id)}, ${lit(m.slug)}, ${lit(m.pregunta)}, ${lit(m.symbol)}, 'ok', ${lit(creado)}, ${lit(fecha)}, ${lit(JSON.stringify({ id: m.market_id, slug: m.slug, question: m.pregunta, description: m.descripcion }))}::jsonb)`;
  const fechaTabla = { 5778294: '2026-11-05', 5412319: '2026-10-21' };
  const creados = { 5999287: '2026-10-21T18:00:00Z', 5999289: '2026-10-21T18:00:00Z' };
  const filas = MERCADOS_PLANTILLA.map((m) => fila(m, creados[m.market_id] || '2026-10-16T15:00:00Z', fechaTabla[m.market_id] || fechaDelSlug(m.slug)));
  // el LLY de 7.01, creado DESPUÉS del corte: no tiene que ganar
  const lly701 = { ...MERCADOS_PLANTILLA.find((m) => m.symbol === 'LLY'), market_id: '6070769', slug: 'lly-quarterly-earnings-nongaap-eps-10-29-2026-7pt01' };
  filas.push(fila(lly701, '2026-10-23T12:00:00Z', '2026-10-29'));
  psql(`insert into pm_earnings_markets_v2 (market_id, slug, question, symbol, filtro_motivo, creado, resolved_date, raw) values ${filas.join(', ')};`);

  const fetchOriginal = globalThis.fetch;
  const dbOriginal = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  delete process.env.CRON_SECRET;
  globalThis.fetch = puenteNeon(psql);
  try {
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    const r = resFalsa();
    await handler({ method: 'GET', query: { validacion: '1' }, headers: {} }, r);
    assert.equal(r.code, 200, JSON.stringify(r.cuerpo));
    const porClave = new Map(r.cuerpo.filas.map((f) => [`${f.symbol} ${f.fecha}`, f]));
    for (const k of ['TSLA 2026-10-20', 'SSNC 2026-10-22', 'TFX 2026-10-22', 'IMAX 2026-10-22', 'IMAX 2026-11-05',
      'BA 2026-10-27', 'PJT 2026-10-27', 'PYPL 2026-10-27', 'LLY 2026-10-29', 'XOM 2026-10-30']) {
      const f = porClave.get(k);
      assert.equal(f.metrica_barra, 'NONGAAP', k);
      assert.equal(f.metrica_via, 'oracion_principal', k);
      assert.notEqual(f.faltante, 'sin_metrica', k);
    }
    assert.equal(porClave.get('IMAX 2026-10-22').market_id, '5778294');
    assert.equal(porClave.get('IMAX 2026-10-22').consenso_creacion, 0.88);
    assert.equal(porClave.get('LLY 2026-10-29').market_id, '5778687');
    assert.equal(porClave.get('LLY 2026-10-29').barra, 7.49);
    assert.equal(porClave.get('XOM 2026-10-30').market_id, '5999289');
    // Las otras 12 filas del piloto no tienen mercado en ESTA base de prueba
    // (viven en tests/earnings-beat-v2.test.mjs); de las 10 de la plantilla,
    // ninguna queda sin métrica.
    const plantilla = new Set(MERCADOS_PLANTILLA.map((m) => m.symbol));
    assert.equal(r.cuerpo.filas.filter((f) => plantilla.has(f.symbol) && /metrica/.test(f.faltante || '')).length, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (dbOriginal === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = dbOriginal;
  }
});
