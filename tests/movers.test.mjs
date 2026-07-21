// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/movers — universo MARKET (Alpha Vantage) con
// fetch mockeado, sin red. Correr con `node tests/movers.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { mapAlphaVantageMovers } from '../api/movers.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}

const avEntry = (ticker, price, change, pct, volume) => ({
  ticker, price: String(price), change_amount: String(change),
  change_percentage: pct, volume: String(volume),
});

const AV_OK = {
  metadata: 'Top gainers, losers, and most actively traded US tickers',
  last_updated: '2026-07-20 16:16:00 US/Eastern',
  top_gainers: [
    avEntry('NVDA', 190.5, 12.3, '6.90%', 41000000),
    avEntry('ABCD+', 0.04, 0.03, '300.00%', 900000),   // warrant → fuera
    avEntry('PENY', 0.42, 0.30, '250.00%', 5000000),   // sub-$1 → fuera
    avEntry('MU', 141.05, 8.11, '6.10%', 22000000),
  ],
  top_losers: [avEntry('TSLA', 244.4, -19.8, '-7.49%', 88000000)],
  most_actively_traded: [avEntry('SOFI', 14.2, 0.31, '2.23%', 152000000)],
};

// ─────────────────── mapeo AV → contrato de movers ───────────────────
console.log('mapAlphaVantageMovers: mapea al contrato actual');
{
  const m = mapAlphaVantageMovers(AV_OK);
  const g = m && m.gainers[0];
  ok(!!m, 'payload válido → objeto', JSON.stringify(m));
  ok(g && g.symbol === 'NVDA' && g.price === 190.5 && g.change === 12.3, 'symbol/price/change numéricos', JSON.stringify(g));
  ok(g && g.changePct === 6.9, 'change_percentage "6.90%" → 6.9', g && g.changePct);
  ok(g && g.prevClose === 178.2, 'prevClose = price - change (computado)', g && g.prevClose);
  ok(g && g.volume === 41000000, 'volumen expuesto (extra vs watchlist)', g && g.volume);
  ok(g && g.high === null && g.low === null, 'high/low null — trade-off documentado de AV free');
  ok(m.last_updated === '2026-07-20 16:16:00 US/Eastern', 'propaga last_updated de AV');
}

console.log('mapAlphaVantageMovers: filtra ruido (warrants y sub-$1)');
{
  const m = mapAlphaVantageMovers(AV_OK);
  const syms = m.gainers.map(q => q.symbol);
  ok(!syms.includes('ABCD+'), 'ticker con "+" (warrant) fuera', syms.join(','));
  ok(!syms.includes('PENY'), 'precio < $1 fuera', syms.join(','));
  ok(syms.length === 2, 'quedan solo los reales', syms.join(','));
}

console.log('mapAlphaVantageMovers: nunca inventa datos');
{
  ok(mapAlphaVantageMovers(null) === null, 'payload nulo → null');
  ok(mapAlphaVantageMovers({}) === null, 'sin top_gainers → null');
  ok(mapAlphaVantageMovers({ Information: 'rate limit' }) === null, 'rate limit de AV (200 con Information) → null');
  ok(mapAlphaVantageMovers({ top_gainers: [], top_losers: [], most_actively_traded: [] }) === null,
    'listas vacías → null (dispara fallback, no panel vacío)');
  // Tickers solo-letras: el filtro anti-ruido descarta cualquier dígito/símbolo
  const many = { top_gainers: Array.from({ length: 20 }, (_, i) => avEntry('T' + 'ABCDEFGHIJKLMNOPQRST'[i], 10 + i, 1, '5.00%', 1000)), top_losers: [], most_actively_traded: [] };
  ok(mapAlphaVantageMovers(many).gainers.length === 10, 'top 10 máximo por columna');
}

// ─────────────────── handler: universo market + fallback ───────────────────
const realFetch = globalThis.fetch;
const finnhubQuote = { c: 100, d: 2, dp: 2.04, h: 101, l: 97, pc: 98 };

console.log('handler ?universe=market: éxito AV → universo market con cache 1h');
{
  process.env.ALPHAVANTAGE_API_KEY = 'test-av';
  process.env.FINNHUB_API_KEY = 'test-fh';
  globalThis.fetch = async (url) => {
    if (String(url).includes('alphavantage.co')) return { ok: true, json: async () => AV_OK };
    throw new Error('no debería llamar a Finnhub en el camino feliz: ' + url);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { universe: 'market' } }, res);
  const b = res.body;
  ok(b && b.universe === 'market' && !b.universe_fallback, 'universe=market sin fallback', JSON.stringify(b && { u: b.universe, f: b.universe_fallback }));
  ok(b && b.source === 'Alpha Vantage TOP_GAINERS_LOSERS', 'declara la fuente honesta');
  ok(b && Array.isArray(b.actives) && b.actives[0].symbol === 'SOFI', 'tercera columna = actives (dato real de volumen)');
  ok(/s-maxage=3600/.test(res.headers['Cache-Control'] || ''), 'edge cache 1h (25 req/día free)', res.headers['Cache-Control']);
}

console.log('handler ?universe=market: AV rate-limited → fallback VISIBLE a watchlist');
{
  globalThis.fetch = async (url) => {
    if (String(url).includes('alphavantage.co')) return { ok: true, json: async () => ({ Information: 'API rate limit is 25 requests per day' }) };
    if (String(url).includes('finnhub.io')) return { ok: true, json: async () => finnhubQuote };
    throw new Error('URL inesperada: ' + url);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: { universe: 'market' } }, res);
  const b = res.body;
  ok(b && b.universe === 'watchlist' && b.universe_fallback === true, 'degrada a watchlist con flag visible', JSON.stringify(b && { u: b.universe, f: b.universe_fallback }));
  ok(b && /Alpha Vantage/.test(b.fallback_reason || ''), 'la razón viaja al cliente', b && b.fallback_reason);
  ok(b && b.gainers.length > 0, 'nunca panel vacío: watchlist renderizable', b && b.gainers.length);
}

console.log('handler default: watchlist intacta (contrato original + universe)');
{
  globalThis.fetch = async (url) => {
    if (String(url).includes('finnhub.io')) return { ok: true, json: async () => finnhubQuote };
    throw new Error('default no debería salir de Finnhub: ' + url);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  const b = res.body;
  ok(b && b.universe === 'watchlist' && !b.universe_fallback, 'universo watchlist sin flag');
  ok(b && Array.isArray(b.volatile), 'conserva la columna volatile');
  ok(b && b.watchlist_size === 55, 'sigue escaneando los 55', b && b.watchlist_size);
  ok(/s-maxage=60/.test(res.headers['Cache-Control'] || ''), 'cache de 60s original', res.headers['Cache-Control']);
}

globalThis.fetch = realFetch;

if (failures) { console.error(`\n${failures} FALLOS`); process.exit(1); }
console.log('\nTODOS LOS TESTS PASAN');
