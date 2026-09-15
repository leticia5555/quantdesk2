// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-instrumento.js — ¿ESTO ES UNA ACCIÓN COMÚN?
//
// EL REPORTE QUE LO ORIGINA (2026-09-15): el canal del día entregó 100
// candidatos y se admitieron CERO. 69 salieron `data_unavailable` y eran
// warrants, rights, preferentes y unidades — instrumentos que nunca tuvieron
// que llegar al filtro de admisión, porque no son el universo del Arena.
//
// Que salieran por "faltan datos" es doblemente malo: no solo entraban, sino
// que al rebotar se veían como una falla de COBERTURA (no pudimos resolver el
// market cap) en vez de como lo que eran (no es una acción). Un rechazo con el
// motivo equivocado manda a buscar el problema al lugar equivocado — y eso fue
// exactamente lo que pasó: se investigó Finnhub cuando el problema era el
// universo de entrada.
//
// ── POR QUÉ EL SUFIJO NO ALCANZA ─────────────────────────────────────
// `_lib/arena-guard.js` ya tenía una heurística: `/[.\-+](WS|WT|W|U|R|RT)$/`.
// Exige un SEPARADOR, y Alpaca escribe muchos warrants pegados: `ABCDW`, no
// `ABCD.W`. Así que la mitad pasaba de largo. Y al revés, un sufijo sin
// separador es ambiguo de verdad: `ANDW` no es un warrant de `AND`.
//
// ── LA FUENTE AUTORITATIVA ES EL CATÁLOGO DE ALPACA ──────────────────
// `/v2/assets` devuelve `class`, `status`, `tradable` y `name` de los ~11.000
// símbolos, en UNA request. El `name` es el que resuelve la ambigüedad: un
// warrant se llama "... Warrant", una unidad "... Unit", una preferente
// "... Preferred Stock". Eso no es heurística sobre el ticker: es lo que el
// broker dice que es el instrumento.
//
// El sufijo queda como filtro BARATO de primera pasada y como respaldo para
// cuando Alpaca no contesta — no como criterio principal.
//
// ── FAIL CLOSED, igual que la admisión ───────────────────────────────
// Si no se puede confirmar que un símbolo es una acción común tradable, NO
// entra. Es la misma decisión que tomó el filtro de admisión con DDDX: la
// alternativa ("si no sé, que pase") es exactamente cómo entró.
//
// Y el motivo viaja: `no_es_comun` (sabemos que no lo es) se journalea aparte
// de `catalogo_no_disponible` (no pudimos preguntarle a Alpaca). Uno es el
// filtro funcionando; el otro es una falla nuestra.
// ═══════════════════════════════════════════════════════════════

import { getAllAssets } from './alpaca.js';
import { readDayCache, writeDayCache } from './arena-buffet-cache.js';
import { EXCLUDED_SECURITY_TYPES, isLeveragedInverseETF } from './arena-guard.js';

export const CATALOGO_CANAL = 'alpaca:assets';

const up = (s) => String(s || '').trim().toUpperCase();

// ── EL NOMBRE ES EL QUE MANDA ────────────────────────────────────────
// Alpaca pone el tipo de instrumento en el nombre. Las alternativas viven en un
// solo lugar para que agregar una no signifique tocar cinco archivos.
export const NOMBRE_NO_COMUN = [
  [/\bwarrants?\b/i, 'warrant'],
  [/\brights?\b/i, 'right'],
  [/\bunits?\b/i, 'unidad'],
  [/\bpreferred\b|\bpfd\b|\bpref\b/i, 'preferente'],
  [/\bdepositary (share|receipt)/i, 'depositary share'],
  [/\b(sub(ordinated)?\s+)?(note|debenture|bond)s?\b/i, 'deuda'],
  [/\btrust preferred\b/i, 'trust preferred'],
];

// ── SUFIJOS: filtro BARATO, no criterio ──────────────────────────────
// Dos familias, y la diferencia importa:
//   · CON separador (`ABCD.WS`, `ABCD-U`): inequívoco, Alpaca los usa así.
//   · SIN separador (`ABCDW`): AMBIGUO — `ANDW` no es un warrant. Estos NO se
//     rechazan por sufijo: solo se marcan como "mirá el catálogo".
export const SUFIJO_CLARO = /[.\-+/](WS|WT|W|U|R|RT|RTS|PR[A-Z]?|P[A-Z])$/i;
export const SUFIJO_AMBIGUO = /(W|U|R)$/i;

