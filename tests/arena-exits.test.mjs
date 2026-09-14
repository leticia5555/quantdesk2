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
  mergeExits, exitReference, riskExitLimit, exitBand, buildRiskExits, EXIT_RULES,
  trailingState, planTrailingStops, timeStopState,
} from '../api/_lib/arena-exits.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// rules fijas para el test (independientes de env):
const RULES = {
  breaker_delever_dd: 0.15, breaker_broadcut_dd: 0.20, breaker_delever_trim: 0.33,
  catastrophic_stop_pct: 0.22,
  exit_band_breaker: 0.12, exit_band_catastrophic: 0.32,
  exit_escalation_step: 0.13, exit_band_max: 0.70,
  // T2: trailing de ganancia + time stop (el time stop NO vende, se prueba abajo).
  trailing_arm_gain: 0.15, trailing_give_back: 0.08, exit_band_trailing: 0.12,
  time_stop_days: 45,
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

// delever: dd 16% → recorta PRO-RATA en TODAS (incluida la ganadora WIN); NO
// vende "los perdedores" (esa apuesta direccional es la que destruye valor).
b = planBreaker({ equity: 84, peak: 100, positions: POS, rules: RULES });
const dSyms = b.exits.map((e) => e.symbol);
ok(b.stage === 'delever', 'dd 16% → stage delever', b.stage);
ok(dSyms.includes('WEAK') && dSyms.includes('MEH') && dSyms.includes('WIN') && dSyms.length === 3,
  'delever recorta PRO-RATA las TRES (no selecciona perdedores)', JSON.stringify(dSyms));
const weakExit = b.exits.find((e) => e.symbol === 'WEAK');
const winExit = b.exits.find((e) => e.symbol === 'WIN');
ok(weakExit.qty === Math.floor(100 * 0.33) && winExit.qty === Math.floor(10 * 0.33) && weakExit.reason_code === 'breaker_delever',
  'recorta floor(qty×0.33) de cada una: WEAK 33, WIN 3 (misma fracción, no apuesta)', JSON.stringify({ w: weakExit.qty, win: winExit.qty }));
ok(/PRO-RATA/.test(weakExit.detail), 'el detail deja claro que es pro-rata', weakExit.detail);

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
ok(riskExitLimit(100, 0.12) === 88, 'marketable limit = 100×(1−0.12) = 88 (banda breaker)');
ok(riskExitLimit(100, 0.32) === 68, 'marketable limit = 100×(1−0.32) = 68 (banda catastrófica, mucho más ancha)');
ok(riskExitLimit(100, 1.2) === null, 'banda ≥1 → null (no se opera con límite negativo)');

console.log('arena-exits: DOS bandas + escalamiento del stop catastrófico');
ok(exitBand(['breaker_delever'], RULES) === 0.12 && exitBand(['breaker_broadcut'], RULES) === 0.12,
  'delever/broadcut → banda breaker 12%', exitBand(['breaker_delever'], RULES));
ok(exitBand(['catastrophic_stop'], RULES) === 0.32, 'stop catastrófico sin reintentos → banda 32%');
ok(exitBand(['catastrophic_stop'], RULES, 1) === 0.45 && exitBand(['catastrophic_stop'], RULES, 2) === 0.58,
  'escalamiento: cada reintento fallido ensancha +13% (0.32→0.45→0.58)', exitBand(['catastrophic_stop'], RULES, 2));
ok(exitBand(['catastrophic_stop'], RULES, 99) === 0.70, 'escalamiento capado en exit_band_max (70%)');
ok(exitBand(['catastrophic_stop', 'breaker_delever'], RULES, 1) === 0.45, 'nombre con stop+delever → usa la banda catastrófica (la ancha)');

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
ok(weak && weak.side === 'sell' && weak.limit_price === Math.round(30 * 0.68 * 100) / 100, 'WEAK: marketable limit banda catastrófica sobre el cierre 30 = 20.4', JSON.stringify(weak && weak.limit_price));
// pro-rata: WIN (ganadora) SÍ se recorta en delever (baja exposición sin apostar)
const win = built.approved.find((a) => a.symbol === 'WIN');
ok(win && win.qty === Math.floor(10 * 0.33) && win.reason_codes.includes('breaker_delever'), 'la ganadora WIN se recorta pro-rata (3), banda breaker', JSON.stringify(win && { q: win.qty, l: win.limit_price }));
ok(win && win.limit_price === Math.round(130 * 0.88 * 100) / 100, 'WIN: banda breaker 12% (no catastrófica) = 114.4', JSON.stringify(win && win.limit_price));

// escalamiento end-to-end: WEAK con 2 reintentos previos → banda 0.58
const escalated = buildRiskExits({
  equity: 100, peak: 100,
  positions: [{ symbol: 'CRASH', qty: '10', avg_entry_price: '100', current_price: '50' }],
  closes: { CRASH: 50 }, rules: RULES, escalation: { CRASH: 2 },
});
const esc = escalated.approved.find((a) => a.symbol === 'CRASH');
ok(esc && esc.exit_attempt === 3 && esc.exit_band === 0.58 && esc.limit_price === Math.round(50 * 0.42 * 100) / 100,
  'escalamiento: 3er intento, banda 58%, limit 50×0.42=21 (journaleado para medir)', JSON.stringify(esc && { a: esc.exit_attempt, b: esc.exit_band, l: esc.limit_price }));
ok(esc && /reintento 3/.test(esc.reasoning), 'el reasoning registra el reintento (medible en el journal)', esc && esc.reasoning);

// broadcut domina: NO se evalúan stops, se liquida todo
const bc = buildRiskExits({ equity: 78, peak: 100, positions: [{ symbol: 'A', qty: '5', avg_entry_price: '10', current_price: '8' }], closes: { A: 8 }, rules: RULES });
ok(bc.stage === 'broadcut' && bc.approved.length === 1 && bc.approved[0].qty === 5, 'broadcut liquida todo vía buildRiskExits', JSON.stringify(bc.approved));

// sin referencia de precio → descartado (fail closed, ruidoso)
const noref = buildRiskExits({ equity: 78, peak: 100, positions: [{ symbol: 'GHOST', qty: '5' }], closes: {}, rules: RULES });
ok(noref.approved.length === 0 && noref.discarded.length === 1 && /sin referencia/.test(noref.discarded[0].reason),
  'sin referencia de precio → descartado y journaleado (no se opera a ciegas)', JSON.stringify(noref.discarded));

// EXIT_RULES por default existe y es coherente
ok(EXIT_RULES.breaker_delever_dd < EXIT_RULES.breaker_broadcut_dd, 'EXIT_RULES: delever < broadcut');
ok(EXIT_RULES.exit_band_breaker > 0.02 && EXIT_RULES.exit_band_catastrophic > EXIT_RULES.exit_band_breaker && EXIT_RULES.exit_band_catastrophic >= 0.30,
  'EXIT_RULES: dos bandas, catastrófica (≥30%) MUCHO más ancha que breaker, ambas > ±2% de entrada');

// ── T2 #3: TRAILING STOP de ganancia ────────────────────────────────
console.log('arena-exits: T2 #3 — trailing stop (protege ganancia, no es un stop apretado)');
const WIN = { symbol: 'WIN', qty: '10', avg_entry_price: '100', current_price: '118' };
const MEH = { symbol: 'MEH', qty: '10', avg_entry_price: '100', current_price: '96' };

let st = trailingState(WIN, 125, RULES);
ok(st.armed === true && st.arm_level === 115 && st.level === 115,
  'pico 125 sobre entrada 100 → ARMADO (umbral 115) y nivel de venta 125×0.92 = 115', JSON.stringify(st));
st = trailingState(MEH, 108, RULES);
ok(st.armed === false && st.level === null,
  'pico +8% NO llega al +15%: no arma y NO hay nivel de venta', JSON.stringify(st));
ok(trailingState(WIN, null, RULES) === null && trailingState({ symbol: 'X' }, 120, RULES) === null,
  'sin pico o sin entrada → null: el trailing NO se evalúa a ciegas');

// LA propiedad que lo distingue de un stop apretado: el nivel SIEMPRE queda
// sobre la entrada, así que una salida por trailing nunca realiza una pérdida.
const armedLevel = trailingState(WIN, 115, RULES).level;
ok(armedLevel > 100, 'el nivel armado más bajo posible (pico = umbral) YA está sobre la entrada: nunca vende en pérdida', String(armedLevel));

let tr = planTrailingStops({ positions: [WIN], closes: { WIN: 114 }, peaks: { WIN: 125 }, rules: RULES });
ok(tr.exits.length === 1 && tr.exits[0].qty === 10 && tr.exits[0].reason_code === 'trailing_stop',
  'cierre 114 bajo el nivel 115 → liquida la posición ENTERA', JSON.stringify(tr.exits));
ok(/pico/.test(tr.exits[0].detail) && /ganancia/.test(tr.exits[0].detail), 'el detail explica el pico y que sale con ganancia', tr.exits[0].detail);
tr = planTrailingStops({ positions: [WIN], closes: { WIN: 116 }, peaks: { WIN: 125 }, rules: RULES });
ok(tr.exits.length === 0, 'cierre 116 sobre el nivel → NO sale (todavía no devolvió el 8%)');
tr = planTrailingStops({ positions: [MEH], closes: { MEH: 96 }, peaks: { MEH: 108 }, rules: RULES });
ok(tr.exits.length === 0, 'una posición que nunca armó NO se vende aunque haya caído 11% desde su pico (Kaminski & Lo)');
tr = planTrailingStops({ positions: [WIN], closes: {}, peaks: { WIN: 125 }, rules: RULES });
ok(tr.exits.length === 0, 'sin cierre completo no se evalúa: un dato faltante no liquida por sorpresa');
tr = planTrailingStops({ positions: [WIN], closes: { WIN: 114 }, peaks: {}, rules: RULES });
ok(tr.exits.length === 0, 'sin pico reconstruido (posición anterior al journal) el trailing NO dispara');

console.log('arena-exits: T2 #3 — banda y precedencia del trailing');
ok(exitBand(['trailing_stop'], RULES) === RULES.exit_band_trailing, 'el trailing usa su propia banda de marketable limit');
ok(exitBand(['trailing_stop'], RULES, 3) === RULES.exit_band_trailing,
  'el trailing NO escala con los reintentos: su nivel se mueve con el pico, no con los intentos fallidos');
ok(exitBand(['trailing_stop', 'catastrophic_stop'], RULES, 1) > RULES.exit_band_trailing,
  'si un nombre cae en trailing Y catastrófico, manda la banda catastrófica (la más severa)');

// Integrado: un libro sano (sin drawdown de portafolio) con una ganadora que
// devolvió su pico → sale por trailing, con marketable limit y su atribución.
const integ = buildRiskExits({
  equity: 100, peak: 100,
  positions: [WIN, MEH],
  closes: { WIN: 114, MEH: 96 }, peaks: { WIN: 125, MEH: 108 }, rules: RULES,
});
ok(integ.stage === 'none' && integ.approved.length === 1 && integ.approved[0].symbol === 'WIN',
  'buildRiskExits: sin breaker, el trailing solo saca a la ganadora que devolvió el pico', JSON.stringify(integ.approved.map((a) => a.symbol)));
ok(integ.approved[0].origin === 'trailing_stop' && integ.approved[0].limit_price === +(114 * (1 - RULES.exit_band_trailing)).toFixed(2),
  'sale con origin trailing_stop y marketable limit = cierre × (1 − banda)', JSON.stringify(integ.approved[0]));
// Sin `peaks` (comportamiento T1 exacto): nada cambia.
const sinPicos = buildRiskExits({ equity: 100, peak: 100, positions: [WIN, MEH], closes: { WIN: 114, MEH: 96 }, rules: RULES });
ok(sinPicos.approved.length === 0, 'sin memoria de picos, buildRiskExits se comporta como en la Temporada 1 (cero salidas nuevas)');

// ── T2 #4: TIME STOP — obliga a pronunciarse, NO vende ──────────────
console.log('arena-exits: T2 #4 — el time stop no produce órdenes');
ok(timeStopState(46, RULES).due === true && timeStopState(44, RULES).due === false,
  'vence a los 45 días calendario', JSON.stringify([timeStopState(46, RULES).due, timeStopState(44, RULES).due]));
ok(timeStopState(null, RULES).due === false && timeStopState(null, RULES).days === null,
  'sin fecha de apertura no vence: no se exige sobre un dato que no existe');
const vieja = { symbol: 'OLD', qty: '10', avg_entry_price: '100', current_price: '95' };
const conVieja = buildRiskExits({ equity: 100, peak: 100, positions: [vieja], closes: { OLD: 95 }, peaks: { OLD: 101 }, rules: RULES });
ok(conVieja.approved.length === 0,
  'una posición vencida por time stop NO genera ninguna orden determinista: la obligación es de PRONUNCIARSE (la audita arena-memory)');

// EXIT_RULES por default: el trailing es coherente con el resto
ok(EXIT_RULES.trailing_arm_gain > EXIT_RULES.trailing_give_back,
  'EXIT_RULES: el umbral de armado (+15%) es mayor que lo que se devuelve (8%) → el trailing solo puede salir en ganancia',
  JSON.stringify({ arm: EXIT_RULES.trailing_arm_gain, give: EXIT_RULES.trailing_give_back }));
ok(EXIT_RULES.time_stop_days === 45, 'EXIT_RULES: time stop a 45 días', String(EXIT_RULES.time_stop_days));

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
