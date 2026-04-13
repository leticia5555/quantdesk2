export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(500).json({ error: 'No API key' });
 
  const { from, to } = req.query;
  
  // Default to next 30 days if no dates provided
  const now = new Date();
  const fromDate = from || now.toISOString().split('T')[0];
  const toDate = to || new Date(now.getTime() + 30*24*60*60*1000).toISOString().split('T')[0];
 
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${finnhubKey}`
    );
    const data = await r.json();
 
    if (!data.earningsCalendar) {
      return res.status(200).json({ earnings: [] });
    }
 
    // Filter and format - only companies with estimates
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
    return res.status(500).json({ error: err.message });
  }
}
