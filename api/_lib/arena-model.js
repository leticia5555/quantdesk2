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
import { ARENA_TEMPERATURE, ARENA_EFFORT, ARENA_MAX_TOKENS, modelSlugResolved } from './arena-registry.js';
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
  if (!String(text).trim() && msg && typeof msg.reasoning === 'string') text = msg.reasoning;
  const u = raw.usage || {};
  // `finish_reason` de OpenAI → `stop_reason` de Anthropic. El caller usa esto
  // para distinguir "el modelo no respetó el formato" de "se quedó sin tokens a
  // mitad del JSON": sin normalizarlo, ese diagnóstico solo existiría para los
  // agentes de Anthropic y la mitad de la liga quedaría sin explicación.
  const finish = (raw.choices && raw.choices[0] && raw.choices[0].finish_reason) || null;
  return {
    content: [{ type: 'text', text: typeof text === 'string' ? text : String(text) }],
    stop_reason: finish === 'length' ? 'max_tokens' : (finish === 'stop' ? 'end_turn' : finish),
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
export function buildOpenRouterBody({ agent, model, system, messages, maxTokens = ARENA_MAX_TOKENS, now = new Date() }) {
  const caps = (agent && agent.caps) || {};
  const body = {
    model: model || (agent && agent.model),
    max_tokens: maxTokens,
    // La directiva de fecha va en el system (mismo anclaje temporal que Anthropic).
    messages: [{ role: 'system', content: (system || '') + dateDirective(now) }, ...messages],
  };
  if (caps.sampling !== false) body.temperature = ARENA_TEMPERATURE;
  if (caps.effort === 'openrouter') body.reasoning = { effort: ARENA_EFFORT };
  // Caché de prompt: en los modelos de OpenAI vía OpenRouter es AUTOMÁTICA
  // (el proveedor cachea el prefijo por su cuenta, sin marcador). No se manda
  // `cache_control` — sería un campo que el endpoint de OpenAI no conoce.
  // `usage.include` pide el desglose para poder REPORTAR el ahorro en vez de
  // suponerlo.
  body.usage = { include: true };
  return body;
}

async function openRouterFetch({ apiKey, agent, model, system, messages, maxTokens, now }) {
  const body = buildOpenRouterBody({ agent, model, system, messages, maxTokens, now });
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
    signal: AbortSignal.timeout(45000),
  });
  const raw = await r.json().catch(() => null);
  return { status: r.status, raw };
}

// Guard-equivalente al de Anthropic, para OpenRouter: inyecta fecha, escanea
// fechas prospectivas rotas, reintenta UNA vez, y si reincide devuelve stale.
async function guardedOpenRouterCall({ apiKey, agent, model, system, messages, maxTokens, now }) {
  const first = await openRouterFetch({ apiKey, agent, model, system, messages, maxTokens, now });
  if (first.status < 200 || first.status >= 300 || !first.raw) {
    await recordAiCall({ model, now });
    return { status: first.status || 502, data: null };
  }
  const data = normalizeOpenRouter(first.raw);
  const text = data.content.map((b) => b.text).join('').trim();
  const hits = staleProspectiveDates(text, now);
  if (!hits.length) {
    await recordAiCall({ model, usage: data.usage, now });
    return { status: 200, data };
  }

  // Retry único con recordatorio, mismo formato requerido.
  const retryMessages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: retryReminder(hits, now) }];
  const second = await openRouterFetch({ apiKey, agent, model, system, messages: retryMessages, maxTokens, now });
  if (second.status < 200 || second.status >= 300 || !second.raw) {
    // El retry falló en red: mejor la primera respuesta (con su nota de fechas)
    // que un corte — el downstream ya valida el JSON de todos modos.
    await recordAiCall({ model, usage: data.usage, retried: true, now });
    return { status: 200, data, retried: true };
  }
  const data2 = normalizeOpenRouter(second.raw);
  const hits2 = staleProspectiveDates(data2.content.map((b) => b.text).join('').trim(), now);
  await recordAiCall({ model, usage: data2.usage, retried: true, stale: !!hits2.length, now });
  if (hits2.length) return { status: 502, stale: true, hits: hits2, data: null };
  return { status: 200, data: data2, retried: true };
}

