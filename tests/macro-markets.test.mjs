// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/macro-markets (batch del tab MACRO) con fetch
// mockeado — sin red. Correr con `node tests/macro-markets.test.mjs`.
//
// Contrato nuevo (anti-bug-de-periodo): el endpoint NO devuelve ningún
// porcentaje. Solo precio actual + serie cronológica de cierres con
// timestamp. El % por periodo lo calcula el cliente (qdPeriodChange).
// ═══════════════════════════════════════════════════════════════

import handler, { MACRO_SYMBOLS, extractMacro } from '../api/macro-markets.js';

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
// chart con timestamps + cierres alineados
function chart(meta, ts, closes) {
  return { chart: { result: [{ meta, timestamp: ts,
    indicators: { quote: [{ close: closes }] } }] } };
}
function chartResponse(meta, ts, closes) {
  return { ok: true, json: async () => chart(meta, ts, closes) };
}
const seq = (n, start = 0) => Array.from({ length: n }, (_, i) => start + i);

// ─────────────────── universo de símbolos ───────────────────
console.log('MACRO_SYMBOLS: universo curado y coherente');
{
  ok(MACRO_SYMBOLS.includes('^VIX'), 'incluye el VIX');
  ok(MACRO_SYMBOLS.includes('^TNX') && MACRO_SYMBOLS.includes('^TYX'),
    'rendimientos 10Y (^TNX) y 30Y (^TYX)');
  ok(MACRO_SYMBOLS.includes('2YY=F'),
    'el 2Y usa el futuro de rendimiento CBOT (no hay ^index limpio en Yahoo)');
  ok(MACRO_SYMBOLS.includes('DX-Y.NYB') && MACRO_SYMBOLS.includes('JPY=X') && MACRO_SYMBOLS.includes('EURUSD=X'),
    'FX global: DXY, USD/JPY, EUR/USD');
  ok(MACRO_SYMBOLS.includes('CL=F') && MACRO_SYMBOLS.includes('BZ=F'), 'commodities: WTI + Brent');
  ok(['^N225','^KS11','^HSI','^GDAXI','^FTSE','^MXX','^BVSP'].every(s => MACRO_SYMBOLS.includes(s)),
    'índices globales por región (Asia/Europa/LATAM)');
  ok(['ES=F','NQ=F','YM=F'].every(s => MACRO_SYMBOLS.includes(s)), 'futuros EE.UU.');
  ok(new Set(MACRO_SYMBOLS).size === MACRO_SYMBOLS.length, 'sin duplicados');
}

// ─────────────────── extractMacro ───────────────────
console.log('extractMacro: precio + serie cronológica con timestamp');
{
  const m = extractMacro(chart(
    { regularMarketPrice: 20, currency: 'USD' },
    [1, 2, 3, 4, 5], [17, 18, 18.5, 19, 20]));
  ok(m && m.price === 20, 'expone el precio actual', JSON.stringify(m));
  ok(m && m.currency === 'USD', 'propaga la moneda');
  ok(m && Array.isArray(m.series) && m.series.length === 5, 'serie con los cierres diarios', m && m.series.length);
  ok(m && m.series[0].t === 1 && m.series[0].c === 17 && m.series[4].c === 20,
    'cada punto es {t,c} alineado close↔timestamp', JSON.stringify(m && m.series));
  ok(m && !('changePct' in m) && !('prevClose' in m) && !('spark' in m),
    'NO devuelve porcentaje ni cierre previo pre-cocinado (la serie es la única verdad)', JSON.stringify(m));
}

console.log('extractMacro: FX NO se aplasta a 2 decimales (bug de escalones cuadrados)');
{
  // EUR/USD ~1.085 con variación en la 4ª cifra: toFixed(2) lo colapsaba a
  // 1.08 (línea plana). sig6 (toPrecision(6)) preserva la variación real.
  const m = extractMacro(chart(
    { regularMarketPrice: 1.0921, currency: 'USD' },
    [1, 2, 3, 4], [1.0850, 1.0862, 1.0899, 1.0921]));
  const distinct = new Set(m.series.map(p => p.c));
  ok(m && distinct.size === 4, 'los 4 cierres siguen siendo distintos (no colapsan a 1.08)', JSON.stringify([...distinct]));
  ok(m && m.series[0].c === 1.085, 'preserva 1.0850 → 1.085 (no 1.08)', m && m.series[0].c);
}

