export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const t = ticker.toUpperCase().trim();
  const finnhubKey = process.env.FINNHUB_API_KEY;

  // Crypto map for CoinGecko (free, no key needed)
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

      let mu = 0.5, sigma = 0.8, high52w = currentPrice * 1.5;
      let low52w = currentPrice * 0.5, return30d = coinInfo.usd_24h_change / 100 * 30;

      if (closes.length >= 20) {
        const returns = [];
        for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i-1]) / closes[i-1]);
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
        mu = mean * 252;
        sigma = Math.sqrt(variance) * Math.sqrt(252);
        high52w = Math.max(...closes);
        low52w = Math.min(...closes);
        return30d = (currentPrice - closes[Math.max(0, closes.length - 31)]) / closes[Math.max(0, closes.length - 31)];
      }

      return res.status(200).json({
        ticker: t,
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        mu: parseFloat(mu.toFixed(4)),
        sigma: parseFloat(sigma.toFixed(4)),
        high52w: parseFloat(high52w.toFixed(2)),
        low52w: parseFloat(low52w.toFixed(2)),
        return30d: parseFloat(return30d.toFixed(4)),
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

  // ── STOCKS via Finnhub (free tier: quote only) ────────
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set' });

  try {
    const symbol = t.replace('/USD', '');

    // Free tier: quote + basic metrics + profile
    const [quoteRes, metricRes, profileRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`)
    ]);

    const [quote, metric, profile] = await Promise.all([
      quoteRes.json(), metricRes.json(), profileRes.json()
    ]);

    if (!quote.c || quote.c === 0) {
      return res.status(404).json({ error: `No price data for ${symbol}` });
    }

    const currentPrice = quote.c;
    const m = metric.metric || {};

    // Use Finnhub's built-in annual metrics for mu/sigma estimation
    const annualReturn = m['52WeekPriceReturnDaily'] ? m['52WeekPriceReturnDaily'] / 100 : 0.15;
    const beta = m.beta || 1;
    const high52w = m['52WeekHigh'] || quote.h || currentPrice * 1.3;
    const low52w = m['52WeekLow'] || quote.l || currentPrice * 0.7;

    // Estimate sigma from 52w range (Parkinson estimator)
    const sigmaEst = Math.log(high52w / low52w) / (2 * Math.sqrt(252 * Math.log(2)));
    const mu = annualReturn;
    const sigma = Math.max(sigmaEst, 0.15); // minimum 15% vol

    // 30d return from quote
    const prevClose = quote.pc || currentPrice;
    // Use best available return metric in order of preference
    const return30d = 
      m['1MonthPriceReturnDaily'] ? m['1MonthPriceReturnDaily'] / 100 :
      m['13WeekPriceReturnDaily'] ? m['13WeekPriceReturnDaily'] / 100 / 13 * 4 :
      m['4WeekPriceReturnDaily'] ? m['4WeekPriceReturnDaily'] / 100 :
      quote.dp ? quote.dp / 100 * 21 :  // scale daily % to ~1 month
      (currentPrice - prevClose) / prevClose;

    return res.status(200).json({
      ticker: symbol,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      mu: parseFloat(mu.toFixed(4)),
      sigma: parseFloat(sigma.toFixed(4)),
      high52w: parseFloat(high52w.toFixed(2)),
      low52w: parseFloat(low52w.toFixed(2)),
      return30d: parseFloat(return30d.toFixed(4)),
      dataPoints: 252,
      asset_type: 'stock',
      currency: profile.currency || 'USD',
      exchange: profile.exchange || '',
      longName: profile.name || symbol,
      recentPrices: []
    });

  } catch (err) {
    return res.status(500).json({ error: `Stock fetch failed: ${err.message}` });
  }
}
