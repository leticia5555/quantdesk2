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
  SET_PILOTO, CRITERIOS_V21, enSetV21, estimadoB, filaV21, veredictoV21, renderMdV21,
} from '../api/_lib/earnings-beat-v2.js';
import { SCHEMA_V2, upsertHist, upsertMercadosV2 } from '../api/_lib/earnings-beat-v2-db.js';
import { SCHEMA as SCHEMA_V1 } from '../api/_lib/earnings-beat-db.js';
import { CONSULTAS, simbolosParaBuscar } from '../api/earnings-beat-v2.js';
import { historia, GAPS, GUIAS, RESUELTOS } from './fixtures/earnings-beat-v2-resueltos.mjs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';
import { puenteNeon, resFalsa } from './_neon-psql.mjs';

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

// ═══════════════════ v2.1 ═══════════════════

test('CRITERIOS_V21 pre-registrados', () => {
  assert.equal(SET_PILOTO, 'piloto-oct26');
  assert.equal(CRITERIOS_V21.creado_desde, '2026-10-23');
  assert.equal(CRITERIOS_V21.creado_hasta, '2026-11-30');
  assert.equal(CRITERIOS_V21.resuelve_antes, '2026-12-31');
  assert.equal(CRITERIOS_V21.min_mercados, 40);
  assert.equal(CRITERIOS_V21.umbral_desacuerdo, 0.15);
  assert.equal(CRITERIOS_V21.acierto_min_zona, 0.65);
  assert.ok(Object.isFrozen(CRITERIOS_V21));
});

test('el set v2.1 lo define la fecha de creación y la de resolución, no una lista', () => {
  assert.equal(enSetV21({ creado: '2026-10-23', fecha: '2026-11-04' }), true);
  assert.equal(enSetV21({ creado: '2026-11-30T23:00:00Z', fecha: '2026-12-30' }), true);
  assert.equal(enSetV21({ creado: '2026-10-22', fecha: '2026-11-04' }), false);  // antes del corte
  assert.equal(enSetV21({ creado: '2026-12-01', fecha: '2026-12-10' }), false);  // creado tarde
  assert.equal(enSetV21({ creado: '2026-11-10', fecha: '2026-12-31' }), false);  // resuelve tarde
  assert.equal(enSetV21({ creado: null, fecha: '2026-11-04' }), false);
});

test('fórmula de B FIJADA: promedio(estimado A, medio de la guía), solo con guía de la misma métrica', () => {
  assert.deepEqual(estimadoB(0.44, 0.41, 'NONGAAP', 'NONGAAP'), { estimado_B: 0.425, usa_guia: true });
  assert.deepEqual(estimadoB(-0.285, -0.40, 'NONGAAP', 'NONGAAP'), { estimado_B: -0.3425, usa_guia: true });
  assert.deepEqual(estimadoB(1.98, null, null, 'NONGAAP'), { estimado_B: 1.98, usa_guia: false });     // sin guía: B = A
  assert.deepEqual(estimadoB(-0.25, -0.25, 'GAAP', 'NONGAAP'), { estimado_B: -0.25, usa_guia: false }); // otra métrica: B = A
  assert.deepEqual(estimadoB(null, 0.41, 'NONGAAP', 'NONGAAP'), { estimado_B: null, usa_guia: false });
});

const fx = (sym) => RESUELTOS.find((r) => r.mercado.symbol === sym);
const fila21 = (sym, { sorpresas, fuenteHist = 'pm_v2_hist' } = {}) => {
  const r = fx(sym);
  return filaV21({
    mercado: r.mercado, historial: historia(sorpresas || r.sorpresas, r.base), fuenteHist,
    gaps: GAPS[sym] || [], guia: GUIAS[sym] ? { ...GUIAS[sym] } : null,
  });
};

test('v2.1: con historial de pm_v2_hist, AAL y PCG ya tienen número; la métrica de la sorpresa queda null', () => {
  for (const sym of ['AAL', 'PCG']) {
    const f = fila21(sym);
    assert.notEqual(f.prob_A, null, sym);
    assert.equal(f.universo_pead, false);
    assert.equal(f.fuente_hist, 'pm_v2_hist');
    assert.equal(f.sorpresa_metrica_match, null);
    assert.equal(f.faltante, null);
  }
  const sin = filaV21({ mercado: fx('AAL').mercado, historial: [], fuenteHist: null });
  assert.equal(sin.prob_A, null);
  assert.equal(sin.faltante, 'sin_historial');
});

