// ═══════════════════════════════════════════════════════════════
// /api/sectors — 4 categories of ETF heatmaps
//   us:         11 SPDR sector ETFs (default)
//   latam:      6 country/region ETFs for LATAM
//   themes:     14 thematic megatrends
//   industries: sub-industry ETFs (semis, biotech, banks, etc.)
// ═══════════════════════════════════════════════════════════════

const CATEGORIES = {
us: [
{ ticker: ‘XLK’, name: ‘Technology’,           emoji: ‘💻’, topStocks: [‘AAPL’,‘MSFT’,‘NVDA’,‘AVGO’,‘ORCL’] },
{ ticker: ‘XLF’, name: ‘Financials’,           emoji: ‘🏦’, topStocks: [‘JPM’,‘BAC’,‘WFC’,‘GS’,‘BRK-B’] },
{ ticker: ‘XLV’, name: ‘Healthcare’,           emoji: ‘🏥’, topStocks: [‘LLY’,‘JNJ’,‘UNH’,‘MRK’,‘PFE’] },
{ ticker: ‘XLY’, name: ‘Consumer Discretionary’,emoji: ‘🛍️’, topStocks: [‘AMZN’,‘TSLA’,‘HD’,‘MCD’,‘NKE’] },
{ ticker: ‘XLP’, name: ‘Consumer Staples’,     emoji: ‘🥫’, topStocks: [‘WMT’,‘PG’,‘KO’,‘PEP’,‘COST’] },
{ ticker: ‘XLE’, name: ‘Energy’,               emoji: ‘⛽’, topStocks: [‘XOM’,‘CVX’,‘COP’,‘SLB’,‘EOG’] },
{ ticker: ‘XLI’, name: ‘Industrials’,          emoji: ‘🏭’, topStocks: [‘CAT’,‘BA’,‘HON’,‘UPS’,‘RTX’] },
{ ticker: ‘XLB’, name: ‘Materials’,            emoji: ‘⛏️’, topStocks: [‘LIN’,‘SHW’,‘APD’,‘ECL’,‘FCX’] },
{ ticker: ‘XLU’, name: ‘Utilities’,            emoji: ‘⚡’, topStocks: [‘NEE’,‘SO’,‘DUK’,‘SRE’,‘AEP’] },
{ ticker: ‘XLRE’,name: ‘Real Estate’,          emoji: ‘🏢’, topStocks: [‘PLD’,‘AMT’,‘EQIX’,‘WELL’,‘CCI’] },
{ ticker: ‘XLC’, name: ‘Communication’,        emoji: ‘📡’, topStocks: [‘META’,‘GOOGL’,‘NFLX’,‘DIS’,‘VZ’] }
],
latam: [
{ ticker: ‘EWW’,  name: ‘Mexico’,           emoji: ‘🇲🇽’, topStocks: [‘AMX’,‘FMX’,‘GFNORTEO.MX’,‘WALMEX.MX’,‘CEMEXCPO.MX’] },
{ ticker: ‘EWZ’,  name: ‘Brazil’,           emoji: ‘🇧🇷’, topStocks: [‘VALE’,‘ITUB’,‘PBR’,‘ABEV’,‘BBAS3.SA’] },
{ ticker: ‘ECH’,  name: ‘Chile’,            emoji: ‘🇨🇱’, topStocks: [‘BSAC’,‘SQM-B.SN’,‘CHILE.SN’,‘FALABELLA.SN’,‘COPEC.SN’] },
{ ticker: ‘ARGT’, name: ‘Argentina’,        emoji: ‘🇦🇷’, topStocks: [‘YPFD.BA’,‘GGAL.BA’,‘PAMP.BA’,‘BMA.BA’,‘CRES.BA’] },
{ ticker: ‘GXG’,  name: ‘Colombia’,         emoji: ‘🇨🇴’, topStocks: [‘EC’,‘CIB’,‘BVN’,‘AVAL’], yahooFallback: true, altTickers: [‘ICOL’,‘GXG’] },
{ ticker: ‘ILF’,  name: ‘LatAm 40 (broad)’, emoji: ‘🌎’, topStocks: [‘VALE’,‘ITUB’,‘PBR’,‘AMX’,‘FMX’] }
],
themes: [
{ ticker: ‘SOXX’, name: ‘Semiconductors’,     emoji: ‘🔬’, topStocks: [‘NVDA’,‘AVGO’,‘AMD’,‘TSM’,‘QCOM’] },
{ ticker: ‘AIQ’,  name: ‘AI & Robotics’,      emoji: ‘🤖’, topStocks: [‘NVDA’,‘META’,‘GOOGL’,‘MSFT’,‘TSLA’] },
{ ticker: ‘IBB’,  name: ‘Biotech’,            emoji: ‘🧬’, topStocks: [‘VRTX’,‘REGN’,‘GILD’,‘MRNA’,‘BIIB’] },
{ ticker: ‘XBI’,  name: ‘Biotech (Small)’,    emoji: ‘⚗️’, topStocks: [‘SRPT’,‘ARWR’,‘ALNY’,‘BMRN’,‘EXEL’] },
{ ticker: ‘HACK’, name: ‘Cybersecurity’,      emoji: ‘🔒’, topStocks: [‘CRWD’,‘PANW’,‘ZS’,‘FTNT’,‘OKTA’] },
{ ticker: ‘CLOU’, name: ‘Cloud Computing’,    emoji: ‘☁️’, topStocks: [‘CRM’,‘SNOW’,‘NET’,‘DDOG’,‘MDB’] },
{ ticker: ‘JETS’, name: ‘Airlines’,           emoji: ‘✈️’, topStocks: [‘DAL’,‘UAL’,‘AAL’,‘LUV’,‘SKYW’] },
{ ticker: ‘TAN’,  name: ‘Solar Energy’,       emoji: ‘☀️’, topStocks: [‘FSLR’,‘ENPH’,‘SEDG’,‘RUN’,‘NXT’] },
{ ticker: ‘ICLN’, name: ‘Clean Energy’,       emoji: ‘🌱’, topStocks: [‘FSLR’,‘ENPH’,‘PLUG’,‘BLDP’,‘TPIC’] },
{ ticker: ‘BLOK’, name: ‘Blockchain’,         emoji: ‘⛓️’, topStocks: [‘COIN’,‘MSTR’,‘RIOT’,‘MARA’,‘HUT’] },
{ ticker: ‘DRIV’, name: ‘Autonomous Vehicles’,emoji: ‘🚗’, topStocks: [‘TSLA’,‘NVDA’,‘GOOGL’,‘MBLY’,‘APTV’] },
{ ticker: ‘GLD’,  name: ‘Gold’,               emoji: ‘🥇’, topStocks: [‘Physical gold trust’] },
{ ticker: ‘SLV’,  name: ‘Silver’,             emoji: ‘🥈’, topStocks: [‘Physical silver trust’] },
{ ticker: ‘URA’,  name: ‘Uranium’,            emoji: ‘☢️’, topStocks: [‘CCJ’,‘URNM’,‘NXE’,‘UEC’,‘DNN’] }
],
industries: [
{ ticker: ‘KRE’,  name: ‘Regional Banks’,     emoji: ‘🏛️’, topStocks: [‘ZION’,‘RF’,‘CMA’,‘CFG’,‘KEY’] },
{ ticker: ‘KIE’,  name: ‘Insurance’,          emoji: ‘🛡️’, topStocks: [‘PGR’,‘TRV’,‘MET’,‘PRU’,‘CB’] },
{ ticker: ‘KCE’,  name: ‘Capital Markets’,    emoji: ‘💼’, topStocks: [‘GS’,‘MS’,‘SCHW’,‘RJF’,‘BLK’] },
{ ticker: ‘IHI’,  name: ‘Medical Devices’,    emoji: ‘🩺’, topStocks: [‘ISRG’,‘MDT’,‘SYK’,‘BSX’,‘BDX’] },
{ ticker: ‘IYR’,  name: ‘Real Estate (broad)’,emoji: ‘🏘️’, topStocks: [‘PLD’,‘AMT’,‘EQIX’,‘WELL’,‘PSA’] },
{ ticker: ‘OIH’,  name: ‘Oil Services’,       emoji: ‘🛢️’, topStocks: [‘SLB’,‘HAL’,‘BKR’,‘FTI’,‘NOV’] },
{ ticker: ‘XHB’,  name: ‘Homebuilders’,       emoji: ‘🏗️’, topStocks: [‘DHI’,‘LEN’,‘PHM’,‘NVR’,‘TOL’] },
{ ticker: ‘ITA’,  name: ‘Aerospace & Defense’,emoji: ‘🛩️’, topStocks: [‘BA’,‘RTX’,‘LMT’,‘GE’,‘NOC’] },
{ ticker: ‘MOO’,  name: ‘Agriculture’,        emoji: ‘🌾’, topStocks: [‘DE’,‘ADM’,‘CTVA’,‘BG’,‘MOS’] },
{ ticker: ‘KWEB’, name: ‘China Internet’,     emoji: ‘🇨🇳’, topStocks: [‘BABA’,‘TCEHY’,‘PDD’,‘JD’,‘BIDU’] },
{ ticker: ‘XRT’,  name: ‘Retail’,             emoji: ‘🛒’, topStocks: [‘AMZN’,‘HD’,‘LOW’,‘TGT’,‘COST’] },
{ ticker: ‘IGV’,  name: ‘Software’,           emoji: ‘💾’, topStocks: [‘MSFT’,‘ORCL’,‘CRM’,‘ADBE’,‘INTU’] }
]
};

