// ═══════════════════════════════════════════════════════════════════
// SEC EDGAR endpoint
//
//   GET /api/sec-edgar?ticker=NVDA&filing=10-K
//
// Pulls the most recent filing of the requested type directly from
// SEC EDGAR's public JSON + Archives endpoints. No paid datavendor —
// SEC is the authoritative free source.
//
// IMPORTANT: SEC requires a descriptive User-Agent on every request,
// otherwise they return 403/429.
// ═══════════════════════════════════════════════════════════════════

const SEC_UA = 'QuantDesk research@quantdesk.app';

// In-memory cache (lives for the lifetime of the warm Vercel function).
// Vercel additionally caches the response via Cache-Control headers below.
const _tickersCache = { data: null, expires: 0 };
const _submissionsCache = new Map(); // cik -> { data, expires }
const _filingCache = new Map();      // url -> { text, expires }

async function loadTickerMap() {
  const now = Date.now();
  if (_tickersCache.data && _tickersCache.expires > now) {
    return _tickersCache.data;
  }
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' }
  });
  if (!r.ok) {
    throw new Error(`SEC ticker list HTTP ${r.status}`);
  }
  const raw = await r.json();
  // The file is shaped { "0": {cik_str, ticker, title}, "1": {...}, ... }
  const map = {};
  Object.values(raw || {}).forEach(row => {
    if (row && row.ticker && row.cik_str != null) {
      map[String(row.ticker).toUpperCase()] = {
        cik: String(row.cik_str),
        title: row.title || ''
      };
    }
  });
  _tickersCache.data = map;
  _tickersCache.expires = now + 24 * 3600 * 1000;
  return map;
}

async function loadSubmissions(paddedCik) {
  const now = Date.now();
  const cached = _submissionsCache.get(paddedCik);
  if (cached && cached.expires > now) return cached.data;

  const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
  const r = await fetch(url, {
    headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' }
  });
  if (r.status === 429) {
    const err = new Error('Rate limited');
    err.status = 429;
    throw err;
  }
  if (!r.ok) {
    throw new Error(`SEC submissions HTTP ${r.status}`);
  }
  const data = await r.json();
  _submissionsCache.set(paddedCik, { data, expires: now + 6 * 3600 * 1000 });
  return data;
}

async function fetchFilingText(url) {
  const now = Date.now();
  const cached = _filingCache.get(url);
  if (cached && cached.expires > now) return cached.text;

  const r = await fetch(url, {
    headers: { 'User-Agent': SEC_UA, 'Accept': 'text/html,application/xhtml+xml,*/*' }
  });
  if (r.status === 429) {
    const err = new Error('Rate limited');
    err.status = 429;
    throw err;
  }
  if (!r.ok) {
    throw new Error(`SEC archive HTTP ${r.status}`);
  }
  const text = await r.text();
  // Cap cache entry size to keep memory bounded
  if (text.length < 5_000_000) {
    _filingCache.set(url, { text, expires: now + 24 * 3600 * 1000 });
  }
  return text;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawTicker = (req.query.ticker || '').toString().trim();
  // `filing` accepts a single type ("10-K"), a comma-separated priority list
  // ("10-K,20-F"), or the alias "ANNUAL" — all meaning "find the most recent
  // matching annual report, preferring earlier entries in the list".
  const filingParam = (req.query.filing || '10-K,20-F').toString().trim().toUpperCase();
  const filingPriority = filingParam === 'ANNUAL'
    ? ['10-K', '20-F']
    : filingParam.split(',').map(s => s.trim()).filter(Boolean);

  if (!rawTicker) {
    return res.status(400).json({ error: 'ticker query param required' });
  }

  const ticker = rawTicker.toUpperCase();

  // Reject obvious non-US tickers (anything with a suffix like .MX, .SA, .TO, etc.)
  if (ticker.includes('.')) {
    return res.status(200).json({
      error: 'Ticker not covered by SEC EDGAR. Only US-listed stocks (including LATAM ADRs) available.',
      ticker
    });
  }

  try {
    const tickerMap = await loadTickerMap();
    const hit = tickerMap[ticker];
    if (!hit) {
      return res.status(200).json({
        error: 'Ticker not covered by SEC EDGAR. Only US-listed stocks (including LATAM ADRs) available.',
        ticker
      });
    }

    const paddedCik = hit.cik.padStart(10, '0');
    const submissions = await loadSubmissions(paddedCik);

    const recent = submissions && submissions.filings && submissions.filings.recent;
    if (!recent || !Array.isArray(recent.form)) {
      return res.status(200).json({
        error: `No filings index available for ${ticker}`,
        ticker
      });
    }

    // Find the most recent filing in the priority order.
    // recent.form is parallel to accessionNumber, filingDate, primaryDocument
    // and is already in reverse-chron order. Pick the earliest-priority type
    // for which any filing exists.
    let idx = -1;
    let matchedType = null;
    for (const type of filingPriority) {
      for (let i = 0; i < recent.form.length; i++) {
        if ((recent.form[i] || '').toUpperCase() === type) {
          idx = i;
          matchedType = type;
          break;
        }
      }
      if (idx !== -1) break;
    }

    if (idx === -1) {
      const human = filingPriority.length > 1
        ? `No annual filing (${filingPriority.join(' or ')}) found for this ticker`
        : `No ${filingPriority[0]} filing found for this ticker`;
      return res.status(200).json({ error: human, ticker });
    }

    const accessionNumber = recent.accessionNumber[idx];
    const filingDate = recent.filingDate[idx];
    const primaryDocument = recent.primaryDocument[idx];
    const reportDate = recent.reportDate ? recent.reportDate[idx] : null;
    const accessionNoDashes = String(accessionNumber).replace(/-/g, '');
    const cikInt = parseInt(hit.cik, 10);

    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accessionNoDashes}/${primaryDocument}`;
    const indexUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${encodeURIComponent(matchedType)}&dateb=&owner=include&count=10`;

    const filingText = await fetchFilingText(filingUrl);

    // Cache successful responses for 24h at the CDN — filings are immutable
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');

    return res.status(200).json({
      ticker,
      company_name: submissions.name || hit.title,
      cik: paddedCik,
      filing_type: matchedType,
      filing_date: filingDate,
      report_date: reportDate,
      accession_number: accessionNumber,
      filing_url: filingUrl,
      index_url: indexUrl,
      filing_text: filingText,
      source: 'SEC EDGAR'
    });
  } catch (err) {
    if (err && err.status === 429) {
      return res.status(429).json({ error: 'Rate limited', retry_after: 60 });
    }
    return res.status(500).json({
      error: 'SEC EDGAR fetch failed: ' + (err && err.message ? err.message : 'unknown'),
      ticker
    });
  }
}
