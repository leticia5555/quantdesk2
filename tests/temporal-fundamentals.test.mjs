// ═══════════════════════════════════════════════════════════════
// Tests de la DIMENSIÓN TIEMPO de los fundamentales
// (_lib/temporal-fundamentals.js + la REGLA TEMPORAL de _lib/arena-guard.js).
// Puro, sin I/O.
//
// Los dos casos que motivaron la capa, con los datos tal como los habría
// visto el PM:
//
//   LULU al 3-ago — el PM la compró al día siguiente como "value" con la
//   FOTO (P/E ~10, ROE 31%, cero deuda). La PELÍCULA decía otra cosa:
//   ingresos desacelerando trimestre a trimestre y el precio ya un tercio
//   abajo de su máximo. Un mes después: revenue miss + guía recortada, −15%.
//   Debe salir con flag CUCHILLO CAYENDO y la compra debe ser RECHAZADA.
//
//   ZM tal como el PM la propuso — misma foto (P/E 8.64, ROE 32%, cero
//   deuda). Con ingresos planos y revisiones neutras NO es un cuchillo: la
//   regla la deja pasar, pero ahora el PM la ve con su película completa.
//   Con revisiones a la baja (misma foto, película distinta) sí se rechaza.
//
// FIXTURES: los números tienen la FORMA de los datos reales (escala, signo,
// orden de magnitud) y fijan el COMPORTAMIENTO de las reglas. No son una
// cotización verificada de LULU ni de ZM.
// Correr con `node tests/temporal-fundamentals.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  TEMPORAL_RULES, parseRevenueHistory, parseEpsSurprises, revenueTrendLabel,
  recommendationScore, recommendationTrend, estimateRevisions, revisionsLabel,
  priceMomentum, pePercentile, fallingKnife, deriveTemporal, temporalForPrompt,
  temporalHeadline, withMomentum, isValueThesis,
} from '../api/_lib/temporal-fundamentals.js';
import { validateActions, temporalVeto } from '../api/_lib/arena-guard.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Fecha de referencia de los tests: relativa a hoy, nunca un literal (lint
// anti "relojes rotos" — un fixture con fecha tatuada envejece y miente).
const DAY = 86400000;
const NOW = new Date();
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

// ═══════════ 1. parseo de las fuentes crudas de Finnhub ═══════════
console.log('temporal: parseRevenueHistory (financials-reported → YoY por trimestre)');

// Payload con la forma de `stock/financials-reported?freq=quarterly`: 8
// trimestres para poder derivar 4 YoY. Ingresos que DESACELERAN.
const finReport = (year, quarter, revenue, extra = []) => ({
  year, quarter, endDate: null, filedDate: null,
  report: { ic: [{ concept: 'us-gaap_CostOfRevenue', value: revenue * 0.55 }, ...extra,
    { concept: 'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax', value: revenue }] },
});
const finPayload = { data: [
  finReport(2026, 2, 2530), finReport(2026, 1, 2410),
  finReport(2025, 4, 3610), finReport(2025, 3, 2400),
  finReport(2025, 2, 2483), finReport(2025, 1, 2286),
  finReport(2024, 4, 3205), finReport(2024, 3, 2064),
] };
const rev = parseRevenueHistory(finPayload);
ok(rev.length === 8 && rev.filter((r) => r.yoy_pct != null).length === 4,
  'los 8 trimestres viajan; el YoY solo donde HAY comparable del año anterior (el resto null, no inventado)',
  JSON.stringify(rev.map((r) => [r.label, r.yoy_pct])));
ok(rev[0].label === 'FY2026 Q2' && rev[0].yoy_pct === 1.9, 'YoY del trimestre más reciente (2530 vs 2483 = +1.9%)', JSON.stringify(rev[0]));
ok(rev[1].yoy_pct === 5.4, 'YoY del anterior (2410 vs 2286 = +5.4%)', String(rev[1].yoy_pct));
ok(rev[0].revenue === 2530, 'la línea de ingresos NO es el costo de ingresos (concepto prioritario, no el primero que matchea)', String(rev[0].revenue));

