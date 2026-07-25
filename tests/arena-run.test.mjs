// ═══════════════════════════════════════════════════════════════
// Test de integración de /api/arena-run: runArenaDecide() de punta a punta
// con TODO el I/O mockeado a nivel fetch. Ahora en DOS fases:
//   contexto → SCAN (LLM #1) → deep dive Finnhub → DIVE (LLM #2) → parse →
//   guard → orden límite a Alpaca → journal
// Anthropic fake devuelve respuesta distinta por fase (branch en el system:
// 'SCOUT' vs 'Claude PM'). Finnhub fake: symbol map + deep dive (metric,
// profile2, recommendation, company-news). Valida el pipeline completo, los
// aborts honestos de AMBAS fases, y los dos estados "ok sin órdenes" que se
// distinguen: ok_no_candidates (el scout no vio nada) vs ok_no_actions (hubo
// deep dive y el DIVE holdeó).
// Correr con `node tests/arena-run.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { runArenaDecide, runArenaReconcile, PROMPT_VERSION, resolveBaseUrl, isLeveragedInverseETF } from '../api/arena-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ALPACA_PAPER_KEY = 'PKTEST';
process.env.ALPACA_PAPER_SECRET = 'SECRETTEST';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.FINNHUB_API_KEY = 'fh-test';

const BASE_URL = 'http://qd.test';
const today = new Date().toISOString().slice(0, 10);

// ── serie Yahoo sintética para AAPL: cierres viejos, último = 200 ──
const DAY = 86400000;
const t0 = Date.UTC(2026, 4, 1); // 2026-05-01, muy anterior a "hoy"
const closes = Array.from({ length: 30 }, (_, i) => 195 + (i % 6));
closes[closes.length - 1] = 200;
const timestamps = closes.map((_, i) => (t0 + i * DAY) / 1000);

// ── fase 1 (SCAN): el SCOUT nombra AAPL como candidato ──
let scanText = JSON.stringify({
  scan_thesis: 'AAPL aparece en actives con earnings lejos; el resto del buffet es ruido de micro-caps.',
  candidates: ['AAPL'],
});
// ── fase 2 (DIVE): una acción válida (AAPL) + un símbolo inventado (FAKEZ,
// que ni siquiera fue candidato — prueba que el guard sigue de backstop) ──
let diveText = JSON.stringify({
  plan: 'Primer día del libro: una sola entrada de calidad y el resto en cash mientras llegan más datos.',
  actions: [
    { symbol: 'AAPL', side: 'buy', notional: 10000, limit_price: 201, conviction: 4, reasoning: 'Fundamentales sólidos y recommendation buy-heavy.' },
    { symbol: 'FAKEZ', side: 'buy', notional: 5000, limit_price: 10, conviction: 2, reasoning: 'Ticker que no existe.' },
  ],
});

const alpacaOrderPosts = [];
const journalInserts = [];
const journalUpdates = [];
const finnhubDiveCalls = []; // urls de deep dive (metric/profile2/recommendation/company-news)
let orderFilled = false;
let moversStatus = 200; // se flipa a 401 para probar fetch_errors del buffet

