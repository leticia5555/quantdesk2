// ═══════════════════════════════════════════════════════════════════════
// Tests de PM-CENTAVOS2 (api/_lib/pm-centavos2-analyze.js + endpoint).
//
//   1. Criterios PROPIOS pineados valor por valor; las reglas neutrales ==
//      PM-CENTAVOS; PM-CENTAVOS sigue como estaba.
//   2. gap contra el estimatedEPS de AV, NO contra la descripción; empate
//      exacto, estimado negativo; exclusiones (sin fecha, sin barra, sin
//      estimado) con su motivo; mercados con fecha de av_hist entran.
//   3. Regresión (base gap = 0) == logística directa; simulación a mano
//      (gap = 0 no apuesta); cada frontera del veredicto; hipótesis (no decide).
//   4. Cadena: efecto plantado → GO; nulo → NO-GO; solo gap ≤ −1 → NO-GO;
//      N(gap ≥ +1) < 40 → INCONCLUSO.
//   5. Endpoint: gate, cobertura → resultado, escribe solo la caché de precios.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockRed, mockRes, GET, soloEscribe, rng, fechaMas, sig, lg, slugDe, descDe } from './_pm-red.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const K = await import('../api/_lib/pm-centavos2-analyze.js');
const P = await import('../api/_lib/pm-centavos-analyze.js');
const T = await import('../api/_lib/pm-trimestre-av.js');
const D = await import('../api/_lib/pm-drift-analyze.js');
const { default: handler } = await import('../api/pm-centavos2-analyze.js');
const C = K.CRITERIOS_PM_CENTAVOS2;
const H = 3600 * 1000;

const caminoConstante = (fecha, p) => {
  const v = D.ventanaDescarga(fecha);
  const pts = [];
  for (let t = v.desdeMs; t < v.hastaMs; t += H) pts.push({ t, p });
  return pts;
};

// ═══════════════════ 1. criterios ═══════════════════

test('criterios congelados: cada valor pineado', () => {
  assert.ok(Object.isFrozen(C));
  assert.equal(C.min_volumen_usd, 500);
  assert.equal(C.gap_tope, 4);
  assert.equal(C.horas_antes_precio, 24);
  assert.equal(C.max_hueco_horas, 3);
  assert.equal(C.logit_clip, 0.01);
  assert.equal(C.sim_no_si_gap_min, 1);
  assert.equal(C.sim_yes_si_gap_max, -1);
  assert.equal(C.apuesta_usd, 1);
  assert.equal(C.costo_por_operacion_usd, 0.02);
  assert.equal(C.min_n_gap_pos, 40);
  assert.equal(C.t_go, -2.5);
  assert.equal(C.t_fragil, -2);
  assert.match(C.hipotesis_previa, /gap ≥ \+1.*POR DEBAJO.*gap ≤ −1.*POR ARRIBA/);
  assert.equal(Object.keys(C).length, 13, 'nadie agregó un criterio en silencio');
  assert.deepEqual([...K.VARIABLES], ['logit_p24', 'gap_pos', 'gap_neg']);
});

test('reglas neutrales == PM-CENTAVOS, y PM-CENTAVOS no se movió', () => {
  const P0 = P.CRITERIOS_PM_CENTAVOS;
  for (const k of ['min_volumen_usd', 'gap_tope', 'horas_antes_precio', 'max_hueco_horas', 'logit_clip', 'apuesta_usd', 'costo_por_operacion_usd']) assert.equal(C[k], P0[k], k);
  assert.equal(P0.min_n_gap0, 40);
  assert.equal(P0.t_go, 2.5);
  assert.equal(P0.sim_no_p24_min, 0.70);
  assert.equal(Object.keys(P0).length, 15);
});

// ═══════════════════ 2. universo ═══════════════════

const fila = (o) => ({ market_id: 'x', symbol: 'AAA', slug: slugDe('AAA', 0.90), question: null, descripcion: descDe(0.90),
  report_date: '2026-11-03', resolved_date: null, creado: '2026-10-20', outcome: 'no', volume: 1000, yes_token_id: 'tok', cosecha: 'v2', ...o });
const hist = (sym, fecha, est) => ({ symbol: sym, fiscal_quarter_end: '2026-09-30', reported_date: fecha, reported_eps: null, estimated_eps: est });

