// ═══════════════════════════════════════════════════════════════════
// /api/vc-feed — VC deal flow real, por categoría (v1 del censo aprobado)
//
//   GET /api/vc-feed?cat=rounds   → rondas por etapa (FinSMEs + TechCrunch)
//   GET /api/vc-feed?cat=latam    → rondas LATAM (LatamList + Contxto)
//   GET /api/vc-feed?cat=ipo      → pipeline IPO (Finnhub calendar + S-1 EDGAR)
//   GET /api/vc-feed?smoke=1      → smoke test: status + primeros bytes de
//                                   cada fuente, para correr contra Vercel
//                                   REAL antes de confiar en el parser
//                                   (lección Stocktwits: Cloudflare bloquea
//                                   IPs de datacenter — solo producción
//                                   responde qué fuentes entran).
//
// Principios (mismos del resto del API):
//   - Solo título + metadata + link a la fuente. NUNCA se republica cuerpo.
//   - Fecha = pubDate del feed. Sin pubDate parseable → date null, jamás hoy.
//   - Sector (AI/fintech/salud/clima/otro) lo clasifica Claude vía la capa
//     centralizada (guardedClaudeCall + ANTHROPIC_MODEL). Claude clasifica
//     titulares REALES, jamás inventa items: la respuesta se valida contra
//     la lista enviada (longitud + whitelist) o se descarta entera.
//   - Caché: Cache-Control s-maxage + stale-while-revalidate por categoría
//     + cache en memoria por instancia (patrón symbol-map). Fuente caída →
//     stale, o payload vacío honesto con flag de qué falló. Nunca bloquea,
//     nunca inventa.
// ═══════════════════════════════════════════════════════════════════

import { ANTHROPIC_MODEL } from './_lib/model.js';
import { guardedClaudeCall } from './_lib/ai-guard.js';

// UA identificado. SEC lo EXIGE (403/429 sin él); a los blogs les mandamos
// el mismo — si Cloudflare lo bloquea, el smoke test lo dirá y ajustamos.
const SEC_UA = 'QuantDesk research@quantdesk.app';
const BLOG_UA = 'Mozilla/5.0 (compatible; QuantDesk/1.0; research@quantdesk.app)';

const FEEDS = {
  finsmes: 'https://www.finsmes.com/feed/',
  techcrunch: 'https://techcrunch.com/category/venture/feed/',
  // Slugs de WordPress sin validar desde el sandbox (bloqueado): el smoke
  // prueba categoría Y feed principal; el parser cae al principal si la
  // categoría 404ea.
  latamlist: 'https://latamlist.com/category/funding/feed/',
  latamlist_main: 'https://latamlist.com/feed/',
  contxto: 'https://contxto.com/en/feed/',
  contxto_main: 'https://contxto.com/feed/',
  // Candidato de respaldo si TechCrunch bloquea (aún no entra al parser):
  crunchbase_news: 'https://news.crunchbase.com/feed/',
  // 1 request por build — muy por debajo del límite de 10 req/s de SEC.
  edgar_s1: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&company=&dateb=&owner=include&count=40&output=atom',
};

// ── Caché en memoria por instancia (patrón symbol-map) ──────────────
const TTL_MS = { rounds: 2 * 3600e3, latam: 8 * 3600e3, ipo: 24 * 3600e3 };
const CDN_CACHE = {
  rounds: 's-maxage=7200, stale-while-revalidate=14400',
  latam: 's-maxage=28800, stale-while-revalidate=43200',
  ipo: 's-maxage=86400, stale-while-revalidate=86400',
};
let memCache = {
  rounds: { at: 0, payload: null },
  latam: { at: 0, payload: null },
  ipo: { at: 0, payload: null },
};

// Hooks de tests (nunca se usan en producción).
export function _resetVcFeedCache() {
  memCache = { rounds: { at: 0, payload: null }, latam: { at: 0, payload: null }, ipo: { at: 0, payload: null } };
}
export function _expireVcFeedCache(cat) { if (memCache[cat]) memCache[cat].at = 0; }

// ── Fetch con timeout (una fuente colgada no bloquea el feed) ───────
async function fetchText(url, ua, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '', text };
  } finally {
    clearTimeout(timer);
  }
}

