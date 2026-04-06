export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  try {
    // Yahoo Finance v8 chart endpoint — 1 year daily data
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y&includePrePost=false`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      return res.status(404).json({ error: `Ticker ${ticker} not found` });
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];

    if (!result) {
      return res.status(404).json({ error: `No data for ${ticker}` });
    }

    const closes = result.indicators?.quote?.[0]?.close || [];
    const timestamps = result.timestamp || [];
    const meta = result.meta || {};

    // Filter out nulls
    const prices = closes
      .map((c, i) => ({ price: c, ts: timestamps[i] }))
      .filter(p => p.price !== null && p.price !== undefined);

    if (prices.length < 30) {
      return res.status(400).json({ error: 'Not enough price history' });
    }

    // Calculate real returns
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i].price - prices[i-1].price) / prices[i-1].price);
    }

    // Annualized stats from real data
    const meanDaily = returns.reduce((a, b) => a + b, 0) / returns.length;
    const varianceDaily = returns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / returns.length;
    const stdDaily = Math.sqrt(varianceDaily);

    const mu = meanDaily * 252;           // annualized drift
    const sigma = stdDaily * Math.sqrt(252); // annualized volatility
    const currentPrice = prices[prices.length - 1].price;

    // 52w high/low
    const allPrices = prices.map(p => p.price);
    const high52w = Math.max(...allPrices);
    const low52w = Math.min(...allPrices);

    // Recent trend (30d return)
    const price30dAgo = prices[Math.max(0, prices.length - 31)].price;
    const return30d = (currentPrice - price30dAgo) / price30dAgo;

    // Asset type detection
    const cryptoTickers = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC',
      'BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD'];
    const isCrypto = cryptoTickers.some(c => ticker.toUpperCase().includes(c));

    return res.status(200).json({
      ticker: ticker.toUpperCase(),
      currentPrice,
      mu: parseFloat(mu.toFixed(4)),
      sigma: parseFloat(sigma.toFixed(4)),
      high52w: parseFloat(high52w.toFixed(2)),
      low52w: parseFloat(low52w.toFixed(2)),
      return30d: parseFloat(return30d.toFixed(4)),
      dataPoints: prices.length,
      asset_type: isCrypto ? 'crypto' : (meta.instrumentType === 'ETF' ? 'etf' : 'stock'),
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      longName: meta.longName || ticker,
      recentPrices: prices.slice(-30).map(p => parseFloat(p.price.toFixed(2)))
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
