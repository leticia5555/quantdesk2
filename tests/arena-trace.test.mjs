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
  // Esta aserción afirmaba `turno[0] === data._raw_message` — el eco VERBATIM
  // del objeto del proveedor. Cambió a propósito el 2026-09-16: el crudo de un
  // modelo de razonamiento incluye `reasoning`/`reasoning_details`, que no son
  // del contrato de entrada de OpenAI y se acumulan vuelta a vuelta. Lo que
  // importa preservar es la IDENTIDAD de las llamadas —los tool_call_id que los
  // mensajes `tool` responden—, no el objeto entero.
  ok(turno[0].tool_calls === data._raw_message.tool_calls,
    'y el eco preserva el `tool_calls` del proveedor tal cual: los ids que se responden son los mismos');
  ok(turno[0].tool_calls.map((c) => c.id).sort().join(',') === ids,
    'los ids del eco y los de los mensajes `tool` coinciden exactamente');
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

  // Subió de 4 KB a 16 KB el 2026-09-17: con 4096, los payloads reales (28-36 KB)
  // se recortaban TODOS al mismo largo y el diff entre vueltas reportaba
  // `delta 0` siempre. El recorte destruía justo el número que más importaba.
  ok(TRACE_MAX_BYTES === 16384, 'el default son 16 KB por turno', String(TRACE_MAX_BYTES));
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

// ── 6) EL CUERPO VACÍO ───────────────────────────────────────────────
// EL DIAGNÓSTICO REAL, confirmado por el trace de qwen del 2026-09-16: vuelta
// 3, HTTP 200, 41.5s, cuerpo de CERO bytes. Durante cuatro sombras esto se
// journaleó como "HTTP 200" con `detail`, `raw_body` y `provider_error` en
// null — y los nulls no eran datos faltantes: eran la firma del cuerpo vacío,
// porque `bodySample` quedaba en `''`, que es falsy.
//
// Es un fallo de TRANSPORTE. Por eso ninguna hipótesis sobre la FORMA del
// payload sobrevivía: un payload mal armado vuelve 400 o 200-con-`error`, y los
// dos ya se manejaban.
console.log('\n── 200 + cuerpo vacío: se reintenta y se cierra, no se aborta ──');
{
  const vacio = { status: 200, data: null, emptyBody: true, bytes: 0, error_detail: 'CUERPO VACÍO: …' };
  const conHerramienta = {
    status: 200,
    data: {
      content: [{ type: 'tool_use', id: 'c1', name: 'screener', input: {} }],
      _raw_message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screener', arguments: '{}' } }] },
    },
  };
  const cierreOk = { status: 200, data: { content: [{ type: 'text', text: '{"weights":{"NVDA":0.1}}' }] } };

  // Vuelta 1 pide herramienta · vuelta 2 vacía · reintento vacío · cierre OK.
  {
    const fases = [];
    let n = 0;
    const call = async (a) => { fases.push(a.fase || null); n++; return n === 1 ? conHerramienta : n <= 3 ? vacio : cierreOk; };
    const loop = await runToolLoop({
      agent: { id: 'qwen', provider: 'openrouter', model: 'x' },
      system: 's', messages: [{ role: 'user', content: 'u' }],
      executor: createToolExecutor({ budget: 8, board: null, universe: null, cache: false }),
      call, trace: createTrace(),
    });

    ok(loop.stopped_by === 'cuerpo_vacio',
      'el loop sale por `cuerpo_vacio`, un motivo propio y no un "HTTP 200"', loop.stopped_by);
    // La fase se llama `reintento_otro_proveedor` desde el 2026-09-17: el
    // reintento ya no repite la misma llamada al mismo proveedor —eso era
    // esperar dos veces— sino que excluye al que nos colgó.
    ok(fases.some((f) => /reintento_otro_proveedor/.test(f || '')),
      'la MISMA vuelta se reintenta una vez, pero con OTRO proveedor', JSON.stringify(fases));
    ok(loop.llm === cierreOk,
      'y tras el segundo vacío NO se aborta: se salta al turno de CIERRE y el PM decide con lo que tiene');
    ok(loop.cuerpos_vacios && loop.cuerpos_vacios.length === 2,
      'los dos cortes quedan registrados con su vuelta e intento', JSON.stringify(loop.cuerpos_vacios));
    const ultimoUser = [...loop.messages].reverse().find((m) => m.role === 'user');
    ok(/corte de conexión/.test(ultimoUser.content),
      'y el mensaje de cierre dice la verdad —hubo un corte— en vez de culpar al presupuesto',
      ultimoUser.content.slice(0, 50));
  }

  // Si el reintento SÍ funciona, la corrida sigue normal: un corte transitorio
  // no puede costar las herramientas que faltaban.
  {
    let n = 0;
    const call = async () => { n++; return n === 1 ? vacio : n === 2 ? conHerramienta : cierreOk; };
    const loop = await runToolLoop({
      agent: { id: 'qwen', provider: 'openrouter', model: 'x' },
      system: 's', messages: [{ role: 'user', content: 'u' }],
      executor: createToolExecutor({ budget: 8, board: null, universe: null, cache: false }),
      call,
    });
    ok(loop.stopped_by !== 'cuerpo_vacio',
      'un vacío que se recupera al reintentar NO corta la corrida', loop.stopped_by);
    ok(loop.cuerpos_vacios && loop.cuerpos_vacios.length === 1,
      'pero queda anotado igual, incluso en una corrida que terminó bien: un corte ocurrido es un dato',
      JSON.stringify(loop.cuerpos_vacios));
  }
}

