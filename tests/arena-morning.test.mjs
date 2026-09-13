// ═══════════════════════════════════════════════════════════════
// tests/arena-morning.test.mjs — CORRIDA MATUTINA POR EVENTO (T2 #7).
//
// De punta a punta con TODO el I/O mockeado a nivel fetch, como arena-liga.
// Lo que esta suite protege (y que ninguna otra puede):
//   - SIN evento no se gasta NADA: cero llamadas al LLM, cero órdenes, y UNA
//     fila marcadora de liga que deja auditable que la corrida sí ocurrió.
//   - CON evento: se salta el SCOUT (el evento ya define el slate), el DIVE
//     recibe el encuadre del evento, y las COMPRAS se suprimen — la corrida
//     existe para decidir sobre lo que ya se tiene, no para operar más seguido.
//   - La red determinista NO se re-evalúa a media mañana (decide con cierres
//     completos; repetirla duplicaría las órdenes de la corrida de anoche).
// Correr con `node tests/arena-morning.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.ALPACA_PAPER_KEY = 'PK_CLAUDE'; process.env.ALPACA_PAPER_SECRET = 'S_CLAUDE';
process.env.FINNHUB_API_KEY = 'fh-test';
process.env.ARENA_LEAGUE = 'claude';   // un solo agente: el foco es el flujo, no la liga
delete process.env.ARENA_SCREENER_ENABLED;

import { runArenaMorning } from '../api/arena-run.js';
import { ARENA_RULES } from '../api/_lib/arena-guard.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const BASE_URL = 'http://qd.test';
const DAY = 86400000;
// RELOJ FIJO: miércoles 2026-09-16 a las 14:50 UTC — la hora exacta del cron
// matutino, con el mercado abierto. La ventana de disparo depende del día de la
// semana (un viernes AMC "reprecia" recién el lunes), así que el test NO puede
// depender del día en que corra: se inyecta `now`.
const NOW = new Date('2026-09-16T14:50:00Z');
const today = '2026-09-16';
const prevSession = '2026-09-15'; // martes: su AMC reprecia en el open de HOY

const t0 = Date.UTC(2026, 4, 1);
const closes = Array.from({ length: 40 }, (_, i) => 195 + (i % 6));
closes[closes.length - 1] = 200;
const timestamps = closes.map((_, i) => (t0 + i * DAY) / 1000);

// El PM sale de NVDA (el nombre que reportó) e intenta comprar AAPL: la compra
// debe morir en la supresión de la corrida por evento, no en el guard.
const DIVE = JSON.stringify({
  plan: 'NVDA reportó por debajo del estimado; cierro la posición y no abro nada nuevo.',
  positions_review: [{ symbol: 'NVDA', stance: 'exit', reason: 'el reporte invalida la tesis con la que entré' }],
  commitments: [{ symbol: 'NVDA', text: 'no volver a NVDA hasta el próximo trimestre', due: null }],
  commitment_updates: [],
  actions: [
    { symbol: 'NVDA', side: 'sell', notional: 4000, limit_price: 200, conviction: 5, reasoning: 'salgo por el reporte' },
    { symbol: 'AAPL', side: 'buy', notional: 5000, limit_price: 201, conviction: 3, reasoning: 'me gusta el setup' },
  ],
});

