// ═══════════════════════════════════════════════════════════════════════
// Tests de PM-CENTAVOS (api/_lib/pm-centavos-analyze.js + /api/pm-centavos-analyze).
//
//   1. Criterios PINEADOS valor por valor (pre-registro) y alineados con
//      PM-DRIFT donde comparten regla (liquidez, T-24h, hueco, logit, costo).
//   2. Lectura: consenso SOLO de la descripción (plantilla nueva, "consensus"
//      cercano, negativos "-$", "$-", "($)"); barra del slug o la pregunta.
//   3. gap en centavos: EMPATE EXACTO con ruido de coma flotante, mitades,
//      CONSENSO NEGATIVO, nunca −0; tramos ≤−4 … ≥+4.
//   4. Universo: unión sin duplicados (gana v2), no resuelto, liquidez,
//      SIN CONSENSO EXCLUIDO (aunque consensus_pm esté lleno), sin barra.
//   5. p24 a T-24h de la hora del reporte (regla de PM-DRIFT).
//   6. Tabla, regresión (codificación, base gap ≤ −2), simulación a mano,
//      mitades, cada frontera del veredicto.
//   7. Cadena completa: efecto plantado → GO; precio calibrado → NO-GO;
//      N(gap=0) < 40 → INCONCLUSO; cero puntos / pendientes → sin veredicto.
//   8. Endpoint: gate, reusa la caché de PM-DRIFT, solo SELECT sobre v1/v2.
//   9. Postgres real: SQL_UNIVERSO corre y lee la descripción de raw.
//
// Correr con `node tests/pm-centavos-analyze.test.mjs`.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const L = await import('../api/_lib/pm-centavos-analyze.js');
const D = await import('../api/_lib/pm-drift-analyze.js');
const { default: handler } = await import('../api/pm-centavos-analyze.js');
const { SCHEMA: SCHEMA_V1 } = await import('../api/_lib/earnings-beat-db.js');
const { PEAD_SCHEMA } = await import('../api/_lib/pead-db.js');

const H = 3600 * 1000;
const C = L.CRITERIOS_PM_CENTAVOS;

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
const slugDe = (sym, b) => `${sym.toLowerCase()}-quarterly-earnings-nongaap-eps-11-04-2026-${b < 0 ? 'neg-' : ''}${Math.abs(b).toFixed(2).replace('.', 'pt')}`;
const descDe = (c) => `This market will resolve to "Yes" if the company reports non-GAAP EPS greater than the listed value. The Street consensus estimate for the company’s non-GAAP EPS for the relevant quarter is ${c < 0 ? '-' : ''}$${Math.abs(c).toFixed(2)} as of market creation.`;

// Fila cruda como la devuelve SQL_UNIVERSO.
function fila({ id, sym = 'AAA', barra, consenso, fecha = '2026-11-04', outcome = 'no', volume = 1000, token, hour = 'amc', cosecha = 'v2', desc, question = null }) {
  return { market_id: id, symbol: sym, slug: barra === undefined ? null : slugDe(sym, barra), question,
    descripcion: desc !== undefined ? desc : consenso === undefined ? 'Resolves Yes if EPS beats.' : descDe(consenso),
    report_date: fecha, outcome, volume, yes_token_id: token === undefined ? 'tok-' + id : token, cosecha, hour };
}

// Precio constante p en toda la ventana de descarga de PM-DRIFT, por hora.
function caminoConstante(fecha, p) {
  const v = D.ventanaDescarga(fecha);
  const pts = [];
  for (let t = v.desdeMs; t < v.hastaMs; t += H) pts.push({ t, p });
  return pts;
}

