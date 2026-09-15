// ═══════════════════════════════════════════════════════════════
// tests/arena-sombra.test.mjs — B13: la sombra, y B5/B10: el contrato nuevo.
//
// El contrato nuevo (portafolio objetivo) no puede estrenarse contra siete
// libros reales. La sombra lo corre con el mismo tablero, las mismas
// herramientas y el mismo mercado — y CERO órdenes.
//
// Las dos condiciones son ESTRUCTURALES, no de disciplina:
//
//   1. TABLAS APARTE, no una columna `shadow` en arena_journal. Una bandera en
//      la misma tabla está a UNA CONSULTA MAL ESCRITA de contaminar el
//      post-mortem — basta olvidar un `where shadow = false` una vez y las
//      métricas quedan mezcladas para siempre sin que nada falle a la vista.
//   2. EL BROKER DE SOMBRA LANZA en toda escritura. No alcanza con "no llamar":
//      alcanza con que NO SE PUEDA. Una sombra que manda una orden es una
//      corrida real mal etiquetada.
//
// Y el parser del contrato nuevo, donde la distinción que vale todo el libro es
// `{}` (decidí no tener nada) vs ausente (me olvidé de contestar).
//
// Correr con `node tests/arena-sombra.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { shadowBroker, shadowRunId } from '../api/_lib/arena-shadow.js';
import { parsePortfolioResponse } from '../api/_lib/arena-rails.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 2) EL CANDADO DE LAS ÓRDENES ─────────────────────────────────────
console.log('\n── la sombra NO PUEDE operar, no es que "no opere" ──');
{
  let leyó = 0;
  const real = {
    getAccount: async () => { leyó++; return { equity: '100000' }; },
    getPositions: async () => { leyó++; return []; },
    getOrders: async () => { leyó++; return []; },
    getOrder: async () => ({}), getClock: async () => ({}), getCalendar: async () => ([]),
    createLimitOrder: async () => ({ id: 'NO-DEBERIA-PASAR' }),
    cancelOrder: async () => ({}), cancelAllOrders: async () => ({}), closeAllPositions: async () => ({}),
  };
  const b = shadowBroker(real);

  ok(b.__shadow === true, 'el broker se identifica como de sombra');

  for (const escritura of ['createLimitOrder', 'cancelOrder', 'cancelAllOrders', 'closeAllPositions']) {
    let lanzó = false;
    try { b[escritura]({ symbol: 'NVDA', qty: 1, side: 'buy', limit_price: 100 }); }
    catch (e) { lanzó = /SOMBRA/.test(e.message); }
    ok(lanzó, `${escritura} LANZA en sombra — que falle ruidosamente es el candado`);
  }

  // Y las LECTURAS sí pasan: sin el libro real, un rebalanceo contra un libro
  // inventado no prueba nada.
  await b.getAccount(); await b.getPositions(); await b.getOrders();
  ok(leyó === 3, 'las lecturas SÍ pasan al cliente real: la sombra necesita el libro de verdad para un diff realista', String(leyó));
}

// ── 1) TABLAS APARTE ─────────────────────────────────────────────────
console.log('\n── la sombra escribe en TABLAS APARTE, no en una columna ──');
{
  const src = readFileSync(new URL('../api/_lib/arena-shadow.js', import.meta.url), 'utf8');
  ok(/arena_shadow_journal/.test(src), 'existe arena_shadow_journal');
  const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/insert into arena_journal/.test(codigo),
    'CANDADO: el módulo de sombra NUNCA escribe en arena_journal — una bandera en la misma tabla está a una consulta mal escrita de contaminar el post-mortem');
  ok(!/\bshadow\s+boolean/.test(codigo), 'y no agrega una columna `shadow` a la tabla real');

  // El runner real tampoco debe tener una columna booleana de sombra.
  const runner = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  ok(!/alter table arena_journal add column .*shadow/i.test(runner), 'el runner tampoco la agrega');

  ok(shadowRunId('claude', new Date('2026-09-17T14:00:00Z')).startsWith('shadow-claude-'),
    'y hasta el id de corrida lleva el prefijo: una fila de sombra se reconoce a simple vista',
    shadowRunId('claude', new Date('2026-09-17T14:00:00Z')));
}

