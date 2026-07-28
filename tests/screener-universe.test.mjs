// ═══════════════════════════════════════════════════════════════
// Tests del universo del canal SCREENER (_lib/screener-universe.js).
// Puro, sin I/O. Cubre auditUniverse: qué tickers del universo ya no
// están en el symbol map US de Finnhub (delisted/renombrados).
// Correr con `node tests/screener-universe.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { US_SCREENER_UNIVERSE, universeLedgerEntries, auditUniverse } from '../api/_lib/screener-universe.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('screener-universe: auditUniverse (universo vs. symbol map US)');

// Map con TODO el universo presente → nada muerto.
const fullMap = Object.fromEntries(US_SCREENER_UNIVERSE.map((s) => [s, s + ' Inc']));
const a1 = auditUniverse(fullMap);
ok(a1.missing.length === 0, 'universo completo en el map → missing vacío', JSON.stringify(a1.missing));
ok(a1.present === a1.total && a1.total === new Set(US_SCREENER_UNIVERSE).size, 'present = total = tamaño del universo (dedupe)', JSON.stringify({ present: a1.present, total: a1.total }));

// Simula tickers muertos: toma dos miembros ACTUALES del universo y bórralos
// del map (robusto ante cambios futuros de la lista).
const [d1, d2] = US_SCREENER_UNIVERSE;
const deadMap = { ...fullMap };
delete deadMap[d1];
delete deadMap[d2];
const a2 = auditUniverse(deadMap);
ok(a2.missing.includes(d1) && a2.missing.includes(d2), `miembros ausentes del map → reportados como missing (${d1}, ${d2})`, JSON.stringify(a2.missing));
ok(a2.missing.length === 2 && a2.present === a2.total - 2, 'solo los borrados faltan; el resto sigue presente', JSON.stringify({ missing: a2.missing, present: a2.present, total: a2.total }));

// Regresión del fix del universo: SQ→XYZ (rebrand de Block) y HES removida
// (delisted por Chevron). Los muertos que dispararon todo esto ya no están.
ok(US_SCREENER_UNIVERSE.includes('XYZ') && !US_SCREENER_UNIVERSE.includes('SQ'), 'universo: SQ reemplazado por XYZ (rebrand de Block, ene-2025)');
ok(!US_SCREENER_UNIVERSE.includes('HES'), 'universo: HES removida (Hess absorbida por Chevron)');

// Map vacío (Finnhub caído): auditUniverse marca TODO como missing — el caller
// DEBE tratarlo como no autoritativo (gate en arena-screener), pero la función
// pura no adivina.
const a3 = auditUniverse({});
ok(a3.missing.length === a3.total && a3.present === 0, 'map vacío → todo missing (el caller no debe confiar a ciegas)', JSON.stringify({ present: a3.present, total: a3.total }));
ok(auditUniverse(null).present === 0, 'map null no crashea (se trata como vacío)');

// Contrato del ledger seed: entries dedupe + shape { symbol }.
const entries = universeLedgerEntries();
ok(entries.length === new Set(US_SCREENER_UNIVERSE).size && entries.every((e) => typeof e.symbol === 'string'), 'universeLedgerEntries: dedupe + shape { symbol }');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
