// ═══════════════════════════════════════════════════════════════
// Tests de earnings-beat v2 ("barra vs consenso vigente"). JS puro + un
// Postgres real para la migración, las semillas y las consultas del endpoint.
//   - CRITERIOS_V2 y el set de validación pineados (mover una portería rompe)
//   - prob_v2: Normal, regla de empate de medio centavo, std de respaldo, clamp
//   - sorpresa 8T sin look-ahead; brecha conocida; guía implícita
//   - los resueltos del 21–22 oct: qué reproduce v2 y qué NO
//   - el veredicto pre-registrado (INCONCLUSO por universo, hoy)
//   - nada de v2 en la UI
// Correr con `node tests/earnings-beat-v2.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  CRITERIOS_V2, VALIDACION_V2, CORTE_VALIDACION, UNIVERSO,
  leeMercado, sorpresaHistorica, trimestreDelReporte, brechaConocida, guiaImplicita, barraVsGuia,
  estimadoV2, normalCdf, probV2, filaV2, acierto, veredictoV2, renderMd, estimadoVigenteDeAv,
} from '../api/_lib/earnings-beat-v2.js';
import { SCHEMA_V2 } from '../api/_lib/earnings-beat-v2-db.js';
import { SCHEMA as SCHEMA_V1 } from '../api/_lib/earnings-beat-db.js';
import { CONSULTAS } from '../api/earnings-beat-v2.js';
import { historia, GAPS, GUIAS, RESUELTOS } from './fixtures/earnings-beat-v2-resueltos.mjs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

const cerca = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ── porterías ──────────────────────────────────────────────────
test('CRITERIOS_V2 congelados', () => {
  assert.equal(CRITERIOS_V2.ventana_trimestres, 8);
  assert.equal(CRITERIOS_V2.min_trimestres, 4);
  assert.equal(CRITERIOS_V2.std_fallback_frac, 0.05);
  assert.equal(CRITERIOS_V2.clamp_min, 0.03);
  assert.equal(CRITERIOS_V2.clamp_max, 0.97);
  assert.equal(CRITERIOS_V2.ajuste_empate, 0.005);
  assert.equal(CRITERIOS_V2.umbral_desacuerdo, 0.15);
  assert.equal(CRITERIOS_V2.acierto_min_zona, 0.70);
  assert.equal(CRITERIOS_V2.max_faltantes, 4);
  assert.ok(Object.isFrozen(CRITERIOS_V2));
});

test('el set de validación son los 22 del 21-oct 20:00 CT, y no se mueve', () => {
  assert.equal(CORTE_VALIDACION, '2026-10-21T20:00:00-05:00');
  assert.equal(VALIDACION_V2.length, 22);
  assert.deepEqual(VALIDACION_V2.map((v) => `${v.symbol} ${v.fecha.slice(5)}`).join(', '),
    'TSLA 10-20, WDFC 10-21, META 10-21, UNP 10-22, SSNC 10-22, PG 10-22, AAL 10-22, TFX 10-22, PCG 10-22, '
    + 'IMAX 10-22, AXP 10-23, SOFI 10-27, BA 10-27, PJT 10-27, CZR 10-27, PYPL 10-27, GOOGL 10-27, TDOC 10-28, '
    + 'AMZN 10-29, LLY 10-29, XOM 10-30, IMAX 11-05');
});

test('11 de los 22 están FUERA del universo de 99 (y eso ya decide el INCONCLUSO)', () => {
  assert.equal(UNIVERSO.size, 99);
  const fuera = VALIDACION_V2.filter((v) => !UNIVERSO.has(v.symbol)).map((v) => v.symbol);
  assert.deepEqual(fuera, ['WDFC', 'SSNC', 'AAL', 'TFX', 'PCG', 'IMAX', 'SOFI', 'PJT', 'CZR', 'TDOC', 'IMAX']);
  assert.ok(fuera.length > CRITERIOS_V2.max_faltantes);
});

// ── prob_v2 ────────────────────────────────────────────────────
test('Φ es la normal estándar', () => {
  assert.ok(cerca(normalCdf(0), 0.5, 1e-6));
  assert.ok(cerca(normalCdf(1.96), 0.975, 1e-3));
  assert.ok(cerca(normalCdf(-1), 0.1587, 1e-3));
});

test('regla de empate: consenso = barra con sorpresa 0 sale bajo 50% (SOFI ~45%)', () => {
  const r = probV2(0, 0.04, 5, true, { barra: 0.17 });
  assert.ok(cerca(r.prob_v2, 0.45, 0.01), r.prob_v2);
  assert.equal(r.std_fallback, false);
});

