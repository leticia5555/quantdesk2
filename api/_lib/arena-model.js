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

import { guardedClaudeCall, dateDirective, staleProspectiveDates } from './ai-guard.js';
import { recordAiCall } from './usage.js';
import { ARENA_TEMPERATURE } from './arena-registry.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
  const u = raw.usage || {};
  return {
    content: [{ type: 'text', text: typeof text === 'string' ? text : String(text) }],
    usage: { input_tokens: Number(u.prompt_tokens) || 0, output_tokens: Number(u.completion_tokens) || 0 },
  };
}

async function openRouterFetch({ apiKey, model, system, messages, maxTokens, now }) {
  const body = {
    model,
    temperature: ARENA_TEMPERATURE,
    max_tokens: maxTokens,
    // La directiva de fecha va en el system (mismo anclaje temporal que Anthropic).
    messages: [{ role: 'system', content: (system || '') + dateDirective(now) }, ...messages],
  };
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
async function guardedOpenRouterCall({ apiKey, model, system, messages, maxTokens, now }) {
  const first = await openRouterFetch({ apiKey, model, system, messages, maxTokens, now });
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
  const second = await openRouterFetch({ apiKey, model, system, messages: retryMessages, maxTokens, now });
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

// ── API pública: una llamada, cualquier proveedor ────────────────────
// Devuelve { status, data:{content:[{text}],usage} | null, stale?, hits?,
// retried?, missingKey? } — la MISMA forma sin importar el proveedor.
export async function callArenaLLM({ agent, system, messages, maxTokens, now = new Date() }) {
  const apiKey = providerKey(agent);
  if (!apiKey) return { status: 0, data: null, missingKey: true, provider: agent && agent.provider };

  if (agent.provider === 'anthropic') {
    // guardedClaudeCall ya inyecta fecha, aplica el guard con retry y journalea
    // el burn. La temperatura va en el payload (se reenvía a Anthropic tal cual).
    return guardedClaudeCall({
      apiKey,
      payload: { model: agent.model, max_tokens: maxTokens, temperature: ARENA_TEMPERATURE, system, messages },
      now,
    });
  }
  if (agent.provider === 'openrouter') {
    return guardedOpenRouterCall({ apiKey, model: agent.model, system, messages, maxTokens, now });
  }
  return { status: 0, data: null, error: 'proveedor desconocido: ' + (agent && agent.provider) };
}