test('v2.1: PCG con +0.01 — A dice Yes (falla), B con la guía 0.41 dice No (acierta)', () => {
  const f = fila21('PCG', { sorpresas: Array(8).fill(0.01) });
  assert.equal(f.estimado_A, 0.44);
  assert.equal(f.guia_q_implicita, 0.41);
  assert.equal(f.estimado_B, 0.425);
  assert.ok(f.prob_A > 0.5 && f.prob_B < 0.5, `${f.prob_A} / ${f.prob_B}`);
});

test('v2.1: AAL — A dice Yes (acierta), B con la guía −0.40 dice No (falla)', () => {
  const f = fila21('AAL');
  assert.equal(f.estimado_B, -0.3425);
  assert.ok(f.prob_A > 0.5 && f.prob_B < 0.5, `${f.prob_A} / ${f.prob_B}`);
});

test('v2.1: sin guía, prob_B = prob_A (META, UNP, PG)', () => {
  for (const sym of ['META', 'UNP', 'PG']) {
    const f = fila21(sym, { fuenteHist: 'pead' });
    assert.equal(f.prob_B, f.prob_A, sym);
    assert.equal(f.B_usa_guia, false);
    assert.equal(f.universo_pead, true);
  }
});

const m21 = (o) => ({ creado: '2026-11-01', fecha: '2026-11-10', outcome: 'yes', faltante: null, prob_A: 0.5, prob_B: 0.5, prob_pm_t24: 0.5, ...o });
const muchos = (n, f) => Array.from({ length: n }, (_, i) => m21(f(i)));

test('veredicto v2.1: < 40 completos → INCONCLUSO', () => {
  const v = veredictoV21(muchos(39, () => ({ prob_A: 0.9, prob_B: 0.9, prob_pm_t24: 0.5 })), { hoy: '2027-01-02' });
  assert.equal(v.veredicto, 'INCONCLUSO');
  assert.equal(v.completas, 39);
});

test('veredicto v2.1: ni A ni B le ganan a PM → NO-GO', () => {
  const v = veredictoV21(muchos(40, () => ({ prob_A: 0.6, prob_B: 0.6, prob_pm_t24: 0.9 })), { hoy: '2027-01-02' });
  assert.equal(v.veredicto, 'NO-GO');
});

test('veredicto v2.1: solo A gana y pasa la zona → GO por A', () => {
  const v = veredictoV21(muchos(40, (i) => ({ prob_A: 0.9, prob_B: 0.5, prob_pm_t24: i < 10 ? 0.6 : 0.85 })), { hoy: '2027-01-02' });
  assert.equal(v.veredicto, 'GO');
  assert.equal(v.A.pasa, true);
  assert.equal(v.B.gana_brier, false);
  assert.match(v.motivo, /pasa A/);
});

test('veredicto v2.1: A y B pasan → GO, se dice cuál tiene mejor Brier y NO se elige', () => {
  const v = veredictoV21(muchos(40, (i) => ({ prob_A: 0.9, prob_B: 0.95, prob_pm_t24: i < 10 ? 0.6 : 0.85 })), { hoy: '2027-01-02' });
  assert.equal(v.veredicto, 'GO');
  assert.match(v.motivo, /pasan A y B; mejor Brier: B\. No se elige/);
});

test('veredicto v2.1: gana el Brier pero la zona no llega al 65% → NO-GO', () => {
  // 50 fuera de la zona donde A es mucho mejor; 10 en la zona, A acierta 4.
  const v = veredictoV21(muchos(60, (i) => (i < 6 ? { prob_A: 0.45, prob_B: 0.45, prob_pm_t24: 0.7 }
    : i < 10 ? { prob_A: 0.95, prob_B: 0.95, prob_pm_t24: 0.75 }
      : { prob_A: 0.99, prob_B: 0.99, prob_pm_t24: 0.85 })), { hoy: '2027-01-02' });
  assert.equal(v.A.gana_brier, true);
  assert.equal(`${v.A.zona_aciertos}/${v.A.zona_n}`, '4/10');
  assert.equal(v.veredicto, 'NO-GO');
});

test('veredicto v2.1: antes del 31-dic es provisional; fuera del set no cuenta', () => {
  const filas = [...muchos(40, () => ({ prob_A: 0.9, prob_B: 0.9, prob_pm_t24: 0.5 })), m21({ creado: '2026-10-01' })];
  const v = veredictoV21(filas, { hoy: '2026-11-15' });
  assert.equal(v.en_set, 40);
  assert.match(v.veredicto, /\(provisional\)$/);
});

