// ═══════════════════════════════════════════════════════════════
// Tests del risk guard determinista del Arena (_lib/arena-guard.js).
// JS puro, sin I/O: parse del JSON del LLM + validación por acción.
// Las reglas de la casa: violación → DESCARTADA con razón (jamás ajustada
// en silencio); JSON malformado → abort del run (ok:false), cero órdenes.
// Correr con `node tests/arena-guard.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { parseScanResponse, parsePlanResponse, validateActions, applyScreenerFloor, ARENA_RULES, isLeveragedInverseETF } from '../api/_lib/arena-guard.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('arena-guard: parse del SCAN (fase 1)');

const scanGood = parseScanResponse('{"scan_thesis":"AAPL y NVDA lucen bien.","candidates":["aapl","NVDA"]}');
ok(scanGood.ok && scanGood.candidates.length === 2 && scanGood.candidates[0] === 'AAPL', 'SCAN: candidatos normalizados a uppercase', JSON.stringify(scanGood.candidates));
ok(scanGood.thesis.includes('AAPL'), 'SCAN: la tesis se conserva');

const scanEmpty = parseScanResponse('{"scan_thesis":"Nada hoy.","candidates":[]}');
ok(scanEmpty.ok && scanEmpty.candidates.length === 0, 'SCAN: array vacío es válido (no aborta) — el caller decide ok_no_candidates');

const scanDupes = parseScanResponse('{"candidates":["AAPL","aapl","NVDA","AMD","INTC","MU","TSM"]}');
ok(scanDupes.ok && scanDupes.candidates.length === 5, 'SCAN: dedupe + corte a 5 candidatos', JSON.stringify(scanDupes.candidates));
ok(!scanDupes.candidates.includes('TSM'), 'SCAN: el 6º-7º candidato se descarta (tope 5)');

const scanDropNonStr = parseScanResponse('{"candidates":["AAPL",123,null,"NVDA"]}');
ok(scanDropNonStr.ok && scanDropNonStr.candidates.length === 2, 'SCAN: no-strings descartados', JSON.stringify(scanDropNonStr.candidates));

ok(parseScanResponse('Investigaría AAPL, sin JSON.').ok === false, 'SCAN: prosa sin JSON → abort');
ok(parseScanResponse('{"candidates":"AAPL"}').ok === false, 'SCAN: candidates no-array → abort');
ok(parseScanResponse('').ok === false, 'SCAN: respuesta vacía → abort');

console.log('arena-guard: floor del screener (atribución del canal)');

// scout pide solo nombres NO-screener → el floor reserva 2 del screener.
const f1 = applyScreenerFloor(['AAPL'], ['KO', 'NVDA', 'JNJ'], { floor: 2, maxCandidates: 5 });
ok(f1.floor.applied === true && f1.floor.reason === 'floor_applied', 'floor: aplica cuando el scout no eligió screener', JSON.stringify(f1.floor));
ok(f1.candidates.length === 3, 'floor: slate = scout + 2 reservados', JSON.stringify(f1.candidates));
ok(f1.candidates[0].symbol === 'AAPL' && f1.candidates[0].origin === 'scout_picked', 'floor: pick del scout marcado scout_picked');
ok(f1.candidates[1].origin === 'floor_reserved' && f1.candidates[2].origin === 'floor_reserved', 'floor: reservados marcados floor_reserved');
ok(f1.candidates[1].symbol === 'KO' && f1.candidates[2].symbol === 'NVDA', 'floor: reserva por orden de ranking (KO, NVDA)', JSON.stringify(f1.floor.reserved));

// condición #3: HAY datos frescos y ninguna screen dispara → floor NO se usa.
// Solo con datos frescos es honesto decir "ninguna acción calificó".
const f2 = applyScreenerFloor(['AAPL', 'MSFT'], [], { floor: 2, maxCandidates: 5, screenerState: 'fresh' });
ok(f2.floor.applied === false && f2.floor.reason === 'no_qualifying_candidates', 'floor: datos frescos sin qualifiers → reason no_qualifying_candidates (cond. #3)', JSON.stringify(f2.floor));
ok(f2.candidates.every((c) => c.origin === 'scout_picked') && f2.candidates.length === 2, 'floor: sin screener, el slate es solo del scout');
// default screenerState = 'fresh' → compat con callers viejos.
ok(applyScreenerFloor(['AAPL'], []).floor.reason === 'no_qualifying_candidates', 'floor: sin screenerState explícito, default fresh → no_qualifying_candidates');