console.log('temporal: parseEpsSurprises (stock/earnings → sorpresa por trimestre)');
const epsPayload = [
  { year: 2026, quarter: 2, period: daysAgo(33), actual: 3.15, estimate: 3.08, surprisePercent: 2.27 },
  { year: 2026, quarter: 1, period: daysAgo(124), actual: 2.60, estimate: 2.56 },
  { year: 2025, quarter: 4, period: daysAgo(215), actual: 6.14, estimate: 5.96 },
];
const eps = parseEpsSurprises(epsPayload);
ok(eps.length === 3 && eps[0].label === 'FY2026 Q2', 'ordenado más reciente primero, con etiqueta de trimestre fiscal', JSON.stringify(eps.map((e) => e.label)));
ok(eps[0].surprise_pct === 2.3, 'usa el surprisePercent de Finnhub cuando viene', String(eps[0].surprise_pct));
ok(eps[1].surprise_pct === 1.6, 'lo recomputa ((actual−est)/|est|) cuando falta', String(eps[1].surprise_pct));

// ═══════════ 2. etiqueta de tendencia de ingresos ═══════════
console.log('temporal: revenueTrendLabel (acelerando / estable / desacelerando N)');
const decel = [{ yoy_pct: 1.9 }, { yoy_pct: 5.4 }, { yoy_pct: 10.1 }, { yoy_pct: 15.9 }];
const t1 = revenueTrendLabel(decel);
ok(t1.label === 'decelerating' && t1.consecutive_quarters === 3, 'desacelerando 3 trimestres seguidos', JSON.stringify(t1));
const accel = [{ yoy_pct: 18.0 }, { yoy_pct: 12.0 }, { yoy_pct: 9.0 }];
ok(revenueTrendLabel(accel).label === 'accelerating', 'acelerando cuando el YoY sube trimestre a trimestre');
const flat = [{ yoy_pct: 2.9 }, { yoy_pct: 3.1 }, { yoy_pct: 3.3 }];
ok(revenueTrendLabel(flat).label === 'stable', 'variación menor al umbral (1.0 pp) = estable, no desacelerando', JSON.stringify(revenueTrendLabel(flat)));
ok(revenueTrendLabel([{ yoy_pct: 5 }]).label === 'no_data', 'un solo trimestre no es tendencia → no_data');
// La racha CORTA cuando un trimestre rompe la secuencia.
const mixed = [{ yoy_pct: 4.0 }, { yoy_pct: 9.0 }, { yoy_pct: 8.5 }, { yoy_pct: 14.0 }];
ok(revenueTrendLabel(mixed).consecutive_quarters === 1, 'la racha se corta en el trimestre que no desacelera', JSON.stringify(revenueTrendLabel(mixed)));

// ═══════════ 3. revisiones ═══════════
console.log('temporal: revisiones (estimados propios > proxy de rating)');
ok(recommendationScore({ strongBuy: 10, buy: 10, hold: 0, sell: 0, strongSell: 0 }) === 1.5, 'score neto en escala −2..+2', String(recommendationScore({ strongBuy: 10, buy: 10, hold: 0, sell: 0, strongSell: 0 })));
const recs = [
  { period: daysAgo(2), strongBuy: 3, buy: 6, hold: 14, sell: 4, strongSell: 1 },
  { period: daysAgo(31), strongBuy: 4, buy: 8, hold: 13, sell: 2, strongSell: 1 },
  { period: daysAgo(92), strongBuy: 8, buy: 11, hold: 8, sell: 1, strongSell: 0 },
];
const rt = recommendationTrend(recs, { now: NOW });
ok(rt.delta_90d < TEMPORAL_RULES.revision_rating_down, 'el rating se deterioró contra 90 días atrás', JSON.stringify(rt));
ok(revisionsLabel({ rating: rt }).label === 'down' && revisionsLabel({ rating: rt }).source === 'analyst_rating_trend',
  'fallback día 0: la etiqueta viaja con su FUENTE (proxy, no revisión de estimados)', JSON.stringify(revisionsLabel({ rating: rt })));

// Historial propio de estimados: solo compara snapshots del MISMO periodo fiscal.
const estHistory = [
  { date: daysAgo(1), period: daysAgo(-20), eps: 2.80, revenue: 2600 },
  { date: daysAgo(32), period: daysAgo(-20), eps: 3.05, revenue: 2660 },
  { date: daysAgo(95), period: daysAgo(-20), eps: 3.20, revenue: 2700 },
  { date: daysAgo(120), period: daysAgo(-110), eps: 9.99, revenue: 9999 }, // otro trimestre → se ignora
];
const er = estimateRevisions(estHistory, { now: NOW });
ok(er && er.eps_change_90d != null && er.eps_change_90d < 0, 'revisión de estimados a 90d, mismo periodo fiscal', JSON.stringify(er));
const revLabel = revisionsLabel({ estimates: er, rating: rt });
ok(revLabel.label === 'down' && revLabel.source === 'estimate_revision', 'con historial propio, la revisión REAL gana sobre el proxy de rating', JSON.stringify(revLabel));
const otherPeriodOnly = estimateRevisions([{ date: daysAgo(1), period: 'A', eps: 3 }, { date: daysAgo(40), period: 'B', eps: 5 }], { now: NOW });
ok(otherPeriodOnly === null, 'no compara estimados de trimestres DISTINTOS (eso no es una revisión)');
ok(revisionsLabel({}).label === 'no_data', 'sin ninguna fuente → no_data explícito');

