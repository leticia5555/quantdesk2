// ═══════════════════════════════════════════════════════════════
// Test de integración de /api/arena-run: runArenaDecide() de punta a punta
// con TODO el I/O mockeado a nivel fetch. En DOS fases:
//   contexto (incluye el canal SCREENER leído de Neon) → SCAN (LLM #1) →
//   FLOOR determinista del screener → deep dive Finnhub → DIVE (LLM #2) →
//   parse → guard → orden límite a Alpaca → journal.
// Anthropic fake devuelve respuesta distinta por fase (branch en el system:
// 'SCOUT' vs 'Claude PM'). Finnhub fake: symbol map + deep dive (metric,
// profile2, recommendation, company-news). Neon fake: journal + la tabla
// arena_screener (mutable) que el arena-run SOLO LEE.
//
// Cubre: el pipeline completo, la ATRIBUCIÓN de canal + origin
// (scout_picked/floor_reserved), el FLOOR (surfacea el screener cuando el
// scout no lo elige), el CANDADO de precio (el precio stale del screener
// NUNCA llega a limit_price — la banda sale del cierre fresco de Yahoo), los
// aborts honestos de AMBAS fases, y los dos estados "ok sin órdenes":
// ok_no_candidates (nada que investigar, ni scout ni screener) vs
// ok_no_actions (hubo deep dive y el DIVE holdeó).
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

// ── serie Yahoo sintética: cierres viejos, último = 200. La MISMA para todos
// los símbolos (lastCompletedClose la usa por candidato). Clave del CANDADO:
// HD llega del screener con last_close=150 STALE, pero el cierre FRESCO de
// Yahoo es 200 → la banda ±2% se calcula sobre 200, no sobre 150. ──
const DAY = 86400000;
const t0 = Date.UTC(2026, 4, 1); // 2026-05-01, muy anterior a "hoy"
const closes = Array.from({ length: 30 }, (_, i) => 195 + (i % 6));
closes[closes.length - 1] = 200;
const timestamps = closes.map((_, i) => (t0 + i * DAY) / 1000);

// ── canal SCREENER (tabla arena_screener en Neon, mutable por test) ──
// KO califica VALUE (P/E 18 < 20, ROE 40 > 15, deuda 0.5 < 1).
// HD califica MOMENTUM (150 > MA50 130 > MA200 110, +15.4% ≤ 30). El
// last_close 150 es STALE (1-2 días): NUNCA debe llegar a limit_price.
const srow = (o) => ({
  symbol: 'X', security_type: 'Common Stock',
  last_close: null, ma50: null, ma200: null,
  pe_ttm: null, ps_ttm: null, gross_margin: null, net_margin: null,
  debt_to_equity: null, roe_ttm: null, rev_growth_yoy: null,
  refreshed_at: '2026-07-27T00:00:00Z', ...o,
});
let screenerRows = [
  srow({ symbol: 'KO', pe_ttm: 18, roe_ttm: 40, debt_to_equity: 0.5 }),           // value
  srow({ symbol: 'HD', last_close: 150, ma50: 130, ma200: 110, pe_ttm: 60 }),     // momentum (precio STALE 150)
];
const SCREENER_FIELDS = ['symbol', 'security_type', 'last_close', 'ma50', 'ma200', 'pe_ttm', 'ps_ttm', 'gross_margin', 'net_margin', 'debt_to_equity', 'roe_ttm', 'rev_growth_yoy', 'refreshed_at'];

