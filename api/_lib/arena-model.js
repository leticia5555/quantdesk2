// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-model.js — dispatch de modelo de la LIGA del Arena.
//
// El harness del Arena no debe saber si un agente corre por Anthropic o por
// OpenRouter: le pasa {agent, system, messages, maxTokens} y recibe SIEMPRE
// la MISMA forma normalizada (la de Anthropic: {content:[{text}], usage}) más
// {status, stale, hits, retried}. Así parseScanResponse/parsePlanResponse y el
// journaling downstream no cambian una línea entre proveedores.
//
// DOS proveedores:
//   - anthropic  → reusa guardedClaudeCall (_lib/ai-guard.js): fecha inyectada,
//                  guard anti-fechas-alucinadas con 1 retry, journaling del burn.
//   - openrouter → API estilo OpenAI (chat/completions). Aquí se replica el
//                  MISMO guard (dateDirective + staleProspectiveDates + 1 retry)
//                  reusando las piezas exportadas de ai-guard — para no tocar el
//                  archivo compartido (lo usa toda la app) y aislar el riesgo.
//
// TEMPERATURA: idéntica para todos (ARENA_TEMPERATURE, 0.7), top-level en ambos
// proveedores. LÍMITE CONOCIDO del experimento: cada proveedor interpreta
// `temperature` distinto (rango, sampling) — no es algo que podamos igualar, se
// documenta (docs/arena-liga-scope.md), no se resuelve.
//
// ENV VARS: ANTHROPIC_API_KEY (anthropic) · OPENROUTER_API_KEY (openrouter).
// ═══════════════════════════════════════════════════════════════

import { dateDirective, staleProspectiveDates } from './ai-guard.js';
import { recordAiCall } from './usage.js';
import { ARENA_TEMPERATURE, ARENA_EFFORT, ARENA_MAX_TOKENS, ARENA_LLM_TIMEOUT_MS, ANTHROPIC_CACHE_MIN_TOKENS, modelSlugResolved } from './arena-registry.js';
import { ANTHROPIC_PRICES } from './model.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// ── POR QUÉ EL ARENA YA NO LLAMA A guardedClaudeCall ──────────────────
// `guardedClaudeCall` (_lib/ai-guard.js) sigue siendo el camino de TODA la app
// sobre Haiku, y no se toca: lo usan sim, earnings, Smart $ y los 6 agentes de
// la flota. El Arena se sale de ahí por tres razones concretas de Fable 5.1,
// las tres verificadas contra el contrato de la API:
//
//   1. TEMPERATURA. `guardedClaudeCall` reenvía el payload tal cual, y el
//      payload del Arena traía `temperature: 0.7`. Fable 5.1 responde 400 a
//      `temperature` (y a top_p/top_k). Con ese payload la liga entera de
//      Anthropic aborta en la PRIMERA llamada, todos los días.
//   2. RETRY DEL GUARD DE FECHAS. El retry de ai-guard reconstruye el turno del
//      asistente como TEXTO PLANO (`{role:'assistant', content: text}`). En un
//      modelo con thinking eso descarta los bloques de pensamiento del turno
//      original, que es justo lo que el chequeo de "preserved thinking" de
//      Fable 5.1 no perdona. Acá el eco es `data.content` VERBATIM.
//   3. REFUSAL. Un rechazo del clasificador llega como HTTP 200 con
//      `stop_reason:'refusal'` y sin JSON. Por el camino viejo eso se
//      diagnosticaba como `aborted_malformed_json` — el post-mortem leería
//      "el modelo no supo formatear" cuando la verdad es "el modelo se negó".
//
// Se replica el guard de fechas (dateDirective + staleProspectiveDates + 1
// retry) reusando las piezas EXPORTADAS de ai-guard, mismo patrón que ya se
// había hecho para OpenRouter. Aislar el riesgo > tocar el archivo compartido.