// ═══════════ 4. momentum de precio ═══════════
console.log('temporal: priceMomentum (1m/3m/6m, máximo 52s, SMA200 descriptiva)');
// Serie sintética de 260 sesiones: sube hasta la sesión 100 y luego baja.
const dates = [], closes = [];
for (let i = 0; i < 260; i++) {
  dates.push(new Date(NOW.getTime() - (260 - i) * DAY).toISOString().slice(0, 10));
  closes.push(i <= 100 ? 100 + i * 0.8 : 180 - (i - 100) * 0.45);
}
const mom = priceMomentum({ dates, closes });
ok(mom.ret_3m < 0 && mom.ret_6m < 0 && mom.ret_1m < 0, 'retornos negativos en un tramo bajista', JSON.stringify({ r1: mom.ret_1m, r3: mom.ret_3m, r6: mom.ret_6m }));
ok(mom.dist_52w_high_pct < 0, 'distancia al máximo de 52 semanas, negativa por debajo del máximo', String(mom.dist_52w_high_pct));
ok(mom.above_sma200 === false, 'bajo la SMA200 (DATO, no breaker)', String(mom.above_sma200));
ok(mom.as_of === dates[dates.length - 1], 'el momentum viaja con la fecha de su último cierre', mom.as_of);
const short = priceMomentum({ dates: dates.slice(-30), closes: closes.slice(-30) });
ok(short.ret_6m === null && short.above_sma200 === null && short.dist_52w_high_pct === null,
  'sin historia suficiente los campos salen null, nunca inventados', JSON.stringify(short));

// ═══════════ 5. cuchillo cayendo ═══════════
console.log('temporal: percentil de P/E + flag CUCHILLO CAYENDO');
const universePes = Array.from({ length: 60 }, (_, i) => 6 + i);       // P/E de 6 a 65
ok(pePercentile(10.3, universePes) <= TEMPORAL_RULES.falling_knife_pe_percentile, 'P/E 10.3 cae en el tercil barato del universo', String(pePercentile(10.3, universePes)));
ok(pePercentile(45, universePes) > TEMPORAL_RULES.falling_knife_pe_percentile, 'P/E 45 no es barato', String(pePercentile(45, universePes)));
ok(pePercentile(10, [12, 14]) === null, 'sin distribución utilizable (<20 nombres) → null, y el flag cae al umbral absoluto');

const knifeMom = { ret_1m: -0.09, ret_3m: -0.22, ret_6m: -0.35, dist_52w_high_pct: -42.0, above_sma200: false, as_of: daysAgo(1) };
const knifeTrend = { label: 'decelerating', consecutive_quarters: 3 };
const k1 = fallingKnife({ peTtm: 10.3, peRank: 12, momentum: knifeMom, trend: knifeTrend, revisions: { label: 'down', source: 'analyst_rating_trend' } });
ok(k1.flag === true && k1.reasons.length >= 3, 'barato + cayendo + deteriorándose = cuchillo cayendo, con sus razones en texto', JSON.stringify(k1.reasons));
ok(fallingKnife({ peTtm: 10.3, peRank: 12, momentum: { ret_3m: 0.14, ret_6m: 0.30 }, trend: knifeTrend, revisions: { label: 'down' } }).flag === false,
  'barato y deteriorándose PERO subiendo → no es cuchillo');
ok(fallingKnife({ peTtm: 10.3, peRank: 12, momentum: knifeMom, trend: { label: 'accelerating', consecutive_quarters: 2 }, revisions: { label: 'up' } }).flag === false,
  'barato y cayendo PERO acelerando → no es cuchillo (puede ser la oportunidad)');
ok(fallingKnife({ peTtm: 42, peRank: 78, momentum: knifeMom, trend: knifeTrend, revisions: { label: 'down' } }).flag === false,
  'cayendo y deteriorándose PERO caro → no es cuchillo (es otro problema)');