test('std null → 0.05 × |barra| con std_fallback; piso de un centavo; clamp', () => {
  const r = probV2(0.10, null, 3, true, { barra: 2.00 });
  assert.equal(r.std_fallback, true);
  assert.equal(r.std_usada, 0.1);
  const piso = probV2(0, null, 3, true, { barra: 0.17 });   // 0.0085 → 0.01
  assert.equal(piso.std_usada, 0.01);
  assert.equal(piso.std_piso, true);
  assert.equal(probV2(5, 0.05, 8, true).prob_v2, 0.97);
  assert.equal(probV2(-5, 0.05, 0, true).prob_v2, 0.03);
  assert.equal(probV2(null, 0.05, 0, true).prob_v2, null);
});

test('beats_8t y metrica_match NO mueven el número (el encargo no define cómo)', () => {
  assert.equal(probV2(0.02, 0.03, 0, false).prob_v2, probV2(0.02, 0.03, 8, true).prob_v2);
});

// ── columnas ───────────────────────────────────────────────────
test('sorpresa 8T: solo trimestres ANTERIORES a la fecha; < 4 → null', () => {
  const filas = [...historia([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]),
    { reported_date: '2026-10-22', estimated_eps: 1, reported_eps: 9 }];  // el propio reporte
  const h = sorpresaHistorica(filas, '2026-10-22', 'NONGAAP');
  assert.equal(h.n_8t, 8);
  assert.equal(h.sorpresa_mediana_8t, 0.1);
  assert.equal(h.beats_8t, 8);
  assert.equal(h.sorpresa_metrica_match, true);
  assert.equal(sorpresaHistorica(filas.slice(0, 3), '2026-10-22', 'GAAP').sorpresa_mediana_8t, null);
  assert.equal(sorpresaHistorica(filas, '2026-10-22', 'GAAP').sorpresa_metrica_match, false);
});

test('trimestre del reporte = fin del trimestre calendario anterior', () => {
  assert.equal(trimestreDelReporte('2026-10-22'), '2026-09-30');
  assert.equal(trimestreDelReporte('2026-11-05'), '2026-09-30');
  assert.equal(trimestreDelReporte('2026-02-03'), '2025-12-31');
  assert.equal(trimestreDelReporte('2026-07-24'), '2026-06-30');
});

test('brecha: GAAP resta todo, NONGAAP solo lo que pega en AMBAS; sin URL no cuenta', () => {
  const gaps = [
    { brecha_por_accion: 0.04, afecta: 'GAAP', fuente_url: 'u1' },
    { brecha_por_accion: 4.57, afecta: 'AMBAS', fuente_url: 'u2' },
    { brecha_por_accion: 9.99, afecta: 'GAAP', fuente_url: null },
  ];
  assert.equal(brechaConocida(gaps, 'GAAP').brecha_aplicada, 4.61);
  assert.equal(brechaConocida(gaps, 'NONGAAP').brecha_aplicada, 4.57);
  assert.equal(brechaConocida(gaps, 'GAAP').brechas_descartadas_sin_url, 1);
  assert.equal(brechaConocida([], 'GAAP').brecha_aplicada, 0);
});

test('guía implícita: trimestral tal cual; anual = (guía − YTD) / restantes', () => {
  const pcg = guiaImplicita(GUIAS.PCG);
  assert.equal(pcg.guia_q_min, 0.405);
  assert.equal(pcg.guia_q_max, 0.415);
  assert.equal(barraVsGuia(0.43, pcg), 'arriba');
  const axp = guiaImplicita({ alcance: 'anual', guia_min: 17.30, guia_max: 17.90, ytd_reportado: 8.80, trimestres_restantes: 2 });
  assert.equal(axp.guia_q_min, 4.25);
  assert.equal(axp.guia_q_max, 4.55);
  const aal = guiaImplicita(GUIAS.AAL);
  assert.equal(aal.guia_q_implicita, -0.4);
  assert.equal(barraVsGuia(-0.34, aal), 'dentro');
  assert.equal(guiaImplicita(null).guia_q_implicita, null);
});

test('estimado_v2: vigente le gana a creación; GAAP resta la brecha', () => {
  assert.equal(estimadoV2({ metrica_barra: 'GAAP', consenso_vigente: null, consenso_creacion: 6.31, sorpresa_mediana_8t: 0.75, brecha_aplicada: 3.3 }), 3.76);
  assert.equal(estimadoV2({ metrica_barra: 'NONGAAP', consenso_vigente: 1.90, consenso_creacion: 1.94, sorpresa_mediana_8t: 0.04, brecha_aplicada: 0 }), 1.94);
  assert.equal(estimadoV2({ metrica_barra: 'NONGAAP', consenso_vigente: null, consenso_creacion: null, sorpresa_mediana_8t: 0.04 }), null);
});

