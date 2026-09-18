// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-buffet.js — BUFFET v1.5: el universo del día con OJOS PROPIOS.
//
// v1 le daba al PM ~24 nombres de UNA fuente (/api/movers, top-8 por lado) más
// earnings, insiders y el screener. v1.5 le da ~100, de TRES preguntas
// distintas que el screener de Alpaca contesta sin una llamada por símbolo:
//
//   · ¿QUÉ SE MOVIÓ?        movers: hasta 50 gainers y 50 losers del día.
//   · ¿QUÉ SE NEGOCIÓ?      most-actives: hasta 100 por volumen. NO es la
//                           misma pregunta — un nombre puede mover 8% con
//                           volumen de nada, o negociar $2.000M sin moverse.
//   · ¿QUÉ ROMPIÓ SU RANGO? máximos y mínimos de 52 semanas, calculados de
//                           barras semanales cerradas.
//
// Es el escalón hacia el universo de ~600 de B1: la misma forma (reconstruir
// el universo, filtrarlo por admisión, deduplicar con banderas, publicarlo
// point-in-time), a una escala que ya cabe hoy.
//
// ── LAS TRES REGLAS DE LA CASA QUE ESTO RESPETA ──────────────────────
//
// 1. UN SOLO FILTRO DE ADMISIÓN. Los tres canales pasan por el MISMO
//    `_lib/arena-admission.js` (precio ≥ $5, mcap ≥ $1B, volumen $ ≥ $10M/día),
//    fail closed. El bug de DDDX fue exactamente lo contrario: tres canales con
//    tres criterios y el más flojo mandando.
//
// 2. DEDUPE CON BANDERAS, NO CON PRIORIDAD. Un nombre que aparece en gainers Y
//    en most-actives Y marcando máximo de 52 semanas es UNA entrada con las
//    TRES banderas — no tres entradas, ni una sola con el canal que llegó
//    primero. La coincidencia de canales ES la señal: perderla al deduplicar
//    sería tirar justo lo que hace interesante al nombre. Y el conteo de
//    banderas por nombre es lo que ordena la lista cuando hay que recortar.
//
// 3. POINT-IN-TIME. El 52w sale de barras SEMANALES CERRADAS: la semana en
//    curso se excluye. Si no, un nombre "marca nuevo máximo" contra un máximo
//    que ya incluye el precio de este momento — o sea, contra sí mismo.
//
// NO LANZA NUNCA. Un canal caído sale nombrado en `unavailable` con su error y
// el buffet se arma con los otros. El PM opera con menos contexto, nunca con
// contexto inventado.
// ═══════════════════════════════════════════════════════════════

import { getMovers, getMostActives, getFiftyTwoWeek } from './alpaca.js';
import { ADMISSION, resolveAdmission, isAdmissible } from './arena-admission.js';
import { cachePersistente } from './arena-mcap-cache.js';

// Cuántos nombres ve el PM. ~100 es el número del encargo: suficiente para que
// la elección sea suya y no nuestra, y chico para que el bloque siga siendo
// legible dentro del presupuesto de tokens del tablero.
export const BUFFET_V15_TARGET = (() => {
  const n = Number(process.env.ARENA_BUFFET_V15_TARGET);
  return Number.isFinite(n) && n >= 10 && n <= 400 ? Math.floor(n) : 100;
})();

// Cerca del extremo del rango, en puntos porcentuales. 2% y no 0% a propósito:
// un nombre a 1.5% de su máximo de 52 semanas está contando la misma historia
// que uno que lo tocó, y exigir el toque exacto convierte la señal en un sorteo
// de un centavo.
export const NEAR_52W_PCT = 2;

// Las banderas, en el orden en que valen para ordenar la lista. Es un orden
// DECLARADO, no el de inserción de un objeto: lo que se rankea es "en cuántas
// preguntas distintas apareció este nombre", y los desempates tienen que ser
// reproducibles para que el journal y el replay coincidan.
export const BUFFET_FLAGS = ['gainer', 'loser', 'most_active', 'high_52w', 'low_52w'];

