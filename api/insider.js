// /api/insider — real insider transactions sourced from SEC EDGAR Form 4
// filings via Finnhub. Replaces AI-hallucinated insider data on the SMART $ tab.

// ── Map Finnhub transactionCode → human type ─────────────
// S=Sale, P=Purchase, A=Award/grant, M=Option exercise, G=Gift,
// F=Tax withholding, D=Sale to issuer
export function deriveType(tx) {
  const code = (tx.transactionCode || '').toUpperCase();
  if (code === 'P') return 'BUY';
  if (code === 'S' || code === 'D') return 'SELL';
  if (code === 'A') return 'AWARD';
  if (code === 'M') return 'OPTION EXERCISE';
  if (code === 'F') return 'TAX WITHHOLDING';
  if (code === 'G') return 'GIFT';
  // Fallback: sign of change
  const change = Number(tx.change) || 0;
  if (change > 0) return 'BUY';
  if (change < 0) return 'SELL';
  return 'OTHER';
}

// Raw Finnhub Form 4 row → normalized transaction. Exported so the
// share/change dollar-value fix is locked by a unit test without hitting
// the network.
//
// CRITICAL — Finnhub Form 4 field semantics:
//   change: shares MOVED in this transaction (signed; <0 = disposed).
//   share:  shares HELD AFTER the transaction (the running position).
// A transaction's dollar size is |change| × transactionPrice. Reading
// `share` (the holding) inflated values ~1000× — a single TSLA F-code row
// showed $287B of "tax withholding" over ~710M shares (≈22% of Tesla)
// while its own 90-day footer said −$17M. Never fall back to `share`.
export function normalizeInsiderTx(tx) {
  const shares = Math.abs(Number(tx.change) || 0);
  const price = Number(tx.transactionPrice) || 0;
  const value = Math.round(shares * price);
  return {
    name: (tx.name || '').trim(),
    title: '', // Finnhub Form 4 feed doesn't expose title; leave blank rather than guess
    type: deriveType(tx),
    shares,
    price,
    value,
    filingDate: tx.filingDate || null,
    transactionDate: tx.transactionDate || null,
    _signedValue: (Number(tx.change) || 0) * price, // for sentiment math
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const t = String(ticker).toUpperCase().trim();
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });

  // Finnhub's insider-transactions endpoint covers US-listed equities sourced
  // from SEC EDGAR Form 4. LATAM tickers (.MX/.SA/.SN/.BA) aren't covered.
  const looksLikeLatam = /\.(MX|SA|SN|BA)$/i.test(t) || t.includes('/USD');
  if (looksLikeLatam) {
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({
      ticker: t,
      source: 'No SEC data available — ticker not covered',
      transactions: [],
      netSentiment: 'NEUTRAL',
      summary: 'Coverage limited to US-listed equities (SEC EDGAR Form 4).',
    });
  }

  const fromDate = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${encodeURIComponent(t)}&from=${fromDate}&token=${finnhubKey}`;

  let raw;
  try {
    const r = await fetch(url);
    if (r.status === 429) {
      return res.status(200).json({
        ticker: t,
        source: 'Rate limited — try again shortly',
        transactions: [],
        netSentiment: 'NEUTRAL',
        summary: '',
        error: 'Rate limited',
      });
    }
    if (!r.ok) {
      return res.status(200).json({
        ticker: t,
        source: `Finnhub error ${r.status}`,
        transactions: [],
        netSentiment: 'NEUTRAL',
        summary: '',
      });
    }
    raw = await r.json();
  } catch (e) {
    return res.status(200).json({
      ticker: t,
      source: 'Network error fetching SEC data',
      transactions: [],
      netSentiment: 'NEUTRAL',
      summary: '',
    });
  }

  const items = Array.isArray(raw && raw.data) ? raw.data : [];

  if (items.length === 0) {
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({
      ticker: t,
      source: 'No SEC data available — ticker not covered',
      transactions: [],
      netSentiment: 'NEUTRAL',
      summary: '',
    });
  }

  // Normalize all rows so we can compute net sentiment, then trim to most recent 5.
  const all = items.map(normalizeInsiderTx);

  // ── Net sentiment over the 90-day window ─────────────────
  // Only count clear open-market BUY/SELL toward sentiment (skip grants,
  // tax withholdings, gifts, option exercises — those don't reflect a view).
  let netDollar = 0;
  let buys = 0, sells = 0;
  const insiderSet = new Set();
  for (const tx of all) {
    if (tx.name) insiderSet.add(tx.name);
    if (tx.type === 'BUY')      { netDollar += tx.value;  buys++;  }
    else if (tx.type === 'SELL'){ netDollar -= tx.value;  sells++; }
  }
  let netSentiment = 'NEUTRAL';
  if (buys > 0 && sells === 0) netSentiment = 'BULLISH';
  else if (sells > 0 && buys === 0) netSentiment = 'BEARISH';
  else if (netDollar > 250000) netSentiment = 'BULLISH';
  else if (netDollar < -250000) netSentiment = 'BEARISH';

  const fmtUsd = (n) => {
    const abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(0);
  };
  const direction = netDollar >= 0 ? 'buying' : 'selling';
  const summary = `Net ${direction} of ${fmtUsd(netDollar)} over last 90 days from ${insiderSet.size} insider${insiderSet.size === 1 ? '' : 's'} (${buys} buy${buys === 1 ? '' : 's'}, ${sells} sell${sells === 1 ? '' : 's'}).`;

  // Most recent 5, sorted by transaction date desc
  const sorted = [...all].sort((a, b) => {
    const da = new Date(a.transactionDate || a.filingDate || 0).getTime();
    const db = new Date(b.transactionDate || b.filingDate || 0).getTime();
    return db - da;
  });
  const recent = sorted.slice(0, 5).map(({ _signedValue, ...rest }) => rest);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({
    ticker: t,
    source: 'SEC EDGAR (via Finnhub)',
    transactions: recent,
    netSentiment,
    summary,
  });
}
