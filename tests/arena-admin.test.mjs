// ═══════════════════════════════════════════════════════════════
// tests/arena-admin.test.mjs — /api/arena-admin, el endpoint que Lety dispara
// a mano. Lo que esta suite protege:
//   1. FAIL CLOSED: sin ARENA_ADMIN_KEY el endpoint no existe (503), nunca
//      "abierto porque falta la variable".
//   2. La key va por HEADER. Mandarla por query NO autentica — un secret en la
//      URL queda en los logs de Vercel y en el historial de la shell.
//   3. GET es ENSAYO: lista y NO manda un solo DELETE. POST cancela.
//   4. Recorre las SIETE cuentas del registry, no las `activeAgents()`: un
//      agente apagado por ARENA_LEAGUE igual tiene órdenes vivas que limpiar.
//   5. Una cuenta sin keys o con Alpaca caída se REPORTA y no tumba a las otras.
//   6. Un 422 de Alpaca (la orden llenó entre el listado y el DELETE) NO es un
//      fallo: el objetivo —que no quede abierta— se cumplió igual.
//   7. La ejecución real deja rastro: una fila de liga en el journal.
// Correr con `node tests/arena-admin.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ARENA_ADMIN_KEY = 'llave-de-lety';
// Las SIETE cuentas menos una: `qwen` se queda SIN keys a propósito, para
// probar que se reporta en vez de romper la limpieza de las otras seis.
for (const a of ['PAPER', 'OPENAI', 'CONTROL', 'GROK', 'GEMINI', 'DEEPSEEK']) {
  process.env['ALPACA_' + a + '_KEY'] = 'PK_' + a;
  process.env['ALPACA_' + a + '_SECRET'] = 'S_' + a;
}
delete process.env.ALPACA_QWEN_KEY;
delete process.env.ALPACA_QWEN_SECRET;

const { default: handler, cancelOpenOrders } = await import('../api/arena-admin.js');
const { ARENA_AGENTS } = await import('../api/_lib/arena-registry.js');

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + JSON.stringify(detail) : ''); }
}

// ── el mundo falso: Alpaca (7 cuentas) + Neon ────────────────────────
let deletes = [];       // cada DELETE /v2/orders/<id> que se emitió
let journalRows = [];   // filas insertadas en arena_journal

// Órdenes abiertas por cuenta, identificadas por la KEY (cada agente tiene la
// suya). `GEMINI` trae una orden que ya no es cancelable (422 al borrar).
const OPEN_BY_KEY = {
  PK_PAPER: [{ id: 'o-claude-1', symbol: 'ADBE', side: 'buy', qty: '10', limit_price: '350.10', status: 'new', client_order_id: 'arena:2026-09-14:ADBE:buy' }],
  PK_OPENAI: [],
  PK_CONTROL: [
    { id: 'o-ctrl-1', symbol: 'ORCL', side: 'buy', qty: '5', limit_price: '190.00', status: 'new' },
    { id: 'o-ctrl-2', symbol: 'ZM', side: 'sell', qty: '3', limit_price: '95.50', status: 'accepted' },
  ],
  PK_GROK: [{ id: 'o-grok-1', symbol: 'DDDX', side: 'buy', qty: '1000', limit_price: '0.01', status: 'new' }],
  PK_GEMINI: [{ id: 'o-gem-422', symbol: 'ADBE', side: 'buy', qty: '2', limit_price: '351.00', status: 'new' }],
  PK_DEEPSEEK: null,   // null = Alpaca caída para esta cuenta (el listado lanza)
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const reply = (obj, status = 200) => ({
    ok: status < 300, status,
    headers: { get: () => 'application/json' },
    json: async () => obj, text: async () => (obj == null ? '' : JSON.stringify(obj)),
  });

  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body || '{}');
    const run = (q, params) => {
      if (/^\s*insert into arena_journal/i.test(String(q || ''))) journalRows.push(params);
      return { fields: [], rows: [] };
    };
    if (body.queries) return reply({ results: body.queries.map((x) => run(x.query, x.params)) });
    return reply(run(body.query, body.params));
  }

  if (u.includes('paper-api.alpaca.markets')) {
    const key = (opts.headers || {})['APCA-API-KEY-ID'];
    if (method === 'GET' && u.includes('/v2/orders?')) {
      const open = OPEN_BY_KEY[key];
      if (open === null) return reply({ message: 'service unavailable' }, 503);
      return reply(open || []);
    }
    if (method === 'DELETE' && u.includes('/v2/orders/')) {
      const id = decodeURIComponent(u.split('/v2/orders/')[1]);
      deletes.push({ key, id });
      // La orden de gemini llenó entre el listado y el DELETE.
      if (id === 'o-gem-422') return reply({ message: 'order is not cancelable' }, 422);
      return reply(null, 204);
    }
  }
  throw new Error('fetch no esperado en el test: ' + method + ' ' + u);
};

