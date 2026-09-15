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
}) {
  const tools = toolsForProvider(agent.provider, toolNames);
  const convo = [...messages];
  let turns = 0;
  let llm = null;

  while (turns < maxTurns) {
    turns++;
    llm = await call({ agent, system, messages: convo, maxTokens, now, timeoutMs, tools });

    // Cualquier cosa que no sea una respuesta usable sale ENTERA hacia arriba.
    if (llm.status !== 200 || !llm.data || llm.refusal || llm.stale || llm.missingKey || llm.unverifiedSlug) {
      return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: 'error' };
    }

    const pedidos = toolUseBlocks(llm.data);
    if (!pedidos.length) {
      return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: turns === 1 ? 'no_tools' : 'end_turn' };
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

  // Se acabaron las vueltas. Última llamada SIN herramientas: el modelo tiene
  // que poder cerrar con su JSON en vez de quedarse pidiendo. Sin esta vuelta
  // final, un modelo que se queda en bucle produce una corrida abortada donde
  // en realidad ya tenía todo lo que necesitaba.
  convo.push({ role: 'user', content: 'Se acabó el presupuesto de investigación de esta corrida. No pidas más herramientas: respondé AHORA con tu JSON final, usando lo que ya tenés.' });
  llm = await call({ agent, system, messages: convo, maxTokens, now, timeoutMs, tools: null });
  return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: 'max_turns' };
}