// Canal SIN datos: el reason nombra el estado, NO culpa a las acciones. Este
// es el fix del bug — tabla vacía por flag faltante se leía como "nada calificó".
ok(applyScreenerFloor(['AAPL'], [], { screenerState: 'disabled' }).floor.reason === 'screener_disabled', 'floor: tabla vacía + cron apagado → screener_disabled (no no_qualifying_candidates)');
ok(applyScreenerFloor(['AAPL'], [], { screenerState: 'empty' }).floor.reason === 'screener_empty', 'floor: tabla vacía + cron prendido → screener_empty');
ok(applyScreenerFloor(['AAPL'], [], { screenerState: 'stale' }).floor.reason === 'screener_stale', 'floor: tabla rancia → screener_stale');
ok(applyScreenerFloor(['AAPL'], [], { screenerState: 'unavailable' }).floor.reason === 'screener_unavailable', 'floor: lectura de la tabla falló → screener_unavailable');
// screenerState NO importa cuando SÍ hubo qualifiers (el canal aportó datos).
const fFloorState = applyScreenerFloor(['AAPL'], ['KO', 'NVDA'], { floor: 2, maxCandidates: 5, screenerState: 'stale' });
ok(fFloorState.floor.applied === true && fFloorState.floor.reason === 'floor_applied', 'floor: con qualifiers, screenerState no altera el reason (aplica normal)', JSON.stringify(fFloorState.floor));

// el scout ya eligió ≥floor nombres de screener → no se fuerza nada.
const f3 = applyScreenerFloor(['KO', 'NVDA', 'AAPL'], ['KO', 'NVDA', 'JNJ'], { floor: 2, maxCandidates: 5 });
ok(f3.floor.applied === false && f3.floor.reason === 'scout_met_floor', 'floor: scout ya cumplió el floor orgánicamente → no fuerza', JSON.stringify(f3.floor));
ok(f3.candidates.filter((c) => c.origin === 'scout_picked').length === 3, 'floor: picks orgánicos de screener quedan scout_picked (no floor_reserved)');

// cap a maxCandidates: reservados DEBEN entrar, se recorta la cola no-screener del scout.
const f4 = applyScreenerFloor(['A', 'B', 'C', 'D', 'E'], ['KO', 'NVDA'], { floor: 2, maxCandidates: 5 });
ok(f4.candidates.length === 5, 'floor: respeta el tope de 5 candidatos', String(f4.candidates.length));
const reservedInF4 = f4.candidates.filter((c) => c.origin === 'floor_reserved').map((c) => c.symbol);
ok(reservedInF4.join(',') === 'KO,NVDA', 'floor: los reservados entran aunque el scout llenara los 5 (recorta su cola)', JSON.stringify(f4.candidates.map((c) => c.symbol)));

// floor=0 (post-trial) → free-choice puro, cero reservas.
const f5 = applyScreenerFloor(['AAPL'], ['KO', 'NVDA'], { floor: 0, maxCandidates: 5 });
ok(f5.floor.applied === false && f5.candidates.length === 1 && f5.candidates[0].origin === 'scout_picked', 'floor=0 → free-choice, sin reservas (knob post-trial)');

console.log('arena-guard: parse de la respuesta del LLM');

const good = parsePlanResponse('{"plan":"Hold mayormente; una entrada.","actions":[{"symbol":"AAPL","side":"buy","notional":5000,"limit_price":200}]}');
ok(good.ok && good.plan.startsWith('Hold') && good.actions.length === 1, 'JSON limpio parsea');