// ── fase 1 (SCAN): el SCOUT nombra AAPL como candidato ──
let scanText = JSON.stringify({
  scan_thesis: 'AAPL aparece en actives con earnings lejos; el resto del buffet es ruido de micro-caps.',
  candidates: ['AAPL'],
});
// ── fase 2 (DIVE): AAPL (scout) + HD (floor_reserved, screener/momentum) +
// FAKEZ (inventado, ni candidato — prueba que el guard sigue de backstop).
// KO (floor_reserved, value) se HOLDEA. HD @203 solo es válido contra el cierre
// FRESCO 200 (banda [196,204]); contra el stale 150 [147,153] se descartaría →
// que HD sea APROBADA es la prueba del candado de precio. ──
let diveText = JSON.stringify({
  plan: 'Primer día del libro: AAPL de calidad y HD que me trajo el screener de momentum; KO lo dejo en watch.',
  actions: [
    { symbol: 'AAPL', side: 'buy', notional: 10000, limit_price: 201, conviction: 4, reasoning: 'Fundamentales sólidos y recommendation buy-heavy.' },
    { symbol: 'HD', side: 'buy', notional: 8000, limit_price: 203, conviction: 3, reasoning: 'Momentum sano sobre MA50/MA200.' },
    { symbol: 'FAKEZ', side: 'buy', notional: 5000, limit_price: 10, conviction: 2, reasoning: 'Ticker que no existe.' },
  ],
});

