// ═══════════════════════════════════════════════════════════════
// Test de integración de /api/arena-run: runArenaDecide() de punta a punta
// con TODO el I/O mockeado a nivel fetch — Alpaca fake (cuenta/posiciones/
// órdenes), Anthropic fake (el plan del PM), Finnhub fake (symbol map),
// Yahoo fake (último cierre), buffet fake (movers/earnings/tracker/vc) y
// Neon fake (formato wire real). Valida el pipeline completo:
//   contexto → LLM → parse → guard → orden límite a Alpaca → journal
// y los dos aborts honestos (JSON malformado, sin API key).
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

// ── el plan que "responde" el LLM: una acción válida + un símbolo inventado ──
let llmText = JSON.stringify({
  plan: 'Primer día del libro: una sola entrada de calidad y el resto en cash mientras llegan más datos.',
  actions: [
    { symbol: 'AAPL', side: 'buy', notional: 10000, limit_price: 201, conviction: 4, reasoning: 'Momentum del buffet con earnings lejos.' },
    { symbol: 'FAKEZ', side: 'buy', notional: 5000, limit_price: 10, conviction: 2, reasoning: 'Ticker que no existe.' },
  ],
});

const alpacaOrderPosts = [];
const journalInserts = [];
const journalUpdates = [];
let orderFilled = false;
let moversStatus = 200; // se flipa a 401 para probar fetch_errors del buffet

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const jsonReply = (obj, status = 200) => ({
    ok: status < 300, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  // Anthropic
  if (u.includes('api.anthropic.com')) {
    return jsonReply({ content: [{ type: 'text', text: llmText }] });
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
  // Finnhub symbol map
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => [{ symbol: 'AAPL', description: 'APPLE INC' }, { symbol: 'MSFT', description: 'MICROSOFT CORP' }] };
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

// ── 1) run feliz: válida ejecutada, inventada descartada, journal completo ──
console.log('arena-run: decide de punta a punta (Alpaca + LLM + guard + journal fakes)');
const r1 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r1.status === 'ok' && r1.orders === 1, 'run ok con 1 orden enviada', JSON.stringify(r1));
ok(r1.discarded === 1, 'el símbolo inventado fue descartado, no ejecutado', JSON.stringify(r1));

ok(alpacaOrderPosts.length === 1, 'exactamente una orden llegó a Alpaca');
const sent = alpacaOrderPosts[0] || {};
ok(sent.type === 'limit' && sent.time_in_force === 'day', 'la orden es limit + day (regla de la casa)');
ok(sent.symbol === 'AAPL' && sent.qty === '49', 'qty entera floor(10000/201) = 49', JSON.stringify(sent));
ok(sent.client_order_id === `arena:${today}:AAPL:buy`, 'client_order_id determinista (idempotencia)', sent.client_order_id);

ok(journalInserts.length === 1, 'una fila de journal por run');
const jrow = journalInserts[0].params;
// (id, run_date, phase, status, prompt_version, prompt_hash, model, plan, llm_response, actions, account, error)
ok(jrow[2] === 'decide' && jrow[3] === 'ok', 'journal: phase decide, status ok', jrow[3]);
ok(jrow[4] === PROMPT_VERSION && /^[0-9a-f]{64}$/.test(jrow[5] || ''), 'journal: versión + hash sha256 del prompt');
ok((jrow[7] || '').includes('Primer día'), 'journal: el plan del PM se publica verbatim');
ok((jrow[8] || '').includes('FAKEZ'), 'journal: la respuesta COMPLETA del LLM queda guardada');
const jactions = JSON.parse(jrow[9]);
const jFake = jactions.find((a) => a.symbol === 'FAKEZ');
const jAapl = jactions.find((a) => a.symbol === 'AAPL');
ok(jFake && jFake.result === 'discarded' && /symbol map/.test(jFake.reason), 'journal: descartada CON razón', JSON.stringify(jFake));
ok(jAapl && jAapl.result === 'approved' && jAapl.alpaca_order_id === 'ord-1', 'journal: aprobada con su alpaca_order_id');
// context journaleado: (id, run_date, phase, status, prompt_version, prompt_hash,
// model, plan, llm_response, actions, account, error, context) → params[12]
const jctx = JSON.parse(jrow[12]);
ok(jctx && Array.isArray(jctx.unavailable) && jctx.unavailable.length === 0,
  'journal: context.unavailable vacío cuando los 4 endpoints responden', jrow[12]);
ok(jctx && jctx.fetch_errors && Object.keys(jctx.fetch_errors).length === 0,
  'journal: context.fetch_errors vacío cuando todo entrega datos', jrow[12]);

// context.prompt: el prompt REAL journaleado (no solo el hash) — post-mortem sin arqueología
ok(jctx.prompt && typeof jctx.prompt.system === 'string' && typeof jctx.prompt.user === 'string',
  'journal: context.prompt guarda system + user completos');
ok(jctx.prompt.system.includes('Claude PM'), 'journal: el system prompt real queda guardado');
const uMovers = JSON.parse(jctx.prompt.user.split('\n').find((l) => l.startsWith('{') && l.includes('"movers"'))).movers;
// actives a top-8 y TSLA (puesto 7 real) por fin entra
ok(Array.isArray(uMovers.actives) && uMovers.actives.length === 8, 'prompt: actives recortado a top-8', String((uMovers.actives || []).length));
ok(uMovers.actives.some((m) => m.symbol === 'TSLA'),
  'prompt: TSLA (-14.5%, puesto 7 por volumen) entra en top-8, antes invisible en top-5', JSON.stringify(uMovers.actives.map((m) => m.symbol)));
// leveraged/inverse ETFs fuera de las TRES listas
ok(!uMovers.actives.some((m) => m.symbol === 'TSLL') && !uMovers.actives.some((m) => m.symbol === 'SQQQ'),
  'prompt: leveraged/inverse ETFs (TSLL, SQQQ) fuera de actives', JSON.stringify(uMovers.actives.map((m) => m.symbol)));
ok(!uMovers.gainers.some((m) => m.symbol === 'TSLL') && !uMovers.losers.some((m) => m.symbol === 'SQQQ'),
  'prompt: leveraged/inverse ETFs fuera de gainers y losers');
// filtro ≥$5: penny stocks fuera de las tres listas
ok(!uMovers.gainers.some((m) => m.symbol === 'PENNYG') && !uMovers.losers.some((m) => m.symbol === 'PENNYL') && !uMovers.actives.some((m) => m.symbol === 'WBUY'),
  'prompt: micro-caps (<$5) filtradas de gainers, losers y actives', JSON.stringify(uMovers));
ok(uMovers.gainers.some((m) => m.symbol === 'AAPL') && uMovers.losers.some((m) => m.symbol === 'TSLA'),
  'prompt: las de precio real (AAPL, TSLA) sí quedan', JSON.stringify(uMovers));

// ── 1b) un endpoint del buffet cae (401) → su error REAL queda journaleado ──
console.log('arena-run: fetch_errors del buffet en el journal (observabilidad)');
moversStatus = 401;
const insBefore = journalInserts.length;
const r1b = await runArenaDecide({ baseUrl: BASE_URL });
ok(journalInserts.length === insBefore + 1, 'run con endpoint caído igual journalea');
const ctxDown = JSON.parse(journalInserts[journalInserts.length - 1].params[12]);
ok(ctxDown.unavailable.includes('movers'), 'context.unavailable incluye el endpoint caído', JSON.stringify(ctxDown));
ok(ctxDown.fetch_errors.movers === 'HTTP 401', 'context.fetch_errors trae el status HTTP real (no solo "no disponible")', JSON.stringify(ctxDown.fetch_errors));
ok(r1b.status === 'ok' || r1b.status === 'ok_no_actions', 'el Arena opera con menos contexto, no aborta por un endpoint caído', r1b.status);
moversStatus = 200; // restaurar para no contaminar los escenarios siguientes

// ── 2) reconcile: el fill real aterriza en el journal ──
console.log('arena-run: reconcile matutino');
orderFilled = true;
const r2 = await runArenaReconcile({});
ok(r2.filled === 1 && r2.updated === 1, 'detectó el fill y actualizó la fila', JSON.stringify(r2));
const upd = JSON.parse(journalUpdates[0].params[1]);
ok(upd[0].order_status === 'filled' && upd[0].filled_avg_price === 200.55 && !!upd[0].filled_at,
  'el fill guarda precio y timestamp REALES de Alpaca', JSON.stringify(upd[0]));

// ── 3) JSON malformado → abort honesto, CERO órdenes ──
console.log('arena-run: aborts honestos');
llmText = 'Compraría AAPL y también otras cosas, pero sin JSON.';
const postsBefore = alpacaOrderPosts.length;
const r3 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r3.status === 'aborted_malformed_json' && r3.orders === 0, 'malformado → run abortado', JSON.stringify(r3));
ok(alpacaOrderPosts.length === postsBefore, 'cero órdenes nuevas a Alpaca tras el abort');
const jAbort = journalInserts[journalInserts.length - 1].params;
ok(jAbort[3] === 'aborted_malformed_json' && (jAbort[8] || '').includes('sin JSON'),
  'el abort queda journaleado con la respuesta cruda');

// ── 4) sin ANTHROPIC_API_KEY (créditos pendientes) → journaleado, cero órdenes ──
delete process.env.ANTHROPIC_API_KEY;
const r4 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r4.status === 'aborted_no_api_key' && r4.orders === 0, 'sin créditos → abort honesto', JSON.stringify(r4));
ok(alpacaOrderPosts.length === postsBefore, 'sigue sin mandar órdenes');

// ── 5) resolveBaseUrl: PUBLIC_BASE_URL primero (fix del self-fetch 401) ──
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
