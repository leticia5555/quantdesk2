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

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  gatherContext, buildScanSystemPrompt, buildScanUserPrompt,
  buildDiveSystemPrompt, buildDiveUserPrompt, resolveBaseUrl, PROMPT_VERSION,
} from './arena-run.js';
import { parseScanResponse, parsePlanResponse } from './_lib/arena-guard.js';
import {
  callArenaLLM, providerKey, buildAnthropicPayload, buildOpenRouterBody, anthropicCostUsd,
} from './_lib/arena-model.js';
import {
  activeAgents, agentById, ARENA_MAX_TOKENS, ARENA_EFFORT, ARENA_TEMPERATURE, modelSlugResolved,
} from './_lib/arena-registry.js';

// ── LA COMPUERTA: cómo se lee ARENA_ADMIN_KEY ────────────────────────
// Tres formas, TODAS equivalentes y TODAS se prueban (la primera que coincide
// gana; que una venga mal no invalida a las otras — el bug viejo era ese: un
// `Authorization` presente pisaba el `?key=` y nunca se leía):
//
//   Authorization: Bearer <key>   ·   x-admin-key: <key>   ·   ?key=<key>
//
// `.trim()` en LOS DOS LADOS. El caso que más duele es el valor pegado en
// Vercel con un `\n` o un espacio al final: son bytes distintos y el 401 sale
// idéntico al de una key equivocada. Acá el trim lo perdona, y si igual no
// coincide el cuerpo del 401 dice qué llegó y por dónde — nunca la key.
const ADMIN_HEADERS = ['x-admin-key'];
const ADMIN_QUERY = ['key', 'admin_key'];

function firstString(v) {
  if (Array.isArray(v)) return v.length ? String(v[v.length - 1]) : '';
  return v == null ? '' : String(v);
}

// Node baja los nombres de header a minúsculas, pero un test o un runtime
// distinto puede no hacerlo: se busca sin distinguir mayúsculas.
function header(req, name) {
  const h = (req && req.headers) || {};
  if (h[name] != null) return firstString(h[name]);
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name);
  return hit ? firstString(h[hit]) : '';
}

// Cada candidato con SU PROCEDENCIA, para poder decir en el 401 por dónde llegó.
export function adminKeyCandidates(req) {
  const out = [];
  const auth = header(req, 'authorization').trim();
  if (auth) {
    const m = /^Bearer\s+([\s\S]*)$/i.exec(auth);
    // Sin el prefijo `Bearer` igual se acepta: mandar la key pelada en
    // Authorization es un error de dedo, no un intento de otra cosa.
    out.push({ source: m ? 'Authorization: Bearer' : 'Authorization (sin Bearer)', value: (m ? m[1] : auth).trim() });
  }
  for (const name of ADMIN_HEADERS) {
    const v = header(req, name).trim();
    if (v) out.push({ source: name, value: v });
  }
  const q = (req && req.query) || {};
  for (const name of ADMIN_QUERY) {
    const v = firstString(q[name]).trim();
    if (v) out.push({ source: '?' + name + '=', value: v });
  }
  return out;
}

// Comparación de largo constante. timingSafeEqual explota si los largos no
// coinciden, así que el largo se chequea antes (y el largo no es el secreto).
function sameSecret(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

// Huella de lo RECIBIDO, nunca de lo esperado: publicar el hash de la key a
// cualquiera que pegue un 401 es regalar material para romperla offline.
// Con esto el dueño compara del lado de su terminal y listo.
function fingerprint(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12);
}

// Nombres —NUNCA valores— de headers y query params que tienen pinta de traer
// una credencial y que este endpoint NO lee. Es la pista que resuelve el caso
// real: "la mandaste por `x-api-key`, que acá no se mira".
function keyishNames(obj, prefix, leidos) {
  const skip = new Set(leidos.map((k) => k.toLowerCase()));
  return Object.keys(obj || {})
    .map((k) => k.toLowerCase())
    .filter((k) => /key|token|secret|auth/i.test(k) && !skip.has(k))
    .map((k) => prefix + k)
    .sort();
}

const ACEPTA = [
  'Authorization: Bearer <ARENA_ADMIN_KEY>',
  'x-admin-key: <ARENA_ADMIN_KEY>',
  '?key=<ARENA_ADMIN_KEY>',
];
const EJEMPLO = 'curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-smoke?catalog=1"';

