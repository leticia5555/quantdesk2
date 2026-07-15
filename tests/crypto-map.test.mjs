// ═══════════════════════════════════════════════════════════════
// Fuente única de verdad crypto→Yahoo (api/_lib/crypto-map.js).
//
// 1) Recorre el catálogo TICKERS del FRONTEND (app.html) y exige que cada
//    type:'crypto' resuelva a su par -USD — si el front gana un crypto que
//    el mapa no cubre, este test falla (nunca más ETH validando Ethan Allen
//    en silencio).
// 2) Verifica, con fetch mockeado, que LOS CONSUMIDORES reales usan el mapa:
//    pairs-validator, signal-backtester, ticker-search (liquidez) y _lib/sim.
//
// Correr con `node tests/crypto-map.test.mjs` — sin red.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CRYPTO, toYahooSymbol, isCrypto } from '../api/_lib/crypto-map.js';
import pairsHandler from '../api/pairs-validator.js';
import signalsHandler from '../api/signal-backtester.js';
import { liquidityCheck } from '../api/ticker-search.js';
import { fetchDailySeries } from '../api/_lib/sim.js';
import backtestHandler from '../api/backtest.js';

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
const realFetch = global.fetch;

// ─────────────────── 1) catálogo del frontend ───────────────────
console.log('catálogo: todos los type:crypto de TICKERS resuelven a -USD');
{
  const appHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.html'), 'utf8');
  const cryptoSyms = [...appHtml.matchAll(/\{sym:'([^']+)'[^}]*type:'crypto'/g)].map((m) => m[1]);
  ok(cryptoSyms.length >= 12, `el catálogo tiene cryptos (${cryptoSyms.length} encontrados)`, cryptoSyms.join(','));
  for (const sym of cryptoSyms) {
    const base = sym.replace(/\/USD$/, '');
    ok(toYahooSymbol(sym) === `${base}-USD`, `${sym} → ${base}-USD`);
    ok(isCrypto(sym) && CRYPTO.includes(base), `${base} está en la lista canónica`);
  }
  // Los dos que faltaban en las listas duplicadas (Bug 2 de la auditoría):
  ok(toYahooSymbol('MATIC') === 'MATIC-USD', 'MATIC cubierto');
  ok(toYahooSymbol('LTC') === 'LTC-USD', 'LTC cubierto (antes: LTC Properties, un REIT)');
  // Y las equities pasan intactas:
  ok(toYahooSymbol('AAPL') === 'AAPL' && toYahooSymbol('femsaubd.mx') === 'FEMSAUBD.MX',
    'equities pasan sin tocar');
}

// Fake de Yahoo chart que registra los símbolos pedidos y devuelve una serie
// diaria válida (300 barras) para que los motores no corten antes del fetch.
function chartFake(requested) {
  return async (url) => {
    const m = /finance\/chart\/([^?]+)/.exec(String(url));
    if (m) requested.push(decodeURIComponent(m[1]));
    const n = 300;
    const ts = Array.from({ length: n }, (_, i) => 1700000000 + i * 86400);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.01);
    const volume = Array.from({ length: n }, () => 1e7);
    return { ok: true, json: async () => ({ chart: { result: [{
      timestamp: ts, meta: { currency: 'USD' },
      indicators: { quote: [{ close: closes, volume }] },
    }] } }) };
  };
}

// ─────────────────── 2) consumidores reales ───────────────────
console.log('pairs-validator: ETH/BTC van a Yahoo como -USD (Bug 1)');
{
  const requested = [];
  global.fetch = chartFake(requested);
  const res = mockRes();
  await pairsHandler({ method: 'GET', query: { x: 'ETH', y: 'BTC', range: '1y' } }, res);
  ok(requested.includes('ETH-USD') && requested.includes('BTC-USD'),
    'fetch usa ETH-USD y BTC-USD', requested.join(','));
  ok(!requested.includes('ETH') && !requested.includes('BTC'),
    'nunca pide el símbolo crudo (Ethan Allen / Grayscale)');
  ok(res.body && res.body.pair && res.body.pair.x === 'ETH' && res.body.pair.y === 'BTC',
    'la respuesta conserva los símbolos que ve el usuario', JSON.stringify(res.body && res.body.pair));
}

console.log('signal-backtester: LTC va a Yahoo como LTC-USD');
{
  const requested = [];
  global.fetch = chartFake(requested);
  const res = mockRes();
  await signalsHandler({ method: 'GET', query: { ticker: 'LTC', rule: 'rsi', range: '1y' } }, res);
  ok(requested.length === 1 && requested[0] === 'LTC-USD', 'fetch usa LTC-USD', requested.join(','));
}

console.log('ticker-search (liquidez): MATIC consulta MATIC-USD');
{
  const requested = [];
  global.fetch = chartFake(requested);
  await liquidityCheck('MATIC');
  ok(requested[0] === 'MATIC-USD', 'liquidez usa MATIC-USD', requested.join(','));
}

console.log('_lib/sim (agentes): DOGE en catch-up usa DOGE-USD');
{
  const requested = [];
  global.fetch = chartFake(requested);
  await fetchDailySeries('DOGE', '1y');
  ok(requested[0] === 'DOGE-USD', 'fetchDailySeries usa DOGE-USD', requested.join(','));
}

console.log('backtest (SIM): XRP usa XRP-USD');
{
  const requested = [];
  global.fetch = chartFake(requested);
  const res = mockRes();
  await backtestHandler({ method: 'GET', query: { ticker: 'XRP', days: '90' } }, res);
  ok(requested[0] === 'XRP-USD', 'backtest usa XRP-USD', requested.join(','));
}

// ─────────────────── blindaje contra listas nuevas ───────────────────
console.log('no reaparecen listas CRYPTO duplicadas en api/');
{
  const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
  const { readdirSync, statSync } = await import('node:fs');
  const files = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.endsWith('crypto-map.js') && !p.endsWith('price.js')) files.push(p);
    }
  })(apiDir);
  const offenders = files.filter((p) => /\[\s*'BTC'\s*,\s*'ETH'/.test(readFileSync(p, 'utf8')));
  ok(offenders.length === 0, 'ningún archivo redefine la lista (price.js/CoinGecko exento)', offenders.join(','));
}

global.fetch = realFetch;
console.log(failures ? `\n${failures} FAIL` : '\nOK — crypto-map: fuente única verificada');
process.exit(failures ? 1 : 0);