// Telemetría del mock.
let llmCalls = [];            // { phase }
let orderPosts = [];          // cuerpos enviados a Alpaca
let journalInserts = [];      // params de cada insert
let earningsCalendar = [];
let positionsMock = [];
let calendarSessions = [{ date: today, open: '09:30', close: '16:00' }];

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const jsonReply = (obj, status = 200) => ({
    ok: status < 300, status,
    headers: { get: () => 'application/json' },
    json: async () => obj, text: async () => JSON.stringify(obj),
  });

  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body || '{}');
    const phase = String(body.system || '').includes('SCOUT') ? 'scan' : 'dive';
    llmCalls.push({ phase, maxTokens: body.max_tokens, user: String(body.messages[0].content) });
    return jsonReply({ content: [{ type: 'text', text: DIVE }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } });
  }
  if (u.includes('paper-api.alpaca.markets')) {
    if (u.includes('/v2/calendar')) return jsonReply(calendarSessions);
    if (u.endsWith('/v2/account')) return jsonReply({ status: 'ACTIVE', equity: '100000', cash: '40000' });
    if (u.endsWith('/v2/positions')) return jsonReply(positionsMock);
    if (u.includes('/v2/orders?')) return jsonReply([]);
    if (u.endsWith('/v2/orders') && method === 'POST') {
      const body = JSON.parse(opts.body);
      orderPosts.push(body);
      return jsonReply({ id: 'ord-' + orderPosts.length, status: 'accepted', ...body });
    }
    return jsonReply({ message: 'ruta alpaca inesperada: ' + u }, 404);
  }
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return jsonReply([
      { symbol: 'NVDA', description: 'NVIDIA CORP', type: 'Common Stock' },
      { symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
    ]);
  }
  if (u.includes('finnhub.io/api/v1/stock/metric')) return jsonReply({ metric: { peTTM: 30 } });
  if (u.includes('finnhub.io/api/v1/stock/profile2')) return jsonReply({ name: 'Nvidia', marketCapitalization: 3000000 });
  if (u.includes('finnhub.io/api/v1/stock/recommendation')) return jsonReply([{ period: '2026-08-01', strongBuy: 10, buy: 5, hold: 2, sell: 0, strongSell: 0 }]);
  if (u.includes('finnhub.io/api/v1/company-news')) return jsonReply([]);
  if (u.includes('yahoo')) return jsonReply({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] } });
  if (u.startsWith(BASE_URL + '/api/earnings')) return jsonReply({ earnings: earningsCalendar });
  if (u.startsWith(BASE_URL + '/api/movers') || u.startsWith(BASE_URL + '/api/stock-tracker')) {
    throw new Error('la corrida por evento NO debe pedir el buffet: ' + u);
  }
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body);
    const q = body.query || '';
    if (q.includes('from arena_state')) return jsonReply({
      fields: [{ name: 'halted', dataTypeID: 16 }, { name: 'halted_at', dataTypeID: 1184 }, { name: 'halted_reason', dataTypeID: 25 }, { name: 'resumed_at', dataTypeID: 1184 }],
      rows: [['f', null, null, null]] });
    if (q.includes('insert into arena_journal')) { journalInserts.push(body.params); return jsonReply({ fields: [], rows: [] }); }
    return jsonReply({ fields: [], rows: [] });
  }
  throw new Error('fetch inesperado en el test: ' + u);
};

const reset = () => { llmCalls = []; orderPosts = []; journalInserts = []; };
// Índices de columnas del insert estándar de arena_journal.
const COL = { status: 3, plan: 7, actions: 9, context: 12, agent: 13 };
const filas = () => journalInserts.filter((p) => p.length === 14);

// ── 1) SIN evento: nadie del libro reportó ──────────────────────────
console.log('matutina: sin evento post-earnings no se gasta nada');
{
  reset();
  positionsMock = [{ symbol: 'NVDA', qty: '20', avg_entry_price: '150', market_value: '4000', current_price: '200', unrealized_plpc: '0.33' }];
  earningsCalendar = [{ ticker: 'MSFT', company: 'Microsoft', date: prevSession, time: 'AMC' }]; // reportó, pero no está en el libro
  const r = await runArenaMorning({ baseUrl: BASE_URL, now: NOW });

  ok(r.status === 'skipped_no_post_earnings_event', 'la corrida sale por el gate de "sin evento"', r.status);
  ok(llmCalls.length === 0, 'CERO llamadas al LLM: sin evento no se gasta un token', String(llmCalls.length));
  ok(orderPosts.length === 0, 'CERO órdenes', String(orderPosts.length));
  const marca = filas().filter((p) => p[COL.status] === 'skipped_no_post_earnings_event');
  ok(marca.length === 1 && marca[0][COL.agent] === 'league',
    'UNA fila marcadora de liga (no una por agente): "no hubo evento" es un hecho de la liga', JSON.stringify(marca.map((p) => p[COL.agent])));
  const ctx = JSON.parse(marca[0][COL.context]);
  ok(ctx.trigger === 'post_earnings_morning' && ctx.reported.includes('MSFT'),
    'la fila deja auditable QUÉ reportó y por qué no se operó (MSFT reportó, pero no está en el libro)', JSON.stringify(ctx.reported));
}