const fenced = parsePlanResponse('```json\n{"plan":"Sin cambios.","actions":[]}\n```');
ok(fenced.ok && fenced.actions.length === 0, 'fences de markdown se toleran (des-serializar no es ajustar)');

ok(parsePlanResponse('Voy a comprar AAPL porque sí.').ok === false, 'prosa sin JSON → abort');
ok(parsePlanResponse('{"plan":"x","actions":[{]}').ok === false, 'JSON roto → abort');
ok(parsePlanResponse('{"actions":[]}').ok === false, 'sin plan → abort');
ok(parsePlanResponse('{"plan":"x","actions":{"symbol":"A"}}').ok === false, 'actions no-array → abort');
ok(parsePlanResponse('').ok === false, 'respuesta vacía → abort');

console.log('arena-guard: validación determinista de acciones');

// Libro base: $100k equity, $60k cash, ya hay 40k en 2 posiciones.
// ── ADDENDUM 2026-09-14: toda orden necesita una decisión por posición
// COMPLETA (invalidation_condition + confidence 0–1). El fixture la trae para
// TODOS los símbolos que estas pruebas operan, para que cada caso siga midiendo
// la regla que dice medir; los tests del addendum, al final, la quitan a
// propósito. Forma idéntica a la que devuelve normalizePositionsReview.
const decide = (symbol, over = {}) => ({
  symbol, stance: 'hold', reason: 'r',
  invalidation_condition: 'si el margen bruto del próximo trimestre baja de 40%',
  confidence: 0.6,
  ...over,
});
const SIMBOLOS_DEL_FIXTURE = [
  'AAPL', 'MSFT', 'NVDA', 'PENNY', 'KO', 'FAKEZ', 'ACME.WS', 'TSLL', 'ZZZL', 'WXYZ',
  'ULTG', 'SPY', 'PDI', 'NU', 'O', 'OEFX', 'WRNTX', 'UNITX', 'RGHTX', 'PREFX', 'PUBX',
  ...Array.from({ length: 8 }, (_, i) => 'P' + i),
];
const BASE = {
  equity: 100000,
  cash: 60000,
  positions: [
    { symbol: 'MSFT', qty: 50, market_value: 25000 },
    { symbol: 'NVDA', qty: 100, market_value: 15000 },
  ],
  symbolMap: { AAPL: 'Apple Inc', MSFT: 'Microsoft Corp', NVDA: 'Nvidia Corp', PENNY: 'Penny Trap Inc', KO: 'Coca-Cola Co' },
  lastCloses: { AAPL: 200, MSFT: 500, NVDA: 150, PENNY: 0.5, KO: 60 },
  decisions: SIMBOLOS_DEL_FIXTURE.map((s) => decide(s)),
};
const act = (over) => ({ symbol: 'AAPL', side: 'buy', notional: 10000, limit_price: 201, conviction: 3, reasoning: 'r', ...over });

// 1) símbolo inventado → descartado, jamás ejecutado
let r = validateActions({ ...BASE, actions: [act({ symbol: 'FAKEZ', limit_price: 10, notional: 1000 })] });
ok(r.approved.length === 0 && r.discarded.length === 1 && /symbol map/.test(r.discarded[0].reason),
  'símbolo inventado → descartado con razón', JSON.stringify(r.discarded));

// 2) sizing violado (>15% del equity) → descartado, NO recortado
r = validateActions({ ...BASE, actions: [act({ notional: 20000 })] });
ok(r.approved.length === 0 && /15%/.test(r.discarded[0].reason), 'posición > 15% equity → descartada, no recortada');

// 3) compra válida → aprobada con qty entera floor(notional/limit)
r = validateActions({ ...BASE, actions: [act()] });
ok(r.approved.length === 1 && r.approved[0].qty === Math.floor(10000 / 201) && r.approved[0].side === 'buy',
  'compra válida aprobada con qty entera', JSON.stringify(r.approved));

// 4) limit_price fuera de banda ±2% → descartada
r = validateActions({ ...BASE, actions: [act({ limit_price: 210 })] });
ok(r.approved.length === 0 && /banda/.test(r.discarded[0].reason), 'limit_price a +5% del cierre → descartada');

