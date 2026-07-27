// ═══════════════════════════════════════════════════════════════
// Tests de las screens deterministas del canal screener (_lib/screens.js).
// Puro, sin I/O. Value + momentum, ranking, top-N, y el CANDADO de precio:
// los qualifiers NUNCA llevan un precio absoluto (solo ratios/%).
// Correr con `node tests/screens.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { computeScreens, screenerRankedSymbols } from '../api/_lib/screens.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Fila cruda de arena_screener.
const row = (o) => ({
  symbol: 'X', security_type: 'Common Stock',
  last_close: null, ma50: null, ma200: null,
  pe_ttm: null, ps_ttm: null, gross_margin: null, net_margin: null,
  debt_to_equity: null, roe_ttm: null, rev_growth_yoy: null, ...o,
});

console.log('screens: VALUE (P/E bajo + ROE alto + deuda baja)');
const rows = [
  row({ symbol: 'KO', pe_ttm: 18, roe_ttm: 40, debt_to_equity: 0.5 }),   // califica value
  row({ symbol: 'JNJ', pe_ttm: 15, roe_ttm: 25, debt_to_equity: 0.4 }),  // califica value
  row({ symbol: 'HIGHPE', pe_ttm: 35, roe_ttm: 40, debt_to_equity: 0.2 }), // P/E>20 → fuera
  row({ symbol: 'LOWROE', pe_ttm: 12, roe_ttm: 8, debt_to_equity: 0.3 }),  // ROE<15 → fuera
  row({ symbol: 'LEVERED', pe_ttm: 10, roe_ttm: 30, debt_to_equity: 2.0 }),// deuda>1 → fuera
];
const s1 = computeScreens(rows, { topN: 5 });
ok(s1.value.length === 2, 'value: solo pasan los que cumplen las 3 condiciones', JSON.stringify(s1.value.map((v) => v.symbol)));
// KO rank = 40/18 = 2.22 > JNJ 25/15 = 1.67 → KO primero
ok(s1.value[0].symbol === 'KO' && s1.value[1].symbol === 'JNJ', 'value: rankeado por roe/pe (KO antes que JNJ)', JSON.stringify(s1.value.map((v) => v.symbol)));
ok(s1.value[0].screen === 'value' && s1.value[0].qualifiers.pe_ttm === 18 && s1.value[0].qualifiers.roe_ttm === 40 && s1.value[0].qualifiers.debt_to_equity === 0.5,
  'value: candidato llega con los números que lo calificaron', JSON.stringify(s1.value[0]));

console.log('screens: MOMENTUM (precio > MA50 > MA200, sin blowoffs)');
const mrows = [
  row({ symbol: 'NVDA', last_close: 150, ma50: 130, ma200: 110 }),  // uptrend, +15.4% sobre MA50
  row({ symbol: 'MSFT', last_close: 420, ma50: 400, ma200: 380 }),  // uptrend, +5%
  row({ symbol: 'DOWN', last_close: 90, ma50: 100, ma200: 110 }),   // bajo MA50 → fuera
  row({ symbol: 'BLOWOFF', last_close: 200, ma50: 140, ma200: 120 }), // +42.8% → extendido, fuera
  row({ symbol: 'NOHIST', last_close: 50, ma50: 48, ma200: null }),  // sin MA200 → fuera
];
const s2 = computeScreens(mrows, { topN: 5 });
ok(s2.momentum.length === 2, 'momentum: uptrend sano, sin blowoffs ni sin-historia', JSON.stringify(s2.momentum.map((m) => m.symbol)));
ok(s2.momentum[0].symbol === 'NVDA', 'momentum: rankeado por % sobre MA50 (NVDA +15% antes que MSFT +5%)', JSON.stringify(s2.momentum.map((m) => m.symbol)));
ok(s2.momentum[0].qualifiers.above_ma50_pct === 15.4 && s2.momentum[0].qualifiers.above_ma200 === true,
  'momentum: qualifier con % sobre MA50 y flag sobre MA200', JSON.stringify(s2.momentum[0].qualifiers));

console.log('screens: CANDADO de precio — qualifiers sin precio absoluto');
// Ni value ni momentum deben exponer last_close/ma50/ma200/un precio en dólares.
const allQualifiers = [...s1.value, ...s2.momentum].map((c) => JSON.stringify(c.qualifiers));
const priceKeyLeak = [...s1.value, ...s2.momentum].some((c) => {
  const k = Object.keys(c.qualifiers);
  return k.includes('last_close') || k.includes('ma50') || k.includes('ma200') || k.includes('price');
});
ok(!priceKeyLeak, 'CANDADO: ningún qualifier expone last_close/ma50/ma200/price (el precio del screener NO llega a la decisión)', allQualifiers.join(' | '));
// El objeto candidato completo tampoco (solo symbol/screen/qualifiers).
const shapeOk = [...s1.value, ...s2.momentum].every((c) => Object.keys(c).sort().join(',') === 'qualifiers,screen,symbol');
ok(shapeOk, 'CANDADO: el candidato es {symbol, screen, qualifiers} — sin campo de precio');

console.log('screens: top-N y filtro de no-equity');
const many = Array.from({ length: 8 }, (_, i) => row({ symbol: 'V' + i, pe_ttm: 10, roe_ttm: 20 + i, debt_to_equity: 0.3 }));
ok(computeScreens(many, { topN: 5 }).value.length === 5, 'top-N recorta a 5');
const nonEq = [row({ symbol: 'PREF', security_type: 'Preference', pe_ttm: 10, roe_ttm: 30, debt_to_equity: 0.2 })];
ok(computeScreens(nonEq).value.length === 0, 'no-equity (Preference) excluido aunque cumpla los números (defensa en profundidad)');

console.log('screens: screenerRankedSymbols (unión value→momentum, dedupe)');
const ranked = screenerRankedSymbols({ value: [{ symbol: 'KO' }, { symbol: 'NVDA' }], momentum: [{ symbol: 'NVDA' }, { symbol: 'MSFT' }] });
ok(ranked.join(',') === 'KO,NVDA,MSFT', 'unión rankeada value primero, dedupe (NVDA una vez)', ranked.join(','));

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
