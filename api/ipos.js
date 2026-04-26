// ═══════════════════════════════════════════════════════════════
// /api/ipos — IPO calendar (upcoming + recent with performance)
// Uses Finnhub's /calendar/ipo endpoint (free tier)
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return res.status(200).json({ ipos: [], error: 'FINNHUB_API_KEY not set' });
  }

  try {
    const today = new Date();
    const fromPast  = new Date(today.getTime() - 45 * 24 * 3600 * 1000);
    const toFuture  = new Date(today.getTime() + 90 * 24 * 3600 * 1000);
    const fmt = d => d.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/calendar/ipo?from=${fmt(fromPast)}&to=${fmt(toFuture)}&token=${finnhubKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(200).json({ ipos: [], error: `Finnhub ${r.status}` });
    }
    const data = await r.json();
    const raw = Array.isArray(data.ipoCalendar) ? data.ipoCalendar : [];

    const todayIso = fmt(today);
    const sevenDays = fmt(new Date(today.getTime() + 7 * 24 * 3600 * 1000));
    const thirtyDays = fmt(new Date(today.getTime() + 30 * 24 * 3600 * 1000));

    // Classify each IPO
    const classify = (ipo) => {
      const d = ipo.date;
      if (!d) return 'unknown';
      if (d < todayIso) return 'recent';           // already happened
      if (d <= sevenDays) return 'this_week';
      if (d <= thirtyDays) return 'next_30d';
      return 'later';
    };

    // Parse numPrice if it's a range like "$10-$12"
    const parsePriceRange = (price) => {
      if (!price) return { mid: null, low: null, high: null };
      const s = String(price);
      const matches = s.match(/[\d.]+/g);
      if (!matches) return { mid: null, low: null, high: null };
      const nums = matches.map(Number).filter(n => !isNaN(n) && n > 0);
      if (nums.length === 0) return { mid: null, low: null, high: null };
      if (nums.length === 1) return { mid: nums[0], low: nums[0], high: nums[0] };
      return {
        low: Math.min(...nums),
        high: Math.max(...nums),
        mid: (Math.min(...nums) + Math.max(...nums)) / 2
      };
    };

    // For recent IPOs, fetch current quote to show performance
    const recentIpos = raw.filter(ipo => classify(ipo) === 'recent' && ipo.symbol)
      .slice(0, 20);  // cap to avoid too many API calls

    const performancePromises = recentIpos.map(async (ipo) => {
      try {
        const qr = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${ipo.symbol}&token=${finnhubKey}`
        );
        if (!qr.ok) return { symbol: ipo.symbol, current: null };
        const quote = await qr.json();
        return {
          symbol: ipo.symbol,
          current: quote.c || null
        };
      } catch { return { symbol: ipo.symbol, current: null }; }
    });

    const performances = await Promise.all(performancePromises);
    const perfMap = {};
    performances.forEach(p => { if (p.current) perfMap[p.symbol] = p.current; });

    // Build the response
    const ipos = raw.map(ipo => {
      const priceRange = parsePriceRange(ipo.price);
      const currentPrice = perfMap[ipo.symbol] || null;
      let perfPct = null;
      if (currentPrice && priceRange.mid) {
        perfPct = ((currentPrice - priceRange.mid) / priceRange.mid) * 100;
      }
      return {
        symbol: ipo.symbol,
        name: ipo.name,
        date: ipo.date,
        exchange: ipo.exchange,
        status: ipo.status,  // "expected" | "priced" | "withdrawn" | "filed"
        numberOfShares: ipo.numberOfShares,
        totalSharesValue: ipo.totalSharesValue,
        priceRange: ipo.price,
        priceLow: priceRange.low,
        priceHigh: priceRange.high,
        priceMid: priceRange.mid,
        currentPrice,
        performancePct: perfPct != null ? +perfPct.toFixed(1) : null,
        bucket: classify(ipo)
      };
    }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // Group
    const thisWeek   = ipos.filter(i => i.bucket === 'this_week');
    const next30d    = ipos.filter(i => i.bucket === 'next_30d');
    const later      = ipos.filter(i => i.bucket === 'later');
    const recent     = ipos.filter(i => i.bucket === 'recent').reverse();  // newest first

    return res.status(200).json({
      this_week: thisWeek,
      next_30d: next30d,
      later: later,
      recent: recent,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    return res.status(200).json({
      ipos: [],
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
