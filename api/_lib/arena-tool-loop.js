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

import { callArenaLLM, providerPolicy } from './arena-model.js';
import { toolsForProvider, estimateTokens, compactarResultado, TOOL_CONTEXT_TOKENS } from './arena-tools.js';
import { ARENA_MAX_TOKENS, ARENA_AGENT_DEADLINE_MS, ARENA_LLM_TIMEOUT_MS } from './arena-registry.js';

// Vueltas, no llamadas. Con 20 llamadas de presupuesto y modelos que piden de a
// una, hacen falta al menos 20 vueltas para que el tope de vueltas no se
// convierta en el techo real — que es justo el "número redondo" que se quitó.
// Con modelos que piden de a tres, sobran.
export const MAX_TURNS = Number(process.env.ARENA_TOOL_TURNS_MAX) || 22;

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
// ── LA RESERVA DEL CIERRE ES UN PISO, NO UN TECHO ────────────────────
// Reserva para la vuelta final + el journal. Si al empezar una vuelta queda
// menos que esto, no se empieza: se cierra.
//
// EL BUG DEL 2026-09-17: grok gastó sus 20 herramientas, cortó por `call_budget`
// con reloj de sobra, y después recibió 45s para redactar el libro final sobre
// un payload enorme. Timeout NUESTRO a los 45.003 ms. El resto del presupuesto
// del loop —minutos, en ese caso— se tiraba sin usar.
//
// El turno de cierre es el que convierte una corrida en una decisión: es el
// ÚLTIMO lugar donde hay que ahorrar tiempo. Ahora la reserva es el MÍNIMO que
// se le garantiza, y si el loop terminó temprano se lleva además todo lo que
// sobró (ver `relojDeCierre`).
//
// Subió de 45s a 70s por el mismo motivo: un modelo que razona mucho sobre un
// libro de 8 posiciones no redacta el JSON en 45 segundos. Sale del presupuesto
// del loop, que es tiempo de INVESTIGAR — y de nada sirve investigar si después
// no se alcanza a decidir.
export const RESERVA_CIERRE_MS = Number(process.env.ARENA_CIERRE_MS) || 70000;

// ── EL RELOJ SE DERIVA, NO SE ESCRIBE A MANO ─────────────────────────
// Eran 120s fijos, escritos en una constante. El problema de un número fijo es
// que no sigue al deadline: si alguien sube `ARENA_AGENT_DEADLINE_MS`, el loop
// no se entera y sigue cortándose en 120 aunque sobre tiempo.
//
// LA RESTA, para el camino que tiene scan (arena-run):
//   deadline 270s − scan 90s − cierre 45s − margen 15s = 120s de loop
// Y para el que NO lo tiene (la sombra, contrato nuevo: una sola cadena):
//   deadline 270s − cierre 45s − margen 15s = 210s de loop
//
// El MARGEN son los 15s de Alpaca, el journaleo y la aritmética que no es una
// llamada al LLM. Sin él la resta da EXACTO contra el deadline, y "exacto" en
// un presupuesto de tiempo significa que el primer hipo se lo come: el lint de
// tests/arena-timeouts exige `<`, no `<=`, y tiene razón.
//
// (Que la fórmula reproduzca los 120s que antes estaban escritos a mano en el
// camino de arena-run es la señal de que deriva lo mismo, no algo nuevo.)
//
// ── POR QUÉ NO SON 240s ──────────────────────────────────────────────
// Lety pidió 240s de reloj. No caben, y la cuenta es corta:
//
//     función 300s  (cap del plan Pro, en vercel.json)
//   − margen 30s    para que una corrida que se pasa alcance a ESCRIBIR que se
//                   pasó; un timeout que no se journalea es indistinguible de
//                   una corrida que nunca ocurrió, y el lint lo exige
//   = deadline 270s
//   − cierre 45s    la llamada que convierte una corrida perdida en decisión
//   − margen 15s    Alpaca + journal
//   = 210s de loop  ← el máximo honesto en la sombra
//
// Los 30s que faltan solo salen de comerse uno de los dos márgenes, o sea de
// pagar un número redondo con la evidencia de los fallos. Se eligió el dato.
// `ARENA_TOOL_LOOP_MS` fuerza otro valor sin deploy si se quiere medir.
export const MARGEN_MS = 15000;