// ── 7) EL ECO LIMPIO ─────────────────────────────────────────────────
// El otro sospechoso de la vuelta 3: el assistant previo se ecoaba TAL CUAL,
// con `reasoning` y `reasoning_details` de OpenRouter, que no son del contrato
// de entrada de OpenAI y que se acumulan vuelta a vuelta.
console.log('\n── el eco del asistente va limpio en el camino de OpenAI ──');
{
  const razonamiento = 'x'.repeat(5000);
  const data = {
    _raw_message: {
      role: 'assistant', content: null,
      reasoning: razonamiento,
      reasoning_details: [{ type: 'encrypted', data: 'zzz' }],
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screener', arguments: '{}' } }],
    },
    content: [{ type: 'tool_use', id: 'c1', name: 'screener', input: {} }],
  };
  const turno = buildToolTurn('openrouter', data, [{ id: 'c1', name: 'screener', text: 'ok' }]);
  const eco = turno[0];

  ok(!('reasoning' in eco) && !('reasoning_details' in eco),
    '`reasoning` y `reasoning_details` NO vuelven al proveedor', Object.keys(eco).join(','));
  ok(eco.role === 'assistant' && eco.content === null && Array.isArray(eco.tool_calls) && eco.tool_calls[0].id === 'c1',
    'pero el `tool_calls` sí, intacto: sin él, los mensajes `tool` que siguen quedan huérfanos');
  ok(JSON.stringify(eco).length < 300,
    'el payload por vuelta cae de ~5 KB a ~100 bytes, y eso se acumula en cada vuelta siguiente',
    String(JSON.stringify(eco).length));

  // El escape: poder volver al comportamiento viejo sin deploy es lo que
  // permite MEDIR si quitar el razonamiento degrada algo, en vez de discutirlo.
  process.env.ARENA_ECHO_REASONING = '1';
  const conRazon = buildToolTurn('openrouter', data, [{ id: 'c1', name: 'screener', text: 'ok' }])[0];
  ok(conRazon.reasoning === razonamiento, 'ARENA_ECHO_REASONING=1 devuelve el eco crudo, sin deploy');
  delete process.env.ARENA_ECHO_REASONING;

  // Un turno sin `_raw_message` sigue reconstruyéndose.
  const sinCrudo = buildToolTurn('openrouter', { content: data.content }, [{ id: 'c1', name: 'screener', text: 'ok' }])[0];
  ok(sinCrudo.tool_calls[0].function.name === 'screener',
    'sin mensaje crudo, el eco se reconstruye desde los bloques normalizados');
}

