// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-kpi.js — lectura de los mercados de RANGOS de KPI de
// Polymarket (comps, márgenes, crecimiento de un segmento, combined ratio…).
//
// Cosecha PARALELA a la de beat/miss (pm_earnings_markets). No la toca: el
// filtro v1 y los criterios congelados de Fase 2 viven en _lib/earnings-beat.js
// y de ahí solo se IMPORTAN utilidades puras (normalizaMercado, tokenYes,
// outcomeResuelto, normalizaTexto). Nada de acá se escribe allá.
//
// La forma de estos mercados: UN evento ("Mastercard cross-border volume
// growth Q3?") con 4–7 mercados hijos, uno por cajón ("<22%", "22% to 24%",
// "28%+"). La unidad de la tabla es el CAJÓN, no el evento.
//
// TODO ACÁ ES PURO: sin fetch, sin DB, sin Date.now() escondido (el "ahora"
// entra por parámetro). Se testea con fixtures: tests/earnings-kpi.test.mjs.
// ═══════════════════════════════════════════════════════════════════

import {
  normalizaMercado, tokenYes, outcomeResuelto, normalizaTexto, construyeIndiceNombres, ALIAS_EMPRESAS,
} from './earnings-beat.js';

// ─────────────────── semillas de búsqueda ───────────────────
// Frases REALES de títulos vistos en Polymarket. Los tags no existen para
// esto (comprobado), así que el descubrimiento es por texto. Cada semilla se
// reporta por separado: una semilla que devuelve 0 se DICE, no se esconde en
// el total.
const SEMILLAS_KPI = [
  'comparable sales',
  'same store sales',
  'organic sales growth',
  'revenue growth',
  'volume growth',
  'operating margin',
  'gross margin',
  'combined ratio',
  'medical benefit ratio',
  'cross-border',
  'eCommerce sales growth',
  'Azure',
  'RPO growth',
  'net adds',
  'deliveries',
];

// Un evento KPI tiene varios cajones. Con menos de 2 rangos legibles no es un
// mercado de rangos: es otra cosa que la búsqueda por texto arrastró ("Will
// Azure go down…"). Se cuenta como excluido, con su motivo.
const MIN_RANGOS_POR_EVENTO = 2;

// ─────────────────── exclusiones ───────────────────
// Dos familias que la búsqueda por texto trae y que NO son rangos de KPI:
//   · beat/miss de EPS — ya tiene su cosecha (pm_earnings_markets);
//   · mercados de MENCIÓN ("Will X say 'tariff' during the call?").
const EXCLUSIONES = [
  { motivo: 'beat_quarterly_earnings', re: /beat\s+(its\s+)?quarterly\s+(earnings|eps)/i },
  { motivo: 'mencion', re: /\bwill\b.*\bsays?\b|\bsay\b|\bsaid\b|\bmentions?\b|\bmentioned\b/i },
];

function excluyeTitulo(titulo) {
  const t = String(titulo || '');
  for (const e of EXCLUSIONES) if (e.re.test(t)) return e.motivo;
  return null;
}

// ─────────────────── parseo de rangos ───────────────────

// Un número como lo escribe Polymarket: "-2%", "11.5%", "$1.2B", "400k",
// "1,250", "95.5". Devuelve valor + unidad. Los multiplicadores (k/M/B) se
// expanden a número absoluto: "900k to 1.1M" tiene que compararse en la misma
// escala. El porcentaje NO se divide entre 100: "22%" se guarda como 22, igual
// que lo escribe el título, con unidad '%'.
const NUM = String.raw`[-+]?\$?\d[\d,]*(?:\.\d+)?\s*(?:%|bps|pp|k|K|m|M|mm|MM|b|B|bn|thousand|million|billion)?`;
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