// La API key del proveedor del agente (null si falta → el caller journalea
// aborted_no_api_key sin gastar). anthropic y openrouter comparten una key por
// casa: todos los agentes de OpenRouter usan la MISMA OPENROUTER_API_KEY.
export function providerKey(agent) {
  if (!agent) return null;
  if (agent.provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || null;
  if (agent.provider === 'openrouter') return process.env.OPENROUTER_API_KEY || null;
  return null;
}

// Recordatorio de fecha para el retry (misma intención que el de ai-guard, que
// no lo exporta; se inline para no tocar el archivo compartido).
function retryReminder(hits, now) {
  const iso = now.toISOString().slice(0, 10);
  return `Your previous answer treated past dates as future scenarios (e.g. ${hits.map((h) => `"…${h}…"`).join(', ')}). ` +
    `REMINDER: today is ${iso}; any year before ${now.getUTCFullYear()} is the past. ` +
    `Rewrite your ENTIRE answer in the exact same required format, with correct temporal framing. ` +
    `If you lack knowledge of recent events, say so instead of fabricating context.`;
}

// ¿Este turno pidió herramientas? Lo necesitan los dos guards de fecha.
function pidioHerramientas(data) {
  return ((data && data.content) || []).some((b) => b && b.type === 'tool_use');
}

// ── EL GUARD DE FECHAS Y EL TOOL USE NO SE LLEVAN ────────────────────
// El retry del guard appendea un turno de USUARIO después del turno del
// asistente. Cuando ese turno del asistente pidió HERRAMIENTAS, eso es un
// payload INVÁLIDO en los dos proveedores: Anthropic exige que el mensaje
// siguiente traiga un `tool_result` por cada `tool_use`, y OpenAI un mensaje
// `tool` por cada `tool_call`. El retry devolvería 400 y la corrida moriría con
// un error que no tiene nada que ver con fechas.
//
// Así que en un turno con herramientas el guard NO reintenta. No se pierde
// nada: el turno que pide una herramienta casi no tiene prosa, y el turno FINAL
// —el que trae el JSON y la narrativa, que es donde una fecha alucinada
// importa— llega sin herramientas y sí pasa por el guard completo.
function saltarGuardPorToolUse(data) {
  return pidioHerramientas(data);
}

// OpenRouter (OpenAI-compatible) → forma Anthropic. El contenido puede venir
// como string o como array de partes; se aplana a texto.
function normalizeOpenRouter(raw) {
  if (!raw) return null;
  const msg = raw.choices && raw.choices[0] && raw.choices[0].message;
  let text = (msg && msg.content) || '';
  if (Array.isArray(text)) text = text.map((p) => (p && (p.text || p.content)) || '').join('');
  // CICATRIZ GROK: varios modelos de razonamiento en OpenRouter devuelven la
  // respuesta en `message.reasoning` y dejan `content` vacío cuando el techo de
  // salida los cortó a mitad del pensamiento. Leer solo `content` convertía eso
  // en un string vacío → JSON inválido → `aborted_scan_malformed_json`, con el
  // journal diciendo "el modelo no respetó el formato" cuando en realidad nunca
  // llegó a contestar. Si `content` viene vacío y hay `reasoning`, se usa ése:
  // el parser de JSON ya sabe extraer el objeto de un texto con prosa alrededor.
  // CICATRIZ AMPLIADA: no todos los proveedores usan el mismo campo. OpenRouter
  // normaliza a `reasoning`, pero varios modelos pasan `reasoning_content` tal
  // cual viene de arriba. Leer solo uno deja al otro como respuesta vacía.
  if (!String(text).trim() && msg) {
    for (const campo of ['reasoning', 'reasoning_content']) {
      if (typeof msg[campo] === 'string' && msg[campo].trim()) { text = msg[campo]; break; }
    }
  }
  const u = raw.usage || {};
  // `finish_reason` de OpenAI → `stop_reason` de Anthropic. El caller usa esto
  // para distinguir "el modelo no respetó el formato" de "se quedó sin tokens a
  // mitad del JSON": sin normalizarlo, ese diagnóstico solo existiría para los
  // agentes de Anthropic y la mitad de la liga quedaría sin explicación.
  const finish = (raw.choices && raw.choices[0] && raw.choices[0].finish_reason) || null;
  // B3 · LAS LLAMADAS A HERRAMIENTAS, normalizadas a la forma de Anthropic.
  // OpenAI las manda en `message.tool_calls` con los argumentos como STRING
  // JSON; Anthropic las manda como bloques `tool_use` con el objeto ya
  // parseado. Se normaliza a lo segundo para que el loop de arriba sea uno
  // solo — dos loops es cómo se terminan corriendo dos experimentos distintos.
  const toolCalls = (msg && msg.tool_calls) || [];
  const toolUse = toolCalls.map((tc) => {
    let input = {};
    try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); }
    catch { input = { __unparsed: (tc.function && tc.function.arguments) || '' }; }
    return { type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input };
  });
  const content = [];
  if (String(text).trim()) content.push({ type: 'text', text: typeof text === 'string' ? text : String(text) });
  content.push(...toolUse);
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    content,
    // `tool_calls` de OpenAI → `tool_use` de Anthropic. Sin esto, el loop no
    // podría distinguir "terminó" de "quiere una herramienta" en la mitad de
    // la liga.
    stop_reason: toolUse.length ? 'tool_use'
      : (finish === 'length' ? 'max_tokens' : (finish === 'stop' ? 'end_turn' : finish)),
    // El turno CRUDO del asistente, para poder ecoarlo verbatim en el próximo
    // mensaje: OpenAI exige que el `tool_calls` que se responde sea el mismo
    // objeto que mandó.
    _raw_message: msg || null,
    // EL `choices[0]` ENTERO, para poder journalearlo cuando algo falla al
    // LEER la respuesta. Los abortos con "HTTP 200" y todo null pasaron porque
    // la captura estaba en la capa del fetch —que había ido bien— y no en la de
    // la lectura. Acá queda el objeto completo: content, reasoning, tool_calls,
    // finish_reason.
    _raw_choice: (raw.choices && raw.choices[0]) || null,
    usage: {
      input_tokens: Number(u.prompt_tokens) || 0,
      output_tokens: Number(u.completion_tokens) || 0,
      // Tokens de RAZONAMIENTO y de CACHÉ: sin estos dos el costo reportado de
      // un modelo que razona es ficción (el razonamiento se cobra como salida).
      reasoning_tokens: Number((u.completion_tokens_details || {}).reasoning_tokens) || 0,
      cache_read_input_tokens: Number((u.prompt_tokens_details || {}).cached_tokens) || 0,
    },
    // Costo REAL que OpenRouter cobró por la llamada, cuando lo reporta. Es
    // preferible a multiplicar tokens × un precio que nosotros hayamos copiado.
    cost_usd: Number(u.cost) || null,
  };
}

