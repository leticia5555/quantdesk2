// ═══════════════════════════════════════════════════════════════
// Tests de la cosecha PEAD (Fase 1). JS puro, sin I/O ni red:
//   - parseEarnings: distingue ok / rate_limited / empty (la trampa de AV)
//   - classifyHourFromET: BMO/AMC/DMH desde el timestamp del 8-K
//   - build8KIndex / match8K: filtra Item 2.02 y casa por fecha ±1
//   - gapHeuristic: respaldo causal BMO vs AMC
//   - universo v0: limpio (sin ETFs/puntos/duplicados)
// Correr con `node tests/pead-harvest.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { parseEarnings } from '../api/_lib/av-earnings.js';
import { classifyHourFromET, build8KIndex, match8K, gapHeuristic, dayDiff } from '../api/_lib/pead-hour.js';
import { V0_UNIVERSE, v0LedgerEntries } from '../api/_lib/pead-universe.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('av-earnings: parseEarnings (la trampa del rate-limit)');

ok(parseEarnings({ Note: 'call frequency' }).status === 'rate_limited', 'Note → rate_limited (no marcar done)');
ok(parseEarnings({ Information: 'premium endpoint' }).status === 'rate_limited', 'Information → rate_limited');
ok(parseEarnings({ 'Error Message': 'invalid symbol' }).status === 'empty', 'Error Message → empty');
ok(parseEarnings({}).status === 'empty', 'sin quarterlyEarnings → empty');
ok(parseEarnings({ quarterlyEarnings: [] }).status === 'empty', 'array vacío → empty');
ok(parseEarnings(null).status === 'empty', 'null → empty (no crashea)');

const avOk = parseEarnings({
  symbol: 'MSFT',
  quarterlyEarnings: [
    { fiscalDateEnding: '2024-03-31', reportedDate: '2024-04-25', reportedEPS: '2.94', estimatedEPS: '2.82', surprise: '0.12', surprisePercentage: '4.2553' },
    { fiscalDateEnding: '2023-12-31', reportedDate: '2024-01-30', reportedEPS: '2.93', estimatedEPS: '2.78', surprise: '0.15', surprisePercentage: 'None' },
    { fiscalDateEnding: '2000-06-30', reportedDate: 'None', reportedEPS: '0.1', estimatedEPS: '0.1' }, // sin reportedDate → se descarta
  ],
});
ok(avOk.status === 'ok', 'respuesta buena → ok');
ok(avOk.events.length === 2, 'descarta filas sin reportedDate', avOk.events.length);
ok(avOk.events[0].reported_eps === 2.94 && avOk.events[0].surprise_pct != null, 'coerciona números');
// surprisePercentage 'None' → recomputa (2.93-2.78)/0.78*100 ≈ 5.128
ok(Math.abs(avOk.events[1].surprise_pct - ((2.93 - 2.78) / 2.78) * 100) < 1e-6, 'recomputa surprise_pct cuando AV manda None');

console.log('pead-hour: classifyHourFromET (hora del Este del 8-K)');

ok(classifyHourFromET('2024-01-30T06:05:00.000Z') === 'bmo', '06:05 → BMO (antes de 09:30)');
ok(classifyHourFromET('2024-01-30T09:29:59.000Z') === 'bmo', '09:29 → BMO');
ok(classifyHourFromET('2024-01-30T09:30:00.000Z') === 'dmh', '09:30 → DMH (mercado abierto)');
ok(classifyHourFromET('2024-01-30T13:00:00.000Z') === 'dmh', '13:00 → DMH');
ok(classifyHourFromET('2024-01-30T16:00:00.000Z') === 'amc', '16:00 → AMC (cierre)');
ok(classifyHourFromET('2024-01-30T16:05:23.000Z') === 'amc', '16:05 → AMC');
ok(classifyHourFromET('') === null && classifyHourFromET(null) === null, 'basura → null');

console.log('pead-hour: build8KIndex + match8K (Item 2.02, ±1 día)');

const recent = {
  form: ['8-K', '10-Q', '8-K', '4', '8-K'],
  items: ['2.02,9.01', '', '5.02', '', '2.02'],
  acceptanceDateTime: ['2024-04-25T16:05:00.000Z', 'x', '2024-03-01T10:00:00.000Z', 'x', '2024-01-30T16:01:00.000Z'],
  filingDate: ['2024-04-25', '2024-04-25', '2024-03-01', '2024-04-24', '2024-01-30'],
  accessionNumber: ['a1', 'a2', 'a3', 'a4', 'a5'],
};
const idx = build8KIndex(recent);
ok(idx.length === 2, 'solo 8-K con Item 2.02 (2 de 5)', idx.length);
ok(idx.every((f) => f.accession === 'a1' || f.accession === 'a5'), 'descarta el 8-K de Item 5.02 (no earnings)');

const m1 = match8K(idx, '2024-04-25', 1);
ok(m1 && m1.accession === 'a1', 'casa exacto por fecha');
const m2 = match8K(idx, '2024-01-31', 1); // AV reportó 1 día después del filing
ok(m2 && m2.accession === 'a5', 'casa con tolerancia ±1 día');
const m3 = match8K(idx, '2024-06-15', 1);
ok(m3 === null, 'sin 8-K cercano → null (cae a heurística de gap)');
ok(build8KIndex(null).length === 0, 'input nulo → índice vacío (no crashea)');

console.log('pead-hour: dayDiff + gapHeuristic (respaldo causal)');

ok(dayDiff('2024-01-31', '2024-01-30') === 1, 'dayDiff +1');
ok(dayDiff('2024-03-01', '2024-02-28') === 2, 'dayDiff cruza fin de mes (2024 bisiesto)');

// Gap grande HACIA D (open salta vs close previo) ⇒ anuncio fue BMO.
ok(gapHeuristic({ closePrev: 100, openD: 108, closeD: 109, openD1: 109.2 }) === 'bmo', 'gap hacia D ⇒ BMO');
// Gap grande HACIA D+1 (open de D+1 salta vs close de D) ⇒ AMC.
ok(gapHeuristic({ closePrev: 100, openD: 100.3, closeD: 101, openD1: 109 }) === 'amc', 'gap hacia D+1 ⇒ AMC');
// Sin reacción en ninguno → ambiguo (null), lo descarta el gate Y igual.
ok(gapHeuristic({ closePrev: 100, openD: 100.1, closeD: 100.2, openD1: 100.15 }) === null, 'sin reacción → null');
ok(gapHeuristic({ closePrev: 0, openD: 1, closeD: 1, openD1: 1 }) === null, 'precio inválido → null');

console.log('pead-universe: v0 limpio');

ok(V0_UNIVERSE.length >= 95 && V0_UNIVERSE.length <= 110, `~100 nombres (${V0_UNIVERSE.length})`);
ok(new Set(V0_UNIVERSE).size === V0_UNIVERSE.length, 'sin duplicados');
ok(V0_UNIVERSE.every((s) => !s.includes('.')), 'sin tickers con punto (ADRs/clases)');
ok(!V0_UNIVERSE.includes('SPY') && !V0_UNIVERSE.includes('QQQ'), 'sin ETFs');
ok(v0LedgerEntries().every((e) => e.priority === 0), 'todos priority 0');
ok(v0LedgerEntries().length === V0_UNIVERSE.length, 'entries = universo');

console.log(`\n${failures === 0 ? 'OK' : 'FALLARON ' + failures} — pead-harvest`);
process.exit(failures ? 1 : 0);