function leeNumero(s) {
  const m = /^([-+]?)(\$?)(\d[\d,]*(?:\.\d+)?)\s*(%|bps|pp|k|m|mm|b|bn|thousand|million|billion)?$/i.exec(String(s).trim());
  if (!m) return null;
  let v = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  if (m[1] === '-') v = -v;
  const suf = m[4] ? m[4].toLowerCase() : null;
  let unidad = m[2] ? '$' : null;
  if (suf === '%') unidad = '%';
  else if (suf === 'bps' || suf === 'pp') unidad = suf;
  else if (suf && MULT[suf]) v = v * MULT[suf];
  return { valor: Number(v.toPrecision(12)), unidad };
}

// Unidad del rango: si cualquiera de los dos extremos la trae, vale para el
// rango ("22 to 24%" → '%').
function unidadDe(...ns) {
  for (const n of ns) if (n && n.unidad) return n.unidad;
  return null;
}

function limpiaEtiqueta(texto) {
  return String(texto || '')
    .replace(/[–—−]/g, '-')
    .replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/\?+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Texto de un cajón → { low, high, unidad }. Extremos abiertos en null:
// "<22%" → low null; "28%+" → high null. Devuelve null si no es un rango: el
// llamador lo cuenta como "rango ilegible" en vez de inventar uno.
//
// Casos cubiertos (ver tests): "<22%", "22% to 24%", "28%+", "between 3% and
// 4%", "above 4%", "below 1%", "11.5% to 12.5%", "<3.5%", "6.5%+", y sus
// variantes "≥", "or more", "less than", "22-24%", negativos ("-2% to 0%").
function parseaRango(texto) {
  const t = limpiaEtiqueta(texto);
  if (!t) return null;
  let m;

  // A to B · between A and B · A - B · from A to B
  m = new RegExp(String.raw`^(?:between\s+|from\s+)?(${NUM})\s*(?:to|and|-|through|thru)\s*(${NUM})$`, 'i').exec(t);
  if (m) {
    const a = leeNumero(m[1]);
    const b = leeNumero(m[2]);
    if (a && b) {
      const u = unidadDe(a, b);
      const low = Math.min(a.valor, b.valor);
      const high = Math.max(a.valor, b.valor);
      return { low, high, unidad: u, forma: 'entre' };
    }
  }

  // Abierto por abajo: "<22%", "below 1%", "under", "less than", "A or less"
  m = new RegExp(String.raw`^(?:<=?|below|under|less\s+than|lower\s+than|at\s+most|up\s+to)\s*(${NUM})$`, 'i').exec(t)
    || new RegExp(String.raw`^(${NUM})\s*(?:or\s+(?:less|lower|below|fewer)|and\s+(?:below|under))$`, 'i').exec(t);
  if (m) {
    const a = leeNumero(m[1]);
    if (a) return { low: null, high: a.valor, unidad: a.unidad, forma: 'abajo' };
  }

  // Abierto por arriba: "28%+", "above 4%", ">", "over", "more than", "at least", "A or more"
  m = new RegExp(String.raw`^(?:>=?|above|over|more\s+than|greater\s+than|higher\s+than|at\s+least)\s*(${NUM})$`, 'i').exec(t)
    || new RegExp(String.raw`^(${NUM})\s*(?:\+|or\s+(?:more|higher|above|greater)|and\s+(?:above|up|over))$`, 'i').exec(t);
  if (m) {
    const a = leeNumero(m[1]);
    if (a) return { low: a.valor, high: null, unidad: a.unidad, forma: 'arriba' };
  }

  // Valor puntual ("Exactly 5%"): low = high.
  m = new RegExp(String.raw`^(?:exactly\s+)?(${NUM})$`, 'i').exec(t);
  if (m) {
    const a = leeNumero(m[1]);
    if (a) return { low: a.valor, high: a.valor, unidad: a.unidad, forma: 'puntual' };
  }
  return null;
}

// El cajón de un mercado hijo. Primero `groupItemTitle` (es literalmente la
// etiqueta del cajón en la UI de Polymarket); si no viene, la cola de la
// pregunta tras el último ':' o la cláusula "be <rango>". Se devuelve también
// DE DÓNDE salió, para auditar.
function rangoDeMercado(raw) {
  const candidatos = [];
  if (raw && raw.groupItemTitle) candidatos.push({ via: 'groupItemTitle', texto: raw.groupItemTitle });
  const q = String((raw && (raw.question || raw.title)) || '');
  const colon = q.lastIndexOf(':');
  if (colon >= 0) candidatos.push({ via: 'pregunta:cola', texto: q.slice(colon + 1) });
  const be = /\b(?:be|is|come in at|report|reports)\s+(.+?)\??$/i.exec(q);
  if (be) {
    // "…be between 3% and 4% in Q3 2026?" → recorta el "in Q3 …" del final.
    candidatos.push({ via: 'pregunta:be', texto: be[1].replace(/\s+(?:in|for|during|on)\s+(?:q[1-4]|fy|the|\d{4}).*$/i, '') });
  }
  for (const c of candidatos) {
    const r = parseaRango(c.texto);
    if (r) return { ...r, etiqueta: limpiaEtiqueta(c.texto), via: c.via };
  }
  return null;
}

// ─────────────────── símbolo y nombre del KPI ───────────────────

// Nombres comerciales que aparecen en mercados de KPI y no en los de beat/miss.
// Las claves van SIN apóstrofo ("dicks", "mcdonalds"): el título se normaliza
// quitándolos antes de buscar, así "DICK'S" y "Dick’s" caen en la misma clave.
const ALIAS_KPI = {
  'dicks': 'DKS', 'dicks sporting goods': 'DKS', 'mcdonalds': 'MCD', 'lowes': 'LOW',
  'kohls': 'KSS', 'macys': 'M', 'dominos': 'DPZ', 'wendys': 'WEN', 'chilis': 'EAT',
  'progressive': 'PGR', 'allstate': 'ALL', 'travelers': 'TRV', 'chubb': 'CB',
  'centene': 'CNC', 'humana': 'HUM', 'elevance': 'ELV', 'molina': 'MOH', 'cigna': 'CI',
  'lululemon': 'LULU', 'ulta': 'ULTA', 'best buy': 'BBY', 'dollar general': 'DG', 'dollar tree': 'DLTR',
  'kroger': 'KR', 'abercrombie': 'ANF', 'five below': 'FIVE', 'darden': 'DRI', 'cava': 'CAVA',
  'sweetgreen': 'SG', 'wingstop': 'WING', 'dutch bros': 'BROS', 'yum': 'YUM', 'yum brands': 'YUM',
  'restaurant brands': 'QSR', 'burlington': 'BURL', 'ross': 'ROST', 'ross stores': 'ROST',
  'gap': 'GAP', 'american eagle': 'AEO', 'williams-sonoma': 'WSM', 'williams sonoma': 'WSM',
  'rh': 'RH', 'wayfair': 'W', 'etsy': 'ETSY', 'ebay': 'EBAY', 'carvana': 'CVNA', 'netflix': 'NFLX',
  'charter': 'CHTR', 'roku': 'ROKU', 'pinterest': 'PINS', 'snap': 'SNAP', 'reddit': 'RDDT',
  'sirius': 'SIRI', 'siriusxm': 'SIRI', 'nio': 'NIO', 'xpeng': 'XPEV', 'li auto': 'LI', 'byd': 'BYD',
  'ferrari': 'RACE', 'oracle': 'ORCL', 'pdd': 'PDD', 'alibaba': 'BABA', 'jd': 'JD', 'sea': 'SE',
  'mercadolibre': 'MELI', 'nu': 'NU', 'nubank': 'NU', 'sofi': 'SOFI', 'affirm': 'AFRM',
  'crowdstrike': 'CRWD', 'datadog': 'DDOG', 'mongodb': 'MDB', 'cloudflare': 'NET', 'zscaler': 'ZS',
};

// Paréntesis que NO son tickers aunque lo parezcan.
const NO_TICKER = new Set(['GAAP', 'EPS', 'YOY', 'QOQ', 'FY', 'US', 'USA', 'USD', 'ADJ', 'TTM', 'LTM', 'EU', 'UK', 'AI', 'ARR', 'RPO', 'MBR', 'NIM']);

let INDICE_KPI = null;
function indiceKpi() {
  if (!INDICE_KPI) INDICE_KPI = construyeIndiceNombres({ alias: { ...ALIAS_EMPRESAS, ...ALIAS_KPI } });
  return INDICE_KPI;
}

// Título del evento → { symbol, via }. Primero el ticker explícito entre
// paréntesis "(MA)"; después el nombre comercial, gana el más largo.
function extraeSimboloKpi(titulo, indice = indiceKpi()) {
  const t = String(titulo || '');
  for (const m of t.matchAll(/\(\s*\$?([A-Z][A-Z.]{0,5})\s*\)/g)) {
    const tok = m[1].replace(/\.$/, '');
    if (!NO_TICKER.has(tok)) return { symbol: tok, via: 'ticker' };
  }
  const dolar = /\$([A-Z]{1,5})\b/.exec(t);
  if (dolar) return { symbol: dolar[1], via: 'ticker' };
  const texto = ' ' + normalizaTexto(t.replace(/['’‘`]/g, '').replace(/-/g, ' ')) + ' ';
  for (const e of indice || []) {
    const clave = e.clave.replace(/-/g, ' ');
    if (texto.includes(' ' + clave + ' ')) return { symbol: e.symbol, via: 'alias' };
  }
  return { symbol: null, via: null };
}

// Nombre del KPI: el título del evento sin el rango, sin el "?" final y sin
// espacios de sobra. Si el título trae un ":" seguido de un rango, se corta ahí.
function kpiDeTitulo(titulo) {
  let t = limpiaEtiqueta(titulo);
  const colon = t.lastIndexOf(':');
  if (colon >= 0 && parseaRango(t.slice(colon + 1))) t = t.slice(0, colon);
  t = t.replace(new RegExp(String.raw`\s+(?:be\s+)?(?:between\s+)?${NUM}\s*(?:to|and|-)\s*${NUM}\s*$`, 'i'), '');
  return t.replace(/^will\s+/i, '').replace(/\s+/g, ' ').trim() || null;
}

// ─────────────────── evento → filas ───────────────────

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Precio del Yes "de hoy" según Gamma: outcomePrices en el índice del Yes.
// Fuera de [0,1] o ausente → null (no se inventa).
function precioYesActual(mNorm) {
  const i = (mNorm.outcomes || []).findIndex((o) => typeof o === 'string' && /^\s*yes\s*$/i.test(o));
  if (i < 0) return null;
  const p = mNorm.precios_outcome ? mNorm.precios_outcome[i] : null;
  return p !== null && p !== undefined && p >= 0 && p <= 1 ? p : null;
}

// Un evento de Gamma → { motivo, filas, ilegibles }. `motivo` es 'ok' o el
// porqué se excluyó. Una fila por CAJÓN (mercado hijo con rango legible).
function filasDeEvento(evento, { semilla = null } = {}) {
  const titulo = (evento && (evento.title || evento.question)) || '';
  const slug = (evento && evento.slug) || null;
  if (!slug) return { motivo: 'sin_slug', filas: [], ilegibles: 0 };
  const excl = excluyeTitulo(titulo);
  if (excl) return { motivo: excl, filas: [], ilegibles: 0 };

  const sim = extraeSimboloKpi(titulo);
  const kpi = kpiDeTitulo(titulo);
  const mercados = Array.isArray(evento.markets) ? evento.markets : [];
  const filas = [];
  let ilegibles = 0;
  for (const raw of mercados) {
    // Un hijo de MENCIÓN dentro de un evento de rangos no existe en la práctica,
    // pero si aparece no se cuela por heredar el título del padre.
    if (excluyeTitulo(raw && raw.question)) { ilegibles++; continue; }
    const rango = rangoDeMercado(raw);
    const m = normalizaMercado(raw);
    const marketId = raw && (raw.conditionId || raw.condition_id) ? String(raw.conditionId || raw.condition_id) : null;
    if (!rango || !m || !marketId) { ilegibles++; continue; }
    const res = m.cerrado ? outcomeResuelto(m) : null;
    filas.push({
      market_id: marketId,
      gamma_market_id: m.id,
      event_slug: slug,
      event_title: titulo || null,
      question: m.pregunta,
      range_label: rango.etiqueta,
      range_low: rango.low,
      range_high: rango.high,
      range_unit: rango.unidad,
      symbol: sim.symbol,
      symbol_via: sim.via,
      kpi_name: kpi,
      end_date: m.fin_declarado || evento.endDate || null,
      created_at_pm: m.creado || evento.createdAt || null,
      yes_token_id: tokenYes(m),
      price_yes_latest: precioYesActual(m),
      volume: m.volumen,
      liquidity: m.liquidez,
      // RESUELTO solo si el mercado cerró Y el precio quedó pegado a 0/1. Un
      // cerrado sin ganador limpio (disputa UMA) sigue sin resolver.
      resolved: !!(res && res.es_yes !== null),
      winning_range: res && res.es_yes !== null ? res.es_yes : null,
      semilla,
      _raw: raw,
    });
  }
  if (filas.length < MIN_RANGOS_POR_EVENTO) return { motivo: 'sin_rangos', filas: [], ilegibles };
  return { motivo: 'ok', filas, ilegibles };
}

// ─────────────────── reporte de la corrida ───────────────────

// Conteos del candado, sobre filas ya filtradas. `ahoraMs` entra por
// parámetro: nada de Date.now() escondido.
function conteos(filas, ahoraMs) {
  const eventos = new Set(filas.map((f) => f.event_slug));
  const futuras = filas.filter((f) => { const t = Date.parse(f.end_date || ''); return Number.isFinite(t) && t > ahoraMs; });
  const eventosFuturos = new Set(futuras.map((f) => f.event_slug));
  return {
    eventos: eventos.size,
    rangos: filas.length,
    con_precio_valido: filas.filter((f) => f.price_yes_latest !== null && f.price_yes_latest !== undefined).length,
    con_precio_vivo: filas.filter((f) => f.price_yes_latest > 0 && f.price_yes_latest < 1).length,
    con_end_date_futura: futuras.length,
    eventos_con_end_date_futura: eventosFuturos.size,
    resueltos: filas.filter((f) => f.resolved).length,
    sin_symbol: filas.filter((f) => !f.symbol).length,
    sin_token_yes: filas.filter((f) => !f.yes_token_id).length,
  };
}

// Las monedas del candado: si la frontera devolvió CERO, eso es una falla de
// la frontera, nunca "no hay mercados". Se decide acá, en un solo sitio.
function veredictoFrontera({ intentos = [], eventosCrudos = 0, corte422 = null }) {
  if (corte422) return { estado: 'falla_de_frontera', motivo: `Gamma devolvió 422 (paginación) en «${corte422.semilla}» página ${corte422.pagina} — se paró sin reintentar` };
  const ok = intentos.filter((i) => i.status === 'ok').length;
  if (!intentos.length) return { estado: 'falla_de_frontera', motivo: 'no se hizo ningún request' };
  if (!ok) return { estado: 'falla_de_frontera', motivo: `ningún request a Gamma contestó ok (${intentos.length} intentos)` };
  if (!eventosCrudos) return { estado: 'falla_de_frontera', motivo: 'Gamma contestó pero devolvió 0 eventos en todas las semillas' };
  return { estado: 'ok', motivo: null };
}

function fmtPrecio(p) {
  return p === null || p === undefined ? '—' : Number(p).toFixed(3);
}

function fmtRango(f) {
  const u = f.range_unit === '%' ? '%' : f.range_unit === '$' ? '' : (f.range_unit ? ' ' + f.range_unit : '');
  const pre = f.range_unit === '$' ? '$' : '';
  const v = (x) => pre + Number(x).toLocaleString('en-US', { maximumFractionDigits: 4 }) + u;
  if (f.range_low === null && f.range_high === null) return f.range_label || '—';
  if (f.range_low === null) return '< ' + v(f.range_high);
  if (f.range_high === null) return v(f.range_low) + '+';
  if (f.range_low === f.range_high) return v(f.range_low);
  return v(f.range_low) + ' – ' + v(f.range_high);
}

// Orden de los cajones dentro de un evento: de abajo hacia arriba.
function ordenCajon(a, b) {
  const la = a.range_low === null || a.range_low === undefined ? -Infinity : Number(a.range_low);
  const lb = b.range_low === null || b.range_low === undefined ? -Infinity : Number(b.range_low);
  return la - lb;
}

// Filas de pm_kpi_markets → markdown, eventos ordenados por end_date.
function markdownEventos(filas, { titulo = 'Mercados KPI abiertos (Polymarket)', generado = null } = {}) {
  const porEvento = new Map();
  for (const f of filas || []) {
    if (!porEvento.has(f.event_slug)) porEvento.set(f.event_slug, []);
    porEvento.get(f.event_slug).push(f);
  }
  const eventos = [...porEvento.values()].sort((a, b) => {
    const ta = Date.parse(a[0].end_date || '') || Infinity;
    const tb = Date.parse(b[0].end_date || '') || Infinity;
    return ta - tb || String(a[0].event_slug).localeCompare(String(b[0].event_slug));
  });
  const out = [`# ${titulo}`, ''];
  if (generado) out.push(`_Generado ${generado} · ${eventos.length} eventos · ${(filas || []).length} rangos_`, '');
  if (!eventos.length) { out.push('Sin eventos abiertos en la tabla.'); return out.join('\n') + '\n'; }
  for (const filasEv of eventos) {
    const e = filasEv[0];
    const fin = e.end_date ? String(e.end_date).slice(0, 16).replace('T', ' ') : '¿?';
    out.push(`## ${e.event_title || e.event_slug}`);
    out.push(`\`${e.symbol || '¿símbolo?'}\` · cierra ${fin} UTC · [${e.event_slug}](https://polymarket.com/event/${e.event_slug})`, '');
    out.push('| rango | Yes hoy | Yes 1ª vez | Yes T-24h | volumen | liquidez |');
    out.push('|---|---:|---:|---:|---:|---:|');
    for (const f of [...filasEv].sort(ordenCajon)) {
      out.push(`| ${fmtRango(f)} | ${fmtPrecio(f.price_yes_latest)} | ${fmtPrecio(f.price_yes_first_seen)} | ${fmtPrecio(f.price_yes_t24h)} | ${f.volume === null || f.volume === undefined ? '—' : Math.round(f.volume)} | ${f.liquidity === null || f.liquidity === undefined ? '—' : Math.round(f.liquidity)} |`);
    }
    const suma = filasEv.reduce((a, f) => a + (Number(f.price_yes_latest) || 0), 0);
    out.push('', `Σ Yes = ${suma.toFixed(3)}`, '');
  }
  return out.join('\n') + '\n';
}

export {
  SEMILLAS_KPI, MIN_RANGOS_POR_EVENTO, EXCLUSIONES, ALIAS_KPI,
  excluyeTitulo, parseaRango, leeNumero, rangoDeMercado, extraeSimboloKpi, kpiDeTitulo,
  precioYesActual, filasDeEvento, conteos, veredictoFrontera, markdownEventos, fmtRango, num,
};
