// api/fundamentals.js — Fetch P/E, P/B, P/S, EPS, Book Value from Yahoo Finance
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  let symbol = ticker.toUpperCase();
  // Crypto handling
  if(['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','LINK','DOT'].includes(symbol)){
    return res.status(200).json({ error: 'Fundamentals not applicable for crypto' });
  }

  try {
    // Yahoo Finance v10 quoteSummary endpoint (public, no key needed)
    const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;

    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      }
    });

    if (!r.ok) {
      return res.status(200).json({ error: 'Yahoo data unavailable', status: r.status });
    }

    const data = await r.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return res.status(200).json({ error: 'No fundamentals available' });

    const summary = result.summaryDetail || {};
    const keyStats = result.defaultKeyStatistics || {};
    const financial = result.financialData || {};
    const profile = result.assetProfile || {};
    const price = result.price || {};

    // Extract values (Yahoo nests as {raw, fmt} objects)
    const val = obj => obj?.raw ?? null;

    const pe = val(summary.trailingPE) || val(keyStats.forwardPE);
    const pb = val(keyStats.priceToBook);
    const ps = val(summary.priceToSalesTrailing12Months);
    const eps = val(keyStats.trailingEps) || val(keyStats.forwardEps);
    const bookValue = val(keyStats.bookValue);
    const beta = val(keyStats.beta);
    const marketCap = val(price.marketCap) || val(summary.marketCap);
    const dividendYield = val(summary.dividendYield);
    const profitMargin = val(financial.profitMargins);
    const revenueGrowth = val(financial.revenueGrowth);
    const roe = val(financial.returnOnEquity);
    const sector = profile.sector || null;

    // Sector-based average multiples (rough approximations)
    const sectorMultiples = {
      'Technology':           { pe: 28, pb: 6.5 },
      'Communication Services': { pe: 22, pb: 3.8 },
      'Consumer Cyclical':    { pe: 20, pb: 3.5 },
      'Consumer Defensive':   { pe: 22, pb: 4.0 },
      'Healthcare':           { pe: 24, pb: 4.5 },
      'Financial Services':   { pe: 14, pb: 1.8 },
      'Industrials':          { pe: 19, pb: 3.2 },
      'Energy':               { pe: 12, pb: 1.6 },
      'Utilities':            { pe: 18, pb: 2.0 },
      'Real Estate':          { pe: 28, pb: 2.2 },
      'Basic Materials':      { pe: 15, pb: 2.0 },
    };
    const sectorData = sectorMultiples[sector] || { pe: 22, pb: 3.5 };

    return res.status(200).json({
      ticker: symbol,
      sector,
      pe,
      pb,
      ps,
      eps,
      bookValue,
      beta,
      marketCap,
      dividendYield,
      profitMargin,
      revenueGrowth,
      roe,
      sectorPE: sectorData.pe,
      sectorPB: sectorData.pb,
      source: 'yahoo-finance'
    });
  } catch (err) {
    return res.status(200).json({ error: err.message });
  }
}
