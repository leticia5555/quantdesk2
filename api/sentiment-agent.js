// ═══════════════════════════════════════════════════════════════════
// Sentiment Agent (Sprint 5)
//
//   GET /api/sentiment-agent?ticker=NVDA
//
// Quantifies sentiment around a ticker using:
//   • Finnhub /company-news — up to ~80 headlines over the last 30d
//   • Reddit search.json — recent posts mentioning the ticker across
//     r/stocks, r/investing, r/wallstreetbets (+ LATAM subs for ADRs)
//   • Claude as the sentiment scorer (one batched call: each
//     headline/title gets sentiment_score ∈ [-1, +1], category,
//     and relevance)
//   • Derived: 7d vs 30d aggregates, velocity (3d vs prior 4d),
//     anomaly detection (|7d − 30d| > 0.3), trend bucket
//   • Claude composes the institutional-grade narrative on top
//     (sentiment_summary, dominant_narrative, contrarian_read,
//     positioning_considerations[3], institutional_insight)
//
// 1-hour CDN cache.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// Hard cap on items sent to Claude in one batched scoring call.
// Modern Sonnet-class context handles 80 short headlines comfortably,
// but we cap to keep latency + token cost predictable.
const MAX_BATCH = 80;
const REDDIT_LIMIT = 25;          // posts per subreddit listing
const REDDIT_USER_AGENT = 'QuantDesk/1.0 (sentiment agent)';

// ── Operational-country override (keep in sync w/ macro+event agents) ──
const OPERATIONAL_COUNTRY_OVERRIDE = {
  STNE: { country: 'BR', name: 'Brazil' },
  PAGS: { country: 'BR', name: 'Brazil' },
  XP:   { country: 'BR', name: 'Brazil' },
  VTEX: { country: 'BR', name: 'Brazil' },
  INTR: { country: 'BR', name: 'Brazil' },
  NU:   { country: 'BR', name: 'Brazil' },
  GLOB: { country: 'AR', name: 'Argentina' },
  TS:   { country: 'AR', name: 'Argentina' },
  TX:   { country: 'AR', name: 'Argentina' },
  MELI: { country: 'BR', name: 'Brazil (primary)' },
  DLO:  { country: 'BR', name: 'Brazil (primary)' }
};

// LATAM-specific subreddits added on top of the default US/global set
// when the effective country is in this map.
const LATAM_SUBS_BY_COUNTRY = {
  BR: ['investimentos', 'BrasilBolsa'],
  AR: ['merval', 'argentinafinanciera'],
  MX: ['MexicoFinanciero', 'mexico'],
  CL: ['SpanishInvesting'],
  CO: ['SpanishInvesting'],
  PE: ['SpanishInvesting']
};
const DEFAULT_SUBREDDITS = ['stocks', 'investing', 'wallstreetbets'];

// ── Fetch helpers ────────────────────────────────────────────────
function safeFetch(url, opts) { return fetch(url, opts || {}).catch(() => null); }
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

// ── Score bucketing helpers ──────────────────────────────────────
function sentimentCategory(score) {
  if (score == null || !isFinite(score)) return 'NEUTRAL';
  if (score >  0.5)  return 'VERY_POSITIVE';
  if (score >  0.25) return 'POSITIVE';
  if (score >  0.1)  return 'MILDLY_POSITIVE';
  if (score >= -0.1) return 'NEUTRAL';
  if (score >= -0.25) return 'MILDLY_NEGATIVE';
  if (score >= -0.5) return 'NEGATIVE';
  return 'VERY_NEGATIVE';
}

function velocityBand(velocity) {
  if (velocity == null) return 'STABLE';
  if (velocity >  0.4)  return 'STRONG_POSITIVE';
  if (velocity >  0.15) return 'POSITIVE';
  if (velocity < -0.4)  return 'STRONG_NEGATIVE';
  if (velocity < -0.15) return 'NEGATIVE';
  return 'STABLE';
}

