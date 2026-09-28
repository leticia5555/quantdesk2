// ═══════════════════════════════════════════════════════════════════
// /api/stock-tracker — Stock Tracker v1 (censo y decisión:
// docs/stock-tracker-scope.md; smoke 6/6 OK contra producción jul 2026)
//
//   GET /api/stock-tracker?cat=insider → insider buys destacados (Form 4):
//        compras open-market (code P) de officers/directors ≥ $100k,
//        desde el atom getcurrent de EDGAR + XML de cada filing.
//   GET /api/stock-tracker?cat=13f     → movimientos 13F: diff propio
//        (nuevas/cerradas/aumentos/recortes) entre los dos últimos
//        trimestres de fondos famosos (CIKs verificados en el censo).
//   GET /api/stock-tracker?smoke=1     → smoke test de fuentes, en vivo.
//
// Principios (mismos de vc-feed):
//   - Solo datos de filings REALES de EDGAR. Nada de IA inventando trades.
//   - Honestidad de lag: cada item lleva fecha de trade/cierre Y fecha de
//     filing — el lag se muestra, no se esconde.
//   - Caché doble (memoria por instancia + CDN s-maxage/swr). Fuente
//     caída → stale con flag, o payload vacío honesto. Nunca 500 HTML.
//   - SEC: User-Agent identificado obligatorio y ≤10 req/s — los fetches
//     en lote van en tandas con piso de 1s (≤8 req/s efectivos).
//
// Congreso (eFD/House) NO está aquí: activable con gates propios (smoke
// de efdsearch + consulta legal puntual + modo mostrar-solo, ver scope).
// ═══════════════════════════════════════════════════════════════════

// UA identificado. SEC lo EXIGE (403/429 sin él) — mismo del resto del API.
const SEC_UA = 'QuantDesk research@quantdesk.app';

// Compra "destacada": open-market (P), officer/director, valor mínimo.
const NOTABLE_MIN_USD = 100000;

// ── Moneda del precio (footnotes del Form 4) ────────────────────────
// El precio de la Tabla I NO siempre es USD: emisores extranjeros con
// listado dual (CEMEX CPO, etc.) reportan el precio de la bolsa local y
// lo aclaran en un footnote ("Price in Mexican Pesos (MXN)"). Sin leerlo,
// 400,800 CPO × MX$17.28 se pintaba como US$6.9M (≈18× el valor real).
// Regla: la moneda se toma SOLO de los footnotes referenciados por el
// precio (o, si no hay, por la transacción); sin mención explícita → USD.
const CURRENCY_PATTERNS = [
  ['MXN', /\bMXN\b|mexican\s+pesos?|pesos?\s+mexicanos?/i],
  ['EUR', /\bEUR\b|\beuros?\b/i],
  ['GBP', /\bGBP\b|pounds?\s+sterling|british\s+pounds?|\bpence\b/i],
  ['CAD', /\bCAD\b|canadian\s+dollars?/i],
  ['BRL', /\bBRL\b|\breais\b|brazilian\s+reals?/i],
  ['JPY', /\bJPY\b|japanese\s+yen|\byen\b/i],
  ['CHF', /\bCHF\b|swiss\s+francs?/i],
  ['ILS', /\bILS\b|\bNIS\b|israeli\s+shekels?|new\s+shekels?/i],
  ['HKD', /\bHKD\b|hong\s+kong\s+dollars?/i],
  ['AUD', /\bAUD\b|australian\s+dollars?/i],
  ['INR', /\bINR\b|indian\s+rupees?/i],
  ['SEK', /\bSEK\b|swedish\s+kron(?:a|or)/i],
  ['NOK', /\bNOK\b|norwegian\s+kron(?:e|er)/i],
  ['DKK', /\bDKK\b|danish\s+kron(?:e|er)/i],
  ['ZAR', /\bZAR\b|south\s+african\s+rand/i],
  ['CLP', /\bCLP\b|chilean\s+pesos?/i],
  ['COP', /\bCOP\b|colombian\s+pesos?/i],
  ['PEN', /\bPEN\b|peruvian\s+sol(?:es)?|nuevos?\s+sol(?:es)?/i],
  ['ARS', /\bARS\b|argentine\s+pesos?/i],
  ['KRW', /\bKRW\b|korean\s+won/i],
  ['TWD', /\bTWD\b|taiwan\s+dollars?/i],
];
// Tipo de cambio APROXIMADO (unidades por USD) — se usa SOLO para aplicar
// el umbral de $100k y para la etiqueta "≈ US$" de referencia. El monto
// principal de la card se muestra en la moneda del filing, que es el dato
// real. Revisar de vez en cuando; un desvío de ±20% no cambia qué pasa el
// umbral. Moneda no listada → el item se excluye y se cuenta en scan.
const FX_TO_USD_APPROX = {
  MXN: 18.5, EUR: 0.92, GBP: 0.78, CAD: 1.37, BRL: 5.5, JPY: 150, CHF: 0.88,
  ILS: 3.7, HKD: 7.8, AUD: 1.5, INR: 84, SEK: 10.5, NOK: 10.7, DKK: 6.9,
  ZAR: 18, CLP: 950, COP: 4100, PEN: 3.75, ARS: 1300, KRW: 1380, TWD: 32,
};

