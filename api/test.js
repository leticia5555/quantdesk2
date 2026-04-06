export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const finnhubKey = process.env.FINNHUB_API_KEY;
  
  try {
    const [quoteRes, metricRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=AAPL&metric=all&token=${finnhubKey}`)
    ]);
    
    const [quote, metric] = await Promise.all([quoteRes.json(), metricRes.json()]);
    
    return res.status(200).json({
      key_present: !!finnhubKey,
      key_length: finnhubKey?.length,
      quote_status: quoteRes.status,
      metric_status: metricRes.status,
      quote,
      metric_sample: { 
        beta: metric.metric?.beta,
        high52w: metric.metric?.['52WeekHigh'],
        low52w: metric.metric?.['52WeekLow'],
        annualReturn: metric.metric?.['52WeekPriceReturnDaily']
      }
    });
  } catch(err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