// ── Parsing RSS/Atom mínimo, sin dependencias ───────────────────────
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagContent(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
  return m ? m[1] : '';
}

// pubDate del feed → ISO (YYYY-MM-DD). No parseable → null, JAMÁS hoy.
function feedDate(raw) {
  if (!raw) return null;
  const d = new Date(decodeEntities(raw));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function parseRss(xml, limit = 40) {
  const blocks = String(xml || '').match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return blocks.slice(0, limit).map((b) => {
    const categories = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((m) => decodeEntities(m[1])).filter(Boolean);
    return {
      title: decodeEntities(tagContent(b, 'title')),
      link: decodeEntities(tagContent(b, 'link')),
      date: feedDate(tagContent(b, 'pubDate')),
      // El snippet SOLO se usa para extraer metadata (lead, país);
      // nunca viaja en el payload.
      snippet: stripTags(tagContent(b, 'description')).slice(0, 500),
      categories,
    };
  }).filter((i) => i.title);
}

// Atom de EDGAR (getcurrent): <entry><title>S-1 - ACME CORP (0001234567) (Filer)</title>…
export function parseEdgarAtom(xml, limit = 20) {
  const entries = String(xml || '').match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const e of entries) {
    const title = decodeEntities(tagContent(e, 'title'));
    const m = /^(S-1(?:\/A)?)\s+-\s+(.+?)\s*\((\d{10})\)/i.exec(title);
    if (!m) continue; // getcurrent puede colar S-1MEF u otros — fuera
    const href = /<link[^>]*href="([^"]+)"/i.exec(e);
    const updated = tagContent(e, 'updated');
    out.push({
      form: m[1].toUpperCase(),
      company: m[2].trim(),
      cik: m[3],
      amended: m[1].toUpperCase() !== 'S-1',
      link: href ? decodeEntities(href[1]) : null,
      date: feedDate(updated),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Extracción de metadata del titular (nunca del cuerpo) ───────────
export function extractAmount(text) {
  if (!text) return null;
  const m = /(US\$|USD\s?|\$|€|£)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(billion|bn|million|mn|m|b|k)?\b/i.exec(text);
  if (!m) return null;
  let num = m[2];
  num = /^\d{1,3}(,\d{3})+/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.');
  let n = parseFloat(num);
  if (isNaN(n)) return null;
  const unit = (m[3] || '').toLowerCase();
  let millions = null;
  if (unit === 'b' || unit === 'bn' || unit === 'billion') millions = n * 1000;
  else if (unit === 'm' || unit === 'mn' || unit === 'million') millions = n;
  else if (unit === 'k') millions = n / 1000;
  else if (n >= 1e6) millions = n / 1e6; // "$5,000,000" sin unidad
  else return null; // "$5" pelado: ambiguo, no se inventa
  const cur = m[1].startsWith('€') ? 'EUR' : m[1].startsWith('£') ? 'GBP' : 'USD';
  return { raw: m[0].replace(/\s+/g, ' ').trim(), currency: cur, millions: +millions.toFixed(2) };
}

export function extractStage(text) {
  if (!text) return null;
  if (/pre[- ]?seed/i.test(text)) return 'pre-seed';
  const s = /series\s+([a-k])\b/i.exec(text);
  if (s) return s[1].toUpperCase() === 'A' ? 'A' : 'B+';
  if (/\bseed\b/i.test(text)) return 'seed';
  return null;
}

export function extractLead(text) {
  if (!text) return null;
  const m = /(?:co-?led|led)\s+by\s+([^,;.]+)/i.exec(text);
  if (!m) return null;
  const lead = m[1].split(/\s+(?:and|with|alongside|y|junto)\s+/i)[0].replace(/\s+/g, ' ').trim();
  return lead.length >= 2 && lead.length <= 60 ? lead : null;
}

const FUNDING_VERBS = /\s+(raises?|raised|closes?|closed|secures?|secured|lands?|nabs?|snags?|banks?|gets?|obtains?|announces?|adds?|extends?|levanta|recauda|cierra|consigue|obtiene|anuncia)\b/i;

export function extractCompany(title) {
  if (!title) return null;
  const t = title.trim();
  const at = t.search(FUNDING_VERBS);
  if (at <= 0) return null; // sin verbo de ronda no hay ancla — no se adivina
  const head = t.slice(0, at).split(',')[0].replace(/[:;–—-]\s*$/, '').trim();
  return head && head.length <= 60 ? head : null;
}

const LATAM_COUNTRIES = [
  ['Mexico', /\bm[eé]xic|mexican/i],
  ['Brazil', /\bbrazil|brasil/i],
  ['Argentina', /\bargentin/i],
  ['Colombia', /\bcolombi/i],
  ['Chile', /\bchile/i],
  ['Peru', /\bper[uú]\b|peruvian/i],
  ['Uruguay', /\buruguay/i],
  ['Ecuador', /\becuador/i],
  ['Bolivia', /\bbolivi/i],
  ['Paraguay', /\bparaguay/i],
  ['Venezuela', /\bvenezuel/i],
  ['Costa Rica', /\bcosta\s*rica|costarric/i],
  ['Panama', /\bpanam[aá]/i],
  ['Guatemala', /\bguatemal/i],
  ['Dominican Republic', /\bdominican|rep[uú]blica dominicana/i],
  ['El Salvador', /\bel salvador|salvadoran|salvadore[ñn]/i],
  ['Honduras', /\bhondur/i],
  ['Nicaragua', /\bnicarag/i],
  ['Puerto Rico', /\bpuerto\s*ric/i],
];

export function extractCountry(text) {
  if (!text) return null;
  for (const [name, re] of LATAM_COUNTRIES) if (re.test(text)) return name;
  return null;
}

const LOOKS_FUNDING = /raise|raised|funding|round|series\s+[a-k]\b|\bseed\b|pre-seed|venture|invest|levanta|recauda|ronda|inversi[oó]n/i;

// ── Item de ronda a partir de un item RSS ───────────────────────────
function roundItem(rss, source, withCountry) {
  const meta = rss.title + ' ' + rss.snippet;
  const amount = extractAmount(rss.title) || extractAmount(rss.snippet);
  const it = {
    title: rss.title,
    company: extractCompany(rss.title),
    amount: amount ? amount.raw : null,
    amount_millions: amount ? amount.millions : null,
    currency: amount ? amount.currency : null,
    stage: extractStage(rss.title) || extractStage(rss.snippet),
    lead: extractLead(meta),
    sector: null, // lo llena Claude; sin IA queda null, jamás inventado
    source,
    link: rss.link || null,
    date: rss.date, // pubDate del feed; null si no vino — nunca hoy
  };
  if (withCountry) it.country = extractCountry(meta + ' ' + rss.categories.join(' '));
  return it;
}

function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = i.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function byDateDesc(a, b) { return String(b.date || '').localeCompare(String(a.date || '')); }

// ── Clasificación de sector vía la capa central de IA ───────────────
const SECTORS = ['AI', 'fintech', 'salud', 'clima', 'otro'];

export async function classifySectors(titles, apiKey, callImpl = guardedClaudeCall) {
  if (!titles.length) return [];
  const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
  try {
    // guard:false — clasificación mecánica de titulares: años viejos en un
    // titular son legítimos, no fechas alucinadas.
    const out = await callImpl({
      apiKey,
      guard: false,
      payload: {
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        system: 'Eres un clasificador de titulares de venture capital. Respondes SOLO un array JSON de strings, sin texto adicional.',
        messages: [{
          role: 'user',
          content: `Clasifica cada titular en exactamente uno de estos sectores: ${SECTORS.join(', ')}.\n` +
            `Responde SOLO un array JSON de ${titles.length} strings, en el mismo orden. Si dudas, usa "otro".\n\n${numbered}`,
        }],
      },
    });
    if (!out || out.status !== 200 || !out.data) return null;
    const text = ((out.data.content || []).map((b) => (b && b.text) || '').join('')).trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    // Claude clasifica, jamás inventa: longitud exacta + whitelist o nada.
    if (!Array.isArray(arr) || arr.length !== titles.length) return null;
    return arr.map((s) => (SECTORS.includes(String(s)) ? String(s) : 'otro'));
  } catch (_) {
    return null;
  }
}

async function applySectors(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'unavailable';
  if (!items.length) return 'skipped';
  const sectors = await classifySectors(items.map((i) => i.title), apiKey);
  if (!sectors) return 'error';
  items.forEach((it, i) => { it.sector = sectors[i]; });
  return 'ok';
}

// ── Builders por categoría ──────────────────────────────────────────
async function pullFeed(name, url, sources, fallbackUrl) {
  try {
    let r = await fetchText(url, BLOG_UA);
    let usedUrl = url;
    if (!r.ok && fallbackUrl) {
      const fb = await fetchText(fallbackUrl, BLOG_UA);
      if (fb.ok) { r = fb; usedUrl = fallbackUrl; }
    }
    if (!r.ok) {
      sources[name] = { ok: false, error: `HTTP ${r.status}` };
      return [];
    }
    const items = parseRss(r.text);
    sources[name] = { ok: true, items: items.length, url: usedUrl };
    return items;
  } catch (err) {
    sources[name] = { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) };
    return [];
  }
}

async function buildRounds() {
  const sources = {};
  const [finsmes, techcrunch] = await Promise.all([
    pullFeed('finsmes', FEEDS.finsmes, sources),
    pullFeed('techcrunch', FEEDS.techcrunch, sources),
  ]);
  // FinSMEs es casi todo funding pero cuela entrevistas; TechCrunch venture
  // trae opinión — solo pasan titulares con pinta de ronda.
  const items = dedupeByTitle([
    ...finsmes.filter((i) => LOOKS_FUNDING.test(i.title)).map((i) => roundItem(i, 'FinSMEs', false)),
    ...techcrunch.filter((i) => LOOKS_FUNDING.test(i.title)).map((i) => roundItem(i, 'TechCrunch', false)),
  ]).sort(byDateDesc).slice(0, 30);
  const ai = await applySectors(items);
  return { cat: 'rounds', items, sources, ai, stale: false, generated_at: new Date().toISOString() };
}

async function buildLatam() {
  const sources = {};
  const [latamlist, contxto] = await Promise.all([
    pullFeed('latamlist', FEEDS.latamlist, sources, FEEDS.latamlist_main),
    pullFeed('contxto', FEEDS.contxto, sources, FEEDS.contxto_main),
  ]);
  const items = dedupeByTitle([
    ...latamlist.filter((i) => LOOKS_FUNDING.test(i.title + ' ' + i.categories.join(' '))).map((i) => roundItem(i, 'LatamList', true)),
    ...contxto.filter((i) => LOOKS_FUNDING.test(i.title + ' ' + i.categories.join(' '))).map((i) => roundItem(i, 'Contxto', true)),
  ]).sort(byDateDesc).slice(0, 30);
  const ai = await applySectors(items);
  return { cat: 'latam', items, sources, ai, stale: false, generated_at: new Date().toISOString() };
}

async function buildIpo() {
  const sources = {};
  const finnhubKey = process.env.FINNHUB_API_KEY;

  const calendarP = (async () => {
    if (!finnhubKey) { sources.finnhub = { ok: false, error: 'FINNHUB_API_KEY not set' }; return []; }
    try {
      // Misma ventana que /api/ipos: -45d a +90d.
      const today = new Date();
      const fmt = (d) => d.toISOString().split('T')[0];
      const from = fmt(new Date(today.getTime() - 45 * 24 * 3600e3));
      const to = fmt(new Date(today.getTime() + 90 * 24 * 3600e3));
      const r = await fetch(`https://finnhub.io/api/v1/calendar/ipo?from=${from}&to=${to}&token=${finnhubKey}`);
      if (!r.ok) { sources.finnhub = { ok: false, error: `HTTP ${r.status}` }; return []; }
      const data = await r.json();
      const raw = Array.isArray(data.ipoCalendar) ? data.ipoCalendar : [];
      sources.finnhub = { ok: true, items: raw.length };
      return raw.map((ipo) => ({
        symbol: ipo.symbol || null,
        name: ipo.name || null,
        date: ipo.date || null,
        exchange: ipo.exchange || null,
        status: ipo.status || null, // expected | priced | withdrawn | filed
        price_range: ipo.price || null,
        shares: ipo.numberOfShares || null,
      })).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    } catch (err) {
      sources.finnhub = { ok: false, error: String((err && err.message) || err) };
      return [];
    }
  })();

  const pipelineP = (async () => {
    try {
      const r = await fetchText(FEEDS.edgar_s1, SEC_UA);
      if (!r.ok) { sources.edgar = { ok: false, error: `HTTP ${r.status}` }; return []; }
      const filings = parseEdgarAtom(r.text);
      sources.edgar = { ok: true, items: filings.length };
      return filings;
    } catch (err) {
      sources.edgar = { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) };
      return [];
    }
  })();

  const [calendar, pipeline] = await Promise.all([calendarP, pipelineP]);
  return { cat: 'ipo', items: calendar, pipeline, sources, stale: false, generated_at: new Date().toISOString() };
}

