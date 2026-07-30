// ═══════════════════════════════════════════════════════════════
// tests/arena-exits.test.mjs — REGLA DE SALIDA determinista (unit).
//
// arena-exits.js es JS puro (sin I/O, sin LLM) como el guard, así que se
// prueba en aislamiento con `rules` inyectadas (no depende de env vars).
// Cubre: drawdown desde el pico, el breaker escalonado (none/delever/broadcut),
// el stop catastrófico ancho (cierre < nivel → salida), el merge de exits, y
// el orquestador buildRiskExits (marketable limit + fail-closed sin referencia).
// Correr con `node tests/arena-exits.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  computeDrawdown, planBreaker, catastrophicStopLevel, planCatastrophicStops,
  mergeExits, exitReference, riskExitLimit, buildRiskExits, EXIT_RULES,
} from '../api/_lib/arena-exits.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// rules fijas para el test (independientes de env):
const RULES = {
  breaker_delever_dd: 0.15, breaker_broadcut_dd: 0.20, breaker_delever_trim: 0.33,
  catastrophic_stop_pct: 0.22, exit_price_band: 0.12,
};

console.log('arena-exits: drawdown desde el pico');
ok(computeDrawdown(85, 100) === 0.15, 'drawdown 15% exacto', computeDrawdown(85, 100));
ok(computeDrawdown(120, 100) === 0, 'equity sobre el pico → drawdown 0 (no negativo)');
ok(computeDrawdown(90, 0) === 0 && computeDrawdown(90, null) === 0, 'pico ≤0/nulo (libro nuevo) → 0, nunca dispara');

console.log('arena-exits: circuit breaker escalonado');
const POS = [
  { symbol: 'WEAK', qty: '100', avg_entry_price: '50', market_value: '4000', unrealized_plpc: '-0.20', current_price: '40' },
  { symbol: 'MEH', qty: '30', avg_entry_price: '100', market_value: '2850', unrealized_plpc: '-0.05', current_price: '95' },
  { symbol: 'WIN', qty: '10', avg_entry_price: '100', market_value: '1300', unrealized_plpc: '0.30', current_price: '130' },
];

// none: dd 10% < 15%
let b = planBreaker({ equity: 90, peak: 100, positions: POS, rules: RULES });
ok(b.stage === 'none' && b.exits.length === 0, 'dd 10% → stage none, sin exits', JSON.stringify(b.stage));

// delever: dd 16% → recorta SOLO las débiles (plpc<0), la ganadora intacta
b = planBreaker({ equity: 84, peak: 100, positions: POS, rules: RULES });
const dSyms = b.exits.map((e) => e.symbol);
ok(b.stage === 'delever', 'dd 16% → stage delever', b.stage);
ok(dSyms.includes('WEAK') && dSyms.includes('MEH') && !dSyms.includes('WIN'),
  'delever recorta las DÉBILES (WEAK, MEH), NO la ganadora WIN', JSON.stringify(dSyms));
const weakExit = b.exits.find((e) => e.symbol === 'WEAK');
ok(weakExit.qty === Math.floor(100 * 0.33) && weakExit.reason_code === 'breaker_delever', 'recorta floor(qty×0.33)=33 de WEAK', JSON.stringify(weakExit));
ok(b.exits[0].symbol === 'WEAK', 'la MÁS débil (plpc más negativo) va primero', JSON.stringify(dSyms));

// broadcut: dd 22% → liquida TODO (incluye la ganadora)
b = planBreaker({ equity: 78, peak: 100, positions: POS, rules: RULES });
ok(b.stage === 'broadcut' && b.exits.length === 3, 'dd 22% → stage broadcut, liquida las 3', JSON.stringify(b.exits.length));
ok(b.exits.every((e) => e.reason_code === 'breaker_broadcut'), 'broadcut: todas reason_code breaker_broadcut');
ok(b.exits.find((e) => e.symbol === 'WIN').qty === 10, 'broadcut liquida la posición ENTERA (incluye ganadora)');

// recorte que no alcanza 1 acción → no se ajusta en silencio
const tiny = [{ symbol: 'T', qty: '2', avg_entry_price: '5', unrealized_plpc: '-0.30' }];
b = planBreaker({ equity: 84, peak: 100, positions: tiny, rules: RULES });
ok(b.exits.length === 0, 'delever: floor(2×0.33)=0 → no emite recorte fantasma');

console.log('arena-exits: stop catastrófico ancho por posición');
ok(catastrophicStopLevel({ symbol: 'X', avg_entry_price: '100' }, RULES) === 78, 'nivel = entrada×(1−0.22) = 78');
ok(catastrophicStopLevel({ symbol: 'X' }, RULES) === null, 'sin entrada → nivel null (no evalúa)');
ok(catastrophicStopLevel({ symbol: 'X', avg_entry_price: '100' }, RULES, { X: 60 }) === 60, 'override (vol-escalado futuro) gana sobre el fijo');

