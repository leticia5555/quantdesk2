// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/event-beta.js — la matemática de "BETA DE EVENTO".
//
// Cinco cosas se prueban con dientes:
//
//   1. CERO LOOK-AHEAD. El día de evento es SIEMPRE la sesión POSTERIOR al
//      reporte (supuesto AMC parejo, docs/pairs-event-beta-scope.md §4.2).
//      Un reporte fechado el mismo día de una sesión NO puede medir esa
//      sesión: eso sería una reacción anterior al anuncio.
//   2. LOS UMBRALES SON LOS FIJADOS ANTES DE CORRER. CRITERIOS va
//      Object.freeze y con los valores del scope §5. Moverlos rompe acá.
//   3. NINGÚN NÚMERO MIENTE. La frontera de ±3% es inclusiva y no depende
//      de un error de redondeo; un retorno cero no cuenta como hit y suma a
//      n_zero; el hit rate del baseline es null (no aplica), nunca 0%;
//      pearson devuelve null por debajo del mínimo en vez de un número
//      frágil; el veredicto no menciona una línea base que no existe.
//   4. LOS HUECOS SE CUENTAN. Cada evento descartado cae en su categoría, y
//      lo que se pierde al alinear se cuenta en sesiones, no en eventos.
//   5. CERO CLAUDE. Se lee el fuente y se verifica que no importa el
//      cliente del modelo ni lo menciona. El veredicto se calcula, no se
//      redacta.
//
// Sin red, sin DB: el módulo es puro por diseño.
// Correr con `node tests/event-beta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CRITERIOS, RANGE_DIAS, signo, logReturns, pearson,
  alignSeries, sliceRange, correlationBlock,
  nextSessionIndex, buildEvents, classifyGroups, groupStats,
  baselineStats, buildGroups, pickBasis, verdictTier, verdictLine,
  fmtPct, fmtHit, unavailable, RAZONES, buildStudy,
} from '../api/_lib/event-beta.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) < eps;

// Serie sintética a partir de closes (open = close previo salvo que se pase).
function serie(fechas, closes, opens) {
  return { fechas, closes, opens: opens || closes.slice() };
}

// ─────────────────── 1. Criterios congelados ───────────────────
console.log('CRITERIOS: los umbrales se fijaron ANTES de ver datos');
{
  ok(Object.isFrozen(CRITERIOS), 'CRITERIOS está congelado (Object.freeze)');
  ok(CRITERIOS.UMBRAL_SALTO === 0.03, 'umbral de salto = ±3%', CRITERIOS.UMBRAL_SALTO);
  ok(CRITERIOS.HIT_FUERTE === 0.60, 'hit fuerte = 60%', CRITERIOS.HIT_FUERTE);
  ok(CRITERIOS.HIT_DEBIL === 0.50, 'hit débil = 50%', CRITERIOS.HIT_DEBIL);
  ok(CRITERIOS.MULT_BASE === 2.0, 'múltiplo sobre la línea base = 2x', CRITERIOS.MULT_BASE);
  ok(CRITERIOS.N_MIN === 10, 'N mínimo para "significativo" = 10', CRITERIOS.N_MIN);
  ok(CRITERIOS.MIN_RET_CORR === 30, 'mínimo de pares para correlación = 30', CRITERIOS.MIN_RET_CORR);
  ok(CRITERIOS.VENTANA_CORTA === 252, 'ventana corta = 252 sesiones', CRITERIOS.VENTANA_CORTA);
  ok(CRITERIOS.RANGE_PRECIOS === '10y', 'ventana de precios del estudio = 10y', CRITERIOS.RANGE_PRECIOS);
  // Que esté frozen tiene que NOTARSE: escribir no debe cambiar el valor.
  try { CRITERIOS.N_MIN = 3; } catch (e) { /* strict mode tira; da igual */ }
  ok(CRITERIOS.N_MIN === 10, 'un intento de mover N_MIN en runtime no prospera');
}

