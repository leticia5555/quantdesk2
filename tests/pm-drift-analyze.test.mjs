// ═══════════════════════════════════════════════════════════════════════
// Tests de PM-DRIFT (api/_lib/pm-drift-analyze.js + /api/pm-drift-analyze).
//
//   1. Criterios PINEADOS valor por valor (pre-registro).
//   2. Hora del reporte: BMO/DMH/AMC en hora del Este con horario de verano;
//      mercado SIN HORA → AMC (imputado).
//   3. Precio en cada hora: el punto ANTERIOR más cercano; a > 3h → faltante;
//      EMPATE de timestamps → gana el último; nunca un punto posterior.
//   4. Universo: unión sin duplicados (gana v2), NO RESUELTO excluido,
//      liquidez < $500 excluida, sin fecha de reporte excluido.
//   5. Logística con errores agrupados == statsmodels (valores pineados).
//   6. Tramos, simulación, mitades, calibración, cada frontera del veredicto.
//   7. Cadena completa: drift plantado → GO; precio calibrado → NO-GO;
//      cero puntos → FALLA DE FRONTERA; descargas pendientes → sin veredicto.
//   8. Descarga: 429 corta, error se registra, ventana, fallback interval=max.
//   9. Endpoint: gate, solo escribe en las tablas nuevas, ?solo=cobertura.
//  10. Postgres real: docs/sql/pm-drift.sql == SCHEMA y todo el SQL corre.
//
// Correr con `node tests/pm-drift-analyze.test.mjs`.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const L = await import('../api/_lib/pm-drift-analyze.js');
const { default: handler } = await import('../api/pm-drift-analyze.js');
const { SCHEMA: SCHEMA_V1 } = await import('../api/_lib/earnings-beat-db.js');
const { PEAD_SCHEMA } = await import('../api/_lib/pead-db.js');

const H = 3600 * 1000;
const C = L.CRITERIOS_PM_DRIFT;

// ═══════════════════ fixtures ═══════════════════

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const sig = (z) => 1 / (1 + Math.exp(-z));
const lg = (p) => Math.log(p / (1 - p));

function fechaMas(fecha, dias) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Puntos horarios en la ventana de descarga: p72 hasta T−48h, p24 de T−48h a
// T−12h, p2 desde T−12h.
function camino(reporteMs, fecha, p72, p24, p2) {
  const v = L.ventanaDescarga(fecha);
  const pts = [];
  for (let t = v.desdeMs; t < v.hastaMs; t += H) {
    const p = t < reporteMs - 48 * H ? p72 : t < reporteMs - 12 * H ? p24 : p2;
    pts.push({ t, p });
  }
  return pts;
}

// modo 'drift': y ~ Bernoulli(sig(logit(p24) + 0.12·Δ)) — el precio
// sub-reacciona. modo 'nulo': y ~ Bernoulli(p24) — el precio ya lo incluye.
function fabrica({ n = 400, modo = 'nulo', semilla = 3, desde = '2025-01-06' } = {}) {
  const r = rng(semilla);
  const universo = [];
  const puntosPorId = new Map();
  const estados = new Map();
  for (let i = 0; i < n; i++) {
    const fecha = fechaMas(desde, Math.floor(i / 3));
    const hour = ['bmo', 'amc', null][i % 3];
    const rep = L.horaDelReporte(fecha, hour);
    const p72 = 0.15 + r() * 0.7;
    const d = (r() - 0.5) * 0.3;
    const p24 = Math.min(0.97, Math.max(0.03, p72 + d));
    const delta = (p24 - p72) * 100;
    const q = modo === 'drift' ? sig(lg(p24) + 0.12 * delta) : p24;
    const y = r() < q ? 1 : 0;
    const id = 'm' + i;
    universo.push({ market_id: id, symbol: 'S' + (i % 50), fecha, hora: hour, hora_efectiva: rep.hora_efectiva,
      hora_imputada: rep.imputada, reporte_ms: rep.ms, token: 't' + i, y, volume: 1000 });
    puntosPorId.set(id, camino(rep.ms, fecha, p72, p24, p24));
    estados.set(id, 'ok');
  }
  return { universo, puntosPorId, estados };
}

// ═══════════════════ 1. criterios pineados ═══════════════════