const nowSec = Math.floor(Date.now() / 1000);

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const jsonReply = (obj, status = 200) => ({
    ok: status < 300, status,
    headers: { get: () => 'application/json' }, // safeJson del deep dive exige content-type json
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  // Anthropic — branch por fase según el system prompt.
  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body || '{}');
    const system = String(body.system || '');
    const text = system.includes('SCOUT') ? scanText : diveText;
    return jsonReply({ content: [{ type: 'text', text }] });
  }
  // Alpaca
  if (u.includes('paper-api.alpaca.markets')) {
    if (u.endsWith('/v2/account')) return jsonReply({ status: 'ACTIVE', equity: '100000', cash: '100000' });
    if (u.endsWith('/v2/positions')) return jsonReply([]);
    if (u.includes('/v2/orders?')) return jsonReply([]);
    if (u.endsWith('/v2/orders') && method === 'POST') {
      const body = JSON.parse(opts.body);
      alpacaOrderPosts.push(body);
      return jsonReply({ id: 'ord-1', status: 'accepted', ...body });
    }
    if (u.includes('/v2/orders/ord-1')) {
      return jsonReply(orderFilled
        ? { id: 'ord-1', status: 'filled', filled_qty: '49', filled_avg_price: '200.55', filled_at: today + 'T13:30:05Z' }
        : { id: 'ord-1', status: 'accepted', filled_qty: '0', filled_avg_price: null, filled_at: null });
    }
    return jsonReply({ message: 'ruta alpaca inesperada: ' + u }, 404);
  }
  // Finnhub symbol map (guard)
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    // symbol map con `type` (main #79): alimenta el gate de security_type del guard
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => [{ symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' }, { symbol: 'MSFT', description: 'MICROSOFT CORP', type: 'Common Stock' }] };
  }
  // Finnhub deep dive (fase 2a)
  if (u.includes('finnhub.io/api/v1/stock/metric')) {
    finnhubDiveCalls.push(u);
    return jsonReply({ metric: { peTTM: 30, psTTM: 8, netProfitMarginTTM: 25, grossMarginTTM: 44, 'totalDebt/totalEquityQuarterly': 1.5, currentRatioQuarterly: 1.1, beta: 1.2 } });
  }
  if (u.includes('finnhub.io/api/v1/stock/profile2')) {
    finnhubDiveCalls.push(u);
    return jsonReply({ name: 'Apple Inc', marketCapitalization: 3000000, finnhubIndustry: 'Technology', country: 'US' });
  }
  if (u.includes('finnhub.io/api/v1/stock/recommendation')) {
    finnhubDiveCalls.push(u);
    return jsonReply([{ period: '2026-07-01', strongBuy: 20, buy: 15, hold: 5, sell: 1, strongSell: 0 }]);
  }
  if (u.includes('finnhub.io/api/v1/company-news')) {
    finnhubDiveCalls.push(u);
    return jsonReply([
      { headline: 'Apple beats earnings expectations', datetime: nowSec - DAY / 1000, source: 'Reuters' },
      { headline: 'Old stale headline from a month ago', datetime: nowSec - 30 * (DAY / 1000), source: 'Bloomberg' },
    ]);
  }
  // Yahoo
  if (u.includes('yahoo')) {
    return jsonReply({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] } });
  }
  // Buffet (self-fetch a nuestros endpoints)
  if (u.startsWith(BASE_URL + '/api/movers')) return jsonReply({
    universe: 'market',
    gainers: [{ symbol: 'PENNYG', price: 2, changePct: 60 }, { symbol: 'TSLL', price: 25, changePct: 22 }, { symbol: 'AAPL', price: 200, changePct: 3.1 }],
    losers: [{ symbol: 'PENNYL', price: 0.5, changePct: -55 }, { symbol: 'SQQQ', price: 8, changePct: -9 }, { symbol: 'TSLA', price: 210, changePct: -14.5 }],
    // 12 actives en orden de volumen (como los da AV): TSLL/SQQQ (leveraged),
    // WBUY (<$5) deben caer; TSLA queda en el puesto 7 real → solo top-8 la ve.
    actives: [
      { symbol: 'TSLL', price: 25, changePct: 22 },
      { symbol: 'NOK', price: 6, changePct: 1.1 },
      { symbol: 'NU', price: 12, changePct: 2.0 },
      { symbol: 'BITO', price: 22, changePct: -3.0 },
      { symbol: 'SQQQ', price: 8, changePct: -9 },
      { symbol: 'AAL', price: 14, changePct: -1.2 },
      { symbol: 'F', price: 11, changePct: 0.5 },
      { symbol: 'WBUY', price: 2, changePct: 30 },
      { symbol: 'PLTR', price: 30, changePct: 4.0 },
      { symbol: 'TSLA', price: 210, changePct: -14.5 },
      { symbol: 'NVDA', price: 170, changePct: 1.2 },
      { symbol: 'AAPL', price: 225, changePct: 0.3 },
    ],
  }, moversStatus);
  if (u.startsWith(BASE_URL + '/api/earnings')) return jsonReply({ earnings: [{ ticker: 'MSFT', company: 'Microsoft Corp', date: today, time: 'AMC' }] });
  if (u.startsWith(BASE_URL + '/api/stock-tracker')) return jsonReply({ items: [{ insider: 'Jane Doe', role: 'CEO', ticker: 'AAPL', value: 250000, tradeDate: today }] });
  if (u.startsWith(BASE_URL + '/api/vc-feed')) return jsonReply({ items: [{ title: 'Startup X raises $40M Series B' }] });
  // Neon
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body);
    const q = body.query || '';
    if (q.includes('insert into arena_journal')) { journalInserts.push(body); return jsonReply({ fields: [], rows: [] }); }
    if (q.includes('update arena_journal')) { journalUpdates.push(body); return jsonReply({ fields: [], rows: [] }); }
    if (q.includes('select') && q.includes('arena_journal') && q.includes("interval '7 days'")) {
      // fila canned para el reconcile: una orden enviada sin fill todavía
      return jsonReply({
        fields: [{ name: 'id', dataTypeID: 25 }, { name: 'actions', dataTypeID: 3802 }],
        rows: [['arena-prev', JSON.stringify([{ symbol: 'AAPL', side: 'buy', result: 'approved', alpaca_order_id: 'ord-1', order_status: 'accepted' }])]],
      });
    }
    return jsonReply({ fields: [], rows: [] }); // plan anterior: no hay
  }
  throw new Error('fetch inesperado en el test: ' + u);
};