// ─────────────────── 2. Piezas numéricas ───────────────────
console.log('\nlogReturns / pearson: sin números frágiles');
{
  const r = logReturns([100, 110, 121]);
  ok(r.length === 2, 'n precios → n-1 retornos', r.length);
  ok(near(r[0], Math.log(1.1)) && near(r[1], Math.log(1.1)), 'log-retornos correctos');
  ok(logReturns([100, 0, 50])[0] === null, 'precio no positivo → retorno null, no -Infinity');
  ok(logReturns([100]).length === 0, 'una sola observación → sin retornos');

  // Pearson contra un caso calculado a mano: correlación perfecta = 1.
  const a = [1, 2, 3, 4, 5];
  ok(near(pearson(a, [2, 4, 6, 8, 10], 3), 1), 'relación lineal creciente → r = 1');
  ok(near(pearson(a, [10, 8, 6, 4, 2], 3), -1), 'relación lineal decreciente → r = −1');
  // Caso a mano: cov/(sx*sy) con x=[1,2,3], y=[1,3,2] → 0.5
  ok(near(pearson([1, 2, 3], [1, 3, 2], 3), 0.5, 1e-12), 'caso a mano → r = 0.5', pearson([1, 2, 3], [1, 3, 2], 3));

  ok(pearson(a, [2, 4, 6, 8, 10]) === null, 'por debajo de MIN_RET_CORR (30) → null, no un número frágil');
  ok(pearson([1, 1, 1], [1, 2, 3], 3) === null, 'una serie sin varianza → null');
  ok(pearson([1, 2, 3], [1, null, 3], 2) !== null, 'los pares con null se saltan, no envenenan');
  ok(pearson(null, [1, 2], 1) === null, 'entrada no-array → null, no throw');
  ok(signo(0) === 0 && signo(-1e-9) === -1 && signo(1e-9) === 1, 'signo() distingue el cero');
}

// ─────────────────── 3. Alineación ───────────────────
console.log('\nalignSeries: el invariante "precio en AMBOS" por construcción');
{
  const sy = serie(['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'], [10, 11, 12, 13]);
  const sx = serie(['2024-01-02', '2024-01-04', '2024-01-05'], [100, 102, 103]);
  const a = alignSeries(sy, sx);
  ok(a.n === 3, 'solo las fechas presentes en ambas', a.n);
  ok(a.fechas.join() === '2024-01-02,2024-01-04,2024-01-05', 'orden cronológico preservado', a.fechas.join());
  ok(a.dropped_sessions === 1, 'la sesión sin par se cuenta en dropped_sessions (sesiones, no eventos)', a.dropped_sessions);

  // Precio inválido en una de las dos → la sesión entera se cae.
  const malo = alignSeries(
    serie(['2024-01-02', '2024-01-03'], [10, 11]),
    serie(['2024-01-02', '2024-01-03'], [100, 0]),
  );
  ok(malo.n === 1 && malo.dropped_sessions === 1, 'un close en 0 tira la sesión completa', `${malo.n}/${malo.dropped_sessions}`);
  ok(alignSeries(null, sx).n === 0, 'entrada nula → serie vacía, no throw');
}

