// ═══════════════════════════════════════════════════════════════════
// Filings Agent
//
//   GET /api/filings-agent?ticker=NVDA
//
// Pipeline:
//   1. Hit /api/sec-edgar to pull the most recent annual report.
//      Default search order is 10-K → 20-F, so US domestic filers and
//      foreign private issuers (most LATAM ADRs) both resolve.
//   2. Strip HTML, slice down to the institutionally-relevant Items,
//      using a section priority list keyed off the actual filing_type.
//   3. Hand the trimmed text to Claude with an analyst prompt that's
//      filing-type aware.
//   4. Parse the structured JSON and return it alongside metadata.
// ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
import { ANTHROPIC_MODEL } from './_lib/model.js';
import { guardedClaudeCall } from './_lib/ai-guard.js';

// ── Bilingual support ─────────────────────────────────────────────
function langDirective(lang) {
  return lang === 'es'
    ? '\n\nIMPORTANTE: Responde completamente en español (español latinoamericano neutral). Todos los campos en lenguaje natural deben estar en español. Mantén los tickers, números, símbolos griegos (β, σ, ρ) y siglas (EPS, FX, ADR, BUY/HOLD/PASS, BEAT/MISS) en su forma original. Los nombres de empresas se mantienen en su idioma original. Las categorías cuantitativas (LOW/MODERATE/ELEVATED/EXTREME, INTACT/BREAKDOWN, etc.) se mantienen en inglés porque son códigos de estado del sistema; el resto del texto narrativo debe ser español.'
    : '';
}

// ~4 chars/token, so 360k chars ≈ 90k tokens — comfortable headroom in
// a 200k context window for the system prompt + JSON output.
const MAX_FILING_CHARS = 360_000;

// ── Section priority + budgets per filing type ─────────────────────
// Keys are normalized form: digit + optional uppercased letter, no
// punctuation. "Item 1A" → "1A", "Item 3.D" → "3D", "Item 5" → "5".
const SECTION_CONFIG = {
  '10-K': {
    priority: ['1A', '7', '7A', '1', '8', '1B', '1C', '3', '9A'],
    budgets: {
      '1A': 110_000, '7': 110_000, '7A': 30_000, '1': 50_000, '8': 50_000,
      '1B': 10_000, '1C': 10_000, '3': 10_000, '9A': 10_000
    },
    labels: {
      '1A': 'Item 1A', '7': 'Item 7', '7A': 'Item 7A', '1': 'Item 1', '8': 'Item 8',
      '1B': 'Item 1B', '1C': 'Item 1C', '3': 'Item 3', '9A': 'Item 9A'
    }
  },
  '20-F': {
    // 20-F headers: 3.D Risk Factors, 5 Operating & Financial Review,
    // 11 Quantitative & Qualitative Market Risk, 4 Information on the
    // Company, 18 Financial Statements. Backup: 3 (Key Info parent),
    // 7 (Major Shareholders), 10 (Additional Info), 15 (Controls).
    priority: ['3D', '5', '11', '4', '18', '3', '7', '10', '15'],
    budgets: {
      '3D': 110_000, '5': 110_000, '11': 30_000, '4': 50_000, '18': 50_000,
      '3':  20_000,  '7': 10_000,  '10': 10_000, '15': 10_000
    },
    labels: {
      '3D': 'Item 3.D', '5': 'Item 5', '11': 'Item 11', '4': 'Item 4', '18': 'Item 18',
      '3':  'Item 3',   '7': 'Item 7', '10': 'Item 10', '15': 'Item 15'
    }
  }
};

// ── HTML → plain text ──────────────────────────────────────────────
// 20-F filings from Brazilian / Mexican companies frequently include
// accented Portuguese / Spanish characters, often as numeric character
// references (&#225; for á). Decode them properly instead of dropping.
function decodeNumericEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      try { return String.fromCodePoint(code); } catch (_) { return ' '; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      try { return String.fromCodePoint(code); } catch (_) { return ' '; }
    });
}