// Gaps: la mitad en 0 (Polymarket suele poner la barra en el consenso).
const GAPS = [0, 0, 0, 0, 0, -1, -1, -2, -3, -5, 1, 1, 2, 3, 6];
// modo 'centavos': en gap = 0 el Yes sale MENOS que lo que dice el precio
// (las empresas aterrizan en el consenso y el empate es No); en gap ≤ −1 sale
// más. modo 'nulo': y ~ Bernoulli(p24).
function fabrica({ n = 600, modo = 'nulo', semilla = 7, desde = '2025-01-06', sinBase = false } = {}) {
  const r = rng(semilla);
  const filas = [];
  const puntosPorToken = new Map();
  const ys = [];
  for (let i = 0; i < n; i++) {
    const fecha = fechaMas(desde, Math.floor(i / 3));
    let gap = GAPS[i % GAPS.length];
    if (sinBase && gap <= -2) gap = -1;
    const consenso = Number((0.2 + r() * 2).toFixed(2));
    const barra = Number((consenso + gap / 100).toFixed(2));
    const p24 = Number((0.3 + r() * 0.65).toFixed(4));
    let q = p24;
    if (modo === 'centavos') q = gap === 0 ? sig(lg(p24) - 1.3) : gap <= -1 ? sig(lg(p24) + 1.3) : p24;
    const y = r() < q ? 1 : 0;
    ys.push(y);
    const id = 'm' + i;
    filas.push(fila({ id, sym: 'S' + (i % 40), barra, consenso, fecha, outcome: y ? 'yes' : 'no', hour: ['bmo', 'amc', null][i % 3] }));
    puntosPorToken.set('tok-' + id, caminoConstante(fecha, p24));
  }
  return { filas, puntosPorToken };
}

function preparado(fx) {
  const u = L.construyeUniverso(fx.filas);
  const puntosPorId = new Map(u.universo.map((m) => [m.market_id, fx.puntosPorToken.get(m.token) || []]));
  const estados = new Map(u.universo.map((m) => [m.market_id, 'ok']));
  return { u, puntosPorId, estados };
}

// ═══════════════════ 1. criterios pineados ═══════════════════

test('criterios congelados: cada valor pineado', () => {
  assert.ok(Object.isFrozen(C));
  assert.equal(C.min_volumen_usd, 500);
  assert.equal(C.gap_tope, 4);
  assert.equal(C.horas_antes_precio, 24);
  assert.equal(C.max_hueco_horas, 3);
  assert.equal(C.logit_clip, 0.01);
  assert.equal(C.sim_no_si_gap, 0);
  assert.equal(C.sim_no_p24_min, 0.70);
  assert.equal(C.sim_yes_si_gap_max, -1);
  assert.equal(C.sim_yes_p24_max, 0.70);
  assert.equal(C.apuesta_usd, 1);
  assert.equal(C.costo_por_operacion_usd, 0.02);
  assert.equal(C.min_n_gap0, 40);
  assert.equal(C.t_go, 2.5);
  assert.equal(C.t_fragil, 2);
  assert.match(C.hipotesis_previa, /gap = 0.*POR DEBAJO del precio/);
  assert.equal(Object.keys(C).length, 15, 'nadie agregó un criterio en silencio');
  assert.deepEqual([...L.VARIABLES], ['logit_p24', 'gap0', 'gap_m1', 'gap_pos']);
});

test('misma regla que PM-DRIFT donde la comparten', () => {
  const P = D.CRITERIOS_PM_DRIFT;
  assert.equal(C.min_volumen_usd, P.min_volumen_usd);
  assert.equal(C.horas_antes_precio, P.horas_antes.t24);
  assert.equal(C.max_hueco_horas, P.max_hueco_horas);
  assert.equal(C.logit_clip, P.logit_clip);
  assert.equal(C.apuesta_usd, P.apuesta_usd);
  assert.equal(C.costo_por_operacion_usd, P.costo_por_operacion_usd);
});

// ═══════════════════ 2. lectura de consenso y barra ═══════════════════

test('consenso: solo lo que la descripción declara como consenso', () => {
  const c = L.consensoDeDescripcion;
  assert.deepEqual(c(descDe(0.90)), { valor: 0.9, patron: 'plantilla' });
  assert.deepEqual(c('The Street consensus estimate for ON Semiconductor’s non-GAAP EPS for the relevant quarter is $0.90 as of market creation.'), { valor: 0.9, patron: 'plantilla' });
  assert.deepEqual(c('Analyst consensus EPS of $1.20 per share.'), { valor: 1.2, patron: 'consensus_monto' });
  // Negativos: las cuatro formas.
  assert.equal(c(descDe(-0.05)).valor, -0.05);
  assert.equal(c('The Street consensus estimate for X’s GAAP EPS for the relevant quarter is $-0.12 as of market creation.').valor, -0.12);
  assert.equal(c('The consensus estimate is -$0.05.').valor, -0.05);
  assert.equal(c('The consensus estimate is ($0.07).').valor, -0.07, 'notación contable, como el lector v1');
  // Un monto que no está pegado a "consensus" NO es consenso (suele ser la barra).
  assert.equal(c('Resolves Yes if EPS is greater than $1.20. The estimate is $1.20.'), null);
  assert.equal(c(''), null);
  assert.equal(c(null), null);
});

