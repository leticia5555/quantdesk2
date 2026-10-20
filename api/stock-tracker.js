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

// R5: la lectura COMPLETA del mismo Form 4. Vive aparte (`_lib/form4.js`)
// porque es otra lectura, no un filtro más flojo: la tarjeta de TRACKER se
// queda con las compras destacadas y la pantalla nueva ve todo. Se parsea en
// la MISMA pasada del escaneo para no pedirle a la SEC dos veces lo mismo.
import { form4Completo, filasDeForm4 } from './_lib/form4.js';
import { sql, sqlBatch, ensureSchema as ensureBase } from './_lib/db.js';
import { beat } from './_lib/heartbeat.js';
import { crearCliente } from './_lib/edgar.js';
import {
  urlIndiceDiario, diasHabiles, parseIndiceEdgar, form4DelIndice, coberturaDeDia,
  ownershipDeEnvio, urlDeArchivo, urlListadoTrimestre, diasPublicados,
} from './_lib/edgar-indice.js';

// ═══════════════════════════════════════════════════════════════════════
// LOS FORM 4 COMPLETOS, NO LA VENTANA
//
// Lety, 2026-10-22: *"Insiders completos, no solo la ventana de
// `getcurrent`."* Tiene razón y el motivo es aritmético: ese feed son los
// últimos ~200 filings de TODOS los formularios. En un día de temporada de
// reportes se presentan más de mil Form 4, así que la ventana cubre menos de
// una hora: lo que pasó antes de la última corrida del cron no existe para
// nosotros, y no hay forma de saber cuánto falta.
//
// El índice diario de EDGAR sí es la lista completa del día. Con él hay
// DENOMINADOR, que es lo que convierte "tenemos insiders" en "tenemos 1.842
// de 1.842". Sin denominador, "cobertura" es una palabra.
//
// DOS TRABAJOS SEPARADOS, y es a propósito:
//   · `job=indice` baja los índices (una petición por día hábil, ~30 en el
//     relleno inicial). Es barato y deja la lista de lo que DEBERÍA estar;
//   · `job=form4` baja y parsea los XML que falten, con presupuesto. Son
//     miles de documentos y no caben en una invocación: el cron los va
//     alcanzando, y mientras tanto la cobertura DICE cuántos faltan en vez
//     de fingir que están.
// ═══════════════════════════════════════════════════════════════════════
const SCHEMA_FORM4 = [
  // Lo que el índice dice que existe. El `primary key` es el accession, así
  // que correr el job dos veces sobre el mismo día no duplica nada.
  `create table if not exists mercado_form4_indice (
     accession     text primary key,
     cik           text not null,
     empresa       text,
     fecha_filing  date not null,
     archivo       text not null,
     leido_en      timestamptz,
     leido_ok      boolean,
     motivo        text,
     visto_en      timestamptz not null default now()
   )`,
  `create index if not exists mercado_form4_indice_fecha_idx
     on mercado_form4_indice (fecha_filing desc)`,
  // Los pendientes se piden por este índice en cada corrida del cron: sin él
  // la consulta escanea la tabla entera, que son decenas de miles de filas.
  `create index if not exists mercado_form4_indice_pend_idx
     on mercado_form4_indice (fecha_filing desc) where leido_en is null`,
  // El DENOMINADOR por día. Vive aparte del detalle porque es una medición
  // fechada: cuántas líneas de Form 4 traía el índice de ese día cuando lo
  // leímos. Si mañana EDGAR reescribe el índice, queremos ver el cambio.
  `create table if not exists mercado_form4_dias (
     fecha            date primary key,
     lineas_form4     int,
     enmiendas        int,
     indice_leido_en  timestamptz,
     motivo           text
   )`,
  // Las transacciones ya parseadas. En JSONB porque un Form 4 trae de una a
  // veinte filas y el detalle lo arma `filasDeForm4`, que ya existe.
  `create table if not exists mercado_form4_tx (
     accession     text primary key,
     filing_fecha  date not null,
     filas         jsonb not null,
     guardado_en   timestamptz not null default now()
   )`,
  `create index if not exists mercado_form4_tx_fecha_idx
     on mercado_form4_tx (filing_fecha desc)`,
];

