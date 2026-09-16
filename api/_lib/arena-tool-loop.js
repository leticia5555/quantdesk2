// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-tool-loop.js — B3: el LOOP de tool use, UNO para los dos
// proveedores.
//
// El scope lo llamó "el trabajo más subestimado de B3" y tenía razón: Anthropic
// y OpenAI no difieren solo en el nombre de los campos, difieren en la FORMA
// del turno que hay que devolver.
//
//   ANTHROPIC                              OPENAI / OPENROUTER
//   ─────────────────────────────────      ─────────────────────────────────
//   pide:  content:[{type:'tool_use',      pide:  message.tool_calls:[{id,
//          id, name, input:{...}}]                function:{name, arguments}}]
//                                                 · arguments es un STRING JSON
//   responde: UN mensaje `user` con        responde: UN mensaje `tool` POR
//          content:[{type:'tool_result',          CADA llamada, con
//          tool_use_id, content}]                 tool_call_id y content
//   eco:   el turno del asistente          eco:   el objeto `message` CRUDO,
//          VERBATIM (bloques de                   incluido tool_calls tal cual
//          thinking incluidos)
//
// Los dos detalles que rompen si se hacen "parecido" en vez de exacto:
//
//   1. ANTHROPIC EXIGE EL ECO VERBATIM del turno del asistente, con los bloques
//      de thinking en su orden original. Reconstruirlo como texto plano es
//      justo lo que el chequeo de "preserved thinking" de Fable 5.1 no perdona
//      — la misma cicatriz que ya está documentada en el guard de fechas.
//   2. OPENAI EXIGE UN MENSAJE `tool` POR CADA `tool_call`. Si el modelo pidió
//      tres herramientas y se responde con uno solo, la API rechaza el turno
//      entero. Agrupar en uno (como hace Anthropic) parece equivalente y no lo es.
//
// ── EL TOPE ES DEL HARNESS ───────────────────────────────────────────
// El loop corta por DOS lados: el presupuesto de llamadas (que lleva el
// ejecutor) y un tope de VUELTAS. Son cosas distintas: un modelo puede pedir
// tres herramientas en una vuelta. Sin el tope de vueltas, un modelo que se
// queda en bucle pidiendo la misma herramienta gasta el reloj de la lambda aun
// con el presupuesto de llamadas agotado.
//
// ── LO QUE NO HACE ───────────────────────────────────────────────────
// No decide, no valida el JSON final y no journalea: devuelve el último turno
// del modelo y la secuencia. Quien llama sigue usando los MISMOS parsers de
// siempre — un loop que además parsea sería un segundo camino de decisión.
// ═══════════════════════════════════════════════════════════════

import { callArenaLLM } from './arena-model.js';
import { toolsForProvider } from './arena-tools.js';
import { ARENA_MAX_TOKENS } from './arena-registry.js';

// Vueltas, no llamadas. Con 8 llamadas de presupuesto y modelos que piden de a
// una, 10 vueltas dan aire de sobra; con modelos que piden de a tres, sobra más.
export const MAX_TURNS = Number(process.env.ARENA_TOOL_TURNS_MAX) || 10;

