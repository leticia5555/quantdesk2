// ═══════════════════════════════════════════════════════════════
// tests/arena-shadow.test.mjs — MODO SOMBRA (martes 15 → viernes 18).
//
// La liga corre COMPLETA y no manda una sola orden. Lo que esta suite protege:
//   1. La compuerta: env var + CADUCIDAD automática el día del relanzamiento.
//      La fecha gana sobre la env var — una variable olvidada en Vercel no
//      puede vaciar la temporada real.
//   2. La MISMA corrida, con y sin sombra: idéntica decisión, cero POST de
//      órdenes en sombra y N POST sin ella. Es la prueba de que la sombra
//      apaga el ENVÍO y nada más.
//   3. La red determinista (trailing/stop/breaker) también se suprime: corre
//      dentro del vigilante y dejarla viva sería media sombra.
//   4. `result:'shadow'` es un valor PROPIO: ni el reconstructor de posiciones
//      lo lee como un fill, ni el escalador de banda como un stop fallido.
//   5. El status `ok_shadow` no se colapsa en `ok_no_actions` (que diría que
//      el PM holdeó — mentira sobre lo único que el experimento mide).
//   6. Un broadcut en sombra NO deja al agente detenido: el halt es estado
//      persistente y sobreviviría al reset del lunes 21.
// Correr con `node tests/arena-shadow.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ALPACA_PAPER_KEY = 'PKTEST';
process.env.ALPACA_PAPER_SECRET = 'SECRETTEST';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.FINNHUB_API_KEY = 'fh-test';
process.env.ARENA_RELAUNCH_DATE = '2026-09-21';

const { shadowActive, shadowState, shadowUntilDate, shadowAction } = await import('../api/_lib/arena-shadow.js');
const { relaunchDate, relaunchId } = await import('../api/_lib/arena-relaunch.js');
const { runArenaDecide } = await import('../api/arena-run.js');
const { reconstructPositionOpens } = await import('../api/_lib/arena-memory.js');

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + JSON.stringify(detail) : ''); }
}

// ═══ A) LA COMPUERTA ═════════════════════════════════════════════════
console.log('sombra: la compuerta (env var + caducidad automática)');
{
  const MAR15 = new Date('2026-09-15T22:40:00Z');
  const VIE18 = new Date('2026-09-18T22:40:00Z');
  const LUN21 = new Date('2026-09-21T13:35:00Z');

  delete process.env.ARENA_SHADOW;
  ok(shadowActive(MAR15) === false, 'sin ARENA_ADOW=1 la sombra NO se enciende sola'.replace('ADOW', 'SHADOW'));

  process.env.ARENA_SHADOW = '1';
  ok(shadowActive(MAR15) === true, 'martes 15 → sombra');
  ok(shadowActive(VIE18) === true, 'viernes 18 → sombra');
  ok(shadowActive(LUN21) === false, 'lunes 21 → la sombra CADUCA SOLA, aunque la env var siga puesta');

  const st = shadowState(LUN21);
  ok(st.active === false && st.flag === true && st.expired === true,
    'el journal del día 21 distingue "caducó" de "nunca se encendió"', st);
  ok(shadowUntilDate() === relaunchDate() && relaunchDate() === '2026-09-21',
    'la fecha de corte SALE de la función del relanzamiento, no de una constante duplicada', [shadowUntilDate(), relaunchDate()]);
  ok(relaunchId() === 'arena-t2-relanzamiento-2026-09-21', 'y el id del corte se deriva de la misma fecha', relaunchId());

  // La env var de fecha manda: es la única forma de extender la sombra.
  process.env.ARENA_SHADOW_UNTIL = '2026-09-25';
  ok(shadowActive(LUN21) === true, 'ARENA_SHADOW_UNTIL extiende la sombra (decisión explícita, no un olvido)');
  delete process.env.ARENA_SHADOW_UNTIL;

  // La hora del corte es ET, no UTC: el lunes 21 a las 03:00 UTC en ET todavía
  // es domingo 20 → sombra. Si se comparara en UTC, la sombra se apagaría un
  // día antes en cada corrida nocturna.
  ok(shadowActive(new Date('2026-09-21T03:00:00Z')) === true,
    'el corte se compara en horario del ESTE, no en UTC');
}