// req/res mínimos, al estilo de los handlers de Vercel.
function mkRes() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const call = async (req) => { const res = mkRes(); await handler(req, res); return res; };
const reset = () => { deletes = []; journalRows = []; };

const BEARER = { authorization: 'Bearer llave-de-lety' };

// ═══ 1. FAIL CLOSED ══════════════════════════════════════════════════
console.log('arena-admin: sin ARENA_ADMIN_KEY el endpoint está CERRADO');
{
  const saved = process.env.ARENA_ADMIN_KEY;
  delete process.env.ARENA_ADMIN_KEY;
  reset();
  const res = await call({ method: 'POST', headers: BEARER, query: { action: 'cancel_open_orders' } });
  ok(res.code === 503, 'sin la variable → 503, no un endpoint abierto', res.code);
  ok(deletes.length === 0, 'y cero DELETE emitidos', deletes.length);
  process.env.ARENA_ADMIN_KEY = saved;
}

// ═══ 2. la key va por HEADER, nunca por query ════════════════════════
console.log('arena-admin: autenticación por header, no por URL');
{
  reset();
  const malo = await call({ method: 'POST', headers: { authorization: 'Bearer otra-cosa' }, query: { action: 'cancel_open_orders' } });
  ok(malo.code === 401, 'key equivocada → 401', malo.code);

  const porQuery = await call({ method: 'POST', headers: {}, query: { action: 'cancel_open_orders', key: 'llave-de-lety' } });
  ok(porQuery.code === 401, 'key en la QUERY → 401 (el secret no viaja en la URL)', porQuery.code);

  const sinNada = await call({ method: 'POST', headers: {}, query: { action: 'cancel_open_orders' } });
  ok(sinNada.code === 401, 'sin key → 401', sinNada.code);

  const alterno = await call({ method: 'GET', headers: { 'x-arena-admin-key': 'llave-de-lety' }, query: { action: 'cancel_open_orders' } });
  ok(alterno.code === 200, 'el header alterno x-arena-admin-key también sirve', alterno.code);
  ok(deletes.length === 0, 'ninguno de los cuatro canceló nada', deletes.length);
}

// ═══ 3. acción desconocida ═══════════════════════════════════════════
console.log('arena-admin: una acción que no existe no es un no-op silencioso');
{
  reset();
  const res = await call({ method: 'POST', headers: BEARER, query: { action: 'borrar_todo' } });
  ok(res.code === 400 && Array.isArray(res.body.acciones), 'acción desconocida → 400 con la lista de las válidas', res.body);
}

// ═══ 4. GET = ENSAYO ═════════════════════════════════════════════════
console.log('arena-admin: GET lista y NO cancela');
{
  reset();
  const res = await call({ method: 'GET', headers: BEARER, query: { action: 'cancel_open_orders' } });
  ok(res.code === 200 && res.body.dry === true, 'GET responde en modo ensayo', res.body && res.body.dry);
  ok(deletes.length === 0, 'cero DELETE a Alpaca en el ensayo', deletes.length);
  ok(journalRows.length === 0, 'y cero filas de journal: no pasó nada que registrar', journalRows.length);
  ok(res.body.totals.open === 5, 'cuenta las 5 órdenes abiertas que sí se pudieron listar', res.body.totals);
  ok(/-X POST/.test(res.body.curl || ''), 'devuelve el curl exacto del POST para no tener que recordarlo', res.body.curl);
  const claude = res.body.cuentas.find((c) => c.agent === 'claude');
  ok(claude.orders[0].symbol === 'ADBE' && claude.orders[0].id === 'o-claude-1', 'el ensayo enseña QUÉ se cancelaría, con símbolo e id', claude.orders[0]);
}