test('criterios congelados: cada valor pineado', () => {
  assert.ok(Object.isFrozen(C));
  assert.equal(C.min_volumen_usd, 500);
  assert.deepEqual({ ...C.hora_reporte_et }, { bmo: '07:00', dmh: '12:00', amc: '16:00' });
  assert.equal(C.hora_por_defecto, 'amc');
  assert.deepEqual({ ...C.horas_antes }, { t72: 72, t24: 24, t2: 2 });
  assert.equal(C.max_hueco_horas, 3);
  assert.equal(C.umbral_drift_pts, 5);
  assert.deepEqual(C.tramos_p24.map((x) => [...x]), [[0, 30], [30, 50], [50, 70], [70, 100]]);
  assert.equal(C.apuesta_usd, 1);
  assert.equal(C.costo_por_operacion_usd, 0.02);
  assert.equal(C.logit_clip, 0.01);
  assert.equal(C.min_n_delta, 150);
  assert.equal(C.t_go, 2.5);
  assert.equal(C.t_fragil, 2);
  assert.match(C.hipotesis_previa, /NO-GO o INCONCLUSO/);
  assert.equal(Object.keys(C).length, 14, 'nadie agregó un criterio en silencio');
  assert.deepEqual({ ...L.VENTANA_DESCARGA }, { dias_antes: 4, dias_despues: 1 });
});

test('mismo umbral de liquidez que Fase 2', async () => {
  const { CRITERIOS_F2 } = await import('../api/_lib/earnings-beat-analyze.js');
  assert.equal(C.min_volumen_usd, CRITERIOS_F2.min_volumen_usd);
});

// ═══════════════════ 2. hora del reporte ═══════════════════

test('hora del Este → UTC, con horario de verano', () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(iso(L.etAUtcMs('2026-10-21', '16:00')), '2026-10-21T20:00:00.000Z', 'EDT');
  assert.equal(iso(L.etAUtcMs('2026-01-15', '16:00')), '2026-01-15T21:00:00.000Z', 'EST');
  assert.equal(iso(L.etAUtcMs('2026-11-02', '07:00')), '2026-11-02T12:00:00.000Z', 'día siguiente al fin del verano (1-nov-2026)');
  assert.equal(iso(L.etAUtcMs('2026-10-30', '07:00')), '2026-10-30T11:00:00.000Z');
  assert.equal(iso(L.etAUtcMs('2026-03-06', '07:00')), '2026-03-06T12:00:00.000Z', 'antes del 8-mar-2026');
  assert.equal(iso(L.etAUtcMs('2026-03-09', '07:00')), '2026-03-09T11:00:00.000Z', 'después del 8-mar-2026');
  assert.equal(iso(L.etAUtcMs('2025-07-01', '12:00')), '2025-07-01T16:00:00.000Z');
});

test('mercado SIN HORA → AMC 16:00 ET, marcado como imputado', () => {
  const sin = L.horaDelReporte('2026-10-21', null);
  assert.equal(sin.hora_efectiva, 'amc');
  assert.equal(sin.imputada, true);
  assert.equal(new Date(sin.ms).toISOString(), '2026-10-21T20:00:00.000Z');
  const raro = L.horaDelReporte('2026-10-21', 'xyz');
  assert.equal(raro.hora_efectiva, 'amc');
  assert.equal(raro.imputada, true);
  const bmo = L.horaDelReporte('2026-10-21', 'BMO');
  assert.equal(bmo.hora_efectiva, 'bmo');
  assert.equal(bmo.imputada, false);
  assert.equal(new Date(bmo.ms).toISOString(), '2026-10-21T11:00:00.000Z');
});

// ═══════════════════ 3. precio en cada hora ═══════════════════

test('precio: el punto ANTERIOR más cercano; nunca uno posterior', () => {
  const T = Date.parse('2026-10-20T20:00:00Z');
  const pts = L.normalizaPuntos([
    { t: (T - 5 * H) / 1000, p: 0.40 }, { t: (T - 1 * H) / 1000, p: 0.45 }, { t: (T + 10 * 60 * 1000) / 1000, p: 0.90 },
  ]);
  const r = L.precioEn(pts, T);
  assert.equal(r.precio, 0.45);
  assert.equal(r.hueco_horas, 1);
  const exacto = L.precioEn(L.normalizaPuntos([{ t: T, p: 0.3 }, { t: T + 1, p: 0.99 }]), T);
  assert.equal(exacto.precio, 0.3, 'un punto justo en la hora vale');
});

