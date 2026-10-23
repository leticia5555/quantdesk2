// ═══════════════════════════════════════════════════════════════════
// tests/arena-ficha-tecnicos.test.mjs — los técnicos en la ficha, listos
// para la T4 y APAGADOS en la T3 (ARENA_FICHA_TECNICOS).
//
// Lo que se blinda:
//   1. SIN LA VARIABLE, LA FICHA ES IDÉNTICA BYTE A BYTE A LA DE MAIN. La
//      referencia (tests/fixtures/ficha-main-2026-10-22.json) se generó
//      corriendo la ficha de main (commit 4a3a232) con exactamente estas
//      entradas, ANTES de tocar arena-tools.js. Y no se pide ni una barra.
//   2. Encendida: una línea de técnicos, después del rango de 52 semanas
//      (antes de los titulares, para que el recorte por la cola no la tire
//      primero). Sin historia, n/d; con Alpaca caída, lo dice — nunca 0.
//
// Camino real: createToolExecutor → call('ficha') → runFicha. Lo falso es la
// red (fetch) y Finnhub (deps.fetchDeepDive, como en el resto de la suite).
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
delete process.env.ARENA_FICHA_TECNICOS;

const REFERENCIA = JSON.parse(readFileSync(new URL('./fixtures/ficha-main-2026-10-22.json', import.meta.url), 'utf8'));
const AHORA = new Date('2026-10-22T18:00:00Z');
const dive = {
  profile: { name: 'Micron Technology', industry: 'Semiconductors', marketCapM: 120000 },
  fundamentals: { peTTM: 20, psTTM: 3, grossMarginTTM: 40, netMarginTTM: 10, roeTTM: 15, debtToEquity: 0.3 },
  recommendation: { strongBuy: 5, buy: 10, hold: 3, sell: 0 },
  news: [{ date: '2026-10-21T12:00:00Z', headline: 'Micron sube guía' }],
};

let red = [];
let barrasCaidas = false;
const json = (b, s = 200) => ({ ok: s < 400, status: s, headers: { get: () => 'application/json' }, json: async () => b, text: async () => JSON.stringify(b) });
global.fetch = async (url) => {
  const u = String(url);
  red.push(u);
  if (u.includes('/v2/stocks/bars')) {
    if (barrasCaidas) return json({ message: 'internal' }, 500);
    // MU: 250 sesiones lineales 100…349. DVA: 30 (sin SMA50 ni 3m/6m).
    const serie = (n) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(), c: 100 + i }));
    return json({ bars: { MU: serie(250), DVA: serie(30) }, next_page_token: null });
  }
  throw new Error('red inesperada: ' + u);
};

const { createToolExecutor } = await import('../api/_lib/arena-tools.js');

const ficha = async (tk, extra = {}) => {
  const ex = createToolExecutor({
    cache: false, now: AHORA, finnhubKey: 'fh', creds: { key: 'k', secret: 's' },
    universe: { fifty_two_week: { MU: { high_52w: 130, low_52w: 60, pct_from_high: -8.5, pct_from_low: 98.2 } } },
    posiciones: [{ symbol: 'MU', qty: '105', avg_entry_price: '101.30', current_price: '118.95', market_value: '12489.75', change_today: '0.012', unrealized_plpc: '0.1742' }], equity: 100000,
    deps: { fetchDeepDive: async ([t]) => (t === 'MU' ? { data: { MU: dive }, errors: {} } : { data: {}, errors: {} }) },
    ...extra,
  });
  return (await ex.call('ficha', { ticker: tk })).text;
};

test('APAGADA (sin la variable): idéntica byte a byte a la ficha de main, y sin pedir barras', async () => {
  red = [];
  for (const tk of ['MU', 'DVA']) assert.equal(await ficha(tk), REFERENCIA[tk], tk);
  assert.equal(red.length, 0, 'apagada no toca la red');
  assert.equal(REFERENCIA.llamadas_de_red, 0, 'y la referencia tampoco la tocaba');
});

test('apagada también con ARENA_FICHA_TECNICOS=0 o un valor raro (se lee del proceso)', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const v of ['0', 'true', '']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
      const { createToolExecutor } = await import('./api/_lib/arena-tools.js');
      const { fichaTecnicosActiva } = await import('./api/_lib/tecnicos.js');
      console.log(JSON.stringify({ activa: fichaTecnicosActiva() }));
    `], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH, ARENA_FICHA_TECNICOS: v } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).activa, false, JSON.stringify(v));
  }
});

test('ENCENDIDA: la línea de técnicos va después del rango de 52 semanas; el resto no cambia', async () => {
  red = []; barrasCaidas = false;
  const texto = await ficha('MU', { fichaTecnicos: true });
  const lineas = texto.split('\n');
  const i = lineas.findIndex((l) => l.startsWith('técnicos'));
  assert.ok(i > 0, texto);
  assert.match(lineas[i - 1], /^52 semanas/);
  assert.match(lineas[i], /^técnicos \(al último cierre, 215 sesiones\): RSI14 100\.0 · vs SMA50 \+\d+\.\d% · vs SMA200 \+\d+\.\d% · ret 1m \+\d+\.\d% · 3m \+\d+\.\d% · 6m \+\d+\.\d%/);
  assert.equal(lineas.filter((_, k) => k !== i).join('\n'), REFERENCIA.MU, 'quitando esa línea, es la ficha de main');
  assert.equal(red.filter((u) => u.includes('/v2/stocks/bars')).length >= 1, true);
});

test('encendida, sin historia: n/d; con Alpaca caída: lo dice — nunca 0', async () => {
  barrasCaidas = false;
  const dva = await ficha('DVA', { fichaTecnicos: true });
  assert.match(dva, /técnicos \(al último cierre, 30 sesiones\): RSI14 100\.0 · vs SMA50 n\/d · vs SMA200 n\/d · ret 1m \+\d+\.\d% · 3m n\/d · 6m n\/d/);
  barrasCaidas = true;
  const caida = await ficha('MU', { fichaTecnicos: true });
  assert.match(caida, /técnicos: no disponibles \(Alpaca data 500[^)]*\) — no son cero\./);
  barrasCaidas = false;
});