// ── 8) EL DIFF ENTRE VUELTAS ─────────────────────────────────────────
// La pregunta "¿qué tiene la vuelta 3 que no tenía la 2?" con payloads de
// 36.000 caracteres no se contesta leyendo JSON en una terminal.
console.log('\n── el trace compara una vuelta contra la anterior ──');
{
  const t = createTrace({ maxBytes: 100000 });
  const assistantLimpio = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screener', arguments: '{}' } }] };
  const assistantSucio = { ...assistantLimpio, reasoning: 'zzz', reasoning_details: [{ a: 1 }] };
  t.push({ fase: 'loop:vuelta_2', request: { messages: [{ role: 'user', content: 'u' }, assistantLimpio, { role: 'tool', tool_call_id: 'c1', content: 'r' }] }, response: '{}', status: 200 });
  t.push({ fase: 'loop:vuelta_3', request: { messages: [{ role: 'user', content: 'u' }, assistantSucio, { role: 'tool', tool_call_id: 'c1', content: 'r' }] }, response: '', status: 200 });

  const d = t.report().diff_entre_turnos[0];
  ok(d.de === 'loop:vuelta_2' && d.a === 'loop:vuelta_3', 'compara la vuelta con la anterior');
  const claves = d.cambios.find((c) => c.campo === 'claves_assistant');
  ok(claves && claves.despues.includes('reasoning'),
    'y NOMBRA que aparecieron `reasoning`/`reasoning_details` en el assistant',
    JSON.stringify(claves && claves.despues));
  ok(d.bytes.delta > 0, 'con cuánto creció el cuerpo', JSON.stringify(d.bytes));

  // El descuadre: un tool_call sin su mensaje `tool` rompe el payload, y se ve
  // sin leer nada más. Es la hipótesis de los cupos, medida en vez de supuesta.
  const t2 = createTrace({ maxBytes: 100000 });
  const dosLlamadas = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'x', arguments: '{}' } }] };
  t2.push({ fase: 'v1', request: { messages: [{ role: 'user', content: 'u' }] }, status: 200 });
  t2.push({ fase: 'v2', request: { messages: [{ role: 'user', content: 'u' }, dosLlamadas, { role: 'tool', tool_call_id: 'c1', content: 'r' }] }, status: 200 });
  const d2 = t2.report().diff_entre_turnos[0];
  ok(d2.descuadre_tool && d2.descuadre_tool.tool_calls === 2 && d2.descuadre_tool.tool_results === 1,
    'un tool_call sin su mensaje `tool` se detecta solo: 2 llamadas, 1 resultado',
    JSON.stringify(d2.descuadre_tool));
}

// ── 9) EL TIMEOUT NUESTRO, DISFRAZADO DE CUERPO VACÍO ────────────────
// EL DIAGNÓSTICO FINAL, y una corrección al anterior. El trace de qwen mostró
// 45.002 ms EXACTOS dos veces seguidas. 45.000 es RESERVA_CIERRE_MS: NUESTRO
// techo del turno de cierre.
//
// `fetch` resuelve en cuanto llegan los HEADERS. OpenRouter manda el 200 al
// instante y después keepalives mientras el proveedor de abajo piensa. El
// cuerpo se lee en `r.text()`, y el AbortSignal cubre TAMBIÉN esa lectura — así
// que nuestro reloj vencía a mitad del cuerpo, `r.text()` lanzaba, y un
// `.catch(() => '')` lo convertía en string vacío. Reportábamos "el proveedor
// cerró el stream" cuando el que cortaba éramos nosotros.
console.log('\n── un timeout tragado se ve igual que una falla del otro lado ──');
{
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('   ');          // keepalive, igual que OpenRouter
    // y el cuerpo nunca llega
  });
  await new Promise((r) => srv.listen(0, r));
  const url = 'http://127.0.0.1:' + srv.address().port;

  const t0 = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(300) });
  ok(r.status === 200, 'el fetch resuelve con 200 en cuanto llegan los headers, antes del cuerpo');

  let lanzo = null;
  try { await r.text(); } catch (e) { lanzo = e; }
  ok(lanzo && (lanzo.name === 'TimeoutError' || lanzo.name === 'AbortError'),
    'y es `r.text()` el que lanza cuando NUESTRO reloj vence leyendo el cuerpo', lanzo && lanzo.name);
  ok(Date.now() - t0 >= 280,
    'a los ~300ms: el tiempo que se ve en el trace es el NUESTRO, no el del proveedor');

  // El patrón que lo escondía, escrito tal cual estaba.
  const comoEstaba = await (async () => { try { return await r.text(); } catch { return ''; } })();
  ok(comoEstaba === '',
    'con `.catch(() => \'\')` eso se convierte en cuerpo vacío y el timeout desaparece del reporte');

  srv.close();

  const src = await import('node:fs').then((fs) => fs.readFileSync('api/_lib/arena-model.js', 'utf8'));
  ok(/const abortadoLeyendo = !!lecturaError/.test(src),
    'el código ya NO traga el error: distingue "nos cortamos" de "el proveedor cerró"');
  ok(!/await r\.text\(\)\.catch\(/.test(src),
    'y el `.catch(() => \'\')` que lo escondía ya no existe en NINGÚN proveedor');
  // El mismo `.catch` estaba en el camino de Anthropic. Ahí importa incluso
  // más: claude y control son el par que mide el PISO DE RUIDO, y un timeout
  // mal etiquetado en cualquiera de los dos contamina la única referencia
  // contra la que vale un delta entre modelos.
  ok((src.match(/const abortadoLeyendo = !!lecturaError/g) || []).length === 2,
    'los DOS caminos (OpenRouter y Anthropic) distinguen nuestro corte del suyo',
    String((src.match(/const abortadoLeyendo/g) || []).length));
}

