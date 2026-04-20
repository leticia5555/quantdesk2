export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const t = ticker.toUpperCase().trim();
  const finnhubKey = process.env.FINNHUB_API_KEY;

  // ── Crypto map for CoinGecko ──────────────────────────
  const cryptoMap = {
    'BTC/USD': 'bitcoin', 'BTC': 'bitcoin',
    'ETH/USD': 'ethereum', 'ETH': 'ethereum',
    'SOL/USD': 'solana', 'SOL': 'solana',
    'BNB/USD': 'binancecoin', 'BNB': 'binancecoin',
    'XRP/USD': 'ripple', 'XRP': 'ripple',
    'ADA/USD': 'cardano', 'ADA': 'cardano',
    'DOGE/USD': 'dogecoin', 'DOGE': 'dogecoin',
    'AVAX/USD': 'avalanche-2', 'AVAX': 'avalanche-2',
    'DOT/USD': 'polkadot', 'DOT': 'polkadot',
    'MATIC/USD': 'matic-network', 'MATIC': 'matic-network',
    'LINK/USD': 'chainlink', 'LINK': 'chainlink',
    'LTC/USD': 'litecoin', 'LTC': 'litecoin',
  };

  const coinGeckoId = cryptoMap[t];

  // ── CRYPTO via CoinGecko ──────────────────────────────
  if (coinGeckoId) {
    try {
      const [priceRes, histRes] = await Promise.all([
        fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd&include_24hr_change=true`),
        fetch(`https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart?vs_currency=usd&days=365&interval=daily`)
      ]);
      const [priceData, histData] = await Promise.all([priceRes.json(), histRes.json()]);
      const coinInfo = priceData[coinGeckoId];
      if (!coinInfo) return res.status(404).json({ error: `Crypto not found: ${t}` });

      const currentPrice = coinInfo.usd;
      const closes = (histData.prices || []).map(p => p[1]).filter(v => v > 0);

      let mu = 0.5, sigma = 0.8;
      let high52w = currentPrice * 1.5, low52w = currentPrice * 0.5;
      let return30d = coinInfo.usd_24h_change / 100 * 30;

      if (closes.length >= 30) {
        // ── Real daily returns ──
        const dailyReturns = [];
        for (let i = 1; i < closes.length; i++) {
          dailyReturns.push(Math.log(closes[i] / closes[i-1]));
        }
        const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const varDaily = dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / dailyReturns.length;
        const sigmaDaily = Math.sqrt(varDaily);

        // ── EWMA volatility (Bloomberg-style: recent vol weighted more) ──
        const lambda = 0.94; // RiskMetrics decay factor
        let ewmaVar = varDaily;
        for (let i = dailyReturns.length - 30; i < dailyReturns.length; i++) {
          ewmaVar = lambda * ewmaVar + (1 - lambda) * dailyReturns[i] ** 2;
        }
        const ewmaSigma = Math.sqrt(ewmaVar);

        // Blend: 60% EWMA (recent) + 40% historical (long-run)
        sigma = Math.min(Math.max((ewmaSigma * 0.6 + sigmaDaily * 0.4) * Math.sqrt(252), 0.20), 2.0);

        // ── Crypto CAPM: higher equity risk premium due to higher beta ──
        // Crypto has beta ~1.5-2.5 vs S&P; use higher baseline
        // For BTC/ETH: rf=4.5%, ERP=5.5%, estimated beta ~2.0 → mu ~15.5%
        // But crypto historically has delivered 30-50% long-term CAGR
        // Blend: 40% CAPM + 40% historical CAGR estimate + 20% recent raw
        const rawMu = meanDaily * 252;
        const cryptoCAPM = 0.045 + 2.0 * 0.055; // beta=2 for crypto
        const historicalCryptoCAGR = 0.35; // BTC 10yr CAGR conservative estimate
        mu = cryptoCAPM * 0.40 + historicalCryptoCAGR * 0.40 + rawMu * 0.20;
        mu = Math.min(Math.max(mu, 0.05), 0.80);

        high52w = Math.max(...closes);
        low52w = Math.min(...closes);
        const idx30 = Math.max(0, closes.length - 31);
        return30d = (currentPrice - closes[idx30]) / closes[idx30];
      }

      // Day change: use 24h change from CoinGecko
      const dayChange = coinInfo.usd_24h_change != null ? coinInfo.usd_24h_change / 100 : 0;

      return res.status(200).json({
        ticker: t,
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        mu: parseFloat(mu.toFixed(4)),
        sigma: parseFloat(sigma.toFixed(4)),
        high52w: parseFloat(high52w.toFixed(2)),
        low52w: parseFloat(low52w.toFixed(2)),
        return30d: parseFloat(return30d.toFixed(4)),
        dayChange: parseFloat(dayChange.toFixed(4)),
        dataPoints: closes.length,
        asset_type: 'crypto',
        currency: 'USD',
        longName: t.replace('/USD', ''),
        recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
      });
    } catch (err) {
      return res.status(500).json({ error: `Crypto fetch failed: ${err.message}` });
    }
  }

  // ── STOCKS via Finnhub + Yahoo Finance historical ─────
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set' });

  try {
    const symbol = t.replace('/USD', '');

    // Fetch Finnhub quote + metrics + Yahoo historical in parallel
    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - 365 * 24 * 3600;

    const [quoteRes, metricRes, profileRes, yahooRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${oneYearAgo}&period2=${now}&interval=1d&range=1y`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then(r => r.json())
        .catch(() => null)
    ]);

    const [quote, metric, profile] = await Promise.all([
      quoteRes.json(), metricRes.json(), profileRes.json()
    ]);

    if (!quote.c || quote.c === 0) {
      return res.status(404).json({ error: `No price data for ${symbol}` });
    }

    const currentPrice = quote.c;
    const m = metric.metric || {};
    const beta = Math.min(Math.max(m.beta || 1.0, 0.3), 3.0);

    // ── Extract Yahoo historical closes ──────────────────
    let closes = [];
    try {
      const chart = yahooRes?.chart?.result?.[0];
      if (chart?.indicators?.quote?.[0]?.close) {
        closes = chart.indicators.quote[0].close.filter(v => v != null && v > 0);
      }
    } catch (e) {}

    const high52w = m['52WeekHigh'] || quote.h || currentPrice * 1.3;
    const low52w  = m['52WeekLow']  || quote.l || currentPrice * 0.7;

    let mu, sigma, return30d;

    if (closes.length >= 30) {
      // ── Real daily log-returns from Yahoo ───────────────
      const dailyReturns = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i-1] > 0) {
          dailyReturns.push(Math.log(closes[i] / closes[i-1]));
        }
      }

      const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
      const varDaily  = dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / dailyReturns.length;

      // ── EWMA volatility (RiskMetrics λ=0.94) ────────────
      // Weights recent volatility more — same as Bloomberg/JPMorgan
      const lambda = 0.94;
      let ewmaVar = varDaily;
      const recentReturns = dailyReturns.slice(-60); // last 60 days for EWMA
      recentReturns.forEach(r => {
        ewmaVar = lambda * ewmaVar + (1 - lambda) * r * r;
      });
      const ewmaSigma = Math.sqrt(ewmaVar);

      // Blend realized vol (long-run) + EWMA (short-run)
      const historicalSigma = Math.sqrt(varDaily * 252);
      const currentSigma    = ewmaSigma * Math.sqrt(252);
      sigma = historicalSigma * 0.40 + currentSigma * 0.60;
      sigma = Math.min(Math.max(sigma, 0.10), 1.50);

      // ── Mu: PURE CAPM (Bloomberg standard) ────────────────
      // E(R) = Rf + beta * (Rm - Rf)
      // Rf = 4.5% (US 10y Treasury), ERP = 5.5% (historical equity risk premium)
      // This is what Bloomberg, Goldman, JP Morgan use for cost of equity
      const rf = 0.045;
      const erp = 0.055;
      const capmMu = rf + beta * erp;

      // Pure CAPM — no momentum extrapolation
      // For very high-beta names (beta > 2), cap to avoid unrealistic mu
      mu = Math.min(Math.max(capmMu, 0.02), 0.30);

      // ── 30d return from actual prices ───────────────────
      const idx30 = Math.max(0, closes.length - 31);
      return30d = (closes[closes.length - 1] - closes[idx30]) / closes[idx30];

    } else {
      // Fallback: Parkinson + CAPM (no Yahoo data)
      const parkinson = Math.log(high52w / low52w) / Math.sqrt(4 * Math.log(2));
      sigma = Math.min(Math.max(parkinson * (1 + (beta - 1) * 0.25), 0.15), 1.20);
      mu = Math.min(Math.max(0.045 + beta * 0.055, 0.04), 0.30);
      return30d = m['1MonthPriceReturnDaily'] ? m['1MonthPriceReturnDaily'] / 100 :
                  m['13WeekPriceReturnDaily'] ? m['13WeekPriceReturnDaily'] / 100 / 13 * 4 :
                  quote.dp ? quote.dp / 100 * 21 :
                  (currentPrice - (quote.pc || currentPrice)) / (quote.pc || currentPrice);
    }

    // Day change from Finnhub quote (dp = day percent, pc = previous close)
    const dayChange = quote.dp != null ? quote.dp / 100 :
                      quote.pc ? (currentPrice - quote.pc) / quote.pc : 0;

    return res.status(200).json({
      ticker: symbol,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      mu: parseFloat(mu.toFixed(4)),
      sigma: parseFloat(sigma.toFixed(4)),
      high52w: parseFloat(high52w.toFixed(2)),
      low52w: parseFloat(low52w.toFixed(2)),
      return30d: parseFloat(return30d.toFixed(4)),
      dayChange: parseFloat(dayChange.toFixed(4)),
      dataPoints: closes.length || 252,
      asset_type: 'stock',
      currency: profile.currency || 'USD',
      exchange: profile.exchange || '',
      longName: profile.name || symbol,
      recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
    });

  } catch (err) {
    return res.status(500).json({ error: `Stock fetch failed: ${err.message}` });
  }
}