test('el markdown v2.1 pone A, B y PM por resuelto, y el piloto va sin veredicto', () => {
  const filas = [fila21('PCG', { sorpresas: Array(8).fill(0.01) })];
  const md = renderMdV21({ titulo: 'x', filas, piloto: true });
  assert.match(md, /Piloto piloto-oct26: SIN veredicto/);
  assert.match(md, /\*\*PCG 2026-10-22\*\*: A dijo \d+% ✗, B dijo \d+% ✓, PM sin precio a T-24h, salió No \(0\.41\)\./);
  assert.ok(!/Veredicto|GO/.test(md.split('\n').slice(0, 6).join('\n')));
});

test('búsqueda por símbolo: pedidos primero, sin universo cerrado, rotando por día', () => {
  const a = simbolosParaBuscar({ cosechados: ['ZZZ', 'bad sym'], pedidos: ['AAL'], dia: 0 });
  assert.equal(a[0], 'AAL');
  assert.ok(a.includes('ZZZ') && a.includes('PCG') && a.includes('AAPL'));
  assert.ok(!a.includes('bad sym'));
  assert.equal(new Set(a).size, a.length);
  const b = simbolosParaBuscar({ cosechados: ['ZZZ'], pedidos: [], dia: 1 });
  const c = simbolosParaBuscar({ cosechados: ['ZZZ'], pedidos: [], dia: 2 });
  assert.notEqual(b[0], c[0]);
  assert.deepEqual([...b].sort(), [...c].sort());
});

// ── migración y semillas contra un Postgres real ───────────────
const SQL_V2 = readFileSync('docs/sql/earnings-beat-v2.sql', 'utf8');
const SQL_V21 = readFileSync('docs/sql/earnings-beat-v2-1.sql', 'utf8');
const SQL_V22 = readFileSync('docs/sql/earnings-beat-v2-2.sql', 'utf8');
const SQL_V23 = readFileSync('docs/sql/earnings-beat-v2-3.sql', 'utf8');
const SQL_V24 = readFileSync('docs/sql/earnings-beat-v2-4.sql', 'utf8');
const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

test('la DDL de los .sql es la misma que SCHEMA_V2', () => {
  const ambos = norm(SQL_V2 + '\n' + SQL_V21 + '\n' + SQL_V22 + '\n' + SQL_V24);
  for (const q of SCHEMA_V2) assert.ok(ambos.includes(norm(q)), q.slice(0, 60));
});

test('pm_earnings_markets_v2 tiene el MISMO esquema que v1 + universo_pead', () => {
  const v1 = SCHEMA_V1[0];
  assert.ok(SCHEMA_V2.includes(v1.replace(/pm_earnings_markets/g, 'pm_earnings_markets_v2')));
  assert.ok(SCHEMA_V2.some((q) => /pm_earnings_markets_v2 add column if not exists universo_pead boolean/.test(q)));
});

