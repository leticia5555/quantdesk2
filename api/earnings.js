export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(200).json({ earnings: [] });

  const { from, to } = req.query;
  const now = new Date();
  const fromDate = from || now.toISOString().split('T')[0];
  const toDate = to || new Date(now.getTime() + 30*24*60*60*1000).toISOString().split('T')[0];

  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${finnhubKey}`
    );

    // Check content type — if Finnhub returns HTML, it's a plan restriction
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
    // Always return empty array — frontend uses hardcoded fallback calendar
    return res.status(200).json({ earnings: [] });
  }
}
