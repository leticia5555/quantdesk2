// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-meta.js — LA METADATA POR NOMBRE que los rieles necesitan.
//
// EL AGUJERO QUE TAPA. `validateTarget` (_lib/arena-rails.js) recibe
// `meta[sym] = { price, sector, shortable, easy_to_borrow }` y con eso decide
// R6 (concentración por sector), R9 (corto solo sobre nombre confirmado) y R10
// (piso de precio del corto). La sombra le pasaba `meta = {}`, y con el mapa
// vacío los tres rieles leen lo mismo: "sin dato".
//
// En R9 eso era CORRECTO y estaba dicho: fail closed, sin confirmación no se
// abre el corto. Pero rechaza TODOS los cortos, siempre, así que la sombra no
// podía decir nada sobre cómo cortan los siete modelos — el riel tapaba el
// experimento en vez de acotarlo.
//
// Y en R6 era peor, porque no saltaba a la vista: sin sector, TODOS los nombres
// caen al bucket UNKNOWN, el bucket suma el bruto entero y cualquier cartera de
// más del 50% bruto viola R6. La sombra estaba rechazando carteras por un tope
// de concentración sectorial calculado sobre un solo sector inventado por la
// ausencia de datos.
//
// ── DE DÓNDE SALE CADA CAMPO ─────────────────────────────────────────
//   shortable / easy_to_borrow → Alpaca /v2/assets/{symbol} (host de TRADING).
//                                Es la MISMA fuente que va a aceptar o rechazar
//                                la orden: preguntarle a otro sería validar
//                                contra una opinión distinta de la que manda.
//   price                      → snapshots de Alpaca, UNA llamada multi-símbolo.
//   sector                     → `finnhubIndustry` de profile2, mapeado a los
//                                once ETFs sectoriales del tablero.
//
// ── EL MAPEO DE INDUSTRIA A SECTOR ES POR REGLAS, NO POR TABLA CERRADA ─
// La taxonomía de `finnhubIndustry` no es GICS y no está congelada: aparecen
// etiquetas nuevas. Una tabla exacta se desactualiza en silencio y manda todo
// lo nuevo a UNKNOWN sin que nadie lo note. Acá el mapeo es una lista ORDENADA
// de reglas por palabra clave, y lo que ninguna regla toca queda UNKNOWN **y se
// cuenta** (`sector_unmapped`): una falla de cobertura tiene que verse como
// falla de cobertura, no disolverse en un bucket.
//
// ── CACHÉ POR DÍA, Y POR QUÉ ES EL GRANO CORRECTO ────────────────────
// `easy_to_borrow` lo recalcula Alpaca una vez al día, a la apertura. La
// industria de una empresa cambia cada varios años. Pedir los dos en cada
// corrida —tres rondas fijas × siete agentes— sería pagar 21 veces por un dato
// que cambia una vez al día en el mejor caso. Se acumulan en una fila por día
// en Neon (misma tabla que los canales lentos del buffet).
//
// LO QUE LA CACHÉ NO HACE: no inventa. Un nombre que falla no se guarda como
// "no shortable" — se guarda como ausente, y R9 lo vuelve a rechazar mañana
// hasta que Alpaca conteste. Guardar el fallo como un "no" lo volvería
// permanente.
// ═══════════════════════════════════════════════════════════════

import { getAssets, getSnapshots } from './alpaca.js';
import { readDayCache, writeDayCache } from './arena-buffet-cache.js';
import { SECTOR_UNKNOWN } from './arena-rails.js';

export const BORROW_CHANNEL = 'assets:borrow';
export const SECTOR_CHANNEL = 'assets:sector';

const up = (s) => String(s || '').trim().toUpperCase();

