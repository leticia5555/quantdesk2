// ═══════════════════════════════════════════════════════════════
// /api/arena-smoke — la compuerta del cambio de modelos (2026-09-15).
//
// Una corrida de la liga con modelos nuevos puede fallar de siete maneras
// distintas y todas se ven igual en el journal: "aborted". Este endpoint las
// separa ANTES de que el cron gaste, y lo hace pegándole a los siete con EL
// PROMPT REAL — no con un "hola, ¿estás ahí?", que no prueba nada de lo que
// importa (si el modelo respeta el formato, cuánto le cuesta y si el techo de
// salida le alcanza).
//
// DOS PASOS, en orden. El primero es gratis y el segundo cuesta dinero:
//
//   PASO 1 — CATÁLOGO (0 tokens). Resuelve el slug de cada agente contra el
//     catálogo VIVO de su proveedor: OpenRouter GET /api/v1/models (público) y
//     Anthropic GET /v1/models. Tres resultados por agente:
//       · `exact`     — el slug existe tal cual. Listo.
//       · `suggested` — no existe, pero el catálogo tiene candidatos parecidos.
//                       Se listan con el `ARENA_MODEL_<ID>=...` ya escrito para
//                       copiar y pegar en Vercel.
//       · `missing`   — no existe y no se le parece nada. El modelo no está en
//                       ese proveedor con ese nombre.
//     Este paso existe porque los slugs default de los cinco de OpenRouter se
//     escribieron SIN poder consultar el catálogo (egress bloqueado). Son
//     candidatos, no hechos, y el registry los marca `slug_verified:false`.
//     Acá es donde dejan de ser candidatos.
//
//   PASO 2 — PROMPT REAL (cuesta tokens). Solo para los agentes con slug
//     `exact`. Manda el MISMO system prompt del SCAN y un user prompt armado
//     con el BUFFET REAL de hoy (gatherContext, el mismo self-fetch de la
//     corrida), con el MISMO techo de salida, el MISMO effort y el MISMO
//     payload que construye _lib/arena-model.js. Reporta por agente:
//       json_ok · stop_reason · truncated · tokens (in/out/reasoning/cache) ·
//       costo USD · latencia · los tickers que nombró.
//
// EL PORTAFOLIO ES UN STAND-IN DECLARADO: $100k en efectivo, sin posiciones.
// El smoke NO toca las siete cuentas de Alpaca (no necesita sus keys y no
// tiene por qué leerlas para probar un modelo). Eso significa que el prompt
// del smoke es el real en todo MENOS en el bloque PORTFOLIO, y se dice acá en
// vez de dejar que alguien lo descubra comparando.
//
// NO ESCRIBE NADA: ni en arena_journal, ni en arena_state, ni en Alpaca. El
// burn de tokens sí se contabiliza (recordAiCall, dentro de callArenaLLM) —
// es gasto real y tiene que aparecer en el contador de la casa.
//
//   GET /api/arena-smoke              → pasos 1 y 2 sobre la liga activa
//   GET /api/arena-smoke?catalog=1    → SOLO el paso 1 (gratis, 0 tokens)
//   GET /api/arena-smoke?catalog=1&buscar=qwen
//       → TODOS los slugs de esa familia con su `endpoint_count`, sus
//         proveedores y su precio. Gratis, 0 tokens. Nace del callejón de qwen:
//         `qwen3.8-max` tiene UN proveedor (Alibaba), así que no hay routing que
//         lo salve — para elegir reemplazo hace falta ver la familia entera y no
//         el slug que ya está configurado.
//   GET /api/arena-smoke?agent=grok   → un solo agente
//   GET /api/arena-smoke?phase=dive   → prueba con el prompt del DIVE
//
// GATES: ARENA_ADMIN_KEY (obligatoria — sin ella el endpoint responde 503 y no
// se puede correr). NO es CRON_SECRET: este endpoint lo dispara una persona a
// mano y gasta dinero real en siete proveedores, así que tiene su propia llave
// y no comparte la del cron. NO exige ARENA_ENABLED: el smoke es justamente lo
// que se corre ANTES de prender el switch.
//
// Se manda de CUALQUIERA de estas tres formas, son equivalentes:
//   curl -H "Authorization: Bearer $ARENA_ADMIN_KEY" ".../api/arena-smoke"
//   curl -H "x-admin-key: $ARENA_ADMIN_KEY"          ".../api/arena-smoke"
//   curl ".../api/arena-smoke?key=$ARENA_ADMIN_KEY"
// Se hace trim de los dos lados (el \n que se cuela al pegar el valor en
// Vercel no debería costar una hora de debug). Cuando no coincide, el 401 dice
// POR DÓNDE llegó, cuántos chars traía y la huella sha256 de lo recibido — la
// key nunca viaja en la respuesta.
//
// ENV VARS: ARENA_ADMIN_KEY (obl) · ANTHROPIC_API_KEY · OPENROUTER_API_KEY ·
//           ARENA_MODEL_<ID> (opc, override de slug) · PUBLIC_BASE_URL
// ═══════════════════════════════════════════════════════════════

import { checkAdminAuth } from './_lib/arena-admin.js';
import {
  gatherContext, buildScanSystemPrompt, buildScanUserPrompt, buildSharedContext,
  buildDiveSystemPrompt, buildDiveUserPrompt, resolveBaseUrl, PROMPT_VERSION,
} from './arena-run.js';
import { parseScanResponse, parsePlanResponse } from './_lib/arena-guard.js';
import {
  callArenaLLM, providerKey, buildAnthropicPayload, buildOpenRouterBody, anthropicCostUsd, withDeadline,
  openRouterCostUsd, cachePrefixReport,
} from './_lib/arena-model.js';
import {
  activeAgents, agentById, ARENA_MAX_TOKENS, ARENA_EFFORT, ARENA_TEMPERATURE, modelSlugResolved,
  ANTHROPIC_CACHE_MIN_TOKENS, ARENA_LLM_TIMEOUT_MS, ARENA_LLM_TIMEOUT_ORIGEN, ARENA_AGENT_DEADLINE_MS,
  techoLlmSospechoso,
} from './_lib/arena-registry.js';
import { LOOP_BUDGET_MS, RESERVA_CIERRE_MS, MARGEN_MS } from './_lib/arena-tool-loop.js';

