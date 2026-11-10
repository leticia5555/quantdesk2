// ═══════════════════════════════════════════════════════════════════════
// Tests de PM-DRIFT2H (api/_lib/pm-drift2h-analyze.js + endpoint).
//
//   1. Criterios pineados; los compartidos == PM-DRIFT; PM-DRIFT intacto.
//   2. Universo: SIN horas imputadas; fechas de tabla y de av_hist.
//   3. Regresión sobre logit(p2h) (no p24) == logística directa.
//   4. Simulación A PRECIO p2h, pagos a mano.
//   5. Veredicto: t ≥ 2.5 y neto > 0 en ambas mitades; SIN GO FRÁGIL.
//   6. Cadena: drift plantado sobre p2h → GO; p2h calibrado → NO-GO; un
//      drift que p24 no ve pero p2h sí ya incluye → NO-GO.
//   7. Endpoint: gate, cobertura → resultado, escribe solo la caché.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockRed, mockRes, GET, soloEscribe, rng, fechaMas, sig, lg } from './_pm-red.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const X = await import('../api/_lib/pm-drift2h-analyze.js');
const D = await import('../api/_lib/pm-drift-analyze.js');
const T = await import('../api/_lib/pm-trimestre-av.js');
const { default: handler } = await import('../api/pm-drift2h-analyze.js');
const C = X.CRITERIOS_PM_DRIFT2H;
const H = 3600 * 1000;

// ═══════════════════ 1. criterios ═══════════════════

test('criterios congelados: cada valor pineado', () => {
  assert.ok(Object.isFrozen(C));
  assert.equal(C.min_volumen_usd, 500);
  assert.equal(C.excluir_hora_imputada, true);
  assert.equal(C.umbral_drift_pts, 5);
  assert.equal(C.apuesta_usd, 1);
  assert.equal(C.costo_por_operacion_usd, 0.02);
  assert.equal(C.logit_clip, 0.01);
  assert.equal(C.min_n, 150);
  assert.equal(C.t_go, 2.5);
  assert.match(C.hipotesis_previa, /NO-GO/);
  assert.equal(Object.keys(C).length, 9, 'nadie agregó un criterio en silencio (tampoco un t_fragil)');
});

test('los compartidos == PM-DRIFT, y PM-DRIFT no se movió', () => {
  const P = D.CRITERIOS_PM_DRIFT;
  for (const k of ['min_volumen_usd', 'umbral_drift_pts', 'apuesta_usd', 'costo_por_operacion_usd', 'logit_clip', 't_go']) assert.equal(C[k], P[k], k);
  assert.equal(C.min_n, P.min_n_delta);
  assert.deepEqual({ ...P.horas_antes }, { t72: 72, t24: 24, t2: 2 });
  assert.equal(P.max_hueco_horas, 3);
});

// ═══════════════════ 2. universo ═══════════════════

const fila = (o) => ({ market_id: 'x', symbol: 'AAA', slug: null, question: null, descripcion: null, report_date: '2026-10-21', resolved_date: null,
  creado: '2026-10-01', outcome: 'yes', volume: 1000, yes_token_id: 'tok', cosecha: 'v2', ...o });

function universoDe(filas, { hist = [], horas = [] } = {}) {
  const histPorSimbolo = new Map();
  for (const h of hist) { if (!histPorSimbolo.has(h.symbol)) histPorSimbolo.set(h.symbol, []); histPorSimbolo.get(h.symbol).push(h); }
  const hm = new Map(horas.map((h) => [`${h.symbol}|${h.reported_date}`, h.hour]));
  return X.construyeUniverso(T.baseMercados(filas, { histPorSimbolo, horas: hm }));
}

test('universo: sin horas imputadas; entra una fecha de av_hist con hora', () => {
  const u = universoDe([
    fila({ market_id: 'a' }),                                                      // tabla + bmo
    fila({ market_id: 'b', symbol: 'BBB' }),                                       // tabla sin hora → fuera
    fila({ market_id: 'c', symbol: 'CCC', report_date: null }),                    // av_hist + amc
    fila({ market_id: 'd', symbol: 'DDD', report_date: null }),                    // sin fecha
    fila({ market_id: 'e', volume: 10 }),                                          // liquidez
  ], {
    hist: [{ symbol: 'CCC', reported_date: '2026-10-22', estimated_eps: 1 }],
    horas: [{ symbol: 'AAA', reported_date: '2026-10-21', hour: 'bmo' }, { symbol: 'CCC', reported_date: '2026-10-22', hour: 'amc' }],
  });
  assert.deepEqual(u.universo.map((m) => [m.market_id, m.fuente_fecha, m.hora_efectiva]), [['a', 'tabla', 'bmo'], ['c', 'av_hist', 'amc']]);
  assert.ok(u.universo.every((m) => !m.hora_imputada));
  assert.equal(u.excluidos.hora_imputada, 1);
  assert.equal(u.excluidos.sin_fecha_reporte, 1);
  assert.equal(u.excluidos.liquidez, 1);
  assert.deepEqual(u.por_fuente_fecha, { tabla: 1, av_hist: 1 });
  assert.equal(new Date(u.universo[0].reporte_ms).toISOString(), '2026-10-21T11:00:00.000Z', 'BMO 07:00 EDT');
});