// 7d sentiment compared to 30d baseline → broad trend bucket
function trendBucket(avg7, avg30) {
  if (avg7 == null && avg30 == null) return 'NEUTRAL';
  const cur = avg7 != null ? avg7 : avg30;
  const prev = avg30 != null ? avg30 : avg7;
  const delta = cur - prev;
  const sign = cur >= 0.1 ? 'POSITIVE' : cur <= -0.1 ? 'NEGATIVE' : 'NEUTRAL';
  if (sign === 'NEUTRAL') {
    // Drifting around 0
    if (delta > 0.15) return 'REVERSING_TO_POSITIVE';
    if (delta < -0.15) return 'REVERSING_TO_NEGATIVE';
    return 'NEUTRAL';
  }
  // Accelerating means current week stronger in the same direction
  if (sign === 'POSITIVE') {
    if (delta > 0.15) return 'ACCELERATING_POSITIVE';
    if (delta < -0.15) return 'REVERSING_TO_NEGATIVE';
    return 'STABLE_POSITIVE';
  }
  // sign NEGATIVE
  if (delta < -0.15) return 'ACCELERATING_NEGATIVE';
  if (delta > 0.15)  return 'REVERSING_TO_POSITIVE';
  return 'STABLE_NEGATIVE';
}

function anomalyDetect(avg7, avg30) {
  if (avg7 == null || avg30 == null) return { detected: false, type: 'STABLE', magnitude: 0 };
  const delta = avg7 - avg30;
  const mag = Math.abs(delta);
  if (mag < 0.3) return { detected: false, type: 'STABLE', magnitude: +mag.toFixed(2) };
  return {
    detected: true,
    type: delta > 0 ? 'POSITIVE_SPIKE' : 'NEGATIVE_SPIKE',
    magnitude: +mag.toFixed(2)
  };
}

// ── Reddit ───────────────────────────────────────────────────────
// Fetches recent posts for a ticker across the configured subreddits.
// Uses Reddit's public JSON search (no auth) — best-effort, fully
// degradable if Reddit rate-limits or 403s.
async function fetchRedditPosts(ticker, subs) {
  const items = [];
  const seen = new Set();
  // Per-sub search keeps results topical; aggregating cross-sub via
  // search.json with a `subreddit:` clause can omit results.
  const res = await Promise.all(subs.map(s => {
    const q = encodeURIComponent(ticker);
    const url = `https://www.reddit.com/r/${encodeURIComponent(s)}/search.json?q=${q}&restrict_sr=1&sort=new&t=week&limit=${REDDIT_LIMIT}`;
    return safeFetch(url, { headers: { 'User-Agent': REDDIT_USER_AGENT } });
  }));
  for (let i = 0; i < res.length; i++) {
    const j = await safeJson(res[i]);
    const children = j && j.data && Array.isArray(j.data.children) ? j.data.children : [];
    for (const c of children) {
      const d = c && c.data;
      if (!d || !d.title) continue;
      const key = d.id || d.title;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: d.id,
        title: d.title,
        subreddit: d.subreddit || subs[i],
        score: d.score || 0,
        num_comments: d.num_comments || 0,
        created_utc: d.created_utc || 0,
        permalink: d.permalink ? `https://reddit.com${d.permalink}` : null
      });
    }
  }
  // Limit total Reddit items to keep scoring batch bounded
  items.sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments));
  return items.slice(0, 30);
}

// ── Claude: batched scorer ───────────────────────────────────────
// Sends one Claude call with up to MAX_BATCH items. Each item gets
// sentiment_score, category, and relevance back. Resilient JSON
// extraction so a wandering preamble doesn't kill the whole batch.
async function scoreBatch(apiKey, ticker, items) {
  if (!items || items.length === 0) return [];
  const trimmed = items.slice(0, MAX_BATCH);
  const numbered = trimmed.map((it, i) => `${i + 1}. [${it._kind || 'news'}] ${it.headline || it.title || ''}`).join('\n');

  const system = `You are a senior equity sentiment analyst. You will be given a numbered list of headlines and Reddit post titles about the ticker ${ticker}. Score each item with three fields:

- sentiment_score: float in [-1.0, +1.0]
   • +1.0 = blowout positive (acquisition target, breakthrough, blockbuster beat)
   • +0.5 = mildly positive (beat, upgrade, partnership)
   •  0.0 = neutral (factual announcement, generic news)
   • -0.5 = mildly negative (downgrade, miss, concern)
   • -1.0 = very negative (fraud, bankruptcy, major lawsuit, large miss)
- category: one of "earnings" | "regulatory" | "partnership" | "competitive" | "macro" | "product" | "leadership" | "financial_health" | "other"
- relevance: float in [0, 1.0] — how directly the headline is about ${ticker} specifically (1.0 = ticker named, 0.5 = sector-wide, 0.1 = tangential mention)

Return ONLY a JSON array of length ${trimmed.length}, in the same order as the input. No preamble:

[
  { "i": 1, "sentiment_score": 0.5, "category": "earnings", "relevance": 0.95 },
  ...
]`;

  const user = `Score these ${trimmed.length} items for ${ticker}:\n\n${numbered}`;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 4000, system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const data = await r.json();
  if (!r.ok) {
    console.log(`[sentiment-agent] scoring HTTP ${r.status}`, data && data.error);
    return trimmed.map(() => null);
  }
  const raw = (data.content || []).map(b => (b && b.text) || '').join('').trim();
  let arr = null;
  try { arr = JSON.parse(raw); } catch (_) {}
  if (!arr) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
    if (fenced) { try { arr = JSON.parse(fenced[1]); } catch (_) {} }
  }
  if (!arr) {
    const first = raw.indexOf('[');
    const last = raw.lastIndexOf(']');
    if (first >= 0 && last > first) {
      try { arr = JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
    }
  }
  if (!Array.isArray(arr)) return trimmed.map(() => null);

  // Map back by index. Tolerate gaps / out-of-order.
  const out = trimmed.map(() => null);
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const idx = (typeof row.i === 'number') ? row.i - 1
              : (typeof row.index === 'number') ? row.index - 1
              : -1;
    if (idx < 0 || idx >= out.length) continue;
    out[idx] = {
      sentiment_score: typeof row.sentiment_score === 'number' ? row.sentiment_score : null,
      category: typeof row.category === 'string' ? row.category : 'other',
      relevance: typeof row.relevance === 'number' ? row.relevance : null
    };
  }
  return out;
}