test('barra: slug primero, pregunta de respaldo, nunca la descripción', () => {
  assert.deepEqual(L.barraDelMercado({ slug: 'fnf-quarterly-earnings-nongaap-eps-11-05-2026-1pt33' }), { valor: 1.33, fuente: 'slug' });
  assert.deepEqual(L.barraDelMercado({ slug: 'x-quarterly-earnings-gaap-eps-11-05-2026-neg-0pt03' }), { valor: -0.03, fuente: 'slug' });
  assert.deepEqual(L.barraDelMercado({ slug: 'sin-umbral', question: 'Will FNF report EPS above $1.33?' }), { valor: 1.33, fuente: 'pregunta' });
  assert.deepEqual(L.barraDelMercado({ slug: null, question: 'Will X beat -$0.04?' }), { valor: -0.04, fuente: 'pregunta' });
  assert.equal(L.barraDelMercado({ slug: 'sin-umbral', question: 'Will X beat earnings?', descripcion: descDe(1) }), null);
});

// ═══════════════════ 3. gap en centavos ═══════════════════

test('gap: empate exacto, ruido de coma flotante, mitades, nunca −0', () => {
  assert.equal(L.gapCentavos(0.90, 0.90), 0, 'ON 0.90 vs 0.90');
  assert.equal(L.gapCentavos(1.19, 1.20), -1, 'SYY');
  assert.equal(L.gapCentavos(1.32, 1.33), -1, 'FNF');
  assert.equal(L.gapCentavos(1.33, 1.32), 1, '1.33 − 1.32 = 0.01000000000000009 → +1, no +1.0000001');
  assert.equal(L.gapCentavos(0.1 + 0.2, 0.3), 0, '0.30000000000000004 vs 0.3 = empate exacto');
  assert.ok(Object.is(L.gapCentavos(-0.3, -(0.1 + 0.2)), 0), 'nunca −0');
  assert.equal(L.gapCentavos(0.43, 0.425), 1, '+0.5 centavo → +1 (lejos del cero)');
  assert.equal(L.gapCentavos(0.425, 0.43), -1, '−0.5 centavo → −1 (lejos del cero)');
  assert.equal(L.gapCentavos(0.424, 0.42), 0);
  assert.equal(L.gapCentavos(null, 0.4), null);
  assert.equal(L.gapCentavos(0.4, undefined), null);
});

test('gap con consenso NEGATIVO', () => {
  assert.equal(L.gapCentavos(-0.03, -0.05), 2, 'barra −0.03 vs consenso −0.05 → +2');
  assert.equal(L.gapCentavos(-0.05, -0.05), 0);
  assert.equal(L.gapCentavos(-0.08, -0.05), -3);
  assert.equal(L.gapCentavos(0.01, -0.02), 3, 'cruza el cero');
  const u = L.construyeUniverso([fila({ id: 'neg', barra: -0.03, consenso: -0.05 })]);
  assert.equal(u.universo.length, 1);
  assert.equal(u.universo[0].barra, -0.03);
  assert.equal(u.universo[0].consenso, -0.05);
  assert.equal(u.universo[0].gap, 2);
  assert.equal(u.universo[0].tramo, '+2');
});

test('tramos de la tabla: ≤−4 … ≥+4', () => {
  assert.deepEqual(L.tramosGap(), ['≤−4', '−3', '−2', '−1', '0', '+1', '+2', '+3', '≥+4']);
  assert.equal(L.tramoGap(-4), '≤−4');
  assert.equal(L.tramoGap(-17), '≤−4');
  assert.equal(L.tramoGap(-3), '−3');
  assert.equal(L.tramoGap(0), '0');
  assert.equal(L.tramoGap(3), '+3');
  assert.equal(L.tramoGap(4), '≥+4');
  assert.equal(L.tramoGap(null), null);
});

// ═══════════════════ 4. universo ═══════════════════

