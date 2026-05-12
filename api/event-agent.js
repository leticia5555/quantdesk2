// ═══════════════════════════════════════════════════════════════════
// Event Agent (Sprint 4)
//
//   GET /api/event-agent?ticker=NVDA
//
// Surfaces the catalyst calendar for the next 30–90 days:
//   • Next earnings (date, EPS/rev estimates, fiscal period)
//   • Last 4 reports → beat rate + average surprise
//   • Dividends (ex-date, amount, yield, frequency)
//   • M&A signals from company news (keyword filter)
//   • Regulatory signals from company news (keyword filter)
//   • Insider transactions over the last 90 days (net direction,
//     largest single trade)
//   • Corporate actions (recent / upcoming splits)
//
// Then Claude composes:
//   • catalyst_summary, primary_catalyst_thesis,
//     positioning_considerations[3], institutional_insight
//
// All Finnhub. 30-minute CDN cache.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// ── Keyword filters for news categorization ───────────────────────
// Each phrase is tested as a lowercased substring against the
// headline + summary. M&A is checked BEFORE regulatory so a deal
// triggering antitrust review lands in M&A.
const MA_KEYWORDS = [
  'acquir', 'merger', 'buyout', 'takeover', 'tender offer',
  'definitive agreement', 'all-cash deal', 'all-stock deal',
  'strategic combination', 'consolidation', 'lbo', 'spin-off',
  'spinoff', 'carve-out', 'divest', 'stake in', 'majority stake',
  'minority stake', 'joint venture'
];
const REGULATORY_KEYWORDS = [
  'antitrust', 'ftc', 'doj', 'sec investigation', 'fda',
  'investigation', 'subpoena', 'consent decree', 'regulator',
  'regulatory approval', 'regulatory action', 'lawsuit',
  'settle', 'fine', 'penalty', 'banxico', 'cofece', 'cnv',
  'cvm ', 'cade', 'ipd', 'sanction', 'compliance', 'probe'
];

// ── Finnhub helpers ──────────────────────────────────────────────
function safeFetch(url) { return fetch(url).catch(() => null); }
async function safeJson(r) {
  if (!r || !r.ok) return null;
  try {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch (_) { return null; }
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (24 * 3600 * 1000));
}

// ── Earnings ─────────────────────────────────────────────────────
function buildEarningsBlock(historyArr, calendarArr) {
  const out = {
    next_date: null, days_until: null, next_eps_estimate: null,
    next_revenue_estimate: null, fiscal_period: null,
    last_4_reports: [], beat_rate_4q: null, avg_surprise_pct: null
  };

  // Upcoming earnings (Finnhub /calendar/earnings)
  const calendar = Array.isArray(calendarArr) ? calendarArr : [];
  const today = new Date();
  const upcoming = calendar
    .filter(e => e && e.date && e.epsEstimate != null)
    .map(e => ({ ...e, _date: new Date(e.date + 'T00:00:00Z') }))
    .filter(e => !isNaN(e._date) && e._date >= today)
    .sort((a, b) => a._date - b._date);
  if (upcoming.length > 0) {
    const next = upcoming[0];
    out.next_date = next.date;
    out.days_until = Math.max(0, daysBetween(next._date, today));
    out.next_eps_estimate = next.epsEstimate;
    out.next_revenue_estimate = next.revenueEstimate || null;
    if (next.quarter && next.year) out.fiscal_period = `Q${next.quarter} ${next.year}`;
  }

  // Last 4 reports (Finnhub /stock/earnings — actuals only)
  const history = Array.isArray(historyArr) ? historyArr : [];
  const last4 = history.slice(0, 4).map(q => {
    const epsEst = (typeof q.estimate === 'number') ? q.estimate : null;
    const epsAct = (typeof q.actual === 'number') ? q.actual : null;
    const surprise = (epsEst != null && epsEst !== 0 && epsAct != null)
      ? ((epsAct - epsEst) / Math.abs(epsEst)) * 100 : null;
    return {
      date: q.period || null,
      eps_actual: epsAct,
      eps_estimate: epsEst,
      surprise_pct: surprise != null ? +surprise.toFixed(2) : null,
      beat: surprise != null ? surprise > 0 : null
    };
  });
  out.last_4_reports = last4;

  const validBeats = last4.filter(r => r.beat != null);
  if (validBeats.length > 0) {
    const beats = validBeats.filter(r => r.beat).length;
    out.beat_rate_4q = +((beats / validBeats.length) * 100).toFixed(0);
    const surprises = validBeats.map(r => r.surprise_pct).filter(s => s != null);
    if (surprises.length > 0) {
      out.avg_surprise_pct = +((surprises.reduce((s, x) => s + x, 0) / surprises.length)).toFixed(2);
    }
  }
  return out;
}

