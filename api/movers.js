// ═══════════════════════════════════════════════════════════════
// /api/movers — Top gainers/losers/most active
// Computes from quotes of curated tickers (Finnhub free tier)
// ═══════════════════════════════════════════════════════════════

// Curated list — most-watched US large caps + popular mid/small + LATAM.
// MÁXIMO 55: Finnhub free = 60 req/min. La lista anterior tenía 84 y los
// ~24 quotes del final recibían 429 EN SILENCIO — por eso MU (puesto #62)
// nunca aparecía en Top Losers aunque cayera -10%. Con ≤55 la cobertura
// es completa y determinista en cada corrida.
const WATCHLIST = [
  // Mega-cap tech
  'NVDA','MSFT','AAPL','GOOGL','META','AMZN','TSLA','AVGO','ORCL','NFLX',
  // Semiconductors (antes al final de la lista, en la zona rate-limitada)
  'TSM','ASML','MU','QCOM','INTC','MRVL','AMD',
  // Other large cap
  'CRM','SHOP','PLTR','SNOW','UBER','COIN',
  // Retail favorites + meme
  'GME','HOOD','SOFI','RIVN','HIMS','RKLB',
  // Healthcare / biotech
  'LLY','PFE','UNH',
  // Finance
  'JPM','BAC','GS','V','PYPL',
  // Energy / industrial / consumer
  'XOM','BA','CAT','WMT','NKE','DIS',
  // ETFs popular
  'SPY','QQQ','IWM','ARKK',
  // LATAM ADRs (highly liquid)
  'MELI','NU','GLOB','VALE','PBR','ITUB','AMX','FMX'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return res.status(200).json({ gainers: [], losers: [], volatile: [], error: 'FINNHUB_API_KEY not set' });
  }

  try {
    // Fetch all quotes in parallel (Finnhub free has 60 req/min, we send ~80 — OK if cached)
    const quotePromises = WATCHLIST.map(async (sym) => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`
        );
        if (!r.ok) return null;
        const q = await r.json();
        // q.c = current, q.dp = % change, q.d = $ change, q.h = high, q.l = low, q.pc = prev close
        if (!q || typeof q.c !== 'number' || q.c === 0) return null;
        return {
          symbol: sym,
          price: +q.c.toFixed(2),
          change: q.d != null ? +q.d.toFixed(2) : null,
          changePct: q.dp != null ? +q.dp.toFixed(2) : null,
          high: q.h || null,
          low: q.l || null,
          prevClose: q.pc || null
        };
      } catch (e) {
        return null;
      }
    });

    const all = (await Promise.all(quotePromises))
      .filter(q => q != null && q.changePct != null);

    // Top gainers (highest positive change)
    const gainers = [...all]
      .filter(q => q.changePct > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 10);

    // Top losers (most negative)
    const losers = [...all]
      .filter(q => q.changePct < 0)
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 10);

    // Most volatile (highest abs change, regardless of direction)
    const volatile = [...all]
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 10);

    // Cache compartido en el edge: los quotes no cambian en <60s y esto
    // evita que cada visitante re-queme el presupuesto de 60 req/min.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      gainers,
      losers,
      volatile,
      total_scanned: all.length,
      watchlist_size: WATCHLIST.length,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    return res.status(200).json({
      gainers: [], losers: [], volatile: [],
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