test('PUNTO FALTANTE a > 3h → faltante; a 3h exactas vale', () => {
  const T = Date.parse('2026-10-20T20:00:00Z');
  const lejos = L.precioEn(L.normalizaPuntos([{ t: T - 3 * H - 60000, p: 0.5 }, { t: T + H, p: 0.6 }]), T);
  assert.equal(lejos.precio, null);
  assert.equal(lejos.motivo, 'hueco_mayor_3h');
  const justo = L.precioEn(L.normalizaPuntos([{ t: T - 3 * H, p: 0.5 }]), T);
  assert.equal(justo.precio, 0.5);
  assert.equal(L.precioEn(L.normalizaPuntos([{ t: T + H, p: 0.5 }]), T).motivo, 'sin_punto_anterior');
  assert.equal(L.precioEn([], T).motivo, 'sin_historial');

  // En una observación: T-72h faltante → sin Δ, pero p24 y p2 siguen.
  const m = { market_id: 'x', fecha: '2026-10-20', reporte_ms: T, y: 1, hora_efectiva: 'amc', hora_imputada: false };
  const pts = [{ t: T - 80 * H, p: 0.2 }, { t: T - 24 * H, p: 0.5 }, { t: T - 2 * H, p: 0.6 }];
  const o = L.observacion(m, L.normalizaPuntos(pts));
  assert.equal(o.p72, null);
  assert.equal(o.motivo72, 'hueco_mayor_3h');
  assert.equal(o.d, null);
  assert.equal(o.p24, 0.5);
  assert.ok(Math.abs(o.d2 - 10) < 1e-9);
});

test('EMPATE de precios: mismo timestamp → gana el último; Δ = +5 exacto cuenta como sube', () => {
  const T = Date.parse('2026-10-20T20:00:00Z');
  const pts = L.normalizaPuntos([{ t: T - H, p: 0.40 }, { t: T - H, p: 0.42 }, { t: (T - 2 * H) / 1000, p: 0.1 }]);
  assert.equal(pts.length, 2, 'un solo punto por timestamp');
  assert.equal(L.precioEn(pts, T).precio, 0.42);
  assert.equal(L.normalizaPuntos([{ t: T, p: 1.2 }, { t: T, p: -0.1 }, { t: 'x', p: 0.5 }]).length, 0, 'basura fuera');

  // Frontera del umbral: Δ = +5 y −5 operan; Δ = 0 (precios empatados) no.
  const base = { fecha: '2026-01-01', y: 1, p72: 0.5, p2: null, d2: null, hora_imputada: false };
  const obs = [
    { ...base, market_id: 'a', p24: 0.55, d: 5 },
    { ...base, market_id: 'b', p24: 0.45, d: -5, y: 0 },
    { ...base, market_id: 'c', p24: 0.50, d: 0 },
    { ...base, market_id: 'd', p24: 0.549, d: 4.9 },
  ];
  const s = L.simulacion(obs);
  assert.equal(s.operaciones, 2);
  assert.equal(s.compra_yes, 1);
  assert.equal(s.compra_no, 1);
  const tr = L.tablaTramos(obs);
  assert.equal(tr[2].sube.n, 1, 'p24 = 55 cae en 50-70');
  assert.equal(tr[1].baja.n, 1, 'p24 = 45 cae en 30-50');
  assert.equal(tr[2].n, 3, 'Δ = 0 y Δ = 4.9 entran al tramo pero no a sube/baja');
});

// ═══════════════════ 4. universo ═══════════════════

test('universo: unión sin duplicados, NO RESUELTO excluido, liquidez, sin fecha', () => {
  const f = (id, extra = {}) => ({ market_id: id, symbol: 'AAA', report_date: '2026-10-20', outcome: 'yes', volume: 1000,
    yes_token_id: 'tok' + id, cosecha: 'v2', hour: 'bmo', ...extra });
  const u = L.construyeUniverso([
    f('1'),
    f('1', { cosecha: 'v1', outcome: 'no' }),          // duplicado de v1: gana v2
    f('2', { outcome: null }),                          // NO RESUELTO
    f('3', { outcome: 'Unresolved' }),                  // tampoco
    f('4', { volume: 499.99 }),                         // liquidez
    f('5', { volume: null }),
    f('6', { yes_token_id: null }),
    f('7', { report_date: null }),                      // sin fecha: NO se usa la resolución
    f('8', { outcome: 'No', volume: 500, hour: null }), // umbral exacto + sin hora
  ]);
  assert.deepEqual(u.excluidos, { duplicado: 1, no_resuelto: 2, liquidez: 2, sin_token: 1, sin_fecha_reporte: 1 });
  assert.deepEqual(u.universo.map((m) => m.market_id), ['1', '8']);
  assert.equal(u.universo[0].cosecha, 'v2');
  assert.equal(u.universo[0].y, 1);
  assert.equal(u.universo[1].y, 0);
  assert.equal(u.universo[1].hora_imputada, true);
  assert.equal(u.universo[1].hora_efectiva, 'amc');
});