// ── Dividends ────────────────────────────────────────────────────
function buildDividendBlock(divArr, currentPrice) {
  const out = {
    has_dividend: false, next_ex_date: null, days_until: null,
    amount: null, yield_pct: null, frequency: null, last_4: []
  };
  const divs = Array.isArray(divArr) ? divArr : [];
  if (divs.length === 0) return out;

  out.has_dividend = true;

  const today = new Date();
  // Finnhub dividend entries carry both past and announced future dates.
  const enriched = divs.map(d => ({
    ...d,
    _exDate: d.date ? new Date(d.date + 'T00:00:00Z') : null
  })).filter(d => d._exDate && !isNaN(d._exDate));

  // Next ex-date = earliest future-or-today
  const future = enriched.filter(d => d._exDate >= today).sort((a, b) => a._exDate - b._exDate);
  if (future.length > 0) {
    out.next_ex_date = future[0].date;
    out.days_until = daysBetween(future[0]._exDate, today);
    out.amount = future[0].amount || future[0].adjustedAmount || null;
  } else if (enriched.length > 0) {
    // No announced future — fall back to most recent past as the "amount" reference
    const past = enriched.slice().sort((a, b) => b._exDate - a._exDate);
    out.amount = past[0].amount || past[0].adjustedAmount || null;
  }

  // Frequency: count distinct ex-dates in the last 12 months
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const yearly = enriched.filter(d => d._exDate >= yearAgo && d._exDate <= today);
  if (yearly.length >= 4) out.frequency = 'quarterly';
  else if (yearly.length === 2 || yearly.length === 3) out.frequency = 'semi-annual';
  else if (yearly.length === 1) out.frequency = 'annual';

  // Yield: annual dividend $ / price
  if (currentPrice && currentPrice > 0 && yearly.length > 0) {
    const annualPaid = yearly.reduce((s, d) => s + (d.amount || d.adjustedAmount || 0), 0);
    if (annualPaid > 0) out.yield_pct = +((annualPaid / currentPrice) * 100).toFixed(2);
  }

  // Last 4 past dividends
  const past = enriched.filter(d => d._exDate < today).sort((a, b) => b._exDate - a._exDate).slice(0, 4);
  out.last_4 = past.map(d => ({ date: d.date, amount: d.amount || d.adjustedAmount || null }));
  return out;
}

// ── News categorization (M&A / regulatory) ───────────────────────
function categorizeNews(newsArr) {
  const items = Array.isArray(newsArr) ? newsArr : [];
  // Last 30 days
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const cleaned = items
    .filter(n => n && n.headline && n.datetime)
    // Finnhub datetime is unix-seconds
    .map(n => ({ ...n, _ts: n.datetime * 1000 }))
    .filter(n => n._ts >= cutoff);

  const matchedMA = [];
  const matchedReg = [];
  const seenHeadlines = new Set();
  for (const n of cleaned) {
    const text = ((n.headline || '') + ' ' + (n.summary || '')).toLowerCase();
    const dedupKey = (n.headline || '').toLowerCase().slice(0, 60);
    if (seenHeadlines.has(dedupKey)) continue;
    seenHeadlines.add(dedupKey);

    const maHit = MA_KEYWORDS.find(k => text.includes(k));
    if (maHit) {
      matchedMA.push({
        headline: n.headline,
        date: new Date(n._ts).toISOString().slice(0, 10),
        category: 'm&a',
        keyword: maHit,
        url: n.url || null,
        source: n.source || null
      });
      continue;  // priority: M&A first
    }
    const regHit = REGULATORY_KEYWORDS.find(k => text.includes(k));
    if (regHit) {
      matchedReg.push({
        headline: n.headline,
        date: new Date(n._ts).toISOString().slice(0, 10),
        category: 'regulatory',
        keyword: regHit,
        url: n.url || null,
        source: n.source || null
      });
    }
  }
  return {
    ma: { deals_mentioned: matchedMA.length, top_news: matchedMA.slice(0, 5) },
    regulatory: { active_concerns: matchedReg.length, top_news: matchedReg.slice(0, 5) }
  };
}