let esquemaListo = false;
async function ensureSchemaForm4() {
  if (esquemaListo) return;
  await ensureBase();
  await sqlBatch(SCHEMA_FORM4.map((q) => [q, []]));
  esquemaListo = true;
}

// Un día hábil "cerrado" es uno cuyo índice ya no va a crecer. EDGAR acepta
// presentaciones hasta las 22:00 ET, así que el índice del día de HOY está
// vivo: medir cobertura contra él daría un porcentaje que baja solo.
const DIAS_RELLENO = 30;
const XML_POR_CORRIDA = 400;
const XML_PRESUPUESTO_MS = 40_000;

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
const TTL_MS = { insider: 30 * 60e3, form4: 30 * 60e3, '13f': 24 * 3600e3 };
const CDN_CACHE = {
  insider: 's-maxage=1800, stale-while-revalidate=3600',
  form4: 's-maxage=1800, stale-while-revalidate=3600',
  '13f': 's-maxage=86400, stale-while-revalidate=86400',
};
let memCache = { insider: { at: 0, payload: null }, form4: { at: 0, payload: null }, '13f': { at: 0, payload: null } };
// accession → item de compra destacada (sobrevive entre builds warm).
let insiderAccum = new Map();
// accession → TODAS las filas de ese filing (R5). Acumulador aparte para que
// la poda y el tope de uno no toquen al otro.
let form4Accum = new Map();
// El diagnóstico de la ÚLTIMA pasada del escaneo. `cat=form4` lo reporta sin
// volver a escanear: las dos lecturas salen de la misma pasada.
let ultimoEscaneo = null;
// CUSIP → ticker (los CUSIP de un fondo cambian poco; el mapa es estable).
let cusipTickerCache = new Map();