// ── ANTHROPIC ────────────────────────────────────────────────────────
// Payload EXPORTADO (misma razón que el de OpenRouter: el smoke manda esto).
export function buildAnthropicPayload({ agent, model, system, messages, maxTokens = ARENA_MAX_TOKENS, now = new Date() }) {
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
  const sysText = (system || '');
  const dateText = dateDirective(now);

  if (caps.cache === 'anthropic') {
    // CACHÉ DE PROMPT. El system del Arena es largo y CONGELADO (el reglamento
    // no cambia entre corridas ni entre agentes); el recordatorio de fecha es lo
    // único volátil. Partirlo en dos bloques con el breakpoint en medio deja el
    // reglamento cacheable y la fecha fuera del prefijo — al revés, un solo
    // bloque con la fecha adentro invalidaría la caché CADA DÍA y el ahorro
    // sería cero. (Regla de oro: estable primero, volátil después del último
    // `cache_control`.)
    payload.system = [
      { type: 'text', text: sysText, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dateText },
    ];
  } else {
    payload.system = sysText + dateText;
  }

  // Temperatura SOLO donde la API la acepta. Fable 5.1 devuelve 400 si viaja.
  if (caps.sampling !== false) payload.temperature = ARENA_TEMPERATURE;
  // `effort` sustituye a la temperatura como perilla de profundidad. Va DENTRO
  // de output_config, no top-level.
  if (caps.effort === 'anthropic') payload.output_config = { effort: ARENA_EFFORT };
  return payload;
}

function anthropicText(data) {
  return ((data && data.content) || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('')
    .trim();
}

async function anthropicFetch({ apiKey, payload }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await r.json().catch(() => null);
  return { status: r.status, raw };
}

// Guard de fechas replicado para el Arena sobre Anthropic (ver el bloque de
// arriba sobre por qué no se usa guardedClaudeCall).
async function guardedAnthropicCall({ apiKey, agent, model, system, messages, maxTokens, now }) {
  const payload = buildAnthropicPayload({ agent, model, system, messages, maxTokens, now });
  const first = await anthropicFetch({ apiKey, payload });
  if (first.status < 200 || first.status >= 300 || !first.raw) {
    await recordAiCall({ model: payload.model, now });
    // El mensaje de error de Anthropic viaja hacia arriba: un 400 por un
    // parámetro no soportado tiene que ser legible en el journal, no un
    // "HTTP 400" mudo que obligue a reproducir la llamada a mano.
    const detail = first.raw && first.raw.error ? first.raw.error.message : null;
    return { status: first.status || 502, data: null, error_detail: detail };
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
  if (!hits.length) {
    await recordAiCall({ model: payload.model, usage: data.usage, now });
    return { status: 200, data };
  }

  // Retry único. El turno del asistente se ecoa con `data.content` VERBATIM
  // (bloques de thinking incluidos, en su orden original): reconstruirlo como
  // texto plano rompería el chequeo de historia de Fable 5.1.
  const retryPayload = buildAnthropicPayload({
    agent, model, system, maxTokens, now,
    messages: [...messages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: retryReminder(hits, now) }],
  });
  const second = await anthropicFetch({ apiKey, payload: retryPayload });
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
export function effectiveParams(agent, maxTokens = ARENA_MAX_TOKENS) {
  const caps = (agent && agent.caps) || {};
  return {
    provider: agent && agent.provider,
    model: agent && agent.model,
    model_label: agent && agent.model_label,
    // null = el parámetro NO se manda (la familia no lo acepta).
    temperature: caps.sampling === false ? null : ARENA_TEMPERATURE,
    effort: caps.effort ? ARENA_EFFORT : null,
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
export async function callArenaLLM({ agent, system, messages, maxTokens = ARENA_MAX_TOKENS, now = new Date() }) {
  // CANDADO DE SLUG: un modelo cuyo slug no se verificó contra el catálogo del
  // proveedor y que no tiene override explícito NO se llama. Ver el encabezado
  // del registry: preferimos no correr a pegarle a un slug inventado.
  if (!modelSlugResolved(agent)) {
    return { status: 0, data: null, unverifiedSlug: true, model: agent && agent.model, agent_id: agent && agent.id };
  }
  const apiKey = providerKey(agent);
  if (!apiKey) return { status: 0, data: null, missingKey: true, provider: agent && agent.provider };

  if (agent.provider === 'anthropic') {
    return guardedAnthropicCall({ apiKey, agent, model: agent.model, system, messages, maxTokens, now });
  }
  if (agent.provider === 'openrouter') {
    return guardedOpenRouterCall({ apiKey, agent, model: agent.model, system, messages, maxTokens, now });
  }
  return { status: 0, data: null, error: 'proveedor desconocido: ' + (agent && agent.provider) };
}