// ── Insider activity ─────────────────────────────────────────────
// Finnhub insider-transactions fields used: name, transactionCode,
// transactionDate, share, transactionPrice, change. Buy if change>0
// AND code is one of P/A; sell if change<0 OR code is S/D/F.
function buildInsiderBlock(insiderRaw, currentPrice) {
  const out = {
    net_direction: 'QUIET', buy_count: 0, sell_count: 0,
    net_value: 0, total_buy_value: 0, total_sell_value: 0,
    largest_transaction: null, category: 'QUIET',
    transaction_count: 0
  };
  const items = Array.isArray(insiderRaw && insiderRaw.data) ? insiderRaw.data : [];
  if (items.length === 0) return out;
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const recent = items
    .filter(t => t && t.transactionDate)
    .map(t => ({ ...t, _date: new Date(t.transactionDate + 'T00:00:00Z') }))
    .filter(t => !isNaN(t._date) && t._date >= cutoff);

  out.transaction_count = recent.length;
  if (recent.length === 0) return out;

  let largest = null;
  for (const t of recent) {
    const code = (t.transactionCode || '').toUpperCase();
    const change = Number(t.change) || 0;
    const price = Number(t.transactionPrice) || currentPrice || 0;
    // Buy: P (open-market purchase) or A (acquisition) with positive change
    // Sell: S (sale), D (disposition), F (tax-withholding) or negative change
    const isBuy = (code === 'P' || code === 'A') && change > 0;
    const isSell = (code === 'S' || code === 'D' || code === 'F') || change < 0;
    const value = Math.abs(change) * price;
    if (isBuy) {
      out.buy_count++;
      out.total_buy_value += value;
      out.net_value += value;
    } else if (isSell) {
      out.sell_count++;
      out.total_sell_value += value;
      out.net_value -= value;
    }
    if (!largest || value > Math.abs(largest._value || 0)) {
      largest = {
        insider_name: t.name || 'Unknown',
        transaction_type: `${code} ${isBuy ? '- Buy' : isSell ? '- Sell' : ''}`.trim(),
        shares: change,
        value: isSell ? -value : value,
        _value: isSell ? -value : value,
        date: t.transactionDate
      };
    }
  }
  if (largest) { delete largest._value; out.largest_transaction = largest; }

  // Category logic
  const totalActions = out.buy_count + out.sell_count;
  if (totalActions === 0) {
    out.category = 'QUIET';
    out.net_direction = 'QUIET';
  } else if (out.buy_count > 0 && out.sell_count === 0) {
    out.category = 'BUYING'; out.net_direction = 'BUYING';
  } else if (out.sell_count > 0 && out.buy_count === 0) {
    out.category = 'SELLING'; out.net_direction = 'SELLING';
  } else {
    // Both sides present. Use net_value sign as tiebreaker; if both are
    // material (>30% of total) call it MIXED.
    const buyShare = out.total_buy_value / (out.total_buy_value + out.total_sell_value || 1);
    if (buyShare > 0.70)      { out.category = 'BUYING';  out.net_direction = 'BUYING'; }
    else if (buyShare < 0.30) { out.category = 'SELLING'; out.net_direction = 'SELLING'; }
    else                       { out.category = 'MIXED';   out.net_direction = 'MIXED'; }
  }
  out.net_value = +out.net_value.toFixed(0);
  out.total_buy_value = +out.total_buy_value.toFixed(0);
  out.total_sell_value = +out.total_sell_value.toFixed(0);
  return out;
}

