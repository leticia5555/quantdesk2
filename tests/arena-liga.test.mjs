// ═══════════════════════════════════════════════════════════════
// LIGA multi-modelo del Arena: registry + dispatch de proveedor + orquestador
// multi-agente de punta a punta, con TODO el I/O mockeado a nivel fetch.
//
// Cubre las rutas que la Fase A debe ejercitar:
//   - Anthropic DIRECTO (claude, control) vs OpenRouter (openai) — mismo
//     harness, forma normalizada idéntica.
//   - TEMPERATURA fija 0.7 en ambos proveedores.
//   - MULTI-CUENTA: cada agente manda sus órdenes a SU cuenta Alpaca (creds
//     distintas por header APCA-API-KEY-ID).
//   - IDENTIDAD de prompt: persona por agente; el CONTROL comparte persona
//     byte-idéntica con claude (piso de ruido válido).
//   - agent_id: cada fila del journal lleva su agente.
//   - Trabajo compartido por corrida: el buffet y el deep-dive de un símbolo se
//     piden UNA vez para toda la liga (dedupe), no una por agente.
// Correr con `node tests/arena-liga.test.mjs`.
// ═══════════════════════════════════════════════════════════════

// Keys de proveedor + de las 3 cuentas Alpaca de la Fase A + infra.
process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.OPENROUTER_API_KEY = 'sk-or-test';
process.env.ALPACA_PAPER_KEY = 'PK_CLAUDE'; process.env.ALPACA_PAPER_SECRET = 'S_CLAUDE';
process.env.ALPACA_OPENAI_KEY = 'PK_OPENAI'; process.env.ALPACA_OPENAI_SECRET = 'S_OPENAI';
process.env.ALPACA_CONTROL_KEY = 'PK_CONTROL'; process.env.ALPACA_CONTROL_SECRET = 'S_CONTROL';
// Temporada 2: las 4 cuentas que se suman (Grok/Gemini/DeepSeek/Qwen).
process.env.ALPACA_GROK_KEY = 'PK_GROK'; process.env.ALPACA_GROK_SECRET = 'S_GROK';
process.env.ALPACA_GEMINI_KEY = 'PK_GEMINI'; process.env.ALPACA_GEMINI_SECRET = 'S_GEMINI';
process.env.ALPACA_DEEPSEEK_KEY = 'PK_DEEPSEEK'; process.env.ALPACA_DEEPSEEK_SECRET = 'S_DEEPSEEK';
process.env.ALPACA_QWEN_KEY = 'PK_QWEN'; process.env.ALPACA_QWEN_SECRET = 'S_QWEN';
process.env.FINNHUB_API_KEY = 'fh-test';
// Esta suite prueba la MECÁNICA de la corrida nocturna (los 7 agentes, multi-
// cuenta, agent_id, dedupe), no el corte de cadencia — y corre contra el RELOJ
// REAL. Desde el corte, el gate la apagaría entera y quedaría verde sin probar
// nada. Se empuja el corte lejos con la env var que existe justo para eso; el
// retiro del cron nocturno lo cubre `arena-morning.test.mjs`, con su propio caso.
process.env.ARENA_WATCH_START = '2099-01-01';
delete process.env.ARENA_LEAGUE;
delete process.env.ARENA_SCREENER_ENABLED;
delete process.env.ARENA_TEMPERATURE;

import { readFileSync } from 'node:fs';
import { runArenaLeague, announceSeasonOpen, SEASON_OPEN_ID } from '../api/arena-run.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_TEMPERATURE, ARENA_AGENTS, ARENA_SEASON } from '../api/_lib/arena-registry.js';
import { ANTHROPIC_MODEL, ARENA_ANTHROPIC_MODEL } from '../api/_lib/model.js';
import { callArenaLLM, providerKey, effectiveParams, sameParams } from '../api/_lib/arena-model.js';
import { buildDiveSystemPrompt } from '../api/arena-run.js';

// Los slugs de OpenRouter de la temporada nueva no están verificados contra el
// catálogo (ver el candado en _lib/arena-registry.js). En los tests el catálogo
// no existe, así que se levanta el candado explícitamente.
process.env.ARENA_ALLOW_UNVERIFIED_SLUGS = '1';