// ── INDUSTRIA → ETF SECTORIAL ────────────────────────────────────────
// Lista ORDENADA: gana la primera regla que matchea. El orden importa —
// "Financial Services" tiene que ganarle a "Services", y "Biotechnology" a
// "Technology", que es el mismo tipo de trampa que el `to buy` de "Broker
// upgrades NVDA to Buy" cayendo en el patrón de fusiones.
export const SECTOR_RULES = [
  [/biotech|pharma|life scien|drug/i, 'XLV'],
  [/health|medical|hospital|managed care/i, 'XLV'],
  [/semiconduct/i, 'XLK'],
  [/software|it services|internet software|electronic (equipment|technolog)|hardware|technolog/i, 'XLK'],
  [/bank|insurance|capital market|financ|asset manage|consumer financ/i, 'XLF'],
  [/telecom|media|entertainment|interactive media|publishing|advertis|internet/i, 'XLC'],
  [/oil|gas|coal|energy|refin|pipeline/i, 'XLE'],
  [/utilit|electric power|water util/i, 'XLU'],
  [/real estate|reit/i, 'XLRE'],
  [/chemical|metal|mining|steel|paper|forest|packaging|constr(uction)? material/i, 'XLB'],
  [/aerospace|defense|airline|machinery|industrial|transport|road & rail|marine|logistic|building|commercial services|professional services|trading compan|electrical equipment|conglomerate/i, 'XLI'],
  [/beverage|food|tobacco|household product|personal product|staples|grocer/i, 'XLP'],
  [/retail|apparel|textile|luxury|hotel|restaurant|leisure|automobile|auto (parts|compon)|homebuild|consumer (disc|durab|product|service)|distributor|education/i, 'XLY'],
];

// ── GICS → ETF, exacto ───────────────────────────────────────────────
// El CSV de IVV trae la columna `Sector` con los once nombres GICS oficiales.
// Eso NO es una heurística: es la clasificación del índice. Se mapea uno a uno
// y gana sobre cualquier regla por palabra clave.
export const GICS_A_ETF = {
  'information technology': 'XLK',
  financials: 'XLF',
  'health care': 'XLV',
  healthcare: 'XLV',
  'consumer discretionary': 'XLY',
  'consumer staples': 'XLP',
  energy: 'XLE',
  industrials: 'XLI',
  materials: 'XLB',
  utilities: 'XLU',
  'real estate': 'XLRE',
  'communication services': 'XLC',
};

export function sectorFromGics(nombre) {
  const k = String(nombre || '').trim().toLowerCase();
  return GICS_A_ETF[k] || null;
}

// Devuelve { etf, matched_by } o { etf: null } — nunca adivina.
export function sectorFromIndustry(industry) {
  const s = String(industry || '').trim();
  if (!s) return { etf: null, matched_by: null };
  for (const [re, etf] of SECTOR_RULES) {
    if (re.test(s)) return { etf, matched_by: String(re) };
  }
  return { etf: null, matched_by: null };
}