export function relojDisponible({ deadlineMs = ARENA_AGENT_DEADLINE_MS, scanMs = 0, reservaMs = RESERVA_CIERRE_MS, margenMs = MARGEN_MS } = {}) {
  return Math.max(30000, deadlineMs - scanMs - reservaMs - margenMs);
}

// El default asume que hubo un scan antes (el caso de arena-run). La sombra,
// que no lo tiene, pasa el suyo con `scanMs: 0`.
export const LOOP_BUDGET_MS = Number(process.env.ARENA_TOOL_LOOP_MS)
  || relojDisponible({ scanMs: ARENA_LLM_TIMEOUT_MS });

// ── EL REINTENTO DEL CUERPO VACÍO ────────────────────────────────────
// Un HTTP 200 con el stream cerrado y sin cuerpo es TRANSITORIO por naturaleza:
// no hay nada en el payload que se pueda corregir, porque el proveedor ni
// siquiera llegó a contestar. Se reintenta UNA vez, con una espera corta.
//
// Dos segundos y no veinte: la vuelta que falló ya se comió ~40s del
// presupuesto del loop, y el reloj de la lambda no perdona. Si el segundo
// intento también vuelve vacío, NO se aborta: se salta al turno de cierre. Un
// PM que investigó ocho veces y no puede escribir su JSON es peor que uno que
// cierra con lo que tiene.
export const REINTENTO_VACIO_MS = Number(process.env.ARENA_EMPTY_RETRY_MS) || 2000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // OpenAI/OpenRouter: el mensaje del asistente y DESPUÉS un mensaje `tool` POR
  // CADA llamada (punto 2).
  const asistente = ecoAsistenteOpenAI(data);
  return [asistente, ...resultados.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text }))];
}

// ── EL ECO, LIMPIO ───────────────────────────────────────────────────
// Antes se ecoaba `_raw_message` TAL CUAL: el objeto entero que devolvió el
// proveedor, con todas sus extensiones. Para los modelos de razonamiento
// (grok, qwen, deepseek) eso incluye `reasoning` y `reasoning_details`, que
// pueden ser miles de caracteres — y que se re-mandan en CADA vuelta siguiente,
// acumulándose.
//
// Dos razones para limpiarlo, y la segunda vale por sí sola:
//
//   1. NO SON DEL CONTRATO. El mensaje `assistant` de la API de OpenAI es
//      `{role, content, tool_calls, name?, refusal?}`. `reasoning` y
//      `reasoning_details` son extensiones de OpenRouter para la RESPUESTA;
//      devolvérselas en la petición es mandarle campos que su esquema de
//      entrada no declara.
//   2. EL PAYLOAD CRECE SIN NECESIDAD. La vuelta 3 de qwen pesaba 36.489
//      caracteres, y buena parte era razonamiento de las vueltas 1 y 2 viajando
//      de vuelta. Eso se paga en tokens de entrada en cada vuelta.
//
// ── LO QUE ESTO CUESTA, declarado ────────────────────────────────────
// Algunos proveedores usan `reasoning_details` para preservar la cadena de
// razonamiento entre turnos, así que quitarlo PUEDE degradar la continuidad del
// razonamiento en esos modelos. Se acepta el costo: hoy tres de siete agentes
// abortan TODAS las corridas. Una posible pérdida de calidad le gana a una
// pérdida segura. `ARENA_ECHO_REASONING=1` lo devuelve al comportamiento viejo
// sin deploy, para poder medir la diferencia en vez de discutirla.
//
// OJO: esto es SOLO el camino de OpenAI. Anthropic EXIGE el eco verbatim con
// los bloques de thinking en su orden original (punto 1 del encabezado), y ese
// camino no se toca.
export const CAMPOS_ASISTENTE_OPENAI = ['role', 'content', 'tool_calls', 'name', 'refusal'];

