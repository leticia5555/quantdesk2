// api/backtest.js — Real backtest using Yahoo Finance historical data
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const { ticker, days, direction } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
 
  const d = parseInt(days) || 90;
  const dir = direction || 'LONG';
 
  try {
    let symbol = ticker.toUpperCase();
    // Crypto handling
    if(['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','LINK','DOT'].includes(symbol)){
      symbol = symbol + '-USD';
    }
 
    // Fetch 2 years of data from Yahoo
    const now = Math.floor(Date.now() / 1000);
    const twoYearsAgo = now - (2 * 365 * 24 * 3600);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${twoYearsAgo}&period2=${now}&interval=1d`;
 
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if(!r.ok) return res.status(200).json({ error: 'Yahoo data unavailable', periods: [] });
 
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if(!result) return res.status(200).json({ error: 'No data', periods: [] });
 
    // Filter closes and timestamps together so indices stay aligned —
    // Yahoo returns null closes on halts/holidays while keeping the timestamp.
    const rawCloses = result.indicators?.quote?.[0]?.close || [];
    const rawTimestamps = result.timestamp || [];
    const closes = [];
    const timestamps = [];
    for (let i = 0; i < rawCloses.length; i++) {
      if (rawCloses[i] != null) {
        closes.push(rawCloses[i]);
        timestamps.push(rawTimestamps[i]);
      }
    }
 
    if(closes.length < d + 30){
      return res.status(200).json({ error: 'Insufficient history', periods: [] });
    }
 
    // Run backtest: pick 6 entry points evenly spaced across the usable range
    // For each entry, measure return after `d` days. The last valid entry is
    // at index (totalDays - d - 1) so its exit lands on the final bar.
    const totalDays = closes.length;
    const lastEntry = totalDays - d - 1;
    const periods = [];
    const numPeriods = 6;

    for(let i = 0; i < numPeriods; i++){
      const entryIdx = Math.floor(lastEntry * (i / (numPeriods - 1)));
      const exitIdx = entryIdx + d;
      if(exitIdx >= totalDays) break;
 
      const entryPrice = closes[entryIdx];
      const exitPrice = closes[exitIdx];
      const rawReturn = (exitPrice - entryPrice) / entryPrice;
      // Flip for SHORT
      const tradeReturn = dir === 'LONG' ? rawReturn : -rawReturn;
      const entryDate = new Date(timestamps[entryIdx] * 1000);
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const dateStr = `${monthNames[entryDate.getMonth()]} ${entryDate.getFullYear()}`;
 
      periods.push({
        start: dateStr,
        entry_price: parseFloat(entryPrice.toFixed(2)),
        exit_price: parseFloat(exitPrice.toFixed(2)),
        return_pct: parseFloat((tradeReturn * 100).toFixed(2)),
        outcome: tradeReturn > 0 ? 'WIN' : 'LOSS'
      });
    }
 
    const wins = periods.filter(p => p.outcome === 'WIN').length;
    const winRate = periods.length ? wins / periods.length : 0;
    const avgReturn = periods.length ? periods.reduce((a, p) => a + p.return_pct / 100, 0) / periods.length : 0;
 
    return res.status(200).json({
      ticker: symbol,
      periods,
      backtest_win_rate: parseFloat(winRate.toFixed(2)),
      backtest_avg_return: parseFloat(avgReturn.toFixed(4)),
      periods_tested: periods.length,
      source: 'yahoo-finance-real'
    });
  } catch (err) {
    return res.status(200).json({ error: err.message, periods: [] });
  }
}
