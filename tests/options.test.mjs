// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/options: max pain y resumen del chain. Sin red.
// Correr con `node tests/options.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { computeMaxPain, summarizeChain } from '../api/options.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── Max pain ──────────────────────────────────────────────────────
{
  // Todo el OI de puts en 90 y de calls en 110; el mínimo dolor cae en un
  // strike intermedio donde ambos lados pagan poco.
  const calls = [{ strike: 100, openInterest: 100 }, { strike: 110, openInterest: 5000 }];
  const puts = [{ strike: 100, openInterest: 100 }, { strike: 90, openInterest: 5000 }];
  const mp = computeMaxPain(calls, puts);
  ok(mp === 100, 'max pain en el strike de mínimo pago (100)', mp);
}
ok(computeMaxPain([], []) === null, 'sin strikes → null');

// ── Resumen del chain ─────────────────────────────────────────────
{
  const calls = [
    { strike: 100, openInterest: 1000, volume: 200, impliedVolatility: 0.50 },
    { strike: 110, openInterest: 3000, volume: 6000, impliedVolatility: 0.55 }, // inusual: vol >> OI
  ];
  const puts = [
    { strike: 100, openInterest: 2000, volume: 300, impliedVolatility: 0.60 },
    { strike: 90, openInterest: 4000, volume: 100, impliedVolatility: 0.65 },
  ];
  const s = summarizeChain(calls, puts, 101);
  ok(s.call_oi === 4000 && s.put_oi === 6000, 'suma OI por lado', `${s.call_oi}/${s.put_oi}`);
  ok(s.put_call_oi === +(6000 / 4000).toFixed(2), 'put/call por OI', s.put_call_oi);
  ok(s.options_sentiment === 'BEARISH', 'p/c 1.5 → BEARISH', s.options_sentiment);
  ok(s.atm_iv_pct != null && s.atm_iv_pct > 40, 'IV ATM del strike más cercano al spot', s.atm_iv_pct);
  ok(s.key_strikes.length > 0 && s.key_strikes[0].oi >= s.key_strikes[s.key_strikes.length - 1].oi, 'strikes ordenados por OI desc');
  ok(s.unusual_activity === true, 'detecta actividad inusual (vol>1.5·OI)', s.unusual_activity);
  ok(s.max_pain != null, 'max pain calculado');
}
{
  const s = summarizeChain([{ strike: 100, openInterest: 5000, volume: 10 }], [{ strike: 100, openInterest: 1000, volume: 10 }], 100);
  ok(s.options_sentiment === 'BULLISH', 'p/c 0.2 → BULLISH', s.put_call_oi);
}

console.log(failures === 0 ? '\n✓ options: todo en verde' : `\n✗ options: ${failures} fallo(s)`);
process.exit(failures ? 1 : 0);