// índices de columnas de arena_journal (id, run_date, phase, status,
// prompt_version, prompt_hash, model, plan, llm_response, actions, account,
// error, context)
const COL = { phase: 2, status: 3, version: 4, hash: 5, plan: 7, llm: 8, actions: 9, error: 11, context: 12 };
const lastRow = () => journalInserts[journalInserts.length - 1].params;

// ── 1) run feliz: SCAN → deep dive → DIVE → válida ejecutada, inventada descartada ──
console.log('arena-run: decide de dos fases de punta a punta (SCAN + Finnhub + DIVE + guard fakes)');
const r1 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r1.status === 'ok' && r1.orders === 1, 'run ok con 1 orden enviada', JSON.stringify(r1));
ok(r1.discarded === 1, 'el símbolo inventado fue descartado, no ejecutado', JSON.stringify(r1));
ok(r1.candidates === 1, 'el scan nombró 1 candidato', JSON.stringify(r1));

ok(alpacaOrderPosts.length === 1, 'exactamente una orden llegó a Alpaca');
const sent = alpacaOrderPosts[0] || {};
ok(sent.type === 'limit' && sent.time_in_force === 'day', 'la orden es limit + day (regla de la casa)');
ok(sent.symbol === 'AAPL' && sent.qty === '49', 'qty entera floor(10000/201) = 49', JSON.stringify(sent));
ok(sent.client_order_id === `arena:${today}:AAPL:buy`, 'client_order_id determinista (idempotencia)', sent.client_order_id);

ok(journalInserts.length === 1, 'una fila de journal por run');
const jrow = lastRow();
ok(jrow[COL.phase] === 'decide' && jrow[COL.status] === 'ok', 'journal: phase decide, status ok', jrow[COL.status]);
ok(jrow[COL.version] === PROMPT_VERSION && /^[0-9a-f]{64}$/.test(jrow[COL.hash] || ''), 'journal: versión v2 + hash sha256 del prompt del DIVE');
ok((jrow[COL.plan] || '').includes('Primer día'), 'journal: el plan del PM (del DIVE) se publica verbatim');
ok((jrow[COL.llm] || '').includes('FAKEZ'), 'journal: la respuesta COMPLETA del DIVE queda guardada');
const jactions = JSON.parse(jrow[COL.actions]);
const jFake = jactions.find((a) => a.symbol === 'FAKEZ');
const jAapl = jactions.find((a) => a.symbol === 'AAPL');
ok(jFake && jFake.result === 'discarded' && /symbol map/.test(jFake.reason), 'journal: descartada CON razón (guard de backstop)', JSON.stringify(jFake));
ok(jAapl && jAapl.result === 'approved' && jAapl.alpaca_order_id === 'ord-1', 'journal: aprobada con su alpaca_order_id');
// El wiring type→guard→journal (main #79): la aprobada lleva su security_type.
ok(jAapl && jAapl.security_type === 'Common Stock', 'journal: la aprobada lleva el security_type del symbol map (wiring type→guard→journal)', JSON.stringify(jAapl && jAapl.security_type));