// Texto de footnotes → código de moneda, o null si no se menciona ninguna.
export function detectCurrency(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const [code, re] of CURRENCY_PATTERNS) if (re.test(s)) return code;
  return null;
}

// <footnotes><footnote id="F2">…</footnote></footnotes> → Map id→texto.
export function parseFootnotes(xml) {
  const out = new Map();
  const re = /<(?:\w+:)?footnote\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?footnote>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    out.set(m[1], m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

function footnoteIds(block) {
  return [...String(block || '').matchAll(/<(?:\w+:)?footnoteId\s+id="([^"]+)"/gi)].map((m) => m[1]);
}

// Unidad del instrumento según securityTitle (para la card: "CPO" en vez
// de "sh" cuando el filing lo dice; ADS/ADR idem).
export function securityUnit(title) {
  const s = String(title || '');
  if (/\bCPOs?\b|participation certificates?/i.test(s)) return 'CPO';
  if (/\bADSs?\b|\bADRs?\b|depositary/i.test(s)) return 'ADS';
  return 'sh';
}
// Filings únicos a inspeccionar por build (2 páginas de atom ≈ 100-200
// entries → ~60-100 únicos). Cap para caber holgados en maxDuration=60s
// a ≤8 req/s: cada filing cuesta 2 requests (index.json + XML).
const SCAN_CAP = 60;
// El acumulador de instancia retiene compras destacadas de los últimos
// 7 días entre builds (mejor cobertura mientras la instancia esté warm;
// un cold start arranca solo con la ventana del atom — limitación
// documentada en el payload via scan.accumulated).
const ACCUM_MAX_AGE_DAYS = 7;

// Fondos v1 — SOLO CIKs verificados en el censo (los CIK son permanentes,
// hardcodearlos es seguro). Ampliar la lista = agregar aquí.
const FUNDS = [
  { cik: 1067983, name: 'Berkshire Hathaway', persona: 'Warren Buffett' },
  { cik: 1350694, name: 'Bridgewater Associates', persona: 'Ray Dalio' },
  { cik: 1697748, name: 'ARK Investment Management', persona: 'Cathie Wood' },
  { cik: 1649339, name: 'Scion Asset Management', persona: 'Michael Burry' },
  { cik: 1336528, name: 'Pershing Square', persona: 'Bill Ackman' },
  { cik: 1037389, name: 'Renaissance Technologies', persona: 'Renaissance' },
];

const SOURCES = {
  edgar_form4_atom: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&output=atom',
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

// ── Caché en memoria por instancia (patrón vc-feed) ─────────────────
const TTL_MS = { insider: 30 * 60e3, '13f': 24 * 3600e3 };
const CDN_CACHE = {
  insider: 's-maxage=1800, stale-while-revalidate=3600',
  '13f': 's-maxage=86400, stale-while-revalidate=86400',
};
let memCache = { insider: { at: 0, payload: null }, '13f': { at: 0, payload: null } };
// accession → item de compra destacada (sobrevive entre builds warm).
let insiderAccum = new Map();
// CUSIP → ticker (los CUSIP de un fondo cambian poco; el mapa es estable).
let cusipTickerCache = new Map();

// Hooks de tests (nunca se usan en producción).
export function _resetTrackerCache() {
  memCache = { insider: { at: 0, payload: null }, '13f': { at: 0, payload: null } };
  insiderAccum = new Map();
  cusipTickerCache = new Map();
}
export function _expireTrackerCache(cat) { if (memCache[cat]) memCache[cat].at = 0; }

// ── Fetch con timeout (una fuente colgada no bloquea el build) ──────
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

// Tandas de ≤8 con piso de 1s por tanda → ≤8 req/s, bajo el límite SEC.
async function batchedMap(items, fn, batchSize = 8, floorMs = 1000) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const t0 = Date.now();
    const chunk = await Promise.all(items.slice(i, i + batchSize).map((it) =>
      fn(it).catch(() => null)));
    out.push(...chunk);
    const left = floorMs - (Date.now() - t0);
    if (left > 0 && i + batchSize < items.length) await new Promise((r) => setTimeout(r, left));
  }
  return out;
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sample200(text) {
  return String(text || '').slice(0, 200).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]+/g, '?');
}

