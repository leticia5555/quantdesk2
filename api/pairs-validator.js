// ═══════════════════════════════════════════════════════════════
// /api/pairs-validator — A skeptic for mean-reversion / stat-arb PAIRS.
//
// Where most screens show a pretty in-sample spread chart, this judges
// whether a pair is *actually* tradeable through three gates:
//
//   Puerta A  COINTEGRACIÓN (Engle-Granger). Regress Y on X by OLS; the
//             spread is the residual. Run an Augmented Dickey-Fuller test
//             on it. Not stationary -> no pair, just two random walks.
//
//   Puerta B  VIDA MEDIA OU. Fit the discrete Ornstein-Uhlenbeck process
//             d(spread)_t = a + b*spread_{t-1} + e_t  ->  theta = -b,
//             half-life = ln(2)/theta. Cointegrated but reverting too slow
//             (or theta <= 0) = untradeable.
//
//   Puerta C  RE-COINTEGRACIÓN OOS. Split 70/30 chronologically, re-run the
//             ADF + half-life on the UNSEEN 30%. Holds in-sample but dies
//             out-of-sample -> overfit.
//
// Port of frankenstein-bot/pairs_validator.py (stdlib-only) to a Vercel
// serverless JS function. Same math, same Spanish verdicts.
//
// INPUT
//   GET  /api/pairs-validator?x=GOOGL&y=AMZN[&range=2y&raw=0]
//   POST /api/pairs-validator   { "x":"GOOGL", "y":"AMZN", "range":"2y" }
//        or raw price arrays (skip Yahoo):
//        { "pricesX":[...], "pricesY":[...], "xLabel":"GOOGL", "yLabel":"AMZN" }
//
//   x / y      ticker symbols (Y = target, X = hedge). Yahoo daily closes.
//   range      Yahoo range for ticker mode (default '2y'). e.g. 1y, 2y, 5y.
//   raw=1      use raw prices instead of log prices.
//   pricesX/pricesY  raw aligned price arrays (bypass Yahoo entirely).
//
// OUTPUT  JSON with:
//   gate_verdict      technical tier (PAR VALIDO / REVERSION LENTA /
//                     SIN COINTEGRACION / SOBREAJUSTADO / INSUFICIENTE)
//   verdict           user-facing tier (VENTAJA REAL / MARGINAL / RUIDO /
//                     SOBREAJUSTADO / DATOS INSUFICIENTES)
//   explain           one-line Spanish explanation naming the gate it failed
//   cointegration     Engle-Granger / ADF in-sample block
//   ou_half_life      OU half-life block (in-sample)
//   oos               out-of-sample re-test block
//   detail            raw numbers (hedge beta/alpha, z-score now, etc.)
// ═══════════════════════════════════════════════════════════════

// ───────────────────────── Config ─────────────────────────
const IN_SAMPLE_FRACTION = 0.70;
const ADF_ALPHA = 0.05;            // stationary if ADF stat < crit at this level
const MIN_TOTAL_OBS = 60;          // min aligned obs to judge at all
const MIN_SPLIT_OBS = 25;          // min obs per split to trust an OOS re-test
const MAX_TRADEABLE_HALFLIFE = 120.0; // bars; longer = real but too slow to trade

// MacKinnon (2010) asymptotic ADF critical values (constant, no trend).
const ADF_CRIT = { 0.01: -3.43, 0.05: -2.86, 0.10: -2.57 };

// ─────────────── Verdict tiers ───────────────
// Technical (matches pairs_validator.py house style)
const SIN_COINTEGRACION = 'SIN COINTEGRACION';
const REVERSION_LENTA = 'REVERSION LENTA';
const SOBREAJUSTADO = 'SOBREAJUSTADO';
const INSUFICIENTE = 'INSUFICIENTE';
const PAR_VALIDO = 'PAR VALIDO';

// User-facing mapping (the tiers requested for QuantDesk)
const USER_TIER = {
  [PAR_VALIDO]: 'VENTAJA REAL',
  [REVERSION_LENTA]: 'MARGINAL',
  [SIN_COINTEGRACION]: 'RUIDO',
  [SOBREAJUSTADO]: 'SOBREAJUSTADO',
  [INSUFICIENTE]: 'DATOS INSUFICIENTES',
};

