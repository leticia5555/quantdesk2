// ═══════════════════════════════════════════════════════════════════
// Tests del LIBRO (Fase 0, plomería).
//
//   1. Interruptor: LIBRO_LIVE_ENABLED solo enciende con 'true'; en sombra el
//      cliente se NIEGA a mandar (no hay flag `force`).
//   2. Limit-only: el cliente no expone `type`; todo POST a /v2/orders es
//      limit + day. Credenciales LIVE, nunca las del Arena.
//   3. Rieles: 15%/posición, 10% cash, 8 posiciones, banda ±2%, ≥$5, long-only,
//      enteros, estrategia ACTIVA. Violación = descartada con motivo, nunca ajustada.
//   4. Kill switch: cancela todo y deja LIBRO_HALT=1.
//   5. Estrategia activa no se edita, solo se cierra.
//   6. Métricas: exceso vs SPY, drawdown y días bajo el agua; 0 días → honesto.
//   7. Suerte: determinista, 40–60 = "indistinguible de suerte", 0 ops → no aplica.
//   8. Reporte con 0 operaciones: "0 operaciones · libro = cash".
//   9. Gate del endpoint: sin secret → 401; salud pública sin secretos.
//
// Correr con `node tests/libro.test.mjs`.
// ═══════════════════════════════════════════════════════════════════

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, send(s) { this.text = s; return this; }, end() { return this; } };
}

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ADMIN_SECRET = 'admin-s3cret';
process.env.ALPACA_LIVE_KEY = 'LIVEKEY';
process.env.ALPACA_LIVE_SECRET = 'LIVESECRET';
process.env.ALPACA_PAPER_KEY = 'PAPERKEY';
process.env.ALPACA_PAPER_SECRET = 'PAPERSECRET';
delete process.env.LIBRO_LIVE_ENABLED;

// ── mock de red: Alpaca live + Neon (estado en memoria) ──
const calls = [];
const estado = new Map();
let haltCancelCalled = 0;
const neon = (fields, rows) => ({ command: 'SELECT', rowCount: rows.length, fields, rows });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, method: opts.method || 'GET', body, headers: opts.headers || {} });
  const reply = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj });
  if (u.includes('neon.tech')) {
    const q = String(body.query || '');
    const queries = body.queries ? body.queries : [body];
    const out = [];
    for (const { query, params } of queries) {
      const qq = String(query);
      if (/^create table/i.test(qq) || /^alter table/i.test(qq)) { out.push(neon([], [])); continue; }
      if (/insert into libro_estado/i.test(qq)) { estado.set(params[0], params[1]); out.push(neon([], [])); continue; }
      if (/select valor from libro_estado/i.test(qq)) {
        const v = estado.has(params[0]) ? estado.get(params[0]) : null;
        out.push(neon([{ name: 'valor', dataTypeID: 25 }], v == null ? [] : [[v]])); continue;
      }
      if (/insert into cron_heartbeat/i.test(qq)) { out.push(neon([], [])); continue; }
      out.push(neon([], []));
    }
    return reply(body.queries ? { results: out } : out[0]);
  }
  if (u.includes('api.alpaca.markets')) {
    if (u.endsWith('/v2/account')) return reply({ status: 'ACTIVE', currency: 'USD', equity: '5000', cash: '5000', account_number: 'LIVE123', trading_blocked: false });
    if (u.endsWith('/v2/clock')) return reply({ is_open: false, next_open: '2026-10-19T13:30:00Z', next_close: '2026-10-19T20:00:00Z' });
    if (u.includes('/v2/calendar')) return reply([{ date: '2026-10-19' }, { date: '2026-10-20' }]);
    if (u.endsWith('/v2/positions')) return reply([]);
    if (u.endsWith('/v2/orders') && (opts.method || 'GET') === 'DELETE') { haltCancelCalled++; return reply([{ id: 'o1', status: 200 }], 207); }
    if (u.endsWith('/v2/orders') && opts.method === 'POST') return reply({ id: 'ord-1', status: 'accepted', type: body.type, limit_price: body.limit_price, time_in_force: body.time_in_force });
    if (/\/v2\/orders\/ord-1$/.test(u)) return reply({ id: 'ord-1', status: (opts.method === 'DELETE') ? 'canceled' : 'canceled' });
  }
  if (u.includes('data.alpaca.markets')) return reply({ dailyBar: { c: 650.5 }, prevDailyBar: { c: 648 }, latestTrade: { p: 650.7 } });
  return reply({ message: 'ruta inesperada: ' + u }, 404);
};

