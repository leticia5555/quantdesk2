// ═══════════════════════════════════════════════════════════════
// /api/correlations — Compute Pearson correlation matrix from
// historical returns for a basket of tickers.
//
// Used by Portfolio Monte Carlo to generate correlated paths via
// Cholesky decomposition (frontend handles Cholesky).
//
// Input:   ?tickers=NVDA,AMD,TSLA,SPY  (comma-separated, max 20)
// Output:  { tickers: [...], corr: NxN matrix, sigmas: [N], n_days: int }
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tickersParam = req.query.tickers || '';
  const tickers = tickersParam.split(',').map(t => t.trim().toUpperCase()).filter(t => t).slice(0, 20);

  if (tickers.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 tickers (comma-separated)' });
  }

  try {
    // Fetch ~6 months of daily closes from Yahoo for each ticker (Yahoo is free + supports LATAM)
    const fetchHistorical = async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=6mo&interval=1d`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return null;
        const d = await r.json();
        const result = d?.chart?.result?.[0];
        if (!result) return null;
        const closes = result.indicators?.quote?.[0]?.close || [];
        const cleanCloses = closes.filter(c => c != null && c > 0);
        if (cleanCloses.length < 30) return null;  // need at least a month of data
        return cleanCloses;
      } catch (e) { return null; }
    };

    const closesPromises = tickers.map(t => fetchHistorical(t));
    const allCloses = await Promise.all(closesPromises);

    // Filter out tickers that failed to load
    const validIdx = [];
    const validTickers = [];
    const validCloses = [];
    for (let i = 0; i < tickers.length; i++) {
      if (allCloses[i] && allCloses[i].length >= 30) {
        validIdx.push(i);
        validTickers.push(tickers[i]);
        validCloses.push(allCloses[i]);
      }
    }

    if (validTickers.length < 2) {
      return res.status(200).json({
        tickers: validTickers,
        corr: [],
        sigmas: [],
        n_days: 0,
        error: 'Insufficient historical data for at least 2 tickers',
        failed: tickers.filter(t => !validTickers.includes(t))
      });
    }

    // Align to shortest series so all returns line up by day
    const minLen = Math.min(...validCloses.map(c => c.length));
    const alignedCloses = validCloses.map(c => c.slice(c.length - minLen));

    // Compute log-returns for each ticker
    const computeReturns = (closes) => {
      const rets = [];
      for (let i = 1; i < closes.length; i++) {
        rets.push(Math.log(closes[i] / closes[i - 1]));
      }
      return rets;
    };
    const allReturns = alignedCloses.map(computeReturns);
    const N = validTickers.length;
    const T = allReturns[0].length;  // number of days of returns

    // Compute means
    const means = allReturns.map(rets => rets.reduce((a, b) => a + b, 0) / rets.length);

    // Compute std deviations (annualized)
    const stds = allReturns.map((rets, i) => {
      const variance = rets.reduce((a, r) => a + (r - means[i]) ** 2, 0) / (rets.length - 1);
      return Math.sqrt(variance);
    });
    const sigmas = stds.map(s => +(s * Math.sqrt(252)).toFixed(4));  // annualized

    // Compute correlation matrix
    const corr = Array(N).fill(null).map(() => Array(N).fill(0));
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        if (i === j) {
          corr[i][j] = 1.0;
          continue;
        }
        let cov = 0;
        for (let t = 0; t < T; t++) {
          cov += (allReturns[i][t] - means[i]) * (allReturns[j][t] - means[j]);
        }
        cov /= (T - 1);
        const c = cov / (stds[i] * stds[j]);
        // Clamp to [-1, 1] for numerical safety
        const cClamped = Math.max(-0.999, Math.min(0.999, c));
        corr[i][j] = +cClamped.toFixed(4);
        corr[j][i] = corr[i][j];
      }
    }

    return res.status(200).json({
      tickers: validTickers,
      corr,
      sigmas,
      n_days: T,
      generated_at: new Date().toISOString(),
      failed: tickers.filter(t => !validTickers.includes(t))
    });

  } catch (err) {
    return res.status(500).json({
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