test('lee barra, métrica y consenso de creación de la descripción del mercado', () => {
  const l = leeMercado({
    slug: 'meta-quarterly-earnings-gaap-eps-10-21-2026-6pt31',
    pregunta: 'Will Meta (META) beat quarterly earnings?',
    descripcion: 'This market will resolve to "Yes" if Meta reports GAAP EPS greater than $6.31 for the quarter. '
      + 'The Street consensus estimate for GAAP EPS is $6.31 as of market creation.',
  });
  assert.equal(l.metrica_barra, 'GAAP');
  assert.equal(l.barra, 6.31);
  assert.equal(l.consenso_creacion, 6.31);
});

test('consenso vigente de AV: el trimestre sin reportar más cercano, o null con motivo', () => {
  const ev = [
    { fiscal_date_ending: '2026-09-30', reported_date: '2026-10-29', reported_eps: null, estimated_eps: 1.12 },
    { fiscal_date_ending: '2026-06-30', reported_date: '2026-07-24', reported_eps: 1.2, estimated_eps: 1.1 },
  ];
  assert.equal(estimadoVigenteDeAv(ev, '2026-09-30').valor, 1.12);
  assert.equal(estimadoVigenteDeAv(ev.slice(1), '2026-09-30').motivo, 'av_sin_estimado_del_trimestre');
});

// ── los resueltos del 21–22 oct ────────────────────────────────
const UNIVERSO_AMPLIADO = new Set([...UNIVERSO, 'AAL', 'PCG']);
const corre = (r, extra = {}, universo = UNIVERSO_AMPLIADO) => filaV2({
  mercado: { ...r.mercado, ...extra },
  historial: historia(r.sorpresas, r.base),
  gaps: GAPS[r.mercado.symbol] || [],
  guia: GUIAS[r.mercado.symbol] || null,
  universo,
});

test('con las series del fixture, v2 saca el lado correcto en los 5 de la tabla', () => {
  for (const r of RESUELTOS) {
    const f = corre(r);
    assert.notEqual(f.prob_v2, null, r.mercado.symbol);
    assert.equal(f.prob_v2 > 0.5 ? 'yes' : 'no', r.esperado, `${r.mercado.symbol}: prob_v2 ${f.prob_v2} — ${r.umbral}`);
    assert.equal(acierto(f.prob_v2, f.outcome), true);
  }
});

test('PERO con el universo real, AAL y PCG no tienen número: fuera_universo', () => {
  for (const sym of ['AAL', 'PCG']) {
    const f = corre(RESUELTOS.find((r) => r.mercado.symbol === sym), {}, UNIVERSO);
    assert.equal(f.fuera_universo, true);
    assert.equal(f.prob_v2, null);
    assert.equal(f.faltante, 'fuera_universo');
  }
});

test('PG: si el consenso es 1.90 (tabla del encargo) y no 1.94, v2 FALLA', () => {
  const pg = RESUELTOS.find((r) => r.mercado.symbol === 'PG');
  const f = corre(pg, { consenso_creacion: 1.90 });
  assert.equal(f.estimado_v2, 1.94);
  assert.equal(f.margen_v2, 0);
  assert.ok(f.prob_v2 < 0.5, f.prob_v2);
  assert.equal(f.consenso_vs_barra_ok, false);
});

test('umbrales: dónde se da vuelta cada uno (para mirarlo contra pead_earnings real)', () => {
  const conMediana = (sym, s) => {
    const r = RESUELTOS.find((x) => x.mercado.symbol === sym);
    return corre({ ...r, sorpresas: Array(8).fill(s) }).prob_v2;
  };
  // UNP: 3.50 + s − 0.04 > 3.505  ⇔  s ≥ 0.05
  assert.ok(conMediana('UNP', 0.04) < 0.5);
  assert.ok(conMediana('UNP', 0.05) > 0.5);
  // PCG: 0.43 + s > 0.435  ⇔  s ≥ 0.01 → con +0.01 v2 dice Yes y salió No
  assert.ok(conMediana('PCG', 0.00) < 0.5);
  assert.ok(conMediana('PCG', 0.01) > 0.5);
  // AAL: −0.34 + s > −0.335  ⇔  s ≥ 0.01
  assert.ok(conMediana('AAL', 0.00) < 0.5);
  assert.ok(conMediana('AAL', 0.01) > 0.5);
  // META: robusto hasta una mediana de +3.30
  assert.ok(conMediana('META', 2.0) < 0.5);
});

test('la guía es columna, no entra al estimado (PCG con guía 0.41 y sorpresa +0.01 da Yes)', () => {
  const pcg = RESUELTOS.find((r) => r.mercado.symbol === 'PCG');
  const f = corre({ ...pcg, sorpresas: Array(8).fill(0.01) });
  assert.equal(f.barra_vs_guia, 'arriba');
  assert.ok(f.prob_v2 > 0.5);
});