// Tags XML con o sin prefijo de namespace (13F suele venir como ns1:cusip).
function xtag(block, tag) {
  const m = new RegExp('<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>', 'i').exec(block);
  return m ? m[1].trim() : '';
}
// Form 4 anida los valores: <transactionDate><value>2026-01-02</value>…
function xval(block, tag) {
  const inner = xtag(block, tag);
  const v = xtag(inner, 'value');
  return (v || inner).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function lagDays(fromIso, toIso) {
  const a = new Date(fromIso), b = new Date(toIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 864e5));
}

// ═══ FORM 4 — insider buys destacados ═══════════════════════════════

// Atom getcurrent: cada filing aparece 2 veces (Issuer y Reporting) —
// se dedupe por accession. Devuelve [{accession, cik, link, updated}].
export function parseForm4Atom(text) {
  const out = new Map();
  const entries = String(text || '').match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const e of entries) {
    const href = (/<link[^>]*href="([^"]+)"/i.exec(e) || [])[1] || '';
    const acc = (/(\d{10}-\d{2}-\d{6})/.exec(href) || /(\d{10}-\d{2}-\d{6})/.exec(e) || [])[1];
    const cik = (/\/edgar\/data\/(\d+)\//i.exec(href) || [])[1];
    if (!acc || !cik || out.has(acc)) continue;
    out.set(acc, { accession: acc, cik, link: href.replace(/&amp;/g, '&'), updated: xtag(e, 'updated') || null });
  }
  return [...out.values()];
}