// Hooks de tests (nunca se usan en producción).
export function _resetTrackerCache() {
  memCache = { insider: { at: 0, payload: null }, form4: { at: 0, payload: null }, '13f': { at: 0, payload: null } };
  insiderAccum = new Map();
  form4Accum = new Map();
  ultimoEscaneo = null;
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

/**
 * EL RELLENO Y EL CRON DEL ÍNDICE.
 *
 * `dias` hábiles hacia atrás desde hoy. Una petición por día: el relleno
 * inicial son 30 y el cron diario es 1 (más 2 de margen, por si una corrida
 * falló y el índice de ayer todavía no se leyó).
 *
 * El ritmo y el User-Agent los pone `crearCliente`, que ya recorta al techo
 * de 10 peticiones por segundo de la SEC y valida que el `SEC_USER_AGENT`
 * tenga forma de contacto. Reimplementar eso acá habría sido una segunda
 * opinión sobre cómo se le habla a la SEC.
 */
async function jobIndice({ dias = 3, hoy = new Date() } = {}) {
  await ensureSchemaForm4();
  const cli = crearCliente({ kind: 'daily-index' });
  const fechas = diasHabiles(hoy.toISOString().slice(0, 10), dias);
  const resumen = [];

  // ── PRIMERO: QUÉ DÍAS EXISTEN ───────────────────────────────────────
  // Antes esto se inferÃ­a del código de respuesta de cada día, y la SEC
  // contesta 403 —no 404— cuando el archivo no está. O sea que un feriado y
  // un User-Agent rechazado y un proxy sin salida daban el mismo código, y el
  // job decidía "EDGAR no publicó" para los tres (Lety, contra producción).
  //
  // El listado del trimestre lo dice sin ambigüedad. Se pide UNA vez por
  // trimestre, no una por día.
  const listados = new Map();
  const fallosDeListado = new Map();
  for (const fecha of fechas) {
    const url = urlListadoTrimestre(fecha);
    if (!url || listados.has(url) || fallosDeListado.has(url)) continue;
    try {
      const { json } = await cli.json(url, { kind: 'daily-index-listado' });
      listados.set(url, diasPublicados(json, { tipo: 'form' }));
    } catch (e) {
      // Sin listado NO se adivina: el día queda en error y se dice por qué.
      // Inventar "no publicó" acá es justo el bug que se está arreglando.
      fallosDeListado.set(url, String((e && e.message) || e));
    }
  }

  for (const fecha of fechas) {
    const urlListado = urlListadoTrimestre(fecha);
    const publicados = listados.get(urlListado);
    const falloListado = fallosDeListado.get(urlListado);

    // ── EL DÍA NO EXISTE EN EDGAR: ESO NO ES UN ERROR ─────────────────
    if (publicados && !publicados.has(fecha)) {
      await sqlBatch([[
        `insert into mercado_form4_dias (fecha, lineas_form4, enmiendas, indice_leido_en, motivo)
         values ($1, null, null, now(), $2)
         on conflict (fecha) do update set indice_leido_en = now(), motivo = excluded.motivo`,
        [fecha, 'EDGAR no publicó índice ese día (no está en el listado del trimestre)'],
      ]]);
      resumen.push({ fecha, lineas: null, publicado: false, error: false,
        motivo: 'EDGAR no publicó índice ese día (no está en el listado del trimestre)' });
      continue;
    }

    const url = urlIndiceDiario(fecha);
    let texto = null; let motivo = null;
    if (falloListado) {
      motivo = `no se pudo leer el listado del trimestre, así que no se sabe si el día existe: ${falloListado}`;
    } else {
      try {
        ({ texto } = await cli.texto(url, { kind: 'daily-index' }));
      } catch (e) {
        // Ya NO se traduce un código a "feriado": el listado ya dijo que el
        // día existe, así que si la descarga falla es una falla.
        motivo = `el listado dice que ${fecha} existe pero la descarga falló: ${String((e && e.message) || e)}`;
      }
    }

    if (!texto) {
      await sqlBatch([[
        `insert into mercado_form4_dias (fecha, lineas_form4, enmiendas, indice_leido_en, motivo)
         values ($1, null, null, now(), $2)
         on conflict (fecha) do update set indice_leido_en = now(), motivo = excluded.motivo`,
        [fecha, motivo],
      ]]);
      resumen.push({ fecha, lineas: null, publicado: publicados ? true : null, error: true, motivo });
      continue;
    }

    const { filas, descartadas } = parseIndiceEdgar(texto);
    const f4 = form4DelIndice(filas);

    // ── CERO FORM 4 EN UN DÍA QUE EDGAR PUBLICÓ ES UN ERROR ───────────
    // Lety: *"un día hábil con 0 Form 4 no debe decir «no publicó»: debe
    // salir como error"*. Y tiene razón por una razón concreta: eso es
    // exactamente lo que pasó. El índice traía 991 Form 4, el parser no
    // entendía el formato de la fecha, las 991 se iban a `descartadas` —que
    // el job ni mirabaa— y el día se guardaba con 0 como si fuera un dato.
    //
    // `descartadas` existía justamente para esto y se estaba tirando. Una
    // alarma que nadie lee no es una alarma.
    if (f4.total === 0) {
      const porque = descartadas > 0
        ? `el índice de ${fecha} trae ${filas.length + descartadas} documentos y el parser no entendió ${descartadas}: cambió el formato`
        : `el índice de ${fecha} se leyó entero (${filas.length} documentos) y no trae ni un Form 4, lo que no pasa en un día hábil`;
      await sqlBatch([[
        `insert into mercado_form4_dias (fecha, lineas_form4, enmiendas, indice_leido_en, motivo)
         values ($1, null, null, now(), $2)
         on conflict (fecha) do update set lineas_form4 = null, indice_leido_en = now(), motivo = excluded.motivo`,
        [fecha, porque],
      ]]);
      resumen.push({ fecha, lineas: 0, documentos: filas.length, descartadas, publicado: true, error: true, motivo: porque });
      continue;
    }

    const lotes = [[
      `insert into mercado_form4_dias (fecha, lineas_form4, enmiendas, indice_leido_en, motivo)
       values ($1, $2, $3, now(), null)
       on conflict (fecha) do update set
         lineas_form4 = excluded.lineas_form4, enmiendas = excluded.enmiendas,
         indice_leido_en = now(), motivo = null`,
      [fecha, f4.total, f4.enmiendas],
    ]];
    // En bloques: una sentencia por filing serían 1.800 viajes a Neon.
    const TAM = 500;
    for (let i = 0; i < f4.filas.length; i += TAM) {
      const t = f4.filas.slice(i, i + TAM);
      lotes.push([
        `insert into mercado_form4_indice (accession, cik, empresa, fecha_filing, archivo)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::date[], $5::text[])
         on conflict (accession) do nothing`,
        [t.map((x) => x.accession), t.map((x) => x.cik), t.map((x) => x.empresa || null),
         t.map((x) => x.fecha || fecha), t.map((x) => x.archivo)],
      ]);
    }
    await sqlBatch(lotes);
    resumen.push({ fecha, lineas: f4.total, enmiendas: f4.enmiendas, descartadas, publicado: true, error: false, motivo: null });
  }

  // EL LATIDO: un día que EDGAR no publicó es una corrida correcta y no baja
  // el semáforo. Lo que sí lo baja es un día que SÍ existe y no se pudo leer,
  // o que se leyó y dio cero: eso es la fuente rota o el formato cambiado, y
  // es lo que estuvo en silencio cinco días.
  const conError = resumen.filter((r) => r.error).length;
  const leidos = resumen.filter((r) => r.lineas).length;
  await beat('mercado:form4-indice', conError ? 'error' : 'ok', {
    dias: fechas.length, con_indice: leidos, con_error: conError,
    descartadas: resumen.reduce((a, r) => a + (r.descartadas || 0), 0),
    form4: resumen.reduce((a, r) => a + (r.lineas || 0), 0),
  }).catch(() => {});
  return { job: 'indice', dias: fechas.length, con_error: conError, fechas: resumen,
    ua: cli.ua, req_por_segundo: cli.reqPorSegundo };
}

/**
 * LOS XML QUE FALTAN, con presupuesto.
 *
 * Se piden los más NUEVOS primero: una pantalla que enseña "las últimas
 * transacciones" se llena de arriba hacia abajo, así que lo primero que se
 * baja es lo primero que se ve. El relleno de los días viejos va quedando
 * atrás, y la cobertura dice exactamente cuánto falta de cada día.
 */
async function jobForm4Xml({ tope = XML_POR_CORRIDA, t0 = Date.now() } = {}) {
  await ensureSchemaForm4();
  const pendientes = await sql(`
    select accession, cik, archivo, fecha_filing::text as fecha
      from mercado_form4_indice
     where leido_en is null
     order by fecha_filing desc, accession desc
     limit $1`, [tope]);
  if (!pendientes.length) {
    // Cero pendientes es el estado BUENO: quiere decir que la cobertura está
    // al día. Late igual, porque un cron que sólo late cuando hay trabajo no
    // se distingue de un cron muerto.
    await beat('mercado:form4-xml', 'ok', { pendientes: 0, leidos: 0 }).catch(() => {});
    return { job: 'form4', pendientes: 0, leidos: 0, ok: 0, fallidos: 0, ms: Date.now() - t0 };
  }

  const cli = crearCliente({ kind: 'form4-xml' });
  const resultados = [];
  for (const p of pendientes) {
    if (Date.now() - t0 > XML_PRESUPUESTO_MS) break;
    // El documento principal del filing. El `.txt` del índice es el envío
    // COMPLETO —con todos sus adjuntos y sus cabeceras— y puede pesar
    // megabytes; el XML del Form 4 vive al lado y pesa unos kilobytes.
    const dir = `https://www.sec.gov/Archives/edgar/data/${p.cik}/${String(p.accession).replace(/-/g, '')}`;
    try {
      // UNA PETICIÓN, no dos. El `.txt` del índice es el envío completo y
      // trae el XML dentro; pedir antes `index.json` para averiguar cómo se
      // llama el XML costaba el doble, y en el relleno de 30 días el doble
      // son 45.000 peticiones de más a la SEC.
      let xml = null;
      const { texto: envio } = await cli.texto(urlDeArchivo(p.archivo), { kind: 'form4-envio' });
      xml = ownershipDeEnvio(envio);
      if (!xml) {
        // Un `4` del índice sin `ownershipDocument` en el envío es raro y es
        // real. Antes de darlo por perdido, el camino largo.
        const { json } = await cli.json(dir + '/index.json', { kind: 'form4-index' });
        const files = (json && json.directory && json.directory.item) || [];
        const xmlFile = files.find((f) => /\.xml$/i.test(f.name) && !/^primary_doc\.xml$/i.test(f.name))
          || files.find((f) => /\.xml$/i.test(f.name));
        if (!xmlFile) { resultados.push({ ...p, ok: false, motivo: 'el envío no trae un Form 4 legible' }); continue; }
        ({ texto: xml } = await cli.texto(dir + '/' + xmlFile.name, { kind: 'form4-xml' }));
      }
      const filas = filasDeForm4(form4Completo(xml), { accession: p.accession, cik: p.cik, fecha: p.fecha });
      resultados.push({ ...p, ok: true, filas, motivo: null });
    } catch (e) {
      resultados.push({ ...p, ok: false, motivo: String((e && e.message) || e) });
    }
  }

  const lotes = [];
  for (const r of resultados) {
    lotes.push([
      `update mercado_form4_indice set leido_en = now(), leido_ok = $2, motivo = $3 where accession = $1`,
      [r.accession, !!r.ok, r.motivo],
    ]);
    if (r.ok && (r.filas || []).length) {
      lotes.push([
        `insert into mercado_form4_tx (accession, filing_fecha, filas)
         values ($1, $2, $3::jsonb)
         on conflict (accession) do update set filas = excluded.filas, guardado_en = now()`,
        [r.accession, r.fecha, JSON.stringify(r.filas)],
      ]);
    }
  }
  if (lotes.length) await sqlBatch(lotes);

  const buenos = resultados.filter((r) => r.ok).length;
  // Que algunos filings fallen es normal (un envío sin Form 4 legible). Que
  // fallen TODOS es la SEC caída o un formato que cambió.
  await beat('mercado:form4-xml', buenos ? 'ok' : 'error', {
    pendientes: pendientes.length, leidos: resultados.length, ok: buenos,
  }).catch(() => {});
  return {
    job: 'form4',
    pendientes: pendientes.length,
    leidos: resultados.length,
    ok: resultados.filter((r) => r.ok).length,
    fallidos: resultados.filter((r) => !r.ok).length,
    sin_terminar: pendientes.length - resultados.length,
    ua: cli.ua,
    ms: Date.now() - t0,
  };
}

/** La cobertura de los últimos días hábiles cerrados, con sus dos números. */
async function coberturaForm4({ dias = 10, hoy = new Date() } = {}) {
  await ensureSchemaForm4();
  const filas = await sql(`
    select d.fecha::text as fecha, d.lineas_form4, d.motivo,
           (select count(*) from mercado_form4_indice i
             where i.fecha_filing = d.fecha and i.leido_en is not null and i.leido_ok) as guardados
      from mercado_form4_dias d
     order by d.fecha desc
     limit $1`, [dias]);
  // El día de HOY no se mide: EDGAR acepta presentaciones hasta las 22:00 ET,
  // así que su índice todavía crece y el porcentaje bajaría solo.
  const hoyIso = hoy.toISOString().slice(0, 10);
  const cerrados = filas.filter((f) => f.fecha < hoyIso);
  const dias_ = cerrados.map((f) => coberturaDeDia({
    fecha: f.fecha, enIndice: f.lineas_form4, guardados: Number(f.guardados), motivo: f.motivo,
  }));
  const medibles = dias_.filter((d) => d.en_indice > 0);
  return {
    dias: dias_,
    // El último día cerrado con índice es el que va al chip de la pantalla.
    ultimo: medibles[0] || null,
    completa: medibles.length > 0 && medibles.every((d) => d.completa),
    medidos: medibles.length,
  };
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
    // ── UNA PASADA, DOS LECTURAS (R5) ────────────────────────────────
    // El XML ya está acá; parsearlo de nuevo en otro endpoint sería pedirle
    // a la SEC el mismo documento dos veces. La lectura de TRACKER
    // (`extractNotableBuy`) NO cambia ni una línea.
    const completo = filasDeForm4(form4Completo(xml.text), e);
    if (completo.length) form4Accum.set(e.accession, completo);
    return extractNotableBuy(parseForm4Xml(xml.text), e, NOTABLE_MIN_USD, skipStats);
  });

  // Merge al acumulador de instancia + poda por edad.
  for (const it of found) if (it) insiderAccum.set(it.accession, it);
  const cutoff = new Date(Date.now() - ACCUM_MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [acc, it] of insiderAccum) {
    if ((it.filedDate || '') < cutoff) insiderAccum.delete(acc);
  }
  for (const [acc, fs] of form4Accum) {
    if (((fs[0] && fs[0].filing_fecha) || '') < cutoff) form4Accum.delete(acc);
  }

  // Orden por tamaño comparable: USD real o la aproximación (nunca el
  // monto nominal en moneda local, que mezclaría pesos con dólares).
  const usd = (it) => (it.currency ? it.valueUsdApprox : it.value) || 0;
  const items = markClusters([...insiderAccum.values()])
    .sort((a, b) => (b.filedDate || '').localeCompare(a.filedDate || '') || usd(b) - usd(a))
    .slice(0, 60);

  // El diagnóstico del escaneo se guarda para que `cat=form4` pueda decir lo
  // mismo sin volver a escanear: las dos lecturas salen de la MISMA pasada.
  ultimoEscaneo = {
    sources,
    scan: { atom_entries: entries.length, inspected: toScan.length, xml_fetched: fetched, accumulated: form4Accum.size },
    at: Date.now(),
  };

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

