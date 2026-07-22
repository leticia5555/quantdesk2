// ═══════════════════════════════════════════════════════════════
// Tests del risk guard determinista del Arena (_lib/arena-guard.js).
// JS puro, sin I/O: parse del JSON del LLM + validación por acción.
// Las reglas de la casa: violación → DESCARTADA con razón (jamás ajustada
// en silencio); JSON malformado → abort del run (ok:false), cero órdenes.
// Correr con `node tests/arena-guard.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { parsePlanResponse, validateActions, ARENA_RULES } from '../api/_lib/arena-guard.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

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
const BASE = {
  equity: 100000,
  cash: 60000,
  positions: [
    { symbol: 'MSFT', qty: 50, market_value: 25000 },
    { symbol: 'NVDA', qty: 100, market_value: 15000 },
  ],
  symbolMap: { AAPL: 'Apple Inc', MSFT: 'Microsoft Corp', NVDA: 'Nvidia Corp', PENNY: 'Penny Trap Inc', KO: 'Coca-Cola Co' },
  lastCloses: { AAPL: 200, MSFT: 500, NVDA: 150, PENNY: 0.5, KO: 60 },
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

// 14) acción malformada dentro de JSON válido → SOLO esa se descarta
r = validateActions({ ...BASE, actions: [{ symbol: 'AAPL' }, act()] });
ok(r.approved.length === 1 && r.discarded.length === 1 && /malformada/.test(r.discarded[0].reason),
  'acción incompleta se descarta sin tumbar las demás');

// 15) el estado se acumula: dos compras válidas que JUNTAS rompen el cash → la segunda cae
r = validateActions({ ...BASE, cash: 25000, actions: [act({ notional: 14000 }), act({ symbol: 'KO', limit_price: 60, notional: 14000 })] });
ok(r.approved.length === 1 && r.discarded.length === 1, 'límites evaluados con estado acumulado del run', JSON.stringify({ a: r.approved.length, d: r.discarded.length }));

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