// ownershipDocument → issuer, owners (cargo real) y compras open-market.
export function parseForm4Xml(xml) {
  const s = String(xml || '');
  if (!/<(?:\w+:)?ownershipDocument/i.test(s)) return null;
  const issuerBlock = xtag(s, 'issuer');
  const issuer = {
    name: xval(issuerBlock, 'issuerName') || null,
    ticker: (xval(issuerBlock, 'issuerTradingSymbol') || '').toUpperCase() || null,
    cik: xval(issuerBlock, 'issuerCik') || null,
  };
  // El ticker puede venir vacío o placeholder — la card degrada a nombre.
  if (issuer.ticker === 'N/A' || issuer.ticker === 'NONE') issuer.ticker = null;
  const owners = (s.match(/<(?:\w+:)?reportingOwner>[\s\S]*?<\/(?:\w+:)?reportingOwner>/gi) || []).map((b) => {
    const yes = (tag) => /^(1|true)$/i.test(xval(b, tag));
    return {
      name: xval(b, 'rptOwnerName') || null,
      cik: xval(b, 'rptOwnerCik') || null,
      isDirector: yes('isDirector'),
      isOfficer: yes('isOfficer'),
      isTenPercentOwner: yes('isTenPercentOwner'),
      officerTitle: xval(b, 'officerTitle') || null,
    };
  });
  const planned10b5 = /^(1|true)$/i.test(xval(s, 'aff10b5One'));
  const footnotes = parseFootnotes(s);
  const noteText = (ids) => ids.map((id) => footnotes.get(id) || '').join(' ');
  const buys = (s.match(/<(?:\w+:)?nonDerivativeTransaction>[\s\S]*?<\/(?:\w+:)?nonDerivativeTransaction>/gi) || [])
    .map((b) => {
      // Moneda: primero los footnotes colgados del precio; si el precio no
      // trae ninguno, los de toda la transacción. Nada → USD (null).
      const priceBlock = xtag(b, 'transactionPricePerShare');
      const priceIds = footnoteIds(priceBlock);
      const currency = detectCurrency(noteText(priceIds.length ? priceIds : footnoteIds(b)));
      const securityTitle = xval(b, 'securityTitle') || null;
      const ownBlock = xtag(b, 'ownershipNature');
      const dio = xval(ownBlock, 'directOrIndirectOwnership').toUpperCase();
      return {
        code: xval(b, 'transactionCode'),
        ad: xval(b, 'transactionAcquiredDisposedCode'),
        date: xval(b, 'transactionDate') || null,
        shares: parseFloat(xval(b, 'transactionShares')) || 0,
        price: parseFloat(xval(b, 'transactionPricePerShare')) || 0,
        currency,
        securityTitle,
        indirect: dio === 'I',
        ownershipNature: dio === 'I' ? (xval(ownBlock, 'natureOfOwnership') || null) : null,
      };
    })
    .filter((tx) => tx.code === 'P' && tx.ad === 'A' && tx.shares > 0 && tx.price > 0);
  return { issuer, owners, planned10b5, buys };
}

// Filing parseado → item destacado, o null si no pasa el filtro.
// `stats` (opcional) acumula descartes no-obvios (moneda sin tipo de
// cambio) para que scan.* los exponga y la cobertura sea auditable.
export function extractNotableBuy(doc, meta, minUsd = NOTABLE_MIN_USD, stats = null) {
  if (!doc || !doc.buys.length) return null;
  const lead = doc.owners.find((o) => o.isOfficer || o.isDirector);
  if (!lead) return null;
  // Un filing con compras en dos monedas distintas no se suma: se toma la
  // moneda de la primera compra y se ignoran las demás (caso rarísimo).
  const currency = doc.buys[0].currency || null;
  const buys = doc.buys.filter((tx) => (tx.currency || null) === currency);
  const value = buys.reduce((s, tx) => s + tx.shares * tx.price, 0);
  // Umbral en USD: moneda local → conversión aproximada solo para el
  // umbral; moneda desconocida → fuera (no se puede comparar honestamente).
  let valueUsdApprox = null;
  if (currency) {
    const fx = FX_TO_USD_APPROX[currency];
    if (!fx) {
      if (stats) stats.fx_unknown = (stats.fx_unknown || 0) + 1;
      return null;
    }
    valueUsdApprox = Math.round(value / fx);
  }
  if ((currency ? valueUsdApprox : value) < minUsd) return null;
  const shares = buys.reduce((s, tx) => s + tx.shares, 0);
  const tradeDate = buys.map((tx) => tx.date).filter(Boolean).sort()[0] || null;
  const filedDate = meta.updated ? meta.updated.slice(0, 10) : null;
  const indirect = buys.some((tx) => tx.indirect);
  return {
    accession: meta.accession,
    insider: lead.name,
    insiderCik: lead.cik,
    role: lead.officerTitle || (lead.isDirector ? 'Director' : 'Officer'),
    issuer: doc.issuer.name,
    ticker: doc.issuer.ticker,
    issuerCik: doc.issuer.cik,
    shares: Math.round(shares),
    unit: securityUnit(buys[0].securityTitle),
    avgPrice: shares > 0 ? +(value / shares).toFixed(2) : null,
    // `value` está en `currency` (null = USD). Si hay moneda local, el
    // dato real es value+currency; valueUsdApprox es solo referencia.
    value: Math.round(value),
    currency,
    valueUsdApprox,
    // Tenencia indirecta (cónyuge, trust, holding) — el filing lo declara.
    indirect,
    ownershipNature: indirect ? (buys.find((tx) => tx.indirect).ownershipNature || null) : null,
    tradeDate,
    filedDate,
    // Honestidad de lag: días entre el trade y el filing (máx legal: 2 hábiles).
    lagDays: tradeDate && filedDate ? lagDays(tradeDate, filedDate) : null,
    planned10b5: doc.planned10b5,
    link: meta.link || null,
  };
}