// ═══ R5 — TODAS LAS TRANSACCIONES DEL FORM 4 ════════════════════════
//
// Comparte el escaneo con `cat=insider`: si éste corre primero y el
// acumulador ya tiene filas, no se vuelve a pedir nada. Si está vacío, se
// dispara el mismo `buildInsider` —que es el que escanea— y después se lee
// el acumulador. Nunca hay dos escaneos de la SEC en vuelo por lo mismo.
async function buildForm4() {
  // ── DE NEON PRIMERO, DE LA MEMORIA DESPUÉS ─────────────────────────
  // Lo que guardó el cron del índice vive en la base y sobrevive a que
  // Vercel recicle la instancia. El acumulador en memoria se queda como
  // complemento: trae lo que se escaneó hace un minuto y todavía no pasó por
  // el job. Se mezclan por accession, así que una transacción no sale dos
  // veces aunque esté en los dos lados.
  let deNeon = [];
  let cobertura = null;
  let errorNeon = null;
  try {
    deNeon = await sql(`
      select accession, filas
        from mercado_form4_tx
       order by filing_fecha desc, accession desc
       limit 600`, []);
    cobertura = await coberturaForm4({});
  } catch (e) {
    // La base caída no deja a la pantalla sin insiders: queda lo de memoria,
    // y la causa viaja para que el hueco se pueda explicar.
    errorNeon = String((e && e.message) || e);
  }

  if (!deNeon.length && !form4Accum.size) await buildInsider();

  const porAccession = new Map();
  for (const r of deNeon) {
    const fs = Array.isArray(r.filas) ? r.filas : [];
    if (fs.length) porAccession.set(r.accession, fs);
  }
  for (const [acc, fs] of form4Accum) if (!porAccession.has(acc)) porAccession.set(acc, fs);

  const filas = [...porAccession.values()].flat()
    // Por HORA de aceptación del filing, no por fecha de la operación: es lo
    // que pide el encargo ("orden por hora de filing ↓") y es lo que hace que
    // "lo último" signifique algo.
    .sort((a, b) => String(b.filing_en || '').localeCompare(String(a.filing_en || '')))
    .slice(0, 400);
  const diag = ultimoEscaneo || {};

  // ── LO QUE SE DICE EN PANTALLA ──────────────────────────────────────
  // Con el índice completo, la frase del arranque en frío SOBRA: ya no es
  // cierta. Decir "puede faltar lo de antes de la última corrida" cuando
  // tenemos el día entero medido es pedir disculpas por un problema que ya no
  // existe, y entrena a no creerle a los avisos.
  const completa = !!(cobertura && cobertura.completa && cobertura.medidos > 0);
  return {
    cat: 'form4',
    items: filas,
    // El TOP y las destacadas los arma la pantalla desde estas mismas filas
    // (`api/_lib/form4.js`): una sola fuente de verdad por pantalla.
    scan: diag.scan || null,
    sources: diag.sources || {},
    cobertura_dias: cobertura ? cobertura.dias : [],
    cobertura_ultimo: cobertura ? cobertura.ultimo : null,
    cobertura_completa: completa,
    cobertura: completa
      ? (cobertura.ultimo ? cobertura.ultimo.texto : 'Cobertura: completa')
      : (errorNeon
        ? `no se pudo leer nuestra base de datos: lo que se ve es lo que esta instancia alcanzó a escanear (${errorNeon})`
        : (cobertura && cobertura.ultimo
          ? cobertura.ultimo.texto
          : 'todavía no se ha leído el índice diario de EDGAR: lo que se ve es la ventana de lo recién presentado')),
    lag_note: 'SEC Form 4: reportado máx. 2 días hábiles después de la operación',
    de_neon: deNeon.length,
    de_memoria: form4Accum.size,
    stale: false,
    generated_at: new Date().toISOString(),
  };
}