// 5) sub-$1 fuera del universo
r = validateActions({ ...BASE, actions: [act({ symbol: 'PENNY', limit_price: 0.5, notional: 100 })] });
ok(r.approved.length === 0 && /sub-\$1/.test(r.discarded[0].reason), 'sub-$1 → descartada');

// 6) piso de cash 10%: compra que vaciaría el cash → descartada
r = validateActions({ ...BASE, cash: 12000, actions: [act({ notional: 14000 })] });
ok(r.approved.length === 0 && /cash/.test(r.discarded[0].reason),
  'compra que rompe el piso de cash → descartada', JSON.stringify(r.discarded));

// 7) máximo de posiciones: con 8 abiertas, un símbolo NUEVO no entra
const eightPositions = Array.from({ length: 8 }, (_, i) => ({ symbol: 'P' + i, qty: 1, market_value: 1000 }));
r = validateActions({
  ...BASE, positions: eightPositions,
  symbolMap: { ...BASE.symbolMap, ...Object.fromEntries(eightPositions.map((p) => [p.symbol, 'x'])) },
  actions: [act({ notional: 2000 })],
});
ok(r.approved.length === 0 && /máximo/.test(r.discarded[0].reason), 'novena posición → descartada');

// 8) venta sin posición (short encubierto) → descartada
r = validateActions({ ...BASE, actions: [act({ symbol: 'KO', side: 'sell', limit_price: 60, notional: 600 })] });
ok(r.approved.length === 0 && /long-only/.test(r.discarded[0].reason), 'venta sin posición → descartada (long-only)');

// 9) venta que excede lo que hay → descartada, no clampeada
r = validateActions({ ...BASE, actions: [act({ symbol: 'MSFT', side: 'sell', limit_price: 500, notional: 100000 })] });
ok(r.approved.length === 0 && /excede/.test(r.discarded[0].reason), 'venta > posición → descartada, no ajustada');

// 10) venta legítima parcial → aprobada
r = validateActions({ ...BASE, actions: [act({ symbol: 'MSFT', side: 'sell', limit_price: 500, notional: 10000 })] });
ok(r.approved.length === 1 && r.approved[0].qty === 20, 'venta parcial válida aprobada', JSON.stringify(r.approved));

// 11) symbol map caído → fail closed: TODO descartado, nada "asumido"
r = validateActions({ ...BASE, symbolMap: null, actions: [act()] });
ok(r.approved.length === 0 && /fail closed/.test(r.discarded[0].reason), 'symbol map caído → fail closed');

// 12) sin cierre de referencia → fail closed
r = validateActions({ ...BASE, lastCloses: {}, actions: [act()] });
ok(r.approved.length === 0 && /cierre/.test(r.discarded[0].reason), 'sin último cierre → descartada');

// 13) warrant-like → fuera del universo aunque estuviera en el map
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, 'ACME.WS': 'Acme Warrants' }, lastCloses: { ...BASE.lastCloses, 'ACME.WS': 5 }, actions: [act({ symbol: 'ACME.WS', limit_price: 5, notional: 500 })] });
ok(r.approved.length === 0 && /warrant/i.test(r.discarded[0].reason), 'sufijo de warrant → descartada');

// 13b) ETF apalancado por LISTA (TSLL) → descartado aunque pase todo lo demás
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, TSLL: 'Direxion Daily Tsla Bull 2X Shares' }, lastCloses: { ...BASE.lastCloses, TSLL: 25 }, actions: [act({ symbol: 'TSLL', limit_price: 25, notional: 5000 })] });
ok(r.approved.length === 0 && /apalancado\/inverso/.test(r.discarded[0].reason), 'leveraged por lista (TSLL) → descartado');

// 13c) ETF apalancado NUEVO (no en la lista) atrapado por el NOMBRE del map
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, ZZZL: 'Granite 3X Long Zzz Daily ETF' }, lastCloses: { ...BASE.lastCloses, ZZZL: 40 }, actions: [act({ symbol: 'ZZZL', limit_price: 40, notional: 5000 })] });
ok(r.approved.length === 0 && /apalancado\/inverso/.test(r.discarded[0].reason), 'leveraged NUEVO (fuera de lista) → descartado por nombre "3X"');