// Cuerpo de OpenRouter, EXPORTADO para que /api/arena-smoke mande exactamente
// el mismo payload que la corrida real (un smoke que manda otra cosa no prueba
// nada). `reasoning.effort` es el parámetro unificado de OpenRouter; un modelo
// que no razona lo ignora, no falla.
export function buildOpenRouterBody({ agent, model, system, messages, maxTokens = ARENA_MAX_TOKENS, now = new Date(), tools = null, toolChoice = null, effort = ARENA_EFFORT }) {
  const caps = (agent && agent.caps) || {};
  const body = {
    model: model || (agent && agent.model),
    max_tokens: maxTokens,
    // La directiva de fecha va en el system (mismo anclaje temporal que Anthropic),
    // y por el mismo motivo va AL FINAL: en los modelos de OpenAI la caché de
    // OpenRouter es automática sobre el PREFIJO, así que un dato volátil arriba
    // del todo la invalida igual que un `cache_control` mal puesto.
    messages: [{ role: 'system', content: systemSegments(system).join('\n\n') + dateDirective(now) }, ...messages],
  };
  if (caps.sampling !== false) body.temperature = ARENA_TEMPERATURE;
  if (caps.effort === 'openrouter') body.reasoning = { effort: effort || ARENA_EFFORT };
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  // Caché de prompt: en los modelos de OpenAI vía OpenRouter es AUTOMÁTICA
  // (el proveedor cachea el prefijo por su cuenta, sin marcador). No se manda
  // `cache_control` — sería un campo que el endpoint de OpenAI no conoce.
  // `usage.include` pide el desglose para poder REPORTAR el ahorro en vez de
  // suponerlo.
  body.usage = { include: true };
  return body;
}

async function openRouterFetch({ apiKey, agent, model, system, messages, maxTokens, now, timeoutMs = ARENA_LLM_TIMEOUT_MS, tools = null, toolChoice = null, effort = ARENA_EFFORT, trace = null, fase = null }) {
  const body = buildOpenRouterBody({ agent, model, system, messages, maxTokens, now, tools, toolChoice, effort });
  const t0 = Date.now();
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      // Atribución opcional que OpenRouter recomienda; no afecta el resultado.
      'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://quantdesk2.vercel.app',
      'X-Title': 'QuantDesk Arena',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // EL CUERPO CRUDO SE CONSERVA SIEMPRE. `r.json()` que falla devolvía null y
  // ahí se perdía la única evidencia de qué contestó el proveedor — que es
  // exactamente lo que dejó sin diagnóstico a los abortos con "HTTP 200".
  const texto = await r.text().catch(() => '');
  let raw = null;
  try { raw = texto ? JSON.parse(texto) : null; } catch { raw = null; }
  // EL TRACE: el cuerpo que SALIÓ, no solo el que volvió. `bodySample` (800
  // chars de la respuesta) nunca alcanzó para diagnosticar los abortos de
  // OpenRouter porque el sospechoso es el payload de entrada.
  if (trace) trace.push({ fase, provider: 'openrouter', model, request: body, response: texto, status: r.status, ms: Date.now() - t0 });
  return { status: r.status, raw, bodySample: String(texto || '').slice(0, 800) };
}

