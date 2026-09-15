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
  gatherContext, buildScanSystemPrompt, buildScanUserPrompt,
  buildDiveSystemPrompt, buildDiveUserPrompt, resolveBaseUrl, PROMPT_VERSION,
} from './arena-run.js';
import { parseScanResponse, parsePlanResponse } from './_lib/arena-guard.js';
import {
  callArenaLLM, providerKey, buildAnthropicPayload, buildOpenRouterBody, anthropicCostUsd, withDeadline,
  openRouterCostUsd,
} from './_lib/arena-model.js';
import {
  activeAgents, agentById, ARENA_MAX_TOKENS, ARENA_EFFORT, ARENA_TEMPERATURE, modelSlugResolved,
} from './_lib/arena-registry.js';

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
// etiqueta humana del modelo. Deliberadamente tonto y explicable (solapamiento
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

function buildPrompts(phase, buffet) {
  if (phase === 'dive') {
    // Slate fijo del buffet (los primeros nombres con canal), sin deep dive:
    // el smoke mide formato y costo, no calidad de research.
    const candidates = Object.keys(buffet.channelsByTicker || {}).slice(0, 3);
    return {
      system: buildDiveSystemPrompt('Claude PM'),
      user: buildDiveUserPrompt({
        ...STAND_IN, previous: null, scanThesis: '(smoke)',
        candidates, deepDive: {}, closes: {}, channels: buffet.channelsByTicker || {},
      }),
    };
  }
  return {
    system: buildScanSystemPrompt(),
    user: buildScanUserPrompt({ ...STAND_IN, buffet, previous: null }),
  };
}

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
    payload_chars: payloadChars(agent, prompts.system, prompts.user),
  };
  if (!providerKey(agent)) {
    return { ...row, ok: false, failure: 'missing_api_key', detail: `Falta la key de ${agent.provider}.` };
  }

  const llm = await withDeadline(
    callArenaLLM({
      agent, system: prompts.system, messages: [{ role: 'user', content: prompts.user }],
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
    row.cache = {
      write: w, read: r2,
      status: w > 0 || r2 > 0 ? (r2 > 0 ? 'hit' : 'written') : 'no_cache',
      note: w > 0 || r2 > 0 ? null
        : 'cache_creation y cache_read en 0: el prefijo cacheable no llegó al mínimo del modelo (Fable 5.1: 512 tokens). El system del SCAN mide ~330 tokens. Ver el runbook.',
    };
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
  out.verdict = red.length === 0 && blocked.length === 0
    ? `VERDE: los ${green.length} agentes respondieron JSON válido sin truncarse. Costo del smoke: $${out.total_cost_usd.toFixed(4)}. La nocturna puede correr con modelos nuevos.`
    : `ROJO: ${green.length}/${out.probes.length} en verde` +
      (blocked.length ? `, ${blocked.length} sin slug resuelto` : '') +
      `. Revisá \`slugs\` y \`probes[].failure\` antes de dejar correr el cron.`;

  if (streaming) {
    res.write(JSON.stringify({ type: 'summary', ...out }) + '\n');
    return res.end();
  }
  return res.status(200).json(out);
}
