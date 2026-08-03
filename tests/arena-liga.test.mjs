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
process.env.FINNHUB_API_KEY = 'fh-test';
delete process.env.ARENA_LEAGUE;
delete process.env.ARENA_SCREENER_ENABLED;
delete process.env.ARENA_TEMPERATURE;

import { runArenaLeague } from '../api/arena-run.js';
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

// Telemetría del mock.
const anthropicCalls = [];   // { model, temperature, phase }
const openrouterCalls = [];  // { model, temperature, phase }
const orderPosts = [];       // { account, symbol, side }
const journalInserts = [];   // params de cada insert into arena_journal
let moversFetches = 0;
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
    const phase = system.includes('SCOUT') ? 'scan' : 'dive';
    anthropicCalls.push({ model: body.model, temperature: body.temperature, phase });
    return jsonReply({ content: [{ type: 'text', text: phase === 'scan' ? SCAN : DIVE }], usage: { input_tokens: 10, output_tokens: 20 } });
  }
  // OpenRouter (openai) — forma OpenAI; el system es messages[0].
  if (u.includes('openrouter.ai')) {
    const body = JSON.parse(opts.body || '{}');
    const sys = String((body.messages && body.messages[0] && body.messages[0].content) || '');
    const phase = sys.includes('SCOUT') ? 'scan' : 'dive';
    openrouterCalls.push({ model: body.model, temperature: body.temperature, phase });
    return jsonReply({ choices: [{ message: { content: phase === 'scan' ? SCAN : DIVE } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
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
    if (q.includes('insert into arena_journal')) { journalInserts.push(body.params); return jsonReply({ fields: [], rows: [] }); }
    return jsonReply({ fields: [], rows: [] });
  }
  throw new Error('fetch inesperado en el test: ' + u);
};

// ── 1) Registry ──────────────────────────────────────────────────────
console.log('liga: registry (Fase A activa, slugs, temperatura, creds)');
{
  const ids = activeAgents().map((a) => a.id);
  ok(ids.length === 3 && ids.includes('claude') && ids.includes('openai') && ids.includes('control'),
    'Fase A activa: claude + openai + control (los otros 4 apagados)', JSON.stringify(ids));
  const off = ARENA_AGENTS.filter((a) => !a.enabled).map((a) => a.id);
  ok(['grok', 'gemini', 'deepseek', 'qwen'].every((x) => off.includes(x)), 'Fase B presente pero apagada', JSON.stringify(off));
  ok(ARENA_TEMPERATURE === 0.7, 'temperatura fija 0.7 por default', String(ARENA_TEMPERATURE));
  ok(agentById('openai').model === 'openai/gpt-5-mini' && agentById('openai').provider === 'openrouter', 'openai → slug gpt-5-mini vía OpenRouter');
  ok(agentById('deepseek').house === 'china' && agentById('qwen').house === 'china', 'DeepSeek/Qwen marcados casa china (ángulo de contenido)');
  ok(agentById('claude').model === agentById('control').model, 'control usa el MISMO modelo que claude (Haiku-B)');
  // Creds por agente, nomenclatura ALPACA_<ALPACA>_*
  ok(agentAlpacaCreds(agentById('claude')).key === 'PK_CLAUDE', 'claude reusa ALPACA_PAPER_* (continuidad del Agente #6)');
  ok(agentAlpacaCreds(agentById('openai')).key === 'PK_OPENAI' && agentAlpacaCreds(agentById('control')).key === 'PK_CONTROL',
    'openai/control leen sus propias ALPACA_<ID>_*');
  // ARENA_LEAGUE gana sobre enabled
  process.env.ARENA_LEAGUE = 'claude,grok';
  ok(activeAgents().map((a) => a.id).join(',') === 'claude,grok', 'ARENA_LEAGUE override enciende cualquier subconjunto (Fase B sin redeploy)');
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
console.log('liga: runArenaLeague — 3 agentes, multi-cuenta, agent_id, dedupe');
anthropicCalls.length = 0; openrouterCalls.length = 0; orderPosts.length = 0;
journalInserts.length = 0; moversFetches = 0; aaplMetricFetches.length = 0;
const res = await runArenaLeague({ baseUrl: BASE_URL });
{
  const byId = Object.fromEntries((res.agents || []).map((a) => [a.id, a]));
  ok(res.agents.length === 3 && byId.claude && byId.openai && byId.control, 'corren los 3 agentes de la Fase A', JSON.stringify(res.league));
  ok(byId.claude.status === 'ok' && byId.openai.status === 'ok' && byId.control.status === 'ok', 'los 3 deciden ok (1 orden c/u)', JSON.stringify(res.agents.map((a) => [a.id, a.status])));

  // Proveedor correcto por agente: claude+control → Anthropic; openai → OpenRouter.
  ok(anthropicCalls.length === 4, 'Anthropic recibió 4 llamadas (claude + control, 2 fases c/u)', String(anthropicCalls.length));
  ok(openrouterCalls.length === 2, 'OpenRouter recibió 2 llamadas (openai, 2 fases)', String(openrouterCalls.length));
  ok(anthropicCalls.every((c) => c.model === 'claude-haiku-4-5'), 'Anthropic siempre con el modelo Haiku');
  ok(openrouterCalls.every((c) => c.model === 'openai/gpt-5-mini'), 'OpenRouter siempre con el slug gpt-5-mini');

  // TEMPERATURA fija 0.7 en AMBOS proveedores.
  ok(anthropicCalls.every((c) => c.temperature === 0.7) && openrouterCalls.every((c) => c.temperature === 0.7),
    'temperatura 0.7 idéntica en Anthropic y OpenRouter');

  // MULTI-CUENTA: cada agente mandó su orden a SU cuenta.
  const acctBySym = {};
  for (const o of orderPosts) acctBySym[o.account] = (acctBySym[o.account] || 0) + 1;
  ok(orderPosts.length === 3, 'tres órdenes (una por agente)', JSON.stringify(orderPosts.map((o) => o.account)));
  ok(acctBySym.PK_CLAUDE === 1 && acctBySym.PK_OPENAI === 1 && acctBySym.PK_CONTROL === 1,
    'cada orden fue a la cuenta Alpaca correcta (multi-login por header)', JSON.stringify(acctBySym));

  // agent_id: cada fila del journal lleva su agente (param $14, posición 13).
  const agentIds = journalInserts.map((p) => p[13]).sort();
  ok(agentIds.length === 3 && agentIds.join(',') === 'claude,control,openai',
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

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