// Deadline de nivel superior, para envolver TRABAJO, no una sola conexión.
// El `timeoutMs` de los fetch de abajo aborta UNA llamada; esto cubre lo que
// esa capa no ve: un agente que encadena scan + dive, un retry del guard de
// fechas, un parser lento. Devuelve `alTimeout()` en vez de rechazar, porque
// el que llama necesita una FILA que journalear, no una excepción que lo tumbe.
export function withDeadline(promesa, ms, alTimeout) {
  let t;
  const reloj = new Promise((resolve) => { t = setTimeout(() => resolve(alTimeout()), ms); });
  return Promise.race([promesa, reloj]).finally(() => clearTimeout(t));
}

// Envoltorio que convierte un abort (o una caída de red) en un RESULTADO, no en
// una excepción: un agente que se pasa del reloj tiene que aparecer como una
// fila `timeout` en el reporte, no tumbar a los otros seis.
async function timedFetch(fn, timeoutMs, trace = null, fase = null) {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (e) {
    const name = (e && e.name) || '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    // El STACK EXACTO del throw. Sin esto, un error de red y un TypeError
    // nuestro se ven igual en el journal: "se pasó de 90s" o un mensaje suelto.
    if (trace) trace.push({ fase, status: 0, ms: Date.now() - t0, threw: String((e && e.message) || e), stack: e && e.stack });
    return {
      status: 0, raw: null, timedOut,
      netError: timedOut ? `se pasó de ${Math.round(timeoutMs / 1000)}s (abortado a los ${Date.now() - t0}ms)` : String((e && e.message) || e),
      threw_stack: (e && e.stack) ? String(e.stack).slice(0, 1200) : null,
    };
  }
}

// Guard-equivalente al de Anthropic, para OpenRouter: inyecta fecha, escanea
// fechas prospectivas rotas, reintenta UNA vez, y si reincide devuelve stale.
async function guardedOpenRouterCall({ apiKey, agent, model, system, messages, maxTokens, now, timeoutMs = ARENA_LLM_TIMEOUT_MS, tools = null, toolChoice = null, effort = ARENA_EFFORT, trace = null, fase = null }) {
  // `effort` NO se estaba pasando: la firma lo aceptaba y las dos llamadas lo
  // dejaban afuera, así que el escalón 1 del breaker bajaba el effort en
  // Anthropic y NO en OpenRouter — cinco de los siete seguían caros.
  const first = await timedFetch(() => openRouterFetch({ apiKey, agent, model, system, messages, maxTokens, now, timeoutMs, tools, toolChoice, effort, trace, fase }), timeoutMs, trace, fase);
  if (first.status < 200 || first.status >= 300 || !first.raw) {
    await recordAiCall({ model, now });
    return {
      status: first.status || 502, data: null, timedOut: !!first.timedOut,
      error_detail: first.netError || (first.bodySample ? `cuerpo no-JSON: ${first.bodySample.slice(0, 200)}` : null),
      raw_body: first.bodySample || null,
      threw_stack: first.threw_stack || null,
    };
  }

  // ── OPENROUTER DEVUELVE HTTP 200 CON UN ERROR ADENTRO ────────────────
  // Es su forma de reportar fallas del proveedor de abajo: rate limit del
  // modelo, contexto excedido, moderación. El código leía `choices[0]`, no lo
  // encontraba, y armaba un turno VACÍO que moría más adelante como si el
  // modelo no hubiera respetado el formato. Un 200 con `error` es un error y se
  // reporta como tal, con el mensaje del proveedor.
  if (first.raw.error || !Array.isArray(first.raw.choices) || !first.raw.choices.length) {
    const e = first.raw.error || {};
    await recordAiCall({ model, now });
    return {
      status: 502, data: null,
      error_detail: `OpenRouter HTTP 200 sin choices utilizables${e.message ? ': ' + String(e.message).slice(0, 200) : ''}${e.code ? ` (code ${e.code})` : ''}`,
      provider_error: e.message ? { message: e.message, code: e.code ?? null, type: e.type ?? null } : null,
      raw_body: first.bodySample || null,
    };
  }

  const data = normalizeOpenRouter(first.raw);
  if (!data) {
    await recordAiCall({ model, now });
    return { status: 502, data: null, error_detail: 'no se pudo normalizar la respuesta de OpenRouter', raw_body: first.bodySample || null };
  }
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
  const hits = staleProspectiveDates(text, now);
  if (!hits.length || saltarGuardPorToolUse(data)) {
    await recordAiCall({ model, usage: data.usage, now });
    return { status: 200, data, ...(hits.length ? { date_guard_skipped: 'tool_use' } : {}) };
  }

  // Retry único con recordatorio, mismo formato requerido.
  const retryMessages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: retryReminder(hits, now) }];
  const second = await timedFetch(() => openRouterFetch({ apiKey, agent, model, system, messages: retryMessages, maxTokens, now, timeoutMs, tools, toolChoice, effort, trace, fase: (fase || '') + ':retry_fechas' }), timeoutMs, trace, fase);
  if (second.status < 200 || second.status >= 300 || !second.raw) {
    // El retry falló en red: mejor la primera respuesta (con su nota de fechas)
    // que un corte — el downstream ya valida el JSON de todos modos.
    await recordAiCall({ model, usage: data.usage, retried: true, now });
    return { status: 200, data, retried: true };
  }
  const data2 = normalizeOpenRouter(second.raw);
  if (!data2 || second.raw.error || !Array.isArray(second.raw.choices) || !second.raw.choices.length) {
    // El retry vino roto: se devuelve la PRIMERA respuesta, que era usable.
    await recordAiCall({ model, usage: data.usage, retried: true, now });
    return { status: 200, data, retried: true, retry_failed: true, raw_body: second.bodySample || null };
  }
  const hits2 = staleProspectiveDates(data2.content.map((b) => b.text).join('').trim(), now);
  await recordAiCall({ model, usage: data2.usage, retried: true, stale: !!hits2.length, now });
  if (hits2.length) return { status: 502, stale: true, hits: hits2, data: null };
  return { status: 200, data: data2, retried: true };
}