const alpacaOrderPosts = [];
const journalInserts = [];
const journalUpdates = [];
const finnhubDiveCalls = []; // urls de deep dive (metric/profile2/recommendation/company-news)
let orderFilled = false;
let moversStatus = 200; // se flipa a 401 para probar fetch_errors del buffet
let positionsMock = []; // posiciones del libro (mutable: la atribución de portfolio lo usa)
let openOrdersMock = []; // órdenes abiertas del libro (mutable)

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
    if (u.endsWith('/v2/positions')) return jsonReply(positionsMock);
    if (u.includes('/v2/orders?')) return jsonReply(openOrdersMock);
    if (u.endsWith('/v2/orders') && method === 'POST') {
      const body = JSON.parse(opts.body);
      alpacaOrderPosts.push(body);
      return jsonReply({ id: 'ord-' + alpacaOrderPosts.length, status: 'accepted', ...body });
    }
    if (u.includes('/v2/orders/ord-')) {
      return jsonReply(orderFilled
        ? { id: 'ord-1', status: 'filled', filled_qty: '49', filled_avg_price: '200.55', filled_at: today + 'T13:30:05Z' }
        : { id: 'ord-1', status: 'accepted', filled_qty: '0', filled_avg_price: null, filled_at: null });
    }
    return jsonReply({ message: 'ruta alpaca inesperada: ' + u }, 404);
  }
  // Finnhub symbol map (guard) — con `type` (main #79): alimenta el gate de security_type.
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => [
        { symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
        { symbol: 'MSFT', description: 'MICROSOFT CORP', type: 'Common Stock' },
        { symbol: 'HD', description: 'HOME DEPOT INC', type: 'Common Stock' },
        { symbol: 'KO', description: 'COCA-COLA CO', type: 'Common Stock' },
        { symbol: 'NVDA', description: 'NVIDIA CORP', type: 'Common Stock' },
        { symbol: 'GNTX', description: 'GENTEX CORP', type: 'Common Stock' },
        { symbol: 'AXP', description: 'AMERICAN EXPRESS CO', type: 'Common Stock' },
      ] };
  }
  // Finnhub deep dive (fase 2a)
  if (u.includes('finnhub.io/api/v1/stock/metric')) {
    finnhubDiveCalls.push(u);
    return jsonReply({ metric: { peTTM: 30, psTTM: 8, netProfitMarginTTM: 25, grossMarginTTM: 44, 'totalDebt/totalEquityQuarterly': 1.5, currentRatioQuarterly: 1.1, beta: 1.2 } });
  }
  if (u.includes('finnhub.io/api/v1/stock/profile2')) {
    finnhubDiveCalls.push(u);
    return jsonReply({ name: 'Some Co', marketCapitalization: 3000000, finnhubIndustry: 'Technology', country: 'US' });
  }
  if (u.includes('finnhub.io/api/v1/stock/recommendation')) {
    finnhubDiveCalls.push(u);
    return jsonReply([{ period: '2026-07-01', strongBuy: 20, buy: 15, hold: 5, sell: 1, strongSell: 0 }]);
  }
  if (u.includes('finnhub.io/api/v1/company-news')) {
    finnhubDiveCalls.push(u);
    return jsonReply([
      { headline: 'Company beats earnings expectations', datetime: nowSec - DAY / 1000, source: 'Reuters' },
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
  // Neon
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body);
    const q = body.query || '';
    // Canal screener: el arena-run SOLO LEE arena_screener (readScreenerRows).
    if (q.includes('arena_screener')) {
      return jsonReply({
        fields: SCREENER_FIELDS.map((name) => ({ name, dataTypeID: 25 })),
        rows: screenerRows.map((r) => SCREENER_FIELDS.map((f) => (r[f] == null ? null : String(r[f])))),
      });
    }
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

// ── 1) run feliz: SCAN → FLOOR → deep dive → DIVE. AAPL (scout) + HD (floor)
// ejecutadas, KO (floor) holdeada, FAKEZ inventada descartada ──
console.log('arena-run: decide de dos fases + FLOOR del screener de punta a punta');
const r1 = await runArenaDecide({ baseUrl: BASE_URL });
ok(r1.status === 'ok' && r1.orders === 2, 'run ok con 2 órdenes (AAPL scout + HD floor)', JSON.stringify(r1));
ok(r1.discarded === 1, 'el símbolo inventado (FAKEZ) fue descartado, no ejecutado', JSON.stringify(r1));
ok(r1.candidates === 3, 'el slate final tiene 3 (AAPL del scout + KO/HD reservados por el floor)', JSON.stringify(r1));
ok(r1.floor === 'floor_applied', 'el floor se aplicó (el scout no eligió screener → se reservaron slots)', JSON.stringify(r1));

ok(alpacaOrderPosts.length === 2, 'exactamente dos órdenes llegaron a Alpaca');
const byS = Object.fromEntries(alpacaOrderPosts.map((o) => [o.symbol, o]));
ok(byS.AAPL && byS.AAPL.type === 'limit' && byS.AAPL.time_in_force === 'day', 'la orden es limit + day (regla de la casa)');
ok(byS.AAPL && byS.AAPL.qty === '49', 'qty entera AAPL floor(10000/201) = 49', JSON.stringify(byS.AAPL));
ok(byS.AAPL && byS.AAPL.client_order_id === `arena:${today}:AAPL:buy`, 'client_order_id determinista (idempotencia)', byS.AAPL && byS.AAPL.client_order_id);
// CANDADO: HD @203 solo cabe en la banda del cierre FRESCO 200 ([196,204]); con
// el precio STALE del screener (150 → [147,153]) se habría descartado. Que esté
// aprobada demuestra que el precio del screener NO llegó a la decisión.
ok(byS.HD && byS.HD.symbol === 'HD' && Number(byS.HD.limit_price) === 203 && byS.HD.qty === '39',
  'CANDADO: HD aprobada @203 (banda del cierre fresco 200), el stale 150 del screener no se usó', JSON.stringify(byS.HD));

ok(journalInserts.length === 1, 'una fila de journal por run');
const jrow = lastRow();
ok(jrow[COL.phase] === 'decide' && jrow[COL.status] === 'ok', 'journal: phase decide, status ok', jrow[COL.status]);
ok(jrow[COL.version] === PROMPT_VERSION && /^[0-9a-f]{64}$/.test(jrow[COL.hash] || ''), 'journal: versión v2 + hash sha256 del prompt del DIVE');
ok((jrow[COL.plan] || '').includes('Primer día'), 'journal: el plan del PM (del DIVE) se publica verbatim');
ok((jrow[COL.llm] || '').includes('FAKEZ'), 'journal: la respuesta COMPLETA del DIVE queda guardada');
const jactions = JSON.parse(jrow[COL.actions]);
const jFake = jactions.find((a) => a.symbol === 'FAKEZ');
const jAapl = jactions.find((a) => a.symbol === 'AAPL');
const jHd = jactions.find((a) => a.symbol === 'HD');
ok(jFake && jFake.result === 'discarded' && /symbol map/.test(jFake.reason), 'journal: descartada CON razón (guard de backstop)', JSON.stringify(jFake));
ok(jAapl && jAapl.result === 'approved' && jAapl.alpaca_order_id, 'journal: AAPL aprobada con su alpaca_order_id');
ok(jAapl && jAapl.security_type === 'Common Stock', 'journal: la aprobada lleva el security_type del symbol map (wiring type→guard→journal)', JSON.stringify(jAapl && jAapl.security_type));

// ── ATRIBUCIÓN de canal + origin (determinista, no confía en el LLM) ──
console.log('arena-run: atribución de canal + origin (scout_picked / floor_reserved)');
ok(jAapl && jAapl.origin === 'scout_picked', 'atribución: AAPL nació del scout → origin scout_picked', JSON.stringify(jAapl && jAapl.origin));
ok(jAapl && Array.isArray(jAapl.channels) && jAapl.channels.includes('movers') && jAapl.channels.includes('insider'),
  'atribución: AAPL viene de movers + insider (índice determinista del buffet)', JSON.stringify(jAapl && jAapl.channels));
ok(jHd && jHd.result === 'approved' && jHd.origin === 'floor_reserved', 'atribución: HD la forzó el floor → origin floor_reserved', JSON.stringify(jHd && jHd.origin));
ok(jHd && Array.isArray(jHd.channels) && jHd.channels.includes('screener') && Array.isArray(jHd.screens) && jHd.screens.includes('momentum'),
  'atribución: HD del canal screener, screen momentum', JSON.stringify(jHd && { channels: jHd.channels, screens: jHd.screens }));
ok(jHd && jHd.screener_qualifiers && jHd.screener_qualifiers.above_ma200 === true && jHd.screener_qualifiers.above_ma50_pct === 15.4,
  'atribución: HD llega con los qualifiers que lo calificaron (% sobre MA50, flag MA200)', JSON.stringify(jHd && jHd.screener_qualifiers));
ok(jHd && jHd.screener_qualifiers && !('last_close' in jHd.screener_qualifiers) && !('ma50' in jHd.screener_qualifiers) && !('price' in jHd.screener_qualifiers),
  'CANDADO: los qualifiers de HD NO exponen precio absoluto (solo ratios/%)', JSON.stringify(jHd && jHd.screener_qualifiers));

// ── context de dos fases: scan + floor + slate + dive journaleados ──
const jctx = JSON.parse(jrow[COL.context]);
ok(Array.isArray(jctx.unavailable) && jctx.unavailable.length === 0, 'journal: context.unavailable vacío cuando todo responde');
ok(jctx.fetch_errors && Object.keys(jctx.fetch_errors).length === 0, 'journal: context.fetch_errors vacío cuando todo entrega datos');
ok(jctx.scan && jctx.scan.prompt && jctx.scan.prompt.system.includes('SCOUT'), 'journal: context.scan.prompt guarda el system del SCOUT');
ok(Array.isArray(jctx.scan.candidates) && jctx.scan.candidates.length === 1 && jctx.scan.candidates[0] === 'AAPL', 'journal: context.scan.candidates son los picks CRUDOS del scout', JSON.stringify(jctx.scan.candidates));
ok(jctx.scan.floor && jctx.scan.floor.reason === 'floor_applied' && jctx.scan.floor.reserved.includes('KO') && jctx.scan.floor.reserved.includes('HD'),
  'journal: context.scan.floor documenta la reserva (reason + símbolos)', JSON.stringify(jctx.scan.floor));
ok(Array.isArray(jctx.scan.slate) && jctx.scan.slate.length === 3, 'journal: context.scan.slate es el slate final (scout + floor)', JSON.stringify(jctx.scan.slate));
const slateOrigin = Object.fromEntries(jctx.scan.slate.map((c) => [c.symbol, c.origin]));
ok(slateOrigin.AAPL === 'scout_picked' && slateOrigin.KO === 'floor_reserved' && slateOrigin.HD === 'floor_reserved',
  'journal: slate con origin por símbolo (AAPL scout, KO/HD floor)', JSON.stringify(slateOrigin));
ok(jctx.scan.thesis && jctx.scan.thesis.length > 0, 'journal: context.scan.thesis guardada');
ok(jctx.dive && jctx.dive.prompt && jctx.dive.prompt.system.includes('Claude PM'), 'journal: context.dive.prompt guarda el system del PM');
ok(/^[0-9a-f]{64}$/.test(jctx.scan.hash) && /^[0-9a-f]{64}$/.test(jctx.dive.hash), 'journal: hash sha256 por fase');

// ── deep dive de Finnhub journaleado (los 3 candidatos del slate) ──
ok(jctx.dive.finnhub && jctx.dive.finnhub.AAPL && jctx.dive.finnhub.KO && jctx.dive.finnhub.HD, 'journal: context.dive.finnhub trae los 3 candidatos del slate', JSON.stringify(Object.keys(jctx.dive.finnhub || {})));
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
ok(jctx.dive.shown_closes && jctx.dive.shown_closes.AAPL === 200 && jctx.dive.shown_closes.HD === 200,
  'journal: context.dive.shown_closes guarda el cierre mostrado por candidato', JSON.stringify(jctx.dive && jctx.dive.shown_closes));
ok(jctx.dive.shown_closes.HD === 200,
  'CANDADO: shown_closes.HD es el cierre FRESCO 200, no el stale 150 del screener', String(jctx.dive.shown_closes.HD));
const research = JSON.parse(jctx.dive.prompt.user.split('\n').find((l) => l.startsWith('[') && l.includes('"ticker"')));
const rAapl = research.find((x) => x.ticker === 'AAPL');
const rHd = research.find((x) => x.ticker === 'HD');
ok(rAapl && rAapl.last_close === 200, 'prompt DIVE: cada candidato lleva last_close (el MISMO contra el que valida el guard)', JSON.stringify(rAapl && rAapl.last_close));
ok(rAapl && rAapl.limit_range && rAapl.limit_range.low === 196 && rAapl.limit_range.high === 204, 'prompt DIVE: limit_range ±2% ya calculado (196–204 para cierre 200)', JSON.stringify(rAapl && rAapl.limit_range));
ok(rHd && rHd.last_close === 200 && rHd.limit_range.low === 196 && rHd.limit_range.high === 204,
  'CANDADO: el research de HD usa el cierre FRESCO 200 (banda 196–204), NO el stale 150', JSON.stringify(rHd && { last_close: rHd.last_close, limit_range: rHd.limit_range }));
ok(rHd && rHd.screener_qualifiers && !('last_close' in rHd.screener_qualifiers) && !('price' in rHd.screener_qualifiers),
  'CANDADO: los qualifiers del screener en el prompt del DIVE no traen precio (solo ratios)', JSON.stringify(rHd && rHd.screener_qualifiers));
ok(rHd && Array.isArray(rHd.channel) && rHd.channel.includes('screener') && Array.isArray(rHd.screen) && rHd.screen.includes('momentum'),
  'prompt DIVE: el research de HD trae su procedencia (channel + screen)', JSON.stringify(rHd && { channel: rHd.channel, screen: rHd.screen }));
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

// ── el SCAN prompt trae el canal screener (value + momentum) pero SIN VC ──
const scanBuffet = JSON.parse(jctx.scan.prompt.user.split('\n').find((l) => l.startsWith('{') && l.includes('"movers"')));
ok(scanBuffet.screener && Array.isArray(scanBuffet.screener.value) && scanBuffet.screener.value.some((c) => c.symbol === 'KO'),
  'prompt SCAN: el canal screener (value) llega al SCOUT con KO', JSON.stringify(scanBuffet.screener && scanBuffet.screener.value));
ok(scanBuffet.screener.momentum.some((c) => c.symbol === 'HD'),
  'prompt SCAN: el canal screener (momentum) llega con HD', JSON.stringify(scanBuffet.screener.momentum));
ok(!('vc_headlines' in scanBuffet) && !('vc' in scanBuffet),
  'prompt SCAN: las VC headlines salieron del buffet (empresas privadas, no comprables)', JSON.stringify(Object.keys(scanBuffet)));
// El índice de atribución y los diagnósticos NO viajan al prompt del LLM.
ok(!('channelsByTicker' in scanBuffet) && !('fetch_errors' in scanBuffet),
  'prompt SCAN: channelsByTicker/fetch_errors son internos, no van al prompt del LLM');

// ── 1b) un endpoint del buffet cae (401) → su error REAL queda journaleado ──
console.log('arena-run: fetch_errors del buffet en el journal (observabilidad)');
moversStatus = 401;
const insBefore = journalInserts.length;
const r1b = await runArenaDecide({ baseUrl: BASE_URL });
ok(journalInserts.length === insBefore + 1, 'run con endpoint caído igual journalea');
const ctxDown = JSON.parse(lastRow()[COL.context]);
ok(ctxDown.unavailable.includes('movers'), 'context.unavailable incluye el endpoint caído', JSON.stringify(ctxDown.unavailable));
ok(ctxDown.fetch_errors.movers === 'HTTP 401', 'context.fetch_errors trae el status HTTP real', JSON.stringify(ctxDown.fetch_errors));
ok(!ctxDown.unavailable.includes('screener'), 'el screener (Neon) sigue disponible aunque caiga un endpoint del buffet');
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

// ── 3a) el scout NO elige nada, pero el screener dispara → el FLOOR surfacea
// KO/HD. NO es ok_no_candidates: hay research y hasta una orden del canal. ──
console.log('arena-run: FLOOR surfacea el screener cuando el scout no lo elige');
scanText = JSON.stringify({ scan_thesis: 'El buffet de hoy es ruido; no elijo nada por mi cuenta.', candidates: [] });
diveText = JSON.stringify({ plan: 'El floor me trajo KO (value P/E 18, ROE 40). Entro chico y dejo HD en watch.', actions: [{ symbol: 'KO', side: 'buy', notional: 6000, limit_price: 199, conviction: 3, reasoning: 'Value sólido que el screener surfaceó.' }] });
const diveCallsBefore3a = finnhubDiveCalls.length;
const r3a = await runArenaDecide({ baseUrl: BASE_URL });
ok(r3a.status === 'ok' && r3a.orders === 1 && r3a.candidates === 2 && r3a.floor === 'floor_applied',
  'scout vacío + screener dispara → el FLOOR surfacea KO/HD (NO ok_no_candidates)', JSON.stringify(r3a));
ok(finnhubDiveCalls.length > diveCallsBefore3a, 'SÍ hubo deep dive: el floor produjo candidatos que investigar');
const j3a = lastRow();
const ctx3a = JSON.parse(j3a[COL.context]);
ok(ctx3a.scan.floor.reason === 'floor_applied' && ctx3a.scan.slate.every((c) => c.origin === 'floor_reserved'),
  'journal: todo el slate es floor_reserved (el scout no aportó nada)', JSON.stringify(ctx3a.scan.slate));
const jKo = JSON.parse(j3a[COL.actions]).find((a) => a.symbol === 'KO');
ok(jKo && jKo.result === 'approved' && jKo.origin === 'floor_reserved' && jKo.screens.includes('value'),
  'atribución: la orden KO nació del canal screener por el floor (origin floor_reserved, screen value)', JSON.stringify(jKo && { origin: jKo.origin, screens: jKo.screens }));

// ── 3b) scout vacío Y la tabla del screener VACÍA con el cron apagado
// (ARENA_SCREENER_ENABLED faltaba, el bug) → ok_no_candidates, pero el
// floor.reason NO debe ser no_qualifying_candidates (eso se leería como
// "ninguna acción calificó" cuando la verdad es "no hubo datos del canal"). ──
console.log('arena-run: scout vacío + tabla screener vacía y cron apagado → screener_disabled (no no_qualifying_candidates)');
screenerRows = []; // la tabla arena_screener no tiene NADA (el cron nunca corrió)
delete process.env.ARENA_SCREENER_ENABLED; // flag faltante: el caso exacto del bug
scanText = JSON.stringify({ scan_thesis: 'Todo el buffet es ruido de micro-caps hoy; nada amerita research.', candidates: [] });
const diveCallsBefore3b = finnhubDiveCalls.length;
const postsBefore3b = alpacaOrderPosts.length;
const r3b = await runArenaDecide({ baseUrl: BASE_URL });
ok(r3b.status === 'ok_no_candidates' && r3b.orders === 0 && r3b.candidates === 0 && r3b.floor === 'screener_disabled',
  'scan vacío + tabla vacía sin flag → ok_no_candidates con floor screener_disabled', JSON.stringify(r3b));
ok(finnhubDiveCalls.length === diveCallsBefore3b, 'NO se pegó a Finnhub deep dive cuando no hubo candidatos');
ok(alpacaOrderPosts.length === postsBefore3b, 'cero órdenes cuando no hubo candidatos');
const jNoCand = lastRow();
ok(jNoCand[COL.status] === 'ok_no_candidates' && (jNoCand[COL.plan] || '').includes('ruido'), 'journal: ok_no_candidates con la tesis del scout como plan');
const ctx3b = JSON.parse(jNoCand[COL.context]);
ok(ctx3b.scan.floor.reason === 'screener_disabled',
  'journal (fix del bug): floor.reason = screener_disabled, no no_qualifying_candidates cuando la tabla estaba vacía por flag faltante', JSON.stringify(ctx3b.scan.floor));
ok(ctx3b.scan.screener_state === 'disabled', 'journal: screener_state journaleado (disabled) para el post-mortem', ctx3b.scan.screener_state);
ok(ctx3b.dive === undefined, 'journal: sin fase dive cuando no hubo candidatos');

// ── 3c) misma tabla vacía pero con el cron PRENDIDO → screener_empty (el cron
// está encendido, simplemente aún no llenó): estado DISTINTO de disabled. ──
console.log('arena-run: tabla vacía con cron prendido → screener_empty (distinto de disabled)');
process.env.ARENA_SCREENER_ENABLED = '1';
const r3c = await runArenaDecide({ baseUrl: BASE_URL });
ok(r3c.status === 'ok_no_candidates' && r3c.floor === 'screener_empty', 'tabla vacía + flag prendido → floor screener_empty', JSON.stringify(r3c));
ok(JSON.parse(lastRow()[COL.context]).scan.screener_state === 'empty', 'journal: screener_state = empty con el cron prendido');
delete process.env.ARENA_SCREENER_ENABLED; // restaura el entorno del test

// ── 4) hay candidatos pero el DIVE holdea → ok_no_actions (distinto de #3b) ──
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

// ── 9) isLeveragedInverseETF: detecta ETPs, no confunde nombres reales ──
console.log('arena-run: isLeveragedInverseETF (lista curada, sin falsos positivos)');
ok(isLeveragedInverseETF('TSLL') && isLeveragedInverseETF('sqqq') && isLeveragedInverseETF(' SOXL '),
  'detecta leveraged/inverse (case/trim-insensible)');
ok(!isLeveragedInverseETF('NU') && !isLeveragedInverseETF('AAL') && !isLeveragedInverseETF('NOK') && !isLeveragedInverseETF('TSLA'),
  'NO marca nombres reales (NU, AAL, NOK, TSLA)');

// ── 10) atribución del canal PORTFOLIO: candidatos que vienen del LIBRO
// (holding u orden abierta), no del buffet, deben salir con channels ['portfolio']
// y NO con [] (bug 2026-07-27: AXP con orden abierta + GNTX holding → []). ──
console.log('arena-run: atribución del canal portfolio (holdings/órdenes abiertas del libro)');
positionsMock = [{ symbol: 'GNTX', qty: '50', avg_entry_price: '30', market_value: '1600', unrealized_plpc: '0.05' }];
openOrdersMock = [{ symbol: 'AXP', side: 'buy', qty: '10', limit_price: '326.17', status: 'accepted' }];
screenerRows = []; // aislar del floor
scanText = JSON.stringify({ scan_thesis: 'Reevalúo GNTX (holding) y AXP (orden abierta de la corrida previa).', candidates: ['GNTX', 'AXP'] });
diveText = JSON.stringify({ plan: 'Recorto GNTX y re-anclo AXP al precio de hoy.', actions: [
  { symbol: 'GNTX', side: 'sell', notional: 800, limit_price: 199, conviction: 3, reasoning: 'Tomo ganancia parcial del holding.' },
  { symbol: 'AXP', side: 'buy', notional: 6000, limit_price: 203, conviction: 4, reasoning: 'Re-anclo al cierre fresco de hoy.' },
] });
const rPf = await runArenaDecide({ baseUrl: BASE_URL });
ok(rPf.status === 'ok' && rPf.orders === 2, 'las dos acciones del libro se ejecutan', JSON.stringify(rPf));
const jPf = JSON.parse(lastRow()[COL.actions]);
const aGntx = jPf.find((a) => a.symbol === 'GNTX');
const aAxp = jPf.find((a) => a.symbol === 'AXP');
ok(aGntx && Array.isArray(aGntx.channels) && aGntx.channels.includes('portfolio'),
  'FIX: holding (GNTX) → channels incluye "portfolio", ya no []', JSON.stringify(aGntx && aGntx.channels));
ok(aAxp && Array.isArray(aAxp.channels) && aAxp.channels.includes('portfolio'),
  'FIX: orden abierta (AXP) → channels incluye "portfolio", ya no []', JSON.stringify(aAxp && aAxp.channels));
ok(aGntx && aGntx.channels.length > 0 && aAxp && aAxp.channels.length > 0,
  'ningún candidato del libro sale con channels vacío (atribución utilizable a 30 días)');
// El slate journalea el mismo canal en context.scan (auditar sin depender de la acción).
const ctxPf = JSON.parse(lastRow()[COL.context]);
ok(ctxPf.scan.slate.every((c) => c.origin === 'scout_picked'), 'slate: ambos son scout_picked (los eligió el scout del libro)', JSON.stringify(ctxPf.scan.slate));
positionsMock = []; openOrdersMock = []; // restaurar para no filtrar estado

// Regresión: un candidato que NO está ni en el buffet ni en el libro sigue con [] —
// [] ahora significa "pick sin anclar" (el scout lo inventó), no un bug de wiring.
console.log('arena-run: [] ahora es señal legítima (candidato sin anclar), no un canal perdido');
screenerRows = [];
// NVDA solo aparece en movers; con movers caído no está en ninguna sección del
// buffet, ni en earnings/insider, ni en el libro → debe quedar con [].
scanText = JSON.stringify({ scan_thesis: 'Pick sin anclar en ninguna fuente.', candidates: ['NVDA'] });
diveText = JSON.stringify({ plan: 'Compro NVDA.', actions: [{ symbol: 'NVDA', side: 'buy', notional: 5000, limit_price: 201, conviction: 3, reasoning: 'x' }] });
moversStatus = 401; // buffet de movers caído → NVDA no está en ninguna sección
const rUn = await runArenaDecide({ baseUrl: BASE_URL });
const aUn = JSON.parse(lastRow()[COL.actions]).find((a) => a.symbol === 'NVDA');
ok(aUn && Array.isArray(aUn.channels) && aUn.channels.length === 0, 'sin buffet ni libro → channels [] (señal de pick sin anclar, no bug de wiring)', JSON.stringify(aUn && aUn.channels));
moversStatus = 200; // restaurar

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