// ═══════════════════ 3–4. regresión y simulación ═══════════════════

const ob = (p2, d2, y, fecha = '2026-01-01', p24 = null) => ({ p2, d2, y, fecha, p24: p24 === null ? (d2 === null ? null : p2 - d2 / 100) : p24 });

test('regresión: logit(p2h) + Δ2 == logística directa (no logit(p24))', () => {
  const r = rng(3);
  const obs = Array.from({ length: 300 }, (_, i) => { const p2 = 0.2 + r() * 0.6; const d2 = (r() - 0.5) * 20; return ob(p2, d2, r() < p2 ? 1 : 0, fechaMas('2025-01-01', Math.floor(i / 3))); });
  const reg = X.regresion(obs);
  const dir = D.logistica(obs.map((o) => [D.logit(o.p2), o.d2]), obs.map((o) => o.y), obs.map((o) => o.fecha));
  assert.ok(Math.abs(reg.coef - dir.coef[2]) < 1e-6);
  assert.ok(Math.abs(reg.t - dir.t[2]) < 1e-6);
  assert.ok(Math.abs(reg.coef_logit_p2 - dir.coef[1]) < 1e-6);
  const conP24 = D.logistica(obs.map((o) => [D.logit(o.p24), o.d2]), obs.map((o) => o.y), obs.map((o) => o.fecha));
  assert.ok(Math.abs(reg.coef - conP24.coef[2]) > 1e-3, 'no es la especificación vieja');
  assert.equal(reg.grupos, 100);
});

test('simulación: compra a precio p2h, pagos a mano', () => {
  const s = X.simulacion([
    ob(0.40, 5, 1),     // Yes a 0.40: +1.5 − 0.02 (Δ2 = +5 exacto entra)
    ob(0.80, 12, 0),    // Yes a 0.80: −1 − 0.02
    ob(0.25, -5, 0),    // No a 0.75: +1/3 − 0.02
    ob(0.60, -4.99, 0), // fuera
    ob(0.60, null, 1),  // fuera: sin Δ2
    ob(1, -9, 0),       // fuera: No a 0
  ]);
  assert.equal(s.operaciones, 3);
  assert.equal(s.compra_yes, 2);
  assert.equal(s.compra_no, 1);
  assert.equal(s.aciertos, 2);
  assert.equal(s.bruto_usd, Number((1.5 - 1 + 1 / 3).toFixed(4)));
  assert.equal(s.neto_usd, Number((1.5 - 1 + 1 / 3 - 0.06).toFixed(4)));
});

// ═══════════════════ 5. veredicto ═══════════════════

test('veredicto: cada frontera, sin GO FRÁGIL', () => {
  const reg = (coef, t) => ({ convergio: true, coef, t });
  const sim = (neto) => ({ simulacion: { neto_usd: neto } });
  const v = (o) => X.veredicto({ n: 150, regresion: reg(0.1, 3), mitad_antes: sim(1), mitad_despues: sim(1), ...o }).veredicto;
  assert.equal(v({}), 'GO');
  assert.equal(v({ n: 149 }), 'INCONCLUSO');
  assert.equal(v({ regresion: reg(0.1, 2.5) }), 'GO', 't = 2.5 exacto');
  assert.equal(v({ regresion: reg(0.1, 2.4999) }), 'NO-GO', 'no hay GO FRÁGIL');
  assert.equal(v({ regresion: reg(-0.1, -3) }), 'NO-GO', 'negativo con |t| grande tampoco');
  assert.equal(v({ mitad_antes: sim(0) }), 'NO-GO', 'neto = 0 no es > 0');
  assert.equal(v({ mitad_despues: sim(-1) }), 'NO-GO');
  assert.equal(v({ regresion: { convergio: false, motivo: 'separacion' } }), 'NO-GO');
});

// ═══════════════════ 6. cadena ═══════════════════