// ═══════════ 6. LULU al 3-ago ═══════════
console.log('temporal: CASO LULU (datos al 3-ago) → cuchillo cayendo + rechazo del guard');
const LULU = deriveTemporal({
  revenueHistory: [
    { year: 2026, quarter: 2, label: 'FY2026 Q2', filed: daysAgo(33), yoy_pct: 1.9, revenue: 2530 },
    { year: 2026, quarter: 1, label: 'FY2026 Q1', filed: daysAgo(124), yoy_pct: 5.4, revenue: 2410 },
    { year: 2025, quarter: 4, label: 'FY2025 Q4', filed: daysAgo(215), yoy_pct: 10.1, revenue: 3610 },
    { year: 2025, quarter: 3, label: 'FY2025 Q3', filed: daysAgo(306), yoy_pct: 15.9, revenue: 2400 },
  ],
  epsSurprises: [
    { year: 2026, quarter: 2, label: 'FY2026 Q2', surprise_pct: 2.3 },
    { year: 2026, quarter: 1, label: 'FY2026 Q1', surprise_pct: 1.6 },
  ],
  recTrend: rt,
  momentum: knifeMom,
  peTtm: 10.3, universePes, now: NOW,
});
ok(LULU.revenue_trend.label === 'decelerating' && LULU.revenue_trend.consecutive_quarters === 3,
  'LULU: tendencia_ingresos = desacelerando 3 trimestres seguidos', JSON.stringify(LULU.revenue_trend));
ok(LULU.revisions.label === 'down', 'LULU: revisiones a la baja', JSON.stringify(LULU.revisions));
ok(LULU.falling_knife.flag === true, 'LULU: FLAG CUCHILLO CAYENDO activo', JSON.stringify(LULU.falling_knife.reasons));
ok(LULU.guidance.available === false && LULU.guidance.direction === null,
  'LULU: la guía se declara AUSENTE (el tier gratis no la expone), no se inventa');
// La trampa exacta del caso: el EPS venía batiendo mientras los ingresos frenaban.
ok(LULU.eps_surprise_history[0].surprise_pct > 0 && LULU.revenue_trend.label === 'decelerating',
  'LULU: la trampa — EPS bateando con ingresos desacelerando, ambas cosas visibles a la vez');