// ── LOS RELOJES, EN UN SOLO LUGAR Y CON SU ORIGEN ────────────────────
// Cuatro techos distintos gobiernan una corrida y viven en tres archivos:
// el de UNA llamada al proveedor (env-overridable), el del loop de
// herramientas, la reserva del cierre y el deadline del agente. Cada uno tiene
// un motivo y ninguno se ve desde afuera.
//
// El modo de falla que esto cierra: `ARENA_LLM_TIMEOUT_MS=15000` puesto para
// una prueba y nunca quitado no rompe ningún test, no falla el deploy y no
// aparece en ninguna respuesta — hasta que corta el dive de un agente en una
// ronda viva, y ahí se lee como "el proveedor se cayó".
export function relojesEfectivos() {
  const aviso = techoLlmSospechoso();
  return {
    una_llamada_ms: ARENA_LLM_TIMEOUT_MS,
    una_llamada_origen: ARENA_LLM_TIMEOUT_ORIGEN,
    loop_herramientas_ms: LOOP_BUDGET_MS,
    reserva_cierre_ms: RESERVA_CIERRE_MS,
    margen_ms: MARGEN_MS,
    deadline_agente_ms: ARENA_AGENT_DEADLINE_MS,
    funcion_max_duration_s: 300,
    // La cuenta que tiene que cerrar, escrita: si no cierra, el agente muere
    // sin journalear y eso es indistinguible de una corrida que nunca ocurrió.
    cuenta: `loop ${Math.round(LOOP_BUDGET_MS / 1000)}s + cierre ${Math.round(RESERVA_CIERRE_MS / 1000)}s + margen ${Math.round(MARGEN_MS / 1000)}s = ${Math.round((LOOP_BUDGET_MS + RESERVA_CIERRE_MS + MARGEN_MS) / 1000)}s contra un deadline de ${Math.round(ARENA_AGENT_DEADLINE_MS / 1000)}s`,
    cuenta_ok: LOOP_BUDGET_MS + RESERVA_CIERRE_MS + MARGEN_MS <= ARENA_AGENT_DEADLINE_MS,
    ...(aviso ? { aviso } : {}),
  };
}

// ── LA COMPUERTA: ARENA_ADMIN_KEY ────────────────────────────────────
// La lógica vive en _lib/arena-admin.js desde que /api/arena-reset pasó a usar
// la MISMA llave. Se re-exporta acá para no romper a quien la importe de este
// módulo — tests/arena-smoke-auth.test.mjs entre otros, que así sigue probando
// la función que de verdad corre en los dos endpoints.
export { checkAdminAuth, adminKeyCandidates } from './_lib/arena-admin.js';

// ── PRESUPUESTO DE TIEMPO ────────────────────────────────────────────
// 300s de función, 7 agentes EN PARALELO, 90s de reloj por agente.
//
// OJO: este `export const maxDuration` NO alcanza por sí solo. `vercel.json`
// declara `functions` para `api/*.js`, y ahí es donde el número se vuelve real
// — con el glob en 60s, este 300 no servía de nada y la corrida moría con
// FUNCTION_INVOCATION_TIMEOUT sin dejar una sola fila. Los dos tienen que decir
// lo mismo; si cambiás uno, cambiá el otro.
export const maxDuration = 300;

// Reloj por agente. Con los siete en paralelo el techo de la corrida es
// max(agentes) ≈ 90s + el buffet, no la suma — por eso entra holgado en 300.
const PROBE_TIMEOUT_MS = (() => {
  const n = Number(process.env.ARENA_SMOKE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 && n <= 280000 ? Math.floor(n) : 90000;
})();

const OPENROUTER_CATALOG = 'https://openrouter.ai/api/v1/models';
const ANTHROPIC_CATALOG = 'https://api.anthropic.com/v1/models?limit=1000';
// La versión de la API de Anthropic, NO una fecha. Como constante nombrada
// porque así lo hace el resto del repo (ai-guard, arena-model y los seis
// agentes) y porque el lint de fechas reconoce ese nombre: escrita en línea,
// `'2023-06-01'` se lee como una fecha hardcodeada y tumba el lint.
const ANTHROPIC_VERSION = '2023-06-01';

// ── Paso 1: catálogos ────────────────────────────────────────────────
async function fetchOpenRouterCatalog() {
  try {
    const r = await fetch(OPENROUTER_CATALOG, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, ids: [], models: [] };
    const j = await r.json();
    const models = (j && j.data) || [];
    return { ok: true, ids: models.map((m) => m.id), models };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), ids: [], models: [] }; }
}

