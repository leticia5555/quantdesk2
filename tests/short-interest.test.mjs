// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/short-interest: parseo del archivo FINRA Reg SHO,
// fechas candidatas (findes fuera), resumen/tendencia. Sin red.
// Correr con `node tests/short-interest.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { parseRegShoFile, candidateDates, summarize, ymdToIso } from '../api/short-interest.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── Parseo del archivo pipe-delimited ─────────────────────────────
{
  const file = [
    'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market',
    '20260731|TSLA|9000000|1000|18000000|Q',
    '20260731|AAPL|3000000|500|12000000|Q',
    '20260731|BADROW|x|y',            // corta → se ignora
    '20260731|ZERO|0|0|0|Q',          // total 0 → se ignora
    'Records in File: 3',             // trailer → se ignora
    '',
  ].join('\n');
  const map = parseRegShoFile(file);
  ok(map.size === 2, 'ignora header, trailer, filas cortas y total 0', map.size);
  ok(map.get('TSLA').short === 9000000 && map.get('TSLA').total === 18000000, 'TSLA parseado', JSON.stringify(map.get('TSLA')));
  ok(!map.has('BADROW') && !map.has('ZERO'), 'descarta filas inválidas');
  const tsla = map.get('TSLA');
  ok(tsla.short / tsla.total === 0.5, 'ratio short/total correcto', tsla.short / tsla.total);
}

// ── Fechas candidatas: sin sábados ni domingos ────────────────────
{
  // 2026-08-03 es lunes. candidateDates arranca en ayer (domingo 08-02).
  const dates = candidateDates(new Date('2026-08-03T12:00:00Z'), 1, 10);
  const isos = dates.map(ymdToIso);
  ok(!isos.includes('2026-08-02') && !isos.includes('2026-08-01'), 'excluye finde (sáb/dom)', isos.join(','));
  ok(isos.includes('2026-07-31') && isos.includes('2026-07-30'), 'incluye días hábiles previos', isos.join(','));
  ok(isos.every((s) => { const d = new Date(s + 'T00:00:00Z').getUTCDay(); return d !== 0 && d !== 6; }), 'todos son días hábiles');
}

// ── Resumen + tendencia ───────────────────────────────────────────
{
  // Serie ascendente con short-volume subiendo del ~30% al ~55%.
  const series = [30, 32, 31, 40, 45, 50, 55].map((pct, i) => ({
    ymd: '2026072' + (i + 1), ratio: pct / 100, short: pct, total: 100,
  }));
  const s = summarize(series);
  ok(s.latestRatio === 55, 'latestRatio = último día en %', s.latestRatio);
  ok(s.trend === 'INCREASING', 'tendencia creciente detectada', s.trend);
  ok(s.days === 7, 'cuenta de días', s.days);
  ok(s.avg5 != null && s.avg20 != null, 'promedios presentes');
}
{
  const flat = [40, 40, 41, 39, 40].map((pct, i) => ({ ymd: '2026072' + (i + 1), ratio: pct / 100, short: pct, total: 100 }));
  ok(summarize(flat).trend === 'STABLE', 'serie plana → STABLE', summarize(flat).trend);
}
ok(summarize([]) === null, 'serie vacía → null');

console.log(failures === 0 ? '\n✓ short-interest: todo en verde' : `\n✗ short-interest: ${failures} fallo(s)`);
process.exit(failures ? 1 : 0);
