// ═══════════════════════════════════════════════════════════════
// tests/arena-red-corta.test.mjs — EL CABLE de la red corta (2026-09-18).
//
// `arena-exits-short.js` existía completo y probado desde B7... y NO LO
// IMPORTABA NADIE en `api/`. Un corto abierto habría corrido con rieles de
// admisión y CERO red de salida. Este archivo prueba el CABLE, no las piezas
// (ésas ya las cubre tests/arena-portafolio.test.mjs):
//
//   1. buildRiskExits planea los DOS lados y el lado viaja con cada salida.
//   2. El límite es SIMÉTRICO: venta por debajo, cobertura por ENCIMA.
//   3. El breaker ve los cortos (con heldQty los saltaba: un −20% habría
//      liquidado todos los largos y dejado los cortos abiertos).
//   4. El merge no borra la salida corta al capar la cantidad.
//   5. De punta a punta: el stop llega al broker como `buy`, no como `sell`.
//   6. Un libro SIN cortos se comporta EXACTAMENTE como antes del cable.
//
// Correr con `node tests/arena-red-corta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  buildRiskExits, planBreaker, mergeExits, riskExitLimit, exitBand,
  posicionCerrable, LADO_VENTA, LADO_COBERTURA, ALPACA_SIDE,
} from '../api/_lib/arena-exits.js';
import { SHORT_RULES } from '../api/_lib/arena-exits-short.js';
import { submitRiskExits } from '../api/arena-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const RULES = {
  breaker_delever_dd: 0.15, breaker_broadcut_dd: 0.20, breaker_delever_trim: 0.33,
  catastrophic_stop_pct: 0.22,
  exit_band_breaker: 0.12, exit_band_catastrophic: 0.32, exit_band_trailing: 0.12,
  exit_escalation_step: 0.13, exit_band_max: 0.70,
  trailing_arm_gain: 0.15, trailing_give_back: 0.08, time_stop_days: 45,
};

// Un corto en Alpaca tiene qty NEGATIVA y market_value NEGATIVO.
const corto = (symbol, qty, entry, current) => ({ symbol, qty: -Math.abs(qty), avg_entry_price: entry, current_price: current, market_value: -Math.abs(qty) * current });
const largo = (symbol, qty, entry, current) => ({ symbol, qty, avg_entry_price: entry, current_price: current, market_value: qty * current });

console.log('\n── 1. el lado viaja con cada salida ──');
{
  ok(posicionCerrable(corto('ZM', 100, 80, 97)).side === LADO_COBERTURA, 'un corto se cierra con una COBERTURA');
  ok(posicionCerrable(corto('ZM', 100, 80, 97)).qty === 100, 'y la cantidad es el valor absoluto');
  ok(posicionCerrable(largo('NVDA', 50, 100, 90)).side === LADO_VENTA, 'un largo se cierra con una VENTA');
  ok(posicionCerrable({ symbol: 'X', qty: 0 }).qty === 0, 'una posición vacía no es cerrable de ningún lado');
  ok(ALPACA_SIDE.cover === 'buy' && ALPACA_SIDE.sell === 'sell', 'Alpaca solo conoce buy/sell: cover → buy');
}

console.log('\n── 2. el stop catastrófico del corto llega a `approved` ──');
{
  // entrada 80 → nivel +20% = 96. Cierre 97 lo cruza.
  const r = buildRiskExits({ equity: 100000, peak: 100000, positions: [corto('ZM', 100, 80, 97)], closes: { ZM: 97 }, rules: RULES });
  ok(r.approved.length === 1, 'un corto por encima de su stop produce UNA salida', JSON.stringify(r.approved));
  const a = r.approved[0];
  ok(a.side === LADO_COBERTURA, "el lado es 'cover', no 'sell'", a.side);
  ok(a.alpaca_side === 'buy', "y para el broker es 'buy'", a.alpaca_side);
  ok(a.reason_codes.includes('short_catastrophic_stop'), 'con el código del lado corto', JSON.stringify(a.reason_codes));
  ok(a.qty === 100, 'la cantidad a cubrir es el valor absoluto', String(a.qty));
  // EL NÚMERO QUE IMPORTA: banda catastrófica 32% POR ENCIMA de 97 = 128.04.
  ok(a.limit_price === 128.04, 'el límite está POR ENCIMA del mercado (97 × 1.32 = 128.04): restarla daría un límite que no llena NUNCA', String(a.limit_price));
  ok(a.limit_price > a.reference, 'invariante: en una cobertura el límite SIEMPRE está sobre la referencia');
}