// ── Corporate actions (splits) ───────────────────────────────────
function buildCorporateActions(splitsArr) {
  const items = Array.isArray(splitsArr) ? splitsArr : [];
  const today = new Date();
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const recent_splits = [];
  const upcoming_splits = [];
  for (const s of items) {
    if (!s || !s.date) continue;
    const d = new Date(s.date + 'T00:00:00Z');
    if (isNaN(d)) continue;
    const entry = { date: s.date, from_factor: s.fromFactor, to_factor: s.toFactor };
    if (d >= today) upcoming_splits.push(entry);
    else if (d >= yearAgo) recent_splits.push(entry);
  }
  return { recent_splits, upcoming_splits };
}

// ── Next major catalyst (earliest known future date) ─────────────
function nextMajorCatalyst(earnings, dividends, corp) {
  const candidates = [];
  if (earnings.next_date && earnings.days_until != null) {
    candidates.push({
      type: 'earnings', date: earnings.next_date, days_until: earnings.days_until,
      label: `${earnings.fiscal_period || 'Next'} Earnings`
    });
  }
  if (dividends.next_ex_date && dividends.days_until != null && dividends.days_until >= 0) {
    candidates.push({
      type: 'dividend', date: dividends.next_ex_date, days_until: dividends.days_until,
      label: `Ex-dividend $${dividends.amount != null ? Number(dividends.amount).toFixed(2) : '—'}`
    });
  }
  if (Array.isArray(corp.upcoming_splits)) {
    for (const s of corp.upcoming_splits) {
      const d = new Date(s.date + 'T00:00:00Z');
      const today = new Date();
      const days = daysBetween(d, today);
      candidates.push({ type: 'split', date: s.date, days_until: days,
        label: `${s.from_factor}-for-${s.to_factor} Split` });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.days_until - b.days_until);
  return candidates[0];
}

// ── Claude narrative ─────────────────────────────────────────────
async function runClaude(apiKey, brief) {
  const system = `You are a senior event-driven research analyst at a top-tier hedge fund. You will be given a structured JSON brief covering a ticker's catalyst calendar: upcoming earnings (date, estimates, beat history), dividends, M&A signals from news, regulatory signals, insider transactions, corporate actions, and the identified next major catalyst.

Produce a concise institutional-grade narrative. Return ONLY a JSON object, no preamble:

{
  "catalyst_summary": "<2-3 sentences. What's the catalyst landscape for the next 30-90 days? Lead with the most proximate event.>",
  "primary_catalyst_thesis": "<3-4 sentences. WHICH catalyst matters most for the next price move, and WHY? Use specific numbers from the brief (beat rate, estimate, insider activity, etc).>",
  "positioning_considerations": [
    "<actionable consideration 1 — be specific, e.g., 'IV crush risk into earnings makes long-vol cleaner than long-delta exposure'>",
    "<actionable consideration 2>",
    "<actionable consideration 3>"
  ],
  "institutional_insight": "<3-4 sentences of NON-OBVIOUS contrarian read. What does the catalyst combination tell you that the consensus has missed? Reference specific data points. For LATAM ADRs weight founder-CEO insider activity heavily (Galperin at MELI, Velez at NU) — these signal more than US insider patterns.>"
}

Be quantitative. Use the actual numbers from the brief. No fluff. If a category has no data (no dividends, no M&A signals, etc.) don't fabricate; pivot to what's actually there.`;

  const user = `Analyze this event brief and return the JSON narrative.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 1500, system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await r.json();
  if (!r.ok) return { error: 'Claude API call failed', detail: data && data.error ? data.error : data };
  const raw = (data.content || []).map(b => (b && b.text) || '').join('').trim();
  try { return { ok: JSON.parse(raw) }; } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) { try { return { ok: JSON.parse(fenced[1]) }; } catch (_) {} }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return { ok: JSON.parse(raw.slice(first, last + 1)) }; } catch (_) {}
  }
  return { error: 'Non-JSON response from Claude', raw_preview: raw.slice(0, 400) };
}

// ═══════════════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker query param required' });

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set', ticker });

  try {
    // Date windows
    const today = new Date();
    const todayStr = ymd(today);
    const fwd120Str = ymd(new Date(today.getTime() + 120 * 24 * 3600 * 1000));
    const back30Str = ymd(new Date(today.getTime() -  30 * 24 * 3600 * 1000));
    const back12moStr = ymd(new Date(today.getTime() - 365 * 24 * 3600 * 1000));
    const fwd6moStr = ymd(new Date(today.getTime() + 180 * 24 * 3600 * 1000));
    const back90Str = ymd(new Date(today.getTime() -  90 * 24 * 3600 * 1000));

    // ── 1. Parallel Finnhub fan-out ──
    const [profileRes, calendarRes, historyRes, divRes, newsRes,
           insiderRes, splitRes, quoteRes] = await Promise.all([
      safeFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/calendar/earnings?from=${todayStr}&to=${fwd120Str}&symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/dividend?symbol=${ticker}&from=${back12moStr}&to=${fwd6moStr}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${back30Str}&to=${todayStr}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&from=${back90Str}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/stock/split?symbol=${ticker}&from=${back12moStr}&to=${fwd6moStr}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`)
    ]);
    const [profile, calendarJ, historyJ, divJ, newsJ,
           insiderJ, splitJ, quoteJ] = await Promise.all([
      safeJson(profileRes), safeJson(calendarRes), safeJson(historyRes),
      safeJson(divRes), safeJson(newsRes), safeJson(insiderRes),
      safeJson(splitRes), safeJson(quoteRes)
    ]);

    if (!profile || !profile.name) {
      return res.status(200).json({
        ticker,
        error: 'No Finnhub profile for this ticker. Event Agent covers US-listed names (incl. ADRs).'
      });
    }

    const company = profile.name;
    const sector = profile.finnhubIndustry || null;
    const currentPrice = (quoteJ && typeof quoteJ.c === 'number' && quoteJ.c > 0) ? quoteJ.c : null;

    // ── 2. Build each block ──
    const calendarArr = (calendarJ && calendarJ.earningsCalendar) || [];
    const earnings = buildEarningsBlock(historyJ, calendarArr);
    const dividends = buildDividendBlock(divJ && divJ.length ? divJ : (Array.isArray(divJ) ? divJ : []), currentPrice);
    const news = categorizeNews(newsJ);
    const insider = buildInsiderBlock(insiderJ, currentPrice);
    const corp = buildCorporateActions(Array.isArray(splitJ) ? splitJ : (splitJ && splitJ.data) || []);
    const next_major_catalyst = nextMajorCatalyst(earnings, dividends, corp);

    // Diagnostic
    console.log(`[event-agent] ${ticker}: next=${next_major_catalyst ? next_major_catalyst.type + '/' + next_major_catalyst.days_until + 'd' : 'none'} ` +
      `beat_rate=${earnings.beat_rate_4q}% div=${dividends.has_dividend} ` +
      `ma=${news.ma.deals_mentioned} reg=${news.regulatory.active_concerns} ` +
      `insider=${insider.category} (${insider.buy_count}/${insider.sell_count})`);

    // ── 3. Claude narrative ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let narrative = null;
    if (apiKey) {
      const brief = {
        ticker, company, sector,
        country: profile.country || null,
        current_price: currentPrice,
        earnings, dividends,
        ma_signals: news.ma,
        regulatory_signals: news.regulatory,
        insider_activity: insider,
        corporate_actions: corp,
        next_major_catalyst
      };
      const out = await runClaude(apiKey, brief);
      if (out.ok) narrative = out.ok;
      else console.log(`[event-agent] ${ticker}: claude error`, out.error, out.raw_preview || out.detail);
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=1800'); // 30min
    return res.status(200).json({
      ticker,
      company_name: company,
      sector,
      country: profile.country || null,
      current_price: currentPrice,
      earnings,
      dividends,
      ma_signals: news.ma,
      regulatory_signals: news.regulatory,
      insider_activity: insider,
      corporate_actions: corp,
      next_major_catalyst,
      catalyst_summary:           narrative ? narrative.catalyst_summary           : null,
      primary_catalyst_thesis:    narrative ? narrative.primary_catalyst_thesis    : null,
      positioning_considerations: narrative ? narrative.positioning_considerations : null,
      institutional_insight:      narrative ? narrative.institutional_insight      : null,
      source: 'Finnhub + Claude'
    });
  } catch (err) {
    console.log(`[event-agent] exception for ${ticker}:`, err && err.message);
    return res.status(500).json({
      ticker,
      error: 'Event Agent failure: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