test('universo: unión sin duplicados, resueltos, liquidez, consenso, barra', () => {
  const filas = [
    fila({ id: '1', barra: 0.90, consenso: 0.90, outcome: 'no', cosecha: 'v2' }),
    fila({ id: '1', barra: 0.95, consenso: 0.90, outcome: 'yes', cosecha: 'v1' }),           // duplicado: gana v2
    fila({ id: '2', barra: 1.0, consenso: 1.0, outcome: null }),                              // no resuelto
    fila({ id: '3', barra: 1.0, consenso: 1.0, outcome: 'abierto' }),                         // no resuelto
    fila({ id: '4', barra: 1.0, consenso: 1.0, volume: 499.99 }),                             // liquidez
    fila({ id: '5', barra: 1.0, consenso: 1.0, volume: null }),                               // liquidez
    fila({ id: '6', barra: 1.0, consenso: 1.0, volume: 500 }),                                // entra: ≥ $500
    { ...fila({ id: '7', barra: 1.2 }), consensus_pm: 1.2 },                                  // SIN consenso en la descripción
    fila({ id: '8', barra: 1.2, desc: 'Resolves Yes if EPS greater than $1.20. Estimate $1.20.' }), // un "estimate" no es consenso
    fila({ id: '9', consenso: 1.2 }),                                                         // sin barra
    fila({ id: '10', barra: 1.2, consenso: 1.2, token: null }),                               // sin token
    fila({ id: '11', barra: 1.2, consenso: 1.2, fecha: null }),                               // sin fecha de reporte
    fila({ id: '12', barra: 1.19, consenso: 1.20, outcome: 'YES' }),
  ];
  const u = L.construyeUniverso(filas);
  assert.equal(u.filas, 13);
  assert.deepEqual(u.excluidos, { duplicado: 1, no_resuelto: 2, liquidez: 2, sin_consenso: 2, sin_barra: 1, sin_token: 1, sin_fecha_reporte: 1 });
  assert.deepEqual(u.universo.map((m) => m.market_id), ['1', '6', '12']);
  assert.equal(u.universo[0].cosecha, 'v2');
  assert.equal(u.universo[0].y, 0);
  assert.equal(u.universo[2].y, 1);
  assert.equal(u.universo[2].gap, -1);
});

test('EMPATE EXACTO: ON 0.90 vs 0.90 resuelto No cae en gap = 0 con Yes = 0', () => {
  const f = fila({ id: 'ON', sym: 'ON', barra: 0.90, consenso: 0.90, outcome: 'no', fecha: '2026-11-03', hour: 'bmo' });
  const u = L.construyeUniverso([f]);
  const m = u.universo[0];
  assert.equal(m.gap, 0);
  assert.equal(m.tramo, '0');
  assert.equal(m.y, 0, 'empate = No');
  const o = L.observacion(m, caminoConstante(m.fecha, 0.85));
  const t = L.tablaGap([o]).find((x) => x.tramo === '0');
  assert.deepEqual({ n: t.n, tasa: t.tasa_yes }, { n: 1, tasa: 0 });
  assert.ok(Math.abs(t.diferencia - -0.85) < 1e-12);
});

// ═══════════════════ 5. p24 ═══════════════════

test('p24: T-24h desde la hora del reporte, punto anterior, hueco ≤ 3h', () => {
  const m = L.construyeUniverso([fila({ id: 'p', barra: 1, consenso: 1, fecha: '2026-10-21', hour: 'amc' })]).universo[0];
  const rep = Date.parse('2026-10-21T20:00:00Z');          // 16:00 EDT
  assert.equal(m.reporte_ms, rep);
  const obj = rep - 24 * H;
  const o = L.observacion(m, [{ t: obj - 2 * H, p: 0.6 }, { t: obj + 1, p: 0.99 }]);
  assert.equal(o.p24, 0.6, 'nunca un punto posterior');
  assert.equal(L.observacion(m, [{ t: obj - 3.5 * H, p: 0.6 }]).motivo24, 'hueco_mayor_3h');
  assert.equal(L.observacion(m, []).motivo24, 'sin_historial');
  assert.equal(L.observacion(m, [{ t: obj + H, p: 0.6 }]).motivo24, 'sin_punto_anterior');
});

// ═══════════════════ 6. pruebas ═══════════════════

const ob = (gap, p24, y, fecha = '2026-01-01') => ({ gap, tramo: L.tramoGap(gap), p24, y, fecha, d: p24 });

