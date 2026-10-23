// ═══════════════════════════════════════════════════════════════════
// tests/liga-tecnicos.test.mjs — RSI(14), precio vs SMA50/SMA200 y retornos
// 1m/3m/6m por posición, en /api/leaderboard (lo que pinta /liga).
//
// Lo que se blinda:
//   1. El RSI contra barras CONOCIDAS: la hoja cs-rsi de StockCharts (Wilder),
//      los 19 valores publicados, a dos decimales.
//   2. Las SMA y los retornos contra aritmética que se hace a mano.
//   3. FALTA HISTORIA → null, NUNCA 0 (80 sesiones: hay SMA50, no SMA200).
//   4. Alpaca pagina por `next_page_token`: sin seguirlo, los últimos símbolos
//      del lote llegan sin historia. Se piden barras ajustadas por split y la
//      vela de hoy no entra.
//   5. Camino real de /api/leaderboard con la red simulada: cada posición
//      trae sus técnicos; si Alpaca no contesta las barras, la tabla sale
//      igual, con null y el motivo.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
for (const a of ['PAPER', 'CONTROL', 'OPENAI', 'GROK', 'GEMINI', 'DEEPSEEK', 'QWEN']) {
  process.env['ALPACA_' + a + '_KEY'] = 'k'; process.env['ALPACA_' + a + '_SECRET'] = 's';
}

const { tecnicosDeCierres, tecnicosPorSimbolo, lineaTecnicos, fichaTecnicosActiva } = await import('../api/_lib/tecnicos.js');
const { getCierresDiarios } = await import('../api/_lib/alpaca.js');

// cs-rsi.xls (StockCharts, "Relative Strength Index"): 33 cierres y el RSI(14)
// publicado desde el cierre 15.
const CS_RSI = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
const CS_RSI_PUBLICADO = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];

test('RSI(14) contra la hoja de StockCharts: los 19 valores publicados', () => {
  for (let i = 0; i < CS_RSI_PUBLICADO.length; i++) {
    const t = tecnicosDeCierres(CS_RSI.slice(0, 15 + i));
    assert.equal(t.rsi14.toFixed(2), CS_RSI_PUBLICADO[i].toFixed(2), `cierre ${15 + i}`);
  }
  assert.equal(tecnicosDeCierres(CS_RSI.slice(0, 14)).rsi14, null, 'con 14 cierres no hay RSI(14): null, no 0');
});

// Serie lineal 100, 101, …: la SMA de los últimos n es el punto medio, y el
// retorno a k sesiones es (p − (p−k)) / (p−k).
const lineal = (n) => Array.from({ length: n }, (_, i) => 100 + i);

test('SMA50/SMA200 y retornos 1m/3m/6m contra la cuenta a mano', () => {
  const t = tecnicosDeCierres(lineal(250));
  const p = 349;
  const sma50 = (p + (p - 49)) / 2;
  const sma200 = (p + (p - 199)) / 2;
  assert.equal(t.ultimo_cierre, p);
  assert.equal(t.vs_sma50_pct, +(((p - sma50) / sma50) * 100).toFixed(2));
  assert.equal(t.vs_sma200_pct, +(((p - sma200) / sma200) * 100).toFixed(2));
  assert.equal(t.ret_1m_pct, +(((p - (p - 21)) / (p - 21)) * 100).toFixed(2));
  assert.equal(t.ret_3m_pct, +(((p - (p - 63)) / (p - 63)) * 100).toFixed(2));
  assert.equal(t.ret_6m_pct, +(((p - (p - 126)) / (p - 126)) * 100).toFixed(2));
  assert.equal(t.rsi14, 100, 'sin una sola baja el RSI es 100');
  assert.equal(t.sesiones, 250);
});

test('falta historia → null, nunca 0', () => {
  const t = tecnicosDeCierres(lineal(80));
  assert.notEqual(t.vs_sma50_pct, null, '80 sesiones alcanzan para SMA50');
  assert.equal(t.vs_sma200_pct, null);
  assert.notEqual(t.ret_3m_pct, null);
  assert.equal(t.ret_6m_pct, null);
  const vacio = tecnicosDeCierres([]);
  for (const k of ['rsi14', 'vs_sma50_pct', 'vs_sma200_pct', 'ret_1m_pct', 'ret_3m_pct', 'ret_6m_pct', 'ultimo_cierre']) assert.equal(vacio[k], null, k);
  // El límite exacto: 21 sesiones atrás necesita 22 cierres.
  assert.equal(tecnicosDeCierres(lineal(21)).ret_1m_pct, null);
  assert.notEqual(tecnicosDeCierres(lineal(22)).ret_1m_pct, null);
  // Y la línea de la ficha lo dice como n/d.
  assert.match(lineaTecnicos(t), /vs SMA200 n\/d .* 6m n\/d \(n\/d = no hay historia suficiente, no es cero\)/);
});

// ── La red de Alpaca, a nivel de fetch ──────────────────────────────────
const AHORA = new Date('2026-10-22T18:00:00Z');
const dias = (n, fin = '2026-10-21') => {
  const out = [];
  const d = new Date(fin + 'T00:00:00Z');
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
};
const barras = (n, base = 100) => dias(n).map((f, i) => ({ t: f + 'T04:00:00Z', c: base + i, o: base + i, h: base + i, l: base + i, v: 1000 }));
const json = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => 'application/json' }, json: async () => b, text: async () => JSON.stringify(b) });