// 13d) inverse por nombre "Inverse"
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, WXYZ: 'Acme Inverse Vix Short-Term ETF' }, lastCloses: { ...BASE.lastCloses, WXYZ: 30 }, actions: [act({ symbol: 'WXYZ', limit_price: 30, notional: 5000 })] });
ok(r.approved.length === 0 && /apalancado\/inverso/.test(r.discarded[0].reason), 'inverse por nombre → descartado');

// 13e) equity común con nombre "inofensivo" NO se marca (sin falso positivo)
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, ULTG: 'Ultragenyx Pharmaceutical Inc' }, lastCloses: { ...BASE.lastCloses, ULTG: 40 }, actions: [act({ symbol: 'ULTG', limit_price: 40, notional: 5000 })] });
ok(r.approved.length === 1, 'equity común (Ultragenyx) NO confundido con "Ultra" apalancado', JSON.stringify(r.discarded));

// 13f) el helper directo: lista + nombre, sin falsos positivos
ok(isLeveragedInverseETF('SQQQ') && isLeveragedInverseETF('zzz', '2x Long Something') && isLeveragedInverseETF('x', 'ProShares UltraPro QQQ'),
  'isLeveragedInverseETF: lista + nombre (2x, UltraPro)');
ok(!isLeveragedInverseETF('AAPL', 'Apple Inc') && !isLeveragedInverseETF('BULF', 'Bullfrog AI Holdings') && !isLeveragedInverseETF('KO', 'Coca-Cola Co'),
  'isLeveragedInverseETF: sin falsos positivos (Apple, Bullfrog, Coca-Cola)');

// 13g) ETP (ETF/ETN, incluye SPY/QQQ) → descartado por tipo
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, SPY: 'Spdr S&P 500 ETF Trust' }, lastCloses: { ...BASE.lastCloses, SPY: 500 }, symbolTypes: { SPY: 'ETP' }, actions: [act({ symbol: 'SPY', limit_price: 500, notional: 5000 })] });
ok(r.approved.length === 0 && /tipo ETP fuera del universo/.test(r.discarded[0].reason), 'ETP (ETF) → descartado por tipo');

// 13h) Closed-End Fund → descartado por tipo
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, PDI: 'Pimco Dynamic Income Fund' }, lastCloses: { ...BASE.lastCloses, PDI: 18 }, symbolTypes: { PDI: 'Closed-End Fund' }, actions: [act({ symbol: 'PDI', limit_price: 18, notional: 3000 })] });
ok(r.approved.length === 0 && /Closed-End Fund/.test(r.discarded[0].reason), 'Closed-End Fund → descartado por tipo');

// 13i) ADR se MANTIENE (NU/MELI/ITUB LATAM) y lleva security_type
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, NU: 'Nu Holdings Ltd' }, lastCloses: { ...BASE.lastCloses, NU: 12 }, symbolTypes: { NU: 'ADR' }, actions: [act({ symbol: 'NU', limit_price: 12, notional: 5000 })] });
ok(r.approved.length === 1 && r.approved[0].security_type === 'ADR', 'ADR (NU) → aprobado y con security_type', JSON.stringify(r.approved));

// 13j) REIT se mantiene
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, O: 'Realty Income Corp' }, lastCloses: { ...BASE.lastCloses, O: 55 }, symbolTypes: { O: 'REIT' }, actions: [act({ symbol: 'O', limit_price: 55, notional: 5000 })] });
ok(r.approved.length === 1 && r.approved[0].security_type === 'REIT', 'REIT → aprobado');

// 13k) tipo desconocido/vacío → PERMITIR (regla de producto) pero security_type null
r = validateActions({ ...BASE, symbolTypes: {}, actions: [act()] });
ok(r.approved.length === 1 && r.approved[0].security_type === null, 'type desconocido → permitido y journaleado (security_type null)', JSON.stringify(r.approved));