// ═══ B) LA ACCIÓN SOMBRA no se confunde con un fill ══════════════════
console.log('sombra: `result:"shadow"` es un valor propio, no un fill ni un fallo');
{
  const a = shadowAction({ symbol: 'ADBE', side: 'buy', qty: 10, limit_price: 350, reasoning: 'tesis' }, { clientOrderId: 'arena:2026-09-16:ADBE:buy' });
  ok(a.result === 'shadow' && a.shadow === true, 'lleva su propio veredicto', a.result);
  ok(a.qty === 10 && a.limit_price === 350 && a.reasoning === 'tesis',
    'conserva TODO el detalle: el post-mortem tiene que poder leer qué habría hecho', a);
  ok(!a.alpaca_order_id, 'sin id de Alpaca: no existió del otro lado', a.alpaca_order_id);

  // El reconstructor de posiciones exige result:'approved' + order_status
  // 'filled'. Una acción sombra NO puede abrirle una posición fantasma al PM.
  const opens = reconstructPositionOpens([{ run_date: '2026-09-16', actions: [{ ...a, order_status: 'filled' }] }]);
  ok(!opens.ADBE, 'ni con order_status filled encima abre una posición: no es `approved`', opens);
}

// ═══ C) LA MISMA CORRIDA, CON Y SIN SOMBRA ═══════════════════════════
// Un solo mundo falso; se corre dos veces cambiando SOLO la env var.
const BASE_URL = 'http://qd.test';
const NOW = new Date('2026-09-16T22:40:00Z'); // miércoles 16, dentro de la sombra
const DAY = 86400000;
// Agosto: DESPUÉS de la fecha de apertura de MU (2 de julio) y antes de
// `NOW`. Si la serie terminara antes de la entrada, el pico quedaría sin
// ventana y el trailing no armaría — el test no probaría nada.
const t0 = Date.UTC(2026, 7, 1);

// Serie plana en 200 salvo el pico: MU entró a 100, tocó 130 (pico) y cerró en
// 118 → devolvió 9.2% desde el pico con el trailing ARMADO (+15% de ganancia).
// Eso dispara una salida determinista, que es lo que se quiere ver suprimida.
function serie(sym) {
  const closes = sym === 'MU'
    ? [...Array.from({ length: 28 }, (_, i) => 100 + i), 130, 118]
    : Array.from({ length: 30 }, (_, i) => (i === 29 ? 200 : 195 + (i % 6)));
  return { chart: { result: [{ timestamp: closes.map((_, i) => (t0 + i * DAY) / 1000), indicators: { quote: [{ close: closes }] } }] } };
}

const SCAN = JSON.stringify({ scan_thesis: 'AAPL en actives.', candidates: ['AAPL'] });
const DIVE = JSON.stringify({
  plan: 'Abro AAPL: el deep dive respalda la tesis y hay cash de sobra.',
  positions_review: [{ symbol: 'MU', stance: 'hold', reason: 'devolvió desde el pico pero la tesis aguanta' }],
  commitment_updates: [],
  commitments: [],
  actions: [{ symbol: 'AAPL', side: 'buy', notional: 10000, limit_price: 201, conviction: 4, reasoning: 'fundamentales sólidos' }],
});