// ═══════════════════ 5. logística == statsmodels ═══════════════════

test('logística con errores agrupados reproduce statsmodels (CR1)', () => {
  const r = rng(7);
  const X = [], y = [], g = [];
  for (let i = 0; i < 120; i++) {
    const a = (r() - 0.5) * 4, b = (r() - 0.5) * 20;
    X.push([a, b]); y.push(r() < sig(0.3 + 0.9 * a + 0.05 * b) ? 1 : 0); g.push('d' + (i % 37));
  }
  const m = L.logistica(X, y, g);
  // statsmodels 0.15: Logit(y, add_constant(X)).fit(cov_type='cluster', groups=g)
  const coef = [0.4234137518395587, 1.4667760591393995, 0.08409717450132313];
  const se = [0.2512279996832571, 0.26436039108946696, 0.04339162748897997];
  assert.equal(m.convergio, true);
  assert.equal(m.grupos, 37);
  for (let j = 0; j < 3; j++) {
    assert.ok(Math.abs(m.coef[j] - coef[j]) < 1e-8, `coef[${j}] ${m.coef[j]}`);
    assert.ok(Math.abs(m.se[j] - se[j]) < 1e-8, `se[${j}] ${m.se[j]}`);
  }
});

test('logística: separación perfecta y un solo grupo no dan número', () => {
  const X = [[-2], [-1], [1], [2]], y = [0, 0, 1, 1];
  assert.equal(L.logistica(X, y, ['a', 'b', 'c', 'd']).convergio, false);
  const r = rng(1);
  const X2 = Array.from({ length: 40 }, () => [r()]);
  const y2 = X2.map(() => (r() < 0.5 ? 1 : 0));
  const u = L.logistica(X2, y2, X2.map(() => 'mismo-dia'));
  assert.equal(u.convergio, false);
  assert.equal(u.motivo, 'un_solo_grupo');
});

// ═══════════════════ 6. piezas + veredicto ═══════════════════

test('simulación: $1 al precio p24 menos 2 centavos', () => {
  const o = (d, p24, y) => ({ market_id: 'x', fecha: '2026-01-01', d, p24, y });
  const s = L.simulacion([o(10, 0.5, 1), o(-10, 0.4, 1), o(6, 0.8, 0)]);
  // +1 (gana Yes a 0.5) −1 (pierde No a 0.6) −1 (pierde Yes a 0.8) − 3·0.02
  assert.equal(s.bruto_usd, -1);
  assert.equal(s.costos_usd, 0.06);
  assert.equal(s.neto_usd, -1.06);
  assert.equal(s.aciertos, 1);
});