test('migración + semillas + consultas + upserts v2.1, contra Postgres', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55437 });
  for (const q of SCHEMA_V1) psql(q + ';');
  psql(`create table if not exists pead_earnings (symbol text not null, fiscal_date_ending date not null,
          reported_date date not null, reported_eps numeric, estimated_eps numeric, surprise numeric,
          surprise_pct numeric, source text, ingested_at timestamptz default now(), primary key (symbol, reported_date));`);
  for (let i = 0; i < 2; i++) { psql(SQL_V2); psql(SQL_V21); psql(SQL_V22); psql(SQL_V23); psql(SQL_V24); }   // idempotentes
  assert.equal(psql('select count(*) from pm_v2_validation').trim(), '22');
  assert.equal(psql("select count(*) from pm_v2_validation where set = 'piloto-oct26'").trim(), '22');
  assert.equal(psql("select count(*) from pm_v2_validation where outcome is not null").trim(), '7');
  assert.equal(psql('select count(*) from pm_known_gaps').trim(), '6');          // + MRK (v2-3)
  assert.equal(psql('select count(*) from pm_company_guidance').trim(), '11');   // + HLT, NET, EBAY, MRK, CL (v2-3)
  assert.equal(psql('select count(*) from pm_known_gaps where fuente_url is null').trim(), '0');
  // lo que Lety abrió, verificado; lo que no, no
  assert.equal(psql("select string_agg(symbol || ':' || concepto, ',' order by symbol, concepto) from pm_known_gaps where not verificada").trim(), 'GOOGL:multa_dma_ce_jul_2026');
  assert.equal(psql("select string_agg(symbol, ',' order by symbol) from pm_company_guidance where not verificada").trim(), 'CL,HLT,SSNC');
  // v2-3: lo que NO se carga (sin guía de EPS) no está
  assert.equal(psql("select count(*) from pm_company_guidance where symbol in ('YELP','CBOE','CVX','IVZ','HGV','RDDT','DKNG','COIN')").trim(), '0');
  assert.match(psql("select nota from pm_v2_validation where symbol = 'IMAX' and fecha_mercado = '2026-10-22'"), /mismo reporte que IMAX 11-05/i);
  assert.equal(psql("select brecha_por_accion from pm_known_gaps where symbol = 'UNP'").trim(), '0.05');
  assert.equal(psql("select string_agg(symbol || ':' || anunciado_en, ',' order by symbol, concepto) from pm_known_gaps where anunciado_en is not null").trim(),
    'GOOGL:2026-07-23,LLY:2026-10-07,META:2026-08-26,MRK:2026-09-28,UNP:2026-07-23');

  for (const [nombre, f] of Object.entries(CONSULTAS)) {
    const q = f(2);
    const marcas = (q.match(/\$\d+/g) || []).map((x) => Number(x.slice(1)));
    const n = marcas.length ? Math.max(...marcas) : 0;
    const tipo = (i) => (['resueltos', 'pendientesPrecioV2'].includes(nombre) || (nombre === 'histFresco' && i === n) ? 'int' : 'text');
    const tipos = n ? `(${Array.from({ length: n }, (_, i) => tipo(i + 1)).join(', ')})` : '';
    psql(`prepare q_${nombre}${tipos} as ${q}; deallocate q_${nombre};`);
  }

  // Los upserts nuevos, ejecutados de verdad.
  const fetchOriginal = globalThis.fetch;
  const dbOriginal = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://u:p@ep-prueba.region.aws.neon.tech/db';
  globalThis.fetch = puenteNeon(psql);
  try {
    const ev = [
      { fiscal_date_ending: '2026-06-30', reported_date: '2026-07-23', reported_eps: 0.95, estimated_eps: 0.84, surprise: 0.11 },
      { fiscal_date_ending: '2026-09-30', reported_date: '2026-10-22', reported_eps: null, estimated_eps: -0.34, surprise: null },
    ];
    assert.equal(await upsertHist('AAL', ev), 1);   // el trimestre sin reportar NO entra
    assert.equal(await upsertHist('AAL', ev), 1);   // idempotente
    assert.equal(psql("select count(*) || '|' || max(reported_eps) from pm_v2_hist where symbol = 'AAL'").trim(), '1|0.95');

    const fila = (precio, estado, outcome = null) => ({
      market_id: 'm1', slug: 'aal-q3', question: 'Will American Airlines (AAL) beat quarterly earnings?', symbol: 'AAL',
      symbol_via: 'ticker', camino: 'simbolo', filtro_motivo: 'ok', creado: '2026-10-01', report_date: null,
      resolved_date: '2026-10-22', consensus_pm: -0.34, outcome, abierto: !outcome, yes_token_id: 't1',
      yes_price_t24h: precio, yes_price_ts: null, yes_price_estado: estado, volume: 1000, raw: JSON.stringify({ id: 'm1' }), universo_pead: false,
    });
    await upsertMercadosV2([fila(0.62, 'valido')]);
    await upsertMercadosV2([fila(0.10, 'error', 'yes')]);   // precio peor: no pisa; outcome sí entra
    await upsertMercadosV2([fila(null, null, null)]);        // resuelto no vuelve a abierto
    assert.equal(psql("select yes_price_t24h || '|' || yes_price_estado || '|' || outcome || '|' || abierto || '|' || universo_pead from pm_earnings_markets_v2").trim(), '0.62|valido|yes|false|false');
    // la unión v1+v2 que leen las vistas: lo de v1 que v2 no tiene, entra
    psql(`insert into pm_earnings_markets (market_id, symbol, filtro_motivo, resolved_date) values ('m1', 'AAL', 'ok', '2026-10-22'), ('m2', 'PG', 'ok', '2026-10-22');`);
    assert.equal(psql(`prepare u as ${CONSULTAS.resueltos()}; execute u(10);`).trim().split('\n').length, 1);  // solo m1 tiene outcome
    assert.equal(psql(`select count(*) from (${CONSULTAS.abiertos().replace(/order by[\s\S]*$/, '')}) x`).trim(), '0');

    // ── El endpoint de punta a punta, sobre las semillas ──
    // Lo que va a ver Lety después de correr los dos .sql, con la cosecha y el
    // historial todavía vacíos (salvo el AAL de arriba).
    const { default: handler } = await import('../api/earnings-beat-v2.js');
    delete process.env.CRON_SECRET;
    const r1 = resFalsa();
    await handler({ method: 'GET', query: { validacion: '1', format: 'md' }, headers: {} }, r1);
    assert.equal(r1.code, 200, JSON.stringify(r1.cuerpo));
    assert.match(r1.cuerpo, /Piloto piloto-oct26: SIN veredicto\.\*\* 22 mercados · resueltos 7/);
    assert.match(r1.cuerpo, /\*\*PCG 2026-10-22\*\*: A sin número, B sin número, PM sin precio a T-24h, salió No \(0\.41\)\. \[sin_historial\]/);
    assert.match(r1.cuerpo, /\| PCG \| 2026-10-22 \| 0\.43 \| NONGAAP \| 0\.43 \|.*0\.405…0\.415 \(barra arriba\)/);
    // AAL: tiene historial (1 trimestre, < 4): todavía sin número, pero ya no "fuera de universo"
    assert.match(r1.cuerpo, /\*\*AAL 2026-10-22\*\*: A sin número.*\[sin_historial_8t\]/);
    if (process.env.EB_V2_MD) (await import('node:fs')).writeFileSync(process.env.EB_V2_MD, r1.cuerpo);
    const r2 = resFalsa();
    await handler({ method: 'GET', query: { validacion: 'v21', format: 'md' }, headers: {} }, r2);
    assert.equal(r2.code, 200, JSON.stringify(r2.cuerpo));
    assert.match(r2.cuerpo, /Set v2\.1: INCONCLUSO \(provisional\)/);
    const r3 = resFalsa();
    await handler({ method: 'GET', query: { job: 'hist' }, headers: {} }, r3);
    assert.equal(r3.cuerpo.apagado, true);   // sin la bandera no gasta AV

    // ── job mercados_v2 contra un Gamma/CLOB falsos: un mercado de AAL (fuera
    // del universo PEAD) tiene que entrar, con su Yes a T-24h y universo_pead
    // = false. Lo que no es de Polymarket sigue yendo al puente de Neon.
    const neon = globalThis.fetch;
    const AAL_RAW = {
      id: 'pm-aal', slug: 'aal-quarterly-earnings-nongaap-eps-10-22-2026-neg-0pt34',
      question: 'Will American Airlines (AAL) beat quarterly earnings?',
      description: 'This market will resolve to "Yes" if American Airlines reports non-GAAP EPS greater than -$0.34 for the quarter. The Street consensus estimate for non-GAAP EPS is $-0.34 as of market creation.',
      outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', clobTokenIds: '["tok-yes","tok-no"]',
      endDate: '2026-10-22T20:00:00Z', closedTime: '2026-10-22T20:00:00Z', createdAt: '2026-10-01T12:00:00Z',
      closed: true, active: false, volumeNum: 5000,
    };
    const pedidos = [];
    const resp = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://gamma-api.polymarket.com/public-search')) {
        const q = new URL(u).searchParams.get('q') || '';
        pedidos.push(q);
        return resp({ events: q.startsWith('AAL ') ? [{ slug: 'aal-q3', markets: [AAL_RAW] }] : [] });
      }
      if (u.startsWith('https://clob.polymarket.com/prices-history')) {
        const fin = Date.parse('2026-10-22T20:00:00Z') / 1000;
        return resp({ history: [{ t: fin - 30 * 3600, p: 0.58 }, { t: fin - 25 * 3600, p: 0.61 }, { t: fin - 2 * 3600, p: 0.9 }] });
      }
      return neon(url, init);
    };
    try {
      const r4 = resFalsa();
      await handler({ method: 'GET', query: { job: 'mercados_v2', symbols: 'AAL' }, headers: {} }, r4);
      assert.equal(r4.code, 200, JSON.stringify(r4.cuerpo));
      assert.equal(pedidos[0], 'AAL quarterly earnings');   // los pedidos van primero
      assert.equal(r4.cuerpo.filtro.aceptados, 1, JSON.stringify(r4.cuerpo.filtro));
      assert.equal(r4.cuerpo.filtro.fuera_universo_pead, 1);
      assert.equal(psql("select symbol || '|' || universo_pead || '|' || yes_price_estado || '|' || yes_price_t24h || '|' || outcome from pm_earnings_markets_v2 where market_id = 'pm-aal'").trim(),
        'AAL|false|valido|0.61|yes');
      assert.equal(psql("select count(*) from pm_earnings_markets").trim(), '2');   // v1 intacta
    } finally {
      globalThis.fetch = neon;
    }
  } finally {
    globalThis.fetch = fetchOriginal;
    if (dbOriginal === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = dbOriginal;
  }
});