// Devuelve { ok:true } o { ok:false, status, body }. Exportada para que el
// test pruebe LA MISMA función que corre en producción.
export function checkAdminAuth(req, rawEnv) {
  const raw = rawEnv == null ? '' : String(rawEnv);
  const expected = raw.trim();

  // Sin llave configurada el endpoint NO queda abierto: responde 503. Un smoke
  // que gasta en siete proveedores no puede depender de que nadie adivine la
  // URL — y "si no hay llave, dejá pasar" es el default que convierte eso en
  // una factura de otro.
  if (!expected) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'Falta ARENA_ADMIN_KEY: el smoke está deshabilitado hasta que se configure.',
        hint: raw
          ? 'ARENA_ADMIN_KEY existe pero está vacía (solo espacios). Ponele un valor en Vercel → Settings → Environment Variables y REDEPLOYÁ: las env vars entran al deploy, no al proyecto.'
          : 'Poné ARENA_ADMIN_KEY en Vercel → Settings → Environment Variables (marcá Production) y REDEPLOYÁ: una env var agregada después del último deploy no la ve la función.',
        acepta: ACEPTA,
      },
    };
  }

  const cands = adminKeyCandidates(req);
  if (cands.some((c) => sameSecret(c.value, expected))) return { ok: true };

  // ── El 401 con pista. Regla: se dice QUÉ FALTA, nunca la key. ──────
  const recibido = cands.map((c) => ({
    fuente: c.source,
    chars: c.value.length,
    mismo_largo_que_la_env: c.value.length === expected.length,
    huella_sha256_12: fingerprint(c.value),
    parece_entre_comillas: /^(".*"|'.*')$/.test(c.value),
  }));
  const headersPinta = keyishNames((req && req.headers) || {}, '', ['authorization', ...ADMIN_HEADERS]);
  const queryPinta = keyishNames((req && req.query) || {}, '?', ADMIN_QUERY);
  const envConEspacios = raw !== expected;
  const envEntreComillas = /^(".*"|'.*')$/.test(expected);

  let hint;
  if (!cands.length) {
    hint = 'No llegó NINGUNA key: ni `Authorization: Bearer`, ni el header `x-admin-key`, ni `?key=`.'
      + (headersPinta.length
        ? ` Sí llegaron estos headers con pinta de credencial: ${headersPinta.join(', ')} — ninguno de esos se lee.`
        : '');
  } else {
    const mismoLargo = recibido.find((r) => r.mismo_largo_que_la_env);
    const r = mismoLargo || recibido[0];
    hint = `La key llegó por \`${r.fuente}\` pero no coincide con ARENA_ADMIN_KEY. `
      + (r.mismo_largo_que_la_env
        ? 'Tiene el largo correcto, así que es OTRA key: revisá si se regeneró en Vercel sin redeployar, o si estás pegando la de otro entorno (Preview vs Production).'
        : `Tiene ${r.chars} chars y la de la env tiene otro largo. Los espacios y saltos de línea alrededor YA se ignoran (trim de los dos lados), así que no es eso: o se cortó al copiar, o viajan comillas pegadas al valor.`);
  }
  if (envEntreComillas) {
    hint += ' ⚠️ El valor de ARENA_ADMIN_KEY en el server empieza y termina con comillas: Vercel guarda el valor literal, no lo desescapa. Sacalas y redeployá.';
  }

  return {
    ok: false,
    status: 401,
    body: {
      error: 'No autorizado.',
      hint,
      acepta: ACEPTA,
      recibido: recibido.length ? recibido : null,
      headers_que_no_se_leen: headersPinta.length ? headersPinta : null,
      query_que_no_se_lee: queryPinta.length ? queryPinta : null,
      env: {
        configurada: true,
        tenia_espacios_alrededor: envConEspacios,
        parece_entre_comillas: envEntreComillas,
      },
      como_comparar: 'En esta respuesta NO viaja ninguna key. `huella_sha256_12` es sha256 de lo que llegó: corré `printf %s "$ARENA_ADMIN_KEY" | shasum -a 256 | cut -c1-12` y comparalo. (`printf %s`, no `echo`: echo agrega un \\n y te da otra huella.)',
      ejemplo: EJEMPLO,
    },
  };
}

// El smoke corre 7 modelos × 1 llamada con techo de 6000 tokens, más el buffet.
// Mismo cap que el decide (plan Pro).
export const maxDuration = 300;

const OPENROUTER_CATALOG = 'https://openrouter.ai/api/v1/models';
const ANTHROPIC_CATALOG = 'https://api.anthropic.com/v1/models?limit=1000';

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
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
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

async function probeAgent(agent, phase, prompts) {
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
  const llm = await callArenaLLM({
    agent, system: prompts.system, messages: [{ role: 'user', content: prompts.user }],
    maxTokens: ARENA_MAX_TOKENS,
  });
  row.ms = Date.now() - t0;

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
  row.cost_usd = agent.provider === 'anthropic'
    ? anthropicCostUsd(agent.model, usage)
    : (llm.cost_usd != null ? llm.cost_usd : null);
  if (row.cost_usd == null) row.cost_note = 'el proveedor no reportó costo y no hay precio verificado en la casa — no se inventa';

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
  out.probes = [];
  for (const a of probeable) {
    // Secuencial a propósito: 7 llamadas en paralelo con techo de 6000 tokens
    // rozan el rate limit de OpenRouter y hacen ilegible el reporte de latencia.
    out.probes.push(await probeAgent(a, phase, prompts));
  }

  const green = out.probes.filter((p) => p.ok);
  const red = out.probes.filter((p) => !p.ok);
  out.total_cost_usd = out.probes.reduce((s, p) => s + (Number(p.cost_usd) || 0), 0);
  out.verdict = red.length === 0 && blocked.length === 0
    ? `VERDE: los ${green.length} agentes respondieron JSON válido sin truncarse. Costo del smoke: $${out.total_cost_usd.toFixed(4)}. La nocturna puede correr con modelos nuevos.`
    : `ROJO: ${green.length}/${out.probes.length} en verde` +
      (blocked.length ? `, ${blocked.length} sin slug resuelto` : '') +
      `. Revisá \`slugs\` y \`probes[].failure\` antes de dejar correr el cron.`;
  return res.status(200).json(out);
}
