// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/insider: el fix del parseo Form 4 (usar el CAMBIO
// de la transacción, no el holding resultante) + tipos por código.
// Sin red. Correr con `node tests/insider.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { normalizeTx, deriveType } from '../api/insider.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── El bug real: TSLA F-code con holding gigante ──────────────────
// Finnhub: change = -710 (acciones movidas), share = 710_000_000 (holding
// TOTAL tras la transacción). El valor debe salir de |change|, no de share.
{
  const tx = { name: 'MUSK ELON', transactionCode: 'F', change: -710, share: 710000000, transactionPrice: 404.76 };
  const n = normalizeTx(tx);
  ok(n.shares === 710, 'usa |change| como tamaño, no el holding', n.shares);
  ok(n.value === Math.round(710 * 404.76), 'valor = |change|·precio (no share·precio)', n.value);
  ok(n.value < 1e6, 'valor plausible (< $1M), no $287B', n.value);
  ok(n.type === 'TAX WITHHOLDING', 'F → TAX WITHHOLDING', n.type);
}

// ── Compra open-market (P): value correcto y BUY ──────────────────
{
  const n = normalizeTx({ name: 'DOE JANE', transactionCode: 'P', change: 1000, share: 51000, transactionPrice: 25 });
  ok(n.type === 'BUY' && n.value === 25000 && n.shares === 1000, 'P → BUY con value=25k', JSON.stringify(n));
}

// ── Venta (S): SELL, signedValue negativo ─────────────────────────
{
  const n = normalizeTx({ name: 'ROE J', transactionCode: 'S', change: -1250, share: 57234, transactionPrice: 655.81 });
  ok(n.type === 'SELL', 'S → SELL', n.type);
  ok(n.shares === 1250 && n.value === Math.round(1250 * 655.81), 'value de venta usa |change|', n.value);
  ok(n._signedValue < 0, 'signedValue negativo en venta', n._signedValue);
}

// ── change ausente → 0 shares (no explota, no inventa) ────────────
{
  const n = normalizeTx({ name: 'NOBODY', transactionCode: 'P', share: 1000, transactionPrice: 10 });
  ok(n.shares === 0 && n.value === 0, 'sin change → 0 (no cae al holding)', JSON.stringify(n));
}

// ── deriveType: cobertura de códigos ──────────────────────────────
ok(deriveType({ transactionCode: 'A' }) === 'AWARD', 'A → AWARD');
ok(deriveType({ transactionCode: 'M' }) === 'OPTION EXERCISE', 'M → OPTION EXERCISE');
ok(deriveType({ transactionCode: 'G' }) === 'GIFT', 'G → GIFT');
ok(deriveType({ change: 5 }) === 'BUY', 'sin código, change>0 → BUY');
ok(deriveType({ change: -5 }) === 'SELL', 'sin código, change<0 → SELL');

console.log(failures === 0 ? '\n✓ insider: todo en verde' : `\n✗ insider: ${failures} fallo(s)`);
process.exit(failures ? 1 : 0);