const A = await import('../api/_lib/libro-alpaca.js');
const L = await import('../api/_lib/libro.js');
const { default: handler, runSmoke } = await import('../api/libro.js');

// ═══ 1. Interruptor ═══
console.log('\n1. Interruptor LIBRO_LIVE_ENABLED');
delete process.env.LIBRO_LIVE_ENABLED; ok(A.libroLiveEnabled() === false, 'ausente → sombra');
process.env.LIBRO_LIVE_ENABLED = 'false'; ok(A.libroLiveEnabled() === false, "'false' → sombra");
process.env.LIBRO_LIVE_ENABLED = '1'; ok(A.libroLiveEnabled() === false, "'1' → sombra (solo 'true' enciende)");
process.env.LIBRO_LIVE_ENABLED = ' TRUE '; ok(A.libroLiveEnabled() === true, "' TRUE ' → live");
delete process.env.LIBRO_LIVE_ENABLED;
let sombra = null;
try { await A.createLimitOrder({ symbol: 'AAPL', qty: 1, side: 'buy', limit_price: 1 }); } catch (e) { sombra = e; }
ok(sombra && sombra.sombra === true, 'en sombra createLimitOrder LANZA LibroSombraError y no manda nada');
ok(!calls.some((c) => c.url.endsWith('/v2/orders') && c.method === 'POST'), 'cero POST /v2/orders en sombra');

// ═══ 2. Limit-only + creds live ═══
console.log('\n2. Limit-only, credenciales LIVE');
process.env.LIBRO_LIVE_ENABLED = 'true';
const o = await A.createLimitOrder({ symbol: 'aapl', qty: 2, side: 'buy', limit_price: 1, client_order_id: 'libro:x:2026-10-17:AAPL:buy' });
const post = calls.find((c) => c.url.endsWith('/v2/orders') && c.method === 'POST');
ok(post && post.body.type === 'limit' && post.body.time_in_force === 'day', 'POST es limit + day');
ok(post.body.symbol === 'AAPL' && post.body.qty === '2', 'símbolo en mayúsculas, qty como string');
ok(post.headers['APCA-API-KEY-ID'] === 'LIVEKEY', 'usa ALPACA_LIVE_KEY, no la del Arena');
ok(post.url.startsWith('https://api.alpaca.markets'), 'host LIVE (api.alpaca.markets), no paper');
ok(!('closeAllPositions' in A), 'el cliente live NO expone liquidación a mercado');
let err = null; try { await A.createLimitOrder({ symbol: 'AAPL', qty: 1.5, side: 'buy', limit_price: 1 }); } catch (e) { err = e; }
ok(err && /entero/.test(err.message), 'qty fraccional rechazada');
err = null; try { await A.createLimitOrder({ symbol: 'AAPL', qty: 1, side: 'short', limit_price: 1 }); } catch (e) { err = e; }
ok(err && /buy\|sell/.test(err.message), 'side inválido rechazado');
delete process.env.LIBRO_LIVE_ENABLED;