// ── context de dos fases: scan + dive journaleados ──
const jctx = JSON.parse(jrow[COL.context]);
ok(Array.isArray(jctx.unavailable) && jctx.unavailable.length === 0, 'journal: context.unavailable vacío cuando los 4 endpoints responden');
ok(jctx.fetch_errors && Object.keys(jctx.fetch_errors).length === 0, 'journal: context.fetch_errors vacío cuando todo entrega datos');
ok(jctx.scan && jctx.scan.prompt && jctx.scan.prompt.system.includes('SCOUT'), 'journal: context.scan.prompt guarda el system del SCOUT');
ok(Array.isArray(jctx.scan.candidates) && jctx.scan.candidates[0] === 'AAPL', 'journal: context.scan.candidates lista los tickers elegidos', JSON.stringify(jctx.scan.candidates));
ok(typeof jctx.scan.thesis === 'string' && jctx.scan.thesis.length > 0, 'journal: context.scan.thesis guardada');
ok(jctx.dive && jctx.dive.prompt && jctx.dive.prompt.system.includes('Claude PM'), 'journal: context.dive.prompt guarda el system del PM');
ok(/^[0-9a-f]{64}$/.test(jctx.scan.hash) && /^[0-9a-f]{64}$/.test(jctx.dive.hash), 'journal: hash sha256 por fase');

// ── deep dive de Finnhub journaleado ──
ok(jctx.dive.finnhub && jctx.dive.finnhub.AAPL, 'journal: context.dive.finnhub trae el ticker candidato');
const dd = jctx.dive.finnhub.AAPL;
ok(dd.fundamentals && dd.fundamentals.peTTM === 30 && dd.fundamentals.netMarginTTM === 25, 'deep dive: fundamentales (P/E, margen neto) extraídos de metric', JSON.stringify(dd.fundamentals));
ok(dd.fundamentals.debtToEquity === 1.5, 'deep dive: deuda (totalDebt/totalEquity con slash en la clave) extraída', String(dd.fundamentals.debtToEquity));
ok(dd.profile && dd.profile.marketCapM === 3000000 && dd.profile.industry === 'Technology', 'deep dive: profile2 (market cap en millones, industria)', JSON.stringify(dd.profile));
ok(dd.recommendation && dd.recommendation.strongBuy === 20 && dd.recommendation.hold === 5, 'deep dive: recommendation (reparto de analistas) — la señal de rating', JSON.stringify(dd.recommendation));
ok(Array.isArray(dd.news) && dd.news.length === 1 && dd.news[0].headline.includes('beats earnings'), 'deep dive: company-news filtrada a 7 días (el titular viejo de 30d se descarta)', JSON.stringify(dd.news));

// ── el DIVE prompt trae los datos y aclara que price target NO viene (Premium) ──
ok(jctx.dive.prompt.user.includes('AAPL') && /price targets? .*NOT provided/i.test(jctx.dive.prompt.user), 'prompt DIVE: research por candidato + nota de que no hay price targets (Premium)');

// ── el cierre se le MUESTRA al PM (fix del desfase: el guard valida contra el
// MISMO cierre). Yahoo mock → último cierre 200 → banda ±2% = [196, 204]. ──
ok(jctx.dive.shown_closes && jctx.dive.shown_closes.AAPL === 200, 'journal: context.dive.shown_closes guarda el cierre mostrado por candidato (auditar desfases)', JSON.stringify(jctx.dive && jctx.dive.shown_closes));
const research = JSON.parse(jctx.dive.prompt.user.split('\n').find((l) => l.startsWith('[') && l.includes('"ticker"')));
const rAapl = research.find((x) => x.ticker === 'AAPL');
ok(rAapl && rAapl.last_close === 200, 'prompt DIVE: cada candidato lleva last_close (el MISMO contra el que valida el guard)', JSON.stringify(rAapl && rAapl.last_close));
ok(rAapl && rAapl.limit_range && rAapl.limit_range.low === 196 && rAapl.limit_range.high === 204, 'prompt DIVE: limit_range ±2% ya calculado (196–204 para cierre 200) — sin aritmética para el PM', JSON.stringify(rAapl && rAapl.limit_range));
ok(/limit_price MUST fall inside/i.test(jctx.dive.prompt.user) && /Do NOT anchor.*52-week/i.test(jctx.dive.prompt.user), 'prompt DIVE: regla de precio explícita (±2% del last_close, no anclar en 52w-high)');

// ── el SCAN prompt trae el buffet; movers con top-8 + filtro leveraged + ≥$5 (main #76) ──
const uMovers = JSON.parse(jctx.scan.prompt.user.split('\n').find((l) => l.startsWith('{') && l.includes('"movers"'))).movers;
ok(Array.isArray(uMovers.actives) && uMovers.actives.length === 8, 'prompt SCAN: actives recortado a top-8', String((uMovers.actives || []).length));
ok(uMovers.actives.some((m) => m.symbol === 'TSLA'),
  'prompt SCAN: TSLA (-14.5%, puesto 7 por volumen) entra en top-8, antes invisible en top-5', JSON.stringify(uMovers.actives.map((m) => m.symbol)));