test('tabla: N, % Yes, p24 medio y diferencia por tramo; sin p24 no cuenta', () => {
  const obs = [ob(0, 0.8, 0), ob(0, 0.6, 1), ob(-1, 0.5, 1), ob(-7, 0.4, 0), ob(-4, 0.2, 1), ob(9, 0.9, 1), ob(0, null, 1)];
  const t = Object.fromEntries(L.tablaGap(obs).map((x) => [x.tramo, x]));
  assert.equal(t['0'].n, 2);
  assert.equal(t['0'].tasa_yes, 0.5);
  assert.ok(Math.abs(t['0'].p24_medio - 0.7) < 1e-12);
  assert.ok(Math.abs(t['0'].diferencia - -0.2) < 1e-12);
  assert.equal(t['≤−4'].n, 2);
  assert.ok(Math.abs(t['≤−4'].p24_medio - 0.3) < 1e-12);
  assert.equal(t['≥+4'].n, 1);
  assert.equal(t['+2'].n, 0);
  assert.equal(t['+2'].tasa_yes, null);
  assert.equal(t['+2'].diferencia, null);
});

test('simulación: reglas y pagos a mano', () => {
  const obs = [
    ob(0, 0.80, 0),    // No a 0.20: +4.00 − 0.02
    ob(0, 0.70, 1),    // No a 0.30 (frontera ≥ 0.70): −1 − 0.02
    ob(0, 0.69, 0),    // fuera: p24 < 0.70
    ob(-1, 0.50, 1),   // Yes a 0.50: +1 − 0.02
    ob(-3, 0.70, 0),   // Yes a 0.70 (frontera ≤ 0.70): −1 − 0.02
    ob(-2, 0.71, 1),   // fuera: p24 > 0.70
    ob(1, 0.30, 1),    // fuera: gap ≥ +1 no opera
    ob(0, 1, 0),       // fuera: No a 0 no se puede comprar
  ];
  const s = L.simulacion(obs);
  assert.equal(s.operaciones, 4);
  assert.deepEqual(s.compra_no, { n: 2, aciertos: 1, neto_usd: Number((4 - 0.02 - 1 - 0.02).toFixed(4)) });
  assert.deepEqual(s.compra_yes, { n: 2, aciertos: 1, neto_usd: Number((1 - 0.02 - 1 - 0.02).toFixed(4)) });
  assert.equal(s.bruto_usd, 3);
  assert.equal(s.costos_usd, 0.08);
  assert.equal(s.neto_usd, 2.92);
  assert.equal(s.neto_por_apuesta, 0.73);
});

test('regresión: codificación de los indicadores == logística directa', () => {
  const r = rng(11);
  const obs = [];
  for (let i = 0; i < 300; i++) {
    const gap = GAPS[i % GAPS.length];
    const p24 = 0.2 + r() * 0.7;
    obs.push(ob(gap, p24, r() < p24 ? 1 : 0, fechaMas('2025-03-01', Math.floor(i / 4))));
  }
  const reg = L.regresion(obs);
  assert.ok(reg.convergio);
  const X = obs.map((o) => [D.logit(o.p24), o.gap === 0 ? 1 : 0, o.gap === -1 ? 1 : 0, o.gap >= 1 ? 1 : 0]);
  const dir = D.logistica(X, obs.map((o) => o.y), obs.map((o) => o.fecha));
  assert.equal(reg.n, 300);
  assert.equal(reg.grupos, 75);
  assert.ok(Math.abs(reg.gap0.coef - dir.coef[2]) < 1e-6);
  assert.ok(Math.abs(reg.gap0.t - dir.t[2]) < 1e-6);
  assert.ok(Math.abs(reg.coefs.gap_m1.coef - dir.coef[3]) < 1e-6);
  assert.ok(Math.abs(reg.coefs.gap_pos.coef - dir.coef[4]) < 1e-6);
  assert.ok(Math.abs(reg.coefs.logit_p24.coef - dir.coef[1]) < 1e-6);
});

test('regresión: sin observaciones en la base (gap ≤ −2) → sin convergencia, no un número', () => {
  const r = rng(5);
  const obs = Array.from({ length: 200 }, (_, i) => ob([0, -1, 2][i % 3], 0.3 + r() * 0.5, r() < 0.5 ? 1 : 0, fechaMas('2025-01-01', i)));
  const reg = L.regresion(obs);
  assert.equal(reg.convergio, false);
  assert.equal(reg.motivo, 'matriz_singular');
});

