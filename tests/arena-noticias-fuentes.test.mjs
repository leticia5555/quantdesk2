// ═══════════════════════════════════════════════════════════════════
// tests/arena-noticias-fuentes.test.mjs — `noticias` con tres fuentes.
//
// Día 1 de la T3: 15 de 72 llamadas a `noticias` dieron "0 titulares" (DVA×4,
// HWM×5, BX×2, BMY, NU y 2 por tema) y los agentes compraron igual, sin
// noticia. La primaria es Alpaca News (Benzinga) y no cubre esos nombres.
//
// Esto corre el CAMINO REAL: el ejecutor → runNoticias → getNews (Alpaca) →
// finnhubNoticias → noticiasLocales (SQL a Neon). Lo único falso es la red,
// a nivel de `fetch`: los tres hosts contestan lo que contestaría cada uno.
// DVA es el caso del día: Alpaca no tiene nada, Finnhub sí, y el 8-K está en
// mercado_noticias.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';

const { createToolExecutor, tickersDelTema, palabrasDelTema, unirTitulares } = await import('../api/_lib/arena-tools.js');
const { secuenciaPublicable } = await import('../api/liga-libros.js');

const AHORA = new Date('2026-10-20T19:00:00Z');
const CATALOGO = [
  ['GE', 'GE Aerospace'], ['HWM', 'Howmet Aerospace Inc.'], ['GM', 'General Motors Company'],
  ['GIS', 'General Mills, Inc.'], ['AI', 'C3.ai, Inc.'], ['DVA', 'DaVita Inc.'], ['NVDA', 'NVIDIA Corporation'],
];

// ── LA RED ──────────────────────────────────────────────────────────
let llamadas = [];
let finnhubCaido = false;
let neonCaido = false;
const json = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: () => 'application/json' },
  json: async () => body, text: async () => JSON.stringify(body),
});
const alpaca = (id, headline, symbols, url, created_at = '2026-10-20T14:00:00Z', summary = '') =>
  ({ id, headline, summary, source: 'benzinga', created_at, symbols, url });

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://data.alpaca.markets/v1beta1/news')) {
    const sym = new URL(u).searchParams.get('symbols');
    llamadas.push('alpaca:' + (sym || '*'));
    if (sym === 'NVDA') return json({ news: [alpaca(1, 'Nvidia ships new chip', ['NVDA'], 'https://bz/1')] });
    if (sym === 'GE') return json({ news: [alpaca(2, 'GE Aerospace raises outlook', ['GE'], 'https://bz/2')] });
    if (sym) return json({ news: [] });
    // El feed general (búsqueda por palabras).
    return json({ news: [
      alpaca(10, 'Shipping rates jump as tension rises in the Strait of Hormuz', ['ZIM'], 'https://bz/10'),
      alpaca(11, 'Oil steady; traders watch Hormuz', ['XOM'], 'https://bz/11'),
      alpaca(12, 'Retail sales beat', [], 'https://bz/12'),
    ] });
  }
  if (u.startsWith('https://finnhub.io/api/v1/company-news')) {
    const sym = new URL(u).searchParams.get('symbol');
    llamadas.push('finnhub:' + sym);
    if (finnhubCaido) return json({ error: 'x' }, 500);
    if (sym === 'DVA') {
      return json([
        { headline: 'DaVita beats on margins', summary: '', datetime: Date.parse('2026-10-20T12:00:00Z') / 1000, url: 'https://fh/dva1', source: 'Reuters' },
        // La MISMA nota que el 8-K de abajo: se deduplica por URL.
        { headline: 'DaVita files 8-K', summary: '', datetime: Date.parse('2026-10-19T21:00:00Z') / 1000, url: 'https://sec/dva-8k', source: 'SEC' },
      ]);
    }
    return json([]);
  }
  if (u.includes('neon.tech')) {
    const { query, params = [] } = JSON.parse(opts.body);
    llamadas.push('neon:' + (/mercado_universo_us/.test(query) ? 'catalogo' : /any\(tickers\)/.test(query) ? 'ticker:' + params[0] : /ilike all/.test(query) ? 'palabras' : /insert into arena_buffet_cache/.test(query) ? 'cache:escribe' : 'otra'));
    if (neonCaido) return json({ message: 'caída' }, 500);
    if (/from mercado_universo_us/.test(query)) {
      return json({ fields: [{ name: 'symbol', dataTypeID: 25 }, { name: 'nombre', dataTypeID: 25 }], rows: CATALOGO });
    }
    const F = [['url', 25], ['titular', 25], ['fuente_nombre', 25], ['publicado_en', 1184], ['tickers', 1009]].map(([name, dataTypeID]) => ({ name, dataTypeID }));
    if (/any\(tickers\)/.test(query) && params[0] === 'DVA') {
      return json({ fields: F, rows: [['https://sec/dva-8k', 'DaVita Inc. 8-K: Results of Operations', 'SEC EDGAR 8-K', '2026-10-19T21:00:00Z', '{DVA}']] });
    }
    if (/ilike all/.test(query)) {
      return json({ fields: F, rows: [['https://rss/h1', 'Hormuz: tanker traffic slows, shipping insurers raise rates', 'Reuters', '2026-10-20T10:00:00Z', '{}']] });
    }
    return json({ fields: F, rows: [] });
  }
  throw new Error('fetch inesperado: ' + u);
};