ok(!uMovers.actives.some((m) => m.symbol === 'TSLL') && !uMovers.actives.some((m) => m.symbol === 'SQQQ'),
  'prompt SCAN: leveraged/inverse ETFs (TSLL, SQQQ) fuera de actives', JSON.stringify(uMovers.actives.map((m) => m.symbol)));
ok(!uMovers.gainers.some((m) => m.symbol === 'TSLL') && !uMovers.losers.some((m) => m.symbol === 'SQQQ'),
  'prompt SCAN: leveraged/inverse ETFs fuera de gainers y losers');
ok(!uMovers.gainers.some((m) => m.symbol === 'PENNYG') && !uMovers.losers.some((m) => m.symbol === 'PENNYL') && !uMovers.actives.some((m) => m.symbol === 'WBUY'),
  'prompt SCAN: micro-caps (<$5) filtradas de gainers, losers y actives', JSON.stringify(uMovers));
ok(uMovers.gainers.some((m) => m.symbol === 'AAPL') && uMovers.losers.some((m) => m.symbol === 'TSLA'),
  'prompt SCAN: las de precio real (AAPL, TSLA) sí quedan', JSON.stringify(uMovers));

// ── 1b) un endpoint del buffet cae (401) → su error REAL queda journaleado ──
console.log('arena-run: fetch_errors del buffet en el journal (observabilidad)');
moversStatus = 401;
const insBefore = journalInserts.length;
const r1b = await runArenaDecide({ baseUrl: BASE_URL });
ok(journalInserts.length === insBefore + 1, 'run con endpoint caído igual journalea');
const ctxDown = JSON.parse(lastRow()[COL.context]);
ok(ctxDown.unavailable.includes('movers'), 'context.unavailable incluye el endpoint caído', JSON.stringify(ctxDown.unavailable));
ok(ctxDown.fetch_errors.movers === 'HTTP 401', 'context.fetch_errors trae el status HTTP real', JSON.stringify(ctxDown.fetch_errors));
ok(r1b.status === 'ok' || r1b.status === 'ok_no_actions', 'el Arena opera con menos contexto, no aborta por un endpoint caído', r1b.status);
moversStatus = 200; // restaurar

// ── 2) reconcile: el fill real aterriza en el journal ──
console.log('arena-run: reconcile matutino');
orderFilled = true;
const r2 = await runArenaReconcile({});
ok(r2.filled === 1 && r2.updated === 1, 'detectó el fill y actualizó la fila', JSON.stringify(r2));
const upd = JSON.parse(journalUpdates[0].params[1]);
ok(upd[0].order_status === 'filled' && upd[0].filled_avg_price === 200.55 && !!upd[0].filled_at,
  'el fill guarda precio y timestamp REALES de Alpaca', JSON.stringify(upd[0]));

// ── 3) SCAN sin candidatos → ok_no_candidates, sin deep dive, sin órdenes ──
console.log('arena-run: SCAN sin candidatos (distinto de DIVE que holdea)');
scanText = JSON.stringify({ scan_thesis: 'Todo el buffet es ruido de micro-caps hoy; nada amerita research.', candidates: [] });
const diveCallsBefore = finnhubDiveCalls.length;
const postsBefore3 = alpacaOrderPosts.length;
const r3 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r3.status === 'ok_no_candidates' && r3.orders === 0 && r3.candidates === 0, 'scan vacío → ok_no_candidates', JSON.stringify(r3));
ok(finnhubDiveCalls.length === diveCallsBefore, 'NO se pegó a Finnhub deep dive cuando no hubo candidatos');
ok(alpacaOrderPosts.length === postsBefore3, 'cero órdenes cuando no hubo candidatos');
const jNoCand = lastRow();
ok(jNoCand[COL.status] === 'ok_no_candidates' && (jNoCand[COL.plan] || '').includes('ruido'), 'journal: ok_no_candidates con la tesis del scout como plan');
ok(JSON.parse(jNoCand[COL.context]).dive === undefined, 'journal: sin fase dive cuando no hubo candidatos');