// ── anunciado_en (24-oct): dato, no regla ──
test('anunciado_en: la fila marca que el mercado nació después del anuncio, pero la brecha se aplica igual (META)', () => {
  const meta = [{ brecha_por_accion: 3.30, afecta: 'GAAP', fuente_url: 'u', anunciado_en: '2026-08-26' }];
  const despues = brechaConocida(meta, 'GAAP', '2026-10-16');
  assert.equal(despues.brecha_aplicada, 3.3);                      // NO pasa a 0
  assert.equal(despues.brechas_anunciadas_antes_de_creacion, 1);
  assert.equal(despues.brecha_anunciada_en, '2026-08-26');
  const antes = brechaConocida(meta, 'GAAP', '2026-08-01');
  assert.equal(antes.brechas_anunciadas_antes_de_creacion, 0);
  assert.equal(brechaConocida(meta, 'GAAP', null).brechas_anunciadas_antes_de_creacion, null);
  // un cargo solo-GAAP no cuenta contra una barra NONGAAP: no se aplica
  assert.equal(brechaConocida(meta, 'NONGAAP', '2026-10-16').brechas_anunciadas_antes_de_creacion, 0);
  // LLY: AMBAS cuenta en NONGAAP
  const lly = [{ brecha_por_accion: 4.57, afecta: 'AMBAS', fuente_url: 'u', anunciado_en: '2026-10-07' }];
  const f = brechaConocida(lly, 'NONGAAP', '2026-10-16');
  assert.deepEqual([f.brecha_aplicada, f.brechas_anunciadas_antes_de_creacion], [4.57, 1]);
});