// ═══ 3. Rieles ═══
console.log('\n3. Rieles (validarOrdenes)');
const est = { tsla: { estado: 'activa', tamano_max_pct: 10 }, piso: { estado: 'validada', tamano_max_pct: 0 }, grande: { estado: 'activa', tamano_max_pct: 15 } };
const base = { equity: 10000, cash: 10000, positions: [], lastCloses: { TSLA: 100, F: 10, X: 4 }, estrategias: est };
let r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 9, limit_price: 101 }] });
ok(r.approved.length === 1 && r.discarded.length === 0, 'compra dentro de rieles aprobada (9×101=909 ≤ 10%)');
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 11, limit_price: 100 }] });
ok(r.discarded.length === 1 && /tamaño máximo/.test(r.discarded[0].reason), 'supera tamaño de la estrategia (11% > 10%) → descartada, no recortada', r.discarded[0] && r.discarded[0].reason);
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'grande', symbol: 'TSLA', side: 'buy', qty: 16, limit_price: 100 }] });
ok(r.discarded.length === 1 && /15%/.test(r.discarded[0].reason), '16% del equity > 15% → descartada');
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 5, limit_price: 103 }] });
ok(r.discarded.length === 1 && /banda/.test(r.discarded[0].reason), 'límite fuera de ±2% → descartada');
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'tsla', symbol: 'X', side: 'buy', qty: 5, limit_price: 4 }] });
ok(r.discarded.length === 1 && /\$5/.test(r.discarded[0].reason), 'precio < $5 → descartada');
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'piso', symbol: 'TSLA', side: 'buy', qty: 1, limit_price: 100 }] });
ok(r.discarded.length === 1 && /ACTIVA/.test(r.discarded[0].reason), 'estrategia no activa → descartada');
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'sell', qty: 1, limit_price: 100 }] });
ok(r.discarded.length === 1 && /cortos/.test(r.discarded[0].reason), 'venta sin posición → sin cortos en v1');
r = L.validarOrdenes({ ...base, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 1.5, limit_price: 100 }] });
ok(r.discarded.length === 1 && /entero/.test(r.discarded[0].reason), 'fraccional → descartada');
r = L.validarOrdenes({ ...base, cash: 1200, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 5, limit_price: 100 }] });
ok(r.discarded.length === 1 && /cash/.test(r.discarded[0].reason), 'rompe piso de 10% cash → descartada');
const ocho = Array.from({ length: 8 }, (_, i) => ({ symbol: 'S' + i, qty: 1, market_value: 10 }));
r = L.validarOrdenes({ ...base, positions: ocho, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 1, limit_price: 100 }] });
ok(r.discarded.length === 1 && /posiciones/.test(r.discarded[0].reason), '9ª posición → descartada');
r = L.validarOrdenes({ ...base, lastCloses: {}, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 1, limit_price: 100 }] });
ok(r.discarded.length === 1 && /referencia/.test(r.discarded[0].reason), 'sin cierre de referencia → fail closed');
r = L.validarOrdenes({ ...base, equity: NaN, ordenes: [{ estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', qty: 1, limit_price: 100 }] });
ok(r.approved.length === 0 && r.discarded.length === 1, 'cuenta ilegible → todo descartado');
ok(Object.isFrozen(L.LIBRO_RULES) && L.LIBRO_RULES.long_only === true && L.LIBRO_RULES.max_position_fraction === 0.15, 'LIBRO_RULES congeladas: long-only, 15%');
ok(L.LIBRO_EXIT_RULES.catastrophic_stop_pct === 0.22 && L.LIBRO_EXIT_RULES.breaker_delever_dd === 0.15 && L.LIBRO_EXIT_RULES.breaker_broadcut_dd === 0.20, 'salidas de riesgo = reglas T2 (22% / 15% / 20%), importadas de arena-exits');
const sal = L.salidasDeRiesgo({ equity: 7900, peak: 10000, positions: [{ symbol: 'TSLA', qty: 10, avg_entry_price: 100, side: 'long', unrealized_plpc: -0.3 }], closes: { TSLA: 70 } });
ok(sal.stage === 'broadcut' && sal.approved.length === 1 && sal.approved[0].side === 'sell', 'drawdown 21% → broadcut liquida con venta límite marketable', JSON.stringify(sal));
ok(L.clientOrderId({ estrategia_id: 'tsla', date: '2026-10-17', symbol: 'tsla', side: 'buy' }) === 'libro:tsla:2026-10-17:TSLA:buy', 'client_order_id idempotente');

// ═══ 4. Kill switch ═══
console.log('\n4. Kill switch');
const k = await L.kill({ cancelAll: A.cancelAllOrders, motivo: 'test' });
ok(k.halt === true && haltCancelCalled === 1, 'cancela todas las órdenes y declara halt');
ok(await L.estaEnHalt() === true, 'LIBRO_HALT=1 en Neon');
await L.reanudar(); ok(await L.estaEnHalt() === false, 'reanudar → halt 0');

// ═══ 5. Estrategia activa no se edita ═══
console.log('\n5. Cero cambios a media temporada');
ok(L.puedeEditarse({ estado: 'activa' }) === false && L.puedeEditarse({ estado: 'paper' }) === true, 'activa no se edita; paper sí');
ok(L.SEMILLA.length === 2 && L.SEMILLA.map((s) => s.id).join(',') === 'spy_piso,tsla_bollinger', 'semilla = spy_piso + tsla_bollinger, nada más');
ok(L.SEMILLA[1].tamano_max_pct === 10 && L.SEMILLA[1].horizonte_meses === 6 && /FRÁGIL a 5/.test(L.SEMILLA[1].fuente_del_go), 'tsla_bollinger: 10%, 6 meses, etiqueta honesta');
ok(Object.keys(L.ADAPTADORES).length === 0, 'Fase 0: ningún adaptador enchufado');

// ═══ 6. Métricas ═══
console.log('\n6. Métricas');
let m = L.metricas({ equityDiario: [] });
ok(m.dias === 0 && m.exceso === null, '0 días → sin números, sin inventar');
const eq = [
  { fecha: '2026-10-20', equity: 10000, cash: 10000, spy_close: 600 },
  { fecha: '2026-10-21', equity: 10200, cash: 10000, spy_close: 606 },
  { fecha: '2026-10-22', equity: 9800, cash: 10000, spy_close: 612 },
  { fecha: '2026-10-23', equity: 9900, cash: 10000, spy_close: 618 },
  { fecha: '2026-10-24', equity: 10500, cash: 10000, spy_close: 624 },
];
m = L.metricas({ equityDiario: eq, spyUnidades: 10000 / 600, equityInicial: 10000 });
ok(Math.abs(m.retorno_libro - 0.05) < 1e-9, 'retorno libro +5%');
ok(Math.abs(m.retorno_spy - 0.04) < 1e-9, 'retorno SPY +4% (unidades × precio)');
ok(Math.abs(m.exceso - 0.01) < 1e-9, 'exceso +1%');
ok(Math.abs(m.max_drawdown - (10200 - 9800) / 10200) < 1e-9, 'max drawdown desde el pico de 10200');
ok(m.dias_bajo_agua === 2, '2 días bajo el agua');

// ═══ 7. Suerte ═══
console.log('\n7. ¿Fue suerte?');
const fechas = Array.from({ length: 260 }, (_, i) => `D${String(i).padStart(3, '0')}`);
const seno = (a, p) => fechas.map((_, i) => 100 + a * Math.sin(i / p));
const series = { TSLA: { fechas, closes: seno(5, 7) }, F: { fechas, closes: seno(3, 11) } };
const ops = [{ symbol: 'TSLA', entrada: 'D010', salida: 'D015' }, { symbol: 'F', entrada: 'D050', salida: 'D060' }, { symbol: 'TSLA', entrada: 'D100', salida: 'D103' }];
const s1 = L.percentilSuerte({ ops, series, retornoReal: 0.0 });
const s2 = L.percentilSuerte({ ops, series, retornoReal: 0.0 });
ok(s1.aplica && s1.percentil === s2.percentil, 'determinista con semilla');
ok(s1.percentil >= 35 && s1.percentil <= 65 && /suerte|azar/.test(s1.veredicto), 'retorno 0 sobre series sin tendencia cae en medio', s1.percentil);
const s3 = L.percentilSuerte({ ops, series, retornoReal: 0.5 });
ok(s3.percentil >= 95 && s3.veredicto === 'mejor que el azar', '+50% por operación → percentil alto');
ok(L.percentilSuerte({ ops: [], series, retornoReal: 0.1 }).aplica === false, '0 ops → no aplica');
const rm = L.retornoMedioPorOperacion([
  { estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', estado: 'filled', fill_price: 100, fill_ts: '2026-10-20T14:00:00Z' },
  { estrategia_id: 'tsla', symbol: 'TSLA', side: 'sell', estado: 'filled', fill_price: 110, fill_ts: '2026-10-25T14:00:00Z' },
  { estrategia_id: 'tsla', symbol: 'TSLA', side: 'buy', estado: 'sombra', fill_price: null },
]);
ok(rm.ops.length === 1 && Math.abs(rm.media - (0.10 - 0.002)) < 1e-9, 'empareja buy→sell llenos, ignora sombra, descuenta 10bp por lado');

// ═══ 8. Reporte honesto con 0 operaciones ═══
console.log('\n8. Reporte');
let md = L.renderReporteMarkdown({ m: L.metricas({ equityDiario: eq.slice(0, 2), spyUnidades: 10000 / 600, equityInicial: 10000 }), suerte: { aplica: false, motivo: '0 operaciones cerradas' }, estrategias: L.SEMILLA.map((s) => ({ ...s })), ordenes: [] });
ok(/0 operaciones · libro = cash/.test(md), 'dice "0 operaciones · libro = cash"');
ok(/¿Le gané al piso\?/.test(md) && /¿Cuánto me asusté\?/.test(md) && /¿Fue suerte\?/.test(md), 'los tres números, con esas preguntas');
ok(/SOMBRA/.test(md) && /dividendos de SPY no contados/.test(md), 'declara modo sombra y dividendos no contados');
ok(/\| tsla_bollinger \| validada \| 0 \|/.test(md), 'tabla por estrategia');
md = L.renderReporteMarkdown({ m: L.metricas({ equityDiario: [] }), suerte: null, estrategias: [], ordenes: [] });
ok(/Sin días registrados/.test(md), 'sin filas → lo dice, no inventa');
const sMed = L.renderReporteMarkdown({ m: L.metricas({ equityDiario: eq, spyUnidades: 10000 / 600, equityInicial: 10000 }), suerte: { aplica: true, percentil: 50, veredicto: 'indistinguible de suerte', n: 1000, operaciones: 3, nube_p10: -0.01, nube_p50: 0, nube_p90: 0.01 }, estrategias: [], ordenes: [] });
ok(/indistinguible de suerte/.test(sMed), 'percentil 50 → "indistinguible de suerte", con esas palabras');

// ═══ 9. Endpoint ═══
console.log('\n9. /api/libro');
let res = mockRes(); await handler({ method: 'GET', query: {}, headers: {} }, res);
ok(res.code === 200 && res.body.modo === 'SOMBRA' && res.body.keys === true, 'salud pública: sombra, keys presentes', JSON.stringify(res.body));
ok(JSON.stringify(res.body).indexOf('LIVEKEY') === -1 && JSON.stringify(res.body).indexOf('LIVESECRET') === -1, 'la salud no filtra credenciales');
res = mockRes(); await handler({ method: 'GET', query: { smoke: '1' }, headers: {} }, res);
ok(res.code === 401, 'smoke sin secret → 401');
res = mockRes(); await handler({ method: 'GET', query: { kill: '1' }, headers: {} }, res);
ok(res.code === 401, 'kill sin secret → 401');
res = mockRes(); await handler({ method: 'GET', query: { smoke: '1' }, headers: { authorization: 'Bearer admin-s3cret' } }, res);
ok(res.code === 200 && res.body.smoke === true && res.body.live === false, 'smoke con secret responde');
const pasos = res.body.results.map((r) => r.name).join(',');
ok(pasos === 'account,clock,calendar,limit_order,order_lookup,cancel', 'secuencia del smoke = la del Arena', pasos);
ok(res.body.results.find((r) => r.name === 'limit_order').sombra === true && res.body.ok === true, 'en sombra la escritura reporta sombra:true, no error');
const postsSmoke = calls.filter((c) => c.url.endsWith('/v2/orders') && c.method === 'POST' && String(c.body.client_order_id || '').startsWith('libro-smoke'));
ok(postsSmoke.length === 0, 'el smoke en sombra NO mandó la orden');
process.env.LIBRO_LIVE_ENABLED = 'true';
const sm = await runSmoke(new Date('2026-10-17T20:00:00Z'));
ok(sm.ok === true && sm.live === true && sm.results.every((r) => r.ok && !r.sombra), 'smoke LIVE 6/6 (orden imposible + cancel)');
const postLive = calls.filter((c) => c.url.endsWith('/v2/orders') && c.method === 'POST' && String(c.body.client_order_id || '').startsWith('libro-smoke'));
ok(postLive.length === 1 && postLive[0].body.limit_price === '1' && postLive[0].body.type === 'limit', 'orden imposible: AAPL límite $1, limit');
delete process.env.LIBRO_LIVE_ENABLED;
res = mockRes(); await handler({ method: 'GET', query: { kill: '1', motivo: 'prueba' }, headers: { 'x-admin-key': 'admin-s3cret' } }, res);
ok(res.code === 200 && res.body.halt === true, 'kill por x-admin-key → halt');
res = mockRes(); await handler({ method: 'GET', query: { equity: '1' }, headers: { authorization: 'Bearer admin-s3cret' } }, res);
ok(res.code === 200 && res.body.equity === 5000 && res.body.spy_close === 650.5, 'foto de equity lee cuenta + SPY', JSON.stringify(res.body));
ok(!calls.some((c) => c.headers['APCA-API-KEY-ID'] === 'PAPERKEY'), 'en toda la suite, NINGUNA llamada usó las keys del Arena');

// ═══ 10. /api/libro-report ═══
console.log('\n10. /api/libro-report');
const { default: reportHandler } = await import('../api/libro-report.js');
res = mockRes(); await reportHandler({ method: 'GET', query: { format: 'md' }, headers: {} }, res);
ok(res.code === 401, 'reporte sin secret → 401 (cuenta real, no es público)');
res = mockRes(); await reportHandler({ method: 'GET', query: { format: 'md' }, headers: { authorization: 'Bearer admin-s3cret' } }, res);
ok(res.code === 200 && /Sin días registrados/.test(res.text), 'reporte md con tablas vacías es honesto', res.text && res.text.slice(0, 200));
res = mockRes(); await reportHandler({ method: 'GET', query: {}, headers: { authorization: 'Bearer admin-s3cret' } }, res);
ok(res.code === 200 && res.body.numeros && res.body.numeros.fue_suerte.aplica === false && res.body.operaciones_cerradas === 0, 'JSON: tres números presentes, suerte no aplica con 0 ops');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
