// ═══════════════════════════════════════════════════════════════════
// tests/arena-ficha-tenencias.test.mjs — la ficha de lo que el agente TIENE.
//
// EL CASO (2026-10-20): 11 de 15 fichas decían "precio: no está entre los
// nombres que el tablero cubre hoy". Las posiciones propias casi nunca están
// en un extremo del tablero, y el agente leía "no tengo precio" de algo que
// él mismo tiene — el precio está en su libro de Alpaca, que la corrida ya
// leyó. La ficha ahora lo da, rotulado como de SU posición.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolExecutor, tenenciasDe } from '../api/_lib/arena-tools.js';

// Una posición como la devuelve Alpaca (todo string, fracciones).
const FICO = { symbol: 'FICO', qty: '10', avg_entry_price: '1800', current_price: '2000.5', market_value: '20005', change_today: '0.0123', unrealized_plpc: '0.1114' };
const sinDive = { fetchDeepDive: async () => ({ data: {} }) };

test('posición propia fuera del tablero: la ficha da su precio, rotulado, y su peso', async () => {
  const ex = createToolExecutor({ budget: 3, cache: false, board: { gainers: [], losers: [] }, posiciones: [FICO], equity: 100025, deps: sinDive });
  const out = await ex.call('ficha', { ticker: 'FICO' });
  assert.doesNotMatch(out.text, /no está entre los nombres que el tablero cubre/);
  assert.match(out.text, /precio 2000\.50 \(de TU posición en Alpaca/);
  assert.match(out.text, /1d \+1\.2%/);
  assert.match(out.text, /TU POSICIÓN: peso 20\.00% · entrada 1800\.00 · desde tu entrada \+11\.1%/);
});

test('un nombre que NO tiene y no está en el tablero sigue diciendo que no hay precio', async () => {
  const ex = createToolExecutor({ budget: 3, cache: false, board: { gainers: [], losers: [] }, posiciones: [FICO], equity: 100025, deps: sinDive });
  const out = await ex.call('ficha', { ticker: 'MU' });
  assert.match(out.text, /precio: no está entre los nombres que el tablero cubre hoy/);
  assert.doesNotMatch(out.text, /TU POSICIÓN/);
});

test('si está en el tablero, manda el precio del tablero y la posición va aparte', async () => {
  const board = { gainers: [{ symbol: 'FICO', price: 2010, change_pct: 1.5, rvol: 1.1 }], losers: [] };
  const ex = createToolExecutor({ budget: 3, cache: false, board, posiciones: [FICO], equity: 100025, deps: sinDive });
  const out = await ex.call('ficha', { ticker: 'FICO' });
  assert.match(out.text, /precio 2010\.00 · 1d \+1\.5%/);
  assert.doesNotMatch(out.text, /de TU posición en Alpaca/);
  assert.match(out.text, /TU POSICIÓN: peso/);
});

test('tenenciasDe tolera campos faltantes sin inventar números', () => {
  const t = tenenciasDe([{ symbol: 'x', current_price: '5' }], null);
  assert.deepEqual(t.X, { price: 5, change_today_pct: null, weight_pct: null, avg_entry: null, pnl_since_entry_pct: null });
});

test('cableado: los dos caminos (objetivo y viejo) le pasan las posiciones al ejecutor', async () => {
  const { readFileSync } = await import('node:fs');
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  assert.match(shadow, /posiciones: libro\.positions \|\| \[\], equity,/);
  assert.match(run, /posiciones: positions \|\| \[\], equity: Number\(account && account\.equity\),/);
});