// 13l) Open-End Fund → descartado (fondo, mismo criterio que CEF)
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, OEFX: 'Sample Open End Fund' }, lastCloses: { ...BASE.lastCloses, OEFX: 20 }, symbolTypes: { OEFX: 'Open-End Fund' }, actions: [act({ symbol: 'OEFX', limit_price: 20, notional: 2000 })] });
ok(r.approved.length === 0 && /Open-End Fund/.test(r.discarded[0].reason), 'Open-End Fund → descartado por tipo');

// 13m) warrant SIN sufijo en el ticker → lo atrapa el type "Equity WRT" (el regex no lo vería)
r = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, WRNTX: 'Acme Warrant' }, lastCloses: { ...BASE.lastCloses, WRNTX: 3 }, symbolTypes: { WRNTX: 'Equity WRT' }, actions: [act({ symbol: 'WRNTX', limit_price: 3, notional: 500 })] });
ok(r.approved.length === 0 && /no es equity común/.test(r.discarded[0].reason), 'warrant sin sufijo → descartado por type autoritativo (regex no lo veía)');

// 13n) Unit / Right / Preference / PUBLIC por type → descartados. PUBLIC es el
// catch-all de Finnhub: las muestras en prod fueron preferentes y baby bonds.
for (const [sym, ty] of [['UNITX', 'Unit'], ['RGHTX', 'Right'], ['PREFX', 'Preference'], ['PUBX', 'PUBLIC']]) {
  const rr = validateActions({ ...BASE, symbolMap: { ...BASE.symbolMap, [sym]: sym }, lastCloses: { ...BASE.lastCloses, [sym]: 10 }, symbolTypes: { [sym]: ty }, actions: [act({ symbol: sym, limit_price: 10, notional: 1000 })] });
  ok(rr.approved.length === 0 && /no es equity común/.test(rr.discarded[0].reason), `type ${ty} → descartado`);
}

// 14) acción malformada dentro de JSON válido → SOLO esa se descarta
r = validateActions({ ...BASE, actions: [{ symbol: 'AAPL' }, act()] });
ok(r.approved.length === 1 && r.discarded.length === 1 && /malformada/.test(r.discarded[0].reason),
  'acción incompleta se descarta sin tumbar las demás');

// 15) el estado se acumula: dos compras válidas que JUNTAS rompen el cash → la segunda cae
r = validateActions({ ...BASE, cash: 25000, actions: [act({ notional: 14000 }), act({ symbol: 'KO', limit_price: 60, notional: 14000 })] });
ok(r.approved.length === 1 && r.discarded.length === 1, 'límites evaluados con estado acumulado del run', JSON.stringify({ a: r.approved.length, d: r.discarded.length }));

// ── T2 #5: la VENTA del PM sale a MARKETABLE LIMIT (cicatriz GOOGL) ──
console.log('arena-guard: T2 #5 — la venta se envía marketable, la compra no se toca');
// Venta válida: el PM ancla en el cierre (150) y el guard la re-precia por
// DEBAJO del mercado para que LLENE. La banda ±2% sigue validando su anclaje.
r = validateActions({ ...BASE, actions: [{ symbol: 'NVDA', side: 'sell', notional: 3000, limit_price: 150, reasoning: 'salgo' }] });
const sell = r.approved[0];
ok(r.approved.length === 1 && sell.limit_price === +(150 * (1 - ARENA_RULES.discretionary_sell_band)).toFixed(2),
  'la venta se envía a cierre × (1 − banda discrecional), por debajo del mercado', JSON.stringify(sell));
ok(sell.limit_price_proposed === 150 && sell.repriced === 'marketable_sell' && sell.exit_band === ARENA_RULES.discretionary_sell_band,
  'NO es un ajuste silencioso: queda el precio que pidió el PM, la marca y la banda usada', JSON.stringify(sell));
ok(sell.notional === +(sell.qty * sell.limit_price).toFixed(2),
  'el notional journaleado usa el precio REALMENTE enviado', JSON.stringify({ n: sell.notional, q: sell.qty, p: sell.limit_price }));

