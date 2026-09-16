// ═══════════════════════════════════════════════════════════════
// tests/arena-trace.test.mjs — el trace, y la hipótesis de los cupos.
//
// Tres agentes de OpenRouter abortan corrida tras corrida y llevamos tres
// rondas de hipótesis, cada una plausible y ninguna sobreviviente. Este archivo
// hace dos cosas distintas:
//
//   1. CONTESTA UNA HIPÓTESIS CONCRETA con código en vez de con prosa. Lety
//      propuso: "cuando el modelo pide más herramientas de las que quedan, las
//      rechazadas no reciben un mensaje `tool` con su tool_call_id". Es una
//      hipótesis buena —ese payload sí rompería a varios proveedores— y es
//      FALSIFICABLE acá mismo, sin red y sin esperar a la próxima corrida. Los
//      tests de abajo la ejercitan con el caso exacto: 3 pedidos, 1 de cupo.
//   2. CONGELA LA DIFERENCIA ENTRE "el cierre salió bien" Y "el cierre nunca
//      ocurrió". Las dos producían `cierre: null` en el journal y se veían
//      iguales, que es la razón por la que tres rondas de diagnóstico
//      apuntaron al lugar equivocado.
//
// Correr con `node tests/arena-trace.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { createTrace, recortar, TRACE_MAX_BYTES } from '../api/_lib/arena-trace.js';
import { buildToolTurn, runToolLoop } from '../api/_lib/arena-tool-loop.js';
import { createToolExecutor } from '../api/_lib/arena-tools.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) LA HIPÓTESIS DE LOS CUPOS ─────────────────────────────────────
// El caso exacto: el modelo pide 3 herramientas y solo queda 1 de presupuesto.
console.log('\n── 3 herramientas pedidas, 1 de cupo: ¿qué se le responde? ──');
{
  const executor = createToolExecutor({ budget: 1, board: null, universe: null, cache: false });
  const pedidos = [
    { id: 'call_a', name: 'screener', input: { limit: 5 } },
    { id: 'call_b', name: 'screener', input: { limit: 6 } },
    { id: 'call_c', name: 'screener', input: { limit: 7 } },
  ];
  const resultados = await Promise.all(pedidos.map(async (b) => {
    const out = await executor.call(b.name, b.input);
    return { id: b.id, name: b.name, text: out.text, budget_exhausted: !!out.budget_exhausted };
  }));

  ok(executor.used === 1, 'solo UNA se ejecuta: el techo se respeta', String(executor.used));
  ok(executor.intentos === 3, 'pero las tres cuentan como intento');
  ok(resultados.filter((r) => r.budget_exhausted).length === 2, 'dos vuelven marcadas como rechazadas por cupo');

  // LA PREGUNTA DE LA HIPÓTESIS: ¿las rechazadas tienen texto, o vuelven vacías?
  ok(resultados.every((r) => typeof r.text === 'string' && r.text.length > 0),
    'las TRES traen texto, rechazadas incluidas: ninguna vuelve con `text` undefined',
    JSON.stringify(resultados.map((r) => typeof r.text)));

  // Y ahora el payload que de verdad sale hacia OpenRouter.
  const data = {
    _raw_message: { role: 'assistant', content: null, tool_calls: pedidos.map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: '{}' } })) },
    content: pedidos.map((p) => ({ type: 'tool_use', id: p.id, name: p.name, input: p.input })),
  };
  const turno = buildToolTurn('openrouter', data, resultados);
  const toolMsgs = turno.filter((m) => m.role === 'tool');

  ok(toolMsgs.length === 3,
    'el payload lleva TRES mensajes `tool`, uno por cada tool_call — las rechazadas NO se omiten',
    String(toolMsgs.length));
  const ids = toolMsgs.map((m) => m.tool_call_id).sort().join(',');
  ok(ids === 'call_a,call_b,call_c',
    'y cada uno con SU tool_call_id: no queda ninguna llamada sin responder', ids);
  ok(toolMsgs.every((m) => typeof m.content === 'string' && m.content.length > 0),
    'ninguno va con `content` undefined o vacío, que es la otra forma de romper el mismo payload');

  // HIPÓTESIS DE LETY (2026-09-17): FALSIFICADA en este nivel. El payload que
  // sale está bien formado incluso en el caso exacto que ella describió. Si los
  // tres siguen abortando, la causa está en otra parte del payload — y el trace
  // es lo que la va a mostrar, porque captura el cuerpo entero.
  //
  // Lo que este test NO puede descartar: que lo que rompa sea otra cosa DENTRO
  // del mismo mensaje (el eco de `reasoning` en `_raw_message`, por ejemplo).
  // Eso solo se ve con el cuerpo real de la vuelta que falló.
  ok(turno[0] === data._raw_message,
    'y el eco del asistente es el objeto CRUDO del proveedor, no una reconstrucción');
}