export function ecoAsistenteOpenAI(data) {
  const crudo = data && data._raw_message;
  const reconstruido = {
    role: 'assistant',
    content: assistantText(data) || null,
    tool_calls: toolUseBlocks(data).map((b) => ({
      id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
    })),
  };
  if (!crudo) return reconstruido;
  if (process.env.ARENA_ECHO_REASONING === '1') return crudo;

  const limpio = {};
  for (const k of CAMPOS_ASISTENTE_OPENAI) {
    if (crudo[k] !== undefined) limpio[k] = crudo[k];
  }
  limpio.role = 'assistant';
  // `content: undefined` no sobrevive a JSON.stringify y el mensaje saldría sin
  // el campo; null es lo que la API espera cuando solo hay tool_calls.
  if (limpio.content === undefined) limpio.content = null;
  // Si el crudo no traía `tool_calls` pero el turno sí pidió herramientas,
  // manda la reconstrucción: un eco sin las llamadas que se están respondiendo
  // deja los `tool` siguientes huérfanos.
  if (!Array.isArray(limpio.tool_calls) && reconstruido.tool_calls.length) {
    limpio.tool_calls = reconstruido.tool_calls;
  }
  return limpio;
}

// ── COMPACTAR LA CONVERSACIÓN ────────────────────────────────────────
// Deja INTACTOS los resultados de las últimas `completas` vueltas y compacta
// los anteriores. Las dos formas de mensaje, porque los dos proveedores
// guardan el resultado en lugares distintos:
//   · OpenAI:     { role: 'tool', tool_call_id, content: '<texto>' }
//   · Anthropic:  { role: 'user', content: [{ type: 'tool_result', content }] }
//
// Trabaja SOBRE LA CONVERSACIÓN, que es lo que se re-envía. `executor.sequence`
// —el registro que alimenta el journal y el replay— no se toca: compactar la
// evidencia sería perder de qué miró el modelo para decidir.
//
// Devuelve cuántos resultados compactó, para poder journalearlo. Una
// compactación que ocurre y no se reporta es un recorte invisible.
export function compactarConversacion(convo, { completas = 1, lineas = 3 } = {}) {
  const indices = [];
  for (let i = 0; i < convo.length; i++) {
    const m = convo[i];
    if (!m) continue;
    if (m.role === 'tool' && typeof m.content === 'string') indices.push(i);
    else if (m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c && c.type === 'tool_result')) indices.push(i);
  }
  // Los últimos `completas` grupos quedan enteros: el modelo acaba de pedirlos y
  // está razonando sobre ellos AHORA. Compactar lo que se acaba de traer sería
  // cobrarle la llamada y no darle el resultado.
  const aCompactar = indices.slice(0, Math.max(0, indices.length - completas));
  let compactados = 0;
  for (const i of aCompactar) {
    const m = convo[i];
    if (m.role === 'tool') {
      const antes = m.content;
      m.content = compactarResultado(antes, { lineas });
      if (m.content !== antes) compactados++;
    } else {
      m.content = m.content.map((c) => {
        if (!c || c.type !== 'tool_result' || typeof c.content !== 'string') return c;
        const nuevo = compactarResultado(c.content, { lineas });
        if (nuevo !== c.content) compactados++;
        return { ...c, content: nuevo };
      });
    }
  }
  return { compactados, grupos: indices.length, intactos: Math.min(completas, indices.length) };
}