function htmlToText(html) {
  if (!html) return '';
  let s = html
    // Drop XBRL inline tags & scripts/styles
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<ix:[^>]*>/gi, ' ')
    .replace(/<\/ix:[^>]*>/gi, ' ')
    // Block-level tags become newlines so item boundaries survive
    .replace(/<\/(p|div|tr|li|h[1-6]|br|table)[^>]*>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ');

  // Numeric entities — preserve UTF-8 (accented LATAM chars).
  s = decodeNumericEntities(s);

  // Named entities — handle the common ones explicitly, then drop the rest.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ');

  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Slice filing to institutionally-relevant Items ────────────────
// Recognizes both 10-K format ("Item 1A.") and 20-F format ("Item 3.D"
// or "Item 3D" or "Item 5").
function extractKeyItems(text, filingType) {
  if (!text) return '';

  const config = SECTION_CONFIG[filingType] || SECTION_CONFIG['10-K'];

  // Match: "Item <digits>" optionally followed by ".<letter>" or just
  // "<letter>" (10-K compact form: "Item 1A").
  const itemRegex = /\bitem\s+(\d{1,2})\.?\s*([a-z])?\b/gi;
  const matches = [];
  let m;
  while ((m = itemRegex.exec(text)) !== null) {
    const num = m[1];
    const letter = m[2] ? m[2].toUpperCase() : '';
    matches.push({ key: num + letter, offset: m.index });
  }

  if (matches.length === 0) {
    return text.slice(0, MAX_FILING_CHARS);
  }

  // Build sections: from each match to the next match. Keep the LONGEST
  // occurrence of each key — the cover page TOC lists items as short
  // chunks; the real section is longer.
  const sections = {};
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].offset;
    const end = i + 1 < matches.length ? matches[i + 1].offset : text.length;
    const key = matches[i].key;
    const chunk = text.slice(start, end);
    if (!sections[key] || chunk.length > sections[key].length) {
      sections[key] = chunk;
    }
  }

  let out = '';
  let used = 0;
  for (const key of config.priority) {
    const chunk = sections[key];
    if (!chunk) continue;
    const budget = config.budgets[key] || 10_000;
    const slice = chunk.slice(0, budget);
    const remaining = MAX_FILING_CHARS - used;
    if (remaining <= 0) break;
    const finalSlice = slice.length > remaining ? slice.slice(0, remaining) : slice;
    const label = config.labels[key] || `Item ${key}`;
    out += `\n\n=== ${label} ===\n${finalSlice}`;
    used += finalSlice.length;
  }

  if (used === 0) {
    return text.slice(0, MAX_FILING_CHARS);
  }
  return out.trim();
}

// ── System prompt builder (filing-type aware) ─────────────────────
function buildSystemPrompt(filingType) {
  const is20F = filingType === '20-F';

  const filingGuidance = is20F
    ? `You are analyzing a Form 20-F filing — the annual report for a foreign private issuer registered with the SEC.

For 20-F filings reference sections like:
- "Item 3.D, p.X" for Risk Factors
- "Item 5, p.X" for Operating and Financial Review and Prospects (the MD&A equivalent)
- "Item 4, p.X" for Information on the Company (business overview)
- "Item 11, p.X" for Quantitative and Qualitative Disclosures About Market Risk
- "Item 18, p.X" for Financial Statements

20-F filers are foreign companies, often with material currency risk, capital-controls exposure, cross-border regulatory complexity, and home-country macro factors. Your analysis should explicitly weight these factors — they are usually the dominant drivers of the equity's risk/return profile and most retail investors materially underweight them.`
    : `You are analyzing a Form 10-K filing — the annual report for a US domestic filer.

For 10-K filings reference sections like:
- "Item 1A, p.X" for Risk Factors
- "Item 7, p.X" for Management's Discussion and Analysis (MD&A)
- "Item 1, p.X" for Business
- "Item 7A, p.X" for Quantitative and Qualitative Disclosures
- "Item 8, p.X" for Financial Statements`;

  const sourceExamples = is20F
    ? `{"risk": "<description>", "severity": "high|medium|low", "source": "Item 3.D, p.<N>"}`
    : `{"risk": "<description>", "severity": "high|medium|low", "source": "Item 1A, p.<N>"}`;

  const segmentSource = is20F ? 'Item 5, p.<N>' : 'Item 7, p.<N>';
  const commentarySource = is20F ? 'Item 5 Operating Review' : 'Item 7 MD&A';

  const insightGuidance = is20F
    ? `<1-2 sentences of non-obvious insight that retail investors typically miss but hedge fund analysts would catch. For a 20-F filer, this should naturally weight foreign-issuer specifics: currency exposure, home-country rate/macro cycles, regulatory regime risk, capital-controls, dual-listing structural quirks, or related-party transactions disclosed in Item 7.B.>`
    : `<1-2 sentences of non-obvious insight that retail investors typically miss but hedge fund analysts would catch>`;

  return `You are a senior equity research analyst at a top-tier hedge fund. You're analyzing an SEC annual filing for institutional clients who need actionable insights with full traceability.

${filingGuidance}

Your output must be structured JSON. Every claim must include a page or section reference from the filing. Be specific, quantitative, and skeptical. Highlight what most retail investors would miss.

Output format (return ONLY valid JSON, no preamble):

{
  "ticker": "<ticker>",
  "filing_type": "${filingType}",
  "filing_date": "<date>",
  "executive_summary": "<2-3 sentence bottom line>",
  "top_risk_factors": [
    ${sourceExamples}
  ],
  "business_segments": [
    {"name": "<segment>", "revenue": "<$X.XB>", "yoy_growth": "<+/-X%>", "source": "${segmentSource}"}
  ],
  "management_commentary": {
    "tone_shift": "<more bullish | similar | more cautious vs prior year>",
    "key_changes": ["<change 1>", "<change 2>"],
    "source": "${commentarySource}"
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
  "institutional_insight": "${insightGuidance}"
}

Return up to 5 top_risk_factors, all major business_segments, and at most 3 red_flags (omit the array entries entirely if you find none). Every citation must use a section label consistent with this filing's structure.`;
}