// El PM que ya pidió un precio MÁS agresivo que el marketable conserva el suyo:
// subirlo sería EMPEORAR su venta, y el objetivo es llenar, no cobrar peaje. Con
// los defaults este caso no ocurre (la banda marketable, 4%, es más ancha que el
// ±2% de anclaje), así que se prueba con una banda estrecha inyectada — que es
// exactamente lo que pasaría si alguien bajara ARENA_EXIT_BAND_DISCRETIONARY.
r = validateActions({
  ...BASE, rules: { ...ARENA_RULES, discretionary_sell_band: 0.01 },
  actions: [{ symbol: 'NVDA', side: 'sell', notional: 3000, limit_price: 147.2, reasoning: 'salgo ya' }],
});
ok(r.approved[0].limit_price === 147.2 && !r.approved[0].repriced,
  'un límite del PM MÁS abajo que el marketable se respeta tal cual (nunca se re-precia hacia arriba)', JSON.stringify(r.approved[0]));

// La banda ±2% NO se relaja: una venta fuera de banda sigue descartándose.
r = validateActions({ ...BASE, actions: [{ symbol: 'NVDA', side: 'sell', notional: 3000, limit_price: 200, reasoning: 'sueño' }] });
ok(r.approved.length === 0 && /banda/.test(r.discarded[0].reason),
  'el marketable NO rescata una venta con el precio fuera de la banda ±2%: se descarta igual', JSON.stringify(r.discarded[0]));

// La COMPRA no se re-precia: ahí el precio del modelo sí es la decisión.
r = validateActions({ ...BASE, actions: [act()] });
ok(r.approved[0].limit_price === 201 && !r.approved[0].repriced,
  'la compra conserva el límite del PM (un límite agresivo de compra paga de más)', JSON.stringify(r.approved[0]));
ok(ARENA_RULES.discretionary_sell_band > ARENA_RULES.price_band && ARENA_RULES.discretionary_sell_band < 0.12,
  'la banda discrecional es más ancha que el ±2% de anclaje y más angosta que la del breaker (12%)',
  String(ARENA_RULES.discretionary_sell_band));

// ── T2 #1/#9: los campos nuevos son TOLERADOS, no contrato duro ──
console.log('arena-guard: T2 — positions_review/commitments no endurecen el parse');
const t2Plan = parsePlanResponse(JSON.stringify({
  plan: 'holdeo', actions: [],
  positions_review: [{ symbol: 'AAPL', stance: 'hold', reason: 'sigue en tesis' }],
  commitments: [{ symbol: 'NVDA', text: 'revisar tras el reporte', due: '2026-09-18' }],
  commitment_updates: [{ id: '2026-09-08:d#1', status: 'vigente' }],
}));
ok(t2Plan.ok && t2Plan.positions_review.length === 1 && t2Plan.commitments.length === 1 && t2Plan.commitment_updates.length === 1,
  'los tres campos de la T2 llegan crudos al caller (los normaliza arena-memory)', JSON.stringify(Object.keys(t2Plan)));
const t2Missing = parsePlanResponse('{"plan":"holdeo","actions":[]}');
ok(t2Missing.ok && t2Missing.positions_review === undefined,
  'una respuesta SIN los campos nuevos sigue siendo válida: no se sube la tasa de aborts por olvidar');
const t2Junk = parsePlanResponse('{"plan":"holdeo","actions":[],"positions_review":"no es un array"}');
ok(t2Junk.ok === true,
  'un campo T2 malformado NO aborta el run: el contrato duro sigue siendo plan + actions (el olvido se MIDE, no se castiga con cero órdenes)');

// ═══ ADDENDUM 2026-09-14: sin decisión completa, no hay orden ══════
console.log('arena-guard: ADDENDUM — invalidation_condition + confidence o la orden se cae');