// ── DEDUPE CON BANDERAS (puro, testeable sin red) ────────────────────
// Entra: listas por canal. Sale: un mapa ticker → { symbol, flags[], ...datos }.
// Los datos de cada canal se FUNDEN en la misma entrada (el precio del mover,
// el volumen del most-active, el rango del 52w) en vez de competir.
export function mergeChannels({ gainers = [], losers = [], actives = [], fiftyTwo = {} } = {}) {
  const map = new Map();
  const touch = (symbol) => {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    if (!map.has(sym)) map.set(sym, { symbol: sym, flags: [] });
    return map.get(sym);
  };
  const flag = (entry, f) => { if (entry && !entry.flags.includes(f)) entry.flags.push(f); };

  for (const m of gainers) {
    const e = touch(m.symbol); if (!e) continue;
    flag(e, 'gainer');
    e.price = Number(m.price); e.change_pct = Number(m.percent_change);
  }
  for (const m of losers) {
    const e = touch(m.symbol); if (!e) continue;
    flag(e, 'loser');
    e.price = Number(m.price); e.change_pct = Number(m.percent_change);
  }
  for (const m of actives) {
    const e = touch(m.symbol); if (!e) continue;
    flag(e, 'most_active');
    if (Number.isFinite(Number(m.volume))) e.volume = Number(m.volume);
    if (Number.isFinite(Number(m.trade_count))) e.trade_count = Number(m.trade_count);
  }
  for (const [sym, r] of Object.entries(fiftyTwo || {})) {
    if (!r) continue;
    // Solo se le cuelga el rango a un nombre que YA está en el universo: el 52w
    // no es un canal que aporte nombres nuevos, es contexto sobre los que hay.
    const e = map.get(String(sym).toUpperCase());
    if (!e) continue;
    e.high_52w = r.high_52w; e.low_52w = r.low_52w;
    e.pct_from_high = r.pct_from_high; e.pct_from_low = r.pct_from_low;
    if (Number.isFinite(r.pct_from_high) && r.pct_from_high >= -NEAR_52W_PCT) flag(e, 'high_52w');
    if (Number.isFinite(r.pct_from_low) && r.pct_from_low <= NEAR_52W_PCT) flag(e, 'low_52w');
  }
  // Las banderas quedan en el orden DECLARADO, no en el de inserción.
  for (const e of map.values()) e.flags = BUFFET_FLAGS.filter((f) => e.flags.includes(f));
  return map;
}