const ejecutor = (extra = {}) => createToolExecutor({
  creds: { key: 'k', secret: 's' }, finnhubKey: 'fh', now: AHORA, cache: false, ...extra,
});

test('DVA: Alpaca da 0 → Finnhub y RSS+8-K, unidos, sin duplicados y con su fuente', async () => {
  llamadas = [];
  const ex = ejecutor();
  const r = await ex.call('noticias', { ticker: 'DVA' });
  assert.deepEqual(llamadas.sort(), ['alpaca:DVA', 'finnhub:DVA', 'neon:ticker:DVA']);
  assert.equal(r.rows, 2, 'tres notas, una repetida por URL → dos');
  assert.match(r.text, /\{finnhub\} DaVita beats on margins/);
  assert.match(r.text, /DaVita files 8-K|8-K: Results of Operations/);
  assert.match(r.text, /Alpaca\/Benzinga ✓ 0 · Finnhub ✓ 2 · RSS\+8-K \(mercado_noticias\) ✓ 1/);
  const paso = ex.sequence[0];
  assert.deepEqual(paso.fuentes, [{ id: 'alpaca', n: 0 }, { id: 'finnhub', n: 2 }, { id: 'rss_8k', n: 1 }]);
  assert.equal(paso.cobertura, 'con_titulares');
  // Lo que publica /liga/libros.
  const pub = secuenciaPublicable({ tools: { summary: ex.summary() } }).pasos[0];
  assert.equal(pub.resultado, '2 titulares · finnhub+rss_8k');
  assert.deepEqual(pub.fuentes, paso.fuentes);
});

test('con cobertura en Alpaca NO se consulta nada más', async () => {
  llamadas = [];
  const r = await ejecutor().call('noticias', { ticker: 'NVDA' });
  assert.deepEqual(llamadas, ['alpaca:NVDA']);
  assert.equal(r.rows, 1);
  assert.match(r.text, /\{alpaca\} Nvidia ships new chip/);
});