console.log('\nsliceRange: recorte por range relativo a la ÚLTIMA sesión (sin reloj)');
{
  // 800 sesiones diarias consecutivas terminando en una fecha conocida.
  const fechas = [];
  const d = new Date(Date.UTC(2022, 0, 1));
  for (let i = 0; i < 800; i++) { fechas.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const closes = fechas.map((_, i) => 100 + i);
  const a = alignSeries(serie(fechas, closes), serie(fechas, closes));
  ok(sliceRange(a, '2y').n === 731, '2y = 730 días de calendario hacia atrás', sliceRange(a, '2y').n);
  ok(sliceRange(a, '1y').n === 366, '1y = 365 días de calendario hacia atrás', sliceRange(a, '1y').n);
  ok(sliceRange(a, '5y').n === a.n, '5y más largo que la serie → la serie entera', sliceRange(a, '5y').n);
  ok(sliceRange(a, 'zz').n === a.n, 'range desconocido → no recorta');
  // El recorte NO depende de Date.now(): dos llamadas dan lo mismo siempre.
  ok(sliceRange(a, '2y').fechas[0] === sliceRange(a, '2y').fechas[0], 'determinista');
  ok(RANGE_DIAS['1y'] === 365 && RANGE_DIAS['2y'] === 730 && RANGE_DIAS['5y'] === 1825, 'tabla de días por range');
}

// ─────────────────── 4. Día de evento (la regla dura) ───────────────────
console.log('\nnextSessionIndex / buildEvents: CERO look-ahead');
{
  const f = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];
  ok(nextSessionIndex(f, '2024-01-02') === 1, 'reporte en una sesión → la SIGUIENTE, nunca la misma');
  ok(nextSessionIndex(f, '2024-01-01') === 0, 'reporte antes de la primera → la primera');
  ok(nextSessionIndex(f, '2023-12-31') === 0, 'reporte muy anterior → la primera');
  ok(nextSessionIndex(f, '2024-01-05') === -1, 'reporte en la última sesión → no hay siguiente');
  ok(nextSessionIndex(f, '2024-01-06') === -1, 'reporte posterior a todo → -1');
  // Fin de semana: viernes 5, siguiente sesión lunes 8.
  const fs = ['2024-01-04', '2024-01-05', '2024-01-08'];
  ok(nextSessionIndex(fs, '2024-01-06') === 2, 'reporte en sábado → el lunes siguiente');
  ok(nextSessionIndex(fs, '2024-01-05') === 2, 'reporte el viernes (AMC) → el lunes siguiente');
}

console.log('\nbuildEvents: cada descarte en su categoría');
{
  const f = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
  const a = alignSeries(serie(f, [10, 10, 10.5, 10.5, 10]), serie(f, [100, 100, 105, 105, 100]));
  const r = buildEvents(a, [
    '2019-01-01',    // fuera de ventana (antes)
    '2024-01-02',    // ok → E = 01-03
    '2024-01-08',    // última sesión → sin siguiente
    '2030-01-01',    // fuera de ventana (después)
    'None',          // malformado (sentinela de AV)
    '',              // malformado
    '2024-01-02',    // duplicado exacto
  ]);
  ok(r.eventos.length === 1, 'un solo evento usable', r.eventos.length);
  ok(r.eventos[0].event_date === '2024-01-03', 'día de evento = la sesión siguiente', r.eventos[0].event_date);
  ok(r.eventos[0].reported_date === '2024-01-02', 'conserva la fecha del reporte');
  ok(r.eventos[0].hour_source === 'assumed_amc', 'cada evento lleva hour_source assumed_amc');
  ok(r.dropped.no_next_session === 1, 'la última sesión cae en no_next_session', r.dropped.no_next_session);
  ok(r.dropped.out_of_window === 4, 'fuera de ventana + malformados = 4', r.dropped.out_of_window);
  ok(!('no_price' in r.dropped), 'no existe la categoría no_price: es imposible por construcción');
  ok(r.ventana.from === '2024-01-02' && r.ventana.to === '2024-01-08', 'ventana reportada');

  // Un reporte ANTES de la primera sesión apuntaría al índice 0, que no tiene
  // cierre previo: se descarta en vez de inventar un retorno.
  const r2 = buildEvents(a, ['2024-01-01']);
  ok(r2.eventos.length === 0 && r2.dropped.out_of_window === 1,
    'reporte anterior a la ventana → out_of_window, no un evento sin cierre previo');

  // Serie vacía: todos los reportes cuentan como fuera de ventana, no se pierden.
  const r3 = buildEvents(alignSeries(serie([], []), serie([], [])), ['2024-01-02', '2024-01-03']);
  ok(r3.eventos.length === 0 && r3.dropped.out_of_window === 2, 'sin precios → nada desaparece en silencio');
}