const REFS = [
{ ticker: ‘SPY’, name: ‘S&P 500’ },
{ ticker: ‘QQQ’, name: ‘Nasdaq 100’ },
{ ticker: ‘IWM’, name: ‘Russell 2000’ },
{ ticker: ‘DIA’, name: ‘Dow Jones’ }
];

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
if (req.method === ‘OPTIONS’) return res.status(200).end();

const finnhubKey = process.env.FINNHUB_API_KEY;
if (!finnhubKey) {
return res.status(200).json({ sectors: [], references: [], error: ‘FINNHUB_API_KEY not set’ });
}

const cat = (req.query.category || ‘us’).toLowerCase();
const sectorList = CATEGORIES[cat] || CATEGORIES.us;

try {
// Track failure reasons so we can return a useful error to the UI
const failureReasons = [];

```
const fetchQuoteFinnhub = async (sym) => {
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`
    );
    if (!r.ok) {
      // Capture rate-limit signal explicitly
      if (r.status === 429) failureReasons.push('finnhub_429');
      else failureReasons.push('finnhub_' + r.status);
      return null;
    }
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
  } catch (e) {
    failureReasons.push('finnhub_exception');
    return null;
  }
};

const fetchQuoteYahoo = async (sym) => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) {
      failureReasons.push('yahoo_' + r.status);
      return null;
    }
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result || !result.meta) return null;
    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const validCloses = closes.filter(c => c != null && c > 0);
    if (validCloses.length < 2) return null;
    const current = meta.regularMarketPrice || validCloses[validCloses.length - 1];
    const prev = meta.chartPreviousClose || validCloses[validCloses.length - 2];
    const change = current - prev;
    const changePct = prev > 0 ? (change / prev) * 100 : 0;
    return {
      price: +current.toFixed(2),
      change: +change.toFixed(2),
      changePct: +changePct.toFixed(2),
      high: meta.regularMarketDayHigh || null,
      low: meta.regularMarketDayLow || null,
      prevClose: prev
    };
  } catch (e) {
    failureReasons.push('yahoo_exception');
    return null;
  }
};

