// ═══════════════════════════════════════════════════════════════
// /api/signal-backtester — Backtest de una REGLA de señal sobre UN activo.
//
// Complemento del validador de PARES (/api/pairs-validator): aquel juzga
// si dos activos forman un par cointegrado; este juzga si una regla simple
// de entrada/salida sobre un solo ticker tuvo ventaja real — con la misma
// disciplina anti-autoengaño (split cronológico 70/30, re-test out-of-sample,
// caza del trade suertudo que fabrica todo el resultado).
//
// Port de frankenstein-bot/backtest_stock.py (RSI Wilder, retornos de trade,
// base rate, verdicts) a función serverless de Vercel, extendido con:
//   - salida por regla (RSI de salida / cruce inverso) en vez de hold fijo
//   - equity curve mark-to-market para graficar
//   - Sharpe, profit factor, max drawdown por tramo
//   - K-tracking + corrección de Bonferroni (ver HONESTIDAD abajo)
//
// REGLAS SOPORTADAS
//   rule=rsi        LONG:  entra cuando RSI(period) < entryLevel (def. 30),
//                          sale cuando RSI > exitLevel (def. 70).
//                   SHORT: entra cuando RSI > entryLevel (def. 70),
//                          sale cuando RSI < exitLevel (def. 30).
//   rule=sma_cross  LONG:  entra en cruce dorado (SMA fast cruza ARRIBA de
//                          SMA slow), sale en cruce de muerte.
//                   SHORT: al revés.
//
// Señal y fill usan el CIERRE de la misma barra (igual que backtest_stock.py).
// Un trade abierto al final de los datos se cierra al último close y se
// marca exit_reason='fin_de_datos'.
//
// INPUT
//   GET  /api/signal-backtester?ticker=AAPL&rule=rsi[&direction=long
//        &range=2y&rsiPeriod=14&entryLevel=30&exitLevel=70
//        &fast=20&slow=50&maxHold=0&k=1]
//   POST /api/signal-backtester  { "ticker":"AAPL", "rule":"rsi", ... }
//        o arrays crudos (salta Yahoo, útil para tests offline):
//        { "prices":[...], "dates":["YYYY-MM-DD",...], "rule":"rsi", ... }
//
//   maxHold  barras máximas en el trade (0 = sin límite, default).
//   k        variaciones ACUMULADAS que el llamador ha probado (ver abajo).
//
// OUTPUT  JSON con: trades[] (entrada/salida/retorno de cada uno),
//   equity_curve[] (mark-to-market, con índice del split para graficar),
//   metrics por tramo (full / in_sample / out_of_sample: win rate, profit
//   factor, max drawdown, Sharpe, n), benchmark (buy&hold + base rate),
//   honesty (K-tracking + Bonferroni), verdict + explain en español.
//
// HONESTIDAD ESTADÍSTICA (el corazón del proyecto)
//   Cada request evalúa exactamente UNA configuración de regla, así que
//   k_this_request = 1 siempre. La función es stateless (serverless): el
//   LLAMADOR debe llevar la cuenta de cuántas variaciones probó en total y
//   pasarla en `k`. Con eso devolvemos alpha ajustado = 0.05 / k (Bonferroni)
//   y si el p-value naive de la win rate OOS vs base rate sobrevive el
//   ajuste. Probar 20 variaciones y quedarse con la bonita ES el sesgo que
//   este bloque existe para delatar.
//   El verdict (VENTAJA REAL / FRÁGIL / SIN VENTAJA) se juzga SOLO sobre el
//   tramo out-of-sample (últimos 30% de barras), nunca sobre la equity curve
//   in-sample. Un backtest bonito in-sample suele estar sobreajustado.
// ═══════════════════════════════════════════════════════════════

// ───────────────────────── Config ─────────────────────────
const IN_SAMPLE_FRACTION = 0.70;   // mismo corte 70/30 que pairs-validator
const MIN_TOTAL_OBS = 120;         // barras mínimas para juzgar (RSI/SMA + split)
const LOW_SAMPLE = 10;             // menos trades OOS que esto -> baja confianza
const TRADING_DAYS = 252;
const ALPHA = 0.05;                // significancia base antes de Bonferroni