// ── EL TERCER TOPE: EL RELOJ (B12) ───────────────────────────────────
// Los otros dos topes (llamadas y vueltas) cuentan ACCIONES. Éste cuenta
// TIEMPO, y es el que de verdad manda, porque el reloj que mata no es el nuestro
// sino el de Vercel.
//
// LA CUENTA QUE NO CERRABA. Antes de las herramientas, una corrida eran DOS
// llamadas al LLM: scan + dive ≈ 200s contra un deadline de agente de 240s.
// Con herramientas, el DIVE puede ser hasta 10 llamadas. A 90s de techo por
// llamada, el peor caso no es 200s: es más de 900. El deadline del agente
// (`withDeadline` en arena-run) mataría la corrida a los 240s **perdiendo todo
// lo que el modelo ya había investigado** — y el journal diría "timeout" sin
// una sola pista de en qué vuelta se quedó.
//
// La respuesta NO es solo subir el deadline. Un loop que no sabe qué hora es va
// a chocar contra cualquier número que se le ponga; lo que hace falta es que
// SEPA CUÁNDO PARAR. Así que el loop lleva su propio presupuesto de tiempo y,
// cuando se le acaba, hace exactamente lo mismo que cuando se le acaban las
// vueltas: una última llamada SIN herramientas para que cierre con lo que tiene.
//
// Un cierre con menos investigación de la que quería es una decisión. Un
// timeout es una corrida perdida.
//
// EL NÚMERO SALE DE UNA RESTA, no de una intuición:
//     scan 90s + loop 120s + cierre 45s = 255s  <  270s (deadline del agente)
// Los 15s de diferencia son el margen para Alpaca, el deep dive y la escritura
// al journal; el deadline a su vez deja 30s contra el cap de la función. Si alguien sube este presupuesto sin bajar otra cosa, el loop
// termina chocando contra el deadline y se pierde la corrida entera — hay un
// test que verifica la resta (tests/arena-timeouts).
export const LOOP_BUDGET_MS = Number(process.env.ARENA_TOOL_LOOP_MS) || 120000;

// Reserva para la vuelta final + el journal. Si al empezar una vuelta queda
// menos que esto, no se empieza: se cierra.
const RESERVA_CIERRE_MS = 45000;

// Los bloques `tool_use` de un turno normalizado (los dos proveedores llegan
// acá con la misma forma — ver normalizeOpenRouter).
export function toolUseBlocks(data) {
  return ((data && data.content) || []).filter((b) => b && b.type === 'tool_use');
}

export function assistantText(data) {
  return ((data && data.content) || [])
    .filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
}

// ── EL TURNO DE RESPUESTA, por proveedor ─────────────────────────────
// Devuelve los mensajes que hay que APPENDEAR: el eco del asistente y el/los
// resultado(s). Es la única parte que difiere, y está acá sola a propósito.
export function buildToolTurn(provider, data, resultados) {
  if (provider === 'anthropic') {
    return [
      // VERBATIM: `data.content` tal cual llegó, con los bloques de thinking en
      // su orden original (ver el punto 1 del encabezado).
      { role: 'assistant', content: data.content },
      // UN mensaje `user` con TODOS los tool_result adentro.
      { role: 'user', content: resultados.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) },
    ];
  }
  // OpenAI/OpenRouter: el mensaje del asistente CRUDO (con su `tool_calls`
  // original) y DESPUÉS un mensaje `tool` POR CADA llamada (punto 2).
  const asistente = data._raw_message || {
    role: 'assistant',
    content: assistantText(data) || null,
    tool_calls: toolUseBlocks(data).map((b) => ({
      id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
    })),
  };
  return [asistente, ...resultados.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text }))];
}