let pedidos = [];
let modoBarras = 'ok';
function redAlpaca(url) {
  const u = new URL(url);
  pedidos.push(u);
  if (modoBarras === 'caida') return json({ message: 'internal' }, 500);
  // Página 1: MU entero y la primera mitad de NVDA; página 2: el resto de
  // NVDA y SPCX (recién listada, 60 sesiones) + la vela de HOY, que no cuenta.
  const nvda = barras(215, 500);
  if (!u.searchParams.get('page_token')) {
    return json({ bars: { MU: barras(215, 100), NVDA: nvda.slice(0, 100) }, next_page_token: 'pag2' });
  }
  return json({ bars: { NVDA: [...nvda.slice(100), { t: '2026-10-22T04:00:00Z', c: 9999 }], SPCX: barras(60, 50) }, next_page_token: null });
}

test('getCierresDiarios sigue next_page_token, pide split y deja afuera la vela de hoy', async () => {
  pedidos = []; modoBarras = 'ok';
  global.fetch = async (url) => redAlpaca(String(url));
  const r = await getCierresDiarios(['mu', 'NVDA', 'SPCX'], { creds: { key: 'k', secret: 's' }, now: AHORA, feed: 'iex' });
  assert.equal(pedidos.length, 2, 'dos páginas');
  assert.equal(pedidos[1].searchParams.get('page_token'), 'pag2');
  assert.equal(pedidos[0].searchParams.get('adjustment'), 'split');
  assert.equal(pedidos[0].searchParams.get('timeframe'), '1Day');
  assert.equal(r.data.NVDA.length, 215, 'NVDA completo: la mitad venía en la página 2');
  assert.ok(!r.data.NVDA.includes(9999), 'la vela de hoy no entra');
  assert.equal(r.data.SPCX.length, 60);
});

test('tecnicosPorSimbolo: Alpaca caída → null por símbolo y el motivo, sin lanzar', async () => {
  modoBarras = 'caida';
  global.fetch = async (url) => redAlpaca(String(url));
  const r = await tecnicosPorSimbolo(['MU'], { creds: { key: 'k', secret: 's' }, now: AHORA, deps: { getCierresDiarios: (s, o) => getCierresDiarios(s, { ...o, feed: 'iex' }) } });
  assert.match(r.error, /Alpaca data 500/);
  assert.equal(r.por_simbolo.MU.rsi14, null);
  assert.equal(r.por_simbolo.MU.sesiones, 0);
});

test('ARENA_FICHA_TECNICOS: solo "1" lo enciende', () => {
  assert.equal(fichaTecnicosActiva({}), false);
  assert.equal(fichaTecnicosActiva({ ARENA_FICHA_TECNICOS: '0' }), false);
  assert.equal(fichaTecnicosActiva({ ARENA_FICHA_TECNICOS: 'true' }), false, 'un valor raro no la prende');
  assert.equal(fichaTecnicosActiva({ ARENA_FICHA_TECNICOS: '1' }), true);
});

// ── Camino real: /api/leaderboard ───────────────────────────────────────
const POSICIONES = {
  k: [
    { symbol: 'MU', qty: '40', avg_entry_price: '110', market_value: '12000', unrealized_pl: '400', unrealized_plpc: '0.034' },
    { symbol: 'SPCX', qty: '10', avg_entry_price: '50', market_value: '1100', unrealized_pl: '100', unrealized_plpc: '0.1' },
  ],
};
function redLiga(url, opts = {}) {
  const u = String(url);
  if (u.includes('/v2/stocks/bars')) return redAlpaca(u);
  if (u.includes('/v2/account')) return json({ equity: '100000', cash: '50000', last_equity: '99000', status: 'ACTIVE' });
  if (u.includes('/v2/positions')) return json(POSICIONES.k);
  if (u.includes('/v2/orders')) return json([]);
  if (u.includes('neon.tech')) return json({ fields: [], rows: [] });
  return json({});
}
const mkRes = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; };

test('/api/leaderboard: cada posición trae sus técnicos (camino real, red simulada)', async () => {
  modoBarras = 'ok'; pedidos = [];
  global.fetch = async (url, opts) => redLiga(url, opts);
  const lb = (await import('../api/leaderboard.js')).default;
  const r = mkRes();
  await lb({ method: 'GET', query: {}, headers: {} }, r);
  assert.equal(r.code, 200);
  const conPos = r.body.agents.filter((a) => (a.positions || []).length);
  assert.ok(conPos.length >= 1);
  const barrasPedidas = pedidos.filter((u) => u.pathname === '/v2/stocks/bars');
  assert.equal(new Set(barrasPedidas.map((u) => u.searchParams.get('page_token') || '1')).size, 2, 'UNA consulta (dos páginas) para los siete libros, no una por agente');
  for (const a of conPos) {
    const mu = a.positions.find((p) => p.symbol === 'MU');
    assert.deepEqual(mu.tecnicos, tecnicosDeCierres(barras(215, 100).map((b) => b.c)), a.id);
    const spcx = a.positions.find((p) => p.symbol === 'SPCX');
    assert.equal(spcx.tecnicos.vs_sma200_pct, null, 'recién listada: sin SMA200');
    assert.notEqual(spcx.tecnicos.vs_sma50_pct, null);
    assert.equal(a.tecnicos_error, undefined);
  }
});

test('/api/leaderboard: barras caídas → la tabla sale, técnicos null y el motivo', async () => {
  modoBarras = 'caida';
  global.fetch = async (url, opts) => redLiga(url, opts);
  const lb = (await import('../api/leaderboard.js')).default;
  const r = mkRes();
  await lb({ method: 'GET', query: {}, headers: {} }, r);
  assert.equal(r.code, 200);
  const a = r.body.agents.find((x) => (x.positions || []).length);
  assert.equal(a.positions[0].tecnicos.rsi14, null);
  assert.match(a.tecnicos_error, /Alpaca data 500/);
  modoBarras = 'ok';
});