// ── ANTHROPIC ────────────────────────────────────────────────────────
// Payload EXPORTADO (misma razón que el de OpenRouter: el smoke manda esto).
// `system` acepta un STRING o un ARRAY de segmentos. El array es el prefijo
// cacheable por partes: `[reglamento, contexto compartido]`. Se une con '\n\n'
// y el breakpoint de caché va al FINAL de todo el array, nunca en medio.
//
// POR QUÉ AL FINAL Y NO POR SEGMENTO: el marcador de Anthropic cachea el
// prefijo ACUMULADO hasta donde está, y por debajo del mínimo del modelo (1.024
// tokens) se IGNORA EN SILENCIO — ni escribe, ni avisa. El reglamento del SCAN
// mide ~760 tokens: marcado solo, no cachea nada y el smoke reporta `cache_read:
// 0` sin explicación. Marcado junto con el contexto compartido de la corrida, el
// prefijo pasa los 2.000 y sí cachea. Un solo breakpoint, al final del bloque
// estable.
export function systemSegments(system) {
  return (Array.isArray(system) ? system : [system]).map((x) => String(x || '')).filter(Boolean);
}

// ── EL CHEQUEO DEL PISO (para que el silencio sea imposible) ─────────
// El bug original no fue "la caché está mal configurada": fue que el bloque
// marcado no llegaba al mínimo del modelo, y por debajo del mínimo el proveedor
// IGNORA el marcador sin escribir, sin cobrar de más y SIN DECIR NADA. Cero
// ahorro, cero error, cero pista — y así estuvo hasta que el smoke reportó un
// `cache_read: 0` que nadie sabía interpretar.
//
// Esta función convierte ese silencio en un dato. Devuelve SIEMPRE una fila que
// el smoke publica y el runner journalea, con la estimación del prefijo, el
// piso del modelo y el veredicto. No bloquea nada: un prefijo corto sigue
// corriendo (la corrida vale más que el ahorro), pero deja de ser invisible.
export function cachePrefixReport(agent, system) {
  const caps = (agent && agent.caps) || {};
  const segs = systemSegments(system);
  const chars = segs.reduce((n, x) => n + x.length, 0);
  const tokens_est = Math.ceil(chars / 4);   // ~4 chars/token: sirve para "cerca del piso", no para facturar
  const min = ANTHROPIC_CACHE_MIN_TOKENS;
  const out = { channel: caps.cache || null, segments: segs.length, chars, tokens_est, min_tokens: min };
  if (caps.cache !== 'anthropic') {
    out.status = caps.cache === 'auto' ? 'auto' : 'unsupported';
    out.note = caps.cache === 'auto'
      ? 'caché automática del proveedor sobre el prefijo: no hay marcador que poner, pero el orden estable→volátil igual manda.'
      : 'esta familia no soporta caché explícita de prompt.';
    return out;
  }
  out.status = tokens_est >= min ? 'ok' : 'below_min';
  out.note = tokens_est >= min
    ? null
    : `El prefijo cacheable estimado (~${tokens_est} tokens) NO llega al mínimo del modelo (${min}). El marcador se va a IGNORAR EN SILENCIO: cache_write y cache_read van a salir en 0 y el ahorro va a ser cero. Mové más contexto estable al system (o revisá que el contexto compartido de la corrida esté entrando).`;
  return out;
}