// Sin NINGUNA decisión (el modelo no emitió positions_review) → fail closed.
r = validateActions({ ...BASE, decisions: [], actions: [act()] });
ok(r.approved.length === 0 && /sin decisión por posición/.test(r.discarded[0].reason),
  'sin positions_review, la orden NO se ejecuta: fail closed, igual que sin symbol map', JSON.stringify(r.discarded[0]));
ok(validateActions({ ...BASE, decisions: undefined, actions: [act()] }).approved.length === 0,
  'el campo AUSENTE tampoco significa "sin regla" — ausente es vacío, y vacío no autoriza nada');

// Decisión que existe pero le falta un campo → se cae, con la razón que lo nombra.
r = validateActions({ ...BASE, decisions: [decide('AAPL', { invalidation_condition: null })], actions: [act()] });
ok(r.approved.length === 0 && /invalidation_condition/.test(r.discarded[0].reason),
  'decisión sin condición de invalidación → orden descartada, nombrando el campo que falta', JSON.stringify(r.discarded[0]));
r = validateActions({ ...BASE, decisions: [decide('AAPL', { confidence: null })], actions: [act()] });
ok(r.approved.length === 0 && /confidence/.test(r.discarded[0].reason),
  'decisión sin confidence → orden descartada', JSON.stringify(r.discarded[0]));

// La confianza fuera de rango NO se clampa (mismo criterio que el resto del guard).
for (const bad of [70, 1.5, -0.1, '0.7', NaN]) {
  const rr = validateActions({ ...BASE, decisions: [decide('AAPL', { confidence: bad })], actions: [act()] });
  ok(rr.approved.length === 0 && /confidence/.test(rr.discarded[0].reason),
    `confidence ${JSON.stringify(bad)} fuera del contrato → descartada, JAMÁS clampada a 1`, JSON.stringify(rr.discarded[0]));
}
// 0 es una declaración válida: el contrato exige el campo LLENO, no un número alto.
r = validateActions({ ...BASE, decisions: [decide('AAPL', { confidence: 0 })], actions: [act()] });
ok(r.approved.length === 1 && r.approved[0].confidence === 0,
  'confidence 0 SÍ opera: "no le tengo confianza" es una declaración honesta, no un campo vacío', JSON.stringify(r.discarded));

// El guard NO confía en el flag `complete` que calcula la memoria: re-verifica.
r = validateActions({ ...BASE, decisions: [decide('AAPL', { invalidation_condition: '', complete: true })], actions: [act()] });
ok(r.approved.length === 0,
  'un `complete:true` mentiroso no pasa: el guard re-verifica los campos, no confía en la bandera');

// La decisión es POR SÍMBOLO: la de otro nombre no autoriza esta orden.
r = validateActions({ ...BASE, decisions: [decide('KO')], actions: [act()] });
ok(r.approved.length === 0 && /AAPL: sin decisión/.test(r.discarded[0].reason),
  'la decisión de OTRO símbolo no autoriza esta orden (no hay decisión "de la corrida", hay una por posición)');

// Aplica también a las VENTAS del PM: vender NVDA sin pronunciarse sobre NVDA no pasa.
r = validateActions({ ...BASE, decisions: [], actions: [{ symbol: 'NVDA', side: 'sell', notional: 3000, limit_price: 150, reasoning: 'salgo' }] });
ok(r.approved.length === 0 && /sin decisión por posición/.test(r.discarded[0].reason),
  'la venta del PM también necesita su decisión (las deterministas del breaker no pasan por acá)');

// La decisión que AUTORIZÓ la orden viaja CON la orden (journal + titular).
r = validateActions({ ...BASE, actions: [act()] });
ok(r.approved[0].invalidation_condition === 'si el margen bruto del próximo trimestre baja de 40%'
  && r.approved[0].confidence === 0.6 && r.approved[0].stance === 'hold',
  'la orden aprobada journalea la condición de venta y la confianza que la respaldaron', JSON.stringify(r.approved[0]));

// Acepta el mapa ya indexado, no solo el array.
r = validateActions({ ...BASE, decisions: { AAPL: decide('AAPL') }, actions: [act()] });
ok(r.approved.length === 1, 'acepta { SYMBOL: decisión } además del array de positions_review');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