// ≥2 insiders distintos comprando el mismo issuer en la ventana → cluster
// (la señal clásica pesa más cuando compran varios a la vez).
export function markClusters(items) {
  const byIssuer = new Map();
  for (const it of items) {
    const k = it.issuerCik || it.issuer;
    if (!byIssuer.has(k)) byIssuer.set(k, new Set());
    byIssuer.get(k).add(it.insiderCik || it.insider);
  }
  return items.map((it) => ({ ...it, cluster: byIssuer.get(it.issuerCik || it.issuer).size >= 2 }));
}

async function buildInsider() {
  const sources = {};
  let entries = [];
  try {
    // 2 páginas del atom (getcurrent pagina con &start=; count máx 100).
    const pages = await Promise.all([0, 100].map((start) =>
      fetchRaw(SOURCES.edgar_form4_atom + '&start=' + start)));
    const bad = pages.find((p) => !p.ok);
    if (bad && !pages.some((p) => p.ok)) {
      sources.edgar_form4_atom = { ok: false, error: `HTTP ${bad.status}` };
    } else {
      entries = pages.filter((p) => p.ok).flatMap((p) => parseForm4Atom(p.text));
      // Dedupe cross-página por accession.
      entries = [...new Map(entries.map((e) => [e.accession, e])).values()];
      sources.edgar_form4_atom = { ok: true, items: entries.length };
    }
  } catch (err) {
    sources.edgar_form4_atom = { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) };
  }

  const toScan = entries.filter((e) => !insiderAccum.has(e.accession)).slice(0, SCAN_CAP);
  let fetched = 0;
  const skipStats = {};
  // Por filing: index.json del accession (el nombre del XML varía) → XML.
  const found = await batchedMap(toScan, async (e) => {
    const dir = `https://www.sec.gov/Archives/edgar/data/${e.cik}/${e.accession.replace(/-/g, '')}`;
    const idx = await fetchRaw(dir + '/index.json');
    if (!idx.ok) return null;
    const j = tryJson(idx.text);
    const files = (j && j.directory && j.directory.item) || [];
    const xmlFile = files.find((f) => /\.xml$/i.test(f.name) && !/^primary_doc\.xml$/i.test(f.name)) ||
      files.find((f) => /\.xml$/i.test(f.name));
    if (!xmlFile) return null;
    const xml = await fetchRaw(dir + '/' + xmlFile.name);
    fetched++;
    if (!xml.ok) return null;
    return extractNotableBuy(parseForm4Xml(xml.text), e, NOTABLE_MIN_USD, skipStats);
  });

  // Merge al acumulador de instancia + poda por edad.
  for (const it of found) if (it) insiderAccum.set(it.accession, it);
  const cutoff = new Date(Date.now() - ACCUM_MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [acc, it] of insiderAccum) {
    if ((it.filedDate || '') < cutoff) insiderAccum.delete(acc);
  }

  // Orden por tamaño comparable: USD real o la aproximación (nunca el
  // monto nominal en moneda local, que mezclaría pesos con dólares).
  const usd = (it) => (it.currency ? it.valueUsdApprox : it.value) || 0;
  const items = markClusters([...insiderAccum.values()])
    .sort((a, b) => (b.filedDate || '').localeCompare(a.filedDate || '') || usd(b) - usd(a))
    .slice(0, 60);

  return {
    cat: 'insider',
    items,
    // Cobertura honesta: qué se escaneó este build y cuánto acumula la
    // instancia — un cold start solo ve la ventana del atom.
    scan: { atom_entries: entries.length, inspected: toScan.length, xml_fetched: fetched, accumulated: insiderAccum.size, ...skipStats },
    fx_note: 'Precios en moneda local (footnote del Form 4) se muestran en esa moneda; "≈ US$" usa un tipo de cambio fijo aproximado, solo referencia',
    lag_note: 'SEC Form 4: reportado máx. 2 días hábiles después del trade',
    sources,
    stale: false,
    generated_at: new Date().toISOString(),
  };
}