// ── LOS ENDPOINTS DE UN MODELO: quién lo sirve, y cuántos ────────────
// `/api/v1/models` lista los MODELOS; los PROVEEDORES de cada uno viven en un
// endpoint aparte. La diferencia no es cosmética: el 2026-09-17 qwen3.8-max
// resultó tener `endpoint_count: 1` —Alibaba y nadie más— y por eso
// `ARENA_PROVIDER_IGNORE_QWEN=Alibaba` devolvió "All providers have been
// ignored". Un modelo con un solo proveedor no tiene ruta alternativa: si ese
// proveedor es lento, el modelo es lento, y no hay routing que lo arregle.
//
// NO PUDE VERIFICAR LA FORMA DE ESTA RESPUESTA: el sandbox donde se escribió
// esto no alcanza openrouter.ai (403 en el CONNECT). Así que se leen VARIOS
// nombres de campo posibles y, si ninguno matchea, se devuelven las claves
// crudas en `campos_vistos` en vez de inventar un cero. Un `endpoint_count: 0`
// que en realidad significa "no supe leerlo" es peor que no traerlo.
async function fetchEndpoints(slug) {
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${slug}/endpoints`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    const d = (j && j.data) || j || {};
    const lista = d.endpoints || d.providers || (Array.isArray(d) ? d : null);
    if (!Array.isArray(lista)) {
      return { ok: false, error: 'no se encontró la lista de endpoints', campos_vistos: Object.keys(d).slice(0, 20) };
    }
    return {
      ok: true,
      endpoint_count: lista.length,
      proveedores: lista.map((e) => ({
        nombre: e.provider_name || e.name || e.provider || null,
        contexto: e.context_length ?? null,
        max_salida: (e.max_completion_tokens ?? e.max_output_tokens) ?? null,
        precio_in_musd: precioPorMillon(e.pricing && e.pricing.prompt),
        precio_out_musd: precioPorMillon(e.pricing && e.pricing.completion),
      })),
    };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// OpenRouter publica el precio POR TOKEN como string. Se pasa a USD por millón,
// que es como se habla de esto en todos lados.
function precioPorMillon(x) {
  const n = Number(x);
  return Number.isFinite(n) ? +(n * 1e6).toFixed(3) : null;
}

async function fetchAnthropicCatalog(apiKey) {
  if (!apiKey) return { ok: false, error: 'falta ANTHROPIC_API_KEY', ids: [], models: [] };
  try {
    const r = await fetch(ANTHROPIC_CATALOG, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, ids: [], models: [] };
    const j = await r.json();
    const models = (j && j.data) || [];
    return { ok: true, ids: models.map((m) => m.id), models };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), ids: [], models: [] }; }
}

// Tokens alfanuméricos de un slug o de una etiqueta humana:
// 'x-ai/grok-4.6' → ['xai','grok','4','6'] ; 'Grok 4.6' → ['grok','4','6'].
function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Candidatos del catálogo ordenados por parecido contra el slug propuesto Y la
// etiqueta humana del modelo. Deliberadamente tonto y explicable (coincidencia
// de tokens con bonus por vendor): el humano decide, esto solo acota la lista.
function suggest(agent, catalogIds) {
  const want = new Set([...tokens(agent.model), ...tokens(agent.model_label)]);
  const vendor = String(agent.model || '').split('/')[0].toLowerCase();
  const scored = catalogIds.map((id) => {
    const have = tokens(id);
    let score = have.filter((t) => want.has(t)).length;
    if (vendor && id.toLowerCase().startsWith(vendor + '/')) score += 2;
    return { id, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.id.length - b.id.length)
    .slice(0, 6).map((x) => x.id);
}

function resolveSlug(agent, catalog) {
  const override = process.env['ARENA_MODEL_' + agent.id.toUpperCase()] || null;
  const out = {
    agent: agent.id, name: agent.name, model_label: agent.model_label,
    provider: agent.provider, slug: agent.model, slug_source: override ? 'env' : 'default',
    slug_verified_in_registry: !!agent.slug_verified,
  };
  if (!catalog.ok) {
    out.resolution = 'catalog_unavailable';
    out.detail = `No se pudo leer el catálogo de ${agent.provider}: ${catalog.error}. Sin catálogo no se afirma que el slug exista.`;
    return out;
  }
  if (catalog.ids.includes(agent.model)) { out.resolution = 'exact'; return out; }
  const cands = suggest(agent, catalog.ids);
  out.resolution = cands.length ? 'suggested' : 'missing';
  out.candidates = cands;
  out.fix = cands.length
    ? cands.map((id) => `ARENA_MODEL_${agent.id.toUpperCase()}=${id}`)
    : [`Ningún modelo del catálogo de ${agent.provider} se parece a "${agent.model_label}". Revisá el nombre con Lety o el proveedor.`];
  return out;
}

// ── Paso 2: el prompt real ───────────────────────────────────────────
// Portafolio STAND-IN. Declarado acá y en la respuesta (`portfolio: 'stand_in'`)
// para que nadie lea el resultado del smoke como si fuera una corrida real.
const STAND_IN = {
  account: { equity: 100000, cash: 100000 },
  positions: [],
  openOrders: [],
};

// `shared` es el CONTEXTO COMPARTIDO de la corrida: va en el prefijo cacheado,
// junto al system y antes del breakpoint. El smoke lo arma igual que la corrida
// real — si acá se mandara el prompt en un solo bloque, el smoke mediría una
// caché que la corrida no tiene.
function buildPrompts(phase, buffet) {
  if (phase === 'dive') {
    // Slate fijo del buffet (los primeros nombres con canal), sin deep dive:
    // el smoke mide formato y costo, no calidad de research.
    const candidates = Object.keys(buffet.channelsByTicker || {}).slice(0, 3);
    return {
      system: buildDiveSystemPrompt('Claude PM'),
      shared: null,   // el DIVE no lleva contexto compartido: su system ya pasa el piso solo
      user: buildDiveUserPrompt({
        ...STAND_IN, previous: null, scanThesis: '(smoke)',
        candidates, deepDive: {}, closes: {}, channels: buffet.channelsByTicker || {},
      }),
    };
  }
  return {
    system: buildScanSystemPrompt(),
    shared: buildSharedContext(buffet),
    user: buildScanUserPrompt({ ...STAND_IN, buffet, previous: null }),
  };
}

// Los segmentos del system tal como viajan: `[reglamento, compartido]`.
const systemFor = (prompts) => (prompts.shared ? [prompts.system, prompts.shared] : [prompts.system]);

// Tamaño del payload que efectivamente se manda, por proveedor. Sirve para
// explicar el costo de entrada sin tener que adivinarlo.
function payloadChars(agent, system, user) {
  const messages = [{ role: 'user', content: user }];
  const p = agent.provider === 'anthropic'
    ? buildAnthropicPayload({ agent, system, messages })
    : buildOpenRouterBody({ agent, system, messages });
  return JSON.stringify(p).length;
}

async function probeAgent(agent, phase, prompts, timeoutMs = PROBE_TIMEOUT_MS, pricing = null) {
  const t0 = Date.now();
  const row = {
    agent: agent.id, name: agent.name, model_label: agent.model_label,
    provider: agent.provider, model: agent.model, phase,
    temperature: agent.caps && agent.caps.sampling === false ? null : ARENA_TEMPERATURE,
    effort: agent.caps && agent.caps.effort ? ARENA_EFFORT : null,
    max_tokens: ARENA_MAX_TOKENS,
    payload_chars: payloadChars(agent, systemFor(prompts), prompts.user),
    // EL PISO DE LA CACHÉ, medido ANTES de llamar. Si el prefijo no lo cruza,
    // el marcador se ignora en silencio y `cache_read`/`cache_write` van a salir
    // en 0 sin ninguna explicación — que es exactamente el reporte que abrió
    // este pendiente.
    cache_prefix: cachePrefixReport(agent, systemFor(prompts)),
  };
  if (!providerKey(agent)) {
    return { ...row, ok: false, failure: 'missing_api_key', detail: `Falta la key de ${agent.provider}.` };
  }

  const llm = await withDeadline(
    callArenaLLM({
      agent, system: systemFor(prompts), messages: [{ role: 'user', content: prompts.user }],
      maxTokens: ARENA_MAX_TOKENS, timeoutMs,
    }).catch((e) => ({ status: 0, data: null, thrown: String((e && e.message) || e) })),
    timeoutMs + 5000,   // 5s de gracia: si el fetch aborta solo, gana su error, que es más específico
    () => ({ status: 0, data: null, timedOut: true, hardStop: true }),
  );
  row.ms = Date.now() - t0;

  if (llm.timedOut || llm.hardStop) {
    return { ...row, ok: false, failure: 'timeout',
      detail: `No contestó en ${Math.round(timeoutMs / 1000)}s${llm.hardStop ? ' (corte duro del harness)' : ''}. ` +
        'Los demás agentes siguieron: esta fila es de este agente, no de la corrida.' };
  }
  if (llm.thrown) return { ...row, ok: false, failure: 'threw', detail: llm.thrown };

  if (llm.unverifiedSlug) return { ...row, ok: false, failure: 'unverified_slug', detail: 'Bloqueado por el candado de slug: corré ?catalog=1 y poné ARENA_MODEL_' + agent.id.toUpperCase() + '.' };
  if (llm.refusal) return { ...row, ok: false, failure: 'refusal', detail: llm.refusal_details || 'stop_reason=refusal' };
  if (llm.stale) return { ...row, ok: false, failure: 'stale_dates', detail: 'El guard anti-fechas lo frenó dos veces: ' + (llm.hits || []).join(', ') };
  if (llm.status !== 200 || !llm.data) {
    return { ...row, ok: false, failure: 'http_' + llm.status, detail: llm.error_detail || ('HTTP ' + llm.status) };
  }

  const data = llm.data;
  const text = ((data.content || []).map((b) => b.text || '').join('')).trim();
  const usage = data.usage || {};
  row.retried = !!llm.retried;
  row.stop_reason = data.stop_reason || null;
  row.truncated = row.stop_reason === 'max_tokens';
  row.response_chars = text.length;
  row.tokens = {
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    reasoning: Number(usage.reasoning_tokens) || 0,
    cache_read: Number(usage.cache_read_input_tokens) || 0,
    cache_write: Number(usage.cache_creation_input_tokens) || 0,
  };
  // COSTO, en orden de preferencia:
  //   1. lo que el proveedor COBRÓ (anthropic: precio de la casa; openrouter:
  //      usage.cost, el cobro real);
  //   2. tokens × precio del catálogo VIVO de OpenRouter — estimación marcada;
  //   3. null, con la nota de por qué. Nunca un número inventado.
  if (agent.provider === 'anthropic') {
    row.cost_usd = anthropicCostUsd(agent.model, usage);
    row.cost_source = row.cost_usd != null ? 'anthropic_price_table' : null;
  } else if (llm.cost_usd != null) {
    row.cost_usd = llm.cost_usd;
    row.cost_source = 'openrouter_reported';
  } else {
    row.cost_usd = openRouterCostUsd(row.tokens, pricing);
    row.cost_source = row.cost_usd != null ? 'catalog_estimate' : null;
    if (row.cost_usd != null) {
      row.cost_estimated = true;
      row.pricing_per_mtok = pricing;
      row.cost_note = 'OpenRouter no reportó usage.cost: estimado con tokens × el precio del catálogo vivo. No contempla descuentos ni el precio distinto de los tokens cacheados.';
    }
  }
  if (row.cost_usd == null) row.cost_note = 'el proveedor no reportó costo y el catálogo no trae precio para este slug — no se inventa';

  // ¿LA CACHÉ ESTÁ VIVA? Se responde con el número del proveedor, no con una
  // suposición: cache_creation>0 significa que el bloque se escribió (o sea,
  // superó el mínimo cacheable del modelo); cache_read>0, que se reusó.
  if (agent.provider === 'anthropic') {
    const w = row.tokens.cache_write, r2 = row.tokens.cache_read;
    const pre = row.cache_prefix || {};
    row.cache = {
      write: w, read: r2,
      prefix_tokens_est: pre.tokens_est ?? null,
      min_tokens: ANTHROPIC_CACHE_MIN_TOKENS,
      status: w > 0 || r2 > 0 ? (r2 > 0 ? 'hit' : 'written') : 'no_cache',
    };
    // EL DIAGNÓSTICO, no la observación. `cache_read: 0` tiene tres causas muy
    // distintas y antes las tres salían con la misma nota: (a) el prefijo no
    // llega al piso y el marcador se ignora; (b) llega, se escribió, y este
    // agente fue el PRIMERO (por eso lee 0 — lo normal en la primera llamada);
    // (c) llega pero ni escribió ni leyó, que sí es un problema.
    if (w > 0 && r2 === 0) {
      row.cache.note = `Caché ESCRITA (${w} tokens). Leer 0 es lo esperado en la primera llamada del prefijo: el ahorro aparece en la SIGUIENTE — los otros agentes de la corrida, o la corrida siguiente dentro del TTL.`;
    } else if (r2 > 0) {
      row.cache.note = `Caché VIVA: ${r2} tokens leídos a precio de caché en vez de precio de entrada.`;
    } else if (pre.status === 'below_min') {
      row.cache.note = pre.note;
      row.cache.fix = 'Mové contexto ESTABLE al system (el reglamento y el contexto compartido de la corrida ya están ahí) o bajá ARENA_CACHE_MIN_TOKENS si el proveedor cambió el piso.';
    } else {
      row.cache.note = `El prefijo (~${pre.tokens_est} tokens) SÍ pasa el piso de ${ANTHROPIC_CACHE_MIN_TOKENS}, pero el proveedor no reportó ni escritura ni lectura. Eso ya no es el mínimo cacheable: revisá que \`cache_control\` esté viajando en el payload.`;
    }
  }

  // ¿RESPETÓ EL FORMATO? Se usa el MISMO parser que la corrida real: un smoke
  // que valida el JSON con otro criterio que el harness no prueba el harness.
  const parsed = phase === 'dive' ? parsePlanResponse(text) : parseScanResponse(text);
  row.json_ok = !parsed.error;
  if (parsed.error) {
    row.json_error = parsed.error;
    row.response_head = text.slice(0, 400);
    row.response_tail = text.slice(-200);
  } else if (phase === 'dive') {
    row.actions = (parsed.actions || []).length;
    row.tickers = (parsed.actions || []).map((a) => a.symbol);
  } else {
    row.tickers = parsed.candidates || [];
    row.thesis_chars = (parsed.thesis || '').length;
  }
  row.ok = row.json_ok && !row.truncated;
  if (!row.ok && row.truncated) row.failure = 'truncated_at_max_tokens';
  else if (!row.ok) row.failure = 'malformed_json';
  return row;
}