console.log('\n── 3. el trailing del corto ──');
{
  const p = corto('ZM', 100, 80, 92);
  // piso 68 = −15% desde 80 → arma. Techo = 68 × 1.08 = 73.44.
  const armado = buildRiskExits({ equity: 100000, peak: 100000, positions: [p], closes: { ZM: 74 }, lows: { ZM: 68 }, rules: RULES });
  ok(armado.approved.length === 1 && armado.approved[0].reason_codes.includes('short_trailing_stop'),
    'piso en −15% y rebote sobre el techo → cubre', JSON.stringify(armado.approved.map((x) => x.reason_codes)));
  ok(armado.approved[0].limit_price === +(74 * 1.12).toFixed(2),
    'con la banda del trailing (12%), también por encima', String(armado.approved[0].limit_price));

  const sinArmar = buildRiskExits({ equity: 100000, peak: 100000, positions: [p], closes: { ZM: 74 }, lows: { ZM: 75 }, rules: RULES });
  ok(sinArmar.approved.length === 0, 'un piso que nunca llegó a −15% NO arma: sin armar no hay salida por trailing');

  const sinPiso = buildRiskExits({ equity: 100000, peak: 100000, positions: [p], closes: { ZM: 74 }, lows: {}, rules: RULES });
  ok(sinPiso.approved.length === 0, 'SIN piso no se dispara nada: un dato ausente no cierra una posición por sorpresa');

  const sinCierre = buildRiskExits({ equity: 100000, peak: 100000, positions: [p], closes: {}, lows: { ZM: 68 }, rules: RULES });
  ok(sinCierre.approved.length === 0, 'y sin cierre tampoco (mismo fail-safe que el lado largo)');
}

console.log('\n── 4. el breaker ve los DOS lados (la regresión de heldQty) ──');
{
  const libro = [largo('NVDA', 50, 100, 90), corto('ZM', 100, 80, 82)];
  const bc = planBreaker({ equity: 79000, peak: 100000, positions: libro, rules: RULES });
  ok(bc.stage === 'broadcut', 'drawdown 21% → corte amplio', bc.stage);
  ok(bc.exits.length === 2, 'el corte amplio alcanza al largo Y al corto: antes el corto quedaba abierto', String(bc.exits.length));
  const zm = bc.exits.find((e) => e.symbol === 'ZM');
  ok(zm && zm.side === LADO_COBERTURA && zm.qty === 100, 'y el corto sale como cobertura de 100', JSON.stringify(zm));

  const dl = planBreaker({ equity: 84000, peak: 100000, positions: libro, rules: RULES });
  ok(dl.stage === 'delever' && dl.exits.length === 2, 'el delever PRO-RATA también recorta los dos lados', JSON.stringify(dl.exits.map((e) => e.symbol)));
  ok(dl.exits.find((e) => e.symbol === 'ZM').qty === 33, 'recorta 33% del corto (33 de 100), sin elegir qué apuesta sobrevive');
}

console.log('\n── 5. el merge ya no borra la salida corta ──');
{
  // El bug: heldBySym usaba heldQty → un corto daba 0 y el Math.min borraba todo.
  const m = mergeExits([[{ symbol: 'ZM', qty: 100, side: LADO_COBERTURA, reason_code: 'short_catastrophic_stop', detail: 'x' }]], [corto('ZM', 100, 80, 97)]);
  ok(m.length === 1 && m[0].qty === 100, 'la salida corta sobrevive al tope de cantidad', JSON.stringify(m));
  ok(m[0].side === LADO_COBERTURA, 'y conserva su lado', JSON.stringify(m[0]));
  const capado = mergeExits([[{ symbol: 'ZM', qty: 500, side: LADO_COBERTURA, reason_code: 'short_catastrophic_stop', detail: 'x' }]], [corto('ZM', 100, 80, 97)]);
  ok(capado[0].qty === 100, 'pero sigue capando a lo que hay: nunca sobre-cubre', String(capado[0].qty));
}

