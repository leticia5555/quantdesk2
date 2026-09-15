// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-universe.js — EL UNIVERSO del Arena (B1, ~600 nombres).
//
// El PM deja de mirar los ~100 nombres que se movieron hoy y pasa a mirar un
// universo estable: S&P 500 + Nasdaq 100 + hasta 100 movers/most-actives del
// día. La diferencia no es de tamaño, es de PREGUNTA. Con solo los movers, lo
// que el PM puede elegir está determinado por lo que se movió — un nombre que
// lleva tres semanas construyendo una base no existe para él. Con el universo,
// los movers pasan a ser una BANDERA sobre nombres que ya estaban ahí.
//
// ── LOS TRES ESCALONES (D1: el tablero NUNCA se bloquea) ─────────────
//
//     1. FMP        — fresco. Refresco SEMANAL, no diario: la composición de un
//                     índice cambia unas pocas veces al año, y pedirla todos los
//                     días es gastar cuota para recibir el mismo archivo.
//     2. Neon       — el último bueno que se bajó. Sobrevive a un deploy y a
//                     una caída de FMP, que es justo lo que un archivo en
//                     memoria no hace.
//     3. JSON en el repo — arranque en frío: Neon vacío Y FMP caído el mismo
//                     día. Ver data/universe/README.md.
//
// Si los tres fallan, el universo se arma SOLO con los movers del día y el
// journal dice `universe_source: 'movers_only'`. Un universo más chico es un
// sesgo declarado; un tablero que no sale es una corrida perdida.
//
// ── SURVIVORSHIP BIAS: DICHO, NO DISIMULADO ──────────────────────────
// Esto NO es point-in-time de verdad. Una lista de HOY aplicada a la sesión de
// AYER arrastra survivorship bias: las empresas que salieron del índice ya no
// están, así que el universo histórico se ve mejor de lo que fue. No existe un
// endpoint gratis y confiable de "constituyentes del S&P 500 en tal fecha".
// Se declara: cada corrida journalea `source` y `built_at` de la lista con la
// que operó, y el post-mortem sabe qué está leyendo.
//
// Lo que SÍ es point-in-time es el resto: los precios y volúmenes que deciden
// la admisión salen de velas CERRADAS (_lib/arena-admission.js), nunca de la
// vela viva del día que se opera.
//
// ── EL COSTO, Y POR QUÉ ESTO VIVE EN UN CRON ─────────────────────────
// ~600 nombres × (precio + volumen + market cap) no cabe en una corrida. Se
// reconstruye ANTES DE LA APERTURA en su propio cron y se guarda. Si el cron no
// corrió, la corrida usa el universo de AYER **y lo dice** — no se reconstruye
// a medias, que daría un universo mitad fresco y mitad viejo sin manera de
// saber cuál nombre es cuál.
//
// ENV VARS: FMP_API_KEY (opc — sin ella se salta al escalón 2) ·
//           ARENA_UNIVERSE_REFRESH_DAYS (opc, default 7) ·
//           ARENA_UNIVERSE_MOVERS_MAX (opc, default 100)
// ═══════════════════════════════════════════════════════════════

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from './db.js';
import { getMovers, getMostActives } from './alpaca.js';
import { ADMISSION, resolveAdmission, isAdmissible } from './arena-admission.js';
import { marketDay } from './arena-buffet-cache.js';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const INDICES = { sp500: 'sp500_constituent', nasdaq100: 'nasdaq_constituent' };

