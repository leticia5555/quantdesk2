export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const apiKey = process.env.FINNHUB_API_KEY;

  // If no Finnhub key, return empty gracefully
  if (!apiKey) {
    return res.status(200).json({ headlines: [], source: 'none' });
  }

  try {
    const t = ticker.toUpperCase().replace('/USD','').replace('-USD','');
    const today = new Date();
    const from = new Date(today - 7 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/company-news?symbol=${t}&from=${fromStr}&to=${toStr}&token=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(200).json({ headlines: [], source: 'finnhub' });

    const data = await r.json();
    const headlines = (Array.isArray(data) ? data : [])
      .slice(0, 5)
      .map(n => ({ headline: n.headline, summary: n.summary, source: n.source, datetime: n.datetime }));

    return res.status(200).json({ headlines, source: 'finnhub' });
  } catch (err) {
    return res.status(200).json({ headlines: [], source: 'error', error: err.message });
  }
}