// ── COSTO PROYECTADO POR CORRIDA Y POR DÍA ───────────────────────────
// El smoke mide UNA llamada por agente. Una CORRIDA del PM son DOS (scan +
// dive) más el titular, y un DÍA son varias corridas por agente. Sin esta
// proyección, el `total_cost_usd` del smoke se lee como si fuera el costo de
// operar — y es ~1/6 de eso.
//
// TODO ACÁ ES UNA ESTIMACIÓN Y SE MARCA COMO TAL. Las suposiciones van
// explícitas en la respuesta (`assumptions`) en vez de escondidas en el
// número, porque son justo lo que hay que discutir cuando la cifra sorprenda:
//
//   · fases por corrida: 2 (scan + dive). El titular es una llamada corta
//     aparte y se cuenta como media fase.
//   · el DIVE cuesta más que el SCAN: más entrada (los datos de Finnhub) y más
//     salida (el JSON completo con positions_review y commitments). Se modela
//     con un multiplicador declarado, no con un número tapado.
//   · la CACHÉ no se descuenta. Es el sesgo CONSERVADOR a propósito: proyectar
//     el ahorro de una caché que todavía no se vio funcionar sería proyectar un
//     deseo. Cuando el smoke reporte `cache.status: 'hit'`, esto se puede
//     afinar y el número REAL va a estar por debajo.
const FASES_POR_CORRIDA = 2.5;        // scan + dive + el titular (corto)
const DIVE_VS_SCAN = 1.8;             // el dive mueve más entrada y más salida

