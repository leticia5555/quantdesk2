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

import { sql } from './db.js';
import { getMovers, getMostActives, getFiftyTwoWeek, getPriceAndDollarVolume } from './alpaca.js';
import { ADMISSION, resolveAdmission, isAdmissible } from './arena-admission.js';
import { marketDay } from './arena-buffet-cache.js';
import { fetchHoldings, HOLDINGS_SOURCES } from './etf-holdings.js';
import { filtrarComunes, cargarCatalogo } from './arena-instrumento.js';
import { CONSTITUENTS } from '../../data/universe/constituents.js';

// ── LAS DOS APIs DE FMP, Y POR QUÉ SE PRUEBAN LAS DOS ────────────────
// FMP tiene dos generaciones vivas: la vieja (`/api/v3`, con guiones bajos) y
// la nueva (`/stable`, con guiones). Cuál de las dos acepta una key depende de
// CUÁNDO se creó la key y de qué plan tiene: una key nueva suele recibir 403
// "Legacy Endpoint" en v3, y una vieja puede no tener acceso a stable.
//
// Adivinar cuál corresponde es justo lo que no se puede hacer desde el código.
// Se prueban las dos y se REPORTA cuál contestó — son como mucho dos requests
// por índice, una vez por semana. Lo que se gana es que "la key no sirve" deje
// de ser indistinguible de "le estás pegando al endpoint equivocado".
export const FMP_APIS = [
  { id: 'stable', base: 'https://financialmodelingprep.com/stable',
    paths: { sp500: 'sp500-constituent', nasdaq100: 'nasdaq-constituent' } },
  { id: 'v3', base: 'https://financialmodelingprep.com/api/v3',
    paths: { sp500: 'sp500_constituent', nasdaq100: 'nasdaq_constituent' } },
];
const INDICES = { sp500: true, nasdaq100: true };

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

// ── ESCALÓN 1: LAS TENENCIAS DEL ETF ─────────────────────────────────
// Reemplazó a FMP, que cobra por los constituyentes: `/stable` devuelve 402
// "Restricted Endpoint" y `/api/v3` un 403 "Legacy". Las tenencias de IVV y QQQ
// son públicas, diarias, sin key y sin plan — y son el REPLICANTE diciendo qué
// tiene, no un tercero diciendo qué cree que tiene el índice.
//
// Nunca lanza: devuelve null y el caller baja un escalón, igual que antes.
export async function fetchDesdeEtf(index, { now = new Date(), fetchImpl = fetch, diag = null } = {}) {
  const anota = (fila) => { if (Array.isArray(diag)) diag.push(fila); };
  const r = await fetchHoldings(index, { fetchImpl });
  anota({ fuente: 'etf', ...r.diagnostics });
  const symbols = (r.symbols || []).map(clean).filter((x) => x && VALID_TICKER.test(x));
  if (!symbols.length) return null;
  // El MISMO piso de cordura de siempre: una lista corta es un error del
  // proveedor, no el índice, y guardarla pisaría la buena con basura.
  if (symbols.length < MIN_SANE[index]) {
    anota({ fuente: 'etf', index, ok: false, reason: 'lista_corta', recibidos: symbols.length, minimo: MIN_SANE[index] });
    return null;
  }
  const src = HOLDINGS_SOURCES[index] || {};
  return { index, source: 'etf', etf: src.etf || null, built_at: now.toISOString(), symbols };
}