// ── EL LOOP ──────────────────────────────────────────────────────────
// Devuelve { llm, messages, turns, sequence, stopped_by }:
//   · `llm`        — la ÚLTIMA respuesta del modelo (la que trae el JSON final)
//   · `messages`   — la conversación completa, para journalear
//   · `stopped_by` — 'end_turn' | 'max_turns' | 'error' | 'no_tools'
//
// Un error del proveedor a mitad del loop NO se traga: se devuelve tal cual,
// con las vueltas que alcanzó a dar. El caller ya sabe journalear un
// `aborted_llm_error`, y perder el diagnóstico acá lo dejaría ciego.
export async function runToolLoop({
  agent, system, messages, executor, maxTokens = ARENA_MAX_TOKENS,
  now = new Date(), timeoutMs, maxTurns = MAX_TURNS, toolNames = null, call = callArenaLLM,
  budgetMs = LOOP_BUDGET_MS, clock = () => Date.now(), effort = undefined, trace = null,
}) {
  const tools = toolsForProvider(agent.provider, toolNames);
  const convo = [...messages];
  // ── EL USAGE DE TODAS LAS VUELTAS, NO EL DE LA ÚLTIMA ──────────────
  // El loop devuelve el ÚLTIMO turno del modelo, y con él su `usage`. Contar
  // eso como el gasto del DIVE es contar una llamada de nueve: con 8
  // herramientas el prompt viaja entero en cada vuelta, así que el costo real
  // es varias veces el de la última. El contador de B9 lee de acá, y un
  // breaker alimentado con un noveno del gasto dispara cuando ya no sirve.
  const acumulado = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0, calls: 0 };
  let costoAcumulado = null;   // null (no reportado) y 0 (gratis) NO son lo mismo
  const sumar = (r) => {
    const u = (r && r.data && r.data.usage) || null;
    acumulado.calls++;
    if (u) {
      acumulado.input_tokens += Number(u.input_tokens) || 0;
      acumulado.output_tokens += Number(u.output_tokens) || 0;
      acumulado.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
      acumulado.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
      acumulado.reasoning_tokens += Number(u.reasoning_tokens) || 0;
    }
    const c = r && r.data && r.data.cost_usd;
    if (Number.isFinite(c)) costoAcumulado = (costoAcumulado || 0) + c;
  };
  const t0 = clock();
  const restante = () => budgetMs - (clock() - t0);
  let turns = 0;
  let llm = null;
  let sinTiempo = false;

  while (turns < maxTurns) {
    // EL RELOJ, ANTES de empezar la vuelta. Empezarla y que la mate el deadline
    // del agente a mitad de camino pierde todo lo investigado y journalea un
    // "timeout" sin decir en qué vuelta se quedó.
    if (turns > 0 && restante() < RESERVA_CIERRE_MS) { sinTiempo = true; break; }
    turns++;
    // El techo de ESTA llamada nunca puede pasarse del presupuesto que queda.
    // Sin esto, una llamada colgada de 90s se come el reloj de las vueltas
    // siguientes y el loop termina chocando contra el deadline del agente —
    // que es justo lo que este presupuesto existe para evitar.
    const techo = Math.max(10000, Math.min(timeoutMs || Infinity, restante() - RESERVA_CIERRE_MS));
    llm = await call({ agent, system, messages: convo, maxTokens, now, timeoutMs: techo, tools, ...(effort ? { effort } : {}), ...(trace ? { trace, fase: `loop:vuelta_${turns}` } : {}) });
    sumar(llm);

    // Cualquier cosa que no sea una respuesta usable sale ENTERA hacia arriba.
    //
    // ── EL PUNTO CIEGO QUE DEJÓ TRES RONDAS SIN DIAGNÓSTICO ──────────
    // Esta salida NO pasa por el bloque de cierre, así que `cierre_diagnostico`
    // queda en undefined — y el journal muestra `cierre: null`. Leído desde
    // afuera eso parece "el cierre no falló", cuando lo que significa es "el
    // cierre NUNCA OCURRIÓ: el loop murió antes". Son cosas opuestas y se veían
    // iguales.
    //
    // Ahora la salida se NOMBRA: en qué vuelta fue, con cuántas herramientas
    // ejecutadas y cuántas pedidas, y qué dijo el proveedor. Es el dato que
    // distingue "murió en la vuelta 8" de "murió en el cierre" sin tener que
    // pedir un trace.
    if (llm.status !== 200 || !llm.data || llm.refusal || llm.stale || llm.missingKey || llm.unverifiedSlug) {
      const dondeMurio = {
        fase: 'loop',
        vuelta: turns,
        de_vueltas_max: maxTurns,
        herramientas_usadas: executor.used,
        herramientas_pedidas: executor.intentos,
        herramientas_tope: executor.budget,
        status: llm.status ?? null,
        detail: llm.error_detail || null,
        provider_error: llm.provider_error || null,
        raw_body: llm.raw_body || null,
        threw_stack: llm.threw_stack || null,
        nota: 'El loop murió DENTRO de una vuelta de herramientas: el turno de cierre nunca llegó a ejecutarse. Un `cierre: null` en el journal significa esto, no que el cierre haya salido bien.',
      };
      return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: 'error', murio_en: dondeMurio, elapsed_ms: clock() - t0, budget_ms: budgetMs, usage_total: acumulado, cost_usd_total: costoAcumulado };
    }

    const pedidos = toolUseBlocks(llm.data);
    if (!pedidos.length) {
      return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: turns === 1 ? 'no_tools' : 'end_turn', elapsed_ms: clock() - t0, budget_ms: budgetMs, usage_total: acumulado, cost_usd_total: costoAcumulado };
    }

    // Las herramientas de UNA vuelta corren EN PARALELO: son lecturas
    // independientes y el modelo ya decidió pedirlas todas. Secuencial solo
    // sumaría latencia contra el reloj de la lambda.
    //
    // OJO: el presupuesto se consume DENTRO de `executor.call`, así que si en
    // una vuelta se piden 3 y solo quedaba 1, las otras 2 devuelven el aviso de
    // presupuesto agotado. Eso es lo correcto: el modelo se entera de cuáles no
    // se ejecutaron en lugar de recibir tres resultados como si todo hubiera ido.
    const resultados = await Promise.all(pedidos.map(async (b) => {
      const out = await executor.call(b.name, b.input);
      return { id: b.id, name: b.name, text: out.text };
    }));

    convo.push(...buildToolTurn(agent.provider, llm.data, resultados));
  }

  // Se acabaron las vueltas O el reloj. En los dos casos, lo mismo: última
  // llamada SIN herramientas para que cierre con su JSON en vez de quedarse
  // pidiendo. Sin esta vuelta, un modelo en bucle —o uno al que se le acabó el
  // tiempo— produce una corrida abortada teniendo todo lo que necesitaba.
  convo.push({
    role: 'user',
    content: sinTiempo
      ? 'Se acabó el TIEMPO de esta corrida (no el presupuesto de herramientas). No pidas más: respondé AHORA con tu JSON final, usando lo que ya investigaste. Una decisión con menos investigación de la que querías sigue siendo una decisión; quedarte sin contestar no lo es.'
      : 'Se acabó el presupuesto de investigación de esta corrida. No pidas más herramientas: respondé AHORA con tu JSON final, usando lo que ya tenés.',
  });
  // El cierre corre contra la RESERVA, no contra lo que quede del presupuesto
  // (que puede ser cero): es la llamada que convierte una corrida perdida en
  // una decisión, y tiene su propio tiempo apartado desde el principio.
  // ── EL CIERRE MANTIENE LAS HERRAMIENTAS DECLARADAS ─────────────────
  // Antes se llamaba con `tools: null`, lo que QUITA el parámetro `tools` del
  // payload. Pero la conversación que se manda YA contiene turnos con
  // `tool_calls` (OpenAI) o bloques `tool_use` (Anthropic), y los dos
  // proveedores esperan que el esquema de las herramientas siga declarado
  // cuando el historial las menciona. Mandar el historial sin el esquema es un
  // payload incoherente, y vía OpenRouter un error del proveedor de abajo
  // vuelve como HTTP 200 con un `error` adentro.
  //
  // Es la mejor explicación que tengo para que grok y deepseek murieran JUSTO
  // al llegar a 8/8 y qwen con 6/8 pasara: el cierre forzado solo ocurre cuando
  // el loop se corta por presupuesto o vueltas. Con 6/8 el modelo terminó solo
  // y nunca pasó por acá.
  //
  // NO PUDE CONFIRMARLO —no tengo acceso al journal ni a los proveedores desde
  // este entorno— así que queda como hipótesis. Lo que sí es cierto en
  // cualquier caso: declarar las herramientas y prohibir su uso con
  // `tool_choice` es la forma correcta de pedir "contestá sin llamar nada", y
  // quitar el esquema no lo es.
  const cierreToolChoice = agent.provider === 'anthropic' ? { type: 'none' } : 'none';
  const llamarCierre = (msgs, extra = {}) => call({
    agent, system, messages: msgs, maxTokens, now,
    timeoutMs: Math.min(timeoutMs || RESERVA_CIERRE_MS, RESERVA_CIERRE_MS),
    tools, toolChoice: cierreToolChoice, ...(effort ? { effort } : {}),
    ...(trace ? { trace, fase: 'cierre' } : {}), ...extra,
  });

  // ── EL CIERRE, CON SU PROPIO DIAGNÓSTICO ───────────────────────────
  // Los abortos de grok y qwen llegaron con `status: 200` y TODO lo demás en
  // null. Eso significa que el fetch fue bien y la falla está al LEER la
  // respuesta — o sea, una capa más abajo de donde estaba puesta la captura.
  //
  // Acá se guarda el `choices[0]` ENTERO del turno de cierre (content,
  // reasoning, tool_calls, finish_reason) pase lo que pase, y también si algo
  // LANZA. Sin el objeto crudo, diagnosticar esto es adivinar — y ya adiviné
  // dos veces.
  const diagCierre = { intentos: [] };
  const anotarCierre = (etiqueta, r, err) => {
    diagCierre.intentos.push({
      etiqueta,
      status: r ? r.status : null,
      error_detail: (r && r.error_detail) || null,
      threw: err ? String((err && err.message) || err) : null,
      stack: err && err.stack ? String(err.stack).slice(0, 400) : null,
      // El turno crudo tal cual lo devolvió el proveedor.
      choice: (r && r.data && r.data._raw_choice) || null,
      texto: r && r.data ? (r.data.content || []).filter((b2) => b2.type === 'text').map((b2) => b2.text || '').join('').slice(0, 400) : null,
      tool_use: r && r.data ? toolUseBlocks(r.data).map((b2) => b2.name) : null,
      stop_reason: (r && r.data && r.data.stop_reason) || null,
    });
  };

  try {
    llm = await llamarCierre(convo);
    anotarCierre('cierre', llm, null);
  } catch (e) {
    anotarCierre('cierre', null, e);
    return {
      llm: { status: 0, data: null, error_detail: `el turno de cierre LANZÓ: ${String((e && e.message) || e)}`, cierre_diagnostico: diagCierre },
      messages: convo, turns, sequence: executor.sequence, stopped_by: 'error_cierre',
      elapsed_ms: clock() - t0, budget_ms: budgetMs, usage_total: acumulado, cost_usd_total: costoAcumulado,
      cierre_diagnostico: diagCierre,
    };
  }
  sumar(llm);

  // ── CASO 2: PIDIÓ HERRAMIENTAS PESE A `tool_choice: none` ──────────
  // Pasa. El proveedor de abajo ignora la restricción, o el modelo la ignora y
  // el proveedor la deja pasar. Un turno con `tool_use` que nadie va a
  // responder deja la conversación colgada y la corrida se pierde teniendo
  // todo lo necesario para decidir.
  //
  // UN solo reintento, con la instrucción más corta posible. Si vuelve a pedir
  // herramientas, se devuelve igual y el diagnóstico lo dice: reintentar en
  // bucle sería gastar el reloj en la misma pared.
  if (llm && llm.status === 200 && llm.data && toolUseBlocks(llm.data).length) {
    const convo2 = [...convo, {
      role: 'user',
      content: 'No llames ninguna herramienta. Respondé SOLO con el JSON del portafolio objetivo, sin texto alrededor.',
    }];
    try {
      const reintento = await llamarCierre(convo2, trace ? { fase: 'reintento_sin_herramientas' } : {});
      anotarCierre('reintento_sin_herramientas', reintento, null);
      if (reintento && reintento.status === 200 && reintento.data && !toolUseBlocks(reintento.data).length) {
        llm = reintento;
        sumar(reintento);
        diagCierre.resuelto_por = 'reintento_sin_herramientas';
      }
    } catch (e) { anotarCierre('reintento_sin_herramientas', null, e); }
  }

  if (llm) llm.cierre_diagnostico = diagCierre;
  return {
    llm, messages: convo, turns, sequence: executor.sequence,
    stopped_by: sinTiempo ? 'time_budget' : 'max_turns',
    elapsed_ms: clock() - t0, budget_ms: budgetMs,
    usage_total: acumulado, cost_usd_total: costoAcumulado,
    cierre_diagnostico: diagCierre,
  };
}
