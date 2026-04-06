export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
 
  const t = ticker.toUpperCase().trim();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/',
  };
 
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${base}/v8/finance/chart/${t}?interval=1d&range=1y`, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const data = await response.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null && !isNaN(c));
      if (closes.length < 20) continue;
      const meta = result.meta || {};
      const latestPrice = meta.regularMarketPrice || meta.previousClose || closes[closes.length-1];
      const returns = [];
      for (let i = 1; i < closes.length; i++) returns.push((closes[i]-closes[i-1])/closes[i-1]);
      const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
      const variance = returns.reduce((a,r)=>a+(r-mean)**2,0)/returns.length;
      const mu = mean*252;
      const sigma = Math.sqrt(variance)*Math.sqrt(252);
      const high52w = Math.max(...closes);
      const low52w = Math.min(...closes);
      const return30d = (latestPrice - closes[Math.max(0,closes.length-31)]) / closes[Math.max(0,closes.length-31)];
      const isCrypto = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','-USD'].some(k=>t.includes(k));
      return res.status(200).json({
        ticker: t,
        currentPrice: parseFloat(latestPrice.toFixed(2)),
        mu: parseFloat(mu.toFixed(4)),
        sigma: parseFloat(sigma.toFixed(4)),
        high52w: parseFloat(high52w.toFixed(2)),
        low52w: parseFloat(low52w.toFixed(2)),
        return30d: parseFloat(return30d.toFixed(4)),
        dataPoints: closes.length,
        asset_type: isCrypto ? 'crypto' : (meta.instrumentType==='ETF' ? 'etf' : 'stock'),
        currency: meta.currency || 'USD',
        longName: meta.longName || meta.shortName || t,
        recentPrices: closes.slice(-30).map(p=>parseFloat(p.toFixed(2)))
      });
    } catch(e) { continue; }
  }
  return res.status(503).json({ error: `Price data unavailable for ${t}` });
}