const luluPrompt = temporalForPrompt(LULU, NOW);
ok(luluPrompt.revenue_trend === 'decelerating (3 consecutive quarter(s))', 'LULU: la etiqueta llega al prompt en texto', luluPrompt.revenue_trend);
ok(/days ago \(/.test(luluPrompt.revenue_yoy_by_quarter[0].reported),
  'LULU: cada trimestre viaja CON FECHA relativa ya calculada (patrón relativeDayLabel)', JSON.stringify(luluPrompt.revenue_yoy_by_quarter[0]));
ok(luluPrompt.price_momentum.return_3m === '-22.0%' && luluPrompt.price_momentum.vs_52w_high === '-42.0%',
  'LULU: los retornos llegan YA FORMATEADOS (el PM no re-escala)', JSON.stringify(luluPrompt.price_momentum));
ok(luluPrompt.falling_knife === true && typeof luluPrompt.falling_knife_why === 'string',
  'LULU: el flag se le MUESTRA al PM con su porqué', luluPrompt.falling_knife_why);

// La compra "value" del 4-ago, tal como la propuso el PM.
const luluBuy = { symbol: 'LULU', side: 'buy', notional: 12000, limit_price: 200,
  conviction: 4, reasoning: 'Deep value: P/E ~10 with 31% ROE and zero debt — the market is overreacting.' };
ok(isValueThesis(luluBuy, LULU).value === true, 'LULU: la tesis se reconoce como VALUE por el lenguaje del reasoning');
ok(isValueThesis({ ...luluBuy, reasoning: 'x' }, { screens: ['value'] }).value === true, 'la screen VALUE también marca la tesis (determinista, sin leer al LLM)');
const veto = temporalVeto(luluBuy, LULU);
ok(typeof veto === 'string' && /desacelerando 3 trimestres/.test(veto) && /LULU/.test(veto),
  'LULU: la regla temporal la veta con razón TEXTUAL', veto);
ok(/YoY/.test(veto), 'LULU: la razón cita la serie de YoY que la condena', veto);

// De punta a punta por el guard.
const guardBase = {
  equity: 100000, cash: 100000, positions: [],
  symbolMap: { LULU: 'LULULEMON ATHLETICA INC', ZM: 'ZOOM COMMUNICATIONS INC' },
  symbolTypes: { LULU: 'Common Stock', ZM: 'Common Stock' },
  lastCloses: { LULU: 200, ZM: 78 },
};
const g1 = validateActions({ ...guardBase, actions: [luluBuy], temporal: { LULU } });
ok(g1.approved.length === 0 && g1.discarded.length === 1, 'GUARD: la compra de LULU se DESCARTA (no se ajusta, se descarta)', JSON.stringify(g1.discarded[0] && g1.discarded[0].reason));
ok(/cuchillo/i.test(g1.discarded[0].reason), 'GUARD: la razón journaleada nombra la regla', g1.discarded[0].reason);
// Y la VENTA del mismo nombre nunca se bloquea: salir de un deterioro es el punto.
const g2 = validateActions({
  ...guardBase, positions: [{ symbol: 'LULU', qty: 60, market_value: 12000 }],
  actions: [{ symbol: 'LULU', side: 'sell', notional: 12000, limit_price: 200, reasoning: 'value thesis broke' }],
  temporal: { LULU },
});
ok(g2.approved.length === 1, 'GUARD: la regla NO toca las ventas (salir del deterioro es lo que queremos)', JSON.stringify(g2.discarded));

// ═══════════ 7. ZM tal como el PM lo propuso hoy ═══════════
console.log('temporal: CASO ZM (misma foto que LULU) → la película decide');
const zmMom = { ret_1m: -0.04, ret_3m: -0.12, ret_6m: -0.18, dist_52w_high_pct: -24.0, above_sma200: false, as_of: daysAgo(1) };
const zmRecs = [
  { period: daysAgo(2), strongBuy: 4, buy: 7, hold: 15, sell: 1, strongSell: 0 },
  { period: daysAgo(33), strongBuy: 4, buy: 7, hold: 15, sell: 1, strongSell: 0 },
  { period: daysAgo(91), strongBuy: 4, buy: 8, hold: 14, sell: 1, strongSell: 0 },
];
const ZM = deriveTemporal({
  revenueHistory: [
    { year: 2026, quarter: 2, label: 'FY2026 Q2', filed: daysAgo(5), yoy_pct: 2.9 },
    { year: 2026, quarter: 1, label: 'FY2026 Q1', filed: daysAgo(96), yoy_pct: 3.1 },
    { year: 2025, quarter: 4, label: 'FY2025 Q4', filed: daysAgo(187), yoy_pct: 3.3 },
    { year: 2025, quarter: 3, label: 'FY2025 Q3', filed: daysAgo(278), yoy_pct: 3.6 },
  ],
  epsSurprises: [{ year: 2026, quarter: 2, label: 'FY2026 Q2', surprise_pct: 5.1 }],
  recTrend: recommendationTrend(zmRecs, { now: NOW }),
  momentum: zmMom, peTtm: 8.64, universePes, now: NOW,
});
ok(ZM.revenue_trend.label === 'stable', 'ZM: ingresos planos (−0.2 pp por trimestre) = estable, no desacelerando', JSON.stringify(ZM.revenue_trend));
ok(ZM.revisions.label === 'neutral', 'ZM: revisiones neutras', JSON.stringify(ZM.revisions));
ok(ZM.falling_knife.flag === false && ZM.falling_knife.checks.cheap === true && ZM.falling_knife.checks.falling === true,
  'ZM: barata y cayendo, pero SIN deterioro → no es cuchillo cayendo', JSON.stringify(ZM.falling_knife));

const zmBuy = { symbol: 'ZM', side: 'buy', notional: 8000, limit_price: 78, conviction: 3,
  reasoning: 'Same setup as before: P/E 8.64, 32% ROE, zero debt — cheap quality.' };
const g3 = validateActions({ ...guardBase, actions: [zmBuy], temporal: { ZM } });
ok(g3.approved.length === 1, 'GUARD: ZM tal como se propuso PASA — la regla filtra deterioro, no baratura', JSON.stringify(g3.discarded));
ok(g3.approved[0].temporal && g3.approved[0].temporal.revenue_trend === 'stable' && g3.approved[0].temporal.falling_knife === false,
  'GUARD: la aprobada journalea la película que el guard tuvo enfrente', JSON.stringify(g3.approved[0].temporal));
// Y el PM la ve completa, no como foto.
const zmPrompt = temporalForPrompt(ZM, NOW);
ok(zmPrompt.price_momentum.return_6m === '-18.0%' && zmPrompt.price_momentum.above_sma200 === false,
  'ZM: el PM ya no ve una foto — recibe 6 meses de retorno y su posición vs. SMA200', JSON.stringify(zmPrompt.price_momentum));

// Misma foto, película en rojo → sí se rechaza.
const ZM_DOWN = { ...ZM, revisions: { label: 'down', source: 'estimate_revision', change: -0.08, detail: null } };
ZM_DOWN.falling_knife = fallingKnife({ peTtm: 8.64, peRank: ZM.pe_percentile, momentum: zmMom, trend: ZM_DOWN.revenue_trend, revisions: ZM_DOWN.revisions });
const g4 = validateActions({ ...guardBase, actions: [zmBuy], temporal: { ZM: ZM_DOWN } });
ok(g4.approved.length === 0 && /revisiones a la baja/.test(g4.discarded[0].reason),
  'GUARD: MISMA foto con revisiones a la baja → rechazada', g4.discarded[0] && g4.discarded[0].reason);

// ═══════════ 8. bordes de la regla ═══════════
console.log('temporal: bordes de la REGLA TEMPORAL');
// Sin datos NO se bloquea (y queda journaleado como no_data — ver docs).
const g5 = validateActions({ ...guardBase, actions: [zmBuy], temporal: {} });
ok(g5.approved.length === 1 && g5.approved[0].temporal.revenue_trend === 'no_data',
  'sin película NO se rechaza, pero la ceguera queda journaleada (no_data)', JSON.stringify(g5.approved[0].temporal));
// Un solo trimestre desacelerando no alcanza para el veto (≥2 es la regla).
const oneQ = deriveTemporal({
  revenueHistory: [{ year: 2026, quarter: 2, label: 'FY2026 Q2', yoy_pct: 8.0 }, { year: 2026, quarter: 1, label: 'FY2026 Q1', yoy_pct: 14.0 }],
  momentum: { ret_3m: -0.02, ret_6m: 0.05 }, peTtm: 11, universePes, now: NOW,
});
ok(oneQ.revenue_trend.consecutive_quarters === 1 && temporalVeto(zmBuy, oneQ) === null,
  '1 trimestre desacelerando no veta (el umbral es ≥2 seguidos)', JSON.stringify(oneQ.revenue_trend));
// Una compra SIN tesis value y sin flag no se veta aunque el negocio frene.
const noThesis = { symbol: 'ZM', side: 'buy', notional: 8000, limit_price: 78, reasoning: 'Breakout above resistance on heavy volume.' };
const decelOnly = deriveTemporal({
  revenueHistory: decel.map((q, i) => ({ year: 2026, quarter: 2 - i, label: `FY2026 Q${2 - i}`, ...q })),
  momentum: { ret_3m: 0.20, ret_6m: 0.35 }, peTtm: 55, universePes, now: NOW,
});
ok(temporalVeto(noThesis, decelOnly) === null, 'compra de momentum (cara, subiendo, sin tesis value) no la toca la regla');
ok(temporalVeto({ ...noThesis, side: 'buy', reasoning: 'cheap multiple' }, decelOnly) !== null,
  'la misma compra CON tesis de valuación sí se veta');

// withMomentum re-evalúa el flag con precio fresco (un rebote lo apaga).
console.log('temporal: withMomentum (precio fresco re-evalúa el flag)');
const rebound = withMomentum(LULU, { ret_1m: 0.12, ret_3m: 0.18, ret_6m: 0.05, dist_52w_high_pct: -12.0, above_sma200: true, as_of: daysAgo(1) });
ok(rebound.falling_knife.flag === false, 'un nombre que rebotó deja de estar marcado (el flag no se queda pegado)');
ok(rebound.revenue_trend.label === 'decelerating', '…pero la tendencia de ingresos NO cambia por el precio');

// La vista TITULAR (SCAN + posiciones del libro) no pierde lo importante.
const head = temporalHeadline(LULU);
ok(head.revenue_trend === 'decelerating (3q)' && head.falling_knife === true && head.return_3m === '-22.0%',
  'titular: etiqueta, retornos y flag en una línea (para el SCAN y el libro)', JSON.stringify(head));
ok(temporalHeadline(ZM).falling_knife === undefined, 'titular: el flag solo aparece cuando está activo (silencio = no marcado)');

console.log(failures ? `\n${failures} FALLARON` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
