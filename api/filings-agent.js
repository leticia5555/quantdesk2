// ═══════════════════════════════════════════════════════════════════
// Filings Agent
//
//   GET /api/filings-agent?ticker=NVDA
//
// Pipeline:
//   1. Hit /api/sec-edgar to pull the most recent 10-K HTML
//   2. Strip HTML, slice down to the institutionally-relevant Items
//      (1A Risk Factors, 7 MD&A, 7A Quant risk, 1 Business, 8 Financials)
//   3. Hand the trimmed text to Claude with a hedge-fund analyst prompt
//   4. Parse the structured JSON and return it alongside filing metadata
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// Hard cap on characters of 10-K text sent to Claude. ~4 chars/token,
// so 360k chars ≈ 90k tokens — leaves comfortable headroom in a 200k
// context window for the system prompt + JSON output.
const MAX_FILING_CHARS = 360_000;

const SYSTEM_PROMPT = `You are a senior equity research analyst at a top-tier hedge fund. You're analyzing a 10-K filing for institutional clients who need actionable insights with full traceability.

Your output must be structured JSON. Every claim must include a page or section reference from the 10-K. Be specific, quantitative, and skeptical. Highlight what most retail investors would miss.

Output format (return ONLY valid JSON, no preamble):

{
  "ticker": "<ticker>",
  "filing_date": "<date>",
  "executive_summary": "<2-3 sentence bottom line>",
  "top_risk_factors": [
    {"risk": "<description>", "severity": "high|medium|low", "source": "Item 1A, p.<N>"}
  ],
  "business_segments": [
    {"name": "<segment>", "revenue": "<$X.XB>", "yoy_growth": "<+/-X%>", "source": "Item 7, p.<N>"}
  ],
  "management_commentary": {
    "tone_shift": "<more bullish | similar | more cautious vs prior year>",
    "key_changes": ["<change 1>", "<change 2>"],
    "source": "Item 7 MD&A"
  },
  "red_flags": [
    {"flag": "<description>", "why_concerning": "<explanation>", "source": "Item <N>, p.<N>"}
  ],
  "key_metrics": {
    "revenue_ttm": "<$X.XB>",
    "revenue_growth_yoy": "<+X%>",
    "operating_margin": "<X%>",
    "fcf_margin": "<X%>",
    "net_debt": "<$X.XB or net cash position>"
  },
  "institutional_insight": "<1-2 sentences of non-obvious insight that retail investors typically miss but hedge fund analysts would catch>"
}

Return up to 5 top_risk_factors, all major business_segments, and at most 3 red_flags (omit the array entries entirely if you find none).`;

// ── HTML → plain text ──────────────────────────────────────────────
function htmlToText(html) {
  if (!html) return '';
  return html
    // Drop XBRL inline tags & scripts/styles
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<ix:[^>]*>/gi, ' ')
    .replace(/<\/ix:[^>]*>/gi, ' ')
    // Block-level tags become newlines so item boundaries survive
    .replace(/<\/(p|div|tr|li|h[1-6]|br|table)[^>]*>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    // Whitespace cleanup
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Slice 10-K to the institutionally-relevant Items ───────────────
// 10-Ks are structured by "Item 1.", "Item 1A.", "Item 7.", etc.
// We surface the sections analysts actually read.
function extractKeyItems(text) {
  if (!text) return '';

  // Locate every Item header offset, in document order
  const itemRegex = /\bitem\s+(\d{1,2}[a-z]?)\b[.:\s-]/gi;
  const matches = [];
  let m;
  while ((m = itemRegex.exec(text)) !== null) {
    matches.push({ item: m[1].toUpperCase(), offset: m.index });
  }

  if (matches.length === 0) {
    // Couldn't parse Item boundaries — fall back to head of document
    return text.slice(0, MAX_FILING_CHARS);
  }

  // Build sections: from each match to the next match
  const sections = {};
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].offset;
    const end = i + 1 < matches.length ? matches[i + 1].offset : text.length;
    const key = matches[i].item;
    const chunk = text.slice(start, end);
    // Keep the LONGEST occurrence of each item — the cover page lists
    // them as a TOC with very short chunks; the real section is longer.
    if (!sections[key] || chunk.length > sections[key].length) {
      sections[key] = chunk;
    }
  }

  // Priority order: what a hedge fund analyst reads first.
  // 1A Risk Factors, 7 MD&A, 7A Quant risk, 1 Business, 8 Financials,
  // then 1B/1C/3/9A as fillers.
  const priority = ['1A', '7', '7A', '1', '8', '1B', '1C', '3', '9A'];

  // Budget chars per section so the whole thing fits under MAX_FILING_CHARS
  const budgets = {
    '1A': 110_000,
    '7':  110_000,
    '7A': 30_000,
    '1':  50_000,
    '8':  50_000,
    '1B': 10_000,
    '1C': 10_000,
    '3':  10_000,
    '9A': 10_000
  };

  let out = '';
  let used = 0;
  for (const key of priority) {
    const chunk = sections[key];
    if (!chunk) continue;
    const budget = budgets[key] || 10_000;
    const slice = chunk.slice(0, budget);
    const remaining = MAX_FILING_CHARS - used;
    if (remaining <= 0) break;
    const finalSlice = slice.length > remaining ? slice.slice(0, remaining) : slice;
    out += `\n\n=== ITEM ${key} ===\n${finalSlice}`;
    used += finalSlice.length;
  }

  // If after priority sections we still have headroom and nothing got pulled,
  // fall back to head of doc
  if (used === 0) {
    return text.slice(0, MAX_FILING_CHARS);
  }

  return out.trim();
}