let orderPosts = [];
let journalInserts = [];
let arenaState = { halted: false, halted_at: null, halted_reason: null, resumed_at: null };
const positions = [{ symbol: 'MU', qty: '10', avg_entry_price: '100', market_value: '1180', unrealized_plpc: '0.18' }];
// Fills históricos: sin fecha de apertura el pico no se acota y el trailing
// nunca armaría (fail-safe del T2 #3) — el test no probaría nada.
const FILLS = [{ run_date: '2026-07-02', actions: [{ symbol: 'MU', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 10, filled_avg_price: 100, filled_at: '2026-07-02T13:35:00Z' }] }];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const reply = (obj, status = 200) => ({
    ok: status < 300, status, headers: { get: () => 'application/json' },
    json: async () => obj, text: async () => JSON.stringify(obj),
  });

  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body || '{}');
    const sys = String(body.system || '');
    const text = sys.includes('TU VOZ:') ? 'Abro AAPL y aguanto MU.' : (sys.includes('SCOUT') ? SCAN : DIVE);
    return reply({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } });
  }
  if (u.includes('paper-api.alpaca.markets')) {
    if (u.endsWith('/v2/account')) return reply({ status: 'ACTIVE', equity: '100000', cash: '90000' });
    if (u.endsWith('/v2/positions')) return reply(positions);
    if (u.includes('/v2/orders?')) return reply([]);
    if (u.endsWith('/v2/orders') && method === 'POST') {
      const body = JSON.parse(opts.body);
      orderPosts.push(body);
      return reply({ id: 'ord-' + orderPosts.length, status: 'accepted', ...body });
    }
    return reply({ message: 'ruta inesperada ' + u }, 404);
  }
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return reply([{ symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' }, { symbol: 'MU', description: 'MICRON', type: 'Common Stock' }]);
  }
  if (u.includes('finnhub.io')) return reply(u.includes('recommendation') || u.includes('company-news') ? [] : {});
  if (u.includes('yahoo')) {
    const m = u.match(/\/chart\/([A-Z.]+)/i);
    return reply(serie(m ? m[1].toUpperCase() : 'X'));
  }
  if (u.startsWith(BASE_URL + '/api/movers')) return reply({ universe: 'market', gainers: [{ symbol: 'AAPL', price: 200, changePct: 3.1 }], losers: [], actives: [] });
  if (u.startsWith(BASE_URL + '/api/earnings')) return reply({ earnings: [] });
  if (u.startsWith(BASE_URL + '/api/stock-tracker')) return reply({ items: [] });
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body || '{}');
    const q = String(body.query || '');
    const table = (fields, rows) => reply({ fields: fields.map(([n, t]) => ({ name: n, dataTypeID: t })), rows });
    if (/from arena_state/i.test(q)) return table([['halted', 16], ['halted_at', 1184], ['halted_reason', 25], ['resumed_at', 1184]], [[arenaState.halted ? 't' : 'f', arenaState.halted_at, arenaState.halted_reason, arenaState.resumed_at]]);
    if (/update arena_state/i.test(q)) {
      if (/halted = true/.test(q)) { arenaState.halted = true; arenaState.halted_at = body.params[0]; arenaState.halted_reason = body.params[1]; }
      return table([], []);
    }
    if (/insert into arena_journal/i.test(q)) { journalInserts.push(body.params); return table([], []); }
    if (/max\(\(account/i.test(q)) return table([['peak', 1700]], [['100000']]);
    if (/actions from arena_journal/i.test(q) && /180 days/.test(q)) return table([['run_date', 25], ['actions', 3802]], FILLS.map((f) => [f.run_date, JSON.stringify(f.actions)]));
    return table([], []);
  }
  throw new Error('fetch inesperado: ' + u);
};

const COL = { status: 3, plan: 7, actions: 9, context: 12 };
const rowsByStatus = () => Object.fromEntries(journalInserts.map((p) => [p[COL.status], p]));
const reset = () => { orderPosts = []; journalInserts = []; arenaState = { halted: false, halted_at: null, halted_reason: null, resumed_at: null }; };

// ── C1) SIN sombra: el control. Tienen que salir órdenes. ──
console.log('\nsombra: la corrida de CONTROL (sombra apagada) sí manda órdenes');
delete process.env.ARENA_SHADOW;
reset();
const real = await runArenaDecide({ baseUrl: BASE_URL, now: NOW });
const realStatuses = Object.keys(rowsByStatus());
ok(orderPosts.length === 2, 'salen 2 órdenes: la compra del PM (AAPL) y el trailing de MU', orderPosts.map((o) => o.symbol + ':' + o.side));
ok(real.status === 'ok' && real.orders === 2, 'status ok con las 2 órdenes contadas', real);
ok(realStatuses.includes('risk_exit') && realStatuses.includes('ok'), 'journal: una fila risk_exit y una fila ok', realStatuses);

// ── C2) CON sombra: misma decisión, cero envío. ──
console.log('\nsombra: la MISMA corrida en sombra decide igual y no manda nada');
process.env.ARENA_SHADOW = '1';
reset();
const shade = await runArenaDecide({ baseUrl: BASE_URL, now: NOW });

ok(orderPosts.length === 0, 'CERO POST a /v2/orders', orderPosts);
ok(shade.status === 'ok_shadow', 'status propio `ok_shadow` (no `ok_no_actions`: el PM sí decidió operar)', shade.status);
ok(shade.orders === 0 && shade.shadow === true && shade.shadow_suppressed === 2,
  '`orders` sigue significando "órdenes que salieron" (0) y lo retenido se cuenta aparte (2)', shade);
ok(shade.approved === real.approved && shade.candidates === real.candidates,
  'la DECISIÓN es la misma que sin sombra: mismos candidatos, mismas aprobadas', [shade.approved, real.approved]);
ok(shade.headline === real.headline, 'el titular se escribe igual (la voz no depende del envío)', shade.headline);

const byStatus = rowsByStatus();
ok(!!byStatus.ok_shadow && !!byStatus.risk_exit_shadow, 'journal: filas `ok_shadow` y `risk_exit_shadow`', Object.keys(byStatus));
ok(!byStatus.ok && !byStatus.risk_exit, 'y NINGUNA fila con el status de una corrida real', Object.keys(byStatus));

// El plan (la prosa que se publica) se journalea completo: es lo que se lee al
// día siguiente para saber qué habría hecho cada libro.
ok(/Abro AAPL/.test(byStatus.ok_shadow[COL.plan]), 'el plan del PM se guarda verbatim, igual que siempre', byStatus.ok_shadow[COL.plan]);

const acciones = JSON.parse(byStatus.ok_shadow[COL.actions]);
const aapl = acciones.find((a) => a.symbol === 'AAPL');
ok(aapl.result === 'shadow' && aapl.qty > 0 && aapl.limit_price === 201,
  'la acción del PM queda journaleada con qty y límite reales, marcada `shadow`', aapl);
ok(Array.isArray(aapl.channels) && aapl.channels.length > 0,
  'y con su atribución de canal intacta (el post-mortem de la semana de ensayo sirve)', aapl.channels);

const ctx = JSON.parse(byStatus.ok_shadow[COL.context]);
ok(ctx.shadow && ctx.shadow.active === true && ctx.shadow.until === '2026-09-21',
  'el context lleva el bloque de sombra con su fecha de caducidad', ctx.shadow);

const riskActions = JSON.parse(byStatus.risk_exit_shadow[COL.actions]);
ok(riskActions[0].result === 'shadow' && riskActions[0].symbol === 'MU',
  'la salida determinista (trailing de MU) también se suprime: no es media sombra', riskActions[0]);
ok(/MODO SOMBRA/.test(byStatus.risk_exit_shadow[COL.plan]), 'y su plan lo dice en voz alta', byStatus.risk_exit_shadow[COL.plan]);

// ── C3) un broadcut en sombra NO entierra al agente ──
console.log('\nsombra: un broadcut de la semana de ensayo no deja al agente detenido');
reset();
// Pico journaleado de 130k contra un equity de 100k → drawdown 23% → broadcut.
const savedFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body || '{}');
    if (/max\(\(account/i.test(String(body.query || ''))) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ fields: [{ name: 'peak', dataTypeID: 1700 }], rows: [['130000']] }), text: async () => '' };
    }
  }
  return savedFetch(url, opts);
};
const bc = await runArenaDecide({ baseUrl: BASE_URL, now: NOW });
globalThis.fetch = savedFetch;
ok(bc.status === 'risk_broad_cut_shadow', 'el corte amplio se journalea con su status de sombra', bc.status);
ok(bc.halted === false && arenaState.halted === false,
  'el agente NO queda detenido: un halt de sombra sobreviviría al reset del lunes 21', [bc.halted, arenaState.halted]);
ok(orderPosts.length === 0, 'y la liquidación tampoco se envía', orderPosts);

console.log(failures ? `\n${failures} FALLARON` : '\nTODO EN VERDE');
process.exit(failures ? 1 : 0);