// ── Claude: narrative ────────────────────────────────────────────
async function runNarrative(apiKey, brief) {
  const system = `You are a senior sentiment / event-driven research analyst at a top-tier hedge fund. You will be given a structured JSON sentiment brief: ticker, sector, country (operational), pre-computed 7d / 30d sentiment aggregates, velocity, anomaly, category breakdowns, top positive/negative headlines, and Reddit signal.

Produce a concise institutional-grade narrative. Return ONLY a JSON object, no preamble:

{
  "sentiment_summary": "<2-3 sentences. Where is sentiment NOW, and how has it shifted week-over-month? Reference actual scores.>",
  "dominant_narrative": "<2-3 sentences. What story is the market telling about this name right now? Cite the dominant category and a specific headline.>",
  "contrarian_read":    "<2-3 sentences. What is the crowd missing? Where does sentiment over- or under-react to the underlying signal?>",
  "positioning_considerations": [
    "<actionable consideration 1>",
    "<actionable consideration 2>",
    "<actionable consideration 3>"
  ],
  "institutional_insight": "<4-5 sentences. Non-obvious institutional read tying sentiment, velocity, anomaly, and Reddit. For LATAM ADRs explicitly weight that English-language sentiment may lag local-language coverage; flag the asymmetry if relevant.>"
}

Be quantitative. Use the actual numbers in the brief (avg 7d score, anomaly magnitude, Reddit post count, etc). Avoid generic statements. If a section has no data (no Reddit, no anomaly) pivot to what's there rather than fabricating.`;

  const user = `Analyze this sentiment brief and return the JSON narrative.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\``;

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

// ── Aggregation helpers ──────────────────────────────────────────
function avgScore(items) {
  const valid = items.filter(it => it && typeof it.sentiment_score === 'number' && isFinite(it.sentiment_score));
  if (valid.length === 0) return null;
  return valid.reduce((s, x) => s + x.sentiment_score, 0) / valid.length;
}
function countsByPolarity(items) {
  let pos = 0, neg = 0, neu = 0;
  for (const it of items) {
    if (!it || typeof it.sentiment_score !== 'number') continue;
    if (it.sentiment_score > 0.1) pos++;
    else if (it.sentiment_score < -0.1) neg++;
    else neu++;
  }
  return { pos, neg, neu };
}
function categoryBreakdown(items) {
  const acc = {};
  for (const it of items) {
    if (!it || typeof it.sentiment_score !== 'number' || !it.category) continue;
    const k = it.category;
    if (!acc[k]) acc[k] = { count: 0, sum: 0 };
    acc[k].count++;
    acc[k].sum += it.sentiment_score;
  }
  const out = {};
  for (const k of Object.keys(acc)) {
    out[k] = { count: acc[k].count, avg_score: +(acc[k].sum / acc[k].count).toFixed(3) };
  }
  return out;
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set', ticker });
  if (!apiKey)     return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set', ticker });

  try {
    const today = new Date();
    const todayStr = ymd(today);
    const back30Str = ymd(new Date(today.getTime() - 30 * 24 * 3600 * 1000));

    // ── 1. Profile + news fan-out ──
    const [profileRes, newsRes] = await Promise.all([
      safeFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubKey}`),
      safeFetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${back30Str}&to=${todayStr}&token=${finnhubKey}`)
    ]);
    const [profile, newsJ] = await Promise.all([safeJson(profileRes), safeJson(newsRes)]);

    if (!profile || !profile.name) {
      return res.status(200).json({
        ticker,
        error: 'No Finnhub profile for this ticker. Sentiment Agent covers US-listed names (incl. ADRs).'
      });
    }

    const company = profile.name;
    const sector = profile.finnhubIndustry || null;

    // Operational country override
    const finnhubCountry = (profile.country || 'US').toUpperCase();
    const override = OPERATIONAL_COUNTRY_OVERRIDE[ticker];
    const effectiveCountry = override ? override.country : finnhubCountry;
    const countryName = override ? override.name : finnhubCountry;
    const countryOverrideApplied = !!override;

    // ── 2. Prepare news items (last 30d, then derive last 7d slice) ──
    const newsItems = Array.isArray(newsJ) ? newsJ : [];
    const cutoff7d = today.getTime() - 7 * 24 * 3600 * 1000;
    const newsCleaned = newsItems
      .filter(n => n && n.headline && n.datetime)
      .map(n => ({
        headline: n.headline,
        summary: n.summary || '',
        ts: n.datetime * 1000,
        date: new Date(n.datetime * 1000).toISOString().slice(0, 10),
        url: n.url || null,
        source: n.source || null
      }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 60); // 60 most recent in 30d window
    const news7d = newsCleaned.filter(n => n.ts >= cutoff7d);

    // ── 3. Reddit (subs depend on operational country) ──
    const subs = [...DEFAULT_SUBREDDITS, ...(LATAM_SUBS_BY_COUNTRY[effectiveCountry] || [])];
    const redditPosts = await fetchRedditPosts(ticker, subs);

    // ── 4. Build single scoring batch for everything ──
    const scoreTargets = [];
    for (const n of newsCleaned)    scoreTargets.push({ _kind: 'news',   ref: n, headline: n.headline });
    for (const p of redditPosts)    scoreTargets.push({ _kind: 'reddit', ref: p, title: p.title });

    const scores = await scoreBatch(apiKey, ticker, scoreTargets);
    // Splice scores back onto news/reddit
    const newsScored = newsCleaned.map((n, i) => ({ ...n, ...(scores[i] || {}) }));
    const redditScored = redditPosts.map((p, i) => {
      const s = scores[newsCleaned.length + i] || {};
      return { ...p, ...s };
    });

    // ── 5. Aggregates ──
    const news30dValid = newsScored.filter(n => typeof n.sentiment_score === 'number');
    const news7dValid  = news30dValid.filter(n => n.ts >= cutoff7d);
    const avg7  = avgScore(news7dValid);
    const avg30 = avgScore(news30dValid);
    const counts7 = countsByPolarity(news7dValid);
    const breakdown = categoryBreakdown(news7dValid);

    // Velocity: last 3 days vs prior 4 days (within the 7d slice)
    const cutoff3d = today.getTime() - 3 * 24 * 3600 * 1000;
    const last3 = news30dValid.filter(n => n.ts >= cutoff3d);
    const prior4 = news30dValid.filter(n => n.ts < cutoff3d && n.ts >= cutoff7d);
    const avg3 = avgScore(last3);
    const avgPrior4 = avgScore(prior4);
    const velocity = (avg3 != null && avgPrior4 != null) ? +(avg3 - avgPrior4).toFixed(3) : null;

    const anomaly = anomalyDetect(avg7, avg30);
    const trend = trendBucket(avg7, avg30);
    const vBand = velocityBand(velocity);

    // Top positive / negative headlines (require some relevance to filter
    // out tangential sector chatter that scored high)
    const ranked = news7dValid
      .filter(n => n.relevance == null || n.relevance >= 0.4)
      .slice();
    const topPositive = ranked.slice().sort((a, b) => b.sentiment_score - a.sentiment_score).slice(0, 3);
    const topNegative = ranked.slice().sort((a, b) => a.sentiment_score - b.sentiment_score).slice(0, 3);

    // ── 6. Reddit aggregates ──
    const redditValid = redditScored.filter(p => typeof p.sentiment_score === 'number');
    const redditAvg = avgScore(redditValid);
    const subCounts = {};
    for (const p of redditValid) { subCounts[p.subreddit] = (subCounts[p.subreddit] || 0) + 1; }
    const topSubs = Object.entries(subCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
    const sampleTitles = redditValid.slice().sort((a, b) => Math.abs(b.sentiment_score) - Math.abs(a.sentiment_score)).slice(0, 3).map(p => ({
      title: p.title, subreddit: p.subreddit, score: p.sentiment_score, url: p.permalink
    }));
    const redditTrending = redditValid.length >= 10 || (redditAvg != null && Math.abs(redditAvg) > 0.3);

    // ── 7. Build brief + narrative ──
    const currentScore = avg7 != null ? +avg7.toFixed(3) : null;
    const sentimentOverview = {
      current_score: currentScore,
      category: sentimentCategory(currentScore),
      trend, velocity: vBand,
      anomaly: anomaly.type
    };

    const newsSentiment = {
      headlines_analyzed_7d:  news7dValid.length,
      headlines_analyzed_30d: news30dValid.length,
      avg_score_7d:  avg7  != null ? +avg7.toFixed(3)  : null,
      avg_score_30d: avg30 != null ? +avg30.toFixed(3) : null,
      positive_count_7d: counts7.pos,
      negative_count_7d: counts7.neg,
      neutral_count_7d:  counts7.neu,
      top_positive: topPositive.map(n => ({
        headline: n.headline, date: n.date,
        score: +Number(n.sentiment_score).toFixed(3),
        category: n.category, url: n.url, source: n.source
      })),
      top_negative: topNegative.map(n => ({
        headline: n.headline, date: n.date,
        score: +Number(n.sentiment_score).toFixed(3),
        category: n.category, url: n.url, source: n.source
      })),
      category_breakdown: breakdown
    };

    const redditSentiment = {
      posts_analyzed: redditValid.length,
      avg_score: redditAvg != null ? +redditAvg.toFixed(3) : null,
      trending: redditTrending,
      top_subreddits: topSubs,
      sample_titles: sampleTitles
    };

    const velocityBlock = {
      last_3d_avg:   avg3       != null ? +avg3.toFixed(3) : null,
      prior_4d_avg:  avgPrior4  != null ? +avgPrior4.toFixed(3) : null,
      velocity, category: vBand
    };

    const anomalyBlock = {
      detected: anomaly.detected,
      type: anomaly.type,
      magnitude: anomaly.magnitude,
      context: (avg7 != null && avg30 != null)
        ? `7d sentiment ${avg7.toFixed(2)} vs 30d baseline ${avg30.toFixed(2)}`
        : 'Insufficient data'
    };

    console.log(`[sentiment-agent] ${ticker}: country=${effectiveCountry} (legal=${finnhubCountry}) ` +
      `news_30d=${news30dValid.length} news_7d=${news7dValid.length} reddit=${redditValid.length} ` +
      `avg7=${avg7} avg30=${avg30} velocity=${velocity} anomaly=${anomaly.type}`);

    // Narrative (gracefully degrade if scoring/narrative fails)
    let narrative = null;
    if (news30dValid.length + redditValid.length > 0) {
      const briefForClaude = {
        ticker, company, sector,
        country: effectiveCountry, country_name: countryName, country_legal: finnhubCountry,
        sentiment_overview: sentimentOverview,
        news_sentiment: newsSentiment,
        reddit_sentiment: redditSentiment,
        sentiment_velocity: velocityBlock,
        anomaly_detection: anomalyBlock
      };
      const out = await runNarrative(apiKey, briefForClaude);
      if (out.ok) narrative = out.ok;
      else console.log(`[sentiment-agent] ${ticker}: narrative error`, out.error, out.raw_preview || out.detail);
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=3600'); // 1h
    return res.status(200).json({
      ticker,
      company_name: company,
      sector,
      country: effectiveCountry,
      country_name: countryName,
      country_legal: finnhubCountry,
      country_override_applied: countryOverrideApplied,
      sentiment_overview: sentimentOverview,
      news_sentiment: newsSentiment,
      reddit_sentiment: redditSentiment,
      sentiment_velocity: velocityBlock,
      anomaly_detection: anomalyBlock,
      sentiment_summary:        narrative ? narrative.sentiment_summary        : null,
      dominant_narrative:       narrative ? narrative.dominant_narrative       : null,
      contrarian_read:          narrative ? narrative.contrarian_read          : null,
      positioning_considerations: narrative ? narrative.positioning_considerations : null,
      institutional_insight:    narrative ? narrative.institutional_insight    : null,
      source: 'Finnhub + Reddit + Claude'
    });
  } catch (err) {
    console.log(`[sentiment-agent] exception for ${ticker}:`, err && err.message);
    return res.status(500).json({
      ticker,
      error: 'Sentiment Agent failure: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
