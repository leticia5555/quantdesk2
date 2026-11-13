// ═══════════════════════════════════════════════════════════════
// Event Agent · insiders (Lety, 2026-11-11). El agente leía sólo
// Finnhub y contaba A/F como compras/ventas. Con FUN decía +$46.6K
// mientras /mercado/insiders mostraba $15M de un director; con SLQT
// decía 0 transacciones con cinco insiders comprando.
// Sin red. Correr con `node tests/event-agent-insiders.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  normalizaFinnhub, normalizaForm4, juntaInsiders, agregaInsiders, buildInsiderBlock,
} from '../api/event-agent.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const AHORA = Date.parse('2026-11-11T16:00:00Z');

// Filas como las guarda `mercado_form4_tx` (forma de filasDeForm4).
const filaSec = (o) => ({ ticker: 'FUN', derivada: false, plan_estado: 'no_programada', ...o });

// ── FUN: las compras de Jaffer que Finnhub no traía ──────────────
{
  const sec = normalizaForm4([
    filaSec({ quien: 'JAFFER REHAN', codigo: 'P', fecha: '2026-11-06', acciones: 700000, precio: 10.00 }),
    filaSec({ quien: 'JAFFER REHAN', codigo: 'P', fecha: '2026-11-09', acciones: 350000, precio: 10.86 }),
    filaSec({ quien: 'JAFFER REHAN', codigo: 'P', fecha: '2026-11-10', acciones: 400000, precio: 10.32 }),
    filaSec({ quien: 'HADDRILL RICHARD M', codigo: 'P', fecha: '2026-11-06', acciones: 9000, precio: 10.08 }),
    // Otro ticker que se coló en la consulta: no cuenta.
    filaSec({ ticker: 'SIX', quien: 'X', codigo: 'P', fecha: '2026-11-06', acciones: 1, precio: 1 }),
    // Derivada: no cuenta.
    filaSec({ quien: 'Y', codigo: 'P', fecha: '2026-11-06', acciones: 5, precio: 1, derivada: true }),
  ], 'FUN');
  const fh = normalizaFinnhub({ data: [
    { name: 'Bennett Christopher Lawrence', transactionCode: 'P', transactionDate: '2026-11-06', change: 5000, transactionPrice: 9.32 },
    // La misma compra de Haddrill vista por Finnhub: no se cuenta dos veces.
    { name: 'Haddrill Richard M', transactionCode: 'P', transactionDate: '2026-11-06', change: 9000, transactionPrice: 10.08 },
  ] });
  const b = agregaInsiders(juntaInsiders(sec, fh), 10.3, { ahora: AHORA });
  ok(b.buy_count === 5, 'FUN: 4 de la SEC + 1 sólo de Finnhub, sin duplicar Haddrill', b.buy_count);
  ok(b.total_buy_value > 15e6, 'FUN: compras > $15M, no $46.6K', b.total_buy_value);
  ok(b.category === 'BUYING', 'FUN: BUYING', b.category);
  ok(b.largest_transaction.insider_name === 'JAFFER REHAN', 'FUN: la más grande es Jaffer', b.largest_transaction.insider_name);
  ok(b.sources.join(',') === 'finnhub,sec_form4', 'FUN: declara las dos fuentes', b.sources);
}

// ── A/F/M ya no son compras ni ventas ────────────────────────────
{
  const b = buildInsiderBlock({ data: [
    { name: 'A', transactionCode: 'A', transactionDate: '2026-11-01', change: 1000, transactionPrice: 0 },
    { name: 'F', transactionCode: 'F', transactionDate: '2026-11-01', change: -400, transactionPrice: 100 },
    { name: 'M', transactionCode: 'M', transactionDate: '2026-11-01', change: 500, transactionPrice: 50 },
    { name: 'S', transactionCode: 'S', transactionDate: '2026-11-01', change: -100, transactionPrice: 100 },
  ] }, 100);
  ok(b.buy_count === 0, 'A (otorgamiento) y M (ejercicio) no son compras', b.buy_count);
  ok(b.sell_count === 1, 'F (impuestos) no es venta; S sí', b.sell_count);
  ok(b.transaction_count === 1, 'transaction_count = sólo P/S', b.transaction_count);
}

// ── Ventas programadas se cuentan aparte ─────────────────────────
{
  const b = agregaInsiders(normalizaForm4([
    filaSec({ ticker: 'CRWD', quien: 'KURTZ', codigo: 'S', fecha: '2026-11-06', acciones: 1000, precio: 220, plan_estado: 'programada' }),
    filaSec({ ticker: 'CRWD', quien: 'OTRO', codigo: 'S', fecha: '2026-11-06', acciones: 10, precio: 220 }),
  ], 'CRWD'), 220, { ahora: AHORA });
  ok(b.sell_count === 2 && b.scheduled_sell_count === 1, '1 de 2 ventas es 10b5-1', JSON.stringify(b));
  ok(b.largest_transaction.scheduled_10b5_1 === true, 'la más grande dice que fue programada');
}

// ── Fuera de la ventana de 90 días no cuenta ─────────────────────
{
  const b = agregaInsiders(normalizaForm4([
    filaSec({ quien: 'VIEJO', codigo: 'P', fecha: '2026-07-01', acciones: 100, precio: 10 }),
  ], 'FUN'), 10, { ahora: AHORA });
  ok(b.transaction_count === 0 && b.category === 'QUIET', 'compra de julio queda fuera', JSON.stringify(b));
}

// ── Sin datos: QUIET y sin fuentes ───────────────────────────────
{
  const b = agregaInsiders(juntaInsiders([], normalizaFinnhub(null)), 10, { ahora: AHORA });
  ok(b.category === 'QUIET' && b.sources.length === 0, 'vacío → QUIET');
}

// ── Finnhub sin dato de plan: "no sabemos", no "no programada" ───
{
  const b = agregaInsiders(normalizaFinnhub({ data: [
    { name: 'STEVENS MARK A', transactionCode: 'S', transactionDate: '2026-09-18', change: -1356000, transactionPrice: 219.7 },
  ] }), 200, { ahora: AHORA });
  ok(b.unknown_plan_sell_count === 1 && b.scheduled_sell_count === 0, 'venta de Finnhub = plan desconocido', JSON.stringify(b));
}

if (failures) { console.error(`\n${failures} fallo(s)`); process.exit(1); }
console.log('\nOK');
