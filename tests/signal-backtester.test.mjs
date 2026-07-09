// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/signal-backtester — reglas macd, bollinger y breakout.
//
// Mismo patrón que el test de paridad del RSI (PR #39): datos sintéticos
// deterministas + una implementación de referencia independiente escrita
// aquí mismo, comparadas dígito a dígito contra las funciones del endpoint.
// Sin framework: correr con `node tests/signal-backtester.test.mjs`;
// sale con código ≠ 0 si algo falla.
// ═══════════════════════════════════════════════════════════════

import {
  computeEMA, computeMACD, computeRollingStd, rollingExtremePrev,
  buildRule, runSignal, backtest,
} from '../api/signal-backtester.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) { console.log('  PASS', name); }
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function approx(a, b, eps = 1e-9) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= eps;
}
function arraysApprox(a, b, eps = 1e-9) {
  if (a.length !== b.length) return 'len ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) {
    if (!approx(a[i], b[i], eps)) return 'idx ' + i + ': ' + a[i] + ' vs ' + b[i];
  }
  return true;
}

// PRNG determinista (LCG) — misma serie sintética en cada corrida.
function makeLCG(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Serie tipo random walk con drift + ondas, 300 barras — suficiente para
// que MACD/Bollinger/breakout disparen varias veces.
const rand = makeLCG(42);
const N = 300;
const closes = [];
let px = 100;
for (let i = 0; i < N; i++) {
  px *= 1 + (rand() - 0.5) * 0.03 + 0.0004;
  closes.push(px + 6 * Math.sin(i / 11));
}
const dates = closes.map((_, i) => {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000);
  return d.toISOString().slice(0, 10);
});

// ─────────────────── MACD: paridad vs referencia ───────────────────
console.log('rule=macd');
{
  // Referencia independiente: EMA con semilla SMA, escrita desde cero.
  function refEMA(vals, p) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < p) return out;
    let seed = 0;
    for (let i = 0; i < p; i++) seed += vals[i];
    out[p - 1] = seed / p;
    const k = 2 / (p + 1);
    for (let i = p; i < vals.length; i++) out[i] = (vals[i] - out[i - 1]) * k + out[i - 1];
    return out;
  }
  const ema12 = refEMA(closes, 12);
  const ema26 = refEMA(closes, 26);
  const refMacd = closes.map((_, i) =>
    (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null);
  const refSignal = new Array(N).fill(null);
  refEMA(refMacd.slice(25), 9).forEach((v, j) => { if (v !== null) refSignal[25 + j] = v; });

  ok(arraysApprox(computeEMA(closes, 12), ema12) === true, 'EMA(12) paridad vs referencia', arraysApprox(computeEMA(closes, 12), ema12));
  const { macd, signal } = computeMACD(closes, 12, 26, 9);
  ok(arraysApprox(macd, refMacd) === true, 'línea MACD paridad', arraysApprox(macd, refMacd));
  ok(arraysApprox(signal, refSignal) === true, 'señal MACD paridad', arraysApprox(signal, refSignal));
  ok(macd[24] === null && macd[25] !== null, 'MACD null hasta slow-1', macd[24] + ' / ' + macd[25]);
  ok(signal[32] === null && signal[33] !== null, 'señal null hasta slow-1+signal-1', signal[32] + ' / ' + signal[33]);

  // Los trades de la regla salen exactamente de los cruces de la referencia.
  const [entry, exit_] = buildRule(closes, 'macd', 'long', { fast: 12, slow: 26, signalPeriod: 9 });
  const trades = runSignal(dates, closes, entry, exit_, 'long', 0);
  ok(trades.length > 0, 'la regla dispara en la serie sintética', trades.length);
  const isCrossUp = (i) => refMacd[i - 1] !== null && refSignal[i - 1] !== null &&
    refMacd[i - 1] <= refSignal[i - 1] && refMacd[i] > refSignal[i];
  const isCrossDown = (i) => refMacd[i - 1] !== null && refSignal[i - 1] !== null &&
    refMacd[i - 1] >= refSignal[i - 1] && refMacd[i] < refSignal[i];
  ok(trades.every((t) => isCrossUp(t.entry_idx)), 'toda entrada es un cruce arriba de la señal');
  ok(trades.filter((t) => t.exit_reason === 'regla').every((t) => isCrossDown(t.exit_idx)),
    'toda salida por regla es el cruce inverso');
  ok(trades.every((t) => t.exit_idx > t.entry_idx), 'salida siempre después de la entrada');

  // SHORT es el espejo: entra en cruce abajo.
  const [sEntry] = buildRule(closes, 'macd', 'short', { fast: 12, slow: 26, signalPeriod: 9 });
  const sTrades = runSignal(dates, closes, sEntry, exit_, 'short', 0);
  ok(sTrades.every((t) => isCrossDown(t.entry_idx)), 'short: toda entrada es un cruce abajo');
}