// Verdicts (español, casa QuantDesk — mismo espíritu que pairs-validator)
const VENTAJA_REAL = 'VENTAJA REAL';
const FRAGIL = 'FRAGIL';
const SIN_VENTAJA = 'SIN VENTAJA';
const INSUFICIENTE = 'DATOS INSUFICIENTES';

// ─────────────────── Indicadores ───────────────────

// RSI estándar con suavizado de Wilder. Port 1:1 de compute_rsi de
// backtest_stock.py: primeros `period` valores son null (sin historia),
// semilla con promedio simple y suavizado exponencial después.
function computeRSI(closes, period = 14) {
  const n = closes.length;
  const rsi = new Array(n).fill(null);
  if (n <= period) return rsi;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  const toRsi = (ag, al) => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));

  rsi[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    rsi[i] = toRsi(avgGain, avgLoss);
  }
  return rsi;
}

// SMA simple; null hasta tener `period` cierres.
function computeSMA(closes, period) {
  const n = closes.length;
  const sma = new Array(n).fill(null);
  if (n < period) return sma;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) sma[i] = sum / period;
  }
  return sma;
}

// ─────────────────── Simulación ───────────────────

// Retorno fraccional de un trade (mismo trade_return de backtest_stock.py).
function tradeReturn(entry, exit_, direction) {
  if (direction === 'long') return (exit_ - entry) / entry;
  return (entry - exit_) / entry; // short
}

// Máquina de estados: recorre las barras en orden, una posición a la vez
// (sin piramidar). Devuelve la lista cronológica de trades cerrados.
// entrySignal/exitSignal son funciones (i) => bool sobre el índice de barra.
function runSignal(dates, closes, entrySignal, exitSignal, direction, maxHold) {
  const trades = [];
  let inTrade = false;
  let entryIdx = -1;

  for (let i = 0; i < closes.length; i++) {
    if (!inTrade) {
      if (entrySignal(i) && i < closes.length - 1) {
        inTrade = true;
        entryIdx = i;
      }
      continue;
    }
    const barsHeld = i - entryIdx;
    let reason = null;
    if (exitSignal(i)) reason = 'regla';
    else if (maxHold > 0 && barsHeld >= maxHold) reason = 'max_hold';
    else if (i === closes.length - 1) reason = 'fin_de_datos';
    if (!reason) continue;

    trades.push({
      entry_date: dates[entryIdx],
      exit_date: dates[i],
      entry_idx: entryIdx,
      exit_idx: i,
      entry: closes[entryIdx],
      exit: closes[i],
      ret: tradeReturn(closes[entryIdx], closes[i], direction),
      bars_held: barsHeld,
      exit_reason: reason,
    });
    inTrade = false;
  }
  return trades;
}

// Equity curve mark-to-market sobre TODAS las barras, partiendo de 1.0 con
// reinversión total: dentro de un trade la equity sigue al precio; fuera,
// queda plana. Es la serie que el frontend grafica.
function buildEquityCurve(dates, closes, trades, direction) {
  const n = closes.length;
  const equity = new Array(n).fill(1.0);
  let eq = 1.0;
  let t = 0;
  let entryEq = null;

  for (let i = 0; i < n; i++) {
    const open = t < trades.length ? trades[t] : null;
    if (open && i === open.entry_idx) entryEq = eq;
    if (entryEq !== null && open && i > open.entry_idx) {
      eq = entryEq * (1 + tradeReturn(open.entry, closes[i], direction));
      if (i === open.exit_idx) { entryEq = null; t++; }
    }
    equity[i] = eq;
  }
  return equity.map((e, i) => ({ date: dates[i], equity: +e.toFixed(6) }));
}