// El system de Anthropic viaja como ARRAY de bloques cuando la caché de prompt
// está encendida (_lib/arena-model.js parte reglamento|fecha para que el
// recordatorio de fecha, que cambia a diario, quede FUERA del prefijo
// cacheado). Los mocks tienen que leer las dos formas o ramifican mal de fase.
function sysText(body) {
  const s = body && body.system;
  if (Array.isArray(s)) return s.map((b) => (b && b.text) || '').join('');
  return String(s || '');
}


let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const BASE_URL = 'http://qd.test';
const today = new Date().toISOString().slice(0, 10);
const DAY = 86400000;
const t0 = Date.UTC(2026, 4, 1);
const closes = Array.from({ length: 30 }, (_, i) => 195 + (i % 6));
closes[closes.length - 1] = 200;
const timestamps = closes.map((_, i) => (t0 + i * DAY) / 1000);

// Ambos proveedores deciden lo MISMO (comprar AAPL @200) para poder comparar el
// harness y probar el dedupe de deep-dive (todos piden AAPL → 1 fetch).
const SCAN = JSON.stringify({ scan_thesis: 'AAPL en actives; el resto es ruido.', candidates: ['AAPL'] });
const DIVE = JSON.stringify({ plan: 'Entro a AAPL de calidad.', actions: [{ symbol: 'AAPL', side: 'buy', notional: 5000, limit_price: 200, conviction: 4, reasoning: 'Fundamentales sólidos.' }] });
// TITULAR: tercera llamada por agente, con el prompt de la VOZ (arquetipo). El
// mock la distingue por el marcador "TU VOZ:", que solo lleva ese prompt.
const TITULAR = 'Compro AAPL y me aguanto: la tesis no cambió con el ruido de hoy.';
const fase = (system) => (String(system).includes('TU VOZ:') ? 'headline' : (String(system).includes('SCOUT') ? 'scan' : 'dive'));
const respuesta = (phase) => (phase === 'scan' ? SCAN : phase === 'dive' ? DIVE : TITULAR);