// ── LOS ETFs NO SON ACCIONES, Y `class` NO LOS DISTINGUE ─────────────
// EL REPORTE: 21 de los 50 cupos del canal del día se los llevaron ETFs —SPY,
// QQQ, SOXL, GLD, XLE— que después rebotaron por market cap. Ocupaban lugar de
// acciones y encima gastaban una llamada a Finnhub cada uno.
//
// LO PRIMERO, PORQUE CAMBIA EL DISEÑO: en Alpaca un ETF es `class: 'us_equity'`,
// igual que una acción. La prueba está en el reporte mismo — SPY y QQQ pasaron
// el filtro de instrumento, que exige exactamente esa clase. Así que `class` no
// sirve para esto, y hacen falta dos señales:
//
//   1. EL `type` DEL SYMBOL MAP DE FINNHUB (autoritativo). Ya existe en el
//      repo: `EXCLUDED_SECURITY_TYPES` del guard marca ETP, Closed-End Fund y
//      Open-End Fund, con 97,6% de cobertura confirmada en prod. Se IMPORTA en
//      vez de redefinirse — una segunda lista de "qué es un fondo" es una lista
//      que se va a desincronizar de la primera.
//   2. EL NOMBRE del catálogo de Alpaca (sin key, siempre disponible).
//
// ── LAS REGLAS DE NOMBRE SON ANGOSTAS A PROPÓSITO ────────────────────
// La tentación es `/\btrust\b/` o `/\bshares\b/`. Las dos están MAL:
// "Northern Trust Corporation" es un banco del S&P 500, y media docena de
// compañías reales llevan "Shares" en el nombre. Es la misma trampa que ANDW
// con los warrants: una palabra genérica se come compañías de verdad.
//
// Así que acá van EMISORES y marcas —SPDR, iShares, ProShares…— y frases que
// solo aparecen en fondos. Lo que se escape por nombre lo agarra el `type`.
export const NOMBRE_ES_FONDO = [
  [/\bETFs?\b|\bETNs?\b/i, 'ETF'],
  [/\b(spdr|ishares|proshares|direxion|vaneck|wisdomtree|global\s?x|invesco|vanguard|schwab strategic|first trust|pacer funds|amplify etf|granite\s?shares|simplify etf)\b/i, 'emisor de ETF'],
  [/\bselect sector\b|\bindex fund\b|\bindex trust\b|\bunit investment trust\b|\bexchange[- ]traded\b/i, 'fondo indexado'],
  [/\b(bull|bear)\s*\d(\.\d)?x\b|\b\d(\.\d)?x (long|short|daily)\b/i, 'apalancado'],
];

// ¿Es un fondo? `type` viene del symbol map de Finnhub cuando está disponible.
export function esFondo(asset, type = null) {
  if (type && EXCLUDED_SECURITY_TYPES.has(type)) return { si: true, clase: 'fondo', fuente: `type=${type}` };
  const nombre = String((asset && asset.name) || '');
  const sym = String((asset && asset.symbol) || '');
  for (const [re, etiqueta] of NOMBRE_ES_FONDO) {
    if (re.test(nombre)) return { si: true, clase: etiqueta, fuente: `"${nombre.slice(0, 60)}"` };
  }
  // La doble barrera del guard para apalancados/inversos: lista curada + nombre.
  if (isLeveragedInverseETF(sym, nombre)) return { si: true, clase: 'apalancado', fuente: 'lista curada del guard' };
  return { si: false };
}

// ¿El catálogo dice que es una acción común operable?
// Devuelve { ok } o { ok:false, reason, detail }.
export function esAccionComun(asset, { type = null, excluirFondos = true } = {}) {
  if (!asset) return { ok: false, reason: 'catalogo_no_disponible', detail: 'el símbolo no está en el catálogo de Alpaca: no se puede operar, venga de donde venga' };
  if (asset.class && asset.class !== 'us_equity') return { ok: false, reason: 'no_es_equity', detail: `class=${asset.class}` };
  if (asset.status && asset.status !== 'active') return { ok: false, reason: 'inactivo', detail: `status=${asset.status}` };
  if (asset.tradable === false) return { ok: false, reason: 'no_operable', detail: 'Alpaca lo marca tradable=false' };
  // DESPUÉS de los bloqueos duros, y el orden lo fijó un test: un símbolo
  // inactivo tiene que rechazarse por INACTIVO. "Es un fondo" es cierto pero
  // secundario, y el motivo que se journalea es el que alguien va a leer para
  // decidir qué hacer.
  if (excluirFondos) {
    // OJO: esto NO se puede resolver con `asset.class` — en Alpaca un ETF
    // también es `us_equity`. Ver el encabezado de `esFondo`.
    const f = esFondo(asset, type);
    if (f.si) return { ok: false, reason: 'es_fondo', clase: f.clase, detail: f.fuente };
  }
  const nombre = String(asset.name || '');
  for (const [re, etiqueta] of NOMBRE_NO_COMUN) {
    if (re.test(nombre)) return { ok: false, reason: 'no_es_comun', clase: etiqueta, detail: `"${nombre.slice(0, 70)}"` };
  }
  // Sin nombre no se puede descartar por nombre, pero el sufijo inequívoco sí
  // alcanza: `ABCD.WS` es un warrant en cualquier convención.
  if (!nombre && SUFIJO_CLARO.test(up(asset.symbol || ''))) {
    return { ok: false, reason: 'no_es_comun', clase: 'sufijo', detail: 'sin nombre en el catálogo, pero el sufijo es inequívoco' };
  }
  return { ok: true };
}