// ═══ 13F — movimientos del trimestre ════════════════════════════════

// infotable XML → posiciones agregadas por CUSIP (solo acciones SH sin
// putCall: los diffs de shares mezclando opciones serían mentira).
export function parse13FInfotable(xml) {
  const blocks = String(xml || '').match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [];
  const byCusip = new Map();
  for (const b of blocks) {
    if (xtag(b, 'putCall')) continue;
    const type = xtag(b, 'sshPrnamtType').toUpperCase();
    if (type && type !== 'SH') continue;
    const cusip = xtag(b, 'cusip').toUpperCase();
    if (!cusip) continue;
    const value = parseFloat(xtag(b, 'value')) || 0; // dólares completos (post-2023)
    const shares = parseFloat(xtag(b, 'sshPrnamt')) || 0;
    const prev = byCusip.get(cusip) || { cusip, name: xtag(b, 'nameOfIssuer') || null, value: 0, shares: 0 };
    prev.value += value;
    prev.shares += shares;
    byCusip.set(cusip, prev);
  }
  return byCusip;
}

// Diff por CUSIP entre dos trimestres. EDGAR solo da snapshots — esto es
// el JOIN que ningún agregador gratuito confiable ofrece ya computado.
export function diff13F(prevMap, currMap) {
  const added = [], closed = [], increased = [], reduced = [];
  for (const [cusip, cur] of currMap) {
    const prev = prevMap.get(cusip);
    if (!prev) { added.push({ ...cur }); continue; }
    if (cur.shares > prev.shares) increased.push({ ...cur, deltaShares: Math.round(cur.shares - prev.shares), deltaPct: prev.shares > 0 ? +((cur.shares / prev.shares - 1) * 100).toFixed(1) : null });
    else if (cur.shares < prev.shares) reduced.push({ ...cur, deltaShares: Math.round(cur.shares - prev.shares), deltaPct: prev.shares > 0 ? +((cur.shares / prev.shares - 1) * 100).toFixed(1) : null });
  }
  for (const [cusip, prev] of prevMap) {
    if (!currMap.has(cusip)) closed.push({ ...prev });
  }
  const byValue = (a, b) => b.value - a.value;
  return {
    added: added.sort(byValue),
    closed: closed.sort(byValue),
    increased: increased.sort(byValue),
    reduced: reduced.sort(byValue),
    counts: { added: added.length, closed: closed.length, increased: increased.length, reduced: reduced.length, held: currMap.size },
  };
}

