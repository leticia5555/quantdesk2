// ═══════════════════════════════════════════════════════════════════
// tests/arena-finnhub-429.test.mjs — un 429 de Finnhub NO es "sin cobertura".
//
// `ficha` tomaba un 429 como "sin cobertura" y lo CACHEABA el día entero para
// los siete. Con #302 (noticias también consulta Finnhub) el límite se pisa
// más seguido, así que esto entra con él.
//
// Camino real: ejecutor → runFicha → fetchDeepDive (las cuatro llamadas a
// Finnhub) → caché del día en Neon. Lo único falso es la red, a nivel de
// `fetch`: Finnhub contesta el status que cada caso pide.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';

const { createToolExecutor } = await import('../api/_lib/arena-tools.js');
const { fetchDeepDive, FINNHUB_LIMITE } = await import('../api/_lib/finnhub-dive.js');
const { secuenciaPublicable } = await import('../api/liga-libros.js');

const AHORA = new Date('2026-10-20T19:00:00Z');
// Por endpoint de Finnhub: 'ok' | 429 | 500 | 'red' (la conexión cae).
let modo = {};
let escrituras = 0;
const json = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: () => 'application/json' },
  json: async () => body, text: async () => JSON.stringify(body),
});
const OK = {
  metric: { metric: { peTTM: 20, psTTM: 3, grossMarginTTM: 40, netProfitMarginTTM: 10, roeTTM: 15 } },
  profile2: { name: 'Micron Technology', finnhubIndustry: 'Semiconductors', marketCapitalization: 120000 },
  recommendation: [{ strongBuy: 5, buy: 10, hold: 3, sell: 0, period: '2026-10-01' }],
  'company-news': [{ headline: 'Micron sube guía', datetime: Date.parse('2026-10-19T12:00:00Z') / 1000, url: 'https://x/1' }],
};
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://finnhub.io/api/v1/')) {
    const ep = Object.keys(OK).find((k) => u.includes('/' + k + '?'));
    const m = modo[ep] ?? 'ok';
    if (m === 'red') throw new Error('ECONNRESET');
    if (m !== 'ok') return json({ error: 'x' }, m);
    return json(OK[ep]);
  }
  if (u.includes('neon.tech')) {
    const { query } = JSON.parse(opts.body);
    if (/insert into arena_buffet_cache/.test(query)) escrituras++;
    return json({ fields: [], rows: [] });
  }
  throw new Error('fetch inesperado: ' + u);
};

const ficha = async () => {
  escrituras = 0;
  const ex = createToolExecutor({ finnhubKey: 'fh', now: AHORA, cache: true });
  const r = await ex.call('ficha', { ticker: 'MU' });
  const paso = secuenciaPublicable({ tools: { summary: ex.summary() } }).pasos[0];
  return { r, paso, seq: ex.sequence[0] };
};

test('fetchDeepDive: el 429 se distingue de "sin cobertura" en la raíz', async () => {
  modo = { metric: 429, profile2: 429, recommendation: 429, 'company-news': 429 };
  assert.equal((await fetchDeepDive(['MU'], 'fh', AHORA)).errors.MU, FINNHUB_LIMITE);
  modo = { metric: 'red', profile2: 'red', recommendation: 'red', 'company-news': 'red' };
  assert.equal((await fetchDeepDive(['MU'], 'fh', AHORA)).errors.MU, 'Finnhub no respondió');
  modo = { metric: 404, profile2: 404, recommendation: 404, 'company-news': 404 };
  assert.equal((await fetchDeepDive(['MU'], 'fh', AHORA)).errors.MU, 'sin cobertura Finnhub', 'un 404 en las cuatro sí es falta de cobertura');
});

test('ficha con Finnhub en 429: "falló: límite de Finnhub", y NO se cachea', async () => {
  modo = { metric: 429, profile2: 429, recommendation: 429, 'company-news': 429 };
  const { r, paso, seq } = await ficha();
  assert.equal(r.error, true);
  assert.match(r.text, /^La herramienta falló en los fundamentales: límite de Finnhub \(429\)\. NO es "sin cobertura"/);
  assert.doesNotMatch(r.text, /sin cobertura de fundamentales/);
  assert.equal(seq.fallo, 'límite de Finnhub');
  assert.equal(paso.resultado, 'falló: límite de Finnhub');
  assert.equal(escrituras, 0, 'un 429 no se cachea nunca');
});

test('un 429 en UNA de las cuatro: la ficha sale, dice que está incompleta, y tampoco se cachea', async () => {
  modo = { 'company-news': 429 };
  const { r, seq } = await ficha();
  assert.equal(r.error, undefined);
  assert.match(r.text, /P\/E 20\.00/);
  assert.match(r.text, /ficha INCOMPLETA: parte de los datos no llegó por el límite de Finnhub \(429\)/);
  assert.equal(seq.fallo, 'límite de Finnhub (parcial)');
  assert.equal(escrituras, 0);
});

test('Finnhub caído (red): "falló: Finnhub no respondió", no "sin cobertura", y no se cachea', async () => {
  modo = { metric: 'red', profile2: 'red', recommendation: 'red', 'company-news': 'red' };
  const { r, paso } = await ficha();
  assert.equal(r.error, true);
  assert.equal(paso.resultado, 'falló: Finnhub no respondió');
  assert.equal(escrituras, 0);
});

test('sin 429 y con datos: la ficha completa SÍ se cachea (el arreglo no apaga la caché)', async () => {
  modo = {};
  const { r, seq } = await ficha();
  assert.equal(r.error, undefined);
  assert.equal(seq.fallo, undefined);
  assert.equal(escrituras, 1);
});

test('noticias: un 429 de Finnhub es una fuente caída con su nombre, no un cero de cobertura', async () => {
  modo = { 'company-news': 429 };
  escrituras = 0;
  const ex = createToolExecutor({ finnhubKey: 'fh', now: AHORA, cache: true, creds: { key: 'k', secret: 's' },
    deps: { getNews: async () => [], noticiasLocales: async () => [] } });
  const r = await ex.call('noticias', { ticker: 'DVA' });
  assert.equal(r.cobertura, 'parcial');
  assert.match(r.text, /Finnhub ✕ límite de Finnhub \(429\)/);
  assert.equal(escrituras, 0);
});