// ── Best-effort JSON extraction from Claude's response ──────────────
function extractJson(raw) {
  if (!raw) return null;
  // Direct parse
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  // Strip ```json fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) { /* fall through */ }
  }
  // Greedy match on outermost { ... }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch (_) { /* fall through */ }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = (req.query.ticker || '').toString().trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: 'ticker query param required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  try {
    // ── 1. Resolve absolute URL for the SEC EDGAR endpoint ──
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
    const base = host ? `${proto}://${host}` : '';
    const edgarUrl = `${base}/api/sec-edgar?ticker=${encodeURIComponent(ticker)}&filing=10-K`;

    console.log(`[filings-agent] ${ticker}: fetching ${edgarUrl}`);
    const edgarRes = await fetch(edgarUrl);
    if (!edgarRes.ok && edgarRes.status !== 200) {
      // sec-edgar returns 200 for "expected" errors, so a non-200 is a real failure
      const body = await edgarRes.text().catch(() => '');
      return res.status(502).json({
        error: `SEC EDGAR endpoint failed (HTTP ${edgarRes.status})`,
        ticker,
        detail: body.slice(0, 200)
      });
    }
    const edgar = await edgarRes.json();

    if (edgar.error) {
      // Pass through structured errors so the UI can render them.
      return res.status(200).json({ ticker, error: edgar.error });
    }

    if (!edgar.filing_text) {
      return res.status(200).json({ ticker, error: 'Empty 10-K text from SEC EDGAR' });
    }

    // ── 2. HTML → text → key items ──
    const plain = htmlToText(edgar.filing_text);
    const trimmed = extractKeyItems(plain);
    console.log(`[filings-agent] ${ticker}: filing chars raw=${edgar.filing_text.length} text=${plain.length} sent=${trimmed.length}`);

    // ── 3. Call Claude with the analyst system prompt ──
    const userMessage =
      `Analyze this 10-K for ${ticker}. ` +
      `Filing date: ${edgar.filing_date}. ` +
      `Filing URL: ${edgar.filing_url}.\n\n` +
      `10-K text:\n${trimmed}\n\n` +
      `Return the structured JSON analysis.`;

    const claudeRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      console.log(`[filings-agent] ${ticker}: Claude HTTP ${claudeRes.status}`, claudeData);
      return res.status(502).json({
        ticker,
        error: 'Claude API call failed',
        detail: claudeData.error || claudeData
      });
    }

    const rawText = (claudeData.content || [])
      .map(b => (b && b.text) ? b.text : '')
      .join('')
      .trim();

    const analysis = extractJson(rawText);
    if (!analysis) {
      console.log(`[filings-agent] ${ticker}: failed to parse Claude JSON. Raw start:`, rawText.slice(0, 400));
      return res.status(502).json({
        ticker,
        error: 'Filings Agent returned non-JSON response',
        raw_preview: rawText.slice(0, 800)
      });
    }

    // ── 4. Return enriched payload ──
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json({
      ticker,
      company_name: edgar.company_name,
      cik: edgar.cik,
      filing_type: edgar.filing_type,
      filing_date: edgar.filing_date,
      report_date: edgar.report_date,
      filing_url: edgar.filing_url,
      index_url: edgar.index_url,
      source: 'SEC EDGAR + Claude',
      analysis,
      stats: {
        filing_chars: edgar.filing_text.length,
        text_chars: plain.length,
        sent_chars: trimmed.length
      }
    });
  } catch (err) {
    console.log(`[filings-agent] exception for ${ticker}:`, err && err.message);
    return res.status(500).json({
      ticker,
      error: 'Filings Agent failure: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