// index.json del accession → nombre del infotable (el XML grande que no
// es primary_doc; los filers lo nombran como quieren).
export function pickInfotableFile(indexJson) {
  const files = ((indexJson || {}).directory || {}).item || [];
  const xmls = files.filter((f) => /\.xml$/i.test(f.name) && !/^primary_doc\.xml$/i.test(f.name));
  if (!xmls.length) return null;
  const named = xmls.find((f) => /info.?table|form13f/i.test(f.name));
  if (named) return named.name;
  return xmls.sort((a, b) => (parseInt(b.size, 10) || 0) - (parseInt(a.size, 10) || 0))[0].name;
}

// CUSIP→ticker vía OpenFIGI (gratis; sin key = 10 jobs/request). Falla →
// la card muestra nameOfIssuer, que siempre viene en el filing.
async function mapCusipsToTickers(cusips) {
  const missing = [...new Set(cusips)].filter((c) => !cusipTickerCache.has(c));
  const hasKey = !!process.env.OPENFIGI_API_KEY;
  const chunkSize = hasKey ? 100 : 10;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (hasKey) headers['X-OPENFIGI-APIKEY'] = process.env.OPENFIGI_API_KEY;
      const r = await fetchRaw(SOURCES.openfigi_map, {
        method: 'POST', headers,
        body: JSON.stringify(chunk.map((c) => ({ idType: 'ID_CUSIP', idValue: c }))),
      }, 8000);
      if (!r.ok) break; // rate limit de OpenFIGI: degradamos a nombres, no insistimos
      const arr = tryJson(r.text);
      if (!Array.isArray(arr)) break;
      arr.forEach((res, j) => {
        const ticker = res && Array.isArray(res.data) && res.data[0] ? res.data[0].ticker : null;
        cusipTickerCache.set(chunk[j], ticker || null);
      });
    } catch { break; }
  }
  const out = new Map();
  for (const c of cusips) out.set(c, cusipTickerCache.get(c) || null);
  return out;
}

const TOP_N = 5;