// Max drawdown de un tramo de equity (fracción, positiva).
function maxDrawdown(equity) {
  let peak = -Infinity;
  let mdd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

// Sharpe anualizado de los retornos diarios de la equity (incluye días
// planos en cero: es el Sharpe de la ESTRATEGIA, no del tiempo en mercado).
function sharpeRatio(equity) {
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  const n = rets.length;
  if (n < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(varr);
  if (sd === 0) return null;
  return +((mean / sd) * Math.sqrt(TRADING_DAYS)).toFixed(3);
}

// ─────────────────── Métricas por tramo ───────────────────

// Estadísticas agregadas de una lista de trades + su sub-curva de equity.
// Mismo espíritu que summarize() de backtest_stock.py, con profit factor,
// drawdown y Sharpe del tramo. `ret_sin_mejor` responde la pregunta clave:
// ¿sobrevive la ventaja sin el único trade suertudo?
function summarize(trades, equitySlice) {
  const n = trades.length;
  const base = {
    n_trades: n,
    max_drawdown: equitySlice.length ? +maxDrawdown(equitySlice).toFixed(4) : null,
    sharpe: sharpeRatio(equitySlice),
  };
  if (n === 0) return { ...base, win_rate: null, profit_factor: null, total_return: null };

  const wins = trades.filter((t) => t.ret > 0).length;
  const grossWin = trades.reduce((a, t) => a + Math.max(t.ret, 0), 0);
  const grossLoss = trades.reduce((a, t) => a + Math.max(-t.ret, 0), 0);
  const totalRet = trades.reduce((a, t) => a * (1 + t.ret), 1) - 1;
  const best = trades.reduce((a, t) => (t.ret > a.ret ? t : a), trades[0]);
  const retSinMejor = trades.filter((t) => t !== best)
    .reduce((a, t) => a * (1 + t.ret), 1) - 1;

  return {
    ...base,
    wins,
    win_rate: +(wins / n).toFixed(4),
    // null = sin trades perdedores (profit factor infinito); no lo maquillamos.
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : null,
    avg_ret: +(trades.reduce((a, t) => a + t.ret, 0) / n).toFixed(5),
    total_return: +totalRet.toFixed(4),
    best_trade: {
      entry_date: best.entry_date,
      exit_date: best.exit_date,
      ret: +best.ret.toFixed(5),
    },
    ret_sin_mejor: +retSinMejor.toFixed(4),
  };
}

// Base rate (port de base_rate de backtest_stock.py): de TODOS los días del
// tramo con `hold` barras de futuro, ¿qué fracción ganó en nuestra dirección?
// Es el benchmark "comprar al azar" contra el que se mide la win rate.
function baseRate(closes, hold, direction) {
  let wins = 0, total = 0;
  for (let i = 0; i < closes.length - hold; i++) {
    total++;
    if (tradeReturn(closes[i], closes[i + hold], direction) > 0) wins++;
  }
  return { rate: total ? wins / total : null, n_days: total };
}

// ─────────────────── p-value naive + Bonferroni ───────────────────

// CDF normal estándar (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// P-value de una cola: ¿probabilidad de ver >= `wins` aciertos en `n` trades
// si la verdadera tasa fuera el base rate p0? Aproximación normal con
// corrección de continuidad. Es NAIVE a propósito: no sabe cuántas
// variaciones probaste antes — para eso está Bonferroni.
function binomPValue(wins, n, p0) {
  if (n === 0 || p0 == null || p0 <= 0 || p0 >= 1) return null;
  const z = (wins - 0.5 - n * p0) / Math.sqrt(n * p0 * (1 - p0));
  return +(1 - normCdf(z)).toFixed(4);
}

// ─────────────────── Verdict (solo sobre OOS) ───────────────────

// Port de verdict() de backtest_stock.py: el juicio se emite sobre el tramo
// out-of-sample, y la ventaja tiene que sobrevivir sin el mejor trade.
function verdict(oos) {
  if (oos.n_trades === 0) {
    return [SIN_VENTAJA, 'La señal nunca disparó out-of-sample — no hay nada que operar.'];
  }
  const pos = oos.total_return > 0;
  const survives = oos.ret_sin_mejor > 0;
  if (pos && survives) {
    return [VENTAJA_REAL,
      'Out-of-sample es rentable Y sigue positivo quitando el mejor trade — no depende de un solo golpe de suerte.'];
  }
  if (pos && !survives) {
    return [FRAGIL,
      'Out-of-sample es rentable SOLO por el mejor trade; sin él la ventaja se vuelve negativa.'];
  }
  return [SIN_VENTAJA, 'Out-of-sample pierde dinero en el período.'];
}

// ─────────────────── Definición de reglas ───────────────────

// Construye (entrySignal, exitSignal, descripcion) para la regla pedida.
// Ambas señales son CAUSALES: solo miran datos hasta la barra i, así que
// calcular los indicadores sobre la serie completa no filtra futuro.
function buildRule(closes, rule, direction, params) {
  if (rule === 'rsi') {
    const rsi = computeRSI(closes, params.rsiPeriod);
    const entryLevel = params.entryLevel ?? (direction === 'long' ? 30 : 70);
    const exitLevel = params.exitLevel ?? (direction === 'long' ? 70 : 30);
    const entry = direction === 'long'
      ? (i) => rsi[i] !== null && rsi[i] < entryLevel
      : (i) => rsi[i] !== null && rsi[i] > entryLevel;
    const exit_ = direction === 'long'
      ? (i) => rsi[i] !== null && rsi[i] > exitLevel
      : (i) => rsi[i] !== null && rsi[i] < exitLevel;
    const cmp = direction === 'long' ? ['<', '>'] : ['>', '<'];
    return [entry, exit_, {
      type: 'rsi', rsi_period: params.rsiPeriod,
      entry_level: entryLevel, exit_level: exitLevel,
      describe: `RSI(${params.rsiPeriod}) ${cmp[0]} ${entryLevel} entra, ${cmp[1]} ${exitLevel} sale`,
    }];
  }

  if (rule === 'sma_cross') {
    const fast = computeSMA(closes, params.fast);
    const slow = computeSMA(closes, params.slow);
    const crossUp = (i) => i > 0 && fast[i - 1] !== null && slow[i - 1] !== null &&
      fast[i] !== null && slow[i] !== null &&
      fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossDown = (i) => i > 0 && fast[i - 1] !== null && slow[i - 1] !== null &&
      fast[i] !== null && slow[i] !== null &&
      fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    const [entry, exit_] = direction === 'long' ? [crossUp, crossDown] : [crossDown, crossUp];
    return [entry, exit_, {
      type: 'sma_cross', fast: params.fast, slow: params.slow,
      describe: `SMA(${params.fast}) cruza ${direction === 'long' ? 'arriba' : 'abajo'} de SMA(${params.slow}) entra, cruce inverso sale`,
    }];
  }

  throw new Error(`Regla desconocida: '${rule}'. Usa 'rsi' o 'sma_cross'.`);
}

// ─────────────────── El backtest completo ───────────────────

// Corre la regla sobre la serie y arma el payload entero. Separado del
// handler HTTP para poder testearlo con arrays sintéticos (export abajo).
function backtest(dates, closes, opts) {
  const { rule, direction, params, maxHold, kCumulative } = opts;

  if (closes.length < MIN_TOTAL_OBS) {
    return {
      verdict: INSUFICIENTE,
      explain: `Solo ${closes.length} barras (< ${MIN_TOTAL_OBS}); no hay datos para juzgar la regla con honestidad.`,
      n_bars: closes.length,
    };
  }

  const [entrySignal, exitSignal, ruleInfo] = buildRule(closes, rule, direction, params);
  const trades = runSignal(dates, closes, entrySignal, exitSignal, direction, maxHold);

  // Split cronológico 70/30 POR BARRA. Los indicadores son causales, así que
  // se calculan una sola vez sobre la serie completa sin fuga de futuro; cada
  // trade se asigna a su tramo por la barra de ENTRADA.
  const splitIdx = Math.floor(closes.length * IN_SAMPLE_FRACTION);
  const isTrades = trades.filter((t) => t.entry_idx < splitIdx);
  const oosTrades = trades.filter((t) => t.entry_idx >= splitIdx);

  const equityCurve = buildEquityCurve(dates, closes, trades, direction);
  const eqValues = equityCurve.map((p) => p.equity);
  // Sub-curvas renormalizadas para que drawdown/Sharpe de cada tramo no
  // arrastren lo que pasó en el otro.
  const eqIs = eqValues.slice(0, splitIdx);
  const eqOosBase = eqValues[splitIdx - 1] || 1;
  const eqOos = eqValues.slice(splitIdx).map((e) => e / eqOosBase);

  const full = summarize(trades, eqValues);
  const inSample = summarize(isTrades, eqIs);
  const outOfSample = summarize(oosTrades, eqOos);

  // Benchmark: buy & hold del tramo OOS + base rate al hold mediano.
  const oosCloses = closes.slice(splitIdx);
  const buyHoldOos = oosCloses.length > 1
    ? tradeReturn(oosCloses[0], oosCloses[oosCloses.length - 1], direction)
    : null;
  const holds = trades.map((t) => t.bars_held).sort((a, b) => a - b);
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)] : null;
  const br = medianHold ? baseRate(oosCloses, medianHold, direction) : { rate: null, n_days: 0 };

  // Honestidad: p-value naive de la win rate OOS vs base rate, y si
  // sobrevive Bonferroni con las K variaciones que el llamador acumuló.
  const naiveP = outOfSample.n_trades > 0 && br.rate != null
    ? binomPValue(outOfSample.wins, outOfSample.n_trades, br.rate)
    : null;
  const adjustedAlpha = ALPHA / kCumulative;

  const warnings = [];
  if (oosTrades.length > 0 && oosTrades.length < LOW_SAMPLE) {
    warnings.push(`Solo ${oosTrades.length} trades out-of-sample — muestra chica, baja confianza.`);
  }
  if (outOfSample.n_trades > 0 && br.rate != null && outOfSample.win_rate < br.rate) {
    warnings.push(`La win rate OOS (${(outOfSample.win_rate * 100).toFixed(1)}%) va DEBAJO del base rate (${(br.rate * 100).toFixed(1)}%): predice dirección peor que comprar al azar; cualquier ganancia viene del TAMAÑO de los winners, no de acertar más.`);
  }
  if (trades.some((t) => t.exit_reason === 'fin_de_datos')) {
    warnings.push('El último trade se cerró forzado al final de los datos (fin_de_datos), no por la regla.');
  }
  if (naiveP != null && naiveP < ALPHA && naiveP >= adjustedAlpha) {
    warnings.push(`El p-value (${naiveP}) parece significativo a solas, pero NO sobrevive Bonferroni con k=${kCumulative} variaciones probadas (umbral ${adjustedAlpha.toFixed(4)}).`);
  }

  const [label, why] = verdict(outOfSample);

  return {
    rule: { ...ruleInfo, direction, max_hold: maxHold || null },
    n_bars: closes.length,
    date_range: { start: dates[0], end: dates[dates.length - 1] },
    split: {
      fraction: IN_SAMPLE_FRACTION,
      index: splitIdx,
      date: dates[splitIdx],
      in_sample_bars: splitIdx,
      oos_bars: closes.length - splitIdx,
    },
    n_trades: trades.length,
    trades: trades.map((t) => ({
      entry_date: t.entry_date,
      exit_date: t.exit_date,
      entry: +t.entry.toFixed(4),
      exit: +t.exit.toFixed(4),
      ret: +t.ret.toFixed(5),
      bars_held: t.bars_held,
      exit_reason: t.exit_reason,
      sample: t.entry_idx < splitIdx ? 'IS' : 'OOS',
    })),
    equity_curve: equityCurve,
    metrics: { full, in_sample: inSample, out_of_sample: outOfSample },
    benchmark: {
      buy_hold_oos: buyHoldOos != null ? +buyHoldOos.toFixed(4) : null,
      base_rate_oos: br.rate != null ? +br.rate.toFixed(4) : null,
      base_rate_n_days: br.n_days,
      median_hold_bars: medianHold,
    },
    honesty: {
      k_this_request: 1,   // cada request evalúa UNA sola configuración
      k_cumulative: kCumulative,
      naive_p_value: naiveP,
      bonferroni: {
        alpha: ALPHA,
        adjusted_alpha: +adjustedAlpha.toFixed(6),
        significant_naive: naiveP != null ? naiveP < ALPHA : null,
        significant_bonferroni: naiveP != null ? naiveP < adjustedAlpha : null,
      },
      warnings,
    },
    verdict: label,
    explain: why,
    config: {
      in_sample_fraction: IN_SAMPLE_FRACTION,
      min_total_obs: MIN_TOTAL_OBS,
      low_sample_trades: LOW_SAMPLE,
      alpha: ALPHA,
    },
  };
}