// ── ORDEN Y RECORTE ──────────────────────────────────────────────────
// Primero por CUÁNTAS banderas (la coincidencia de canales es la señal),
// después por magnitud del movimiento, y el símbolo como desempate final.
//
// El símbolo al final NO es decorativo: sin un desempate total, dos corridas
// con los mismos datos podrían devolver órdenes distintas y el replay dejaría
// de reproducir la corrida. Un sort inestable es un journal irreproducible.
export function rankCandidates(entries, limit = BUFFET_V15_TARGET) {
  const arr = [...entries];
  arr.sort((a, b) => {
    if (b.flags.length !== a.flags.length) return b.flags.length - a.flags.length;
    const ma = Math.abs(Number(a.change_pct) || 0);
    const mb = Math.abs(Number(b.change_pct) || 0);
    if (mb !== ma) return mb - ma;
    const va = Number(a.volume) || 0, vb = Number(b.volume) || 0;
    if (vb !== va) return vb - va;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
  return arr.slice(0, limit);
}

// ── EL ARMADO COMPLETO ───────────────────────────────────────────────
// `creds` son las de Alpaca; `finnhubKey` alimenta el market cap del filtro de
// admisión. Devuelve el bloque tal como va al buffet, más el diagnóstico
// (`unavailable`, `errors`, `admission`) que se journalea pero NO viaja al
// prompt.
export async function buildBuffetV15({
  creds, finnhubKey = process.env.FINNHUB_API_KEY, now = new Date(),
  target = BUFFET_V15_TARGET, rules = ADMISSION,
  deps = {},
} = {}) {
  const movers = deps.getMovers || getMovers;
  const actives = deps.getMostActives || getMostActives;
  const range52 = deps.getFiftyTwoWeek || getFiftyTwoWeek;
  const admit = deps.resolveAdmission || resolveAdmission;

  const errors = {};
  const unavailable = [];

  // Los dos canales de nombres, EN PARALELO: el costo del buffet es el del
  // canal más lento, no la suma.
  const [mv, ac] = await Promise.all([
    movers({ top: 50, creds }).catch((e) => { errors.movers = String((e && e.message) || e); unavailable.push('movers'); return null; }),
    actives({ top: 100, by: 'volume', creds }).catch((e) => { errors.most_actives = String((e && e.message) || e); unavailable.push('most_actives'); return null; }),
  ]);

  const gainers = (mv && mv.gainers) || [];
  const losers = (mv && mv.losers) || [];
  const mostActives = (ac && ac.most_actives) || [];

  // Universo bruto: la unión de los dos canales, antes de admisión.
  const universo = [...new Set([
    ...gainers.map((m) => m.symbol),
    ...losers.map((m) => m.symbol),
    ...mostActives.map((m) => m.symbol),
  ])].filter(Boolean);

  // ── ADMISIÓN, ANTES del 52w ──
  // El orden importa por costo: el rango de 52 semanas son barras por símbolo,
  // así que se piden SOLO para los nombres que ya pasaron el filtro. Al revés,
  // se pagaría por el rango de nombres que van a quedar afuera igual.
  let admissionData = {};
  try {
    // Mismo pozo que el universo: el buffet corre varias veces al día sobre
    // nombres que se repiten, y sin la caché cada corrida pagaba cuota otra vez.
    admissionData = await admit(universo, {
      finnhubKey, now, mcapCache: deps.mcapCache || cachePersistente({ now }),
    });
  } catch (e) {
    errors.admission = String((e && e.message) || e);
  }
  const conocido = {};
  for (const m of [...gainers, ...losers]) if (Number.isFinite(m.price)) conocido[m.symbol] = { price: m.price };

  const rechazados = [];
  const admitidos = new Set();
  for (const sym of universo) {
    const v = isAdmissible({ symbol: sym, ...(admissionData[sym] || conocido[sym] || {}) }, rules);
    if (v.ok) admitidos.add(sym);
    else rechazados.push({ symbol: sym, reason: v.reason, ...(v.missing ? { missing: v.missing } : {}) });
  }
  // SI LA ADMISIÓN NO RESOLVIÓ NADA, no se filtra: degradar a "sin filtro" es
  // malo, pero dejar el buffet vacío por una caída de Finnhub es peor, y fingir
  // que se filtró sería lo peor de todo. Se declara en `admission.applied`.
  const aplicado = Object.keys(admissionData).length > 0;
  const vivos = aplicado ? universo.filter((s) => admitidos.has(s)) : universo;

  let fiftyTwo = {};
  if (vivos.length) {
    try { fiftyTwo = await range52(vivos, { creds, now }); }
    catch (e) { errors.fifty_two_week = String((e && e.message) || e); unavailable.push('52w'); }
  }

  const keep = new Set(vivos);
  const merged = mergeChannels({
    gainers: gainers.filter((m) => keep.has(m.symbol)),
    losers: losers.filter((m) => keep.has(m.symbol)),
    actives: mostActives.filter((m) => keep.has(m.symbol)),
    fiftyTwo,
  });
  const candidates = rankCandidates([...merged.values()], target);

  const porBandera = {};
  for (const f of BUFFET_FLAGS) porBandera[f] = candidates.filter((c) => c.flags.includes(f)).length;

  return {
    version: 'v1.5',
    built_at: now.toISOString(),
    // Lo que VE el PM.
    candidates,
    counts: {
      universo_bruto: universo.length,
      admitidos: vivos.length,
      publicados: candidates.length,
      por_bandera: porBandera,
      multi_canal: candidates.filter((c) => c.flags.length > 1).length,
    },
    near_52w_pct: NEAR_52W_PCT,
    last_updated: { movers: (mv && mv.last_updated) || null, most_actives: (ac && ac.last_updated) || null },
    // Diagnóstico: NO viaja al prompt.
    unavailable,
    errors,
    admission: {
      applied: aplicado,
      rules,
      rejected: rechazados,
      rejected_count: rechazados.length,
      data_unavailable: rechazados.filter((r) => r.reason === 'data_unavailable').length,
    },
  };
}
