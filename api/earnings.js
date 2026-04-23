export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(200).json({ earnings: [] });
 
  const { from, to, ticker } = req.query;
 
  // ═══════════════════════════════════════════════════════════════
  // MODE 2: HISTORY — /api/earnings?ticker=NVDA
  // Returns last 8 quarters: EPS est vs actual, surprise %, stock reaction
  // ═══════════════════════════════════════════════════════════════
  if (ticker) {
    const sym = ticker.toUpperCase().trim();
 
    try {
      // Fetch in parallel: EPS history (Finnhub) + 1y price history (Yahoo)
      const now = Math.floor(Date.now() / 1000);
      const oneYearAgo = now - 400 * 24 * 3600; // 400 days to cover 4+ quarters
 
      const [epsRes, yahooRes] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${finnhubKey}`),
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${oneYearAgo}&period2=${now}&interval=1d&range=2y`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        ).catch(() => null)
      ]);
 
      const epsCT = epsRes.headers.get('content-type') || '';
      if (!epsCT.includes('application/json')) {
        return res.status(200).json({ ticker: sym, history: [], error: 'Finnhub plan restriction' });
      }
 
      const epsData = await epsRes.json();
 
      if (!Array.isArray(epsData) || epsData.length === 0) {
        return res.status(200).json({ ticker: sym, history: [], error: 'No earnings history available' });
      }
 
      // Get up to last 8 quarters (Finnhub returns most-recent-first)
      const quarters = epsData.slice(0, 8);
 
      // Build price lookup from Yahoo for stock reaction calculation
      let priceLookup = null;
      try {
        const yahoo = await yahooRes.json();
        const chart = yahoo?.chart?.result?.[0];
        if (chart?.timestamp && chart?.indicators?.quote?.[0]?.close) {
          const ts = chart.timestamp;
          const closes = chart.indicators.quote[0].close;
          priceLookup = ts.map((t, i) => ({
            date: new Date(t * 1000).toISOString().split('T')[0],
            close: closes[i]
          })).filter(p => p.close != null && p.close > 0);
        }
      } catch (e) { /* price lookup optional */ }
 
      // For each quarter, compute surprise % and stock reaction (next-day return)
      const history = quarters.map(q => {
        const epsEst = q.estimate;
        const epsAct = q.actual;
        const surprisePct = (epsEst != null && epsEst !== 0 && epsAct != null)
          ? ((epsAct - epsEst) / Math.abs(epsEst)) * 100
          : null;
 
        // Find stock reaction: close on report date vs close next trading day
        let stockReaction = null;
        if (priceLookup && q.period) {
          const reportDate = q.period; // Finnhub uses YYYY-MM-DD format
          const reportIdx = priceLookup.findIndex(p => p.date >= reportDate);
          if (reportIdx >= 0 && reportIdx + 1 < priceLookup.length) {
            const before = priceLookup[reportIdx].close;
            const after = priceLookup[reportIdx + 1].close;
            if (before > 0) {
              stockReaction = ((after - before) / before) * 100;
            }
          }
        }
 
        return {
          period: q.period,                           // YYYY-MM-DD
          quarter: q.quarter,                          // 1, 2, 3, 4
          year: q.year,                                // 2024, 2025, etc
          eps_estimate: epsEst,
          eps_actual: epsAct,
          surprise_pct: surprisePct != null ? +surprisePct.toFixed(2) : null,
          beat: surprisePct != null ? (surprisePct > 0) : null,
          stock_reaction_pct: stockReaction != null ? +stockReaction.toFixed(2) : null
        };
      });
 
      // Aggregate stats
      const validQuarters = history.filter(h => h.surprise_pct != null);
      const beats = validQuarters.filter(h => h.beat).length;
      const total = validQuarters.length;
      const beatRate = total > 0 ? (beats / total) * 100 : 0;
 
      const avgSurprise = total > 0
        ? validQuarters.reduce((sum, h) => sum + h.surprise_pct, 0) / total
        : 0;
 
      const validReactions = history.filter(h => h.stock_reaction_pct != null);
      const avgReaction = validReactions.length > 0
        ? validReactions.reduce((sum, h) => sum + h.stock_reaction_pct, 0) / validReactions.length
        : null;
 
      return res.status(200).json({
        ticker: sym,
        history,                                       // last 8 quarters, most-recent-first
        beat_rate_pct: +beatRate.toFixed(1),           // e.g. 87.5 (PERCENTAGE not decimal)
        beats,                                         // e.g. 7
        total,                                         // e.g. 8
        avg_surprise_pct: +avgSurprise.toFixed(2),     // e.g. 13.4
        avg_stock_reaction_pct: avgReaction != null ? +avgReaction.toFixed(2) : null,
        next_report_date: null                         // placeholder; calendar mode handles this
      });
 
    } catch (err) {
      return res.status(200).json({ ticker: sym, history: [], error: err.message });
    }
  }
 
  // ═══════════════════════════════════════════════════════════════
  // MODE 1: CALENDAR — /api/earnings?from=...&to=... (existing behavior)
  // ═══════════════════════════════════════════════════════════════
  const now = new Date();
  const fromDate = from || now.toISOString().split('T')[0];
  const toDate = to || new Date(now.getTime() + 30*24*60*60*1000).toISOString().split('T')[0];
 
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${finnhubKey}`
    );
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return res.status(200).json({ earnings: [] });
    }
    const data = await r.json();
    if (!data.earningsCalendar) {
      return res.status(200).json({ earnings: [] });
    }
    const earnings = data.earningsCalendar
      .filter(e => e.epsEstimate !== null && e.symbol)
      .map(e => ({
        ticker: e.symbol,
        date: e.date,
        time: e.hour === 'bmo' ? 'BMO' : e.hour === 'amc' ? 'AMC' : 'TBD',
        eps_est: e.epsEstimate,
        eps_actual: e.epsActual,
        revenue_est: e.revenueEstimate,
        revenue_actual: e.revenueActual,
        quarter: e.quarter,
        year: e.year
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return res.status(200).json({ earnings, count: earnings.length });
  } catch (err) {
    return res.status(200).json({ earnings: [] });
  }
}