test('mitades por fecha mediana: ≤ mediana / > mediana', () => {
  const obs = ['2026-01-01', '2026-01-02', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map((fecha, i) =>
    ({ market_id: 'm' + i, fecha, d: 1, p24: 0.5, y: 1 }));
  const m = L.mitades([...obs, { market_id: 'sinD', fecha: '2026-01-09', d: null, p24: 0.5, y: 1 }]);
  assert.equal(m.mediana, '2026-01-02');
  assert.equal(m.antes.length, 3);
  assert.equal(m.despues.length, 3);
});

test('calibración por deciles y Brier', () => {
  const obs = Array.from({ length: 20 }, (_, i) => ({ p24: (i + 0.5) / 20, y: i % 2 }));
  const c = L.calibracion(obs);
  assert.equal(c.n, 20);
  assert.equal(c.deciles.length, 10);
  assert.ok(c.deciles.every((d) => d.n === 2));
  const brier = obs.reduce((s, o) => s + (o.p24 - o.y) ** 2, 0) / 20;
  assert.ok(Math.abs(c.brier - brier) < 1e-6);
});

test('veredicto: cada frontera', () => {
  const reg = (coef, t) => ({ convergio: true, coef, t });
  const mitad = (coef, neto) => ({ regresion: reg(coef, 1), simulacion: { neto_usd: neto } });
  const base = { n_delta: 150, regresion: reg(0.02, 2.5), mitad_antes: mitad(0.01, 1), mitad_despues: mitad(0.03, 0.5) };
  assert.equal(L.veredicto(base).veredicto, 'GO');
  assert.equal(L.veredicto({ ...base, n_delta: 149 }).veredicto, 'INCONCLUSO');
  assert.equal(L.veredicto({ ...base, regresion: reg(0.02, 2.49) }).veredicto, 'GO FRÁGIL');
  assert.equal(L.veredicto({ ...base, regresion: reg(0.02, 2) }).veredicto, 'GO FRÁGIL');
  assert.equal(L.veredicto({ ...base, regresion: reg(0.02, 1.99) }).veredicto, 'NO-GO');
  assert.equal(L.veredicto({ ...base, regresion: reg(-0.02, -3) }).veredicto, 'NO-GO');
  assert.equal(L.veredicto({ ...base, mitad_antes: mitad(-0.01, 1) }).veredicto, 'NO-GO');
  assert.equal(L.veredicto({ ...base, mitad_despues: mitad(0.01, 0) }).veredicto, 'NO-GO', 'neto = 0 no es > 0');
  assert.equal(L.veredicto({ ...base, mitad_despues: mitad(0.01, -0.1) }).veredicto, 'NO-GO');
  assert.equal(L.veredicto({ ...base, regresion: { convergio: false, motivo: 'separacion' } }).veredicto, 'NO-GO');
});

// ═══════════════════ 7. cadena completa ═══════════════════

test('drift plantado (el precio sub-reacciona) → GO', () => {
  const fx = fabrica({ n: 600, modo: 'drift', semilla: 5 });
  const r = L.corre(fx);
  assert.equal(r.cobertura.con_3_precios, 600);
  assert.equal(r.n_delta, 600);
  assert.ok(r.regresion.coef > 0 && r.regresion.t >= 2.5, JSON.stringify(r.regresion));
  assert.equal(r.estado, 'GO', r.motivo);
  assert.equal(r.cobertura.sin_hora_imputada_amc, 200);
});

test('precio calibrado (Δ no agrega nada) → NO-GO', () => {
  const fx = fabrica({ n: 600, modo: 'nulo', semilla: 9 });
  const r = L.corre(fx);
  assert.equal(r.n_delta, 600);
  assert.ok(Math.abs(r.regresion.t) < 2.5, JSON.stringify(r.regresion));
  assert.notEqual(r.estado, 'GO');
  assert.notEqual(r.estado, 'GO FRÁGIL');
  assert.equal(r.estado, 'NO-GO');
});

test('muestra corta → INCONCLUSO', () => {
  const r = L.corre(fabrica({ n: 120, modo: 'drift' }));
  assert.equal(r.estado, 'INCONCLUSO');
});

test('cero puntos del CLOB → FALLA DE FRONTERA, nunca veredicto', () => {
  const fx = fabrica({ n: 200 });
  for (const k of fx.puntosPorId.keys()) fx.puntosPorId.set(k, []);
  const r = L.corre(fx);
  assert.equal(r.estado, 'FALLA DE FRONTERA');
  assert.equal(r.regresion, undefined);
  const vacio = L.corre({ universo: [], puntosPorId: new Map(), estados: new Map() });
  assert.equal(vacio.estado, 'FALLA DE FRONTERA');
  // todos con error de descarga, cero puntos
  const fx2 = fabrica({ n: 200 });
  for (const k of fx2.estados.keys()) fx2.estados.set(k, 'error');
  assert.equal(L.corre(fx2).estado, 'FALLA DE FRONTERA');
});

test('descargas pendientes → COBERTURA INCOMPLETA, sin veredicto', () => {
  const fx = fabrica({ n: 200, modo: 'drift' });
  fx.estados.delete('m0');
  const r = L.corre(fx);
  assert.equal(r.estado, 'COBERTURA INCOMPLETA');
  assert.equal(r.cobertura.pendiente_descarga, 1);
  assert.equal(r.regresion, undefined);
});

test('markdown: resultado completo y modo cobertura', () => {
  const r = L.corre(fabrica({ n: 300, modo: 'drift' }));
  delete r.obs;
  const md = L.renderResumenMarkdown({ generado_en: 'x', criterios: C, universo: { filas: 300, excluidos: { duplicado: 0, no_resuelto: 0, liquidez: 0, sin_token: 0, sin_fecha_reporte: 0 } }, resultado: r });
  for (const s of ['## a) Regresión', '## b) Tasa de Yes', '## c) Simulación', '## d) Fuera de muestra', '## e) Calibración', 'Secundario', 'Con los 3 precios']) {
    assert.ok(md.includes(s), s);
  }
  const mdC = L.renderResumenMarkdown({ generado_en: 'x', solo_cobertura: true, universo: {}, resultado: { estado: 'COBERTURA LISTA', cobertura: r.cobertura } });
  assert.ok(mdC.includes('Con los 3 precios'));
  assert.ok(!mdC.includes('## a) Regresión'));
});

// ═══════════════════ 8. descarga ═══════════════════

test('bajaHistoriales: ventana, fallback, error registrado, 429 corta', async () => {
  const fecha = '2026-10-20';
  const v = L.ventanaDescarga(fecha);
  const llamadas = [];
  const guardados = [];
  const respuestas = {
    a: [{ status: 'ok', body: { history: [{ t: (v.desdeMs - H) / 1000, p: 0.1 }, { t: (v.desdeMs + H) / 1000, p: 0.5 }, { t: v.hastaMs / 1000, p: 0.9 }] } }],
    b: [{ status: 'ok', body: { history: [] } }, { status: 'ok', body: { history: [{ t: (v.desdeMs + 2 * H) / 1000, p: 0.3 }] } }],
    c: [{ status: 'httperror', http: 500 }, { status: 'httperror', http: 500 }],
    d: [{ status: 'ratelimit', http: 429 }],
    e: [{ status: 'ok', body: { history: [{ t: (v.desdeMs + H) / 1000, p: 0.5 }] } }],
  };
  const clob = async (path, params) => {
    llamadas.push({ path, ...params });
    return respuestas[params.market].shift();
  };
  const pend = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ market_id: 'M' + k, token: k, fecha }));
  const res = await L.bajaHistoriales(pend, { clob, guarda: async (x) => guardados.push(x), concurrencia: 4, pausaMs: 0 });
  assert.equal(llamadas[0].path, '/prices-history');
  assert.equal(llamadas[0].fidelity, 60);
  assert.equal(llamadas[0].startTs, v.desdeMs / 1000);
  assert.equal(llamadas[0].endTs, v.hastaMs / 1000);
  assert.equal(res.ratelimit, true);
  assert.equal(res.por_presupuesto, 1, "'e' queda para la próxima corrida");
  assert.ok(!llamadas.some((x) => x.market === 'e'), 'después de un 429 no se pide nada más');
  assert.deepEqual(guardados.map((g) => g.market_id), ['Ma', 'Mb', 'Mc'], 'el 429 no se registra: se reintenta');
  assert.deepEqual(guardados[0].puntos.map((p) => p.p), [0.5], 'solo puntos dentro de [desde, hasta)');
  assert.equal(guardados[1].forma, 'interval=max');
  assert.equal(guardados[1].puntos.length, 1);
  assert.equal(guardados[2].estado, 'error');
  assert.equal(guardados[2].http, 500);
});

