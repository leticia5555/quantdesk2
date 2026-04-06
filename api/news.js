export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(200).json({ headlines: [], earnings: null });

  const symbol = ticker.toUpperCase().replace('/USD', '').replace('-USD', '');
  const isCrypto = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX'].includes(symbol);

  try {
    const today = new Date();
    const from = new Date(today - 7 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    // Fetch news + earnings in parallel (skip earnings for crypto)
    const fetches = [
      fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromStr}&to=${toStr}&token=${finnhubKey}`)
    ];

    if (!isCrypto) {
      fetches.push(
        fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${symbol}&token=${finnhubKey}`),
        fetch(`https://finnhub.io/api/v1/news-sentiment?symbol=${symbol}&token=${finnhubKey}`)
      );
    }

    const results = await Promise.allSettled(fetches.map(f => f.then(r => r.json())));

    // News
    const newsData = results[0].status === 'fulfilled' ? results[0].value : [];
    const headlines = (Array.isArray(newsData) ? newsData : [])
      .slice(0, 5)
      .map(n => ({
        headline: n.headline,
        summary: n.summary?.slice(0, 200),
        source: n.source,
        url: n.url,
        datetime: n.datetime
      }));

    // Earnings
    let nextEarnings = null;
    if (!isCrypto && results[1]?.status === 'fulfilled') {
      const earningsData = results[1].value;
      const upcoming = (earningsData.earningsCalendar || [])
        .filter(e => new Date(e.date) >= new Date())
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (upcoming.length) {
        const e = upcoming[0];
        const daysUntil = Math.ceil((new Date(e.date) - new Date()) / (1000 * 60 * 60 * 24));
        nextEarnings = {
          date: e.date,
          daysUntil,
          epsEstimate: e.epsEstimate,
          revenueEstimate: e.revenueEstimate
        };
      }
    }

    // Sentiment
    let sentiment = null;
    if (!isCrypto && results[2]?.status === 'fulfilled') {
      const sentData = results[2].value;
      if (sentData.sentiment) {
        sentiment = {
          score: sentData.sentiment.bearishPercent !== undefined
            ? (1 - sentData.sentiment.bearishPercent).toFixed(2)
            : null,
          bullish: sentData.sentiment.bullishPercent,
          bearish: sentData.sentiment.bearishPercent
        };
      }
    }

    return res.status(200).json({ headlines, nextEarnings, sentiment, source: 'finnhub' });

  } catch (err) {
    return res.status(200).json({ headlines: [], nextEarnings: null, sentiment: null, error: err.message });
  }
}
