export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
 
  const t = ticker.toUpperCase().trim();
  const finnhubKey = process.env.FINNHUB_API_KEY;
 
  // Crypto map for CoinGecko
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
        fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`),
        fetch(`https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart?vs_currency=usd&days=365&interval=daily`)
      ]);
 
      const [priceData, histData] = await Promise.all([priceRes.json(), histRes.json()]);
 
      const coinInfo = priceData[coinGeckoId];
      if (!coinInfo) return res.status(404).json({ error: `Crypto not found: ${t}` });
 
      const currentPrice = coinInfo.usd;
      const change24h = coinInfo.usd_24h_change || 0;
 
      // Historical closes from CoinGecko
      const closes = (histData.prices || []).map(p => p[1]).filter(v => v > 0);
 
      if (closes.length < 20) {
        return res.status(200).json({
          ticker: t, currentPrice, mu: 0.5, sigma: 0.8,
          high52w: currentPrice * 1.5, low52w: currentPrice * 0.5,
          return30d: change24h / 100 * 30, dataPoints: 0,
          asset_type: 'crypto', currency: 'USD', longName: t,
          recentPrices: [currentPrice]
        });
      }
 
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
      const return30d = (currentPrice - closes[Math.max(0, closes.length - 31)]) / closes[Math.max(0, closes.length - 31)];
 
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
 
  // ── STOCKS via Finnhub ────────────────────────────────
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set' });
 
  try {
    const symbol = t.replace('/USD', '');
 
    const [quoteRes, candleRes, profileRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${Math.floor((Date.now()-365*24*60*60*1000)/1000)}&to=${Math.floor(Date.now()/1000)}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`)
    ]);
 
    const [quote, candle, profile] = await Promise.all([quoteRes.json(), candleRes.json(), profileRes.json()]);
 
    if (!quote.c || quote.c === 0) {
      return res.status(404).json({ error: `No price data for ${symbol}` });
    }
 
    const currentPrice = quote.c;
    const closes = candle.s === 'ok' ? candle.c.filter(v => v > 0) : [];
 
    let mu = 0.15, sigma = 0.35, high52w = quote.h || currentPrice * 1.2;
    let low52w = quote.l || currentPrice * 0.8, return30d = 0;
 
    if (closes.length >= 20) {
      const returns = [];
      for (let i = 1; i < closes.length; i++) {
        returns.push((closes[i] - closes[i-1]) / closes[i-1]);
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
      mu = mean * 252;
      sigma = Math.sqrt(variance) * Math.sqrt(252);
      high52w = Math.max(...closes);
      low52w = Math.min(...closes);
      return30d = (currentPrice - closes[Math.max(0, closes.length - 31)]) / closes[Math.max(0, closes.length - 31)];
    }
 
    return res.status(200).json({
      ticker: symbol,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      mu: parseFloat(mu.toFixed(4)),
      sigma: parseFloat(sigma.toFixed(4)),
      high52w: parseFloat(high52w.toFixed(2)),
      low52w: parseFloat(low52w.toFixed(2)),
      return30d: parseFloat(return30d.toFixed(4)),
      dataPoints: closes.length,
      asset_type: profile.finnhubIndustry ? 'stock' : 'stock',
      currency: profile.currency || 'USD',
      exchange: profile.exchange || '',
      longName: profile.name || symbol,
      recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
    });
 
  } catch (err) {
    return res.status(500).json({ error: `Stock fetch failed: ${err.message}` });
  }
}
