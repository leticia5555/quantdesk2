// ═══════════════════════════════════════════════════════════════
// /api/sectors — 11 SPDR Sector ETFs with live % change
// Uses Finnhub /quote endpoint (free tier)
// ═══════════════════════════════════════════════════════════════

const SECTORS = [
  { ticker: 'XLK', name: 'Technology',           emoji: '💻', topStocks: ['AAPL','MSFT','NVDA','AVGO','ORCL'] },
  { ticker: 'XLF', name: 'Financials',           emoji: '🏦', topStocks: ['JPM','BAC','WFC','GS','BRK-B'] },
  { ticker: 'XLV', name: 'Healthcare',           emoji: '🏥', topStocks: ['LLY','JNJ','UNH','MRK','PFE'] },
  { ticker: 'XLY', name: 'Consumer Discretionary',emoji: '🛍️', topStocks: ['AMZN','TSLA','HD','MCD','NKE'] },
  { ticker: 'XLP', name: 'Consumer Staples',     emoji: '🥫', topStocks: ['WMT','PG','KO','PEP','COST'] },
  { ticker: 'XLE', name: 'Energy',               emoji: '⛽', topStocks: ['XOM','CVX','COP','SLB','EOG'] },
  { ticker: 'XLI', name: 'Industrials',          emoji: '🏭', topStocks: ['CAT','BA','HON','UPS','RTX'] },
  { ticker: 'XLB', name: 'Materials',            emoji: '⛏️', topStocks: ['LIN','SHW','APD','ECL','FCX'] },
  { ticker: 'XLU', name: 'Utilities',            emoji: '⚡', topStocks: ['NEE','SO','DUK','SRE','AEP'] },
  { ticker: 'XLRE',name: 'Real Estate',          emoji: '🏢', topStocks: ['PLD','AMT','EQIX','WELL','CCI'] },
  { ticker: 'XLC', name: 'Communication',        emoji: '📡', topStocks: ['META','GOOGL','NFLX','DIS','VZ'] }
];

// Also include broad market for reference
const REFS = [
  { ticker: 'SPY', name: 'S&P 500' },
  { ticker: 'QQQ', name: 'Nasdaq 100' },
  { ticker: 'IWM', name: 'Russell 2000' },
  { ticker: 'DIA', name: 'Dow Jones' }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return res.status(200).json({ sectors: [], references: [], error: 'FINNHUB_API_KEY not set' });
  }

  try {
    const fetchQuote = async (sym) => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`
        );
        if (!r.ok) return null;
        const q = await r.json();
        if (!q || typeof q.c !== 'number' || q.c === 0) return null;
        return {
          price: +q.c.toFixed(2),
          change: q.d != null ? +q.d.toFixed(2) : null,
          changePct: q.dp != null ? +q.dp.toFixed(2) : null,
          high: q.h || null,
          low: q.l || null,
          prevClose: q.pc || null
        };
      } catch (e) { return null; }
    };

    // Fetch all sectors and references in parallel
    const sectorPromises = SECTORS.map(async (s) => {
      const quote = await fetchQuote(s.ticker);
      if (!quote) return null;
      return {
        ticker: s.ticker,
        name: s.name,
        emoji: s.emoji,
        topStocks: s.topStocks,
        ...quote
      };
    });

    const refPromises = REFS.map(async (r) => {
      const quote = await fetchQuote(r.ticker);
      if (!quote) return null;
      return { ticker: r.ticker, name: r.name, ...quote };
    });

    const [sectorsResult, refsResult] = await Promise.all([
      Promise.all(sectorPromises),
      Promise.all(refPromises)
    ]);

    const sectors = sectorsResult.filter(s => s != null);
    const references = refsResult.filter(r => r != null);

    return res.status(200).json({
      sectors,
      references,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    return res.status(200).json({
      sectors: [], references: [],
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