// ── EL CATÁLOGO, cacheado por día ────────────────────────────────────
// Un símbolo no cambia de clase dentro del día. Se guarda REDUCIDO —solo lo que
// el filtro mira— porque las ~11.000 filas completas son varios MB y no hay
// ninguna razón para arrastrarlas.
export async function cargarCatalogo({ creds, now = new Date(), deps = {} } = {}) {
  const cached = await readDayCache(CATALOGO_CANAL, now).catch(() => null);
  if (cached && cached.payload && cached.payload.assets && Object.keys(cached.payload.assets).length) {
    return { assets: cached.payload.assets, from_cache: true, fetched_at: cached.fetched_at, count: Object.keys(cached.payload.assets).length };
  }
  const traer = deps.getAllAssets || getAllAssets;
  let filas = [];
  try { filas = await traer({ creds }); }
  catch (e) { return { assets: null, from_cache: false, error: String((e && e.message) || e) }; }

  const assets = {};
  for (const a of filas || []) {
    const s = up(a && a.symbol);
    if (!s) continue;
    assets[s] = { symbol: s, class: a.class || null, status: a.status || null, tradable: a.tradable !== false, name: a.name || null };
  }
  if (!Object.keys(assets).length) return { assets: null, from_cache: false, error: 'el catálogo vino vacío' };
  await writeDayCache(CATALOGO_CANAL, { assets }, now).catch(() => {});
  return { assets, from_cache: false, count: Object.keys(assets).length };
}

// ── NORMALIZACIÓN DE TICKER ──────────────────────────────────────────
// Las tenencias de ETFs escriben las clases múltiples sin punto (`BRKB`), y
// Alpaca las escribe con punto (`BRK.B`). En vez de una tabla de alias que se
// desactualiza, se PREGUNTA al catálogo: si el símbolo tal cual no existe pero
// la versión con punto antes de la última letra sí, se usa ésa.
//
// Solo se intenta cuando el original NO existe, así que no puede romper un
// símbolo bueno: `ANDW` existe y se queda como está.
export function normalizarTicker(sym, assets) {
  const s = up(sym);
  if (!s || !assets) return s;
  if (assets[s]) return s;
  if (/^[A-Z]{3,5}$/.test(s)) {
    const conPunto = s.slice(0, -1) + '.' + s.slice(-1);
    if (assets[conPunto]) return conPunto;
  }
  return s;
}

// ── EL FILTRO, sobre un lote ─────────────────────────────────────────
// Devuelve { comunes, rechazados, diagnostics }. NUNCA lanza: si el catálogo no
// está, no inventa — devuelve todo rechazado con `catalogo_no_disponible`, que
// es una falla NUESTRA y se journalea como tal.
export async function filtrarComunes(symbols = [], { creds, now = new Date(), deps = {}, catalogo = null, symbolTypes = null, excluirFondos = true } = {}) {
  const wanted = [...new Set((symbols || []).map(up).filter(Boolean))];
  const cat = catalogo || await cargarCatalogo({ creds, now, deps });
  const assets = cat && cat.assets;

  const comunes = [];
  const rechazados = [];
  const porClase = {};

  for (const bruto of wanted) {
    if (!assets) { rechazados.push({ symbol: bruto, reason: 'catalogo_no_disponible' }); continue; }
    const sym = normalizarTicker(bruto, assets);
    const v = esAccionComun(assets[sym], { type: symbolTypes ? symbolTypes[sym] || null : null, excluirFondos });
    if (v.ok) { comunes.push(sym); continue; }
    porClase[v.clase || v.reason] = (porClase[v.clase || v.reason] || 0) + 1;
    rechazados.push({ symbol: sym, ...(sym !== bruto ? { original: bruto } : {}), reason: v.reason, ...(v.clase ? { clase: v.clase } : {}), detail: v.detail });
  }

  return {
    comunes,
    rechazados,
    diagnostics: {
      entraron: wanted.length,
      comunes: comunes.length,
      rechazados: rechazados.length,
      por_clase: porClase,
      catalogo_disponible: !!assets,
      catalogo_count: (cat && cat.count) || 0,
      catalogo_from_cache: !!(cat && cat.from_cache),
      // De dónde salió la señal de "es un fondo". El `type` del symbol map es
      // autoritativo; sin él quedan solo las reglas de nombre, que son angostas
      // a propósito y por lo tanto dejan pasar alguno.
      fondos_excluidos: rechazados.filter((x) => x.reason === 'es_fondo').length,
      symbol_types_disponible: !!symbolTypes,
      ...(cat && cat.error ? { catalogo_error: cat.error } : {}),
      note: assets
        ? 'Los rechazados por `no_es_comun` y `es_fondo` NO son una falla de cobertura: son warrants, unidades, rights, preferentes y ETFs — nada de eso es el universo del Arena. Los ETFs sectoriales ya viajan en el tablero como calor por sector, que es donde van.'
        : 'El catálogo de Alpaca no está disponible: NADA pasa el filtro. Es fail closed y es una falla NUESTRA, no de los nombres.',
    },
  };
}