// ── veredicto ──────────────────────────────────────────────────
const fila = (o) => ({ prob_v2: 0.5, prob_pm_t24: 0.5, outcome: 'yes', faltante: null, ...o });

test('veredicto: > 4 faltantes → INCONCLUSO aunque el Brier sea mejor', () => {
  const filas = [
    ...Array(5).fill(0).map(() => fila({ prob_v2: null, faltante: 'fuera_universo' })),
    ...Array(17).fill(0).map(() => fila({ prob_v2: 0.9, prob_pm_t24: 0.5 })),
  ];
  assert.equal(veredictoV2(filas).veredicto, 'INCONCLUSO');
});

test('veredicto: GO, NO-GO, zona vacía y pendientes', () => {
  const go = Array(22).fill(0).map((_, i) => fila({ prob_v2: 0.9, prob_pm_t24: i < 5 ? 0.6 : 0.85 }));
  assert.equal(veredictoV2(go).veredicto, 'GO');
  const nogo = Array(22).fill(0).map(() => fila({ prob_v2: 0.6, prob_pm_t24: 0.9 }));
  assert.equal(veredictoV2(nogo).veredicto, 'NO-GO');
  const sinZona = Array(22).fill(0).map(() => fila({ prob_v2: 0.9, prob_pm_t24: 0.85 }));
  assert.equal(veredictoV2(sinZona).veredicto, 'INCONCLUSO');
  const zonaMala = Array(22).fill(0).map((_, i) => fila({ prob_v2: i < 4 ? 0.3 : 0.99, prob_pm_t24: i < 4 ? 0.6 : 0.8 }));
  assert.equal(veredictoV2(zonaMala).veredicto, 'NO-GO');
  const pend = Array(22).fill(0).map((_, i) => fila({ outcome: i < 7 ? 'yes' : null }));
  assert.equal(veredictoV2(pend).veredicto, 'PENDIENTE');
});

test('el set real HOY: INCONCLUSO por universo, antes de resolver nada más', () => {
  const filas = VALIDACION_V2.map(({ symbol, fecha }) => filaV2({ mercado: { symbol, fecha, metrica_barra: 'NONGAAP', barra: 1, consenso_creacion: 1 } }));
  const v = veredictoV2(filas);
  assert.equal(v.veredicto, 'INCONCLUSO');
  assert.equal(v.motivos_faltan.fuera_universo, 11);
});

test('el markdown trae una línea por resuelto con v2, PM y resultado', () => {
  const filas = RESUELTOS.map((r) => ({ ...corre(r), prob_pm_t24: 0.5 }));
  const md = renderMd({ titulo: 'x', filas, veredicto: veredictoV2(filas, { total: filas.length }) });
  assert.match(md, /\*\*META 2026-10-21\*\*: v2 dijo 3%, PM dijo 50%, salió No \(3\.83\) → v2 acierta\./);
  assert.match(md, /\| Símbolo \| Fecha \| Barra \| Métrica \| Consenso \|/);
});

// ── nada de v2 en la UI ────────────────────────────────────────
test('prob_v2 no aparece en ninguna página ni script del front', () => {
  const front = readdirSync('.').filter((f) => /\.(html|js)$/.test(f));
  for (const f of front) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/earnings-beat-v2|prob_v2|estimado_v2/.test(s), `${f} menciona v2`);
  }
});

// ── migración y semillas contra un Postgres real ───────────────
const SQL_SEMILLAS = readFileSync('docs/sql/earnings-beat-v2.sql', 'utf8');
const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

test('la DDL del .sql es la misma que SCHEMA_V2', () => {
  for (const q of SCHEMA_V2) assert.ok(norm(SQL_SEMILLAS).includes(norm(q)), q.slice(0, 60));
});

test('migración + semillas + consultas del endpoint, contra Postgres', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55437 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  psql(SQL_SEMILLAS);
  psql(SQL_SEMILLAS);   // idempotente
  assert.equal(psql('select count(*) from pm_v2_validation').trim(), '22');
  assert.equal(psql("select count(*) from pm_v2_validation where outcome is not null").trim(), '7');
  assert.equal(psql('select count(*) from pm_known_gaps').trim(), '5');
  assert.equal(psql('select count(*) from pm_company_guidance').trim(), '6');
  assert.equal(psql('select count(*) from pm_known_gaps where fuente_url is null').trim(), '0');
  for (const [nombre, f] of Object.entries(CONSULTAS)) {
    const q = f(2);
    const n = (q.match(/\$\d+/g) || []).length ? Math.max(...q.match(/\$\d+/g).map((x) => Number(x.slice(1)))) : 0;
    const tipos = n ? `(${Array(n).fill(nombre === 'resueltos' ? 'int' : 'text').join(', ')})` : '';
    psql(`prepare q_${nombre}${tipos} as ${q}; deallocate q_${nombre};`);
  }
});