export function projectRunCost(probes, { fixedRounds = 3, worstCaseRuns = 12 } = {}) {
  // `p.cost_usd != null` PRIMERO: Number(null) es 0, y 0 es finito — sin esa
  // guarda un agente sin precio entraba a la suma como si costara cero, y la
  // proyección salía más barata justo por los agentes que no sabemos cuánto
  // cuestan. Es el error que hay que evitar en un número que sirve para decidir
  // un presupuesto.
  const conCosto = probes.filter((p) => p.cost_usd != null && Number.isFinite(Number(p.cost_usd)));
  if (!conCosto.length) return null;
  const porAgente = conCosto.map((p) => {
    const unaLlamada = Number(p.cost_usd);
    // La llamada medida es la del SCAN (o la del DIVE si se corrió ?phase=dive).
    const scan = p.phase === 'dive' ? unaLlamada / DIVE_VS_SCAN : unaLlamada;
    const porCorrida = scan * (1 + DIVE_VS_SCAN) + scan * 0.5;
    return {
      agent: p.agent, name: p.name, provider: p.provider,
      medido_una_llamada_usd: +unaLlamada.toFixed(6),
      cost_source: p.cost_source || null,
      estimado: !!p.cost_estimated,
      pricing_per_mtok: p.pricing_per_mtok || null,
      por_corrida_usd: +porCorrida.toFixed(4),
      rondas_fijas_dia_usd: +(porCorrida * fixedRounds).toFixed(4),
      peor_caso_dia_usd: +(porCorrida * worstCaseRuns).toFixed(4),
    };
  });
  const suma = (k) => +porAgente.reduce((a, b) => a + b[k], 0).toFixed(4);
  const sinCosto = probes.filter((p) => p.cost_usd == null || !Number.isFinite(Number(p.cost_usd))).map((p) => p.agent);
  return {
    estimado: true,
    nota: 'ESTIMACIÓN, no una factura. Sale de escalar la única llamada que el smoke midió por agente. No descuenta caché (sesgo conservador deliberado) y no contempla descuentos ni mínimos por request.',
    assumptions: {
      fases_por_corrida: FASES_POR_CORRIDA,
      dive_vs_scan: DIVE_VS_SCAN,
      rondas_fijas_por_dia: fixedRounds,
      peor_caso_corridas_por_dia: worstCaseRuns,
      cache: 'no descontada',
    },
    por_agente: porAgente,
    liga: {
      agentes_con_costo: porAgente.length,
      agentes_sin_costo: sinCosto,
      por_corrida_usd: suma('por_corrida_usd'),
      rondas_fijas_dia_usd: suma('rondas_fijas_dia_usd'),
      peor_caso_dia_usd: suma('peor_caso_dia_usd'),
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const auth = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const only = String(q.agent || '').toLowerCase();
  const phase = String(q.phase || 'scan').toLowerCase() === 'dive' ? 'dive' : 'scan';
  const catalogOnly = String(q.catalog || '') === '1';
  const agents = only ? [agentById(only)].filter(Boolean) : activeAgents();

  if (!agents.length) return res.status(400).json({ error: 'Ningún agente activo con ese id.' });

  const out = {
    ran_at: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    settings: { max_tokens: ARENA_MAX_TOKENS, effort: ARENA_EFFORT, temperature_default: ARENA_TEMPERATURE },
    // ── LOS RELOJES EFECTIVOS, CON SU ORIGEN ──────────────────────────
    // Estaban repartidos entre cuatro archivos y una env var, y la única forma
    // de conocerlos era esperar a que un agente abortara. Un techo puesto en
    // una env var de prueba no se ve en ningún lado hasta que corta una ronda
    // VIVA — y ahí ya costó un agente.
    relojes: relojesEfectivos(),
    portfolio: 'stand_in',
    portfolio_note: 'PORTAFOLIO FICTICIO: $100k en efectivo, cero posiciones. El smoke no lee las cuentas de Alpaca. El prompt es el real en todo menos ese bloque.',
    writes: 'none',
    catalog: {},
    slugs: [],
    probes: [],
    verdict: null,
  };

  // ── PASO 1 ──
  const needOR = agents.some((a) => a.provider === 'openrouter');
  const needAnth = agents.some((a) => a.provider === 'anthropic');
  const [orCat, anthCat] = await Promise.all([
    needOR ? fetchOpenRouterCatalog() : Promise.resolve({ ok: true, ids: [], models: [] }),
    needAnth ? fetchAnthropicCatalog(process.env.ANTHROPIC_API_KEY) : Promise.resolve({ ok: true, ids: [], models: [] }),
  ]);
  out.catalog.openrouter = { ok: orCat.ok, error: orCat.error || null, model_count: orCat.ids.length };
  out.catalog.anthropic = { ok: anthCat.ok, error: anthCat.error || null, model_count: anthCat.ids.length };
  out.slugs = agents.map((a) => resolveSlug(a, a.provider === 'anthropic' ? anthCat : orCat));

  // Precio del catálogo de OpenRouter, para los que resolvieron exacto.
  for (const s of out.slugs) {
    if (s.provider !== 'openrouter' || s.resolution !== 'exact') continue;
    const m = orCat.models.find((x) => x.id === s.slug);
    if (m && m.pricing) {
      s.pricing_per_mtok = {
        input: +(Number(m.pricing.prompt) * 1e6).toFixed(3),
        output: +(Number(m.pricing.completion) * 1e6).toFixed(3),
      };
      s.context_length = m.context_length || null;
    }
  }

  const exact = out.slugs.filter((s) => s.resolution === 'exact').map((s) => s.agent);
  const blocked = out.slugs.filter((s) => s.resolution !== 'exact');

  // ── ?buscar=<texto> — EL CATÁLOGO DE UNA FAMILIA ────────────────────
  // Nace del callejón de qwen: `qwen3.8-max` tiene UN solo proveedor (Alibaba),
  // así que no hay routing que lo salve — para elegir reemplazo hace falta ver
  // la familia entera, no el slug que ya está configurado.
  //
  // Se busca en el ID y en el nombre: "qwen" matchea `qwen/…` y también un
  // modelo de otro vendor que lo mencione, que es información y no ruido.
  const buscar = String(q.buscar || '').trim().toLowerCase();
  if (buscar) {
    const hits = (orCat.models || []).filter((m) => {
      const id = String(m.id || '').toLowerCase();
      const nom = String(m.name || '').toLowerCase();
      return id.includes(buscar) || nom.includes(buscar);
    });

    // Los endpoints cuestan UNA llamada por modelo. Se piden solo para los
    // primeros `ENDPOINTS_MAX` ordenados por relevancia — traer 40 sería
    // castigar la búsqueda amplia con un minuto de espera.
    const ENDPOINTS_MAX = 14;
    const porRelevancia = [...hits].sort((a, b) => {
      // Primero los del vendor exacto (`qwen/…`), después el resto; dentro de
      // cada grupo, los "max"/flagship arriba: son los candidatos reales.
      const va = String(a.id || '').toLowerCase().startsWith(buscar + '/') ? 0 : 1;
      const vb = String(b.id || '').toLowerCase().startsWith(buscar + '/') ? 0 : 1;
      if (va !== vb) return va - vb;
      const ma = /max|flagship|plus|large/.test(String(a.id || '').toLowerCase()) ? 0 : 1;
      const mb = /max|flagship|plus|large/.test(String(b.id || '').toLowerCase()) ? 0 : 1;
      if (ma !== mb) return ma - mb;
      return String(a.id).localeCompare(String(b.id));
    });

    const conEndpoints = porRelevancia.slice(0, ENDPOINTS_MAX);
    const eps = await Promise.all(conEndpoints.map((m) => fetchEndpoints(m.id)));

    out.busqueda = {
      texto: buscar,
      encontrados: hits.length,
      con_proveedores: conEndpoints.length,
      tope_endpoints: ENDPOINTS_MAX,
      ...(hits.length > ENDPOINTS_MAX
        ? { nota: `Se consultaron los proveedores de los ${ENDPOINTS_MAX} más relevantes de ${hits.length}. Afiná la búsqueda para ver los demás.` }
        : {}),
      // Las claves crudas del primer resultado. Va porque la forma de esta
      // respuesta NO se pudo verificar al escribirla (el sandbox no alcanza
      // openrouter.ai): si algún campo sale null, acá se ve si es que no vino o
      // que se está leyendo con otro nombre.
      campos_crudos_de_ejemplo: hits[0] ? Object.keys(hits[0]) : [],
    };

    out.modelos = porRelevancia.map((m, i) => {
      const ep = i < conEndpoints.length ? eps[i] : null;
      const proveedores = ep && ep.ok ? ep.proveedores.map((x) => x.nombre).filter(Boolean) : null;
      const n = ep && ep.ok ? ep.endpoint_count : null;
      return {
        slug: m.id,
        nombre: m.name || null,
        contexto: m.context_length ?? null,
        max_salida: (m.top_provider && (m.top_provider.max_completion_tokens ?? m.top_provider.max_output_tokens)) ?? null,
        precio_in_musd: precioPorMillon(m.pricing && m.pricing.prompt),
        precio_out_musd: precioPorMillon(m.pricing && m.pricing.completion),
        endpoint_count: n,
        proveedores,
        // LA COLUMNA QUE DECIDE. Un modelo con un solo proveedor no tiene ruta
        // alternativa: si ese proveedor se cuelga, el modelo se cuelga, y
        // `ARENA_PROVIDER_IGNORE_*` devuelve "All providers have been ignored".
        ruta_alternativa: n == null ? null : n > 1,
        ...(ep && !ep.ok ? { endpoints_error: ep.error, ...(ep.campos_vistos ? { campos_vistos: ep.campos_vistos } : {}) } : {}),
        ...(i >= conEndpoints.length ? { proveedores_no_consultados: true } : {}),
      };
    });

    // La regla que pidió Lety, aplicada a los datos en vez de a mi memoria: un
    // "max" servido por más de un proveedor es el candidato.
    const candidatos = out.modelos.filter((m) => /max/.test(m.slug.toLowerCase()) && m.ruta_alternativa === true);
    const actual = out.modelos.find((m) => out.slugs.some((s2) => s2.slug === m.slug)) || null;
    out.busqueda.candidatos = candidatos.map((m) => ({
      slug: m.slug, proveedores: m.proveedores, endpoint_count: m.endpoint_count,
      precio_in_musd: m.precio_in_musd, precio_out_musd: m.precio_out_musd,
      env: `ARENA_MODEL_${(only || 'AGENTE').toUpperCase()}=${m.slug}`,
    }));
    out.busqueda.actual = actual
      ? { slug: actual.slug, endpoint_count: actual.endpoint_count, proveedores: actual.proveedores, ruta_alternativa: actual.ruta_alternativa }
      : null;
    out.busqueda.lectura = candidatos.length
      ? `${candidatos.length} modelo(s) "max" con MÁS DE UN proveedor: ésos tienen ruta alternativa si uno se cuelga. Copiá el \`env\` del elegido en Vercel — se toma sin deploy, y el candado de slug lo acepta porque es un override explícito.`
      : `NINGÚN "max" de esta familia tiene más de un proveedor. Si el actual también tiene endpoint_count 1, el routing no puede ayudar: la elección es entre otro tamaño de la misma casa (y declarar el cambio de tier) o correr sin ese agente.`;

    out.verdict = `CATÁLOGO: ${hits.length} modelo(s) con "${buscar}". Mirá \`busqueda.candidatos\` y la columna \`ruta_alternativa\`.`;
    return res.status(200).json(out);
  }

  if (catalogOnly) {
    out.verdict = blocked.length
      ? `PASO 1: ${exact.length}/${out.slugs.length} slugs resueltos. ${blocked.length} bloqueados — poné las env vars de abajo y volvé a correr.`
      : `PASO 1 VERDE: los ${exact.length} slugs existen en el catálogo. Corré sin ?catalog=1 para el paso 2.`;
    return res.status(200).json(out);
  }

  // ── PASO 2 ──
  const baseUrl = resolveBaseUrl(req);
  let buffet;
  try {
    buffet = await gatherContext({ baseUrl });
  } catch (e) {
    return res.status(200).json({ ...out, verdict: 'No se pudo armar el buffet real: ' + String((e && e.message) || e) + '. Sin buffet no hay prompt real que probar.', buffet_error: String((e && e.message) || e) });
  }
  out.buffet = {
    unavailable: buffet.unavailable, fetch_errors: buffet.fetch_errors,
    screener_state: buffet.screener_state, tickers: Object.keys(buffet.channelsByTicker || {}).length,
  };
  const prompts = buildPrompts(phase, buffet);
  out.prompt_chars = { system: prompts.system.length, user: prompts.user.length };

  const probeable = agents.filter((a) => exact.includes(a.id) || modelSlugResolved(a));
  out.probe_timeout_ms = PROBE_TIMEOUT_MS;

  // ── ?stream=1 — cada agente sale APENAS TERMINA, no al final ───────
  // NDJSON: una línea JSON por evento. Se prende acá abajo y no antes a
  // propósito: arriba todavía hay returns tempranos (?catalog=1, buffet roto)
  // que responden un JSON entero, y no se puede empezar a escribir el cuerpo
  // antes de saber si vamos por ese camino.
  //
  // Por qué opt-in y no el default: el runbook (y el dedo de cualquiera) hace
  // `| jq '{verdict, probes}'`, y jq no come NDJSON sin -s. Romper eso para
  // todos, por una corrida de debug, no vale.
  //
  // Lo que compra de verdad: si la función igual se pasa del reloj, las filas
  // ya escritas LLEGARON. Con el JSON al final, un timeout se lleva todo.
  // Lo que NO compra: con los siete en paralelo terminan casi juntos, así que
  // esto es una red de seguridad, no un chorro de progreso.
  const streaming = String(q.stream || '') === '1';
  let emit = () => {};
  if (streaming) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.status(200);
    const linea = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* cliente colgó */ } };
    linea({ type: 'start', ran_at: out.ran_at, phase, probe_timeout_ms: PROBE_TIMEOUT_MS,
            agents: probeable.map((a) => a.id), slugs: out.slugs, buffet: out.buffet });
    emit = (row) => linea({ type: 'probe', ...row });
  }

  // EN PARALELO, con allSettled. Antes era secuencial "para no rozar el rate
  // limit de OpenRouter y no ensuciar la latencia", y el precio de esa prolijidad
  // era que 7 llamadas de ~60s no cabían en NINGÚN maxDuration: la corrida moría
  // entera y no quedaba ni una fila. Un 429 se lee perfecto en su propia fila
  // (`failure: "http_429"`); una función muerta no se lee en ninguna parte.
  //
  // allSettled y no all: acá NADA debería rechazar (probeAgent atrapa todo),
  // pero si algo se escapa, el reporte pierde un agente en vez de los siete.
  // Precio del catálogo por slug — ya se bajó en el PASO 1, no se vuelve a pedir.
  const precios = {};
  for (const sl of out.slugs) if (sl.pricing_per_mtok) precios[sl.agent] = sl.pricing_per_mtok;

  const settled = await Promise.allSettled(
    probeable.map((a) => probeAgent(a, phase, prompts, PROBE_TIMEOUT_MS, precios[a.id] || null)
      .then((row) => { emit(row); return row; })),
  );
  out.probes = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : {
    agent: probeable[i].id, name: probeable[i].name, ok: false, failure: 'threw',
    detail: String((r.reason && r.reason.message) || r.reason),
  }));

  const green = out.probes.filter((p) => p.ok);
  const red = out.probes.filter((p) => !p.ok);
  out.total_cost_usd = out.probes.reduce((s, p) => s + (Number(p.cost_usd) || 0), 0);
  const estimados = out.probes.filter((p) => p.cost_estimated).map((p) => p.agent);
  out.cost_note = estimados.length
    ? `${estimados.length} de ${out.probes.length} son ESTIMADOS con el precio del catálogo (${estimados.join(', ')}): OpenRouter no reportó usage.cost. El resto es el cobro real.`
    : 'todos los costos son los que el proveedor reportó, ninguno estimado';
  out.sin_costo = out.probes.filter((p) => p.cost_usd == null).map((p) => p.agent);
  // El costo de OPERAR, no el de este smoke. Marcado estimado, con las
  // suposiciones a la vista y los precios del catálogo que las alimentan.
  out.costo_proyectado = projectRunCost(out.probes);
  if (out.costo_proyectado) {
    const l = out.costo_proyectado.liga;
    out.costo_proyectado.lectura = `Estimado: ~$${l.por_corrida_usd} por corrida de la liga completa, ~$${l.rondas_fijas_dia_usd}/día con 3 rondas fijas, ~$${l.peor_caso_dia_usd}/día en el peor caso de 12 corridas.` +
      (l.agentes_sin_costo.length ? ` Sin precio: ${l.agentes_sin_costo.join(', ')} — el total real es MAYOR que esto.` : '');
  }
  out.verdict = red.length === 0 && blocked.length === 0
    ? `VERDE: los ${green.length} agentes respondieron JSON válido sin truncarse. Costo de ESTE smoke: $${out.total_cost_usd.toFixed(4)}` +
      (out.costo_proyectado ? `; costo ESTIMADO de operar: ~$${out.costo_proyectado.liga.rondas_fijas_dia_usd}/día con 3 rondas fijas` : '') +
      '. La nocturna puede correr con modelos nuevos.'
    : `ROJO: ${green.length}/${out.probes.length} en verde` +
      (blocked.length ? `, ${blocked.length} sin slug resuelto` : '') +
      `. Revisá \`slugs\` y \`probes[].failure\` antes de dejar correr el cron.`;

  if (streaming) {
    res.write(JSON.stringify({ type: 'summary', ...out }) + '\n');
    return res.end();
  }
  return res.status(200).json(out);
}