function universoDe(filas, hs, horas = new Map()) {
  const histPorSimbolo = new Map();
  for (const h of hs) { if (!histPorSimbolo.has(h.symbol)) histPorSimbolo.set(h.symbol, []); histPorSimbolo.get(h.symbol).push(h); }
  return K.construyeUniverso(T.baseMercados(filas, { histPorSimbolo, horas }));
}

test('gap contra el estimatedEPS final de AV, no contra la descripción', () => {
  const u = universoDe([
    fila({ market_id: 'on' }),                                                     // barra 0.90, desc 0.90, AV 0.95 → −5
    fila({ market_id: 'eq', symbol: 'EQ' }),                                       // AV 0.90 → empate exacto 0
    fila({ market_id: 'neg', symbol: 'NG', slug: slugDe('NG', -0.03), descripcion: descDe(-0.05) }), // AV −0.05 → +2
  ], [hist('AAA', '2026-11-03', 0.95), hist('EQ', '2026-11-03', 0.1 + 0.8), hist('NG', '2026-11-04', -0.05)]);
  const g = Object.fromEntries(u.universo.map((m) => [m.market_id, m]));
  assert.equal(g.on.gap, -5);
  assert.equal(g.on.consenso, 0.95);
  assert.equal(g.on.consenso_descripcion, 0.9);
  assert.equal(g.on.tramo, '≤−4');
  assert.equal(g.eq.gap, 0, '0.1 + 0.8 = 0.9000000000000001 vs 0.90 → empate');
  assert.equal(g.neg.gap, 2);
  assert.equal(g.neg.tramo, '+2');
});

test('exclusiones con motivo; un mercado con fecha de av_hist entra', () => {
  const u = universoDe([
    fila({ market_id: 'a' }),                                                     // entra (tabla)
    fila({ market_id: 'b', report_date: null, creado: '2026-10-20' }),            // entra (av_hist → 2026-11-03)
    fila({ market_id: 'c', report_date: null, creado: '2026-11-20' }),            // sin fecha: hist_desactualizado
    fila({ market_id: 'd', slug: 'sin-umbral' }),                                 // sin barra
    fila({ market_id: 'e', symbol: 'SINAV' }),                                    // sin estimado: simbolo_sin_hist
    fila({ market_id: 'f', report_date: '2026-11-10' }),                          // sin estimado: sin_trimestre_av (7 días)
    fila({ market_id: 'g', symbol: 'NUL' }),                                      // sin estimado: estimado_nulo
    fila({ market_id: 'h', outcome: null }),                                      // no resuelto
  ], [hist('AAA', '2026-11-03', 0.95), hist('NUL', '2026-11-03', null)]);
  assert.deepEqual(u.universo.map((m) => [m.market_id, m.fuente_fecha, m.fecha]), [['a', 'tabla', '2026-11-03'], ['b', 'av_hist', '2026-11-03']]);
  assert.equal(u.excluidos.no_resuelto, 1);
  assert.equal(u.excluidos.sin_fecha_reporte, 1);
  assert.deepEqual(u.motivos_sin_fecha, { hist_desactualizado: 1 });
  assert.equal(u.excluidos.sin_barra, 1);
  assert.equal(u.excluidos.sin_estimado_av, 3);
  assert.deepEqual(u.motivos_sin_estimado, { simbolo_sin_hist: 1, sin_trimestre_av: 1, estimado_nulo: 1 });
  assert.deepEqual(u.por_fuente_fecha, { tabla: 1, av_hist: 1 });
});

test('hora del reporte: la de pead_event_hour en la fecha efectiva; sin hora → AMC imputado', () => {
  const u = universoDe([fila({ market_id: 'a' }), fila({ market_id: 'b', symbol: 'BBB' })],
    [hist('AAA', '2026-11-03', 0.9), hist('BBB', '2026-11-03', 0.9)], new Map([['AAA|2026-11-03', 'bmo']]));
  assert.equal(u.universo[0].hora_efectiva, 'bmo');
  assert.equal(u.universo[0].hora_imputada, false);
  assert.equal(new Date(u.universo[0].reporte_ms).toISOString(), '2026-11-03T12:00:00.000Z');
  assert.equal(u.universo[1].hora_imputada, true);
});

// ═══════════════════ 3. hipótesis ═══════════════════

const ob = (gap, p24, y, fecha = '2026-01-01') => ({ gap, p24, y, fecha, d: p24 });