const BUILDERS = { rounds: buildRounds, latam: buildLatam, ipo: buildIpo };

// ── Smoke test (?smoke=1): correr contra Vercel REAL ────────────────
async function runSmoke() {
  const targets = [
    { name: 'finsmes', url: FEEDS.finsmes, ua: BLOG_UA },
    { name: 'techcrunch_venture', url: FEEDS.techcrunch, ua: BLOG_UA },
    { name: 'latamlist_funding', url: FEEDS.latamlist, ua: BLOG_UA },
    { name: 'latamlist_main', url: FEEDS.latamlist_main, ua: BLOG_UA },
    { name: 'contxto_en', url: FEEDS.contxto, ua: BLOG_UA },
    { name: 'contxto_main', url: FEEDS.contxto_main, ua: BLOG_UA },
    { name: 'crunchbase_news', url: FEEDS.crunchbase_news, ua: BLOG_UA },
    { name: 'edgar_s1_atom', url: FEEDS.edgar_s1, ua: SEC_UA },
  ];
  const results = await Promise.all(targets.map(async (t) => {
    const t0 = Date.now();
    try {
      const r = await fetchText(t.url, t.ua);
      const sample = r.text.slice(0, 200).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]+/g, '?');
      return {
        name: t.name, url: t.url, ok: r.ok, status: r.status,
        content_type: r.contentType, bytes: r.text.length, ms: Date.now() - t0,
        looks_like_feed: /<rss|<feed|<channel/i.test(r.text.slice(0, 2000)),
        items_parsed: r.ok ? (t.name === 'edgar_s1_atom' ? parseEdgarAtom(r.text).length : parseRss(r.text).length) : 0,
        sample,
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

  const cat = String(q.cat || '').toLowerCase();
  if (!BUILDERS[cat]) {
    return res.status(400).json({ error: 'cat must be rounds | latam | ipo (or pass smoke=1)' });
  }

  const entry = memCache[cat];
  if (entry.payload && Date.now() - entry.at < TTL_MS[cat]) {
    res.setHeader('Cache-Control', CDN_CACHE[cat]);
    return res.status(200).json(entry.payload);
  }

  try {
    const payload = await BUILDERS[cat]();
    const allDown = Object.values(payload.sources).length > 0 &&
      Object.values(payload.sources).every((s) => !s.ok);
    if (allDown && entry.payload) {
      // Todas las fuentes caídas y hay stale: se sirve lo último bueno con
      // los flags frescos de qué falló. El fallo NO pisa el cache.
      res.setHeader('Cache-Control', CDN_CACHE[cat]);
      return res.status(200).json({ ...entry.payload, stale: true, sources: payload.sources });
    }
    memCache[cat] = { at: Date.now(), payload };
    res.setHeader('Cache-Control', CDN_CACHE[cat]);
    return res.status(200).json(payload);
  } catch (err) {
    // Excepción imprevista: stale si hay, si no vacío honesto. Nunca 500 HTML.
    if (entry.payload) {
      res.setHeader('Cache-Control', CDN_CACHE[cat]);
      return res.status(200).json({ ...entry.payload, stale: true, error: String((err && err.message) || err) });
    }
    return res.status(200).json({
      cat, items: [], sources: {}, stale: false,
      error: 'Server exception: ' + String((err && err.message) || err),
      generated_at: new Date().toISOString(),
    });
  }
}