test('mitades: la regla de PM-DRIFT sobre las observaciones con p24', () => {
  const obs = [ob(0, 0.5, 1, '2026-01-01'), ob(0, 0.5, 1, '2026-01-02'), ob(0, null, 1, '2026-01-03'), ob(0, 0.5, 1, '2026-01-04'), ob(0, 0.5, 1, '2026-01-05')];
  const m = L.mitades(obs);
  assert.equal(m.mediana, '2026-01-02', 'N par (4 válidas) → la menor de las dos del medio');
  assert.equal(m.antes.length, 2);
  assert.equal(m.despues.length, 2);
});

test('veredicto: cada frontera', () => {
  const reg = (coef, t) => ({ convergio: true, gap0: { coef, se: 1, t } });
  const sim = (neto) => ({ simulacion: { neto_usd: neto } });
  const v = (o) => L.veredicto({ n_gap0: 40, regresion: reg(-0.5, -3), mitad_antes: sim(1), mitad_despues: sim(1), ...o }).veredicto;
  assert.equal(v({}), 'GO');
  assert.equal(v({ n_gap0: 39 }), 'INCONCLUSO');
  assert.equal(v({ n_gap0: 39, regresion: reg(-5, -10) }), 'INCONCLUSO', 'N manda primero');
  assert.equal(v({ regresion: reg(-0.5, -2.5) }), 'GO', '|t| = 2.5 exacto → GO');
  assert.equal(v({ regresion: reg(-0.5, -2.4999) }), 'GO FRÁGIL');
  assert.equal(v({ regresion: reg(-0.5, -2) }), 'GO FRÁGIL', '|t| = 2 exacto → FRÁGIL');
  assert.equal(v({ regresion: reg(-0.5, -1.9999) }), 'NO-GO');
  assert.equal(v({ regresion: reg(0.5, 3) }), 'NO-GO', 'coef positivo');
  assert.equal(v({ regresion: reg(0, 0) }), 'NO-GO', 'coef = 0 no es negativo');
  assert.equal(v({ mitad_antes: sim(0) }), 'NO-GO', 'neto = 0 no es > 0');
  assert.equal(v({ mitad_despues: sim(-0.01) }), 'NO-GO');
  assert.equal(v({ regresion: reg(-0.5, -2.2), mitad_despues: sim(-1) }), 'NO-GO', 'FRÁGIL también exige las dos mitades');
  assert.equal(v({ regresion: { convergio: false, motivo: 'separacion' } }), 'NO-GO');
  const r = L.veredicto({ n_gap0: 40, regresion: { convergio: false, motivo: 'separacion' }, mitad_antes: sim(1), mitad_despues: sim(-1) });
  assert.match(r.motivo, /sin convergencia \(separacion\).*2ª mitad/);
});

// ═══════════════════ 7. cadena completa ═══════════════════

test('efecto plantado (gap = 0 sobrevalorado) → GO, hipótesis previa se cumple', () => {
  const { u, puntosPorId, estados } = preparado(fabrica({ modo: 'centavos' }));
  const r = L.corre({ universo: u.universo, puntosPorId, estados });
  assert.equal(r.estado, 'GO', r.motivo);
  assert.equal(r.n_validas, 600);
  assert.equal(r.n_gap0, 200);
  assert.ok(r.regresion.gap0.coef < 0 && r.regresion.gap0.t <= -2.5);
  assert.ok(r.mitad_antes.simulacion.neto_usd > 0 && r.mitad_despues.simulacion.neto_usd > 0);
  assert.equal(r.hipotesis_previa.se_cumple, true);
  assert.equal(r.mitad_antes.n + r.mitad_despues.n, 600);
  assert.ok(r.mitad_antes.hasta <= r.mediana_fecha && r.mitad_despues.desde > r.mediana_fecha);
});

test('precio calibrado (y ~ p24) → NO-GO', () => {
  const { u, puntosPorId, estados } = preparado(fabrica({ modo: 'nulo', semilla: 9 }));
  const r = L.corre({ universo: u.universo, puntosPorId, estados });
  assert.equal(r.estado, 'NO-GO', r.motivo);
});

