// ═══════════════════════════════════════════════════════════════════
// /api/stock-tracker — Stock Tracker (censo aprobado: docs/stock-tracker-scope.md)
//
//   GET /api/stock-tracker?smoke=1  → smoke test: status + primeros bytes
//                                     de cada fuente de la v1, para correr
//                                     contra Vercel REAL antes de construir
//                                     (lección FinSMEs/Stocktwits: solo
//                                     producción responde qué fuentes entran
//                                     desde IPs de datacenter).
//
// v1 aprobada = insider buys destacados (Form 4) + movimientos 13F, como
// tab nuevo. Las categorías (?cat=...) se construyen DESPUÉS de que este
// smoke pase en producción. Congreso (eFD/House) queda en pausa: gate de
// smoke propio + duda legal EIGA §105(c) — no aparece aquí todavía.
//
// Fuentes que valida el smoke:
//   - Atom getcurrent type=4 (feed global Form 4, casi tiempo real)
//   - data.sec.gov submissions JSON por CIK — persona (Musk) y fondo
//     (Berkshire): la base de la vista por personaje y del pipeline 13F
//   - Archives: un Form 4 XML conocido (ownershipDocument parseable)
//   - company_tickers.json (mapeo CIK↔ticker)
//   - OpenFIGI v3 mapping CUSIP→ticker (gratis; OPENFIGI_API_KEY opcional
//     sube el rate limit)
// ═══════════════════════════════════════════════════════════════════

// UA identificado. SEC lo EXIGE (403/429 sin él) — mismo del resto del API.
const SEC_UA = 'QuantDesk research@quantdesk.app';

const SOURCES = {
  edgar_form4_atom: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=40&output=atom',
  // CIK personal (Elon Musk): confirma que submissions JSON sirve para
  // personas — historial de Form 4 cross-empresa para la vista por personaje.
  edgar_submissions_person: 'https://data.sec.gov/submissions/CIK0001494730.json',
  // CIK de fondo (Berkshire Hathaway): base del pipeline 13F.
  edgar_submissions_fund: 'https://data.sec.gov/submissions/CIK0001067983.json',
  // Form 4 XML real conocido (McDonald's 2012) — valida acceso a Archives
  // y que el ownershipDocument llega parseable.
  edgar_archives_form4: 'https://www.sec.gov/Archives/edgar/data/67472/000112760212009244/form4.xml',
  sec_company_tickers: 'https://www.sec.gov/files/company_tickers.json',
  openfigi_map: 'https://api.openfigi.com/v3/mapping',
};

// ── Fetch con timeout (una fuente colgada no bloquea el smoke) ──────
async function fetchRaw(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json, application/atom+xml, application/xml, text/xml, */*', ...(opts.headers || {}) },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '', text };
  } finally {
    clearTimeout(timer);
  }
}

function sample200(text) {
  return String(text || '').slice(0, 200).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]+/g, '?');
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Cada target valida lo que el pipeline real necesitará de esa fuente,
// no solo el HTTP 200.
const TARGETS = [
  {
    name: 'edgar_form4_atom', url: SOURCES.edgar_form4_atom,
    check(r) {
      const entries = (r.text.match(/<entry>/g) || []).length;
      return { looks_like: /<feed/i.test(r.text.slice(0, 2000)), items_parsed: entries };
    },
  },
  {
    name: 'edgar_submissions_person', url: SOURCES.edgar_submissions_person,
    check(r) {
      const j = tryJson(r.text);
      const forms = j && j.filings && j.filings.recent && Array.isArray(j.filings.recent.form) ? j.filings.recent.form : null;
      return {
        looks_like: !!forms,
        items_parsed: forms ? forms.filter((f) => f === '4').length : 0,
        entity: j ? j.name : null,
      };
    },
  },
  {
    name: 'edgar_submissions_fund', url: SOURCES.edgar_submissions_fund,
    check(r) {
      const j = tryJson(r.text);
      const forms = j && j.filings && j.filings.recent && Array.isArray(j.filings.recent.form) ? j.filings.recent.form : null;
      return {
        looks_like: !!forms,
        items_parsed: forms ? forms.filter((f) => f.startsWith('13F')).length : 0,
        entity: j ? j.name : null,
      };
    },
  },
  {
    name: 'edgar_archives_form4', url: SOURCES.edgar_archives_form4,
    check(r) {
      return {
        looks_like: /<ownershipDocument/i.test(r.text),
        items_parsed: (r.text.match(/<nonDerivativeTransaction>/g) || []).length,
      };
    },
  },
  {
    name: 'sec_company_tickers', url: SOURCES.sec_company_tickers,
    check(r) {
      const j = tryJson(r.text);
      const n = j ? Object.keys(j).length : 0;
      return { looks_like: !!(j && j['0'] && j['0'].ticker), items_parsed: n };
    },
  },
  {
    name: 'openfigi_map', url: SOURCES.openfigi_map,
    // CUSIP de Apple (037833100) → debe volver ticker AAPL.
    fetchOpts() {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.OPENFIGI_API_KEY) headers['X-OPENFIGI-APIKEY'] = process.env.OPENFIGI_API_KEY;
      return { method: 'POST', headers, body: JSON.stringify([{ idType: 'ID_CUSIP', idValue: '037833100' }]) };
    },
    check(r) {
      const j = tryJson(r.text);
      const ticker = Array.isArray(j) && j[0] && Array.isArray(j[0].data) && j[0].data[0] ? j[0].data[0].ticker : null;
      return { looks_like: ticker === 'AAPL', items_parsed: ticker ? 1 : 0, ticker };
    },
  },
];

async function runSmoke() {
  const results = await Promise.all(TARGETS.map(async (t) => {
    const t0 = Date.now();
    try {
      const r = await fetchRaw(t.url, t.fetchOpts ? t.fetchOpts() : {});
      return {
        name: t.name, url: t.url, ok: r.ok, status: r.status,
        content_type: r.contentType, bytes: r.text.length, ms: Date.now() - t0,
        ...(r.ok ? t.check(r) : { looks_like: false, items_parsed: 0 }),
        sample: sample200(r.text),
      };
    } catch (err) {
      return {
        name: t.name, url: t.url, ok: false, status: null, ms: Date.now() - t0,
        error: err && err.name === 'AbortError' ? 'timeout (12s)' : String((err && err.message) || err),
      };
    }
  }));
  return { smoke: true, results, generated_at: new Date().toISOString() };
}

// ── Handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};

  if (q.smoke) {
    // Resultados en vivo siempre — el smoke pierde sentido cacheado.
    res.setHeader('Cache-Control', 'no-store');
    const out = await runSmoke();
    return res.status(200).json(out);
  }

  // Las categorías v1 (insider | 13f) se construyen cuando este smoke
  // pase contra producción. Hasta entonces el endpoint lo dice de frente.
  return res.status(400).json({
    error: 'Stock Tracker v1 en construcción. Por ahora solo smoke=1 (gate previo al primer PR).',
    scope: 'docs/stock-tracker-scope.md',
  });
}