// ─────────────────── 5. Grupos y métricas ───────────────────
console.log('\nclassifyGroups: la frontera de ±3% es INCLUSIVA y no depende del redondeo');
{
  const ev = (x) => ({ x_c2c: x, y_c2c: 0.01, x_o2c: x, y_o2c: 0.01 });
  const g = classifyGroups([ev(0.03), ev(0.0299), ev(-0.03), ev(-0.0299), ev(0.05), ev(0)]);
  ok(g.UP.length === 2, 'exactamente +3.00% entra en UP (junto al +5%)', g.UP.length);
  ok(g.DOWN.length === 1, 'exactamente −3.00% entra en DOWN', g.DOWN.length);
  ok(g.ALL.length === 6, 'ALL son todos los eventos', g.ALL.length);
  // 2.99% queda fuera de los dos.
  ok(!g.UP.some((e) => e.x_c2c === 0.0299) && !g.DOWN.some((e) => e.x_c2c === -0.0299),
    '2.99% no entra en ningún grupo de salto');
  // El caso que motivó la tolerancia: 0.1+0.2-0.27 no da exactamente 0.03.
  const casi = 0.1 + 0.2 - 0.27; // 0.029999999999999995
  ok(classifyGroups([ev(casi)]).UP.length === 1,
    'un +3% con error de punto flotante por debajo igual entra en UP', casi);
}

console.log('\ngroupStats: el denominador no miente');
{
  const mk = (y, x) => ({ y_c2c: y, x_c2c: x });
  // 4 eventos: 2 mismo signo, 1 signo opuesto, 1 con Y en cero.
  const s = groupStats([mk(0.02, 0.05), mk(-0.02, -0.05), mk(-0.01, 0.04), mk(0, 0.05)], 'y_c2c', 'x_c2c');
  ok(s.n === 4, 'n cuenta TODOS los eventos del grupo', s.n);
  ok(s.n_zero === 1, 'el retorno cero se cuenta aparte en n_zero', s.n_zero);
  ok(near(s.hit_rate, 2 / 4), 'hit rate = aciertos / n (el cero NO es acierto)', s.hit_rate);
  ok(near(s.avg, (0.02 - 0.02 - 0.01 + 0) / 4), 'avg es la media de Y sobre TODOS los del grupo', s.avg);
  const vacio = groupStats([], 'y_c2c', 'x_c2c');
  ok(vacio.n === 0 && vacio.hit_rate === null && vacio.avg === null, 'grupo vacío → n=0 y nulls, no ceros');
}

console.log('\nbaselineStats: el contrafáctico, sin hit rate inventado');
{
  const f = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const a = alignSeries(serie(f, [100, 110, 121], [100, 100, 110]), serie(f, [10, 11, 12]));
  const b = baselineStats(a);
  ok(b.n === 2, 'n = sesiones − 1 (los retornos disponibles)', b.n);
  ok(b.c2c.hit_rate === null, 'hit rate del baseline es null (no aplica), NUNCA 0%');
  ok(near(b.c2c.avg, 0.1), 'avg c2c correcto', b.c2c.avg);
  ok(baselineStats(alignSeries(serie([], []), serie([], []))).n === 0, 'serie vacía → n=0 sin throw');
}

console.log('\nbuildGroups: las cuatro filas, con su marca de significancia');
{
  const eventos = Array.from({ length: 12 }, () => ({ x_c2c: 0.05, y_c2c: 0.02, x_o2c: 0.04, y_o2c: 0.01 }));
  eventos.push({ x_c2c: -0.05, y_c2c: -0.02, x_o2c: -0.04, y_o2c: -0.01 });
  const f = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const a = alignSeries(serie(f, [100, 101, 102]), serie(f, [10, 11, 12]));
  const filas = buildGroups(eventos, a);
  ok(filas.map((x) => x.key).join() === 'UP,DOWN,ALL,BASELINE', 'las cuatro filas en orden', filas.map((x) => x.key).join());
  ok(filas[0].n === 12 && filas[0].significant === true, 'UP con N=12 → significativo');
  ok(filas[1].n === 1 && filas[1].significant === false, 'DOWN con N=1 → NO significativo');
  ok(filas[3].key === 'BASELINE' && filas[3].c2c.hit_rate === null, 'la fila BASELINE va sin hit rate');
}

