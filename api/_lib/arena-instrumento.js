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

// ¿El catálogo dice que es una acción común operable?
// Devuelve { ok } o { ok:false, reason, detail }.
export function esAccionComun(asset) {
  if (!asset) return { ok: false, reason: 'catalogo_no_disponible', detail: 'el símbolo no está en el catálogo de Alpaca: no se puede operar, venga de donde venga' };
  if (asset.class && asset.class !== 'us_equity') return { ok: false, reason: 'no_es_equity', detail: `class=${asset.class}` };
  if (asset.status && asset.status !== 'active') return { ok: false, reason: 'inactivo', detail: `status=${asset.status}` };
  if (asset.tradable === false) return { ok: false, reason: 'no_operable', detail: 'Alpaca lo marca tradable=false' };
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
export async function filtrarComunes(symbols = [], { creds, now = new Date(), deps = {}, catalogo = null } = {}) {
  const wanted = [...new Set((symbols || []).map(up).filter(Boolean))];
  const cat = catalogo || await cargarCatalogo({ creds, now, deps });
  const assets = cat && cat.assets;

  const comunes = [];
  const rechazados = [];
  const porClase = {};

  for (const bruto of wanted) {
    if (!assets) { rechazados.push({ symbol: bruto, reason: 'catalogo_no_disponible' }); continue; }
    const sym = normalizarTicker(bruto, assets);
    const v = esAccionComun(assets[sym]);
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
      ...(cat && cat.error ? { catalogo_error: cat.error } : {}),
      note: assets
        ? 'Los rechazados por `no_es_comun` NO son una falla de cobertura: son warrants, unidades, rights y preferentes, que no son el universo del Arena.'
        : 'El catálogo de Alpaca no está disponible: NADA pasa el filtro. Es fail closed y es una falla NUESTRA, no de los nombres.',
    },
  };
}