// ── 4) hay candidatos pero el DIVE holdea → ok_no_actions (distinto de #3) ──
console.log('arena-run: DIVE holdea con candidatos → ok_no_actions');
scanText = JSON.stringify({ scan_thesis: 'AAPL merece un vistazo.', candidates: ['AAPL'] });
diveText = JSON.stringify({ plan: 'Fundamentales caros y recommendation mixta: holdeo, no entro hoy.', actions: [] });
const r4 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r4.status === 'ok_no_actions' && r4.orders === 0 && r4.candidates === 1, 'DIVE con candidatos pero sin órdenes → ok_no_actions', JSON.stringify(r4));
ok(lastRow()[COL.status] === 'ok_no_actions', 'journal: ok_no_actions es un estado DISTINTO de ok_no_candidates');

// ── 5) JSON malformado del SCAN → aborted_scan_malformed_json, cero órdenes ──
console.log('arena-run: aborts honestos por fase');
scanText = 'Investigaría AAPL y NVDA pero sin JSON.';
const postsBefore5 = alpacaOrderPosts.length;
const r5 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r5.status === 'aborted_scan_malformed_json' && r5.orders === 0, 'scan malformado → abort de fase 1', JSON.stringify(r5));
ok(alpacaOrderPosts.length === postsBefore5, 'cero órdenes tras abort del scan');
ok(lastRow()[COL.status] === 'aborted_scan_malformed_json', 'journal: abort del scan journaleado');

// ── 6) SCAN ok pero DIVE malformado → aborted_malformed_json ──
scanText = JSON.stringify({ scan_thesis: 'AAPL.', candidates: ['AAPL'] });
diveText = 'Compraría AAPL, pero sin JSON.';
const r6 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r6.status === 'aborted_malformed_json' && r6.orders === 0, 'dive malformado → abort de fase 2', JSON.stringify(r6));
ok(alpacaOrderPosts.length === postsBefore5, 'sigue sin mandar órdenes');

// ── 7) sin ANTHROPIC_API_KEY → journaleado, cero órdenes, ni siquiera SCAN ──
delete process.env.ANTHROPIC_API_KEY;
const r7 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r7.status === 'aborted_no_api_key' && r7.orders === 0, 'sin créditos → abort honesto antes del SCAN', JSON.stringify(r7));
ok(alpacaOrderPosts.length === postsBefore5, 'sigue sin mandar órdenes');
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

// ── 8) resolveBaseUrl: PUBLIC_BASE_URL primero (fix del self-fetch 401) ──
console.log('arena-run: resolveBaseUrl (A2 — evita Deployment Protection)');
const envSnap = { pub: process.env.PUBLIC_BASE_URL, vercel: process.env.VERCEL_URL };
process.env.PUBLIC_BASE_URL = 'https://quantdesk2.vercel.app';
process.env.VERCEL_URL = 'quantdesk2-pnamotrql-x.vercel.app';
ok(resolveBaseUrl({ headers: {} }) === 'https://quantdesk2.vercel.app',
  'PUBLIC_BASE_URL gana sobre VERCEL_URL (el generado está protegido)');
process.env.PUBLIC_BASE_URL = 'https://quantdesk2.vercel.app/';
ok(resolveBaseUrl({ headers: {} }) === 'https://quantdesk2.vercel.app', 'recorta el trailing slash');
delete process.env.PUBLIC_BASE_URL;
ok(resolveBaseUrl({ headers: {} }) === 'https://quantdesk2-pnamotrql-x.vercel.app', 'cae a VERCEL_URL si no hay PUBLIC_BASE_URL');
delete process.env.VERCEL_URL;
ok(resolveBaseUrl({ headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' } }) === 'http://localhost:3000',
  'cae a proto+host en dev/local');
// restaurar el entorno
if (envSnap.pub === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = envSnap.pub;
if (envSnap.vercel === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = envSnap.vercel;

// ── 6) isLeveragedInverseETF: detecta ETPs, no confunde nombres reales ──
console.log('arena-run: isLeveragedInverseETF (lista curada, sin falsos positivos)');
ok(isLeveragedInverseETF('TSLL') && isLeveragedInverseETF('sqqq') && isLeveragedInverseETF(' SOXL '),
  'detecta leveraged/inverse (case/trim-insensible)');
ok(!isLeveragedInverseETF('NU') && !isLeveragedInverseETF('AAL') && !isLeveragedInverseETF('NOK') && !isLeveragedInverseETF('TSLA'),
  'NO marca nombres reales (NU, AAL, NOK, TSLA)');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