// El tamaño de lo que se está por mandar, en tokens estimados. Es el techo que
// de verdad aprieta: el payload crece de forma CUADRÁTICA porque cada resultado
// se queda en la conversación y vuelve a viajar en todas las vueltas siguientes.
export function tokensDeConversacion(system, convo, tools) {
  return estimateTokens(JSON.stringify(system || ''))
    + estimateTokens(JSON.stringify(convo || []))
    + estimateTokens(JSON.stringify(tools || []));
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
  contextTokensMax = TOOL_CONTEXT_TOKENS, compactar = true, vueltasCompletas = 1,
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

  // ── QUÉ CORTÓ LA CORRIDA, con los tres al lado ─────────────────────
  // No alcanza con el nombre del que cortó: hace falta ver los tres para saber
  // si el que ganó lo hizo por poco o por lejos. Un corte por contexto con las
  // llamadas en 6/20 dice que el techo de llamadas está de adorno y que lo que
  // hay que subir es el otro — o compactar más fuerte.
  const limites = () => {
    const usadoMs = clock() - t0;
    const tokens = tokensDeConversacion(system, convo, tools);
    const pct = (a, b) => (b > 0 ? +((a / b) * 100).toFixed(1) : null);
    return {
      llamadas: { usadas: executor.used, tope: executor.budget, intentos: executor.intentos, pct: pct(executor.used, executor.budget) },
      contexto_tokens: { al_cierre: tokens, pico: Math.max(picoTokens, tokens), tope: contextTokensMax, pct: pct(Math.max(picoTokens, tokens), contextTokensMax) },
      reloj_ms: { usado: usadoMs, tope: budgetMs, pct: pct(usadoMs, budgetMs) },
      vueltas: { usadas: turns, tope: maxTurns },
      // ── EL REPARTO ENTRE INVESTIGAR Y DECIDIR ──────────────────────
      // Un corte por `call_budget` a los 40s de un presupuesto de 185 significa
      // que al cierre le quedaron 70 + 145 segundos. Sin este desglose, "grok
      // se pasó de tiempo" no dice si le faltó reloj o si le sobró y no se lo
      // dimos — que es exactamente lo que pasaba.
      reparto_ms: {
        investigacion_usada: usadoMs,
        investigacion_sobrante: Math.max(0, budgetMs - usadoMs),
        cierre_minimo: RESERVA_CIERRE_MS,
        cierre_concedido: cierreConcedidoMs,
        // Cuánto llevaba la corrida cuando se repartió. `investigacion_usada` se
        // mide al final y es posterior, así que el reparto se juzga con ÉSTE.
        reparto_en_ms: cierreEnMs,
      },
      compactacion: { resultados_compactados: compactados, vueltas_intactas: vueltasCompletas, activa: !!compactar },
      nota: 'Los tres topes cortan igual: se cierra con lo que haya, nunca se aborta. `stopped_by` dice cuál ganó; estos porcentajes dicen si ganó por poco o por lejos.',
    };
  };
  let turns = 0;
  let llm = null;
  let sinTiempo = false;
  // Cuerpos vacíos vistos en todo el loop. Viaja al journal: si un agente
  // acumula varios por corrida, el problema es del proveedor y no de una vuelta.
  const vacios = [];
  // Los proveedores que nos colgaron en ESTA corrida. Se acumulan y se excluyen
  // de todas las llamadas siguientes: si Alibaba colgó la vuelta 4, no tiene
  // sentido que atienda el cierre.
  const proveedoresColgados = [];
  // Quién atendió cada vuelta, para el journal. "Alibaba se cuelga" solo
  // significa algo si se sabe quién contestó las vueltas que SÍ anduvieron.
  const proveedoresPorVuelta = [];
  let cuerpoVacio = false;
  let sinContexto = false;
  let sinLlamadas = false;
  let cierreConcedidoMs = null;
  // El instante EXACTO del reparto. `limites()` lee el reloj más tarde, así que
  // sin esto el invariante "investigación + cierre ≤ presupuesto + reserva" no
  // se puede verificar: se estaría sumando un `usado` posterior al reparto
  // contra un techo calculado antes.
  let cierreEnMs = null;
  let compactados = 0;
  let picoTokens = 0;

  while (turns < maxTurns) {
    // EL RELOJ, ANTES de empezar la vuelta. Empezarla y que la mate el deadline
    // del agente a mitad de camino pierde todo lo investigado y journalea un
    // "timeout" sin decir en qué vuelta se quedó.
    if (turns > 0 && restante() < RESERVA_CIERRE_MS) { sinTiempo = true; break; }

    // ── EL TECHO DE CONTEXTO, también ANTES de la vuelta ──────────────
    // Se mide lo que SE VA A MANDAR, no lo que se mandó: pasarse y enterarse
    // después es haber pagado la llamada cara igual. Los tres techos cortan
    // idéntico —se cierra con lo que haya— pero cada uno se NOMBRA, porque
    // "se acabó el presupuesto" sin decir cuál de los tres no dice nada.
    const tokensAhora = tokensDeConversacion(system, convo, tools);
    picoTokens = Math.max(picoTokens, tokensAhora);
    if (turns > 0 && tokensAhora >= contextTokensMax) { sinContexto = true; break; }

    // ── Y EL CUPO DE LLAMADAS, ANTES DE GASTAR LA VUELTA ──────────────
    // Esto no estaba, y con 8 llamadas casi no se notaba. Con 20 sí: un modelo
    // que quema su cupo en la vuelta 6 se comía las 16 vueltas restantes
    // pidiendo herramientas que solo podían devolverle "presupuesto agotado" —
    // y CADA una de esas vueltas es una llamada al LLM con la conversación
    // entera adentro. Se pagaba el contexto completo dieciséis veces para
    // recibir dieciséis rechazos.
    //
    // Sin cupo no hay nada que investigar: se va derecho al cierre, que es
    // exactamente lo que se quería que pasara.
    if (turns > 0 && executor.remaining === 0) { sinLlamadas = true; break; }
    turns++;
    // El techo de ESTA llamada nunca puede pasarse del presupuesto que queda.
    // Sin esto, una llamada colgada de 90s se come el reloj de las vueltas
    // siguientes y el loop termina chocando contra el deadline del agente —
    // que es justo lo que este presupuesto existe para evitar.
    const techo = Math.max(10000, Math.min(timeoutMs || Infinity, restante() - RESERVA_CIERRE_MS));
    const argsVuelta = { agent, system, messages: convo, maxTokens, now, timeoutMs: techo, tools, ...(effort ? { effort } : {}) };
    llm = await call({
      ...argsVuelta,
      ...(proveedoresColgados.length ? { provider: providerPolicy(agent, { ignore: proveedoresColgados }) } : {}),
      ...(trace ? { trace, fase: `loop:vuelta_${turns}` } : {}),
    });
    sumar(llm);
    if (llm && llm.proveedor) proveedoresPorVuelta.push({ vuelta: turns, proveedor: llm.proveedor, ms: llm.ms ?? null, ok: llm.status === 200 && !!llm.data });

    // ── CUERPO VACÍO: se reintenta la MISMA vuelta, una vez ────────────
    // Misma conversación, mismo payload: no hay nada que corregir porque el
    // proveedor no llegó a contestar. Si el segundo también vuelve vacío, se
    // sale del loop hacia el CIERRE, no hacia un abort.
    if (llm && llm.emptyBody) {
      const colgado = llm.proveedor || null;
      if (colgado && !proveedoresColgados.includes(colgado)) proveedoresColgados.push(colgado);
      vacios.push({ vuelta: turns, intento: 1, bytes: llm.bytes ?? 0, proveedor: colgado, timeout_nuestro: !!llm.timedOutLeyendo, ms: llm.ms ?? null });

      // ── EL REINTENTO DE UNA VUELTA ÚTIL VALE MÁS QUE UN SEGUNDO CIERRE ─
      // Antes el reintento se saltaba con "sin reloj" apenas el presupuesto
      // bajaba de RESERVA + 2s, y después el CIERRE quemaba 90s en dos intentos
      // idénticos. Eso es al revés: la vuelta 4 todavía podía traer datos; el
      // segundo cierre solo repetía la misma llamada al mismo proveedor colgado.
      //
      // Ahora el reintento puede morder la reserva del cierre hasta dejarle lo
      // mínimo para UN intento. Un cierre alcanza — si además se le cambia el
      // proveedor, que es lo que se hace abajo.
      const pisoReserva = Math.round(RESERVA_CIERRE_MS / 2);
      const alcanzaElReloj = restante() > pisoReserva + REINTENTO_VACIO_MS + 10000;
      if (alcanzaElReloj) {
        await dormir(REINTENTO_VACIO_MS);
        const techo2 = Math.max(10000, Math.min(timeoutMs || Infinity, restante() - pisoReserva));
        // Y NO se repite igual: se excluye al proveedor que nos colgó. Repetir
        // la misma llamada al mismo proveedor lento es pagar el reloj dos veces
        // por la misma respuesta.
        llm = await call({
          ...argsVuelta, timeoutMs: techo2,
          ...(proveedoresColgados.length ? { provider: providerPolicy(agent, { ignore: proveedoresColgados }) } : {}),
          ...(trace ? { trace, fase: `loop:vuelta_${turns}:reintento_otro_proveedor` } : {}),
        });
        sumar(llm);
        if (llm && llm.emptyBody) vacios.push({ vuelta: turns, intento: 2, bytes: llm.bytes ?? 0, proveedor: llm.proveedor || null, timeout_nuestro: !!llm.timedOutLeyendo, ms: llm.ms ?? null });
      } else {
        vacios.push({ vuelta: turns, intento: 2, omitido: 'sin reloj ni para el cierre: se va directo a cerrar' });
      }
      if (!llm || llm.emptyBody) { cuerpoVacio = true; break; }
    }

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
      return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: 'error', murio_en: dondeMurio, elapsed_ms: clock() - t0, budget_ms: budgetMs, limites: limites(), usage_total: acumulado, cost_usd_total: costoAcumulado, ...(proveedoresPorVuelta.length ? { proveedores: proveedoresPorVuelta } : {}), ...(vacios.length ? { cuerpos_vacios: vacios } : {}) };
    }

    const pedidos = toolUseBlocks(llm.data);
    if (!pedidos.length) {
      // `cuerpos_vacios` viaja incluso cuando la corrida terminó BIEN: un corte
      // que el reintento recuperó sigue siendo un corte, y si se pierde acá, la
      // única evidencia de que el proveedor está inestable son las corridas que
      // además fracasaron — o sea, la mitad del cuadro.
      return { llm, messages: convo, turns, sequence: executor.sequence, stopped_by: turns === 1 ? 'no_tools' : 'end_turn', elapsed_ms: clock() - t0, budget_ms: budgetMs, limites: limites(), usage_total: acumulado, cost_usd_total: costoAcumulado, ...(proveedoresPorVuelta.length ? { proveedores: proveedoresPorVuelta } : {}), ...(vacios.length ? { cuerpos_vacios: vacios } : {}) };
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

    // ── COMPACTAR, DESPUÉS DE AGREGAR ─────────────────────────────────
    // Acá y no antes: lo que se acaba de traer queda entero (el modelo está
    // razonando sobre eso ahora mismo) y lo viejo se resume. Sin esto, el techo
    // de contexto se alcanzaría alrededor de la vuelta 8 y las otras doce
    // llamadas del presupuesto no se podrían usar nunca — el techo de 20 sería
    // decorativo.
    if (compactar) {
      const c = compactarConversacion(convo, { completas: vueltasCompletas });
      compactados += c.compactados;
    }
  }

  // Se acabaron las vueltas O el reloj. En los dos casos, lo mismo: última
  // llamada SIN herramientas para que cierre con su JSON en vez de quedarse
  // pidiendo. Sin esta vuelta, un modelo en bucle —o uno al que se le acabó el
  // tiempo— produce una corrida abortada teniendo todo lo que necesitaba.
  convo.push({
    role: 'user',
    content: cuerpoVacio
      ? 'Hubo un corte de conexión con el proveedor y esta corrida no puede seguir investigando. No pidas más herramientas: respondé AHORA con tu JSON final, usando lo que ya investigaste.'
      : sinLlamadas
        ? 'Se acabó el presupuesto de LLAMADAS a herramientas de esta corrida (no el reloj ni el contexto). No pidas más: respondé AHORA con tu JSON final, usando lo que ya investigaste.'
        : sinContexto
        ? 'Se acabó el presupuesto de CONTEXTO de esta corrida (no el de llamadas ni el reloj): lo que ya investigaste ocupa todo el espacio disponible. No pidas más herramientas: respondé AHORA con tu JSON final. Algunos resultados viejos están marcados [COMPACTADO] — de esos tenés la cabecera y las primeras filas, no la lista entera.'
        : sinTiempo
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
  // ── EL CIERRE SE LLEVA LA RESERVA **MÁS** LO QUE SOBRÓ ──────────────
  // `restante()` es lo que queda del presupuesto de INVESTIGACIÓN, que ya no se
  // va a usar: el loop terminó. Sumarlo a la reserva es la diferencia entre
  // darle a grok 45s tras gastar sus 20 herramientas y darle los ~2 minutos que
  // de verdad sobraban.
  //
  // El techo total no se mueve: `relojDisponible` ya restó la reserva del
  // presupuesto del loop, así que `loop_usado + cierre ≤ budgetMs + RESERVA`
  // pase lo que pase. Lo único que cambia es quién usa el tiempo que sobra.
  const relojDeCierre = () => {
    const usado = clock() - t0;
    cierreEnMs = usado;
    const sobrante = Math.max(0, budgetMs - usado);
    const disponible = RESERVA_CIERRE_MS + sobrante;
    return Math.max(10000, timeoutMs ? Math.min(timeoutMs, disponible) : disponible);
  };
  const llamarCierre = (msgs, extra = {}) => call({
    agent, system, messages: msgs, maxTokens, now,
    timeoutMs: (cierreConcedidoMs = relojDeCierre()),
    tools, toolChoice: cierreToolChoice, ...(effort ? { effort } : {}),
    // El cierre NUNCA va al proveedor que ya nos colgó en esta corrida.
    ...(proveedoresColgados.length ? { provider: providerPolicy(agent, { ignore: proveedoresColgados }) } : {}),
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
    // El cierre TAMBIÉN puede volver vacío. Se reintenta una vez, igual que una
    // vuelta: es la llamada que convierte una corrida perdida en una decisión, y
    // rendirse en el primer corte de conexión desperdicia ocho herramientas ya
    // pagadas.
    if (llm && llm.emptyBody) {
      const colgado = llm.proveedor || null;
      if (colgado && !proveedoresColgados.includes(colgado)) proveedoresColgados.push(colgado);
      vacios.push({ vuelta: 'cierre', intento: 1, bytes: llm.bytes ?? 0, proveedor: colgado, timeout_nuestro: !!llm.timedOutLeyendo, ms: llm.ms ?? null });

      // ── EL SEGUNDO CIERRE VA A OTRO PROVEEDOR, O NO VA ─────────────
      // El trace de qwen mostró dos cierres de 45.002 ms EXACTOS al mismo
      // proveedor: 90 segundos para recibir dos veces la misma nada. Repetir la
      // misma llamada al mismo proveedor lento no es un reintento, es esperar
      // dos veces.
      //
      // Solo se reintenta si (a) sabemos a quién excluir y (b) queda reloj de
      // verdad. Si no se sabe quién atendió, un segundo intento idéntico es el
      // mismo error otra vez, y es mejor cerrar sin él.
      const puedeCambiar = proveedoresColgados.length > 0;
      const quedaReloj = restante() > 12000;
      if (puedeCambiar && quedaReloj) {
        const reintento = await llamarCierre(convo, trace ? { fase: 'cierre:otro_proveedor' } : {});
        anotarCierre('cierre_otro_proveedor', reintento, null);
        if (reintento && !reintento.emptyBody) { llm = reintento; }
        else { vacios.push({ vuelta: 'cierre', intento: 2, bytes: (reintento && reintento.bytes) ?? 0, proveedor: (reintento && reintento.proveedor) || null, timeout_nuestro: !!(reintento && reintento.timedOutLeyendo), ms: (reintento && reintento.ms) ?? null }); }
      } else {
        vacios.push({
          vuelta: 'cierre', intento: 2,
          omitido: !puedeCambiar
            ? 'no se sabe qué proveedor atendió: un segundo intento idéntico sería el mismo error otra vez'
            : `quedan ${Math.round(restante() / 1000)}s: no alcanza para otro intento`,
        });
      }
    }
  } catch (e) {
    anotarCierre('cierre', null, e);
    return {
      llm: { status: 0, data: null, error_detail: `el turno de cierre LANZÓ: ${String((e && e.message) || e)}`, cierre_diagnostico: diagCierre },
      messages: convo, turns, sequence: executor.sequence, stopped_by: 'error_cierre',
      elapsed_ms: clock() - t0, budget_ms: budgetMs, usage_total: acumulado, cost_usd_total: costoAcumulado,
      cierre_diagnostico: diagCierre, limites: limites(),
      ...(vacios.length ? { cuerpos_vacios: vacios } : {}),
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
    // Cada techo se NOMBRA. "Se acabó el presupuesto" sin decir cuál de los
    // tres no dice nada, y los tres se arreglan distinto.
    stopped_by: cuerpoVacio ? 'cuerpo_vacio'
      : sinLlamadas ? 'call_budget'
        : sinContexto ? 'context_budget'
          : sinTiempo ? 'time_budget'
            : 'max_turns',
    elapsed_ms: clock() - t0, budget_ms: budgetMs,
    limites: limites(),
    usage_total: acumulado, cost_usd_total: costoAcumulado,
    cierre_diagnostico: diagCierre,
    ...(proveedoresPorVuelta.length ? { proveedores: proveedoresPorVuelta } : {}),
    ...(proveedoresColgados.length ? { proveedores_colgados: proveedoresColgados } : {}),
    ...(vacios.length ? { cuerpos_vacios: vacios } : {}),
  };
}
