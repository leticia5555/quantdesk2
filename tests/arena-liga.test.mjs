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
delete process.env.ARENA_LEAGUE;
delete process.env.ARENA_SCREENER_ENABLED;
delete process.env.ARENA_TEMPERATURE;

import { runArenaLeague, runArenaSeasonAnnounce, SEASON } from '../api/arena-run.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_TEMPERATURE, ARENA_AGENTS } from '../api/_lib/arena-registry.js';
import { callArenaLLM, providerKey } from '../api/_lib/arena-model.js';
import { buildDiveSystemPrompt } from '../api/arena-run.js';

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
const seasonRows = [];       // agent_id con fila 'season_start' ya insertada (idempotencia)
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
    const system = String(body.system || '');
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
  ok(agentById('openai').model === 'openai/gpt-5-mini' && agentById('openai').provider === 'openrouter', 'openai → slug gpt-5-mini vía OpenRouter');
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
  ok(anthropicCalls.every((c) => c.model === 'claude-haiku-4-5'), 'Anthropic siempre con el modelo Haiku');
  // Cada agente de OpenRouter va con SU slug — un solo adapter, cinco modelos.
  const slugsVistos = [...new Set(openrouterCalls.map((c) => c.model))].sort();
  ok(slugsVistos.join(',') === ['openai/gpt-5-mini', 'x-ai/grok-4-fast', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat-v3.1', 'qwen/qwen-plus'].sort().join(','),
    'OpenRouter recibió los 5 slugs distintos (uno por agente)', JSON.stringify(slugsVistos));

  // TEMPERATURA fija 0.7 en AMBOS proveedores.
  ok(anthropicCalls.every((c) => c.temperature === 0.7) && openrouterCalls.every((c) => c.temperature === 0.7),
    'temperatura 0.7 idéntica en Anthropic y OpenRouter');

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

// ── Anuncio del arranque de TEMPORADA ─────────────────────────────────────────
// Fila OPERATIVA por agente (no una decisión): cero órdenes, model null, status
// propio, e IDEMPOTENTE — curlear el endpoint dos veces no duplica el rastro.
console.log('liga: anuncio de arranque de Temporada ' + SEASON + ' (fila por agente, idempotente)');
{
  journalInserts.length = 0; seasonRows.length = 0;
  const ordersBefore = orderPosts.length;
  const hoy = new Date('2026-09-13T18:00:00Z');
  const res = await runArenaSeasonAnnounce({ now: hoy });

  ok(res.season === SEASON && res.announced.length === 7, 'anuncia a los 7 agentes de la parrilla', JSON.stringify(res.announced));
  ok(res.run_date === '2026-09-13', 'la fila lleva la fecha del día del anuncio', res.run_date);
  ok(orderPosts.length === ordersBefore, 'CERO órdenes: un anuncio no opera', String(orderPosts.length - ordersBefore));
  ok(journalInserts.length === 7 && journalInserts.every((p) => p[3] === 'season_start'),
    "las 7 filas van con status 'season_start' (separable del post-mortem)", JSON.stringify(journalInserts.map((p) => p[3])));
  ok(journalInserts.every((p) => p[6] === null), 'model null: ningún LLM decidió esto', JSON.stringify(journalInserts.map((p) => p[6])));
  ok(journalInserts.every((p) => JSON.parse(p[9] || '[]').length === 0), 'actions vacío en todas las filas');
  ok(journalInserts.every((p) => p[2] === 'decide'),
    "phase='decide' → el leaderboard la publica como la entrada visible del agente");
  const plan0 = journalInserts[0][7];
  ok(/TEMPORADA 2 DE LA LIGA/.test(plan0) && /7 agentes/.test(plan0), 'el plan anuncia la Temporada 2 y la parrilla', plan0);
  ok(journalInserts.every((p) => p[7] === plan0), 'el mismo anuncio verbatim para los 7 (es un hecho de la liga)');
  ok(JSON.parse(journalInserts[0][12]).roster.length === 7, 'context.roster deja quién arrancó la temporada (auditable)');

  // Segunda pasada: idempotente.
  journalInserts.length = 0;
  const again = await runArenaSeasonAnnounce({ now: hoy });
  ok(again.announced.length === 0 && again.skipped.length === 7, 'segunda corrida: no duplica (idempotente)', JSON.stringify(again));
  ok(journalInserts.length === 0, 'cero inserts en la segunda corrida', String(journalInserts.length));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