// ── 2) CON evento: una posición del libro acaba de reportar ─────────
console.log('matutina: una posición del libro reportó → corrida por evento');
{
  reset();
  positionsMock = [{ symbol: 'NVDA', qty: '20', avg_entry_price: '150', market_value: '4000', current_price: '200', unrealized_plpc: '0.33' }];
  earningsCalendar = [{ ticker: 'NVDA', company: 'Nvidia Corp', date: prevSession, time: 'AMC', eps_est: 1.0, eps_actual: 0.9 }];
  const r = await runArenaMorning({ baseUrl: BASE_URL, now: NOW });

  ok(r.status === 'ok' && r.agents.length === 1 && r.agents[0].id === 'claude',
    'corre SOLO el agente que tiene el nombre en su libro', JSON.stringify(r.agents && r.agents.map((a) => a.id)));
  ok(r.agents[0].trigger === 'post_earnings_morning' && r.agents[0].status === 'ok',
    'la corrida se marca como disparada por evento', JSON.stringify(r.agents[0]));

  // El SCOUT no corre: el evento ya eligió el slate.
  ok(llmCalls.length === 1 && llmCalls[0].phase === 'dive',
    'UNA sola llamada al LLM y es el DIVE: el SCOUT no se paga para elegir lo que el evento ya eligió', JSON.stringify(llmCalls.map((c) => c.phase)));
  ok(/EVENT-DRIVEN MORNING RUN/.test(llmCalls[0].user) && /NVDA/.test(llmCalls[0].user),
    'el prompt del DIVE llega con el encuadre del evento y el nombre que reportó');

  // La venta se ejecuta MARKETABLE (T2 #5); la compra se suprime (T2 #7).
  ok(orderPosts.length === 1 && orderPosts[0].symbol === 'NVDA' && orderPosts[0].side === 'sell',
    'la ÚNICA orden enviada es la venta de la posición que reportó', JSON.stringify(orderPosts));
  ok(Number(orderPosts[0].limit_price) === +(200 * (1 - ARENA_RULES.discretionary_sell_band)).toFixed(2),
    'y sale a marketable limit (cierre 200 × (1 − banda)), no a un límite pasivo que expire', JSON.stringify(orderPosts[0]));
  ok(orderPosts[0].type === 'limit' && orderPosts[0].time_in_force === 'day',
    'sigue siendo una orden LÍMITE day (regla de la casa: jamás market orders)');

  const fila = filas().find((p) => p[COL.status] === 'ok');
  const acciones = JSON.parse(fila[COL.actions]);
  const aapl = acciones.find((a) => a.symbol === 'AAPL');
  ok(aapl && aapl.result === 'discarded' && /corrida por evento/.test(aapl.reason),
    'la COMPRA se descarta con razón explícita: la corrida por evento no abre riesgo nuevo', JSON.stringify(aapl));

  const ctx = JSON.parse(fila[COL.context]);
  ok(ctx.event && ctx.event.type === 'post_earnings_morning' && ctx.event.symbols.includes('NVDA'),
    'el journal guarda el evento que disparó la corrida', JSON.stringify(ctx.event));
  ok(ctx.scan && ctx.scan.skipped === 'post_earnings_event' && !ctx.scan.prompt,
    'el journal dice explícitamente que la fase SCAN se saltó (no que falló)', JSON.stringify(ctx.scan));
  ok(ctx.risk && ctx.risk.skipped && ctx.risk.approved.length === 0,
    'la red determinista NO se re-evalúa a media mañana (evita duplicar las órdenes de anoche)', JSON.stringify(ctx.risk.skipped));
  ok(ctx.positions_review.length === 1 && ctx.positions_review[0].stance === 'exit',
    'el pronunciamiento por posición queda journaleado', JSON.stringify(ctx.positions_review));
  ok(ctx.position_review_audit.missing.length === 0 && ctx.position_review_audit.required === 1,
    'y auditado contra los nombres del evento (no contra el libro entero: es una reacción, no la revisión diaria)',
    JSON.stringify(ctx.position_review_audit));
  ok(ctx.commitments.created.length === 1 && /no volver a NVDA/.test(ctx.commitments.created[0].text),
    'lo que el PM promete hoy queda guardado con id y fecha para la corrida siguiente', JSON.stringify(ctx.commitments.created));
}

// ── 3) mercado cerrado: ni el calendario de earnings se consulta ────
console.log('matutina: festivo → no hay open al que reaccionar');
{
  reset();
  const saved = calendarSessions;
  calendarSessions = [];
  const r = await runArenaMorning({ baseUrl: BASE_URL, now: NOW });
  calendarSessions = saved;
  ok(r.status === 'skipped_market_closed' && llmCalls.length === 0 && orderPosts.length === 0,
    'mercado cerrado → skip global, cero LLM, cero órdenes', JSON.stringify({ s: r.status, llm: llmCalls.length }));
  const marca = filas().filter((p) => p[COL.status] === 'skipped_market_closed');
  ok(marca.length === 1 && marca[0][COL.agent] === 'league', 'una sola fila marcadora de liga', String(marca.length));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
