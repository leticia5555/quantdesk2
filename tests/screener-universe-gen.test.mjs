// ═══════════════════════════════════════════════════════════════════
// Tests de la lógica PURA de regeneración del universo (expansión v2):
// api/_lib/screener-universe-gen.js. Cero red — todo con fixtures.
//   - gateByType: solo Common Stock / ADR / REIT; excluye ETP/warrant/right/
//     unit/preferente, tipo vacío, y apalancados/inversos por nombre.
//   - selectUniverse: aplica pisos precio/ADV/cap (fail-closed en faltantes),
//     rankea por ADV desc y corta a N; --min-cap null no filtra cap.
//   - formatUniverseArray: dedupe + filas de 10, formato del archivo.
// Correr con `node tests/screener-universe-gen.test.mjs`.
// ═══════════════════════════════════════════════════════════════════

import { gateByType, selectUniverse, formatUniverseArray, ALLOWED_SECURITY_TYPES } from '../api/_lib/screener-universe-gen.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) gateByType: inclusión estricta por tipo ──────────────────────
console.log('gateByType: solo equity común + ADR + REIT');
const symbolMap = {
  AAPL: 'APPLE INC',
  BABA: 'ALIBABA GROUP HLDG ADR',       // ADR
  O: 'REALTY INCOME CORP',               // REIT
  SPY: 'SPDR S&P 500 ETF TRUST',         // ETP → fuera
  'BRK.A': 'BERKSHIRE HATHAWAY',         // sin type en el fixture → fuera
  FOOWS: 'FOO WARRANTS',                 // type Equity WRT → fuera
  TSLL: 'DIREXION TSLA BULL 2X',         // Common Stock mistipado pero nombre apalancado → fuera
  ZBRA: 'ZEBRA TECHNOLOGIES',
};
const symbolTypes = {
  AAPL: 'Common Stock', BABA: 'ADR', O: 'REIT', SPY: 'ETP',
  FOOWS: 'Equity WRT', TSLL: 'Common Stock', ZBRA: 'Common Stock',
  // BRK.A deliberadamente sin type
};
const gated = gateByType(symbolMap, symbolTypes);
const gatedSyms = gated.map((g) => g.symbol).sort();
ok(gatedSyms.join(',') === 'AAPL,BABA,O,ZBRA', 'admite Common Stock + ADR + REIT, nada más', gatedSyms.join(','));
ok(!gatedSyms.includes('SPY'), 'excluye ETP (SPY)');
ok(!gatedSyms.includes('BRK.A'), 'excluye tipo vacío/desconocido (BRK.A)');
ok(!gatedSyms.includes('FOOWS'), 'excluye warrant (Equity WRT)');
ok(!gatedSyms.includes('TSLL'), 'excluye apalancado por nombre aunque el type diga Common Stock');
ok(gated.find((g) => g.symbol === 'BABA').type === 'ADR', 'conserva el tipo resuelto (BABA → ADR)');
ok(ALLOWED_SECURITY_TYPES.has('ADR') && !ALLOWED_SECURITY_TYPES.has('ETP'), 'ALLOWED = {Common Stock, ADR, REIT}');

// ── 2) selectUniverse: pisos + ranking por ADV + top-N ──────────────
console.log('\nselectUniverse: pisos + ranking por ADV, top-N');
const rows = [
  { symbol: 'AAA', price: 100, adv_usd: 900_000_000, cap_usd: 3e9 },   // más líquido
  { symbol: 'BBB', price: 50, adv_usd: 500_000_000, cap_usd: 5e9 },
  { symbol: 'CCC', price: 20, adv_usd: 100_000_000, cap_usd: 2.5e9 },
  { symbol: 'DUST', price: 0.5, adv_usd: 800_000_000, cap_usd: 4e9 },  // sub-$1 → fuera
  { symbol: 'THIN', price: 30, adv_usd: 500_000, cap_usd: 9e9 },       // ADV < $1M → fuera
  { symbol: 'SMOL', price: 40, adv_usd: 200_000_000, cap_usd: 5e8 },   // cap < $2B → fuera
  { symbol: 'NOPX', price: null, adv_usd: 300_000_000, cap_usd: 9e9 }, // sin precio → fuera
  { symbol: 'NOCAP', price: 10, adv_usd: 300_000_000, cap_usd: null }, // sin cap → fuera (con piso)
];
const sel = selectUniverse(rows, { n: 2, minPrice: 1, minAdvUsd: 1_000_000, minCapUsd: 2e9 });
ok(sel.symbols.join(',') === 'AAA,BBB', 'top-N por ADV desc, N respetado', sel.symbols.join(','));
ok(sel.stats.rejected.sub_min_price === 1, 'cuenta el sub-$1 (DUST)', JSON.stringify(sel.stats.rejected));
ok(sel.stats.rejected.sub_min_adv === 1, 'cuenta el ADV bajo (THIN)');
ok(sel.stats.rejected.sub_min_cap === 1, 'cuenta el cap bajo (SMOL)');
ok(sel.stats.rejected.no_price === 1, 'cuenta el sin-precio (NOPX)');
ok(sel.stats.rejected.no_cap === 1, 'fail-closed: sin cap con piso → rechazado (NOCAP)');
ok(sel.stats.passed_floors === 3, 'AAA/BBB/CCC pasan los pisos', String(sel.stats.passed_floors));

// cap null → no filtra por cap (NOCAP y SMOL entran si alcanzan el N)
const selNoCap = selectUniverse(rows, { n: 10, minPrice: 1, minAdvUsd: 1_000_000, minCapUsd: null });
ok(selNoCap.symbols.includes('SMOL') && selNoCap.symbols.includes('NOCAP'), 'min-cap null: no filtra por cap', selNoCap.symbols.join(','));
ok(!selNoCap.symbols.includes('DUST') && !selNoCap.symbols.includes('THIN'), 'min-cap null igual filtra precio+ADV');

// ── 3) formatUniverseArray: dedupe + filas de 10 ────────────────────
console.log('\nformatUniverseArray: dedupe + filas de 10');
const arr = formatUniverseArray(['aapl', 'MSFT', 'AAPL', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AVGO', 'ORCL', 'CRM']);
const lines = arr.split('\n');
// 'aapl' y 'AAPL' colapsan → 10 únicos → 1 fila de 10.
ok(lines.length === 1, 'diez símbolos únicos (aapl/AAPL dedup) → 1 fila', String(lines.length));
ok(lines[0].trim() === "'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AVGO', 'ORCL', 'CRM',", 'fila: 10, uppercase, sin duplicado', lines[0]);
// Un 11º distinto empuja a una 2ª fila.
const arr2 = formatUniverseArray(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
const lines2 = arr2.split('\n');
ok(lines2.length === 2 && lines2[1].trim() === "'K',", 'once distintos → 2 filas (10 + 1)', lines2.join(' | '));

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