// ── 2) ANTHROPIC: la otra forma, que también responde a todas ────────
console.log('\n── el mismo caso en Anthropic: un user con TODOS los tool_result ──');
{
  const resultados = [
    { id: 'tu_a', name: 'screener', text: 'ok' },
    { id: 'tu_b', name: 'screener', text: 'PRESUPUESTO DE HERRAMIENTAS AGOTADO: ...' },
  ];
  const data = { content: [{ type: 'tool_use', id: 'tu_a', name: 'screener', input: {} }, { type: 'tool_use', id: 'tu_b', name: 'screener', input: {} }] };
  const turno = buildToolTurn('anthropic', data, resultados);
  ok(turno.length === 2 && turno[0].role === 'assistant' && turno[1].role === 'user',
    'Anthropic: eco del asistente + UN mensaje user (no uno por llamada)');
  const results = turno[1].content;
  ok(results.length === 2 && results.every((r) => r.type === 'tool_result' && r.tool_use_id && r.content),
    'con un tool_result por cada tool_use, la rechazada incluida');
  ok(turno[0].content === data.content, 'y el eco es VERBATIM: el mismo array, no una copia reconstruida');
}

// ── 3) "EL CIERRE NUNCA OCURRIÓ" ≠ "EL CIERRE SALIÓ BIEN" ────────────
// Las dos daban `cierre: null`. Esta es la confusión que costó tres rondas.
console.log('\n── morir DENTRO del loop se distingue de morir en el cierre ──');
{
  const executor = createToolExecutor({ budget: 8, board: null, universe: null, cache: false });
  let n = 0;
  // Vuelta 1: pide una herramienta. Vuelta 2: el proveedor devuelve 502.
  const call = async () => {
    n++;
    if (n === 1) {
      return { status: 200, data: { content: [{ type: 'tool_use', id: 'c1', name: 'screener', input: {} }], _raw_message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screener', arguments: '{}' } }] } } };
    }
    return { status: 502, data: null, error_detail: 'OpenRouter HTTP 200 sin choices utilizables', raw_body: '{"error":{"message":"boom"}}' };
  };
  const loop = await runToolLoop({
    agent: { id: 'qwen', provider: 'openrouter', model: 'x' },
    system: 's', messages: [{ role: 'user', content: 'u' }], executor, call,
  });

  ok(loop.stopped_by === 'error', 'el loop sale por error', loop.stopped_by);
  ok(!loop.cierre_diagnostico,
    'y `cierre_diagnostico` NO existe: el turno de cierre nunca llegó a ejecutarse');
  ok(loop.murio_en && loop.murio_en.fase === 'loop',
    'pero ahora la salida se NOMBRA: murio_en.fase = "loop"', JSON.stringify(loop.murio_en && loop.murio_en.fase));
  ok(loop.murio_en.vuelta === 2, 'con el número de vuelta exacto', String(loop.murio_en && loop.murio_en.vuelta));
  ok(loop.murio_en.herramientas_usadas === 1 && loop.murio_en.herramientas_tope === 8,
    'y con cuántas herramientas llevaba contra el techo: es lo que decía "murió al llegar a 8/8"',
    JSON.stringify([loop.murio_en.herramientas_usadas, loop.murio_en.herramientas_tope]));
  ok(/nunca llegó a ejecutarse/.test(loop.murio_en.nota || ''),
    'y la nota dice qué significa un `cierre: null`, para que nadie lo vuelva a leer al revés');
  ok(loop.murio_en.raw_body === '{"error":{"message":"boom"}}',
    'el cuerpo crudo del proveedor viaja con la salida, no solo el status');
}

// ── 4) EL TRACE: el cuerpo que SALE, que es lo que nunca tuvimos ─────
console.log('\n── el trace captura request y response, y declara el recorte ──');
{
  const t = createTrace({ maxBytes: 100 });
  t.push({ fase: 'loop:vuelta_8', provider: 'openrouter', model: 'qwen', request: { messages: [{ role: 'user', content: 'x'.repeat(500) }] }, response: 'y'.repeat(500), status: 200, ms: 120 });
  const turno = t.report().turnos_detalle[0];

  ok(turno.request && turno.request.length <= 100 + 80,
    'el request se recorta al tope pedido', String(turno.request.length));
  ok(/RECORTADO: \d+ caracteres en total/.test(turno.request),
    'y el recorte se DECLARA con el tamaño real: un payload cortado en silencio es una pista falsa');
  ok(turno.fase === 'loop:vuelta_8', 'la fase dice en qué vuelta del ciclo ocurrió');
  ok(turno.status === 200 && turno.ms === 120, 'con status y tiempo');

  // El stack de un throw.
  const t2 = createTrace();
  try { null.x; } catch (e) { t2.push({ fase: 'cierre', threw: e.message, stack: e.stack }); }
  const th = t2.report().turnos_detalle[0];
  ok(/TypeError|Cannot read/.test(th.threw + ' ' + th.stack),
    'un throw queda con su stack, no con un mensaje suelto', th.threw);

  // Serializar no puede tumbar la corrida que intenta explicar.
  const circ = {}; circ.self = circ;
  ok(/no serializable/.test(recortar(circ)), 'una referencia circular NO lanza: se anota como no serializable');

  // El tope de turnos.
  const t3 = createTrace({ maxEntries: 2 });
  for (let i = 0; i < 5; i++) t3.push({ fase: 'loop', request: 'a' });
  ok(t3.turns.length === 2 && t3.descartados === 3,
    'el tope de turnos se respeta y los descartados se CUENTAN, no se ocultan',
    JSON.stringify([t3.turns.length, t3.descartados]));

  ok(TRACE_MAX_BYTES === 4096, 'el default son los 4 KB por turno que pidió Lety');
}

// ── 5) EL TRACE NO CAMBIA LA CORRIDA ─────────────────────────────────
// Si el trace alterara el payload, estaría depurando otra corrida — justo la
// que no falla.
console.log('\n── el trace no altera lo que se manda ──');
{
  const executor = createToolExecutor({ budget: 2, board: null, universe: null, cache: false });
  const payloads = [];
  const call = async (args) => {
    payloads.push(JSON.stringify({ system: args.system, messages: args.messages, tools: !!args.tools, toolChoice: args.toolChoice || null }));
    return { status: 200, data: { content: [{ type: 'text', text: '{"weights":{}}' }] } };
  };
  const base = { agent: { id: 'qwen', provider: 'openrouter', model: 'x' }, system: 's', messages: [{ role: 'user', content: 'u' }], executor, call };
  await runToolLoop({ ...base });
  const sinTrace = [...payloads];
  payloads.length = 0;
  await runToolLoop({ ...base, executor: createToolExecutor({ budget: 2, board: null, universe: null, cache: false }), trace: createTrace() });
  ok(JSON.stringify(sinTrace) === JSON.stringify(payloads),
    'con trace y sin trace, el payload enviado es IDÉNTICO: el trace observa, no participa');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