// p24 hasta T−12h, p2 después (T-2h cae en p2).
function camino(reporteMs, fecha, p24, p2) {
  const v = D.ventanaDescarga(fecha);
  const pts = [];
  for (let t = v.desdeMs; t < v.hastaMs; t += H) pts.push({ t, p: t < reporteMs - 12 * H ? p24 : p2 });
  return pts;
}
// 'drift': y ~ sig(logit(p2) + 0.12·Δ2) — p2h sub-reacciona.
// 'nulo':  y ~ p2 — p2h es el precio justo (y Δ2 SÍ predice contra p24).
function fabrica({ n = 600, modo = 'nulo', semilla = 5 } = {}) {
  const r = rng(semilla);
  const mercados = [], horas = [], puntosPorToken = new Map();
  for (let i = 0; i < n; i++) {
    const fecha = fechaMas('2025-01-06', Math.floor(i / 3));
    const hour = ['bmo', 'amc', 'dmh'][i % 3];
    const rep = D.horaDelReporte(fecha, hour);
    const p24 = 0.15 + r() * 0.7;
    const p2 = Math.min(0.97, Math.max(0.03, p24 + (r() - 0.5) * 0.3));
    const d2 = (p2 - p24) * 100;
    const q = modo === 'drift' ? sig(lg(p2) + 0.12 * d2) : p2;
    const y = r() < q ? 1 : 0;
    const sym = 'S' + i;
    mercados.push(fila({ market_id: 'm' + i, symbol: sym, report_date: fecha, outcome: y ? 'yes' : 'no', yes_token_id: 'tok' + i }));
    horas.push({ symbol: sym, reported_date: fecha, hour });
    puntosPorToken.set('tok' + i, camino(rep.ms, fecha, p24, p2));
  }
  return { mercados, horas, puntosPorToken };
}
function corre(fx) {
  const u = universoDe(fx.mercados, { horas: fx.horas });
  const puntosPorId = new Map(u.universo.map((m) => [m.market_id, fx.puntosPorToken.get(m.token)]));
  const estados = new Map(u.universo.map((m) => [m.market_id, 'ok']));
  return { u, r: X.corre({ universo: u.universo, puntosPorId, estados }) };
}

test('drift plantado sobre p2h → GO', () => {
  const { r } = corre(fabrica({ modo: 'drift' }));
  assert.equal(r.estado, 'GO', r.motivo);
  assert.equal(r.n, 600);
  assert.ok(r.regresion.t >= 2.5);
});

test('p2h calibrado → NO-GO, aunque la especificación vieja (logit(p24) + Δ2) dé significativo', () => {
  const { r } = corre(fabrica({ modo: 'nulo', semilla: 8 }));
  assert.equal(r.estado, 'NO-GO', r.motivo);
  assert.ok(r.referencia_logit_p24.t > 2.5, `la vieja confunde "p2h ya lo sabe" con señal: t = ${r.referencia_logit_p24.t}`);
});

test('sin datos: universo vacío → FRONTERA; pendientes → INCOMPLETA', () => {
  assert.equal(X.corre({ universo: [], puntosPorId: new Map(), estados: new Map() }).estado, 'FALLA DE FRONTERA');
  const fx = fabrica({ n: 30 });
  const u = universoDe(fx.mercados, { horas: fx.horas });
  assert.equal(X.corre({ universo: u.universo, puntosPorId: new Map(), estados: new Map() }).estado, 'COBERTURA INCOMPLETA');
  const ok = new Map(u.universo.map((m) => [m.market_id, 'ok']));
  assert.equal(X.corre({ universo: u.universo, puntosPorId: new Map(), estados: ok }).estado, 'FALLA DE FRONTERA');
});

test('markdown', () => {
  const { u, r } = corre(fabrica({ modo: 'drift' }));
  delete r.obs;
  const { universo, ...resto } = u;
  const md = X.renderResumenMarkdown({ generado_en: 'x', universo: resto, resultado: r });
  assert.match(md, /## Estado: \*\*GO\*\*/);
  assert.match(md, /resultado ~ logit\(p2h\) \+ Δ2 — N 600/);
  assert.match(md, /Simulación a precio p2h/);
  assert.match(md, /hora_imputada 0/);
});

// ═══════════════════ 7. endpoint ═══════════════════

test('endpoint: gate, cobertura → resultado, escribe solo la caché', async () => {
  const fx = fabrica({ n: 300, modo: 'drift', semilla: 21 });
  const red = mockRed({ mercados: [...fx.mercados, fila({ market_id: 'sinhora', symbol: 'NOH' })], horas: fx.horas, puntosPorToken: fx.puntosPorToken });
  globalThis.fetch = red.fetch;
  const a = mockRes();
  await handler(GET({ secret: 'mal' }), a);
  assert.equal(a.code, 401);

  const cob = mockRes();
  await handler(GET({ solo: 'cobertura', format: 'md' }, { authorization: `Bearer ${SECRET}` }), cob);
  assert.equal(cob.code, 200, cob.body && cob.body.error);
  assert.match(cob.text, /COBERTURA LISTA/);
  assert.match(cob.text, /\*\*con Δ2: 300\*\*/);
  assert.match(cob.text, /hora_imputada 1/);
  assert.equal(red.clobLlamadas.length, 300, 'el mercado sin hora no se baja');

  const full = mockRes();
  await handler(GET({ secret: SECRET }), full);
  assert.equal(full.code, 200, full.body && full.body.error);
  assert.equal(red.clobLlamadas.length, 300);
  assert.equal(full.body.veredicto, 'GO');
  soloEscribe(assert, red.queries, ['pm_price_hist', 'pm_price_hist_fetch']);
});