// ── 10) ROUTING DE PROVEEDOR ─────────────────────────────────────────
console.log('\n── el proveedor que cuelga se excluye, no se reintenta igual ──');
{
  const { providerPolicy, buildOpenRouterBody } = await import('../api/_lib/arena-model.js');

  ok(providerPolicy({ id: 'grok' }) === null,
    'sin configuración no se toca el routing: apagar un proveedor a ciegas puede dejar al modelo sin quien lo sirva');

  process.env.ARENA_PROVIDER_IGNORE_QWEN = 'Alibaba';
  const pol = providerPolicy({ id: 'qwen' });
  ok(pol && pol.ignore[0] === 'Alibaba', 'se configura por agente y por env, sin deploy', JSON.stringify(pol));
  ok(pol.allow_fallbacks === true,
    'con fallbacks: un orden es una preferencia, no un candado que deje al agente sin correr');
  delete process.env.ARENA_PROVIDER_IGNORE_QWEN;

  const adHoc = providerPolicy({ id: 'qwen' }, { ignore: ['Alibaba', 'Novita'] });
  ok(adHoc.ignore.length === 2,
    'y se puede excluir al vuelo a quien nos colgó en ESTA corrida, sin tocar env');

  const body = buildOpenRouterBody({
    agent: { id: 'qwen', model: 'q' }, system: 's', messages: [{ role: 'user', content: 'u' }],
    provider: adHoc,
  });
  ok(body.provider && body.provider.ignore.includes('Alibaba'), 'la política viaja en el payload de OpenRouter');

  const sinPol = buildOpenRouterBody({
    agent: { id: 'gemini', model: 'g' }, system: 's', messages: [{ role: 'user', content: 'u' }],
  });
  ok(!('provider' in sinPol), 'y sin política, el payload no lleva el campo: cero cambios para quien no lo necesita');
}

// ── 11) EL REPARTO DEL RELOJ ─────────────────────────────────────────
// El trace mostró la vuelta 4 saltándose su reintento por "sin reloj" y después
// el cierre quemando 90s en DOS intentos idénticos al MISMO proveedor colgado.
// Eso es al revés: la vuelta 4 podía traer datos, el segundo cierre no.
console.log('\n── el reintento de una vuelta útil le gana a un segundo cierre ──');
{
  const src = await import('node:fs').then((fs) => fs.readFileSync('api/_lib/arena-tool-loop.js', 'utf8'));
  ok(/const pisoReserva = Math\.round\(RESERVA_CIERRE_MS \/ 2\)/.test(src),
    'el reintento de una vuelta puede morder la reserva del cierre hasta dejarle lo mínimo para UNO');
  ok(/reintento_otro_proveedor/.test(src),
    'y ese reintento va a OTRO proveedor: repetir la misma llamada al mismo proveedor lento es esperar dos veces');
  ok(/cierre:otro_proveedor/.test(src), 'el segundo cierre también cambia de proveedor');
  ok(/no se sabe qué proveedor atendió/.test(src),
    'y si no se sabe a quién excluir, NO se reintenta: un intento idéntico sería el mismo error otra vez');
  ok(/const relojDeCierre = \(\) =>/.test(src),
    'el cierre pide lo que QUEDA, no 45s que ya no existen');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
