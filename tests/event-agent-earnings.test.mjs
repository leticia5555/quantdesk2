// ═══════════════════════════════════════════════════════════════
// Event Agent · earnings (Lety, 2026-11-11).
//   • NVDA el 11-nov 10:38 Monterrey: decía "5d" al 17-nov; EARNINGS
//     decía "en 6d". Ahora son días de calendario en Nueva York.
//   • Un reporte de HOY se caía de "next earnings".
//   • El orden del historial se fija acá: el más reciente primero.
// Sin red. Correr con `node tests/event-agent-earnings.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { buildEarningsBlock, hoyNY, diasDeCalendario } from '../api/event-agent.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const ahora = new Date('2026-11-11T16:38:00Z'); // 10:38 Monterrey

ok(hoyNY(ahora) === '2026-11-11', 'hoy en NY', hoyNY(ahora));
ok(hoyNY(new Date('2026-11-12T03:00:00Z')) === '2026-11-11', '22:00 NY sigue siendo el 11');
ok(diasDeCalendario('2026-11-11', '2026-11-17') === 6, '11 → 17 = 6 días');

{
  const e = buildEarningsBlock([], [{ date: '2026-11-17', epsEstimate: 2.53, quarter: 3, year: 2027 }], { ahora });
  ok(e.days_until === 6, 'NVDA: 6d como EARNINGS, no 5d', e.days_until);
}
{
  const e = buildEarningsBlock([], [
    { date: '2026-11-11', epsEstimate: 0.1 }, { date: '2026-11-17', epsEstimate: 2.53 },
  ], { ahora });
  ok(e.next_date === '2026-11-11' && e.days_until === 0, 'reporte de hoy no se cae', JSON.stringify(e));
}
{
  // Finnhub desordenado: el agente lo ordena.
  const e = buildEarningsBlock([
    { period: '2025-12-31', actual: 0.11, estimate: -0.0408, quarter: 2, year: 2026 },
    { period: '2026-09-30', actual: -0.21, estimate: -0.35, quarter: 1, year: 2027 },
    { period: '2026-03-31', actual: 0.2, estimate: 0.1, quarter: 3, year: 2026 },
    { period: '2026-06-30', actual: 0.1, estimate: 0.12, quarter: 4, year: 2026 },
  ], [], { ahora });
  ok(e.most_recent_report.period_end === '2026-09-30', 'el más reciente es el de sep-30', e.most_recent_report.period_end);
  ok(e.last_4_reports.map(r => r.quarters_ago).join() === '1,2,3,4', 'quarters_ago 1..4');
  ok(e.last_4_reports[0].fiscal_period === 'Q1 2027', 'etiqueta fiscal', e.last_4_reports[0].fiscal_period);
  ok(e.estimates_source === 'Finnhub', 'declara la fuente del consenso');
}

if (failures) { console.error(`\n${failures} fallo(s)`); process.exit(1); }
console.log('\nOK');