console.log('extractMacro: descarta cierres/timestamps inválidos y toma últimos 70');
{
  const ts = seq(90, 1000);
  const closes = seq(90, 1).map(x => x); // 1..90
  closes[3] = null; closes[7] = 0; closes[9] = 'x';
  const m = extractMacro(chart({ regularMarketPrice: 90 }, ts, closes));
  ok(m && m.series.length === 70, 'serie acotada a 70 puntos', m && m.series.length);
  ok(m && m.series.every(p => Number.isFinite(p.c) && p.c > 0 && Number.isFinite(p.t)),
    'sin nulls/ceros ni timestamps rotos', JSON.stringify(m && m.series.slice(0, 3)));
}

console.log('extractMacro: nunca inventa un dato');
{
  ok(extractMacro(null) === null, 'payload nulo → null');
  ok(extractMacro(chart({}, [1, 2], [1, 2])) === null, 'sin precio actual → null');
  ok(extractMacro(chart({ regularMarketPrice: 0 }, [1, 2], [1, 2])) === null, 'precio 0 → null');
  ok(extractMacro(chart({ regularMarketPrice: 100 }, [1], [100])) === null,
    'un solo punto (sin periodo que calcular) → null');
  ok(extractMacro(chart({ regularMarketPrice: 100 }, [], [])) === null, 'sin serie → null');
}

// ─────────────────── handler batched ───────────────────
const realFetch = global.fetch;

console.log('handler: batch feliz sobre el universo fijo');
{
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const u = String(url);
    ok(u.includes('range=3mo') && u.includes('interval=1d'), 'pide range=3mo&interval=1d (serie 3m en 1 fetch)');
    if (u.includes('%5EVIX')) return chartResponse({ regularMarketPrice: 20 }, [1, 2, 3], [18, 19, 20]);
    return chartResponse({ regularMarketPrice: 100 }, [1, 2, 3], [98, 99, 100]);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  ok(res.code === 200, 'responde 200', res.code);
  ok(calls === MACRO_SYMBOLS.length, 'un fetch por símbolo del universo', calls);
  const vix = res.body.data['^VIX'];
  ok(vix && vix.price === 20 && Array.isArray(vix.series) && vix.series.length === 3,
    'VIX indexado por su símbolo Yahoo con precio + serie', JSON.stringify(vix));
  ok(vix && !('changePct' in vix), 'sin changePct en la respuesta del handler');
  ok(/s-maxage=\d+/.test(res.headers['Cache-Control'] || ''), 'setea caché CDN compartida', res.headers['Cache-Control']);
}

console.log('handler: Yahoo caído parcial o total');
{
  global.fetch = async (url) => {
    if (String(url).includes('%5EVIX')) throw new Error('yahoo caído');
    return chartResponse({ regularMarketPrice: 100 }, [1, 2], [99, 100]);
  };
  const res = mockRes();
  await handler({ method: 'GET', query: {} }, res);
  ok(res.code === 200 && !('^VIX' in res.body.data) && Object.keys(res.body.data).length > 0,
    'símbolo caído se omite, el resto llega', Object.keys(res.body.data).length);

  global.fetch = async () => { throw new Error('yahoo caído'); };
  const res2 = mockRes();
  await handler({ method: 'GET', query: {} }, res2);
  ok(res2.code === 200 && Object.keys(res2.body.data).length === 0,
    'todo caído → 200 con data vacía (el cliente omite las tarjetas)');
}

console.log('handler: OPTIONS (CORS preflight)');
{
  global.fetch = async () => { throw new Error('no debería llamar a la red'); };
  const res = mockRes();
  await handler({ method: 'OPTIONS', query: {} }, res);
  ok(res.code === 200, 'preflight → 200 sin red');
}

global.fetch = realFetch;
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