// Telemetría del mock.
const anthropicCalls = [];   // { model, temperature, phase }
const openrouterCalls = [];  // { model, temperature, phase }
const orderPosts = [];       // { account, symbol, side }
const journalInserts = [];   // params de cada insert into arena_journal
let moversFetches = 0;
const seasonRows = [];       // ids de anuncio ya insertados (idempotencia del `on conflict`)
const aaplMetricFetches = [];
// Calendario de Alpaca: por default trae una sesión hoy (mercado ABIERTO) para
// que las corridas normales operen. La sección de "mercado cerrado" lo vacía.
let calendarSessions = [{ date: '2026-08-03', open: '09:30', close: '16:00' }];

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const jsonReply = (obj, status = 200) => ({
    ok: status < 300, status,
    headers: { get: () => 'application/json' },
    json: async () => obj, text: async () => JSON.stringify(obj),
  });

  // Anthropic (claude, control) — branch por fase según el system.
  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body || '{}');
    const system = sysText(body);
    const phase = fase(system);
    anthropicCalls.push({ model: body.model, temperature: body.temperature, phase, system });
    return jsonReply({ content: [{ type: 'text', text: respuesta(phase) }], usage: { input_tokens: 10, output_tokens: 20 } });
  }
  // OpenRouter (openai) — forma OpenAI; el system es messages[0].
  if (u.includes('openrouter.ai')) {
    const body = JSON.parse(opts.body || '{}');
    const sys = String((body.messages && body.messages[0] && body.messages[0].content) || '');
    const phase = fase(sys);
    openrouterCalls.push({ model: body.model, temperature: body.temperature, phase, system: sys });
    return jsonReply({ choices: [{ message: { content: respuesta(phase) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
  }
  // Alpaca — la cuenta se identifica por el header APCA-API-KEY-ID.
  if (u.includes('paper-api.alpaca.markets')) {
    const account = (opts.headers && opts.headers['APCA-API-KEY-ID']) || '?';
    if (u.includes('/v2/calendar')) return jsonReply(calendarSessions);
    if (u.endsWith('/v2/account')) return jsonReply({ status: 'ACTIVE', equity: '100000', cash: '100000', last_equity: '100000' });
    if (u.endsWith('/v2/positions')) return jsonReply([]);
    if (u.includes('/v2/orders?')) return jsonReply([]);
    if (u.endsWith('/v2/orders') && method === 'POST') {
      const body = JSON.parse(opts.body);
      orderPosts.push({ account, symbol: body.symbol, side: body.side, limit_price: body.limit_price });
      return jsonReply({ id: 'ord-' + orderPosts.length, status: 'accepted', ...body });
    }
    return jsonReply({ message: 'ruta alpaca inesperada' }, 404);
  }
  // Finnhub symbol map (guard)
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return jsonReply([{ symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' }]);
  }
  // Finnhub deep dive — cuenta cuántas veces se pide AAPL/metric (dedupe).
  if (u.includes('finnhub.io/api/v1/stock/metric')) { aaplMetricFetches.push(u); return jsonReply({ metric: { peTTM: 30 } }); }
  if (u.includes('finnhub.io/api/v1/stock/profile2')) return jsonReply({ name: 'Apple', marketCapitalization: 3000000 });
  if (u.includes('finnhub.io/api/v1/stock/recommendation')) return jsonReply([{ period: '2026-07-01', strongBuy: 20, buy: 10, hold: 3, sell: 0, strongSell: 0 }]);
  if (u.includes('finnhub.io/api/v1/company-news')) return jsonReply([]);
  // Yahoo
  if (u.includes('yahoo')) return jsonReply({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] } });
  // Buffet self-fetch (compartido: debería pedirse UNA vez para la liga)
  if (u.startsWith(BASE_URL + '/api/movers')) { moversFetches++; return jsonReply({ universe: 'market', gainers: [], losers: [], actives: [{ symbol: 'AAPL', price: 200, changePct: 1.2 }] }); }
  if (u.startsWith(BASE_URL + '/api/earnings')) return jsonReply({ earnings: [] });
  if (u.startsWith(BASE_URL + '/api/stock-tracker')) return jsonReply({ items: [] });
  // Neon
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body);
    const q = body.query || '';
    if (q.includes('arena_screener')) return jsonReply({ fields: [], rows: [] });
    if (q.includes('from arena_state')) return jsonReply({
      fields: [{ name: 'halted', dataTypeID: 16 }, { name: 'halted_at', dataTypeID: 1184 }, { name: 'halted_reason', dataTypeID: 25 }, { name: 'resumed_at', dataTypeID: 1184 }],
      rows: [['f', null, null, null]] });
    // Idempotencia del anuncio de temporada: el SELECT devuelve los agent_id que
    // YA tienen su fila de esta temporada (los que este mock vio insertar).
    if (q.includes("status = 'season_start'") && q.startsWith('select')) {
      return jsonReply({
        fields: [{ name: 'agent_id', dataTypeID: 25 }],
        rows: seasonRows.map((id) => [id]),
      });
    }
    if (q.includes('insert into arena_journal')) {
      journalInserts.push(body.params);
      if (body.params[3] === 'season_start') seasonRows.push(body.params[13]);
      return jsonReply({ fields: [], rows: [] });
    }
    return jsonReply({ fields: [], rows: [] });
  }
  throw new Error('fetch inesperado en el test: ' + u);
};

// ── 1) Registry ──────────────────────────────────────────────────────
console.log('liga: registry (Temporada 2: los 7 activos, slugs, temperatura, creds)');
{
  const ids = activeAgents().map((a) => a.id);
  const SIETE = ['claude', 'openai', 'control', 'grok', 'gemini', 'deepseek', 'qwen'];
  ok(ids.length === 7 && SIETE.every((x) => ids.includes(x)),
    'Temporada 2: la liga COMPLETA activa (los 7)', JSON.stringify(ids));
  const off = ARENA_AGENTS.filter((a) => !a.enabled).map((a) => a.id);
  ok(off.length === 0, 'ya no queda ningún agente apagado en el registry', JSON.stringify(off));
  ok(['grok', 'gemini', 'deepseek', 'qwen'].every((x) => agentById(x).enabled === true),
    'Grok/Gemini/DeepSeek/Qwen encendidos (el flip de la Temporada 2)');
  ok(ARENA_TEMPERATURE === 0.7, 'temperatura fija 0.7 por default', String(ARENA_TEMPERATURE));
  ok(agentById('openai').model_label === 'GPT-6 Astra' && agentById('openai').provider === 'openrouter', 'openai → GPT-6 Astra vía OpenRouter', agentById('openai').model);
  ok(agentById('deepseek').house === 'china' && agentById('qwen').house === 'china', 'DeepSeek/Qwen marcados casa china (ángulo de contenido)');
  ok(agentById('claude').model === agentById('control').model, 'control usa el MISMO modelo que claude (Haiku-B)');
  // Creds por agente, nomenclatura ALPACA_<ALPACA>_*
  ok(agentAlpacaCreds(agentById('claude')).key === 'PK_CLAUDE', 'claude reusa ALPACA_PAPER_* (continuidad del Agente #6)');
  ok(agentAlpacaCreds(agentById('openai')).key === 'PK_OPENAI' && agentAlpacaCreds(agentById('control')).key === 'PK_CONTROL',
    'openai/control leen sus propias ALPACA_<ID>_*');
  ok(['grok', 'gemini', 'deepseek', 'qwen'].every((id) => agentAlpacaCreds(agentById(id)).key === 'PK_' + id.toUpperCase()),
    'los 4 de la Temporada 2 leen sus propias ALPACA_<ID>_* (7 libros distintos)');
  // ARENA_LEAGUE sigue ganando sobre `enabled`; con los 7 en true su uso es RECORTAR
  // la parrilla sin redeploy (y el riesgo operativo es dejarla puesta de la Fase A).
  process.env.ARENA_LEAGUE = 'claude,grok';
  ok(activeAgents().map((a) => a.id).join(',') === 'claude,grok', 'ARENA_LEAGUE recorta la parrilla sin redeploy (gana sobre enabled)');
  delete process.env.ARENA_LEAGUE;
}

// ── 2) Identidad de prompt: control === claude, openai distinto ──
console.log('liga: identidad de prompt (control byte-idéntico a claude)');
{
  const pClaude = buildDiveSystemPrompt(agentById('claude').persona);
  const pControl = buildDiveSystemPrompt(agentById('control').persona);
  const pOpenai = buildDiveSystemPrompt(agentById('openai').persona);
  ok(pClaude === pControl, 'CONTROL: prompt del DIVE byte-idéntico al de claude (piso de ruido válido)');
  ok(pOpenai !== pClaude && pOpenai.includes('GPT PM'), 'openai: persona distinta ("GPT PM") — se ejercita la ruta de identidad');
}

// ── 3) Dispatch normalizado: providerKey + forma OpenRouter → Anthropic ──
console.log('liga: dispatch de proveedor normalizado');
{
  ok(providerKey(agentById('claude')) === 'sk-ant-test' && providerKey(agentById('openai')) === 'sk-or-test',
    'providerKey resuelve la key correcta por casa');
  const out = await callArenaLLM({ agent: agentById('openai'), system: 'You are GPT PM', messages: [{ role: 'user', content: 'ping' }], maxTokens: 100 });
  ok(out.status === 200 && out.data && out.data.content[0].text.length > 0, 'OpenRouter normalizado a {content:[{text}]}', JSON.stringify(out.status));
  // Sin key → missingKey (abort honesto, sin gastar)
  const saved = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  const noKey = await callArenaLLM({ agent: agentById('openai'), system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
  ok(noKey.missingKey === true, 'sin OPENROUTER_API_KEY → missingKey (no llama a la red)');
  process.env.OPENROUTER_API_KEY = saved;
}

// ── 4) Orquestador de la liga de punta a punta ──
console.log('liga: runArenaLeague — los 7 agentes, multi-cuenta, agent_id, dedupe');
anthropicCalls.length = 0; openrouterCalls.length = 0; orderPosts.length = 0;
journalInserts.length = 0; moversFetches = 0; aaplMetricFetches.length = 0;
const res = await runArenaLeague({ baseUrl: BASE_URL });
{
  const SIETE = ['claude', 'openai', 'control', 'grok', 'gemini', 'deepseek', 'qwen'];
  const byId = Object.fromEntries((res.agents || []).map((a) => [a.id, a]));
  ok(res.agents.length === 7 && SIETE.every((id) => byId[id]), 'corren los 7 agentes de la Temporada 2', JSON.stringify(res.league));
  ok(SIETE.every((id) => byId[id].status === 'ok'), 'los 7 deciden ok (1 orden c/u)', JSON.stringify(res.agents.map((a) => [a.id, a.status])));

  // Proveedor correcto por agente: claude+control → Anthropic (directo); los
  // otros CINCO → OpenRouter con la MISMA key y su propio slug.
  // TRES llamadas por agente: SCAN + DIVE (deciden) + TITULAR (solo narra).
  ok(anthropicCalls.length === 6, 'Anthropic recibió 6 llamadas (claude + control, 3 fases c/u)', String(anthropicCalls.length));
  ok(openrouterCalls.length === 15, 'OpenRouter recibió 15 llamadas (5 agentes × 3 fases)', String(openrouterCalls.length));
  // RELANZAMIENTO 2026-09-15: el Arena corre Fable 5.1 y el RESTO de la app se
  // queda en Haiku. Se comprueba contra ARENA_ANTHROPIC_MODEL (no contra un ID
  // escrito acá) y, sobre todo, que NO sea ANTHROPIC_MODEL: el día que alguien
  // los vuelva a unir, la app entera sube 10× de precio sin pedirlo.
  ok(anthropicCalls.every((c) => c.model === ARENA_ANTHROPIC_MODEL),
    'Anthropic siempre con el modelo del Arena (ARENA_ANTHROPIC_MODEL)', JSON.stringify([...new Set(anthropicCalls.map((c) => c.model))]));
  ok(ARENA_ANTHROPIC_MODEL !== ANTHROPIC_MODEL,
    'el modelo del Arena está SEPARADO del de la app — subir la liga no sube sim/earnings/Smart $');
  // Cada agente de OpenRouter va con SU slug — un solo adapter, cinco modelos.
  // Los slugs se leen DEL REGISTRY, no se repiten acá: escribirlos a mano en el
  // test los convertiría en dos fuentes de verdad que se desincronizan en el
  // próximo cambio de modelos. Lo que el test protege es el invariante —
  // un adapter, cinco slugs DISTINTOS, uno por agente.
  const slugsVistos = [...new Set(openrouterCalls.map((c) => c.model))].sort();
  const slugsEsperados = ARENA_AGENTS.filter((a) => a.provider === 'openrouter').map((a) => a.model).sort();
  ok(slugsVistos.join(',') === slugsEsperados.join(',') && slugsVistos.length === 5,
    'OpenRouter recibió los 5 slugs distintos del registry (uno por agente)', JSON.stringify(slugsVistos));

  // TEMPERATURA: la decisión #2 de la liga ("idéntica para todos") se ROMPIÓ el
  // 2026-09-15 y el test lo dice en vez de taparlo. Claude Fable 5.1 rechaza
  // `temperature` con 400: en esa familia el sampling no es configurable, así
  // que los dos agentes de Anthropic corren SIN el parámetro. Lo que sigue
  // siendo obligatorio —y es lo que hace válido al control— es que `claude` y
  // `control` manden parámetros IDÉNTICOS entre ellos.
  ok(anthropicCalls.every((c) => c.temperature === undefined),
    'Anthropic corre SIN temperature (Fable 5.1 la rechaza con 400)', JSON.stringify([...new Set(anthropicCalls.map((c) => c.temperature))]));
  ok(openrouterCalls.every((c) => c.temperature === 0.7),
    'los cinco de OpenRouter sí corren con temperatura 0.7');
  // Identidad de parámetros entre claude y control SIN depender del orden de
  // llegada: la liga corre en paralelo, así que emparejar por índice sería un
  // test flaky. El invariante real es que TODAS las llamadas de Anthropic
  // lleven exactamente los mismos parámetros — si claude y control divergieran,
  // habría más de una combinación.
  const combosAnthropic = [...new Set(anthropicCalls.filter((c) => c.phase !== 'headline')
    .map((c) => JSON.stringify({ model: c.model, temperature: c.temperature ?? null })))];
  ok(combosAnthropic.length === 1,
    'claude y control mandan parámetros idénticos — el piso de ruido sigue siendo válido', JSON.stringify(combosAnthropic));

  // El invariante, afirmado también sobre la fuente (no solo sobre lo que salió
  // por el cable): `sameParams` es lo que el anuncio de reglamento journalea.
  ok(sameParams(agentById('claude'), agentById('control')),
    'sameParams(claude, control) === true — la regla "mismos parámetros por familia; insignia y control idénticos"');
  ok(effectiveParams(agentById('claude')).temperature === null,
    'la familia de Anthropic reporta temperature NULL (el parámetro no viaja), no 0',
    String(effectiveParams(agentById('claude')).temperature));
  ok(effectiveParams(agentById('grok')).temperature === ARENA_TEMPERATURE,
    'la familia de OpenRouter sí reporta su temperatura efectiva');
  // Dentro de cada familia, parámetros idénticos (la regla nueva).
  const porFamilia = {};
  for (const a of ARENA_AGENTS) {
    const p = effectiveParams(a);
    (porFamilia[a.provider] = porFamilia[a.provider] || []).push(
      JSON.stringify({ t: p.temperature, e: p.effort, mt: p.max_tokens, ec: p.effort_channel }));
  }
  ok(Object.values(porFamilia).every((v) => new Set(v).size === 1),
    'mismos parámetros DENTRO de cada familia', JSON.stringify(porFamilia));

  // MULTI-CUENTA: cada agente mandó su orden a SU cuenta.
  const acctBySym = {};
  for (const o of orderPosts) acctBySym[o.account] = (acctBySym[o.account] || 0) + 1;
  ok(orderPosts.length === 7, 'siete órdenes (una por agente)', JSON.stringify(orderPosts.map((o) => o.account)));
  ok(SIETE.every((id) => acctBySym['PK_' + id.toUpperCase()] === 1),
    'cada orden fue a la cuenta Alpaca correcta (7 libros, multi-login por header)', JSON.stringify(acctBySym));

  // agent_id: cada fila del journal lleva su agente (param $14, posición 13).
  // Los SIETE (flip de la Fase B, ya en main) — y el anuncio del reglamento T2
  // usa OTRO insert, con 5 params y `'league'` literal en el SQL, así que se
  // filtra por longitud para contar solo las filas por-agente del pipeline.
  const agentIds = journalInserts.filter((p) => p.length === 14).map((p) => p[13]).sort();
  ok(agentIds.length === 7 && agentIds.join(',') === [...SIETE].sort().join(','),
    'agent_id journaleado por agente (columna $14, no tabla por agente)', JSON.stringify(agentIds));

  // Trabajo COMPARTIDO por corrida: buffet una vez, deep-dive de AAPL una vez.
  ok(moversFetches === 1, 'el buffet (movers) se pidió UNA vez para toda la liga (compartido)', String(moversFetches));
  ok(aaplMetricFetches.length === 1, 'el deep-dive de AAPL se pidió UNA vez (dedupe entre agentes)', String(aaplMetricFetches.length));
}

// ── mercado cerrado (festivo): chequeo GLOBAL, UNA vez antes del loop ──────────
// El calendario de Alpaca no reporta sesión hoy → la liga NO corre el pipeline de
// ningún agente y journalea UNA SOLA fila marcadora global (agent_id='league',
// cero órdenes): "mercado cerrado" es un hecho de la liga entera, no de cada
// agente. Ocurre ANTES del DIVE (sin plan_number_audit en la fila).
console.log('liga: mercado cerrado (calendario vacío) → skip global, UNA fila marcadora de liga');
{
  journalInserts.length = 0;
  const ordersBefore = orderPosts.length;
  const saved = calendarSessions;
  calendarSessions = []; // Alpaca sin sesión hoy → cerrado (festivo / fin de semana)
  const res = await runArenaLeague({ baseUrl: BASE_URL });
  calendarSessions = saved; // restaurar para no filtrar estado

  ok(res.market_closed && res.market_closed.closed === true, 'la liga reporta market_closed', JSON.stringify(res.market_closed));
  ok(res.status === 'skipped_market_closed', 'status de liga = skipped_market_closed', res.status);
  ok(Array.isArray(res.agents) && res.agents.length === 0, 'ningún agente corre (skip global, no por-agente)', JSON.stringify(res.agents));
  ok(orderPosts.length === ordersBefore, 'CERO órdenes enviadas a Alpaca en un día cerrado', String(orderPosts.length - ordersBefore));
  const skipRows = journalInserts.filter((p) => p[3] === 'skipped_market_closed');
  ok(skipRows.length === 1, 'UNA sola fila marcadora global (no una por agente)', String(skipRows.length));
  ok(skipRows[0][13] === 'league', "la fila global lleva agent_id='league' (sentinela, no un agente real)", skipRows[0][13]);
  const ctx0 = JSON.parse(skipRows[0][12]);
  ok(ctx0.market_check && ctx0.market_check.reason && ctx0.market_check.date,
    'la fila journalea context.market_check (reason + fecha ET) para auditar', JSON.stringify(ctx0.market_check));
  ok(!ctx0.plan_number_audit, 'el skip ocurre ANTES del DIVE (sin plan_number_audit en un día cerrado)');
}

// ── APERTURA DE TEMPORADA: UN SOLO mecanismo, automático ─────────────────────
// Antes hubo dos (éste y uno manual, `?action=announce`, con una fila por
// agente). Se consolidó en éste; el manual se retiró. Lo que esta sección
// blinda es justamente que quede UNO.
console.log('liga: apertura de temporada — una fila de LIGA, automática e idempotente');
{
  journalInserts.length = 0;
  const ordersBefore = orderPosts.length;
  const hoy = new Date('2026-09-14T22:40:00Z');
  const res = await announceSeasonOpen(hoy);

  ok(res.announced === true && res.agents === 7, 'anuncia con los siete en pista', JSON.stringify(res));
  ok(orderPosts.length === ordersBefore, 'CERO órdenes: un anuncio no opera', String(orderPosts.length - ordersBefore));
  ok(journalInserts.length === 1, 'UNA sola fila, no una por agente', String(journalInserts.length));

  const fila = journalInserts[0];
  ok(fila[0] === SEASON_OPEN_ID && fila[1] === '2026-09-14',
    'id fijo (idempotente) y run_date = el día en que corre, no una fecha hardcodeada', JSON.stringify([fila[0], fila[1]]));
  ok(/TEMPORADA 2 — ARRANCA LA LIGA COMPLETA/.test(fila[3]) && /Grok/.test(fila[3]) && /Qwen/.test(fila[3]),
    'el plan anuncia la temporada y nombra a los siete', fila[3].slice(0, 90));
  ok(new RegExp(ARENA_SEASON.start + ' → ' + ARENA_SEASON.end).test(fila[3]),
    'y publica la ventana de la temporada', ARENA_SEASON.start + ' → ' + ARENA_SEASON.end);
  ok(/piso de ruido/.test(fila[3]), 'explica qué es el control (sin eso, ningún delta entre modelos significa nada)');
  const ctx = JSON.parse(fila[4]);
  ok(ctx.season.id === 'T2' && ctx.agents.length === 7 && ctx.opened_on === '2026-09-14',
    'el context lleva temporada, los siete agentes y la fecha de apertura', JSON.stringify({ s: ctx.season.id, n: ctx.agents.length, d: ctx.opened_on }));

  // GUARDA: con la liga recortada NO se anuncia (el id es idempotente; anunciar
  // "arrancan los siete" con menos quedaría sellado el día equivocado).
  journalInserts.length = 0;
  process.env.ARENA_LEAGUE = 'claude,openai,control';
  const parcial = await announceSeasonOpen(hoy);
  delete process.env.ARENA_LEAGUE;
  ok(parcial.announced === false && parcial.reason === 'liga incompleta' && journalInserts.length === 0,
    'con ARENA_LEAGUE recortado no se anuncia nada', JSON.stringify(parcial));
}

// ── UN SOLO mecanismo: el manual quedó retirado ──────────────────────────────
console.log('liga: el mecanismo manual de anuncio ya no existe');
{
  const runner = await import('../api/arena-run.js');
  ok(!('runArenaSeasonAnnounce' in runner) && !('SEASON' in runner),
    'arena-run ya no exporta runArenaSeasonAnnounce ni SEASON (mecanismo manual retirado)',
    JSON.stringify(Object.keys(runner).filter((k) => /season/i.test(k))));
  const src = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  ok(!/action === 'announce'/.test(src), "el handler ya no atiende ?action=announce");
  // El status legado SIGUE excluido del plan anterior: las filas que el
  // mecanismo manual alcanzó a escribir siguen en el journal para siempre.
  ok(/status not in \('season_start', 'season_started', 'rules_changed', 'season_winner'\)/.test(src),
    'la exclusión del plan anterior cubre el status legado Y los tres de liga', 'not in (...)');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