console.log('\n── 6. simetría del límite y bandas del corto ──');
{
  ok(riskExitLimit(100, 0.12, LADO_VENTA) === 88, 'venta: 100 × (1 − 0.12) = 88');
  ok(riskExitLimit(100, 0.12, LADO_COBERTURA) === 112, 'cobertura: 100 × (1 + 0.12) = 112');
  ok(riskExitLimit(100, 0.12) === 88, 'sin lado explícito se comporta como antes (venta): compatible hacia atrás');
  ok(exitBand(['short_catastrophic_stop'], RULES) === RULES.exit_band_catastrophic, 'el catastrófico corto usa la banda ancha');
  ok(exitBand(['short_trailing_stop'], RULES) === RULES.exit_band_trailing, 'y el trailing corto la suya');
  ok(exitBand(['short_catastrophic_stop'], RULES, 2) > RULES.exit_band_catastrophic, 'y el escalamiento por reintentos también aplica del lado corto');
}

console.log('\n── 7. DE PUNTA A PUNTA: qué recibe el broker ──');
{
  const enviadas = [];
  const fake = async (o) => { enviadas.push(o); return { id: 'o1', status: 'accepted' }; };
  const r = buildRiskExits({ equity: 100000, peak: 100000, positions: [corto('ZM', 100, 80, 97)], closes: { ZM: 97 }, rules: RULES });
  const { actions, submitted } = await submitRiskExits(r.approved, '2026-09-18', null, fake);
  ok(submitted === 1, 'se mandó una orden', String(submitted));
  ok(enviadas[0].side === 'buy', "EL PASO QUE FALTABA: el broker recibe 'buy'. Con el literal 'sell' de antes, el stop DUPLICABA el corto en vez de cerrarlo", enviadas[0].side);
  ok(enviadas[0].qty === 100 && enviadas[0].limit_price === 128.04, 'con la cantidad y el límite del plan', JSON.stringify(enviadas[0]));
  ok(actions[0].result === 'approved', 'y queda journaleada');

  // El lado largo, por el mismo camino, sigue siendo una venta.
  const enviadasL = [];
  const fakeL = async (o) => { enviadasL.push(o); return { id: 'o2', status: 'accepted' }; };
  const rl = buildRiskExits({ equity: 100000, peak: 100000, positions: [largo('NVDA', 50, 100, 70)], closes: { NVDA: 70 }, rules: RULES });
  await submitRiskExits(rl.approved, '2026-09-18', null, fakeL);
  ok(enviadasL[0].side === 'sell', 'y un stop largo sigue llegando como sell', enviadasL[0].side);
}

console.log('\n── 8. un libro SIN cortos no cambió de comportamiento ──');
{
  const libro = [largo('NVDA', 50, 100, 70), largo('AMD', 30, 50, 48)];
  const r = buildRiskExits({ equity: 100000, peak: 100000, positions: libro, closes: { NVDA: 70, AMD: 48 }, peaks: { NVDA: 120 }, rules: RULES });
  ok(r.approved.length === 1 && r.approved[0].symbol === 'NVDA', 'solo NVDA cruza su stop catastrófico', JSON.stringify(r.approved.map((a) => a.symbol)));
  ok(r.approved[0].side === LADO_VENTA && r.approved[0].limit_price === +(70 * 0.68).toFixed(2),
    'con el MISMO lado y el MISMO límite de siempre (70 × 0.68 = 47.60)', String(r.approved[0].limit_price));
  ok(r.approved.every((a) => !a.reason_codes.some((c) => c.startsWith('short_'))), 'y ningún código del lado corto aparece');
}

console.log('\n── 9. los números del reglamento (D8) ──');
{
  ok(SHORT_RULES.catastrophic_stop_pct === 0.20, 'stop catastrófico del corto: +20% (no +22% del largo — la asimetría)');
  ok(SHORT_RULES.trailing_arm_drop === 0.15, 'arma cuando el piso llegó a −15%');
  ok(SHORT_RULES.trailing_give_back === 0.08, 'y dispara con un rebote de +8% desde ese piso');
  // Por construcción NUNCA cubre en pérdida: 1 × 0.85 × 1.08 = 0.918 < 1.
  ok((1 - SHORT_RULES.trailing_arm_drop) * (1 + SHORT_RULES.trailing_give_back) < 1,
    'invariante: el techo del trailing queda SIEMPRE bajo la entrada → el trailing corto solo puede cubrir en ganancia');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