test('regresión: base gap = 0, codificación == logística directa', () => {
  const r = rng(11);
  const obs = Array.from({ length: 300 }, (_, i) => { const p24 = 0.2 + r() * 0.7; return ob(GAPS[i % GAPS.length], p24, r() < p24 ? 1 : 0, fechaMas('2025-03-01', Math.floor(i / 4))); });
  const reg = K.regresion(obs);
  const dir = D.logistica(obs.map((o) => [D.logit(o.p24), o.gap >= 1 ? 1 : 0, o.gap <= -1 ? 1 : 0]), obs.map((o) => o.y), obs.map((o) => o.fecha));
  assert.ok(reg.convergio);
  assert.equal(reg.grupos, 75);
  assert.ok(Math.abs(reg.gap_pos.coef - dir.coef[2]) < 1e-6);
  assert.ok(Math.abs(reg.gap_pos.t - dir.t[2]) < 1e-6);
  assert.ok(Math.abs(reg.gap_neg.coef - dir.coef[3]) < 1e-6);
  assert.ok(Math.abs(reg.coefs.logit_p24.coef - dir.coef[1]) < 1e-6);
});

test('regresión: sin observaciones en la base (gap = 0) → sin convergencia → NO-GO', () => {
  const r = rng(5);
  const obs = Array.from({ length: 200 }, (_, i) => ob(i % 2 ? 2 : -2, 0.3 + r() * 0.5, r() < 0.5 ? 1 : 0, fechaMas('2025-01-01', i)));
  const reg = K.regresion(obs);
  assert.equal(reg.convergio, false);
  assert.equal(reg.motivo, 'matriz_singular');
  assert.equal(K.veredicto({ n_gap_pos: 100, regresion: reg, mitad_antes: { simulacion: { neto_usd: 1 } }, mitad_despues: { simulacion: { neto_usd: 1 } } }).veredicto, 'NO-GO');
});

test('simulación: gap ≥ +1 → No, gap ≤ −1 → Yes, gap = 0 no apuesta; pagos a mano', () => {
  const s = K.simulacion([
    ob(1, 0.80, 0),    // No a 0.20: +4 − 0.02
    ob(7, 0.30, 1),    // No a 0.70: −1 − 0.02 (sin umbral de p24)
    ob(-1, 0.50, 1),   // Yes a 0.50: +1 − 0.02
    ob(-9, 0.95, 0),   // Yes a 0.95: −1 − 0.02 (sin umbral de p24)
    ob(0, 0.90, 0),    // gap = 0: no apuesta
    ob(2, 1, 0),       // No a 0: no se puede
    ob(-2, 0, 1),      // Yes a 0: no se puede
    ob(3, null, 0),    // sin p24
  ]);
  assert.equal(s.operaciones, 4);
  assert.deepEqual(s.compra_no, { n: 2, aciertos: 1, neto_usd: Number((4 - 1 - 0.04).toFixed(4)) });
  assert.deepEqual(s.compra_yes, { n: 2, aciertos: 1, neto_usd: Number((1 - 1 - 0.04).toFixed(4)) });
  assert.equal(s.bruto_usd, 3);
  assert.equal(s.costos_usd, 0.08);
  assert.equal(s.neto_usd, 2.92);
});

test('veredicto: cada frontera', () => {
  const reg = (coef, t) => ({ convergio: true, gap_pos: { coef, se: 1, t }, gap_neg: { coef: 9, se: 1, t: 9 } });
  const sim = (neto) => ({ simulacion: { neto_usd: neto } });
  const v = (o) => K.veredicto({ n_gap_pos: 40, regresion: reg(-0.5, -3), mitad_antes: sim(1), mitad_despues: sim(1), ...o }).veredicto;
  assert.equal(v({}), 'GO');
  assert.equal(v({ n_gap_pos: 39 }), 'INCONCLUSO');
  assert.equal(v({ n_gap_pos: 39, regresion: reg(-5, -10) }), 'INCONCLUSO', 'N manda primero');
  assert.equal(v({ regresion: reg(-0.5, -2.5) }), 'GO', 't = −2.5 exacto → GO');
  assert.equal(v({ regresion: reg(-0.5, -2.4999) }), 'GO FRÁGIL');
  assert.equal(v({ regresion: reg(-0.5, -2) }), 'GO FRÁGIL', 't = −2 exacto → FRÁGIL');
  assert.equal(v({ regresion: reg(-0.5, -1.9999) }), 'NO-GO');
  assert.equal(v({ regresion: reg(0.5, 3) }), 'NO-GO', 'positivo con t grande no es GO');
  assert.equal(v({ mitad_antes: sim(0) }), 'NO-GO', 'neto = 0 no es > 0');
  assert.equal(v({ regresion: reg(-0.5, -2.2), mitad_despues: sim(-1) }), 'NO-GO', 'FRÁGIL también exige las dos mitades');
  assert.equal(v({ regresion: { convergio: false, motivo: 'separacion' } }), 'NO-GO');
  // coef(gap ≤ −1) NO decide: el mismo gap_pos con cualquier gap_neg da lo mismo.
  const r2 = { convergio: true, gap_pos: { coef: -0.5, se: 1, t: -3 }, gap_neg: { coef: -9, se: 1, t: -9 } };
  assert.equal(v({ regresion: r2 }), 'GO');
});