async function build13F() {
  const sources = {};
  const funds = await batchedMap(FUNDS, async (fund) => {
    const padded = String(fund.cik).padStart(10, '0');
    const sub = await fetchRaw(`https://data.sec.gov/submissions/CIK${padded}.json`);
    if (!sub.ok) { sources[fund.name] = { ok: false, error: `HTTP ${sub.status}` }; return null; }
    const j = tryJson(sub.text);
    const rec = j && j.filings && j.filings.recent;
    if (!rec) { sources[fund.name] = { ok: false, error: 'submissions sin filings.recent' }; return null; }
    // Dos últimos 13F-HR con reportDate distinto (amendments /A fuera del
    // MVP — riesgo documentado en el scope).
    const picks = [];
    for (let i = 0; i < rec.form.length && picks.length < 2; i++) {
      if (rec.form[i] !== '13F-HR') continue;
      if (picks.some((p) => p.reportDate === rec.reportDate[i])) continue;
      picks.push({ accession: rec.accessionNumber[i], reportDate: rec.reportDate[i], filingDate: rec.filingDate[i] });
    }
    if (picks.length < 2) { sources[fund.name] = { ok: false, error: 'menos de 2 13F-HR' }; return null; }
    const tables = [];
    for (const p of picks) {
      const dir = `https://www.sec.gov/Archives/edgar/data/${fund.cik}/${p.accession.replace(/-/g, '')}`;
      const idx = await fetchRaw(dir + '/index.json');
      const fname = idx.ok ? pickInfotableFile(tryJson(idx.text)) : null;
      if (!fname) { tables.push(null); continue; }
      const xml = await fetchRaw(dir + '/' + fname, {}, 20000); // Renaissance ≈ 2.5MB
      tables.push(xml.ok ? parse13FInfotable(xml.text) : null);
    }
    if (!tables[0] || !tables[1]) { sources[fund.name] = { ok: false, error: 'infotable no descargable' }; return null; }
    sources[fund.name] = { ok: true, positions: tables[0].size };
    const [curr, currMeta, prevMeta] = [tables[0], picks[0], picks[1]];
    const d = diff13F(tables[1], curr);
    const totalValue = [...curr.values()].reduce((s, p) => s + p.value, 0);
    return {
      fund: fund.name,
      persona: fund.persona,
      cik: fund.cik,
      quarterEnd: currMeta.reportDate,
      filedDate: currMeta.filingDate,
      // Honestidad de lag: días entre el cierre del trimestre y el filing
      // (máx legal: 45). La foto es del cierre, no de hoy.
      lagDays: lagDays(currMeta.reportDate, currMeta.filingDate),
      prevQuarterEnd: prevMeta.reportDate,
      totalValue: Math.round(totalValue),
      counts: d.counts,
      top: {
        added: d.added.slice(0, TOP_N),
        closed: d.closed.slice(0, TOP_N),
        increased: d.increased.slice(0, TOP_N),
        reduced: d.reduced.slice(0, TOP_N),
      },
      link: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.cik}&type=13F-HR&dateb=&owner=include&count=10`,
    };
  }, 2, 1000); // 2 fondos por tanda: cada uno cuesta 5 requests

  const valid = funds.filter(Boolean);
  // Ticker solo para los CUSIP que salen en cards (≤20 por fondo).
  const shown = valid.flatMap((f) => Object.values(f.top).flat().map((p) => p.cusip));
  const tickers = await mapCusipsToTickers(shown);
  for (const f of valid) {
    for (const bucket of Object.values(f.top)) {
      for (const p of bucket) p.ticker = tickers.get(p.cusip) || null;
    }
  }

  return {
    cat: '13f',
    funds: valid,
    lag_note: 'SEC 13F: foto al cierre del trimestre, publicada hasta 45 días después — no es el portafolio de hoy',
    sources,
    stale: false,
    generated_at: new Date().toISOString(),
  };
}

// ═══ Smoke test (?smoke=1) — gate de fuentes contra Vercel real ═════

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

// ── Handler (patrón vc-feed: cache doble, stale-on-fail, nunca 500) ──
const BUILDERS = { insider: buildInsider, '13f': build13F };

function payloadLooksEmpty(payload) {
  const srcs = Object.values(payload.sources || {});
  return srcs.length > 0 && srcs.every((s) => !s.ok);
}

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
    return res.status(400).json({ error: 'cat must be insider | 13f (or pass smoke=1)' });
  }

  const entry = memCache[cat];
  if (entry.payload && Date.now() - entry.at < TTL_MS[cat]) {
    res.setHeader('Cache-Control', CDN_CACHE[cat]);
    return res.status(200).json(entry.payload);
  }

  try {
    const payload = await BUILDERS[cat]();
    if (payloadLooksEmpty(payload) && entry.payload) {
      // Fuentes caídas y hay stale: se sirve lo último bueno con los
      // flags frescos de qué falló. El fallo NO pisa el cache.
      res.setHeader('Cache-Control', CDN_CACHE[cat]);
      return res.status(200).json({ ...entry.payload, stale: true, sources: payload.sources });
    }
    memCache[cat] = { at: Date.now(), payload };
    res.setHeader('Cache-Control', CDN_CACHE[cat]);
    return res.status(200).json(payload);
  } catch (err) {
    if (entry.payload) {
      res.setHeader('Cache-Control', CDN_CACHE[cat]);
      return res.status(200).json({ ...entry.payload, stale: true, error: String((err && err.message) || err) });
    }
    return res.status(200).json({
      cat, items: [], funds: [], sources: {}, stale: false,
      error: 'Server exception: ' + String((err && err.message) || err),
      generated_at: new Date().toISOString(),
    });
  }
}