// ───────────────────── Linear algebra (OLS) ─────────────────────

// Simple OLS of y on x with intercept. Returns [alpha, beta].
function ols(y, x) {
  const n = x.length;
  if (n === 0 || n !== y.length) throw new Error('ols: empty or mismatched inputs');
  const mx = x.reduce((a, v) => a + v, 0) / n;
  const my = y.reduce((a, v) => a + v, 0) / n;
  let sxx = 0;
  for (const xi of x) sxx += (xi - mx) ** 2;
  if (sxx === 0) throw new Error('ols: x has zero variance');
  let sxy = 0;
  for (let i = 0; i < n; i++) sxy += (x[i] - mx) * (y[i] - my);
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  return [alpha, beta];
}

// OLS of y on multiple regressors via normal equations + Gaussian elimination.
// X is an array of rows (each row an array of regressor values).
function olsMulti(y, X) {
  const n = X.length;
  if (n === 0) throw new Error('olsMulti: no rows');
  const k = X[0].length;
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    const yi = y[i];
    for (let a = 0; a < k; a++) {
      xty[a] += xi[a] * yi;
      const xa = xi[a];
      const row = xtx[a];
      for (let b = 0; b < k; b++) row[b] += xa * xi[b];
    }
  }
  return solve(xtx, xty);
}

// Solve A z = b by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('solve: singular matrix');
    [M[col], M[piv]] = [M[piv], M[col]];
    const pivval = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / pivval;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]); // M[i][n] / M[i][i]
}

// ─────────────────── Augmented Dickey-Fuller ───────────────────

// Build [targets, rows] for an ADF regression at a given lag.
// Row = [1, y_{t-1}, dy_{t-1}, ..., dy_{t-lag}]; target = dy_t.
function adfDesign(y, dy, lag) {
  const targets = [];
  const rows = [];
  for (let j = lag; j < dy.length; j++) {
    const reg = [1.0, y[j]]; // const + level lag (y_{t-1}, t = j+1)
    for (let i = 1; i <= lag; i++) reg.push(dy[j - i]);
    rows.push(reg);
    targets.push(dy[j]);
  }
  if (rows.length === 0 || rows.length < rows[0].length + 5) return [null, null];
  return [targets, rows];
}

// Schwarz BIC for an OLS fit, used to pick the ADF lag length.
function bic(targets, rows, coeffs) {
  const nobs = rows.length;
  const k = coeffs.length;
  let ssr = 0;
  for (let i = 0; i < nobs; i++) {
    let pred = 0;
    for (let a = 0; a < k; a++) pred += coeffs[a] * rows[i][a];
    ssr += (targets[i] - pred) ** 2;
  }
  if (ssr <= 0 || nobs <= 0) return -Infinity;
  return nobs * Math.log(ssr / nobs) + k * Math.log(nobs);
}

// Coarse ADF p-value by interpolating the MacKinnon critical points.
// Not a full response surface; monotonic and honest-ish. More negative -> smaller p.
function adfPvalue(stat) {
  // pts sorted by crit ascending: [[0.01,-3.43],[0.05,-2.86],[0.10,-2.57]]
  const pts = Object.entries(ADF_CRIT)
    .map(([p, c]) => [parseFloat(p), c])
    .sort((a, b) => a[1] - b[1]);
  if (stat <= pts[0][1]) return pts[0][0]; // at/beyond 1% crit -> ~0.01
  if (stat >= pts[pts.length - 1][1]) {
    const c10 = pts[pts.length - 1][1];
    const frac = c10 !== 0 ? Math.min(Math.max(stat / c10, 0.0), 1.0) : 1.0;
    return 0.10 + (1.0 - frac) * 0.80;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [pLo, cLo] = pts[i];
    const [pHi, cHi] = pts[i + 1];
    if (cLo <= stat && stat <= cHi) {
      if (cHi === cLo) return pHi;
      const w = (stat - cLo) / (cHi - cLo);
      return pLo + w * (pHi - pLo);
    }
  }
  return 0.50;
}