// ─────────────────── 6. Veredicto ───────────────────
console.log('\npickBasis: orden FIJO UP→DOWN→ALL, nunca "el que salió mejor"');
{
  const fila = (key, n) => ({ key, n, significant: n >= 10, c2c: { hit_rate: 0.9, avg: 0.05 }, o2c: {} });
  ok(pickBasis([fila('UP', 3), fila('DOWN', 40), fila('ALL', 50)]) === 'UP',
    'con UP poblado se usa UP aunque DOWN tenga más eventos y mejor pinta');
  ok(pickBasis([fila('UP', 0), fila('DOWN', 5), fila('ALL', 20)]) === 'DOWN', 'UP vacío → DOWN');
  ok(pickBasis([fila('UP', 0), fila('DOWN', 0), fila('ALL', 20)]) === 'ALL', 'UP y DOWN vacíos → ALL');
  ok(pickBasis([fila('UP', 0), fila('DOWN', 0), fila('ALL', 0)]) === null, 'todo vacío → null');
}

console.log('\nverdictTier: los tres tiers y sus fronteras');
{
  const base = { c2c: { avg: 0.001 } };
  const f = (hit, avg) => ({ key: 'UP', n: 20, c2c: { hit_rate: hit, avg }, o2c: {} });
  ok(verdictTier(f(0.70, 0.01), base) === 'beta_evento', '70% y 10x la base → beta_evento');
  ok(verdictTier(f(0.60, 0.002), base) === 'beta_evento', 'exactamente 60% y exactamente 2x → beta_evento (fronteras inclusivas)');
  ok(verdictTier(f(0.60, 0.0019), base) === 'arrastre_debil', '60% pero por debajo de 2x la base → arrastre_debil');
  ok(verdictTier(f(0.59, 0.05), base) === 'arrastre_debil', '59% → arrastre_debil por más grande que sea el avg');
  ok(verdictTier(f(0.50, 0.05), base) === 'arrastre_debil', 'exactamente 50% → arrastre_debil');
  ok(verdictTier(f(0.49, 0.05), base) === 'sin_beta', '49% → sin_beta');
  ok(verdictTier(f(0.80, 0), base) === 'arrastre_debil', 'avg exactamente 0 no concede el tier fuerte por vacío');
  ok(verdictTier(f(0.80, 0.05), null) === 'arrastre_debil', 'sin línea base no se puede exigir el múltiplo → no se concede fuerte');
  ok(verdictTier({ key: 'UP', n: 0, c2c: { hit_rate: null, avg: null }, o2c: {} }, base) === 'sin_datos', 'grupo vacío → sin_datos');
  ok(verdictTier(null, base) === 'sin_datos', 'sin fila → sin_datos');
}