test('sin cobertura: las tres respondieron y no hay nada — se dice así', async () => {
  const ex = ejecutor();
  const r = await ex.call('noticias', { ticker: 'BX' });
  assert.equal(r.rows, 0);
  assert.equal(r.error, undefined, 'no es una falla');
  assert.match(r.text, /^0 titulares \(sin cobertura en nuestras fuentes: Alpaca\/Benzinga, Finnhub, RSS\+8-K/);
  assert.equal(secuenciaPublicable({ tools: { summary: ex.summary() } }).pasos[0].resultado, '0 titulares (sin cobertura en nuestras fuentes)');
});

test('una fuente caída: el cero NO es falta de cobertura, y no se cachea', async () => {
  finnhubCaido = true;
  const escrituras = [];
  try {
    const ex = ejecutor();
    const r = await ex.call('noticias', { ticker: 'BX' });
    assert.equal(r.cobertura, 'parcial');
    assert.match(r.text, /^0 titulares \(fuentes consultadas: Alpaca\/Benzinga ✓ 0 · Finnhub ✕ Finnhub 500 · RSS\+8-K \(mercado_noticias\) ✓ 0\)/);
    assert.match(r.text, /no es falta de cobertura/);
    const pub = secuenciaPublicable({ tools: { summary: ex.summary() } }).pasos[0];
    assert.equal(pub.resultado, '0 titulares (fuentes con falla: finnhub)');

    // Con caché encendida: lo parcial no se escribe; lo completo, sí.
    const antes = llamadas.length;
    await ejecutor({ cache: true }).call('noticias', { ticker: 'BX', days: 3 });
    escrituras.push(...llamadas.slice(antes).filter((l) => l === 'neon:cache:escribe'));
  } finally { finnhubCaido = false; }
  assert.equal(escrituras.length, 0, 'una consulta parcial no se cachea');
  const antes = llamadas.length;
  await ejecutor({ cache: true }).call('noticias', { ticker: 'BX', days: 4 });
  assert.equal(llamadas.slice(antes).filter((l) => l === 'neon:cache:escribe').length, 1, 'la completa sí se escribe');
});

test('todas caídas: es una falla (error), no un cero', async () => {
  finnhubCaido = true; neonCaido = true;
  try {
    const r = await createToolExecutor({ creds: null, finnhubKey: 'fh', now: AHORA, cache: false,
      deps: { getNews: async () => { throw new Error('Alpaca data 503'); } } }).call('noticias', { ticker: 'BX' });
    assert.equal(r.error, true);
    assert.match(r.text, /ninguna fuente de noticias respondió/);
  } finally { finnhubCaido = false; neonCaido = false; }
});

test('tema → ticker: "GE Aerospace earnings outlook" busca GE; "Howmet" busca HWM', async () => {
  llamadas = [];
  const ex = ejecutor();
  const ge = await ex.call('noticias', { tema: 'GE Aerospace earnings outlook' });
  assert.ok(llamadas.includes('alpaca:GE'), llamadas.join(','));
  assert.equal(ge.rows, 1);
  assert.match(ge.text, /"GE Aerospace earnings outlook" → GE/);
  llamadas = [];
  const hwm = await ex.call('noticias', { tema: 'Howmet' });
  assert.deepEqual(llamadas.filter((l) => !l.startsWith('neon:catalogo')).sort(), ['alpaca:HWM', 'finnhub:HWM', 'neon:ticker:HWM']);
  assert.equal(hwm.cobertura, 'sin_cobertura');
  assert.match(hwm.text, /"Howmet" \(→ HWM\)/);
  assert.deepEqual(ex.sequence[1].mapeo, [{ symbol: 'HWM', por: 'nombre: Howmet Aerospace Inc.' }]);
});

test('el mapeo no inventa empresas', () => {
  const cat = CATALOGO.map(([symbol, nombre]) => ({ symbol, nombre }));
  assert.deepEqual(tickersDelTema('General outlook for autos', cat), [], '"General" sola no es GM ni GIS');
  assert.deepEqual(tickersDelTema('General Motors recall', cat).map((x) => x.symbol), ['GM']);
  assert.deepEqual(tickersDelTema('AI chips demand', cat), [], '"AI" es una sigla, no C3.ai');
  assert.deepEqual(tickersDelTema('NVDA guidance', cat).map((x) => x.symbol), ['NVDA']);
  assert.deepEqual(tickersDelTema('nvidia guidance', cat).map((x) => x.symbol), ['NVDA']);
  assert.deepEqual(tickersDelTema('ge aerospace', cat).map((x) => x.symbol), ['GE'], 'por nombre completo aunque esté en minúsculas');
  assert.deepEqual(tickersDelTema('ge', cat), [], '"ge" en minúsculas y solo no es el ticker');
});

test('tema sin empresa: palabras en cualquier orden, no la frase exacta', async () => {
  llamadas = [];
  const r = await ejecutor().call('noticias', { tema: 'Hormuz shipping' });
  assert.ok(llamadas.includes('alpaca:*') && llamadas.includes('neon:palabras'), llamadas.join(','));
  // La frase exacta "Hormuz shipping" no está en ningún titular; las dos
  // palabras sí, en dos de ellos (uno de Alpaca, uno de los RSS).
  assert.equal(r.rows, 2);
  assert.match(r.text, /\{alpaca\} Shipping rates jump as tension rises in the Strait of Hormuz/);
  assert.match(r.text, /\{rss_8k\} Hormuz: tanker traffic slows/);
  assert.doesNotMatch(r.text, /Oil steady/, 'el que tiene una sola de las dos palabras queda fuera si hay alguno con las dos');
  assert.deepEqual(palabrasDelTema('the Strait of Hormuz'), ['strait', 'hormuz']);
});

test('unirTitulares: deduplica por URL y ordena por fecha', () => {
  const u = unirTitulares([
    [{ headline: 'a', url: 'x', created_at: '2026-10-19' }],
    [{ headline: 'a otra vez', url: 'x', created_at: '2026-10-20' }, { headline: 'b', url: null, created_at: '2026-10-20' }],
  ]);
  assert.deepEqual(u.map((n) => n.headline), ['b', 'a']);
});