test('bajaHistoriales: el presupuesto de tiempo corta y deja el resto', async () => {
  let reloj = 0;
  const pend = Array.from({ length: 10 }, (_, i) => ({ market_id: 'M' + i, token: 't' + i, fecha: '2026-10-20' }));
  const res = await L.bajaHistoriales(pend, {
    clob: async () => { reloj += 1000; return { status: 'ok', body: { history: [] } }; },
    guarda: async () => {}, concurrencia: 2, pausaMs: 0, presupuestoMs: 3500, ahora: () => reloj,
  });
  assert.ok(res.por_presupuesto > 0 && res.intentados + res.por_presupuesto === 10, JSON.stringify(res));
});

// ═══════════════════ 9. endpoint ═══════════════════

function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.text = s; return this; },
    end() { return this; } };
}
const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

// Neon + CLOB falsos. Guarda lo escrito en pm_price_hist para servirlo luego.
function mockRed({ n = 200, modo = 'drift', clobCaido = false } = {}) {
  const fx = fabrica({ n, modo, semilla: 21 });
  const filas = fx.universo.map((m) => [m.market_id, m.symbol, m.fecha, m.y ? 'yes' : 'no', '1000', m.token, 'v2', '0', m.hora]);
  filas.push(['abierto', 'ZZZ', '2026-10-20', null, '5000', 'tz', 'v1', '1', 'amc']);   // no resuelto
  const porToken = new Map(fx.universo.map((m) => [m.token, fx.puntosPorId.get(m.market_id)]));
  const db = { estados: new Map(), puntos: new Map() };
  const queries = [];
  const clobLlamadas = [];
  const fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      const results = [];
      for (const q of body.queries || [body]) {
        queries.push(q.query);
        const s = q.query.trim();
        let fields = [], rows = [];
        if (/^insert into pm_price_hist \(/.test(s)) {
          const p = q.params;
          for (let i = 0; i < p.length; i += 3) {
            if (!db.puntos.has(p[i])) db.puntos.set(p[i], new Map());
            db.puntos.get(p[i]).set(Date.parse(p[i + 1]), p[i + 2]);
          }
        } else if (/^insert into pm_price_hist_fetch/.test(s)) {
          db.estados.set(q.params[0], q.params[2]);
        } else if (/pm_earnings_markets_v2/.test(s)) {
          fields = ['market_id', 'symbol', 'report_date', 'outcome', 'volume', 'yes_token_id', 'cosecha', 'orden', 'hour']
            .map((name) => ({ name, dataTypeID: ['volume', 'orden'].includes(name) ? 1700 : 25 }));
          rows = filas;
        } else if (/from pm_price_hist_fetch/.test(s)) {
          fields = [{ name: 'market_id', dataTypeID: 25 }, { name: 'estado', dataTypeID: 25 }];
          rows = [...db.estados].map(([k, v]) => [k, v]);
        } else if (/from pm_price_hist /.test(s)) {
          fields = [{ name: 'market_id', dataTypeID: 25 }, { name: 't', dataTypeID: 20 }, { name: 'p', dataTypeID: 1700 }];
          for (const id of q.params) for (const [t, p] of db.puntos.get(id) || []) rows.push([id, String(t), String(p)]);
        }
        results.push({ fields, rows });
      }
      const out = body.queries ? { results } : results[0];
      return { ok: true, status: 200, json: async () => out };
    }
    if (u.includes('clob.polymarket.com')) {
      const market = new URL(u).searchParams.get('market');
      clobLlamadas.push(market);
      if (clobCaido) return { ok: false, status: 503, headers: new Headers(), text: async () => 'caído' };
      const pts = porToken.get(market) || [];
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ history: pts.map((p) => ({ t: p.t / 1000, p: p.p })) }) };
    }
    throw new Error('red inesperada: ' + u);
  };
  return { fetch, queries, clobLlamadas, db, fx };
}