// ── Best-effort JSON extraction from Claude's response ──────────────
function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) { /* fall through */ }
  }
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
  const lang = (req.query.lang || 'en').toString().toLowerCase();
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
    // Ask sec-edgar for either an annual filing — 10-K preferred, 20-F fallback.
    const edgarUrl = `${base}/api/sec-edgar?ticker=${encodeURIComponent(ticker)}&filing=10-K,20-F`;

    console.log(`[filings-agent] ${ticker}: fetching ${edgarUrl}`);
    const edgarRes = await fetch(edgarUrl);
    if (!edgarRes.ok && edgarRes.status !== 200) {
      const body = await edgarRes.text().catch(() => '');
      return res.status(502).json({
        error: `SEC EDGAR endpoint failed (HTTP ${edgarRes.status})`,
        ticker,
        detail: body.slice(0, 200)
      });
    }
    const edgar = await edgarRes.json();

    if (edgar.error) {
      return res.status(200).json({ ticker, error: edgar.error });
    }
    if (!edgar.filing_text) {
      return res.status(200).json({ ticker, error: 'Empty filing text from SEC EDGAR' });
    }

    const filingType = (edgar.filing_type || '10-K').toUpperCase();
    const filingTypeKnown = SECTION_CONFIG[filingType] ? filingType : '10-K';

    // ── 2. HTML → text → key items ──
    const plain = htmlToText(edgar.filing_text);
    const trimmed = extractKeyItems(plain, filingTypeKnown);
    console.log(`[filings-agent] ${ticker}: type=${filingTypeKnown} chars raw=${edgar.filing_text.length} text=${plain.length} sent=${trimmed.length}`);

    // ── 3. Call Claude with the analyst system prompt ──
    const systemPrompt = buildSystemPrompt(filingTypeKnown);
    const userMessage =
      `Analyze this ${filingTypeKnown} for ${ticker}` +
      (edgar.company_name ? ` (${edgar.company_name})` : '') + `. ` +
      `Filing date: ${edgar.filing_date}. ` +
      `Filing URL: ${edgar.filing_url}.\n\n` +
      `Filing text:\n${trimmed}\n\n` +
      `Return the structured JSON analysis.`;

    // guard:false — el análisis de un filing histórico cita legítimamente
    // años pasados y forward-looking statements del documento ("projected
    // growth into 2025" de un 10-K de 2024): el escaneo prospectivo daría
    // falsos positivos y el retry re-mandaría el filing completo. La fecha
    // de HOY sí se inyecta, y el userMessage ya ancla la Filing date.
    const g = await guardedClaudeCall({ apiKey, guard: false, payload: {
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      system: systemPrompt + langDirective(lang),
      messages: [{ role: 'user', content: userMessage }]
    } });

    const claudeData = g.data;
    if (g.status >= 400) {
      console.log(`[filings-agent] ${ticker}: Claude HTTP ${g.status}`, claudeData);
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
      filing_type: filingTypeKnown,
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