test('anunciado_en no mueve prob A ni prob B (META sigue en 3%)', () => {
  const r = RESUELTOS.find((x) => x.mercado.symbol === 'META');
  const sin = filaV21({ mercado: { ...r.mercado, creado: '2026-10-16' }, historial: historia(r.sorpresas, r.base), fuenteHist: 'pead', gaps: GAPS.META });
  const con = filaV21({ mercado: { ...r.mercado, creado: '2026-10-16' }, historial: historia(r.sorpresas, r.base), fuenteHist: 'pead',
    gaps: GAPS.META.map((g) => ({ ...g, anunciado_en: '2026-08-26' })) });
  assert.equal(con.prob_A, sin.prob_A);
  assert.equal(con.prob_B, sin.prob_B);
  assert.equal(con.prob_A, 0.03);
  assert.equal(con.brechas_anunciadas_antes_de_creacion, 1);
  assert.match(renderMdV21({ titulo: 'x', filas: [con] }), /\| 3\.30§ \|/);
});

// ── semillas v2-3 (24-oct): la guía implícita que sale de lo cargado ──
test('v2-3: guía implícita de MRK y CL con la fórmula (guía anual − YTD) / 2', () => {
  const mrk = guiaImplicita({ alcance: 'anual', guia_min: 2.66, guia_max: 2.76, ytd_reportado: -1.41, trimestres_restantes: 2 });
  assert.deepEqual([mrk.guia_q_min, mrk.guia_q_max], [2.035, 2.085]);
  const cl = guiaImplicita({ alcance: 'anual', guia_min: 3.84, guia_max: 3.91, ytd_reportado: 1.97, trimestres_restantes: 2 });
  assert.deepEqual([cl.guia_q_min, cl.guia_q_max], [0.935, 0.97]);
  const net = guiaImplicita({ alcance: 'trimestre', guia_min: 0.34, guia_max: 0.34 });
  assert.equal(net.guia_q_implicita, 0.34);
});