// ─────────────────── Yahoo price fetch ───────────────────

// Cryptos comunes van con sufijo -USD en Yahoo (mismo mapeo que backtest.js).
const CRYPTO = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT'];

// Baja cierres diarios de Yahoo y devuelve { dates, closes } alineados,
// oldest-first, sin nulls (mismo plumbing que correlations.js).
async function fetchYahoo(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [];
  const raw = result.indicators?.quote?.[0]?.close || [];
  const dates = [];
  const closes = [];
  for (let i = 0; i < ts.length; i++) {
    if (raw[i] == null || raw[i] <= 0) continue;
    dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    closes.push(raw[i]);
  }
  return closes.length ? { dates, closes } : null;
}

// ─────────────────── HTTP handler ───────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});

  const rule = (src.rule || 'rsi').toString().toLowerCase();
  const direction = (src.direction || 'long').toString().toLowerCase();
  const range = (src.range || '2y').toString();
  const maxHold = Math.max(0, parseInt(src.maxHold, 10) || 0);
  const kCumulative = Math.max(1, parseInt(src.k, 10) || 1);

  const clamp = (v, lo, hi, def) => {
    const x = parseInt(v, 10);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def;
  };
  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const params = {
    rsiPeriod: clamp(src.rsiPeriod, 2, 100, 14),
    entryLevel: num(src.entryLevel),
    exitLevel: num(src.exitLevel),
    fast: clamp(src.fast, 2, 200, 20),
    slow: clamp(src.slow, 3, 400, 50),
  };

  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ error: "direction debe ser 'long' o 'short'." });
  }
  if (!['rsi', 'sma_cross'].includes(rule)) {
    return res.status(400).json({ error: "rule debe ser 'rsi' o 'sma_cross'.", usage: '/api/signal-backtester?ticker=AAPL&rule=rsi' });
  }
  if (rule === 'sma_cross' && params.fast >= params.slow) {
    return res.status(400).json({ error: `fast (${params.fast}) debe ser menor que slow (${params.slow}).` });
  }

  try {
    let dates, closes, ticker, source;

    // ── Modo arrays crudos: el llamador trae los precios (tests offline). ──
    if (Array.isArray(src.prices)) {
      closes = src.prices.map(Number).filter((p) => Number.isFinite(p) && p > 0);
      dates = Array.isArray(src.dates) && src.dates.length === closes.length
        ? src.dates.map(String)
        : closes.map((_, i) => String(i));
      ticker = (src.ticker || 'RAW').toString().toUpperCase();
      source = 'raw arrays';
    } else {
      // ── Modo ticker: Yahoo daily closes. ──
      ticker = (src.ticker || '').toString().trim().toUpperCase();
      if (!ticker) {
        return res.status(400).json({
          error: 'Falta el ticker (o un array prices).',
          usage: '/api/signal-backtester?ticker=AAPL&rule=rsi&range=2y',
        });
      }
      const symbol = CRYPTO.includes(ticker) ? `${ticker}-USD` : ticker;
      const series = await fetchYahoo(symbol, range);
      if (!series) return res.status(404).json({ error: `Sin historial de precios para ${ticker}` });
      ({ dates, closes } = series);
      source = `Yahoo Finance (${range} daily)`;
    }

    const result = backtest(dates, closes, { rule, direction, params, maxHold, kCumulative });
    return res.status(200).json({
      ticker,
      source,
      ...result,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown'),
    });
  }
}

// Named exports para unit testing (ignorados por el runtime de Vercel).
export {
  computeRSI, computeSMA, tradeReturn, runSignal, buildEquityCurve,
  maxDrawdown, sharpeRatio, summarize, baseRate, binomPValue, normCdf,
  verdict, buildRule, backtest,
  VENTAJA_REAL, FRAGIL, SIN_VENTAJA, INSUFICIENTE,
};
