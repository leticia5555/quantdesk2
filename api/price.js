export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const t = ticker.toUpperCase().trim();
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'TWELVE_DATA_API_KEY not set' });

  try {
    const [histRes, quoteRes] = await Promise.all([
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(t)}&interval=1day&outputsize=252&apikey=${apiKey}`),
      fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(t)}&apikey=${apiKey}`)
    ]);

    const [hist, quote] = await Promise.all([histRes.json(), quoteRes.json()]);

    // Check for errors
    if (hist.status === 'error' || !hist.values || hist.values.length < 20) {
      return res.status(404).json({ 
        error: `No data for ${t}`,
        detail: hist.message || 'Check ticker symbol or upgrade Twelve Data plan for crypto'
      });
    }

    // Twelve Data returns newest first — reverse for chronological
    const closes = hist.values
      .map(v => parseFloat(v.close))
      .filter(v => !isNaN(v) && v > 0)
      .reverse();

    // Get current price from quote endpoint (more accurate)
    const currentPrice = quote.price ? parseFloat(quote.price) : closes[closes.length - 1];

    if (!currentPrice || currentPrice <= 0) {
      return res.status(404).json({ error: `Invalid price data for ${t}` });
    }

    // Sanity check — price shouldn't be wildly different from historical closes
    const lastClose = closes[closes.length - 1];
    const priceDiff = Math.abs(currentPrice - lastClose) / lastClose;
    const validPrice = priceDiff < 0.5 ? currentPrice : lastClose; // use last close if >50% diff

    // Annualized stats
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i-1]) / closes[i-1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const mu = mean * 252;
    const sigma = Math.sqrt(variance) * Math.sqrt(252);
    const high52w = Math.max(...closes);
    const low52w = Math.min(...closes);
    const return30d = (validPrice - closes[Math.max(0, closes.length - 31)]) / closes[Math.max(0, closes.length - 31)];

    const cryptoKeywords = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','DOT','MATIC','/USD'];
    const isCrypto = cryptoKeywords.some(k => t.includes(k));

    return res.status(200).json({
      ticker: t,
      currentPrice: parseFloat(validPrice.toFixed(2)),
      mu: parseFloat(mu.toFixed(4)),
      sigma: parseFloat(sigma.toFixed(4)),
      high52w: parseFloat(high52w.toFixed(2)),
      low52w: parseFloat(low52w.toFixed(2)),
      return30d: parseFloat(return30d.toFixed(4)),
      dataPoints: closes.length,
      asset_type: isCrypto ? 'crypto' : 'stock',
      currency: 'USD',
      longName: t,
      recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