// ═══ 5. POST cancela en las SIETE cuentas ════════════════════════════
console.log('arena-admin: POST cancela de verdad, cuenta por cuenta');
{
  reset();
  const res = await call({ method: 'POST', headers: BEARER, query: { action: 'cancel_open_orders' } });
  ok(res.code === 200 && res.body.dry === false, 'POST ejecuta', res.code);
  ok(res.body.cuentas.length === ARENA_AGENTS.length && ARENA_AGENTS.length === 7,
    'se recorren las SIETE cuentas del registry (no solo las activas)', res.body.cuentas.length);

  ok(deletes.length === 5, 'un DELETE por cada orden abierta listada', deletes.map((d) => d.id));
  // Cada DELETE viaja con las creds de SU cuenta: cancelar el libro de uno con
  // las keys de otro es el error que este assert impide para siempre.
  const porCuenta = Object.fromEntries(deletes.map((d) => [d.id, d.key]));
  ok(porCuenta['o-claude-1'] === 'PK_PAPER' && porCuenta['o-ctrl-1'] === 'PK_CONTROL' && porCuenta['o-grok-1'] === 'PK_GROK',
    'cada orden se cancela con las keys de SU propia cuenta', porCuenta);

  const by = Object.fromEntries(res.body.cuentas.map((c) => [c.agent, c]));
  ok(by.claude.canceled === 1 && by.control.canceled === 2, 'claude 1 y control 2 canceladas', [by.claude.canceled, by.control.canceled]);
  ok(by.openai.status === 'sin_ordenes_abiertas', 'una cuenta limpia se reporta como tal, no como error', by.openai.status);
  ok(by.qwen.status === 'sin_keys' && by.qwen.canceled === 0, 'la cuenta sin keys se reporta y no rompe nada', by.qwen);
  ok(by.deepseek.status === 'error_listado' && by.deepseek.open === null,
    'Alpaca caída en una cuenta → error visible y `open:null` (hueco honesto, no un cero inventado)', by.deepseek);
  ok(by.gemini.orders[0].result === 'ya_no_cancelable' && by.gemini.failed === 0,
    'un 422 (la orden llenó en el ínterin) no cuenta como fallo: ya no está abierta', by.gemini);
  ok(res.body.totals.canceled === 4 && res.body.totals.failed === 0, 'totales: 4 canceladas, 0 fallidas', res.body.totals);
}

// ═══ 6. rastro ═══════════════════════════════════════════════════════
console.log('arena-admin: la ejecución real deja rastro en el journal');
{
  reset();
  await call({ method: 'POST', headers: BEARER, query: { action: 'cancel_open_orders' } });
  ok(journalRows.length === 1, 'UNA fila, no una por cuenta', journalRows.length);
  const [id, , plan, ctx, agentId] = [journalRows[0][0], journalRows[0][1], journalRows[0][2], journalRows[0][3], undefined];
  ok(/^arena-admin-cancel-/.test(id), 'id fechado y propio de la acción', id);
  ok(/cancelación manual/i.test(plan) && /Canceladas: 4/.test(plan), 'el plan dice qué se hizo, en números', plan);
  const parsed = JSON.parse(ctx);
  ok(parsed.cuentas.length === 7 && parsed.totals.canceled === 4, 'el context guarda el detalle por cuenta', parsed.totals);
}

// ═══ 7. la función pura, sin handler ═════════════════════════════════
console.log('arena-admin: cancelOpenOrders es llamable sola (para un script o un test)');
{
  reset();
  const r = await cancelOpenOrders({ dry: true });
  ok(r.dry === true && deletes.length === 0 && r.totals.open === 5, 'ensayo directo, sin efectos', r.totals);
}

console.log(failures ? `\n${failures} FALLARON` : '\nTODO EN VERDE');
process.exit(failures ? 1 : 0);