export function buildAnthropicPayload({ agent, model, system, messages, maxTokens = ARENA_MAX_TOKENS, now = new Date(), tools = null, toolChoice = null, effort = ARENA_EFFORT }) {
  const caps = (agent && agent.caps) || {};
  const payload = {
    model: model || (agent && agent.model),
    max_tokens: maxTokens,
    // La directiva de fecha se concatena ACÁ (no en ai-guard) porque acá se
    // decide dónde cae el breakpoint de caché: la fecha cambia todos los días,
    // así que va DESPUÉS del marcador, nunca antes.
    system: undefined,
    messages,
  };
  const segs = systemSegments(system);
  const sysText = segs.join('\n\n');
  const dateText = dateDirective(now);

  if (caps.cache === 'anthropic') {
    // CACHÉ DE PROMPT. Todo lo ESTABLE de la corrida —reglamento, cómo leer
    // cada campo, y el contexto de mercado, que es IDÉNTICO para los siete
    // agentes— va antes del marcador; el recordatorio de fecha y el libro de
    // cada agente van después. Regla de oro: estable primero, volátil después
    // del último `cache_control`. Al revés, la fecha adentro del bloque marcado
    // invalidaría la caché cada día y el ahorro sería cero.
    payload.system = [
      { type: 'text', text: sysText, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dateText },
    ];
  } else {
    payload.system = sysText + dateText;
  }

  // B3 · HERRAMIENTAS. Van DESPUÉS del system en el payload pero ANTES del
  // último `cache_control` conceptualmente: las definiciones son estables (no
  // cambian entre corridas ni entre agentes), así que forman parte del prefijo
  // que se cachea. Anthropic las cuenta dentro del prefijo cacheado si están
  // antes del breakpoint, y acá lo están — el breakpoint vive en el system.
  if (tools && tools.length) {
    payload.tools = tools;
    if (toolChoice) payload.tool_choice = toolChoice;
  }

  // Temperatura SOLO donde la API la acepta. Fable 5.1 devuelve 400 si viaja.
  if (caps.sampling !== false) payload.temperature = ARENA_TEMPERATURE;
  // `effort` sustituye a la temperatura como perilla de profundidad. Va DENTRO
  // de output_config, no top-level.
  if (caps.effort === 'anthropic') payload.output_config = { effort: effort || ARENA_EFFORT };
  return payload;
}

function anthropicText(data) {
  return ((data && data.content) || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('')
    .trim();
}

async function anthropicFetch({ apiKey, payload, timeoutMs = ARENA_LLM_TIMEOUT_MS, trace = null, fase = null }) {
  const t0 = Date.now();
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // EL CUERPO CRUDO SE CONSERVA SIEMPRE. `r.json()` que falla devolvía null y
  // ahí se perdía la única evidencia de qué contestó el proveedor — que es
  // exactamente lo que dejó sin diagnóstico a los abortos con "HTTP 200".
  const texto = await r.text().catch(() => '');
  let raw = null;
  try { raw = texto ? JSON.parse(texto) : null; } catch { raw = null; }
  // El trace también acá: el par claude↔control es el CONTROL del experimento.
  // Comparar el payload que sí funciona contra el que falla es la mitad del
  // diagnóstico, y solo se puede si los dos se capturan igual.
  if (trace) trace.push({ fase, provider: 'anthropic', model: payload && payload.model, request: payload, response: texto, status: r.status, ms: Date.now() - t0 });
  return { status: r.status, raw, bodySample: String(texto || '').slice(0, 800) };
}

// Guard de fechas replicado para el Arena sobre Anthropic (ver el bloque de
// arriba sobre por qué no se usa guardedClaudeCall).
async function guardedAnthropicCall({ apiKey, agent, model, system, messages, maxTokens, now, timeoutMs = ARENA_LLM_TIMEOUT_MS, tools = null, toolChoice = null, effort = ARENA_EFFORT, trace = null, fase = null }) {
  const payload = buildAnthropicPayload({ agent, model, system, messages, maxTokens, now, tools, toolChoice, effort });
  const first = await timedFetch(() => anthropicFetch({ apiKey, payload, timeoutMs, trace, fase }), timeoutMs, trace, fase);
  if (first.status < 200 || first.status >= 300 || !first.raw) {
    await recordAiCall({ model: payload.model, now });
    // El mensaje de error de Anthropic viaja hacia arriba: un 400 por un
    // parámetro no soportado tiene que ser legible en el journal, no un
    // "HTTP 400" mudo que obligue a reproducir la llamada a mano.
    const detail = (first.raw && first.raw.error ? first.raw.error.message : null) || first.netError || null;
    return { status: first.status || 502, data: null, timedOut: !!first.timedOut, error_detail: detail };
  }
  const data = first.raw;

  // RECHAZO DEL CLASIFICADOR: HTTP 200, sin contenido útil. Se devuelve como su
  // propia condición para que el journal diga "se negó", no "no supo formatear".
  if (data.stop_reason === 'refusal') {
    await recordAiCall({ model: payload.model, usage: data.usage, now });
    return { status: 200, data, refusal: true, refusal_details: data.stop_details || null };
  }

  const text = anthropicText(data);
  const hits = staleProspectiveDates(text, now);
  if (!hits.length || saltarGuardPorToolUse(data)) {
    await recordAiCall({ model: payload.model, usage: data.usage, now });
    return { status: 200, data, ...(hits.length ? { date_guard_skipped: 'tool_use' } : {}) };
  }

  // Retry único. El turno del asistente se ecoa con `data.content` VERBATIM
  // (bloques de thinking incluidos, en su orden original): reconstruirlo como
  // texto plano rompería el chequeo de historia de Fable 5.1.
  const retryPayload = buildAnthropicPayload({
    agent, model, system, maxTokens, now, tools, toolChoice, effort,
    messages: [...messages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: retryReminder(hits, now) }],
  });
  const second = await timedFetch(() => anthropicFetch({ apiKey, payload: retryPayload, timeoutMs, trace, fase: (fase || '') + ':retry_fechas' }), timeoutMs, trace, fase);
  if (second.status < 200 || second.status >= 300 || !second.raw) {
    await recordAiCall({ model: payload.model, usage: data.usage, retried: true, now });
    return { status: 200, data, retried: true };
  }
  const data2 = second.raw;
  if (data2.stop_reason === 'refusal') {
    await recordAiCall({ model: payload.model, usage: data2.usage, retried: true, now });
    return { status: 200, data: data2, refusal: true, refusal_details: data2.stop_details || null, retried: true };
  }
  const hits2 = staleProspectiveDates(anthropicText(data2), now);
  await recordAiCall({ model: payload.model, usage: data2.usage, retried: true, stale: !!hits2.length, now });
  if (hits2.length) return { status: 502, stale: true, hits: hits2, data: null };
  return { status: 200, data: data2, retried: true };
}

