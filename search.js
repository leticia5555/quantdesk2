// ═══════════════════════════════════════════════════════════════
// /api/search — Global symbol search via Finnhub
// Returns up to 10 matching symbols worldwide
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const { q } = req.query;

  if (!q || String(q).trim().length < 1) {
    return res.status(200).json({ results: [] });
  }
  if (!finnhubKey) {
    return res.status(200).json({ results: [], error: 'FINNHUB_API_KEY not set' });
  }

  const query = String(q).trim();

  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${finnhubKey}`
    );
    if (!r.ok) {
      return res.status(200).json({ results: [], error: `Finnhub ${r.status}` });
    }
    const data = await r.json();
    const raw = Array.isArray(data.result) ? data.result : [];

    // Finnhub returns all sorts of symbols — rank and filter
    // Preference: exact match > common stock > ETF > crypto > others
    const scored = raw.map(s => {
      let score = 0;
      const sym = s.symbol || '';
      const displaySym = s.displaySymbol || sym;
      const desc = s.description || '';
      const type = s.type || '';

      // Boost exact / prefix matches
      const upperQ = query.toUpperCase();
      if (sym.toUpperCase() === upperQ) score += 1000;
      else if (displaySym.toUpperCase() === upperQ) score += 900;
      else if (sym.toUpperCase().startsWith(upperQ)) score += 500;
      else if (displaySym.toUpperCase().startsWith(upperQ)) score += 400;
      else if (desc.toUpperCase().startsWith(upperQ)) score += 100;

      // Penalize weird types
      if (type === 'Common Stock') score += 50;
      else if (type === 'ETP' || type === 'ETF') score += 30;
      else if (type === 'ADR') score += 40;
      else if (!type) score -= 100;

      // Prefer US primary listings (shorter symbols without weird suffixes)
      if (!sym.includes('.')) score += 10;

      return { ...s, _score: score };
    }).sort((a, b) => b._score - a._score);

    // Dedupe by displaySymbol, take top 10
    const seen = new Set();
    const results = [];
    for (const s of scored) {
      const key = (s.displaySymbol || s.symbol || '').toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push({
        symbol: s.displaySymbol || s.symbol,
        apiSymbol: s.symbol,  // the one to pass to Finnhub for quote
        name: s.description || s.symbol,
        type: s.type || 'unknown'
      });
      if (results.length >= 10) break;
    }

    return res.status(200).json({ query, results });

  } catch (err) {
    return res.status(200).json({
      results: [],
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