const stopPos = [
  { symbol: 'CRASH', qty: '20', avg_entry_price: '100' }, // nivel 78
  { symbol: 'FINE', qty: '20', avg_entry_price: '100' },  // nivel 78
  { symbol: 'NOENTRY', qty: '20' },                        // sin entrada
];
const stopCloses = { CRASH: 77, FINE: 79, NOENTRY: 10 };
const s = planCatastrophicStops({ positions: stopPos, closes: stopCloses, rules: RULES });
const sSyms = s.exits.map((e) => e.symbol);
ok(sSyms.length === 1 && sSyms[0] === 'CRASH', 'solo CRASH (cierre 77 < nivel 78) dispara; FINE (79) no', JSON.stringify(sSyms));
ok(s.exits[0].qty === 20 && s.exits[0].stop_level === 78, 'stop liquida la posición ENTERA con el nivel journaleado', JSON.stringify(s.exits[0]));
ok(!sSyms.includes('NOENTRY'), 'sin entrada/cierre → NO dispara a ciegas (fail-safe)');

console.log('arena-exits: merge de exits (breaker + stop del mismo nombre)');
const merged = mergeExits([
  [{ symbol: 'DUP', qty: 10, reason_code: 'breaker_delever', detail: 'trim' }],
  [{ symbol: 'DUP', qty: 30, reason_code: 'catastrophic_stop', detail: 'stop' }],
], [{ symbol: 'DUP', qty: '30' }]);
ok(merged.length === 1 && merged[0].qty === 30, 'mismo nombre en dos reglas → qty MAYOR (30), una sola orden', JSON.stringify(merged));
ok(merged[0].origin === 'catastrophic_stop', 'origin = el reason_code más severo (stop > delever)', merged[0].origin);
ok(merged[0].reason_codes.length === 2, 'ambos reason_codes se conservan para el post-mortem');
const capped = mergeExits([[{ symbol: 'C', qty: 999, reason_code: 'breaker_broadcut', detail: 'x' }]], [{ symbol: 'C', qty: '5' }]);
ok(capped[0].qty === 5, 'la qty se capa a lo que realmente hay (nunca sobrevende)');

console.log('arena-exits: referencia de precio + marketable limit ancho');
ok(exitReference({ symbol: 'A', current_price: '95', avg_entry_price: '100' }, { A: 90 }) === 90, 'referencia prioriza el cierre completo');
ok(exitReference({ symbol: 'A', current_price: '95', avg_entry_price: '100' }, {}) === 95, 'sin cierre → current_price de Alpaca');
ok(exitReference({ symbol: 'A', avg_entry_price: '100' }, {}) === 100, 'sin cierre ni current_price → avg_entry (nombre delisted igual se cierra)');
ok(exitReference({ symbol: 'A' }, {}) === null, 'sin ninguna referencia → null (fail closed)');
ok(riskExitLimit(100, RULES) === 88, 'marketable limit = 100×(1−0.12) = 88 (por DEBAJO del mercado, asegura fill)');

console.log('arena-exits: buildRiskExits orquestador de punta a punta');
// delever (dd 16%) + un stop catastrófico sobre WEAK (cierre 30 < nivel 39)
const built = buildRiskExits({
  equity: 84, peak: 100,
  positions: [
    { symbol: 'WEAK', qty: '100', avg_entry_price: '50', unrealized_plpc: '-0.20', current_price: '30' }, // stop nivel 39; cierre 30 < 39
    { symbol: 'WIN', qty: '10', avg_entry_price: '100', unrealized_plpc: '0.30', current_price: '130' },   // ganadora: intacta
  ],
  closes: { WEAK: 30, WIN: 130 },
  rules: RULES,
});
const weak = built.approved.find((a) => a.symbol === 'WEAK');
ok(built.stage === 'delever', 'stage delever propagado');
ok(weak && weak.qty === 100, 'WEAK: el stop (posición entera 100) gana sobre el recorte delever (33)', JSON.stringify(weak && weak.qty));
ok(weak && weak.reason_codes.includes('catastrophic_stop') && weak.reason_codes.includes('breaker_delever'), 'WEAK acumula ambos reason_codes', JSON.stringify(weak && weak.reason_codes));
ok(weak && weak.side === 'sell' && weak.limit_price === Math.round(30 * 0.88 * 100) / 100, 'WEAK: marketable limit sobre el cierre 30 = 26.4', JSON.stringify(weak && weak.limit_price));
ok(!built.approved.find((a) => a.symbol === 'WIN'), 'la ganadora WIN no se toca en delever');

// broadcut domina: NO se evalúan stops, se liquida todo
const bc = buildRiskExits({ equity: 78, peak: 100, positions: [{ symbol: 'A', qty: '5', avg_entry_price: '10', current_price: '8' }], closes: { A: 8 }, rules: RULES });
ok(bc.stage === 'broadcut' && bc.approved.length === 1 && bc.approved[0].qty === 5, 'broadcut liquida todo vía buildRiskExits', JSON.stringify(bc.approved));

// sin referencia de precio → descartado (fail closed, ruidoso)
const noref = buildRiskExits({ equity: 78, peak: 100, positions: [{ symbol: 'GHOST', qty: '5' }], closes: {}, rules: RULES });
ok(noref.approved.length === 0 && noref.discarded.length === 1 && /sin referencia/.test(noref.discarded[0].reason),
  'sin referencia de precio → descartado y journaleado (no se opera a ciegas)', JSON.stringify(noref.discarded));

// EXIT_RULES por default existe y es coherente (delever < broadcut)
ok(EXIT_RULES.breaker_delever_dd < EXIT_RULES.breaker_broadcut_dd && EXIT_RULES.exit_price_band > 0.02,
  'EXIT_RULES default: delever<broadcut y banda de exit MUCHO más ancha que el ±2% de entrada');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