test('hipótesis previa: gap ≥ +1 por debajo, gap ≤ −1 por arriba; gap = 0 fuera (no decide)', () => {
  const h = K.chequeaHipotesis([ob(1, 0.6, 0), ob(3, 0.4, 1), ob(0, 0.5, 1), ob(-2, 0.5, 1), ob(-1, 0.5, 0), ob(-1, 0.5, 1), ob(5, null, 1)]);
  assert.equal(h.gap_pos.n, 2);
  assert.ok(Math.abs(h.gap_pos.diferencia - 0) < 1e-12);
  assert.equal(h.gap_pos.se_cumple, false, 'diferencia 0 no está por debajo');
  assert.equal(h.gap_neg.n, 3);
  assert.ok(Math.abs(h.gap_neg.diferencia - (2 / 3 - 0.5)) < 1e-12);
  assert.equal(h.gap_neg.se_cumple, true);
  assert.equal(K.chequeaHipotesis([]).gap_pos.se_cumple, null);
});

// ═══════════════════ 4. cadena ═══════════════════

const GAPS = [0, 0, 0, 0, 0, -1, -1, -2, -3, -5, 1, 1, 2, 3, 6];
function fabrica({ n = 600, modo = 'nulo', semilla = 7 } = {}) {
  const r = rng(semilla);
  const mercados = [];
  const hs = [];
  const puntosPorToken = new Map();
  for (let i = 0; i < n; i++) {
    const fecha = fechaMas('2025-01-06', Math.floor(i / 3));
    const gap = GAPS[i % GAPS.length];
    const est = Number((0.2 + r() * 2).toFixed(2));
    const barra = Number((est + gap / 100).toFixed(2));
    const p24 = Number((0.3 + r() * 0.65).toFixed(4));
    // 'centavos': barra arriba del consenso final → Yes sobrevalorado; abajo → subvalorado.
    // 'solo_neg': solo gap ≤ −1 tiene efecto (no debe dar GO: decide gap ≥ +1).
    const q = modo === 'centavos' ? (gap >= 1 ? sig(lg(p24) - 1.3) : gap <= -1 ? sig(lg(p24) + 1.3) : p24)
      : modo === 'solo_neg' ? (gap <= -1 ? sig(lg(p24) + 1.3) : p24) : p24;
    const y = r() < q ? 1 : 0;
    const sym = 'S' + i;
    // la mitad sin fecha en la tabla: la pone AV
    const sinFecha = i % 2 === 1;
    mercados.push(fila({ market_id: 'm' + i, symbol: sym, slug: slugDe(sym, barra), descripcion: descDe(barra), report_date: sinFecha ? null : fecha,
      creado: fechaMas(fecha, -10), outcome: y ? 'yes' : 'no', yes_token_id: 'tok' + i }));
    hs.push(hist(sym, fecha, est));
    puntosPorToken.set('tok' + i, caminoConstante(fecha, p24));
  }
  return { mercados, hist: hs, puntosPorToken };
}
function corre(fx) {
  const u = universoDe(fx.mercados, fx.hist);
  const puntosPorId = new Map(u.universo.map((m) => [m.market_id, fx.puntosPorToken.get(m.token)]));
  const estados = new Map(u.universo.map((m) => [m.market_id, 'ok']));
  return { u, r: K.corre({ universo: u.universo, puntosPorId, estados }) };
}