// Universal resilient fetcher: try Finnhub first, then Yahoo automatically.
// For any ticker. This protects against Finnhub rate limits (60/min free tier).
const fetchQuoteResilient = async (sectorDef) => {
  // Try main ticker on Finnhub first (faster, structured data)
  let quote = await fetchQuoteFinnhub(sectorDef.ticker);
  if (quote) return { quote, tickerUsed: sectorDef.ticker };

  // Auto-fallback to Yahoo on the SAME ticker
  quote = await fetchQuoteYahoo(sectorDef.ticker);
  if (quote) return { quote, tickerUsed: sectorDef.ticker };

  // For tickers with explicit alternates (Colombia GXG/ICOL), try those too
  if (sectorDef.altTickers) {
    for (const alt of sectorDef.altTickers) {
      if (alt === sectorDef.ticker) continue;  // already tried
      quote = await fetchQuoteFinnhub(alt);
      if (quote) return { quote, tickerUsed: alt };
      quote = await fetchQuoteYahoo(alt);
      if (quote) return { quote, tickerUsed: alt };
    }
  }
  return null;
};

const sectorPromises = sectorList.map(async (s) => {
  const result = await fetchQuoteResilient(s);
  if (!result) return null;
  return {
    ticker: result.tickerUsed,
    name: s.name,
    emoji: s.emoji,
    topStocks: s.topStocks,
    ...result.quote
  };
});

const refPromises = REFS.map(async (r) => {
  // Refs use same resilient pattern
  const result = await fetchQuoteResilient(r);
  if (!result) return null;
  return { ticker: r.ticker, name: r.name, ...result.quote };
});

const [sectorsResult, refsResult] = await Promise.all([
  Promise.all(sectorPromises),
  Promise.all(refPromises)
]);

const sectors = sectorsResult.filter(s => s != null);
const references = refsResult.filter(r => r != null);

// Track failures so frontend can show "loaded X of Y"
const failedSectors = sectorList
  .filter((s, i) => sectorsResult[i] == null)
  .map(s => ({ ticker: s.ticker, name: s.name }));

// Build a useful error message if everything failed
let errorMsg = null;
if (sectors.length === 0) {
  const reasons = [...new Set(failureReasons)];
  if (reasons.includes('finnhub_429')) {
    errorMsg = 'Finnhub rate limit hit (60/min free tier). Wait 60 seconds and refresh.';
  } else if (reasons.length === 0) {
    errorMsg = 'No quotes returned (market may be closed or tickers unrecognized).';
  } else {
    errorMsg = 'Data sources failing: ' + reasons.join(', ');
  }
}

return res.status(200).json({
  category: cat,
  sectors,
  references,
  total_expected: sectorList.length,
  total_loaded: sectors.length,
  failed: failedSectors,
  error: errorMsg,
  generated_at: new Date().toISOString()
});
```

} catch (err) {
return res.status(200).json({
sectors: [], references: [],
error: ’Server exception: ’ + (err && err.message ? err.message : ‘unknown’)
});
}
}