// Augmented Dickey-Fuller test on a series, with a constant.
// Returns { stat, crit, p_approx, n_used, lag, stationary } or null if too short.
function adfTest(series, maxLag = null) {
  const y = [...series];
  const n = y.length;
  if (n < 20) return null;
  if (maxLag === null) {
    maxLag = Math.floor(Math.min(12 * Math.pow(n / 100.0, 0.25), Math.max(1, Math.floor(n / 5))));
    maxLag = Math.max(1, maxLag);
  }

  const dy = [];
  for (let i = 1; i < n; i++) dy.push(y[i] - y[i - 1]);

  // Pick the lag (0..maxLag) that minimizes BIC.
  let best = null; // [bic, lag, targets, rows, coeffs]
  for (let lag = 0; lag <= maxLag; lag++) {
    const [targets, rows] = adfDesign(y, dy, lag);
    if (targets === null) continue;
    let coeffs;
    try {
      coeffs = olsMulti(targets, rows);
    } catch (e) {
      continue;
    }
    const b = bic(targets, rows, coeffs);
    if (best === null || b < best[0]) best = [b, lag, targets, rows, coeffs];
  }

  if (best === null) return null;
  const [, lag, targets, rows, coeffs] = best;
  const k = coeffs.length;
  const nobs = rows.length;

  let ssr = 0;
  for (let i = 0; i < nobs; i++) {
    let pred = 0;
    for (let a = 0; a < k; a++) pred += coeffs[a] * rows[i][a];
    ssr += (targets[i] - pred) ** 2;
  }
  const dof = nobs - k;
  if (dof <= 0) return null;
  const sigma2 = ssr / dof;

  // (X'X)^-1 diagonal for gamma (index 1): solve X'X z = e1.
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < nobs; i++) {
    const xi = rows[i];
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) xtx[a][b] += xi[a] * xi[b];
    }
  }
  const e1 = Array.from({ length: k }, (_, a) => (a === 1 ? 1.0 : 0.0));
  let invCol;
  try {
    invCol = solve(xtx, e1);
  } catch (e) {
    return null;
  }
  const varGamma = sigma2 * invCol[1];
  if (varGamma <= 0) return null;
  const seGamma = Math.sqrt(varGamma);
  const gamma = coeffs[1];
  const stat = gamma / seGamma;

  const crit = ADF_CRIT[ADF_ALPHA];
  return {
    stat,
    crit,
    p_approx: adfPvalue(stat),
    n_used: nobs,
    lag,
    stationary: stat < crit,
  };
}

// ─────────────────── Ornstein-Uhlenbeck half-life ───────────────────

// Estimate OU mean-reversion half-life (in observations).
// d_t = a + b*spread_{t-1} + e_t -> theta = -b, half_life = ln(2)/theta.
function ouHalfLife(spread) {
  const n = spread.length;
  if (n < 10) return null;
  const lagged = spread.slice(0, -1);
  const dz = [];
  for (let i = 1; i < n; i++) dz.push(spread[i] - spread[i - 1]);
  let b;
  try {
    [, b] = ols(dz, lagged);
  } catch (e) {
    return null;
  }
  const theta = -b;
  if (theta <= 0) {
    // b >= 0: shocks don't decay -> not mean-reverting.
    return { theta, b, half_life: null, tradeable: false };
  }
  const halfLife = Math.log(2.0) / theta;
  const tradeable = halfLife > 0.0 && halfLife <= MAX_TRADEABLE_HALFLIFE;
  return { theta, b, half_life: halfLife, tradeable };
}

// ─────────────────── Spread construction ───────────────────

// Engle-Granger step 1: spread = y - (alpha + beta*x) using OLS hedge ratio.
function buildSpread(xs, ys) {
  const [alpha, beta] = ols(ys, xs);
  const spread = xs.map((xi, i) => ys[i] - (alpha + beta * xi));
  return [spread, alpha, beta];
}

// Current z-score of the spread (how stretched the pair is right now).
function zscoreLast(spread, lookback = null) {
  const s = lookback === null ? spread : spread.slice(-lookback);
  const n = s.length;
  if (n < 2) return null;
  const m = s.reduce((a, v) => a + v, 0) / n;
  let varr = 0;
  for (const v of s) varr += (v - m) ** 2;
  varr /= n - 1;
  if (varr <= 0) return null;
  return (spread[spread.length - 1] - m) / Math.sqrt(varr);
}

