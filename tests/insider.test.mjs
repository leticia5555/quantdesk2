// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/insider — semántica de campos Form 4 de Finnhub.
// Blinda el fix del bug de $287B (usar `change`, NUNCA `share`).
// Correr con `node tests/insider.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { normalizeInsiderTx, deriveType } from '../api/insider.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── El bug real: fila F-code de TSLA ─────────────────────────────
// Finnhub devuelve `share` = tenencia RESULTANTE (~710M acciones) y
// `change` = las acciones MOVIDAS en esta transacción (−17.6k). Usar
// `share` inflaba el valor a ~$287B; el correcto es |change| × precio.
console.log('normalizeInsiderTx: dimensiona por `change`, jamás por `share`');
{
  const tslaFcode = {
    name: 'Elon Musk',
    transactionCode: 'F',
    change: -17600,        // acciones movidas (retención fiscal)
    share: 710000000,      // tenencia resultante — NO es el tamaño de la tx
    transactionPrice: 408.0,
  };
  const n = normalizeInsiderTx(tslaFcode);
  ok(n.shares === 17600, 'shares = |change|, no la tenencia', n.shares);
  ok(n.value === Math.round(17600 * 408.0), 'value = |change| × precio (~$7.2M)', n.value);
  ok(n.value < 1e9, 'value jamás llega a miles de millones (mata el $287B)', n.value);
  ok(n._signedValue < 0, '_signedValue conserva el signo (disposición)', n._signedValue);
  ok(n.type === 'TAX WITHHOLDING', 'code F → TAX WITHHOLDING', n.type);
}

// ── Compra abierta ───────────────────────────────────────────────
console.log('normalizeInsiderTx: compra abierta (P)');
{
  const buy = { name: 'Jane Insider', transactionCode: 'P', change: 5000, share: 42000, transactionPrice: 20 };
  const n = normalizeInsiderTx(buy);
  ok(n.shares === 5000, 'shares = change', n.shares);
  ok(n.value === 100000, 'value = 5000 × 20', n.value);
  ok(n._signedValue === 100000, '_signedValue positivo en compra', n._signedValue);
  ok(n.type === 'BUY', 'code P → BUY', n.type);
}

// ── Robustez de campos ausentes/basura ───────────────────────────
console.log('normalizeInsiderTx: campos ausentes → 0 seguro, sin NaN');
{
  const n = normalizeInsiderTx({ name: '  Bob  ', transactionCode: 'S', change: -3, transactionPrice: undefined });
  ok(n.price === 0 && n.value === 0, 'precio ausente → value 0', JSON.stringify(n));
  ok(!Number.isNaN(n.value), 'nunca NaN', n.value);
  ok(n.name === 'Bob', 'name trimmeado', n.name);
  ok(n.type === 'SELL', 'code S → SELL', n.type);
}

// ── deriveType: fallback por signo cuando no hay code ─────────────
console.log('deriveType: fallback por signo de change');
{
  ok(deriveType({ change: 10 }) === 'BUY', 'change>0 → BUY');
  ok(deriveType({ change: -10 }) === 'SELL', 'change<0 → SELL');
  ok(deriveType({ change: 0 }) === 'OTHER', 'change=0 → OTHER');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : `\n${failures} TESTS FALLARON`);
process.exit(failures ? 1 : 0);
