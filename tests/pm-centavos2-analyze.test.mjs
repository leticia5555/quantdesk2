// ═══════════════════════════════════════════════════════════════════════
// Tests de PM-CENTAVOS2 (api/_lib/pm-centavos2-analyze.js + endpoint).
//
//   1. Criterios == los de PM-CENTAVOS valor por valor (solo cambia el texto
//      de la hipótesis), y PM-CENTAVOS sigue pineado como estaba.
//   2. gap contra el estimatedEPS de AV, NO contra la descripción; empate
//      exacto, estimado negativo; exclusiones (sin fecha, sin barra, sin
//      estimado) con su motivo; mercados con fecha de av_hist entran.
//   3. Hipótesis previa: gap ≤ 0 por encima / gap ≥ +1 por debajo (no decide).
//   4. Cadena: efecto plantado → GO por las reglas de PM-CENTAVOS; nulo → NO-GO.
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

test('criterios: IGUALES a PM-CENTAVOS salvo el texto de la hipótesis', () => {
  assert.ok(Object.isFrozen(C));
  const { hipotesis_previa: h2, ...resto2 } = C;
  const { hipotesis_previa: h1, ...resto1 } = P.CRITERIOS_PM_CENTAVOS;
  assert.deepEqual(resto2, resto1);
  assert.equal(Object.keys(C).length, Object.keys(P.CRITERIOS_PM_CENTAVOS).length);
  assert.match(h2, /gap ≤ 0.*POR ENCIMA.*gap ≥ \+1.*POR DEBAJO/);
  assert.notEqual(h1, h2);
  // PM-CENTAVOS no se movió.
  assert.equal(P.CRITERIOS_PM_CENTAVOS.min_n_gap0, 40);
  assert.equal(P.CRITERIOS_PM_CENTAVOS.t_go, 2.5);
  assert.equal(P.CRITERIOS_PM_CENTAVOS.sim_no_p24_min, 0.70);
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

test('hipótesis previa: gap ≤ 0 por encima y gap ≥ +1 por debajo (no decide)', () => {
  const o = (gap, p24, y) => ({ gap, p24, y });
  const h = K.chequeaHipotesis([o(0, 0.5, 1), o(-2, 0.5, 1), o(-1, 0.5, 0), o(1, 0.6, 0), o(3, 0.4, 1), o(5, null, 1)]);
  assert.equal(h.gap_le_0.n, 3);
  assert.ok(Math.abs(h.gap_le_0.diferencia - (2 / 3 - 0.5)) < 1e-12);
  assert.equal(h.gap_le_0.se_cumple, true);
  assert.equal(h.gap_ge_1.n, 2);
  assert.ok(Math.abs(h.gap_ge_1.diferencia - 0) < 1e-12);
  assert.equal(h.gap_ge_1.se_cumple, false, 'diferencia 0 no está por debajo');
  assert.equal(K.chequeaHipotesis([]).gap_le_0.se_cumple, null);
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
    const q = modo === 'centavos' ? (gap === 0 ? sig(lg(p24) - 1.3) : gap <= -1 ? sig(lg(p24) + 1.3) : p24) : p24;
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

test('efecto plantado → GO por las reglas de PM-CENTAVOS; usa fechas de tabla y de av_hist', () => {
  const { r } = corre(fabrica({ modo: 'centavos' }));
  assert.equal(r.estado, 'GO', r.motivo);
  assert.equal(r.n_validas, 600);
  assert.deepEqual(r.por_fuente_fecha, { tabla: 300, av_hist: 300 });
  assert.equal(r.n_gap0, 200);
  assert.ok(r.regresion.gap0.coef < 0);
  assert.equal(r.movimiento_consenso.n, 600);
  assert.equal(r.movimiento_consenso.igual, 200, 'la descripción trae la barra; solo coincide con AV donde gap = 0');
  assert.ok(r.hipotesis_previa.gap_le_0 && r.hipotesis_previa.gap_ge_1);
  // El veredicto es exactamente el de PM-CENTAVOS sobre los mismos números.
  assert.equal(P.veredicto(r).veredicto, r.estado);
});

test('precio calibrado → NO-GO', () => {
  const { r } = corre(fabrica({ modo: 'nulo', semilla: 9 }));
  assert.equal(r.estado, 'NO-GO', r.motivo);
});

test('markdown', () => {
  const { u, r } = corre(fabrica({ modo: 'centavos' }));
  delete r.obs;
  const { universo, ...resto } = u;
  const md = K.renderResumenMarkdown({ generado_en: 'x', universo: resto, resultado: r });
  for (const t of P.tramosGap()) assert.match(md, new RegExp(`^\\| ${t.replace('+', '\\+')} \\| \\d+ \\|`, 'm'), t);
  assert.match(md, /## Estado: \*\*GO\*\*/);
  assert.match(md, /tabla 300 · av_hist 300/);
  assert.match(md, /- gap ≤ 0: N /);
  assert.match(md, /- gap ≥ \+1: N /);
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