// ─────────────────── Bollinger: paridad + escenario a mano ───────────────────
console.log('rule=bollinger');
{
  // Paridad de la std rodante (población) vs referencia independiente.
  const refStd = closes.map((_, i) => {
    if (i < 19) return null;
    const win = closes.slice(i - 19, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / 20;
    return Math.sqrt(win.reduce((a, v) => a + (v - mean) ** 2, 0) / 20);
  });
  ok(arraysApprox(computeRollingStd(closes, 20), refStd) === true, 'std rodante paridad (población)',
    arraysApprox(computeRollingStd(closes, 20), refStd));

  // Escenario construido a mano: plano en 100, un desplome bajo la banda
  // inferior, recuperación hasta la media. period=5, mult=2.
  //  idx:      0    1    2    3    4    5    6    7
  const bcl = [100, 100, 100, 100, 100, 90, 94, 100];
  const bdt = bcl.map((_, i) => 'D' + i);
  // En idx 5: SMA5=98, std=√16=4, banda inf = 98−2·4=90 → 90 NO es < 90 (sin entrada).
  // Por eso mult=1.9: banda inf = 90.4 → 90 < 90.4 ENTRA en idx 5.
  // En idx 6: SMA5 = (100+100+100+90+94)/5 = 96.8 → 94 < 96.8, sigue dentro.
  // En idx 7: SMA5 = (100+100+90+94+100)/5 = 96.8 → 100 ≥ 96.8 SALE (toca la media).
  const [entry, exit_] = buildRule(bcl, 'bollinger', 'long', { period: 5, mult: 1.9 });
  const trades = runSignal(bdt, bcl, entry, exit_, 'long', 0);
  ok(trades.length === 1, 'exactamente un trade en el escenario a mano', JSON.stringify(trades));
  ok(trades[0] && trades[0].entry_idx === 5, 'entra en la barra que cierra bajo la banda inferior', trades[0] && trades[0].entry_idx);
  ok(trades[0] && trades[0].exit_idx === 7, 'sale en la barra que toca la media', trades[0] && trades[0].exit_idx);
  ok(trades[0] && approx(trades[0].ret, (100 - 90) / 90, 1e-12), 'retorno del trade correcto', trades[0] && trades[0].ret);

  // Serie plana: std=0 → banda inferior = media → nunca entra.
  const flat = new Array(30).fill(100);
  const [fEntry, fExit] = buildRule(flat, 'bollinger', 'long', { period: 5, mult: 2 });
  ok(runSignal(flat.map((_, i) => 'F' + i), flat, fEntry, fExit, 'long', 0).length === 0,
    'serie plana: la banda no dispara nunca');

  // SHORT espejo: pico sobre la banda superior, vuelve a la media.
  const scl = [100, 100, 100, 100, 100, 110, 106, 100];
  const [sEntry, sExit] = buildRule(scl, 'bollinger', 'short', { period: 5, mult: 1.9 });
  const sTrades = runSignal(bdt, scl, sEntry, sExit, 'short', 0);
  ok(sTrades.length === 1 && sTrades[0].entry_idx === 5 && sTrades[0].exit_idx === 7,
    'short: entra sobre la banda superior y sale en la media', JSON.stringify(sTrades));
  ok(sTrades[0] && approx(sTrades[0].ret, (110 - 100) / 110, 1e-12), 'short: retorno correcto', sTrades[0] && sTrades[0].ret);
}

// ─────────────────── Breakout: escenario a mano + paridad de extremos ───────────────────
console.log('rule=breakout');
{
  // Paridad del extremo rodante previo vs referencia.
  const refHi = closes.map((_, i) => i < 20 ? null : Math.max(...closes.slice(i - 20, i)));
  ok(arraysApprox(rollingExtremePrev(closes, 20, true), refHi) === true, 'máximo previo rodante paridad',
    arraysApprox(rollingExtremePrev(closes, 20, true), refHi));

  // Escenario a mano: lookback=4 → salida con mínimo de 2 días previos.
  //  idx:      0   1   2   3   4    5   6   7   8   9
  const bcl = [10, 10, 10, 10, 10, 11, 12, 13, 12.5, 9];
  const bdt = bcl.map((_, i) => 'D' + i);
  // idx 4: max(prev 4)=10, close 10 NO rompe (> estricto).
  // idx 5: max(idx1..4)=10, close 11 > 10 ENTRA.
  // idx 9: min(prev 2)= min(13, 12.5)=12.5, close 9 < 12.5 SALE.
  const [entry, exit_] = buildRule(bcl, 'breakout', 'long', { lookback: 4 });
  const trades = runSignal(bdt, bcl, entry, exit_, 'long', 0);
  ok(trades.length === 1, 'exactamente un trade en el escenario a mano', JSON.stringify(trades));
  ok(trades[0] && trades[0].entry_idx === 5, 'entra en la barra que rompe el máximo de 4 días', trades[0] && trades[0].entry_idx);
  ok(trades[0] && trades[0].exit_idx === 9, 'sale en la barra que cierra bajo el mínimo de 2 días', trades[0] && trades[0].exit_idx);
  ok(trades[0] && approx(trades[0].ret, (9 - 11) / 11, 1e-12), 'retorno del trade correcto', trades[0] && trades[0].ret);

  // Igualar el máximo NO es romperlo.
  const eq = [10, 10, 10, 10, 10, 10, 10, 10];
  const [eEntry, eExit] = buildRule(eq, 'breakout', 'long', { lookback: 4 });
  ok(runSignal(eq.map((_, i) => 'E' + i), eq, eEntry, eExit, 'long', 0).length === 0,
    'igualar el máximo previo no dispara entrada');

  // SHORT espejo: rompe el mínimo entra, cierra sobre el máximo de N/2 sale.
  const scl = [10, 10, 10, 10, 10, 9, 8, 7, 7.5, 11];
  const [sEntry, sExit] = buildRule(scl, 'breakout', 'short', { lookback: 4 });
  const sTrades = runSignal(scl.map((_, i) => 'S' + i), scl, sEntry, sExit, 'short', 0);
  ok(sTrades.length === 1 && sTrades[0].entry_idx === 5 && sTrades[0].exit_idx === 9,
    'short: rompe el mínimo entra y sale sobre el máximo de 2 días', JSON.stringify(sTrades));
}

// ─────────────────── Contrato de backtest() intacto para las 3 reglas ───────────────────
console.log('contrato de output');
{
  for (const [rule, params] of [
    ['macd', { fast: 12, slow: 26, signalPeriod: 9 }],
    ['bollinger', { period: 20, mult: 2 }],
    ['breakout', { lookback: 20 }],
  ]) {
    const r = backtest(dates, closes, { rule, direction: 'long', params, maxHold: 0, kCumulative: 3 });
    const oosOk = r.metrics && ['full', 'in_sample', 'out_of_sample'].every((k) =>
      r.metrics[k] && 'win_rate' in r.metrics[k] && 'max_drawdown' in r.metrics[k] && 'sharpe' in r.metrics[k]);
    ok(Array.isArray(r.trades) && Array.isArray(r.equity_curve) && r.equity_curve.length === N &&
       r.split && r.split.index === Math.floor(N * 0.7) && oosOk &&
       r.benchmark && 'buy_hold_oos' in r.benchmark &&
       r.honesty && r.honesty.k_cumulative === 3 &&
       r.honesty.bonferroni && approx(r.honesty.bonferroni.adjusted_alpha, 0.05 / 3, 1e-6) &&
       Array.isArray(r.honesty.warnings) && typeof r.verdict === 'string' && typeof r.explain === 'string',
      rule + ': contrato completo (trades, equity_curve, métricas por tramo, honestidad)',
      JSON.stringify({ verdict: r.verdict, n_trades: r.n_trades }));
    ok(r.equity_curve[0].equity === 1, rule + ': equity curve parte de 1.0', r.equity_curve[0].equity);
  }
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