test('efecto plantado (gap ≥ +1 sobrevalorado) → GO; usa fechas de tabla y de av_hist', () => {
  const { r } = corre(fabrica({ modo: 'centavos' }));
  assert.equal(r.estado, 'GO', r.motivo);
  assert.equal(r.n_validas, 600);
  assert.deepEqual(r.por_fuente_fecha, { tabla: 300, av_hist: 300 });
  assert.equal(r.n_gap_pos, 200);
  assert.equal(r.n_gap0, 200);
  assert.equal(r.n_gap_neg, 200);
  assert.ok(r.regresion.gap_pos.coef < 0 && r.regresion.gap_pos.t <= -2.5);
  assert.ok(r.regresion.gap_neg.coef > 0, 'se reporta');
  assert.ok(r.mitad_antes.simulacion.neto_usd > 0 && r.mitad_despues.simulacion.neto_usd > 0);
  assert.equal(r.hipotesis_previa.gap_pos.se_cumple, true);
  assert.equal(r.hipotesis_previa.gap_neg.se_cumple, true);
  assert.equal(r.movimiento_consenso.igual, 200, 'la descripción trae la barra; solo coincide con AV donde gap = 0');
  assert.equal(r.tabla.length, 9);
});

test('precio calibrado → NO-GO', () => {
  const { r } = corre(fabrica({ modo: 'nulo', semilla: 9 }));
  assert.equal(r.estado, 'NO-GO', r.motivo);
});

test('efecto solo en gap ≤ −1 → NO-GO: decide gap ≥ +1', () => {
  const { r } = corre(fabrica({ modo: 'solo_neg', semilla: 4 }));
  assert.ok(r.regresion.gap_neg.t > 2.5, 'el efecto está y se reporta');
  assert.equal(r.estado, 'NO-GO', r.motivo);
});

test('N(gap ≥ +1) < 40 → INCONCLUSO aunque el efecto esté', () => {
  const { r } = corre(fabrica({ n: 105, modo: 'centavos' }));
  assert.equal(r.n_gap_pos, 35);
  assert.equal(r.estado, 'INCONCLUSO');
});

test('markdown', () => {
  const { u, r } = corre(fabrica({ modo: 'centavos' }));
  delete r.obs;
  const { universo, ...resto } = u;
  const md = K.renderResumenMarkdown({ generado_en: 'x', universo: resto, resultado: r });
  for (const t of P.tramosGap()) assert.match(md, new RegExp(`^\\| ${t.replace('+', '\\+')} \\| \\d+ \\|`, 'm'), t);
  assert.match(md, /## Estado: \*\*GO\*\*/);
  assert.match(md, /tabla 300 · av_hist 300/);
  assert.match(md, /- gap ≥ \+1: N .*✅ por debajo/);
  assert.match(md, /- gap ≤ −1: N .*✅ por arriba/);
  assert.match(md, /Base: gap = 0\./);
  assert.match(md, /1\[gap ≥ \+1\] \(decide\): coef -/);
  assert.match(md, /gap = 0 → no se apuesta/);
  assert.match(md, /pm_v2_consenso_snap/);
});

// ═══════════════════ 5. endpoint ═══════════════════

test('endpoint: gate, cobertura → resultado, escribe solo la caché de precios', async () => {
  const fx = fabrica({ n: 300, modo: 'centavos', semilla: 21 });
  const red = mockRed({ mercados: [...fx.mercados, fila({ market_id: 'abierto', outcome: null })], hist: fx.hist, puntosPorToken: fx.puntosPorToken });
  globalThis.fetch = red.fetch;
  const a = mockRes();
  await handler(GET({}), a);
  assert.equal(a.code, 401);

  const cob = mockRes();
  await handler(GET({ secret: SECRET, solo: 'cobertura', format: 'md' }), cob);
  assert.equal(cob.code, 200, cob.body && cob.body.error);
  assert.match(cob.text, /COBERTURA LISTA/);
  assert.match(cob.text, /Con p24: \*\*300\*\*/);
  assert.equal(red.clobLlamadas.length, 300);

  const full = mockRes();
  await handler(GET({ secret: SECRET }), full);
  assert.equal(full.code, 200, full.body && full.body.error);
  assert.equal(red.clobLlamadas.length, 300, 'lo bajado no se vuelve a pedir');
  assert.equal(full.body.veredicto, full.body.resultado.estado);
  assert.equal(full.body.resultado.n_validas, 300);
  assert.equal(full.body.universo.excluidos.no_resuelto, 1);
  soloEscribe(assert, red.queries, ['pm_price_hist', 'pm_price_hist_fetch']);
});
