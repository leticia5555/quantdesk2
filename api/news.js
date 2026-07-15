import { isCrypto } from './_lib/crypto-map.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return res.status(200).json({ headlines: [], newsLive: [], earnings: null });
  }

  const symbol = ticker.toUpperCase().replace('/USD', '').replace('-USD', '');
  const cryptoTicker = isCrypto(symbol);

  try {
    const today = new Date();
    // Use 14-day window for richer news feed (was 7)
    const from = new Date(today - 14 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    // Fetch news + earnings + sentiment in parallel (skip earnings/sentiment for crypto)
    const fetches = [
      fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromStr}&to=${toStr}&token=${finnhubKey}`)
    ];
    if (!cryptoTicker) {
      fetches.push(
        fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${symbol}&token=${finnhubKey}`),
        fetch(`https://finnhub.io/api/v1/news-sentiment?symbol=${symbol}&token=${finnhubKey}`)
      );
    }
    const results = await Promise.allSettled(fetches.map(f => f.then(r => r.json())));

    // ── 1. NEWS ──────────────────────────────────────────
    const newsData = results[0].status === 'fulfilled' ? results[0].value : [];
    const rawNews = Array.isArray(newsData) ? newsData : [];

    // Deduplicate by headline
    const seenHeadlines = new Set();
    const cleanNews = [];
    for (const n of rawNews) {
      const h = String(n.headline || '').trim();
      if (!h || seenHeadlines.has(h)) continue;
      seenHeadlines.add(h);
      cleanNews.push(n);
    }

    // Sort newest first
    cleanNews.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));

    // ── Format A: headlines (existing format, used by sim's news sentiment block) ──
    const headlines = cleanNews.slice(0, 5).map(n => ({
      headline: n.headline,
      summary: n.summary?.slice(0, 200),
      source: n.source,
      url: n.url,
      datetime: n.datetime
    }));

    // ── Format B: newsLive (rich format for visual news sidebar with thumbnails) ──
    const newsLive = cleanNews.slice(0, 12).map(n => ({
      id: n.id || null,
      headline: n.headline,
      summary: n.summary || '',
      source: n.source || 'Unknown',
      url: n.url || '#',
      image: n.image || null,
      category: n.category || null,
      datetime: n.datetime || null,
      related: n.related || null
    }));

    // ── 2. EARNINGS ──────────────────────────────────────
    let nextEarnings = null;
    if (!cryptoTicker && results[1]?.status === 'fulfilled') {
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

    // ── 3. SENTIMENT ─────────────────────────────────────
    let sentiment = null;
    if (!cryptoTicker && results[2]?.status === 'fulfilled') {
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

    return res.status(200).json({
      headlines,        // legacy format — used by existing sim sentiment block
      newsLive,         // new rich format — used by live news feed sidebar
      nextEarnings,
      sentiment,
      source: 'finnhub'
    });

  } catch (err) {
    return res.status(200).json({
      headlines: [],
      newsLive: [],
      nextEarnings: null,
      sentiment: null,
      error: err.message
    });
  }
}