// ── Handler (patrón vc-feed: cache doble, stale-on-fail, nunca 500) ──
const BUILDERS = { insider: buildInsider, form4: buildForm4, '13f': build13F };

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

  // ── LOS JOBS ────────────────────────────────────────────────────────
  // Un JOB que falla contesta 5xx. Un 200 con un `error` adentro es una
  // promesa falsa: el cron lo marca como bueno y nadie se entera.
  if (q.job) {
    res.setHeader('Cache-Control', 'no-store');
    const t0 = Date.now();
    const job = String(q.job).toLowerCase();
    try {
      if (job === 'indice') {
        const dias = Math.min(Math.max(Number(q.dias) || 3, 1), 90);
        return res.status(200).json(await jobIndice({ dias }));
      }
      if (job === 'form4') {
        const tope = Math.min(Math.max(Number(q.tope) || XML_POR_CORRIDA, 1), 1000);
        return res.status(200).json(await jobForm4Xml({ tope, t0 }));
      }
      if (job === 'cobertura') {
        return res.status(200).json(await coberturaForm4({ dias: Math.min(Number(q.dias) || 10, 60) }));
      }
      return res.status(400).json({ error: 'job must be indice | form4 | cobertura' });
    } catch (e) {
      return res.status(500).json({ job, error: String((e && e.message) || e), ms: Date.now() - t0 });
    }
  }

  if (q.smoke) {
    // Resultados en vivo siempre — el smoke pierde sentido cacheado.
    res.setHeader('Cache-Control', 'no-store');
    const out = await runSmoke();
    return res.status(200).json(out);
  }

  const cat = String(q.cat || '').toLowerCase();
  if (!BUILDERS[cat]) {
    return res.status(400).json({ error: 'cat must be insider | form4 | 13f (or pass smoke=1)' });
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