console.log('\nverdictLine: dos idiomas, mismos números, cero Claude');
{
  const eventos = Array.from({ length: 14 }, (_, i) => ({
    x_c2c: 0.05, x_o2c: 0.04,
    y_c2c: i < 9 ? 0.02 : -0.01,   // 9 de 14 en la misma dirección
    y_o2c: i < 8 ? 0.01 : -0.005,
  }));
  const f = ['2024-01-02', '2024-01-03', '2024-01-04'];
  const a = alignSeries(serie(f, [100, 100.05, 100.1]), serie(f, [10, 11, 12]));
  const filas = buildGroups(eventos, a);
  const baseline = filas.find((x) => x.key === 'BASELINE');
  const v = verdictLine(filas, baseline, { y: 'MU', x: 'NVDA' });

  ok(v.basis === 'UP', 'basis = UP', v.basis);
  ok(v.significant === true, 'N=14 → significativo');
  ok(/9 de 14/.test(v.es) && /9 of 14/.test(v.en), 'el conteo de aciertos es el mismo en los dos idiomas');
  ok(/64%/.test(v.es) && /64%/.test(v.en), 'el hit rate es el mismo en los dos idiomas');
  ok(/los 14 earnings de NVDA con salto ≥ \+3%/.test(v.es), 'la frase nominal lleva el N adentro (ES)', v.es);
  ok(/NVDA's 14 earnings with a ≥ \+3% move/.test(v.en), 'la frase nominal lleva el N adentro (EN)', v.en);
  ok(/MU/.test(v.es) && /MU/.test(v.en), 'nombra a Y');
  ok(!/undefined|NaN|null/.test(v.es + v.en), 'sin undefined / NaN / null en el texto');
  ok(/,/.test(v.es.match(/promedió ([^ ]+)/)[1]), 'el decimal en español va con coma', v.es.match(/promedió ([^ ]+)/)[1]);
  ok(/\./.test(v.en.match(/averaging ([^ ]+)/)[1]), 'el decimal en inglés va con punto', v.en.match(/averaging ([^ ]+)/)[1]);

  // N chico → el modificador va ADELANTE, no como nota al pie.
  const pocos = buildGroups(eventos.slice(0, 6), a);
  const vp = verdictLine(pocos, pocos.find((x) => x.key === 'BASELINE'), { y: 'KO', x: 'PEP' });
  ok(vp.significant === false, 'N=6 → no significativo');
  ok(vp.es.startsWith('Descriptivo, no significativo (N=6):'), 'el aviso abre la línea en español', vp.es.slice(0, 45));
  ok(vp.en.startsWith('Descriptive, not significant (N=6):'), 'el aviso abre la línea en inglés', vp.en.slice(0, 45));

  // Sin eventos → dice por qué, no un veredicto vacío.
  const nada = buildGroups([], a);
  const vn = verdictLine(nada, nada.find((x) => x.key === 'BASELINE'), { y: 'KO', x: 'PEP' });
  ok(vn.tier === 'sin_datos' && vn.basis === null, 'sin eventos → tier sin_datos');
  ok(/PEP/.test(vn.es) && /KO/.test(vn.es), 'aun sin datos nombra a los dos tickers');

  // Sin línea base no se promete un contrafáctico que no se calculó.
  const vsb = verdictLine(filas, null, { y: 'MU', x: 'NVDA' });
  ok(!/día cualquiera/.test(vsb.es) && !/ordinary day/.test(vsb.en),
    'sin baseline el texto NO menciona "un día cualquiera"');

  // Los tres cierres existen y son distintos.
  const cierres = new Set();
  for (const hit of [0.9, 0.55, 0.2]) {
    const fk = [{ key: 'UP', n: 20, significant: true, c2c: { hit_rate: hit, avg: 0.05 }, o2c: {} },
      { key: 'DOWN', n: 0, c2c: {}, o2c: {} }, { key: 'ALL', n: 20, c2c: {}, o2c: {} }];
    cierres.add(verdictLine(fk, { c2c: { avg: 0.001 } }, { y: 'A', x: 'B' }).tier);
  }
  ok(cierres.size === 3, 'los tres tiers producen líneas distintas', [...cierres].join());
}

console.log('\nfmtPct / fmtHit: formato por idioma');
{
  ok(fmtPct(0.018, 'es') === '+1,8%', 'ES: coma decimal y signo explícito', fmtPct(0.018, 'es'));
  ok(fmtPct(0.018, 'en') === '+1.8%', 'EN: punto decimal', fmtPct(0.018, 'en'));
  ok(fmtPct(-0.021, 'es') === '-2,1%', 'ES: negativo', fmtPct(-0.021, 'es'));
  ok(fmtPct(null, 'es') === 'n/d' && fmtPct(null, 'en') === 'n/a', 'null → n/d / n/a, nunca "0%"');
  ok(fmtPct(Infinity, 'es') === 'n/d', 'no finito → n/d');
  ok(fmtHit(0.6449, 'es') === '64%', 'hit rate redondeado a entero', fmtHit(0.6449, 'es'));
  ok(fmtHit(null, 'en') === 'n/a', 'hit rate null → n/a, distinto de 0%');
}

// ─────────────────── 7. Correlación ───────────────────
console.log('\ncorrelationBlock: dos ventanas, y una sola cuando son la misma');
{
  const fechas = [];
  const d = new Date(Date.UTC(2020, 0, 1));
  for (let i = 0; i < 900; i++) { fechas.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  // X e Y perfectamente correlacionados en retornos.
  let px = 100, py = 50;
  const cx = [], cy = [];
  for (let i = 0; i < 900; i++) { const r = Math.sin(i / 7) * 0.01; px *= 1 + r; py *= 1 + r; cx.push(px); cy.push(py); }
  const a = alignSeries(serie(fechas, cy), serie(fechas, cx));

  const c2 = correlationBlock(a, '2y');
  ok(c2.same_window === false, '2y → dos ventanas distintas');
  ok(c2.r_1y && c2.r_1y.n === 252, 'la ventana corta usa 252 retornos', c2.r_1y && c2.r_1y.n);
  ok(c2.r_full && c2.r_full.range === '2y', 'la ventana completa lleva el range del usuario');
  ok(near(c2.r_full.value, 1, 1e-6), 'retornos idénticos → r ≈ 1', c2.r_full.value);

  const c1 = correlationBlock(a, '1y');
  ok(c1.same_window === true, '1y → same_window');
  ok(c1.r_1y === null, 'con same_window r_1y va null (la UI pinta un solo número)');
  ok(c1.r_full !== null, 'y r_full sí viaja, etiquetado con el range');

  // Serie corta → no disponible con razón, no un número frágil.
  const corta = alignSeries(serie(fechas.slice(0, 5), [1, 2, 3, 4, 5]), serie(fechas.slice(0, 5), [2, 4, 6, 8, 10]));
  const cc = correlationBlock(corta, '2y');
  ok(cc.r_1y === null && cc.r_full === null, 'menos de 30 pares → sin números');
  ok(cc.unavailable && cc.unavailable.reason_key === 'pocos_dias', 'y con la razón puesta', cc.unavailable && cc.unavailable.reason_key);
  ok(/días en común/.test(cc.unavailable.es) && /overlapping days/.test(cc.unavailable.en), 'razón en los dos idiomas');

  const vacia = correlationBlock(alignSeries(serie([], []), serie([], [])), '2y');
  ok(vacia.unavailable !== null, 'serie vacía → no disponible, no throw');
}

// ─────────────────── 8. "No disponible" ───────────────────
console.log('\nunavailable: cada fallo con su razón, en los dos idiomas');
{
  const casos = [
    ['sin_precios', { symbol: 'NVDA' }, /NVDA/, /NVDA/],
    ['pocos_dias', { n: 12 }, /12/, /12/],
    ['sin_cache', {}, /caché/, /cache/],
    ['presupuesto_av', { used: 25, cap: 25 }, /25\/25/, /25\/25/],
    ['av_rate_limited', {}, /rate-limitó/, /rate-limited/],
    ['av_vacio', { symbol: 'ZZZZ' }, /ZZZZ/, /ZZZZ/],
    ['sin_eventos', { symbol: 'PEP' }, /PEP/, /PEP/],
  ];
  for (const [key, params, reEs, reEn] of casos) {
    const u = unavailable(key, params);
    ok(u.reason_key === key && reEs.test(u.es) && reEn.test(u.en), `razón "${key}" en es/en`, JSON.stringify(u));
  }
  ok(Object.keys(RAZONES).length === 7, 'las 7 razones del scope §8 están todas', Object.keys(RAZONES).length);
  const desc = unavailable('no_existe');
  ok(desc.reason_key === 'desconocida', 'una razón inexistente degrada, no revienta');
  for (const key of Object.keys(RAZONES)) {
    const u = unavailable(key, { symbol: 'X', n: 1, used: 1, cap: 25 });
    ok(!/undefined|NaN|\[object/.test(u.es + u.en), `razón "${key}" sin undefined en el texto`, u.es);
  }
}

// ─────────────────── 9. Ensamblado ───────────────────
console.log('\nbuildStudy: la cadena completa sobre una serie plantada');
{
  // 400 sesiones. X salta +5% en las sesiones que siguen a cada reporte, e Y
  // lo sigue el 100% de las veces: el estudio TIENE que detectarlo.
  const fechas = [];
  const d = new Date(Date.UTC(2021, 0, 4));
  for (let i = 0; i < 400; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    fechas.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const reportIdx = new Set();
  for (let i = 20; i < 390; i += 30) reportIdx.add(i);       // reporte en la sesión i
  const saltoEn = new Set([...reportIdx].map((i) => i + 1)); // reacción en la i+1

  const cx = [], cy = [], ox = [], oy = [];
  let px = 100, py = 50;
  for (let i = 0; i < 400; i++) {
    ox.push(px); oy.push(py);
    const r = saltoEn.has(i) ? 0.05 : 0.0005;
    px *= 1 + r; py *= 1 + r * 0.5;
    cx.push(px); cy.push(py);
  }
  const sy = { fechas, opens: oy, closes: cy };
  const sx = { fechas, opens: ox, closes: cx };
  const st = buildStudy(sy, sx, [...reportIdx].map((i) => fechas[i]), { x: 'NVDA' });

  ok(st.x_events_total === reportIdx.size, 'todos los reportes producen evento', `${st.x_events_total}/${reportIdx.size}`);
  ok(st.hour_source === 'assumed_amc', 'el bloque declara el supuesto de hora');
  ok(st.window.range === '10y', 'el bloque declara la ventana de precios pedida');
  ok(st.unavailable === null, 'con eventos no hay "no disponible"');
  const up = st.groups.find((g) => g.key === 'UP');
  ok(up.n === reportIdx.size, 'todos caen en UP (el salto plantado es +5%)', up.n);
  ok(near(up.c2c.hit_rate, 1), 'hit rate = 100%: Y siguió a X todas las veces', up.c2c.hit_rate);
  const base = st.groups.find((g) => g.key === 'BASELINE');
  ok(base.n === 399, 'baseline = todas las sesiones menos la primera', base.n);
  ok(up.c2c.avg > base.c2c.avg * 2, 'el avg del grupo supera 2x la línea base');

  const v = verdictLine(st.groups, st._baseline, { y: 'MU', x: 'NVDA' });
  ok(v.tier === 'beta_evento', 'la cadena completa detecta la beta plantada', v.tier);

  // Sin reportes → sin_eventos con la razón puesta.
  const vacio = buildStudy(sy, sx, [], { x: 'NVDA' });
  ok(vacio.x_events_total === 0 && vacio.unavailable && vacio.unavailable.reason_key === 'sin_eventos',
    'sin earnings en ventana → unavailable sin_eventos');
  ok(/NVDA/.test(vacio.unavailable.es), 'y la razón nombra al símbolo');

  // CONTROL NEGATIVO: si Y no sigue a X, el veredicto NO puede ser beta_evento.
  const cyR = [], oyR = [];
  let pyr = 50;
  for (let i = 0; i < 400; i++) {
    oyR.push(pyr);
    pyr *= 1 + (saltoEn.has(i) ? -0.03 : 0.0005); // Y se mueve al REVÉS en el evento
    cyR.push(pyr);
  }
  const stR = buildStudy({ fechas, opens: oyR, closes: cyR }, sx, [...reportIdx].map((i) => fechas[i]), { x: 'NVDA' });
  const vR = verdictLine(stR.groups, stR._baseline, { y: 'MU', x: 'NVDA' });
  ok(vR.tier === 'sin_beta', 'control negativo: Y contra X → sin_beta, no beta_evento', vR.tier);
}

// ─────────────────── 10. Cero Claude ───────────────────
console.log('\nCERO CLAUDE: el veredicto se calcula, no se redacta');
{
  const src = readFileSync(join(ROOT, 'api/_lib/event-beta.js'), 'utf8');
  const codigo = src.split('\n')
    .filter((l) => !l.trim().startsWith('//'))       // los comentarios sí pueden nombrarlo
    .join('\n');
  ok(!/from\s+['"].*claude/i.test(codigo), 'no importa el cliente del modelo');
  ok(!/anthropic|claude\.js|ANTHROPIC_API_KEY/i.test(codigo), 'no menciona el modelo ni su key en el código');
  ok(!/\bfetch\s*\(/.test(codigo), 'no hace I/O de red: es puro por diseño');
  ok(!/process\.env/.test(codigo), 'no lee env vars');
  ok(!/Date\.now\(\)|new Date\(\)/.test(codigo), 'no depende del reloj (el recorte es relativo a la última sesión)');
}

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