// Costo en USD de una llamada de Anthropic, con los precios del catálogo
// vigente (_lib/arena-registry.js). Devuelve null si el modelo no está en la
// tabla — un costo inventado es peor que un costo ausente.
export function anthropicCostUsd(model, usage) {
  const px = ANTHROPIC_PRICES[model];
  if (!px || !usage) return null;
  const cached = Number(usage.cache_read_input_tokens) || 0;
  const fresh = Math.max(0, (Number(usage.input_tokens) || 0));
  const write = Number(usage.cache_creation_input_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  const cacheRead = px.cache_read != null ? px.cache_read : px.in;
  return (fresh * px.in + write * px.in * 1.25 + cached * cacheRead + out * px.out) / 1e6;
}

// ── PARÁMETROS EFECTIVOS de un agente ────────────────────────────────
// Lo que REALMENTE se le manda a la API, no lo que el reglamento aspira a
// mandarle. Existe porque desde el 2026-09-15 los parámetros dejaron de ser
// iguales para los siete (Fable 5.1 rechaza `temperature` con 400), y una liga
// donde eso no está escrito por agente es una liga donde el post-mortem tiene
// que adivinar con qué corrió cada uno.
//
// `temperature: null` NO significa 0: significa que el parámetro no viaja y que
// el sampling lo decide el proveedor. La distinción importa — leerlo como 0
// haría creer que ese agente corre determinista, que es lo contrario.
export function effectiveParams(agent, maxTokens = ARENA_MAX_TOKENS, effort = ARENA_EFFORT) {
  const caps = (agent && agent.caps) || {};
  return {
    provider: agent && agent.provider,
    model: agent && agent.model,
    model_label: agent && agent.model_label,
    // null = el parámetro NO se manda (la familia no lo acepta).
    temperature: caps.sampling === false ? null : ARENA_TEMPERATURE,
    effort: caps.effort ? (effort || ARENA_EFFORT) : null,
    effort_channel: caps.effort || null,   // 'anthropic' | 'openrouter' | null
    max_tokens: maxTokens,
    prompt_cache: caps.cache || null,      // 'anthropic' | 'auto' | null
    slug_verified: !!(agent && agent.slug_verified),
  };
}

// ¿Dos agentes corren con parámetros idénticos? Es la pregunta que decide si el
// control sigue siendo control: `claude` y `control` TIENEN que dar true.
export function sameParams(a, b) {
  const norm = (x) => JSON.stringify({ ...effectiveParams(x), model_label: undefined, slug_verified: undefined });
  return norm(a) === norm(b);
}

// ── API pública: una llamada, cualquier proveedor ────────────────────
// Devuelve { status, data:{content:[{text}],usage} | null, stale?, hits?,
// retried?, missingKey?, refusal?, unverifiedSlug? } — la MISMA forma sin
// importar el proveedor.
// ── COSTO DE OPENROUTER ──────────────────────────────────────────────
// OpenRouter devuelve `usage.cost` (el cobro REAL) cuando lo reporta, y ése
// siempre gana. Cuando no lo manda, el costo quedaba en null y la corrida no
// tenía cifra: siete modelos gastando y un total de $0.0000.
//
// Este fallback multiplica tokens × el precio del CATÁLOGO VIVO del propio
// OpenRouter (`pricing.prompt` / `pricing.completion` de GET /api/v1/models).
// No es un precio que copiamos a mano en un archivo — es el que el proveedor
// publica hoy. Aun así es una ESTIMACIÓN y se marca como tal
// (`cost_source: 'catalog_estimate'`), porque no tiene en cuenta descuentos,
// mínimos por request ni el precio distinto de los tokens cacheados.
//
// Los tokens de razonamiento NO se suman aparte: OpenRouter ya los incluye en
// `completion_tokens` (vienen desglosados en completion_tokens_details). Sumar
// ambos contaría el razonamiento dos veces.
export function openRouterCostUsd(usage, pricing) {
  if (!usage || !pricing) return null;
  const inPer = Number(pricing.input), outPer = Number(pricing.output);
  if (!Number.isFinite(inPer) || !Number.isFinite(outPer)) return null;
  const inTok = Number(usage.input_tokens) || 0;
  const outTok = Number(usage.output_tokens) || 0;
  const usd = (inTok / 1e6) * inPer + (outTok / 1e6) * outPer;
  return Number.isFinite(usd) ? +usd.toFixed(6) : null;
}

// Precios del catálogo vivo, por slug: { 'x-ai/grok-4.6': {input, output} }.
// Cacheado en el proceso: el catálogo no cambia dentro de una corrida y son
// 446 modelos de JSON que no hace falta bajar dos veces.
let priceCache = { at: 0, map: null };
const PRICE_TTL_MS = 10 * 60e3;
export async function openRouterPrices({ timeoutMs = 20000, now = Date.now() } = {}) {
  if (priceCache.map && now - priceCache.at < PRICE_TTL_MS) return priceCache.map;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return priceCache.map || null;
    const j = await r.json();
    const map = {};
    for (const m of (j && j.data) || []) {
      if (!m || !m.id || !m.pricing) continue;
      const input = Number(m.pricing.prompt) * 1e6;
      const output = Number(m.pricing.completion) * 1e6;
      if (Number.isFinite(input) && Number.isFinite(output)) map[m.id] = { input: +input.toFixed(3), output: +output.toFixed(3) };
    }
    priceCache = { at: now, map };
    return map;
  } catch { return priceCache.map || null; }   // el costo es observabilidad: nunca tumba una corrida
}