// ── ESCALÓN 1b: FMP, SOLO SI HAY KEY DE PAGO ─────────────────────────
// Degradado a respaldo opcional. Sin `FMP_API_KEY` ni se intenta: los
// constituyentes son endpoint de pago y pegarle sin plan solo produce un 402
// que hay que explicar.
// Nunca lanza: devuelve null y el caller baja un escalón.
// ── EL DIAGNÓSTICO: POR QUÉ FALLÓ, NO SOLO QUE FALLÓ ─────────────────
// Esto devolvía `null` pelado en SEIS situaciones distintas —sin key, HTTP de
// error, cuerpo que no es un array, JSON roto, timeout, y lista más corta que
// el piso de cordura— y ninguna llegaba a `errors`. Todas terminaban en el
// mismo "Sin FMP", así que una key mal alcanzada, una key rechazada, una cuota
// agotada y un endpoint equivocado eran EL MISMO MENSAJE.
//
// Eso hace indebuggeable lo único que hay que debuggear acá. Ahora cada intento
// deja una fila en `diag` con la API, el status y los primeros bytes del cuerpo
// —que es donde FMP pone su `Error Message`, a veces con HTTP 200— y el
// endpoint la publica.
//
// LA KEY NO SE JOURNALEA NUNCA, ni truncada: viaja en la query string, así que
// la URL que se guarda es la del path sin el `?apikey=`.
export async function fetchConstituents(index, { apiKey = process.env.FMP_API_KEY, timeoutMs = 20000, fetchImpl = fetch, diag = null } = {}) {
  const anota = (fila) => { if (Array.isArray(diag)) diag.push({ index, ...fila }); };
  if (!INDICES[index]) { anota({ api: null, ok: false, reason: 'index_desconocido' }); return null; }
  if (!apiKey) {
    anota({ api: null, ok: false, reason: 'sin_key', detail: 'process.env.FMP_API_KEY está vacía EN ESTE ENTORNO. Ojo: en Vercel una env var vive por entorno — que esté en Production no la pone en Preview.' });
    return null;
  }

  for (const api of FMP_APIS) {
    const path = api.paths[index];
    const url = `${api.base}/${path}`;
    try {
      const r = await fetchImpl(`${url}?apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(timeoutMs) });
      const texto = await r.text().catch(() => '');
      // Los primeros bytes SIEMPRE, salga bien o mal: es donde FMP explica el
      // rechazo, y lo hace tanto en un 403 como en un 200.
      const muestra = String(texto || '').slice(0, 200);

      if (!r.ok) { anota({ api: api.id, url, ok: false, status: r.status, reason: 'http_error', body_sample: muestra }); continue; }

      let j = null;
      try { j = JSON.parse(texto); } catch { anota({ api: api.id, url, ok: false, status: r.status, reason: 'json_invalido', body_sample: muestra }); continue; }

      if (!Array.isArray(j)) {
        // EL CASO QUE MÁS ENGAÑA: HTTP 200 y un objeto de error. Sin esto se
        // leía como "FMP no contestó" cuando FMP contestó, y contestó por qué.
        const msg = (j && (j['Error Message'] || j.error || j.message)) || null;
        anota({ api: api.id, url, ok: false, status: r.status, reason: msg ? 'fmp_error_message' : 'cuerpo_no_es_lista', fmp_message: msg, body_sample: muestra });
        continue;
      }

      const symbols = [...new Set(j.map((x) => clean(x && x.symbol)).filter((s) => s && VALID_TICKER.test(s)))].sort();
      // Una lista sospechosamente corta NO se acepta: un índice que devuelve 12
      // nombres es un error de la API o de la cuota, y guardarlo pisaría el
      // último bueno con basura. Es la diferencia entre degradar y corromper.
      if (symbols.length < MIN_SANE[index]) {
        anota({ api: api.id, url, ok: false, status: r.status, reason: 'lista_corta', recibidos: symbols.length, minimo: MIN_SANE[index],
          detail: `${symbols.length} nombres para ${index} no es el índice: es cuota agotada o un plan que no cubre este endpoint. Se RECHAZA en vez de pisar la lista buena.` });
        continue;
      }

      anota({ api: api.id, url, ok: true, status: r.status, recibidos: symbols.length });
      return { index, source: 'fmp', fmp_api: api.id, built_at: new Date().toISOString(), symbols };
    } catch (e) {
      const m = String((e && e.message) || e);
      anota({ api: api.id, url, ok: false, reason: /abort|timeout/i.test(m) ? 'timeout' : 'red', detail: m });
    }
  }
  return null;
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

// ── ESCALÓN 3: la lista del repo ─────────────────────────────────────
// SE IMPORTA, NO SE LEE DEL DISCO. Antes esto abría un .json con
// `new URL(..., import.meta.url)` y eso tumbó producción: sin package.json, un
// .js de /api no es un módulo ESM para el runtime de Vercel, el código se
// transpila a CommonJS, e `import.meta` es lo único de ESM que no tiene
// traducción a CJS. Reventaba al CARGAR el módulo —no al usar la función—, así
// que se llevaba puesto a todo el que lo importara. Ver el encabezado de
// data/universe/constituents.js.
export async function readStatic(index) {
  try {
    const j = (CONSTITUENTS || {})[index];
    if (!j) return null;
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
export async function resolveConstituents(index, { now = new Date(), force = false, deps = {}, diag = null } = {}) {
  const fromEtf = deps.fetchDesdeEtf || fetchDesdeEtf;
  const fromFmp = deps.fetchConstituents || fetchConstituents;
  const fromNeon = deps.readStored || readStored;
  const toNeon = deps.writeStored || writeStored;
  const fromRepo = deps.readStatic || readStatic;

  const stored = await fromNeon(index);
  if (stored && !force && !refreshDue(stored.built_at, now)) {
    return { ...stored, refreshed: false, stored: true, age_days: edad(stored.built_at, now) };
  }

  // ORDEN: tenencias del ETF (gratis, diarias) → FMP (solo si hay key de pago).
  let fresh = await fromEtf(index, { now, diag });
  if (!fresh && (process.env.FMP_API_KEY || (deps.fetchConstituents && deps.forzarFmp !== false))) {
    fresh = await fromFmp(index, { diag });
  }
  if (fresh) {
    const written = await toNeon(index, fresh);
    return { ...fresh, refreshed: true, stored: written, age_days: 0 };
  }

  // FMP no contestó (o no hay key, o devolvió una lista incoherente). Lo
  // guardado sirve IGUAL aunque esté vencido — y se dice cuánto.
  // El PORQUÉ del fallo, en la nota, no solo en un campo aparte: quien lee
  // `note` en una terminal tiene que ver la causa sin ir a buscarla.
  const porque = motivoFmp(diag, index);
  if (stored) {
    return { ...stored, refreshed: false, stored: true, stale: true, age_days: edad(stored.built_at, now), fmp_failed: porque,
      note: `FMP no sirvió (${porque}): se usa la lista guardada de hace ${edad(stored.built_at, now)} días. Un universo de la semana pasada es un sesgo declarado.` };
  }
  const estatico = await fromRepo(index);
  if (estatico) {
    return { ...estatico, refreshed: false, stored: false, stale: true, age_days: edad(estatico.built_at, now),
      note: 'Arranque en frío: sin FMP y sin nada guardado, se usa el JSON del repo.' };
  }
  // ── UN ÍNDICE OPCIONAL QUE NO CONTESTA NO ES UNA FALLA ─────────────
  // El Nasdaq 100 arranca sin URL verificada (Invesco devolvió HTML y no hay
  // otra probada). Que falte NO puede leerse igual que si faltara el S&P 500:
  // uno es una decisión tomada, el otro es el universo roto. Si se mezclan, el
  // día que de verdad se caiga el S&P 500 nadie lo va a notar entre el ruido.
  const esOpcional = !!(HOLDINGS_SOURCES[index] && HOLDINGS_SOURCES[index].opcional);
  if (esOpcional) {
    return { index, source: 'none', opcional: true, symbols: [], built_at: null, refreshed: false, stored: false,
      note: `El ${index} es OPCIONAL y hoy no se pudo bajar. No es un error: el universo sale con los índices obligatorios. Para activarlo, poné una URL de descarga directa del CSV en ARENA_HOLDINGS_URL_${String(index).toUpperCase()} — se toma sin deploy.` };
  }
  return { index, source: 'none', symbols: [], built_at: null, refreshed: false, stored: false, fmp_failed: porque,
    note: `Sin FMP (${porque}), sin lista guardada y con la lista del repo vacía. Los índices NO entran al universo de hoy — ver data/universe/README.md. Si el motivo dice algo distinto de "sin_key", la key SÍ está llegando y el problema es otro: mirá \`fmp_diagnostics\` en la respuesta del endpoint.` };
}

// Resume el diagnóstico en una frase. Si los dos intentos fallaron por lo
// mismo, se dice una vez; si fallaron distinto, se dicen los dos, porque un
// 403 en una API y un 200-con-error en la otra son pistas diferentes.
export function motivoFmp(diag, index) {
  const filas = (diag || []).filter((d) => d && d.index === index && !d.ok);
  if (!filas.length) return 'sin_intentos';
  const partes = filas.map((f) => {
    const pedazos = [f.api ? f.api : 'sin_api', f.reason];
    if (f.status) pedazos.push('HTTP ' + f.status);
    if (f.fmp_message) pedazos.push('"' + String(f.fmp_message).slice(0, 80) + '"');
    if (f.reason === 'lista_corta') pedazos.push(`${f.recibidos}<${f.minimo}`);
    return pedazos.filter(Boolean).join(' ');
  });
  return [...new Set(partes)].join(' · ');
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
  // El diagnóstico de FMP viaja compartido por los dos índices: cada intento
  // deja su fila y después se publica entero. Sin esto, "Sin FMP" era la única
  // salida posible para seis causas distintas.
  const fmpDiag = [];
  const [sp, nq, mv, ac, acTrades] = await Promise.all([
    resolveConstituents('sp500', { now, force, deps, diag: fmpDiag }),
    resolveConstituents('nasdaq100', { now, force, deps, diag: fmpDiag }),
    // ── DE DÓNDE SALEN LOS ~300 BRUTOS ────────────────────────────────
    // El tope del canal del día son 100 nombres, pero ahora ese tope se gasta
    // DESPUÉS del filtro de instrumento, y ahí está el problema de volumen: de
    // cada 3 nombres que devuelve el screener, ~2 son warrants, unidades,
    // rights o preferentes. Con 200 brutos quedaban ~65 acciones comunes y el
    // cupo de 100 no se llenaba nunca.
    //
    // `getMovers` clampea a 50 por lado (es el máximo del endpoint), así que
    // los movers no dan más de 100. El tercer canal —most-actives por NÚMERO DE
    // OPERACIONES, no por volumen— es un ranking DISTINTO del mismo endpoint:
    // trae nombres que el ranking por volumen no trae (mucha actividad
    // minorista en papeles chicos aparece por trades y no por volumen). Una
    // request más, ~100 nombres más.
    movers({ top: 50, creds }).catch((e) => { errors.movers = String((e && e.message) || e); return null; }),
    actives({ top: 100, by: 'volume', creds }).catch((e) => { errors.most_actives = String((e && e.message) || e); return null; }),
    actives({ top: 100, by: 'trades', creds }).catch((e) => { errors.most_actives_trades = String((e && e.message) || e); return null; }),
  ]);

  const spSet = new Set(sp.symbols);
  const nqSet = new Set(nq.symbols);
  const indexSyms = new Set([...sp.symbols, ...nq.symbols]);
  const delDia = [...new Set([
    ...((mv && mv.gainers) || []).map((m) => m.symbol),
    ...((mv && mv.losers) || []).map((m) => m.symbol),
    ...((ac && ac.most_actives) || []).map((m) => m.symbol),
    ...((acTrades && acTrades.most_actives) || []).map((m) => m.symbol),
  ].map(clean).filter((s) => s && VALID_TICKER.test(s)))];

  // ── EL FILTRO DE INSTRUMENTO, ANTES DE LA ADMISIÓN ─────────────────
  // EL REPORTE QUE LO ORIGINA: el canal del día entregó 100 candidatos y se
  // admitieron CERO. 69 salieron `data_unavailable` y eran warrants, rights,
  // preferentes y unidades — cosas que nunca tuvieron que llegar al filtro de
  // admisión, porque no son el universo del Arena.
  //
  // Que salieran por "faltan datos" es doblemente malo: no solo entraban, sino
  // que al rebotar se veían como una falla de COBERTURA (no pudimos resolver el
  // market cap) en vez de como lo que eran (no es una acción). Un rechazo con
  // el motivo equivocado manda a buscar el problema al lugar equivocado — y eso
  // fue exactamente lo que pasó: se sospechó de Finnhub cuando el problema
  // estaba en el universo de entrada.
  //
  // EL ORDEN IMPORTA Y ES EL PUNTO. Se filtra ANTES de gastar el tope de 100 y
  // antes de pedirle a Finnhub un market cap que un warrant no tiene. Antes el
  // tope se gastaba en instrumentos que iban a rebotar igual: 100 cupos para
  // ~30 acciones reales.
  //
  // El catálogo de Alpaca también sirve para los nombres de índice: las
  // tenencias de ETFs escriben las clases múltiples sin punto (BRKB) y Alpaca
  // con punto (BRK.B), y `normalizarTicker` lo resuelve preguntándole al
  // catálogo en vez de con una tabla de alias que se desactualiza.
  const catalogo = await (deps.cargarCatalogo || cargarCatalogo)({ creds, now, deps })
    .catch((e) => { errors.catalogo = String((e && e.message) || e); return { assets: null }; });

  const filtroDia = await (deps.filtrarComunes || filtrarComunes)(
    delDia.filter((s2) => !indexSyms.has(s2)), { creds, now, deps, catalogo },
  ).catch((e) => { errors.filtro_instrumento = String((e && e.message) || e); return { comunes: [], rechazados: [], diagnostics: {} }; });

  // El tope se gasta sobre los que YA se sabe que son acciones comunes.
  const nuevos = filtroDia.comunes.filter((s2) => !indexSyms.has(s2)).slice(0, moversMax);

  // Los de índice también se normalizan contra el catálogo (BRKB → BRK.B), pero
  // NO se filtran por instrumento: un constituyente del S&P 500 es una acción
  // por definición, y si el catálogo de Alpaca no lo tiene el problema es del
  // catálogo, no del nombre.
  const candidatos = [...indexSyms, ...nuevos];

  // ── ADMISIÓN ──
  // Los nombres de los ÍNDICES pasan igual por el filtro: un constituyente que
  // cayó bajo $5 o bajo $1B sigue en el índice hasta que el comité lo saque, y
  // el universo del Arena no hereda esa demora.
  //
  // ── POR QUÉ NO SE LLAMA A LA ADMISIÓN "A PELO" ───────────────────
  // `resolveAdmission` pide, POR NOMBRE, una serie de Yahoo (precio + volumen)
  // y un profile2 de Finnhub (market cap). Está bien dimensionado para lo que
  // tenía enfrente: su propio encabezado dice "~26 llamadas a Finnhub y ~8
  // series de Yahoo por corrida", porque nació para el buffet de ~100.
  //
  // El universo le pone ~600 delante, y la cuenta no cierra por dos lados:
  //   · 600 series de Yahoo, de a 4 en paralelo, no entran en 300s;
  //   · 600 profile2 contra el tier gratis de Finnhub (60/min) son DIEZ
  //     MINUTOS — y 429s desde el primer minuto.
  //
  // Se resuelve llenando `known` ANTES de llamar: `resolveAdmission` ya respeta
  // lo que se le da y no lo vuelve a pedir.
  //
  // PRECIO Y VOLUMEN → Alpaca por LOTES de 100: 600 nombres son 6 requests en
  // vez de 600. Mismo dato y misma disciplina point-in-time (velas cerradas).
  let precios = {};
  try {
    precios = await (deps.getPriceAndDollarVolume || getPriceAndDollarVolume)(candidatos, { creds, now });
  } catch (e) {
    errors.prices = String((e && e.message) || e);
  }

  // MARKET CAP → acá hay una DECISIÓN, no un truco.
  //
  // Un nombre del S&P 500 o del Nasdaq 100 cumple el piso de $1B POR
  // CONSTRUCCIÓN: los dos son índices de gran capitalización, y un miembro por
  // debajo de $1B sería un caso extremo a punto de ser removido. Pedirle a
  // Finnhub que confirme eso 600 veces es gastar diez minutos y el rate limit
  // entero para reconfirmar la definición del índice.
  //
  // Así que para los nombres de ÍNDICE el criterio se da por cumplido — y se
  // DECLARA nombre por nombre (`market_cap_assumed_by_index`) en vez de fingir
  // que se midió. Es una suposición, no un dato, y el journal tiene que poder
  // distinguirlas.
  //
  // LO QUE NO SE ASUME: el precio y el volumen se miden de verdad para TODOS.
  // Ésa es la parte que de verdad cambia entre un constituyente sano y uno que
  // se cayó, y es la demora del comité que el Arena no hereda.
  //
  // Y los nombres DEL DÍA no entran en la suposición: son ≤100, no tienen
  // ninguna garantía de tamaño, y son justo por donde entró DDDX. Ésos pagan su
  // profile2, que a ≤100 sí cabe en el tier gratis.
  const known = {};
  for (const sym of candidatos) {
    const p = precios[sym] || {};
    known[sym] = {
      ...(Number.isFinite(p.price) ? { price: p.price } : {}),
      ...(Number.isFinite(p.dollarVolume) ? { dollarVolume: p.dollarVolume } : {}),
      ...(indexSyms.has(sym) ? { marketCap: rules.min_market_cap_usd } : {}),
    };
  }

  // El diagnóstico de Finnhub, por la misma razón que el de FMP: "0 admitidos"
  // tiene que poder distinguirse entre "Finnhub está caído", "nos pasamos de la
  // cuota" y "los nombres de verdad no llegan al piso".
  const finnhubDiag = [];
  let admissionData = {};
  try {
    admissionData = await admit(candidatos, { finnhubKey, now, known, diag: finnhubDiag });
  } catch (e) {
    errors.admission = String((e && e.message) || e);
  }
  const resumenFinnhub = finnhubDiag.reduce((acc, d) => {
    const k = d.ok ? 'ok' : (d.reason || 'desconocido');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const aplicado = Object.keys(admissionData).length > 0;
  const rechazados = [];
  const admitidos = [];
  for (const sym of candidatos) {
    if (!aplicado) { admitidos.push(sym); continue; }
    const v = isAdmissible({ symbol: sym, ...(admissionData[sym] || {}) }, rules);
    if (v.ok) admitidos.push(sym);
    else rechazados.push({ symbol: sym, reason: v.reason, ...(v.missing ? { missing: v.missing } : {}) });
  }

  // ── RANGO DE 52 SEMANAS del universo admitido ──────────────────
  // Se computa ACÁ, en el cron pre-apertura, y no en la corrida: son ~600
  // símbolos × 52 barras semanales, o sea 6 llamadas de datos que la corrida
  // del PM no puede pagar tres veces al día. Y no hace falta que las pague: el
  // máximo y el mínimo de 52 semanas salen de barras CERRADAS, así que son un
  // hecho del día — el tablero los lee y los compara contra el precio vivo.
  let fiftyTwo = {};
  if (admitidos.length) {
    try { fiftyTwo = await (deps.getFiftyTwoWeek || getFiftyTwoWeek)(admitidos, { creds, now }); }
    catch (e) { errors.fifty_two_week = String((e && e.message) || e); }
  }

  // De dónde salió el universo, en una palabra, para el journal.
  // LA FUENTE SE CALCULA SOLO SOBRE LOS ÍNDICES OBLIGATORIOS. Con el Nasdaq 100
  // opcional, incluirlo acá haría que TODOS los días salieran `partial` — y
  // `partial` dejaría de significar "algo se rompió" para significar "es
  // martes". Una bandera que está siempre encendida no es una bandera.
  const obligatorios = [sp, nq].filter((x) => !x.opcional);
  const fuentes = obligatorios.map((x) => x.source);
  const source = indexSyms.size === 0
    ? (admitidos.length ? 'movers_only' : 'empty')
    : (fuentes.includes('none') ? 'partial'
      : (fuentes.every((f) => f === 'etf') ? 'etf'
        : (fuentes.every((f) => f === 'fmp') ? 'fmp'
          : (fuentes.includes('static') ? 'static' : 'neon'))));

  return {
    built_at: now.toISOString(),
    market_day: marketDay(now),
    universe_source: source,
    symbols: admitidos.sort(),
    from_index: admitidos.filter((s) => indexSyms.has(s)),
    from_day: admitidos.filter((s) => !indexSyms.has(s)),
    // { SYMBOL: {high_52w, low_52w, last, pct_from_high, pct_from_low} }. Es el
    // insumo de los breakouts del tablero, precomputado una vez por día.
    fifty_two_week: fiftyTwo,
    fifty_two_week_count: Object.keys(fiftyTwo).length,
    indices: {
      // `persisted` es la pregunta operativa: ¿esta lista sobrevive al próximo
      // deploy sin que nadie la commitee? Si es false y la fuente es 'fmp', la
      // escritura a Neon falló y mañana se vuelve a pedir la misma lista.
      sp500: { source: sp.source, opcional: !!sp.opcional, built_at: sp.built_at, count: sp.symbols.length, age_days: sp.age_days ?? null, stale: !!sp.stale, persisted: sp.stored !== false, refreshed: !!sp.refreshed, etf: sp.etf || null, fmp_api: sp.fmp_api || null, fmp_failed: sp.fmp_failed || null, note: sp.note || null },
      nasdaq100: { source: nq.source, opcional: !!nq.opcional, built_at: nq.built_at, count: nq.symbols.length, age_days: nq.age_days ?? null, stale: !!nq.stale, persisted: nq.stored !== false, refreshed: !!nq.refreshed, etf: nq.etf || null, fmp_api: nq.fmp_api || null, fmp_failed: nq.fmp_failed || null, note: nq.note || null },
      // CUÁNTO APORTA CADA UNO QUE EL OTRO NO. La mayoría de los miembros del
      // Nasdaq 100 también están en el S&P 500, así que "nos falta el 100" no
      // significa "nos faltan 100 nombres". Este número dice exactamente
      // cuántos, para que la decisión de ir a buscar la URL de QQQ se tome con
      // un dato en vez de con una intuición.
      solo_en: {
        sp500: sp.symbols.filter((x) => !nqSet.has(x)).length,
        nasdaq100: nq.symbols.filter((x) => !spSet.has(x)).length,
        en_ambos: sp.symbols.filter((x) => nqSet.has(x)).length,
      },
    },
    // Qué se descartó por NO SER UNA ACCIÓN, separado de lo que se descartó por
    // criterio de admisión. Son dos preguntas distintas y antes daban la misma
    // respuesta.
    instrumento: filtroDia.diagnostics || null,
    instrumento_rechazados: (filtroDia.rechazados || []).slice(0, 50),
    counts: {
      indices: indexSyms.size,
      del_dia_brutos: delDia.length,
      del_dia_comunes: (filtroDia.comunes || []).length,
      del_dia_no_comunes: (filtroDia.rechazados || []).length,
      del_dia_nuevos: nuevos.length,
      candidatos: candidatos.length,
      admitidos: admitidos.length,
    },
    admission: {
      applied: aplicado, rules, rejected_count: rechazados.length,
      // Cuántos market caps se MIDIERON y cuántos se dieron por cumplidos por
      // pertenecer a un índice de gran capitalización. Es una suposición
      // declarada, no un dato — y el conteo la deja auditable.
      market_cap_assumed_by_index: candidatos.filter((s2) => indexSyms.has(s2)).length,
      market_cap_measured: candidatos.filter((s2) => !indexSyms.has(s2)).length,
      market_cap_note: 'Un miembro del S&P 500 / Nasdaq 100 cumple el piso de $1B por construcción del índice, así que ese criterio se da por cumplido en vez de pedirlo 600 veces. El PRECIO y el VOLUMEN se miden de verdad para TODOS: un constituyente que cayó bajo $5 sigue en el índice hasta que el comité lo saque, y esa demora el Arena no la hereda.',
      // Cómo le fue a Finnhub, en una línea. Un `rate_limit` o `rate_budget`
      // alto significa que el problema es NUESTRO (la cuota), no de los
      // nombres — y eso cambia por completo dónde buscar.
      finnhub: {
        ...resumenFinnhub,
        llamadas: finnhubDiag.length,
        note: (resumenFinnhub.rate_limit || resumenFinnhub.rate_budget)
          ? 'Hay nombres que NO se pudieron consultar por la cuota de Finnhub. Eso NO es "el nombre no tiene datos": es un límite nuestro. Subí ARENA_FINNHUB_CALL_BUDGET solo si el plan lo aguanta, o bajá el tope del canal del día.'
          : (resumenFinnhub.sin_key ? 'FINNHUB_API_KEY no está en este entorno: ningún market cap se pudo medir.' : null),
      },
      prices_resolved: Object.keys(precios).length,
      prices_missing: candidatos.filter((s2) => !precios[s2]).length,
      // La lista entera pesa; se journalea acotada y con el conteo real al lado.
      rejected: rechazados.slice(0, 50),
      data_unavailable: rechazados.filter((r) => r.reason === 'data_unavailable').length,
    },
    errors,
    // CADA intento contra FMP, con su status y los primeros bytes del cuerpo.
    // Es lo que convierte "Sin FMP" en algo que se puede arreglar: dice si la
    // key llegó, si la rechazaron, cuál de las dos APIs contestó y qué dijo.
    // La key NUNCA aparece acá: la URL se guarda sin el `?apikey=`.
    // Cada intento contra CUALQUIER fuente de constituyentes: primero las
    // tenencias del ETF, después FMP si hay key. Se llama así y no
    // `fmp_diagnostics` porque FMP dejó de ser la fuente y el nombre viejo
    // mandaría a mirar el lugar equivocado.
    constituents_diagnostics: fmpDiag,
    // La pregunta más barata de todas, y la que no se podía contestar: ¿la
    // env var llegó a ESTE entorno? Solo el booleano — el valor jamás.
    fmp_key_present: !!process.env.FMP_API_KEY,
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