test('N(gap = 0) < 40 → INCONCLUSO aunque el efecto esté', () => {
  const { u, puntosPorId, estados } = preparado(fabrica({ n: 105, modo: 'centavos' }));
  const r = L.corre({ universo: u.universo, puntosPorId, estados });
  assert.equal(r.n_gap0, 35);
  assert.equal(r.estado, 'INCONCLUSO');
});

test('sin datos: universo vacío / cero puntos → FALLA DE FRONTERA; pendientes → COBERTURA INCOMPLETA', () => {
  assert.equal(L.corre({ universo: [], puntosPorId: new Map(), estados: new Map() }).estado, 'FALLA DE FRONTERA');
  const { u, estados } = preparado(fabrica({ n: 60 }));
  const cero = L.corre({ universo: u.universo, puntosPorId: new Map(), estados });
  assert.equal(cero.estado, 'FALLA DE FRONTERA');
  assert.equal(cero.cobertura.faltan_p24.sin_historial, 60);
  const pend = new Map(estados);
  pend.delete(u.universo[0].market_id);
  const fx = preparado(fabrica({ n: 60 }));
  assert.equal(L.corre({ universo: fx.u.universo, puntosPorId: fx.puntosPorId, estados: pend }).estado, 'COBERTURA INCOMPLETA');
});

test('markdown: tabla con los 9 tramos, regresión, simulación, mitades, veredicto', () => {
  const { u, puntosPorId, estados } = preparado(fabrica({ modo: 'centavos' }));
  const r = L.corre({ universo: u.universo, puntosPorId, estados });
  delete r.obs;
  const md = L.renderResumenMarkdown({ generado_en: 'x', criterios: C, universo: { filas: u.filas, excluidos: u.excluidos }, resultado: r });
  for (const t of L.tramosGap()) assert.match(md, new RegExp(`^\\| ${t.replace('+', '\\+')} \\| \\d+ \\|`, 'm'), t);
  assert.match(md, /## Estado: \*\*GO\*\*/);
  assert.match(md, /1\[gap = 0\]: coef -/);
  assert.match(md, /1ª mitad/);
  assert.match(md, /2ª mitad/);
  assert.match(md, /sin consenso en la descripción 0/);
  assert.match(md, /✅ por debajo, como se esperaba/);
});

// ═══════════════════ 8. endpoint ═══════════════════

function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.text = s; return this; },
    end() { return this; } };
}
const GET = (query, headers = {}) => ({ method: 'GET', query, headers });
const COLS = ['market_id', 'symbol', 'slug', 'question', 'descripcion', 'report_date', 'outcome', 'volume', 'yes_token_id', 'cosecha', 'orden', 'hour'];

// Neon + CLOB falsos. `cache` = lo que PM-DRIFT ya dejó en pm_price_hist.
function mockRed({ n = 300, modo = 'centavos', cachePrevia = false } = {}) {
  const fx = fabrica({ n, modo, semilla: 21 });
  const filas = fx.filas.map((f) => COLS.map((k) => (k === 'orden' ? '0' : f[k] === null || f[k] === undefined ? null : String(f[k]))));
  filas.push(['abierto', 'ZZZ', slugDe('ZZZ', 1), null, descDe(1), '2026-10-20', null, '5000', 'tz', 'v1', '1', 'amc']);
  const db = { estados: new Map(), puntos: new Map() };
  if (cachePrevia) {
    for (const f of fx.filas) {
      db.estados.set(f.market_id, 'ok');
      db.puntos.set(f.market_id, new Map(fx.puntosPorToken.get(f.yes_token_id).map((p) => [p.t, p.p])));
    }
  }
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
          fields = COLS.map((name) => ({ name, dataTypeID: ['volume', 'orden'].includes(name) ? 1700 : 25 }));
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
      const pts = fx.puntosPorToken.get(market) || [];
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ history: pts.map((p) => ({ t: p.t / 1000, p: p.p })) }) };
    }
    throw new Error('red inesperada: ' + u);
  };
  return { fetch, queries, clobLlamadas, db };
}

function soloLecturaSobreV1V2(queries) {
  for (const q of queries) {
    const s = q.trim().toLowerCase();
    if (/^(insert|update|delete|alter|drop|truncate)/.test(s)) assert.match(s, /^insert into pm_price_hist(_fetch)? /, q.slice(0, 80));
    else if (/^create/.test(s)) assert.match(s, /^create table if not exists pm_price_hist(_fetch)? /);
    else assert.match(s, /^select/);
  }
}