// ── profile2 de Finnhub, solo por la industria ───────────────────────
// Un request por nombre. Se llama sobre los símbolos del objetivo (unidades,
// no centenas), así que cabe de sobra en el tier gratis.
export async function fetchIndustry(symbol, finnhubKey, fetchImpl = fetch) {
  if (!finnhubKey) return null;
  try {
    const r = await fetchImpl(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    const ind = j && j.finnhubIndustry;
    return ind ? String(ind) : null;
  } catch { return null; }
}

// ── La caché acumulativa por día ─────────────────────────────────────
// Lee el mapa de hoy, pide SOLO lo que falta, y vuelve a guardar la unión.
// Dos lambdas que corren a la vez pueden pisarse la escritura y perder alguna
// entrada: el costo de eso es una relectura mañana, no un dato malo.
async function cachedMap(channel, symbols, fetchMissing, now) {
  const cached = (await readDayCache(channel, now)) || { payload: {} };
  const have = (cached.payload && typeof cached.payload === 'object') ? cached.payload : {};
  const missing = symbols.filter((s) => have[s] === undefined);
  if (!missing.length) return { map: have, fetched: 0, from_cache: symbols.length };
  const fresh = await fetchMissing(missing);
  const merged = { ...have, ...fresh };
  await writeDayCache(channel, merged, now);
  return { map: merged, fetched: Object.keys(fresh).length, from_cache: symbols.length - missing.length };
}

// ── LA METADATA COMPLETA ─────────────────────────────────────────────
// Nunca lanza: lo que falla sale ausente del mapa y los rieles lo leen como
// "sin dato", que es el comportamiento que ya está especificado y probado.
//
// `diagnostics` es lo que hace auditable el resultado: cuántos nombres tienen
// cada campo, cuántos quedaron sin sector y por qué. Sin eso, una cartera
// rechazada por R6 no se distingue de una cartera concentrada de verdad.
export async function buildRailMeta(symbols = [], {
  creds, finnhubKey = process.env.FINNHUB_API_KEY, now = new Date(), deps = {}, sectoresConocidos = null,
} = {}) {
  const wanted = [...new Set((symbols || []).map(up).filter(Boolean))];
  const meta = {};
  const errors = {};
  if (!wanted.length) return { meta, diagnostics: { symbols: 0 }, errors };

  const snaps = deps.getSnapshots || getSnapshots;
  const assets = deps.getAssets || getAssets;
  const industryOf = deps.fetchIndustry || fetchIndustry;

  const [precios, borrow, sectores] = await Promise.all([
    snaps(wanted, creds).catch((e) => { errors.prices = String((e && e.message) || e); return {}; }),
    cachedMap(BORROW_CHANNEL, wanted, (miss) => assets(miss, { creds }), now)
      .catch((e) => { errors.borrow = String((e && e.message) || e); return { map: {}, fetched: 0, from_cache: 0 }; }),
    cachedMap(SECTOR_CHANNEL, wanted, async (miss) => {
      const out = {};
      for (let i = 0; i < miss.length; i += 4) {
        await Promise.all(miss.slice(i, i + 4).map(async (sym) => {
          const ind = await industryOf(sym, finnhubKey);
          if (ind) out[sym] = ind;
        }));
      }
      return out;
    }, now).catch((e) => { errors.sectors = String((e && e.message) || e); return { map: {}, fetched: 0, from_cache: 0 }; }),
  ]);

  const sinSector = [];
  const sinBorrow = [];
  let porIndice = 0;
  for (const sym of wanted) {
    const p = precios[sym];
    const b = (borrow.map || {})[sym];
    const ind = (sectores.map || {})[sym] || null;
    // EL SECTOR DEL ÍNDICE GANA. Viene del CSV de IVV, que es la
    // clasificación GICS oficial del índice — no una heurística sobre el nombre
    // de la industria. Solo se cae a Finnhub para los nombres del día, que no
    // están en ningún índice.
    const delIndice = sectoresConocidos ? sectorFromGics(sectoresConocidos[sym]) : null;
    if (delIndice) porIndice++;
    const sec = delIndice ? { etf: delIndice, matched_by: 'gics_del_indice' } : sectorFromIndustry(ind);
    if (!b) sinBorrow.push(sym);
    if (!sec.etf) sinSector.push(sym);
    meta[sym] = {
      ...(p && Number.isFinite(p.price) ? { price: p.price } : {}),
      // El sector SOLO viaja si se resolvió. Mandar 'UNKNOWN' explícito y no
      // mandar nada son lo mismo para el riel (R6 usa SECTOR_UNKNOWN como
      // default), pero distintos para quien lee el journal.
      ...(sec.etf ? { sector: sec.etf } : {}),
      ...(ind ? { industry: ind } : {}),
      // FAIL CLOSED: sin fila de Alpaca no se afirma nada. `undefined` es lo
      // que R9 lee como "sin dato" y rechaza.
      ...(b ? { shortable: b.shortable === true, easy_to_borrow: b.easy_to_borrow === true, tradable: b.tradable === true } : {}),
    };
  }

  return {
    meta,
    diagnostics: {
      symbols: wanted.length,
      with_price: wanted.filter((s) => Number.isFinite(meta[s].price)).length,
      with_borrow: wanted.length - sinBorrow.length,
      shortable_ok: wanted.filter((s) => meta[s].shortable === true && meta[s].easy_to_borrow === true).length,
      with_sector: wanted.length - sinSector.length,
      sector_del_indice: porIndice,
      sector_de_finnhub: wanted.length - sinSector.length - porIndice,
      sector_unmapped: sinSector,
      sector_unknown_bucket: sinSector.length,
      borrow_missing: sinBorrow,
      borrow_fetched: borrow.fetched, borrow_from_cache: borrow.from_cache,
      sector_fetched: sectores.fetched, sector_from_cache: sectores.from_cache,
      unknown_bucket_label: SECTOR_UNKNOWN,
      note: sinBorrow.length
        ? `${sinBorrow.length} nombre(s) sin fila de /v2/assets: R9 va a rechazar cualquier corto sobre ellos. Es fail closed, no un bug.`
        : null,
    },
    errors,
  };
}