// Cada cuántos días se vuelve a pedir la composición. SEMANAL: un índice cambia
// unas pocas veces al año.
export const REFRESH_DAYS = (() => {
  const n = Number(process.env.ARENA_UNIVERSE_REFRESH_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.floor(n) : 7;
})();

// Tope de nombres del día que se AGREGAN al universo (los que no son de los
// índices). El encargo dice "hasta 100".
export const MOVERS_MAX = (() => {
  const n = Number(process.env.ARENA_UNIVERSE_MOVERS_MAX);
  return Number.isFinite(n) && n >= 0 && n <= 500 ? Math.floor(n) : 100;
})();

const SCHEMA = `create table if not exists arena_universe (
   key        text primary key,
   payload    jsonb not null,
   source     text,
   built_at   timestamptz not null default now()
 )`;

let ready = false;
async function ensure() {
  if (ready) return;
  await sql(SCHEMA);
  ready = true;
}

// Ticker limpio y en mayúsculas. Los tickers con punto de FMP (BRK.B) se
// normalizan al guion de Alpaca (BRK.B → BRK.B queda igual; Alpaca usa el
// punto también, así que solo se limpia espacio y caso). Un ticker con sufijo
// raro se descarta antes de llegar al filtro de admisión.
const clean = (s) => String(s || '').trim().toUpperCase();
const VALID_TICKER = /^[A-Z][A-Z0-9.]{0,6}$/;

// Piso de cordura por índice. No es el tamaño exacto (los índices flotan unos
// nombres): es "esto claramente no es la lista".
const MIN_SANE = { sp500: 400, nasdaq100: 80 };

// ── ESCALÓN 1: FMP ───────────────────────────────────────────────────
// Nunca lanza: devuelve null y el caller baja un escalón.
export async function fetchConstituents(index, { apiKey = process.env.FMP_API_KEY, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const path = INDICES[index];
  if (!path || !apiKey) return null;
  try {
    const r = await fetchImpl(`${FMP_BASE}/${path}?apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    const symbols = [...new Set(j.map((x) => clean(x && x.symbol)).filter((s) => s && VALID_TICKER.test(s)))].sort();
    // Una lista sospechosamente corta NO se acepta: un índice que devuelve 12
    // nombres es un error de la API o de la cuota, y guardarlo pisaría el
    // último bueno con basura. Es la diferencia entre degradar y corromper.
    if (symbols.length < MIN_SANE[index]) return null;
    return { index, source: 'fmp', built_at: new Date().toISOString(), symbols };
  } catch { return null; }
}

// ── ESCALÓN 2: Neon ──────────────────────────────────────────────────
export async function readStored(index) {
  try {
    await ensure();
    const rows = await sql(`select payload, source, built_at from arena_universe where key = $1`, ['constituents:' + index]);
    if (!rows.length) return null;
    const p = rows[0].payload || {};
    const symbols = Array.isArray(p.symbols) ? p.symbols : [];
    if (!symbols.length) return null;
    return { index, source: 'neon', stored_source: rows[0].source || null, built_at: rows[0].built_at, symbols };
  } catch { return null; }
}

export async function writeStored(index, snapshot) {
  try {
    await ensure();
    await sql(
      `insert into arena_universe (key, payload, source, built_at) values ($1, $2, $3, now())
       on conflict (key) do update set payload = excluded.payload, source = excluded.source, built_at = now()`,
      ['constituents:' + index, JSON.stringify({ symbols: snapshot.symbols }), snapshot.source],
    );
    return true;
  } catch { return false; }
}

// ── ESCALÓN 3: el JSON del repo ──────────────────────────────────────
export async function readStatic(index) {
  try {
    const url = new URL(`../../data/universe/${index}.json`, import.meta.url);
    const j = JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
    const symbols = (Array.isArray(j.symbols) ? j.symbols : []).map(clean).filter((s) => s && VALID_TICKER.test(s));
    if (!symbols.length) return null;   // el seed vacío NO cuenta como respaldo
    return { index, source: 'static', built_at: j.built_at || null, symbols };
  } catch { return null; }
}

// ¿Toca refrescar? Sale de la EDAD de lo guardado, no de un calendario: si el
// cron no corrió el lunes, el martes refresca igual en vez de esperar al
// siguiente lunes.
export function refreshDue(builtAt, now = new Date(), days = REFRESH_DAYS) {
  if (!builtAt) return true;
  const t = Date.parse(builtAt);
  if (!Number.isFinite(t)) return true;
  return (now.getTime() - t) >= days * 86400000;
}

// ── LOS CONSTITUYENTES, con los tres escalones ───────────────────────
// `force` salta la ventana de refresco (lo usa el endpoint a mano).
export async function resolveConstituents(index, { now = new Date(), force = false, deps = {} } = {}) {
  const fromFmp = deps.fetchConstituents || fetchConstituents;
  const fromNeon = deps.readStored || readStored;
  const toNeon = deps.writeStored || writeStored;
  const fromRepo = deps.readStatic || readStatic;

  const stored = await fromNeon(index);
  if (stored && !force && !refreshDue(stored.built_at, now)) {
    return { ...stored, refreshed: false, age_days: edad(stored.built_at, now) };
  }

  const fresh = await fromFmp(index);
  if (fresh) {
    const written = await toNeon(index, fresh);
    return { ...fresh, refreshed: true, stored: written, age_days: 0 };
  }

  // FMP no contestó (o no hay key, o devolvió una lista incoherente). Lo
  // guardado sirve IGUAL aunque esté vencido — y se dice cuánto.
  if (stored) {
    return { ...stored, refreshed: false, stale: true, age_days: edad(stored.built_at, now),
      note: `FMP no contestó: se usa la lista guardada de hace ${edad(stored.built_at, now)} días. Un universo de la semana pasada es un sesgo declarado.` };
  }
  const estatico = await fromRepo(index);
  if (estatico) {
    return { ...estatico, refreshed: false, stale: true, age_days: edad(estatico.built_at, now),
      note: 'Arranque en frío: sin FMP y sin nada guardado, se usa el JSON del repo.' };
  }
  return { index, source: 'none', symbols: [], built_at: null, refreshed: false,
    note: 'Sin FMP, sin lista guardada y con el JSON del repo vacío. Los índices NO entran al universo de hoy — ver data/universe/README.md.' };
}

function edad(builtAt, now) {
  const t = Date.parse(builtAt || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 86400000));
}

// ── EL UNIVERSO COMPLETO ─────────────────────────────────────────────
// índices (estables) + movers/most-actives del día (hasta MOVERS_MAX), todo
// por el MISMO filtro de admisión.
//
// LOS MOVERS NO SE FILTRAN DOS VECES: un mover que YA está en un índice no
// cuenta contra el tope de 100 — sería gastar el cupo de nombres nuevos en
// nombres que ya estaban. El tope aplica a los que el universo no tenía.
export async function buildUniverse({
  creds, finnhubKey = process.env.FINNHUB_API_KEY, now = new Date(),
  moversMax = MOVERS_MAX, rules = ADMISSION, force = false, deps = {},
} = {}) {
  const movers = deps.getMovers || getMovers;
  const actives = deps.getMostActives || getMostActives;
  const admit = deps.resolveAdmission || resolveAdmission;

  const errors = {};
  const [sp, nq, mv, ac] = await Promise.all([
    resolveConstituents('sp500', { now, force, deps }),
    resolveConstituents('nasdaq100', { now, force, deps }),
    movers({ top: 50, creds }).catch((e) => { errors.movers = String((e && e.message) || e); return null; }),
    actives({ top: 100, by: 'volume', creds }).catch((e) => { errors.most_actives = String((e && e.message) || e); return null; }),
  ]);

  const indexSyms = new Set([...sp.symbols, ...nq.symbols]);
  const delDia = [...new Set([
    ...((mv && mv.gainers) || []).map((m) => m.symbol),
    ...((mv && mv.losers) || []).map((m) => m.symbol),
    ...((ac && ac.most_actives) || []).map((m) => m.symbol),
  ].map(clean).filter((s) => s && VALID_TICKER.test(s)))];

  // Los del día que NO están ya en un índice. El tope se gasta solo acá.
  const nuevos = delDia.filter((s) => !indexSyms.has(s)).slice(0, moversMax);

  const candidatos = [...indexSyms, ...nuevos];

  // ── ADMISIÓN ──
  // Los nombres de los ÍNDICES pasan igual por el filtro: un constituyente que
  // cayó bajo $5 o bajo $1B sigue en el índice hasta que el comité lo saque, y
  // el universo del Arena no hereda esa demora.
  let admissionData = {};
  try {
    admissionData = await admit(candidatos, { finnhubKey, now });
  } catch (e) {
    errors.admission = String((e && e.message) || e);
  }
  const aplicado = Object.keys(admissionData).length > 0;
  const rechazados = [];
  const admitidos = [];
  for (const sym of candidatos) {
    if (!aplicado) { admitidos.push(sym); continue; }
    const v = isAdmissible({ symbol: sym, ...(admissionData[sym] || {}) }, rules);
    if (v.ok) admitidos.push(sym);
    else rechazados.push({ symbol: sym, reason: v.reason, ...(v.missing ? { missing: v.missing } : {}) });
  }

  // De dónde salió el universo, en una palabra, para el journal.
  const source = indexSyms.size === 0
    ? (admitidos.length ? 'movers_only' : 'empty')
    : (sp.source === 'fmp' && nq.source === 'fmp' ? 'fmp'
      : (sp.source === 'none' || nq.source === 'none' ? 'partial' : (sp.source === 'static' || nq.source === 'static' ? 'static' : 'neon')));

  return {
    built_at: now.toISOString(),
    market_day: marketDay(now),
    universe_source: source,
    symbols: admitidos.sort(),
    from_index: admitidos.filter((s) => indexSyms.has(s)),
    from_day: admitidos.filter((s) => !indexSyms.has(s)),
    indices: {
      sp500: { source: sp.source, built_at: sp.built_at, count: sp.symbols.length, age_days: sp.age_days ?? null, stale: !!sp.stale, note: sp.note || null },
      nasdaq100: { source: nq.source, built_at: nq.built_at, count: nq.symbols.length, age_days: nq.age_days ?? null, stale: !!nq.stale, note: nq.note || null },
    },
    counts: {
      indices: indexSyms.size,
      del_dia_brutos: delDia.length,
      del_dia_nuevos: nuevos.length,
      candidatos: candidatos.length,
      admitidos: admitidos.length,
    },
    admission: {
      applied: aplicado, rules, rejected_count: rechazados.length,
      // La lista entera pesa; se journalea acotada y con el conteo real al lado.
      rejected: rechazados.slice(0, 50),
      data_unavailable: rechazados.filter((r) => r.reason === 'data_unavailable').length,
    },
    errors,
    // La advertencia viaja CON el dato, no en un doc que nadie abre.
    caveat: 'La composición de los índices es la de HOY aplicada a la sesión de hoy. No es point-in-time histórico: un backtest sobre esta lista arrastra survivorship bias.',
  };
}

// Snapshot del universo del día, para que la corrida no lo reconstruya.
export async function saveUniverse(snapshot, now = new Date()) {
  try {
    await ensure();
    await sql(
      `insert into arena_universe (key, payload, source, built_at) values ($1, $2, $3, now())
       on conflict (key) do update set payload = excluded.payload, source = excluded.source, built_at = now()`,
      ['universe:' + marketDay(now), JSON.stringify(snapshot), snapshot.universe_source],
    );
    return true;
  } catch { return false; }
}

// El universo del día, si el cron ya lo construyó. `allowPrevious` deja usar el
// de AYER cuando el de hoy no existe — pero lo marca, que es la diferencia
// entre degradar y mentir.
export async function loadUniverse({ now = new Date(), allowPrevious = true } = {}) {
  try {
    await ensure();
    const hoy = marketDay(now);
    const rows = await sql(
      `select key, payload, built_at from arena_universe
       where key like 'universe:%' and key <= $1 order by key desc limit 1`, ['universe:' + hoy],
    );
    if (!rows.length) return null;
    const dia = String(rows[0].key).slice('universe:'.length);
    if (dia !== hoy && !allowPrevious) return null;
    return {
      ...rows[0].payload,
      loaded_from: dia,
      is_today: dia === hoy,
      ...(dia === hoy ? {} : { note: `El cron pre-apertura no corrió hoy: se usa el universo del ${dia}. No se reconstruye a medias — un universo mitad fresco y mitad viejo no se puede auditar.` }),
    };
  } catch { return null; }
}