test('endpoint: gate del CRON_SECRET', async () => {
  const red = mockRed({ n: 15 });
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

test('endpoint: con la caché de PM-DRIFT llena no pide nada al CLOB', async () => {
  const red = mockRed({ n: 300, cachePrevia: true });
  globalThis.fetch = red.fetch;
  const r = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), r);
  assert.equal(r.code, 200, r.body && r.body.error);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(red.clobLlamadas.length, 0);
  assert.match(r.text, /## Estado: \*\*GO\*\*/);
  assert.match(r.text, /no resueltos 1/);
  soloLecturaSobreV1V2(red.queries);
});

test('endpoint: cobertura → baja lo que falta, guarda en la caché, después resultado', async () => {
  const red = mockRed({ n: 300 });
  globalThis.fetch = red.fetch;
  const cob = mockRes();
  await handler(GET({ solo: 'cobertura', format: 'md', secret: SECRET }), cob);
  assert.equal(cob.code, 200, cob.body && cob.body.error);
  assert.match(cob.text, /COBERTURA LISTA/);
  assert.match(cob.text, /Con p24: \*\*300\*\*/);
  assert.ok(!/## a\) Tabla/.test(cob.text), 'cobertura no da resultados');
  assert.equal(red.clobLlamadas.length, 300);
  soloLecturaSobreV1V2(red.queries);

  const full = mockRes();
  await handler(GET({ secret: SECRET, obs: '1' }), full);
  assert.equal(full.code, 200, full.body && full.body.error);
  assert.equal(red.clobLlamadas.length, 300, 'lo ya bajado no se vuelve a pedir');
  assert.equal(full.body.veredicto, 'GO');
  assert.equal(full.body.resultado.n_validas, 300);
  assert.equal(full.body.obs.length, 300);
  assert.equal(full.body.universo.excluidos.no_resuelto, 1);
});

// ═══════════════════ 9. Postgres real ═══════════════════

test('contra Postgres real: SQL_UNIVERSO lee slug, pregunta y la descripción de raw', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = SIN_POSTGRES ? null : binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55453 });
  for (const q of SCHEMA_V1) psql(q + ';');
  for (const q of SCHEMA_V1) psql(q.replace(/pm_earnings_markets/g, 'pm_earnings_markets_v2') + ';');
  for (const q of PEAD_SCHEMA) psql(q + ';');
  const raw = (c) => JSON.stringify({ description: descDe(c) }).replace(/'/g, "''");
  psql(`insert into pm_earnings_markets (market_id, symbol, slug, question, filtro_motivo, report_date, outcome, volume, yes_token_id, raw) values
          ('1', 'AAA', 'aaa-x-0pt95', 'q1', 'ok', '2026-10-20', 'yes', 900, 'v1tok', '${raw(0.9)}'),
          ('2', 'BBB', 'bbb-x-1pt20', 'q2', 'ok', '2026-10-21', 'no', 800, 'tok2', '${raw(1.2)}');
        insert into pm_earnings_markets_v2 (market_id, symbol, slug, question, filtro_motivo, report_date, outcome, volume, yes_token_id, raw) values
          ('1', 'AAA', 'aaa-x-0pt90', 'q1', 'ok', '2026-10-20', 'no', 1000, 'v2tok', '${raw(0.9)}');
        insert into pead_event_hour (symbol, reported_date, hour, source) values ('AAA', '2026-10-20', 'bmo', 'sec_8k');`);
  const filas = psql(`select market_id, slug, descripcion, report_date, outcome, cosecha, coalesce(hour, '') from (${L.SQL_UNIVERSO}) x;`).trim().split('\n');
  assert.deepEqual(filas, [
    `1|aaa-x-0pt90|${descDe(0.9)}|2026-10-20|no|v2|bmo`,
    `2|bbb-x-1pt20|${descDe(1.2)}|2026-10-21|no|v1|`,
  ], 'v2 primero, v1 solo lo que v2 no tiene, descripción desde raw');
  for (const q of D.SCHEMA) psql(q + ';');
  psql(D.SQL_ESTADOS + ';');
});
