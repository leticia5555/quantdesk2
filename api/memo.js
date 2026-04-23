// ═══════════════════════════════════════════════════════════════
// /api/memo — Aggregator for institutional research memo
// Fetches: profile, fundamentals, earnings, recommendations, price targets,
//          technical indicators (from price history)
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const { ticker } = req.query;

  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const sym = String(ticker).toUpperCase().trim();

  if (!finnhubKey) {
    return res.status(200).json({ ticker: sym, error: 'FINNHUB_API_KEY not set' });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const twoYearsAgo = now - 730 * 24 * 3600;
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const futureStr = new Date(today.getTime() + 120 * 24 * 3600 * 1000).toISOString().split('T')[0];

    // All requests in parallel with fallback to null if any fails
    const [profileRes, metricRes, epsRes, finRes, recRes, ptRes, yahooRes, calRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${finnhubKey}`).catch(() => null),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${finnhubKey}`).catch(() => null),
      fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${finnhubKey}`).catch(() => null),
      fetch(`https://finnhub.io/api/v1/stock/financials-reported?symbol=${sym}&freq=quarterly&token=${finnhubKey}`).catch(() => null),
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${sym}&token=${finnhubKey}`).catch(() => null),
      fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${sym}&token=${finnhubKey}`).catch(() => null),
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${twoYearsAgo}&period2=${now}&interval=1d&range=2y`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      ).catch(() => null),
      fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${todayStr}&to=${futureStr}&symbol=${sym}&token=${finnhubKey}`).catch(() => null)
    ]);

    const safeJson = async (r) => {
      if (!r || !r.ok) return null;
      try {
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return null;
        return await r.json();
      } catch (e) { return null; }
    };

    const [profile, metricData, epsData, finData, recData, ptData, yahoo, calData] = await Promise.all([
      safeJson(profileRes), safeJson(metricRes), safeJson(epsRes),
      safeJson(finRes), safeJson(recRes), safeJson(ptRes),
      safeJson(yahooRes), safeJson(calRes)
    ]);

    // ─── 1. COMPANY PROFILE ───────────────────────────
    const companyProfile = profile ? {
      name: profile.name || sym,
      country: profile.country || null,
      currency: profile.currency || 'USD',
      exchange: profile.exchange || null,
      industry: profile.finnhubIndustry || null,
      ipo: profile.ipo || null,
      marketCap: profile.marketCapitalization || null,  // in millions
      shareOutstanding: profile.shareOutstanding || null,  // in millions
      logo: profile.logo || null,
      weburl: profile.weburl || null,
      ticker: profile.ticker || sym
    } : { name: sym, ticker: sym };

    // ─── 2. FUNDAMENTALS ─────────────────────────────
    const m = (metricData && metricData.metric) || {};
    const fundamentals = {
      pe_ratio: m.peNormalizedAnnual || m.peBasicExclExtraTTM || m.peTTM || null,
      pb_ratio: m.pbAnnual || m.pb || null,
      ps_ratio: m.psAnnual || m.psTTM || null,
      ev_ebitda: m['enterpriseValueOverEBITDATTM'] || null,
      dividend_yield: m.dividendYieldIndicatedAnnual || m.currentDividendYieldTTM || null,
      beta: m.beta || null,
      high_52w: m['52WeekHigh'] || null,
      low_52w: m['52WeekLow'] || null,
      revenue_ttm: m.revenueTTM || null,
      gross_margin_ttm: m.grossMarginTTM || null,
      operating_margin_ttm: m.operatingMarginTTM || null,
      net_margin_ttm: m.netProfitMarginTTM || null,
      roe_ttm: m.roeTTM || null,
      roa_ttm: m.roaTTM || null,
      debt_to_equity: m['totalDebt/totalEquityAnnual'] || null,
      current_ratio: m.currentRatioAnnual || null,
      revenue_growth_3y: m.revenueGrowth3Y || null,
      eps_growth_3y: m.epsGrowth3Y || null,
      eps_ttm: m.epsTTM || null
    };

    // ─── 3. EARNINGS HISTORY ─────────────────────────
    const earningsQuarters = Array.isArray(epsData) ? epsData.slice(0, 8) : [];

    // Build revenue lookup from financials-reported
    const revenueByPeriod = {};
    if (finData && Array.isArray(finData.data)) {
      finData.data.forEach(r => {
        const ic = r.report && r.report.ic ? r.report.ic : [];
        const revItem = ic.find(item =>
          item.concept && (
            item.concept.toLowerCase().includes('revenue') ||
            item.concept.toLowerCase().includes('sales')
          )
        );
        if (revItem && typeof revItem.value === 'number' && r.quarter && r.year) {
          const key = `${r.year}-Q${r.quarter}`;
          if (!revenueByPeriod[key]) {
            revenueByPeriod[key] = revItem.value;
          }
        }
      });
    }

    // Yahoo price lookup for stock reactions
    let priceLookup = null;
    try {
      const chart = yahoo && yahoo.chart && yahoo.chart.result && yahoo.chart.result[0];
      if (chart && chart.timestamp && chart.indicators && chart.indicators.quote && chart.indicators.quote[0]) {
        const ts = chart.timestamp;
        const closes = chart.indicators.quote[0].close || [];
        priceLookup = ts.map((t, i) => ({
          date: new Date(t * 1000).toISOString().split('T')[0],
          close: closes[i]
        })).filter(p => p.close != null && p.close > 0);
      }
    } catch (e) { priceLookup = null; }

    const earningsHistory = earningsQuarters.map(q => {
      const epsEst = typeof q.estimate === 'number' ? q.estimate : null;
      const epsAct = typeof q.actual === 'number' ? q.actual : null;
      const surprisePct = (epsEst != null && epsEst !== 0 && epsAct != null)
        ? ((epsAct - epsEst) / Math.abs(epsEst)) * 100 : null;

      let stockReaction = null;
      if (priceLookup && q.period) {
        const idx = priceLookup.findIndex(p => p.date >= q.period);
        if (idx >= 0 && idx + 1 < priceLookup.length) {
          const before = priceLookup[idx].close;
          const after = priceLookup[idx + 1].close;
          if (before > 0) stockReaction = ((after - before) / before) * 100;
        }
      }

      let revenue = null, revYoyPct = null;
      if (q.year && q.quarter) {
        const key = `${q.year}-Q${q.quarter}`;
        revenue = revenueByPeriod[key] || null;
        const yoyKey = `${q.year - 1}-Q${q.quarter}`;
        if (revenue != null && revenueByPeriod[yoyKey] > 0) {
          revYoyPct = ((revenue - revenueByPeriod[yoyKey]) / revenueByPeriod[yoyKey]) * 100;
        }
      }

      return {
        period: q.period, quarter: q.quarter, year: q.year,
        eps_estimate: epsEst, eps_actual: epsAct,
        surprise_pct: surprisePct != null ? +surprisePct.toFixed(2) : null,
        beat: surprisePct != null ? surprisePct > 0 : null,
        stock_reaction_pct: stockReaction != null ? +stockReaction.toFixed(2) : null,
        revenue: revenue,
        revenue_yoy_pct: revYoyPct != null ? +revYoyPct.toFixed(1) : null
      };
    });

    const validEarnings = earningsHistory.filter(h => h.surprise_pct != null);
    const beats = validEarnings.filter(h => h.beat).length;
    const beatRate = validEarnings.length > 0 ? (beats / validEarnings.length) * 100 : null;
    const avgSurprise = validEarnings.length > 0
      ? validEarnings.reduce((s, h) => s + h.surprise_pct, 0) / validEarnings.length : null;

    // Next earnings from calendar
    let nextEarnings = null;
    try {
      const list = (calData && calData.earningsCalendar) || [];
      const upcoming = list
        .filter(e => e.symbol === sym && e.epsEstimate != null)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (upcoming.length > 0) {
        const next = upcoming[0];
        const daysAway = Math.max(0, Math.ceil((new Date(next.date) - new Date()) / (1000*60*60*24)));
        nextEarnings = {
          date: next.date,
          days_away: daysAway,
          eps_estimate: next.epsEstimate,
          revenue_estimate: next.revenueEstimate || null,
          time: next.hour === 'bmo' ? 'BMO' : next.hour === 'amc' ? 'AMC' : 'TBD'
        };
      }
    } catch (e) {}

    // ─── 4. ANALYST RECOMMENDATION (most recent) ──────
    let recommendation = null;
    if (Array.isArray(recData) && recData.length > 0) {
      const latest = recData[0];  // most recent first
      const total = (latest.strongBuy||0) + (latest.buy||0) + (latest.hold||0) + (latest.sell||0) + (latest.strongSell||0);
      recommendation = {
        period: latest.period,
        strong_buy: latest.strongBuy || 0,
        buy: latest.buy || 0,
        hold: latest.hold || 0,
        sell: latest.sell || 0,
        strong_sell: latest.strongSell || 0,
        total_analysts: total,
        consensus: total === 0 ? 'N/A' :
          (latest.strongBuy + latest.buy) / total > 0.6 ? 'BUY' :
          (latest.sell + latest.strongSell) / total > 0.4 ? 'SELL' : 'HOLD'
      };
    }

    // ─── 5. PRICE TARGET ────────────────────────────
    const priceTarget = ptData && ptData.targetMean ? {
      target_mean: ptData.targetMean,
      target_high: ptData.targetHigh,
      target_low: ptData.targetLow,
      target_median: ptData.targetMedian,
      last_updated: ptData.lastUpdated,
      num_analysts: ptData.numberOfAnalysts
    } : null;

    // ─── 6. TECHNICAL INDICATORS (computed from Yahoo price history) ──
    let technicals = null;
    if (priceLookup && priceLookup.length >= 200) {
      const closes = priceLookup.map(p => p.close);
      const current = closes[closes.length - 1];

      // SMA 50 & 200
      const sma = (n) => {
        if (closes.length < n) return null;
        const slice = closes.slice(-n);
        return slice.reduce((a,b) => a+b, 0) / n;
      };
      const sma50 = sma(50);
      const sma200 = sma(200);

      // RSI 14
      let rsi = null;
      if (closes.length >= 15) {
        const period = 14;
        let gains = 0, losses = 0;
        for (let i = closes.length - period; i < closes.length; i++) {
          const diff = closes[i] - closes[i-1];
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) rsi = 100;
        else {
          const rs = avgGain / avgLoss;
          rsi = 100 - (100 / (1 + rs));
        }
      }

      // 20-day volatility
      const returns20 = [];
      for (let i = closes.length - 20; i < closes.length; i++) {
        returns20.push(Math.log(closes[i]/closes[i-1]));
      }
      const meanR = returns20.reduce((a,b)=>a+b,0) / returns20.length;
      const varR = returns20.reduce((a,r)=>a+(r-meanR)**2,0) / returns20.length;
      const vol20 = Math.sqrt(varR * 252) * 100;

      // Support/resistance from last 60 days
      const last60 = closes.slice(-60);
      const resistance = Math.max(...last60);
      const support = Math.min(...last60);

      technicals = {
        current_price: +current.toFixed(2),
        sma_50: sma50 != null ? +sma50.toFixed(2) : null,
        sma_200: sma200 != null ? +sma200.toFixed(2) : null,
        price_vs_sma50_pct: sma50 != null ? +(((current - sma50) / sma50) * 100).toFixed(2) : null,
        price_vs_sma200_pct: sma200 != null ? +(((current - sma200) / sma200) * 100).toFixed(2) : null,
        golden_cross: sma50 != null && sma200 != null ? sma50 > sma200 : null,
        rsi_14: rsi != null ? +rsi.toFixed(1) : null,
        rsi_signal: rsi != null ? (rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'NEUTRAL') : null,
        volatility_20d_annualized: +vol20.toFixed(1),
        support: +support.toFixed(2),
        resistance: +resistance.toFixed(2),
        upside_to_resistance_pct: +(((resistance - current) / current) * 100).toFixed(2),
        downside_to_support_pct: +(((support - current) / current) * 100).toFixed(2)
      };
    }

    // ─── RESPONSE ───────────────────────────────────
    return res.status(200).json({
      ticker: sym,
      generated_at: new Date().toISOString(),
      profile: companyProfile,
      fundamentals,
      earnings: {
        history: earningsHistory,
        beats,
        total: validEarnings.length,
        beat_rate_pct: beatRate != null ? +beatRate.toFixed(1) : null,
        avg_surprise_pct: avgSurprise != null ? +avgSurprise.toFixed(2) : null,
        next: nextEarnings
      },
      analyst: {
        recommendation,
        price_target: priceTarget
      },
      technicals
    });

  } catch (err) {
    return res.status(200).json({
      ticker: sym,
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