test('endpoint: gate del CRON_SECRET', async () => {
  const red = mockRed({ n: 10 });
  globalThis.fetch = red.fetch;
  const a = mockRes();
  await handler(GET({}), a);
  assert.equal(a.code, 401);
  assert.equal(red.queries.length, 0, 'un 401 no toca la DB');
  const b = mockRes();
  await handler(GET({ secret: 'mal' }), b);
  assert.equal(b.code, 401);
  const c = mockRes();
  await handler({ method: 'POST', query: { secret: SECRET }, headers: {} }, c);
  assert.equal(c.code, 405);
});

test('endpoint: cobertura → baja, guarda, no vuelve a pedir; resultado completo', async () => {
  const red = mockRed({ n: 200, modo: 'drift' });
  globalThis.fetch = red.fetch;

  const cob = mockRes();
  await handler(GET({ solo: 'cobertura', format: 'md' }, { authorization: `Bearer ${SECRET}` }), cob);
  assert.equal(cob.code, 200, cob.body && cob.body.error);
  assert.equal(cob.headers['Cache-Control'], 'no-store');
  assert.match(cob.text, /COBERTURA LISTA/);
  assert.match(cob.text, /Con los 3 precios \(T-72h, T-24h, T-2h\): \*\*200\*\*/);
  assert.match(cob.text, /no resueltos 1/);
  assert.ok(!/## a\) Regresión/.test(cob.text), 'cobertura no da resultados');
  assert.equal(red.clobLlamadas.length, 200);

  // Solo se escribe en las tablas nuevas; sobre v1/v2/pead_event_hour, SELECT.
  for (const q of red.queries) {
    const s = q.trim().toLowerCase();
    if (/^(insert|update|delete|alter|drop|truncate)/.test(s)) assert.match(s, /^insert into pm_price_hist(_fetch)? /, q.slice(0, 80));
    else if (/^create/.test(s)) assert.match(s, /^create table if not exists pm_price_hist(_fetch)? /);
    else assert.match(s, /^select/);
  }

  const n0 = red.clobLlamadas.length;
  const full = mockRes();
  await handler(GET({ secret: SECRET, obs: '1' }), full);
  assert.equal(full.code, 200, full.body && full.body.error);
  assert.equal(red.clobLlamadas.length, n0, 'lo ya bajado no se vuelve a pedir');
  assert.equal(full.body.veredicto, 'GO');
  assert.equal(full.body.resultado.n_delta, 200);
  assert.equal(full.body.obs.length, 200);
  assert.equal(full.body.universo.excluidos.no_resuelto, 1);
});

test('endpoint: CLOB caído → FALLA DE FRONTERA, nunca veredicto', async () => {
  const red = mockRed({ n: 30, clobCaido: true });
  globalThis.fetch = red.fetch;
  const r = mockRes();
  await handler(GET({ secret: SECRET }), r);
  assert.equal(r.code, 200, r.body && r.body.error);
  assert.equal(r.body.veredicto, 'FALLA DE FRONTERA');
  assert.equal(r.body.resultado.cobertura.error_descarga, 30);
});

// ═══════════════════ 10. Postgres real ═══════════════════

const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
function literal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function incrusta(query, params = []) {
  let q = query;
  for (let i = params.length; i >= 1; i--) q = q.split('$' + i).join(literal(params[i - 1]));
  return q;
}

test('docs/sql/pm-drift.sql == SCHEMA; no toca v1/v2', () => {
  const archivo = readFileSync(new URL('../docs/sql/pm-drift.sql', import.meta.url), 'utf8');
  const sentencias = norm(archivo).split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(sentencias, L.SCHEMA.map(norm));
  for (const q of L.SCHEMA) assert.ok(!/pm_earnings_markets/.test(q));
});

test('contra Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = SIN_POSTGRES ? null : binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55451 });
  for (const q of SCHEMA_V1) psql(q + ';');
  for (const q of SCHEMA_V1) psql(q.replace(/pm_earnings_markets/g, 'pm_earnings_markets_v2') + ';');
  for (const q of PEAD_SCHEMA) psql(q + ';');
  for (const q of L.SCHEMA) psql(q + ';');
  for (const q of L.SCHEMA) psql(q + ';');   // idempotente

  psql(`insert into pm_earnings_markets (market_id, symbol, filtro_motivo, report_date, outcome, volume, yes_token_id) values
          ('1', 'AAA', 'ok', '2026-10-20', 'no', 900, 'v1tok'),
          ('2', 'BBB', 'ok', '2026-10-21', 'yes', 800, 'tok2');
        insert into pm_earnings_markets_v2 (market_id, symbol, filtro_motivo, report_date, outcome, volume, yes_token_id) values
          ('1', 'AAA', 'ok', '2026-10-20', 'yes', 1000, 'v2tok'),
          ('3', 'CCC', 'ok', null, 'yes', 1000, 'tok3');
        insert into pead_event_hour (symbol, reported_date, hour, source) values ('AAA', '2026-10-20', 'bmo', 'sec_8k');`);
  const filas = psql(SQL_A_TEXTO(L.SQL_UNIVERSO)).trim().split('\n');
  assert.deepEqual(filas, ['1|AAA|2026-10-20|yes|v2tok|v2|bmo', '3|CCC||yes|tok3|v2|', '2|BBB|2026-10-21|yes|tok2|v1|'],
    'v2 primero, v1 solo lo que v2 no tiene, hora por (symbol, fecha)');

  const ins = L.sqlInsertPuntos('1', [{ t: Date.parse('2026-10-19T20:00:00Z'), p: 0.4 }, { t: Date.parse('2026-10-19T21:00:00Z'), p: 0.5 }]);
  psql(incrusta(ins.query, ins.params) + ';');
  const otra = L.sqlInsertPuntos('1', [{ t: Date.parse('2026-10-19T21:00:00Z'), p: 0.55 }]);
  psql(incrusta(otra.query, otra.params) + ';');
  assert.equal(psql(`select count(*), max(price) from pm_price_hist where market_id = '1';`).trim(), '2|0.55', 'ON CONFLICT: el último gana');

  const pts = psql(incrusta(L.sqlPuntos(2), ['1', '9']) + ';').trim().split('\n');
  assert.deepEqual(pts, [`1|${Date.parse('2026-10-19T20:00:00Z')}|0.4`, `1|${Date.parse('2026-10-19T21:00:00Z')}|0.55`]);

  const reg = (estado, n) => { const r = L.sqlRegistraDescarga({ market_id: '1', token: 'v2tok', estado, puntos: Array(n).fill(0), http: 200, forma: 'startTs/endTs', desdeMs: 0, hastaMs: 1 }); psql(incrusta(r.query, r.params) + ';'); };
  reg('error', 0);
  reg('ok', 2);
  reg('error', 0);
  assert.equal(psql(`select estado, puntos from pm_price_hist_fetch where market_id = '1';`).trim(), 'ok|2', "un 'ok' no se degrada");
  assert.equal(psql(L.SQL_ESTADOS + ';').trim(), '1|ok');
});

// SQL_UNIVERSO con columnas fijas para comparar texto.
function SQL_A_TEXTO(q) {
  return `select market_id, symbol, coalesce(report_date, ''), outcome, yes_token_id, cosecha, coalesce(hour, '') from (${q}) x;`;
}