export function __resetPriceCache() { priceCache = { at: 0, map: null }; }

// `trace` es un sink opcional (ver _lib/arena-trace.js). null en el camino
// normal: sin él no se construye ni se recorre nada, así que una corrida de
// producción no paga el trace que solo se mira cuando algo falla.
export async function callArenaLLM({ agent, system, messages, maxTokens = ARENA_MAX_TOKENS, now = new Date(), timeoutMs = ARENA_LLM_TIMEOUT_MS, tools = null, toolChoice = null, effort = ARENA_EFFORT, trace = null, fase = null }) {
  // CANDADO DE SLUG: un modelo cuyo slug no se verificó contra el catálogo del
  // proveedor y que no tiene override explícito NO se llama. Ver el encabezado
  // del registry: preferimos no correr a pegarle a un slug inventado.
  if (!modelSlugResolved(agent)) {
    return { status: 0, data: null, unverifiedSlug: true, model: agent && agent.model, agent_id: agent && agent.id };
  }
  const apiKey = providerKey(agent);
  if (!apiKey) return { status: 0, data: null, missingKey: true, provider: agent && agent.provider };

  if (agent.provider === 'anthropic') {
    return guardedAnthropicCall({ apiKey, agent, model: agent.model, system, messages, maxTokens, now, timeoutMs, tools, toolChoice, effort, trace, fase });
  }
  if (agent.provider === 'openrouter') {
    return guardedOpenRouterCall({ apiKey, agent, model: agent.model, system, messages, maxTokens, now, timeoutMs, tools, toolChoice, effort, trace, fase });
  }
  return { status: 0, data: null, error: 'proveedor desconocido: ' + (agent && agent.provider) };
}