// Convert a price series to log prices (guarding non-positive values).
function toLog(series) {
  if (series.some((v) => v <= 0)) return [...series];
  return series.map((v) => Math.log(v));
}

// ─────────────────── The full pair verdict ───────────────────

// Run all three gates on a pair and return a full result object.
// { final, explain, detail:{...} }  — mirrors pairs_validator.validate_pair.
function validatePair(xsIn, ysIn, useLog = true) {
  let xs = xsIn;
  let ys = ysIn;
  if (useLog) {
    xs = toLog(xs);
    ys = toLog(ys);
  }

  const n = xs.length;
  const detail = {};

  if (n < MIN_TOTAL_OBS) {
    return {
      final: INSUFICIENTE,
      explain: `Solo ${n} observaciones alineadas (< ${MIN_TOTAL_OBS}); no hay datos para juzgar el par con honestidad.`,
      detail,
    };
  }

  // Full-sample spread (hedge ratio + current z-score reporting).
  const [spreadFull, alpha, beta] = buildSpread(xs, ys);
  detail.alpha = alpha;
  detail.beta = beta;
  detail.z_now = zscoreLast(spreadFull);

  // Chronological split.
  const split = Math.floor(n * IN_SAMPLE_FRACTION);
  const xsIs = xs.slice(0, split);
  const ysIs = ys.slice(0, split);
  const xsOos = xs.slice(split);
  const ysOos = ys.slice(split);

  const enoughSplit = xsIs.length >= MIN_SPLIT_OBS && xsOos.length >= MIN_SPLIT_OBS;

  // Gate A: in-sample cointegration.
  const [spreadIs, , bIs] = buildSpread(xsIs, ysIs);
  const adfIs = adfTest(spreadIs);
  detail.adf_in_sample = adfIs;
  detail.beta_in_sample = bIs;

  if (adfIs === null) {
    return {
      final: INSUFICIENTE,
      explain: 'No se pudo correr la prueba ADF in-sample (muy pocos datos tras el split).',
      detail,
    };
  }

  const pIs = adfIs.p_approx;
  if (!adfIs.stationary) {
    return {
      final: SIN_COINTEGRACION,
      explain: `El spread no es estacionario in-sample (ADF=${adfIs.stat.toFixed(2)} ≥ crítico ${adfIs.crit.toFixed(2)}, p≈${pIs.toFixed(3)}). No hay cointegración: son dos caminatas aleatorias, no un par. (Falló la Puerta A.)`,
      detail,
    };
  }

  // Gate B: OU half-life on the in-sample spread.
  const hl = ouHalfLife(spreadIs);
  detail.half_life = hl;
  if (hl === null) {
    return {
      final: INSUFICIENTE,
      explain: 'No se pudo estimar la vida media OU in-sample.',
      detail,
    };
  }
  if (!hl.tradeable) {
    let why;
    if (hl.half_life === null) {
      why = `La vida media OU es degenerada (θ=${hl.theta.toFixed(4)} ≤ 0): el spread no revierte, solo se cointegró por estadística. `;
    } else {
      why = `Vida media ≈ ${Math.round(hl.half_life)} barras (> ${MAX_TRADEABLE_HALFLIFE.toFixed(0)}): revierte demasiado lento para operar. `;
    }
    return {
      final: REVERSION_LENTA,
      explain: why + 'Cointegrado pero no operable. (Falló la Puerta B.)',
      detail,
    };
  }

  // Gate C: OOS re-cointegration.
  if (!enoughSplit) {
    return {
      final: INSUFICIENTE,
      explain: `Pasó A y B in-sample (vida media ≈ ${Math.round(hl.half_life)} barras) pero el tramo out-of-sample es muy chico para re-test honesto (in=${xsIs.length}, oos=${xsOos.length}). (Falta la Puerta C.)`,
      detail,
    };
  }

  const [spreadOos] = buildSpread(xsOos, ysOos);
  const adfOos = adfTest(spreadOos);
  const hlOos = ouHalfLife(spreadOos);
  detail.adf_oos = adfOos;
  detail.half_life_oos = hlOos;

  const oosOk =
    adfOos !== null && adfOos.stationary && hlOos !== null && hlOos.tradeable;

  if (!oosOk) {
    let why;
    if (adfOos === null || hlOos === null) {
      why = 'no se pudo re-evaluar fuera de muestra con seguridad.';
    } else if (!adfOos.stationary) {
      why = `el spread deja de ser estacionario fuera de muestra (ADF=${adfOos.stat.toFixed(2)} ≥ ${adfOos.crit.toFixed(2)}).`;
    } else {
      const hlv = hlOos.half_life === null ? Infinity : hlOos.half_life;
      why = `la reversión se vuelve no operable fuera de muestra (vida media ≈ ${Math.round(hlv)} barras).`;
    }
    return {
      final: SOBREAJUSTADO,
      explain: `Cointegrado y operable in-sample, pero ${why} El par estaba sobreajustado al tramo que miraste. (Falló la Puerta C.)`,
      detail,
    };
  }

  return {
    final: PAR_VALIDO,
    explain: `Spread estacionario (ADF in=${adfIs.stat.toFixed(2)}, oos=${adfOos.stat.toFixed(2)}), vida media operable (in≈${Math.round(hl.half_life)}, oos≈${Math.round(hlOos.half_life)} barras) y la cointegración SOBREVIVE fuera de muestra. Par válido en las 3 puertas.`,
    detail,
  };
}