console.log('\n── el ENDPOINT de sombra no puede escribir a Alpaca ──');
{
  const src = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // La forma real es inyectable: `(deps.shadowBroker || shadowBroker)(alpaca)`.
  // Lo que importa no es la sintaxis exacta sino que el cliente real SOLO entre
  // envuelto — nunca pelado.
  ok(/shadowBroker\)?\(alpaca\)/.test(codigo),
    'el endpoint construye su broker envolviendo al cliente real — nunca lo usa pelado');
  for (const escritura of ['createLimitOrder', 'cancelOrder', 'cancelAllOrders', 'closeAllPositions']) {
    ok(!new RegExp('alpaca\\.' + escritura).test(codigo),
      `CANDADO: el endpoint no llama a alpaca.${escritura} directo`);
  }
  ok(/arena_shadow_journal|shadowJournalInsert/.test(codigo), 'y journalea por el camino de sombra');
  ok(!/journalInsert\(/.test(codigo.replace(/shadowJournalInsert\(/g, '')),
    'CANDADO: no usa el journalInsert de la tabla real');
  ok(/phase: 'shadow'/.test(codigo),
    'el gasto se registra como `shadow`: son llamadas reales a siete proveedores y van contra el mismo presupuesto');
  ok(/orders_placed: 0/.test(codigo), 'y el reporte afirma explícitamente cero órdenes');
}

// ── EL PARSER DEL CONTRATO NUEVO ─────────────────────────────────────
console.log('\n── B5/B10: `{}` y ausente NO son lo mismo ──');
{
  const vacio = parsePortfolioResponse('{"plan":"me voy a cash, no veo nada","pesos":{}}');
  ok(vacio.ok && Object.keys(vacio.weights).length === 0,
    'un `pesos` VACÍO es válido y significa liquidar todo e irse a cash');

  const ausente = parsePortfolioResponse('{"plan":"mantengo"}');
  ok(!ausente.ok && /AUSENCIA del campo no es lo mismo/.test(ausente.error),
    'la AUSENCIA del campo se RECHAZA: con omisión = salida, confundirla con "{}" costaría el libro entero', ausente.error);
}

console.log('\n── el contrato duro es plan + pesos; lo demás es tolerado ──');
{
  const completo = parsePortfolioResponse(JSON.stringify({
    plan: 'Roto hacia semis.',
    pesos: { NVDA: 12, AMD: 8, ZM: -10 },
    cash: 70,
    tesis: { NVDA: 'la demanda sigue' },
    positions_review: [{ symbol: 'NVDA', stance: 'hold' }],
    commitments: [{ symbol: 'AMD', text: 'reviso tras el reporte' }],
  }));
  ok(completo.ok, 'una respuesta completa pasa');
  ok(completo.weights.NVDA === 0.12 && completo.weights.ZM === -0.10, 'los pesos en fracción, con el signo del corto', JSON.stringify(completo.weights));
  ok(completo.cash === 0.70, 'el cash también');
  ok(completo.theses.NVDA === 'la demanda sigue', 'y la tesis por posición');
  ok(Array.isArray(completo.positions_review) && Array.isArray(completo.commitments),
    'positions_review y commitments viajan CRUDOS, como en el contrato viejo');

  const sinAccesorios = parsePortfolioResponse('{"plan":"x","pesos":{"NVDA":10}}');
  ok(sinAccesorios.ok,
    'y su ausencia NO aborta: endurecer el contrato con campos accesorios subiría la tasa de aborts, que es lo que la T2 intenta bajar');
}

console.log('\n── malformado = abortado honesto, cero órdenes ──');
{
  ok(!parsePortfolioResponse('no soy json').ok, 'texto suelto se rechaza');
  ok(!parsePortfolioResponse('{"pesos":{}}').ok, 'sin plan se rechaza');
  ok(!parsePortfolioResponse('').ok, 'vacío se rechaza');
  ok(!parsePortfolioResponse('{"plan":"x","pesos":{"NVDA":1200}}').ok, 'un peso fuera de escala se rechaza, no se adivina');
  ok(parsePortfolioResponse('```json\n{"plan":"x","pesos":{"NVDA":10}}\n```').ok,
    'las fences se quitan: des-serializar no es "ajustar la orden"');
  ok(parsePortfolioResponse('Acá va mi decisión:\n{"plan":"x","pesos":{"NVDA":10}}\nEso es todo.').ok,
    'y se extrae el objeto de entre la prosa');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