// ─────────────────── Response shaping ───────────────────

// Turn the internal validate_pair result into the user-facing JSON payload.
function shapeResponse(res, xLabel, yLabel, nObs, skipped) {
  const d = res.detail || {};
  const adfIs = d.adf_in_sample || null;
  const hl = d.half_life || null;
  const adfOos = d.adf_oos || null;
  const hlOos = d.half_life_oos || null;

  return {
    pair: { y: yLabel, x: xLabel },           // spread = y - (alpha + beta*x)
    n_obs: nObs,
    skipped,
    gate_verdict: res.final,                  // technical tier
    verdict: USER_TIER[res.final] || res.final, // user-facing tier
    explain: res.explain,
    hedge: {
      alpha: d.alpha ?? null,
      beta: d.beta ?? null,
      z_now: d.z_now ?? null,                 // how stretched the pair is right now
    },
    cointegration: adfIs
      ? {
          gate: 'A',
          method: 'Engle-Granger + ADF',
          adf_stat: adfIs.stat,
          adf_crit: adfIs.crit,
          p_approx: adfIs.p_approx,
          lag: adfIs.lag,
          n_used: adfIs.n_used,
          stationary: adfIs.stationary,
        }
      : null,
    ou_half_life: hl
      ? {
          gate: 'B',
          theta: hl.theta,
          half_life_bars: hl.half_life,
          max_tradeable_bars: MAX_TRADEABLE_HALFLIFE,
          tradeable: hl.tradeable,
        }
      : null,
    oos: adfOos || hlOos
      ? {
          gate: 'C',
          adf_stat: adfOos ? adfOos.stat : null,
          adf_crit: adfOos ? adfOos.crit : null,
          stationary: adfOos ? adfOos.stationary : null,
          half_life_bars: hlOos ? hlOos.half_life : null,
          tradeable: hlOos ? hlOos.tradeable : null,
        }
      : null,
    config: {
      in_sample_fraction: IN_SAMPLE_FRACTION,
      adf_alpha: ADF_ALPHA,
      min_total_obs: MIN_TOTAL_OBS,
      min_split_obs: MIN_SPLIT_OBS,
      max_tradeable_halflife: MAX_TRADEABLE_HALFLIFE,
    },
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────── Yahoo price fetch + alignment ───────────────────

// Crypto symbols map to their -USD Yahoo pair (shared canonical map) —
// without this, 'ETH' silently fetched Ethan Allen and 'BTC' the Grayscale
// ETF instead of the crypto the autocomplete offered.
import { toYahooSymbol } from './_lib/crypto-map.js';

// Fetch [timestamps, closes] of daily closes for one symbol from Yahoo.
async function fetchYahoo(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  if (!ts.length || ts.length !== closes.length) return null;
  return [ts, closes];
}

// Align two (timestamps, closes) series by shared timestamp, dropping nulls.
// Returns { xs, ys, n, skipped } with xs/ys index-aligned and chronological.
function alignByTimestamp(seriesX, seriesY) {
  const [tx, cx] = seriesX;
  const [ty, cy] = seriesY;
  const mapY = new Map();
  for (let i = 0; i < ty.length; i++) {
    if (cy[i] != null && cy[i] > 0) mapY.set(ty[i], cy[i]);
  }
  const xs = [];
  const ys = [];
  let skipped = 0;
  // tx is chronological from Yahoo; iterate it to keep order.
  for (let i = 0; i < tx.length; i++) {
    const px = cx[i];
    if (px == null || px <= 0) { skipped++; continue; }
    const py = mapY.get(tx[i]);
    if (py == null) { skipped++; continue; }
    xs.push(px);
    ys.push(py);
  }
  return { xs, ys, n: xs.length, skipped };
}

// ─────────────────── HTTP handler ───────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Accept params from query (GET) or body (POST).
  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const range = (src.range || '2y').toString();
  const useLog = !(src.raw === '1' || src.raw === 1 || src.raw === true || src.raw === 'true');

  try {
    // ── Raw-array mode: caller supplies aligned price arrays. ──
    if (Array.isArray(src.pricesX) && Array.isArray(src.pricesY)) {
      const xsRaw = src.pricesX.map(Number);
      const ysRaw = src.pricesY.map(Number);
      // Drop rows where either price is not a finite positive number (stay aligned).
      const xs = [];
      const ys = [];
      let skipped = 0;
      const m = Math.min(xsRaw.length, ysRaw.length);
      for (let i = 0; i < m; i++) {
        const a = xsRaw[i];
        const b = ysRaw[i];
        if (Number.isFinite(a) && Number.isFinite(b)) { xs.push(a); ys.push(b); }
        else skipped += 1;
      }
      if (xs.length === 0) {
        return res.status(400).json({ error: 'pricesX/pricesY had no usable aligned rows' });
      }
      const xLabel = (src.xLabel || 'X').toString();
      const yLabel = (src.yLabel || 'Y').toString();
      const result = validatePair(xs, ys, useLog);
      return res.status(200).json(shapeResponse(result, xLabel, yLabel, xs.length, skipped));
    }

    // ── Ticker mode: fetch + align from Yahoo. ──
    const x = (src.x || '').toString().trim().toUpperCase();
    const y = (src.y || '').toString().trim().toUpperCase();
    if (!x || !y) {
      return res.status(400).json({
        error: 'Provide two tickers (x and y), or raw pricesX/pricesY arrays.',
        usage: '/api/pairs-validator?x=GOOGL&y=AMZN&range=2y',
      });
    }
    if (x === y) {
      return res.status(400).json({ error: 'x and y must be different tickers.' });
    }

    const [sx, sy] = await Promise.all([fetchYahoo(toYahooSymbol(x), range), fetchYahoo(toYahooSymbol(y), range)]);
    if (!sx) return res.status(404).json({ error: `No price history for ${x}` });
    if (!sy) return res.status(404).json({ error: `No price history for ${y}` });

    const { xs, ys, n, skipped } = alignByTimestamp(sx, sy);
    if (n === 0) {
      return res.status(422).json({ error: `No overlapping dates for ${x} / ${y}` });
    }

    const result = validatePair(xs, ys, useLog);
    return res.status(200).json(shapeResponse(result, x, y, n, skipped));
  } catch (err) {
    return res.status(500).json({
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown'),
    });
  }
}

// Named exports for unit testing (ignored by Vercel's default-export runtime).
export {
  ols, olsMulti, solve, adfTest, adfPvalue, ouHalfLife, buildSpread,
  zscoreLast, toLog, validatePair, shapeResponse, alignByTimestamp,
  USER_TIER, PAR_VALIDO, SIN_COINTEGRACION, REVERSION_LENTA, SOBREAJUSTADO, INSUFICIENTE,
};
