// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-mcap-cache.js — el market cap, persistido en Neon.
//
// EL PROBLEMA (visto el 2026-09-18: 40 de 50 llamadas ok, 10 nombres sin
// market cap por cuota): la caché de admisión es un `Map` del PROCESO. En
// Vercel cada cold start arranca vacío, así que el mismo nombre se vuelve a
// pedir a Finnhub una y otra vez EL MISMO DÍA, y el tier gratis corta a 60/min.
// Los nombres que quedaban afuera salían como `rate_budget`: descartados por un
// límite NUESTRO, no por una propiedad del nombre.
//
// SUBIR EL PRESUPUESTO NO ERA LA SOLUCIÓN. El techo real es el de Finnhub: a
// 60/min lo que hoy sale como `rate_budget` saldría como 429 — el mismo hueco
// con otra etiqueta. Lo que sobraba eran las llamadas REPETIDAS.
//
// ── POR QUÉ EL MARKET CAP SÍ SE PUEDE CACHEAR Y EL PRECIO NO ─────────
// El market cap es una propiedad LENTA: entre dos corridas del mismo día no se
// movió, y entre dos días se movió lo que se movió el precio. El precio y el
// volumen NO se cachean acá — ésos se miden de verdad en cada corrida, porque
// son justo lo que cambia entre un constituyente sano y uno que se cayó.
//
// ── LA VENTANA DEPENDE DE QUÉ TAN CERCA ESTÁ DEL PISO ────────────────
// El criterio es "market cap ≥ $1B". Un nombre de $80.000M puede usar una foto
// de hace una semana: ninguna semana normal lo baja del piso. Uno de $1.100M
// está a un mal trimestre de cruzarlo, y ahí una foto vieja decide MAL — y la
// decisión es binaria (entra o no entra al universo).
//
// Así que la ventana no es una constante, es una función de la distancia al
// piso. Los nombres lejos se cachean una semana; los del borde, un día. Los
// del borde son POCOS, así que esto no devuelve el problema de cuota por la
// puerta de atrás: cachear lo que no cambia es gratis, y re-preguntar lo que
// decide es barato.
//
// TODO ACÁ TRAGA SUS ERRORES. Una caché que tumba el universo cuando Neon
// hipa es peor que no tener caché: el peor caso de un fallo de lectura es
// pedirle a Finnhub lo que ya sabíamos.
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './db.js';

// El piso de admisión vive en arena-admission.js; acá solo importa la RELACIÓN
// con él, así que se recibe como parámetro y el default lo repite explícito
// para no crear un import circular por una constante.
export const PISO_MCAP_DEFAULT = 1_000_000_000;

// Múltiplo del piso por encima del cual un nombre se considera "lejos".
export const MULTIPLO_LEJOS = 2;

export const TTL_DIAS_LEJOS = (() => {
  const n = Number(process.env.ARENA_MCAP_TTL_DIAS);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();
export const TTL_DIAS_BORDE = (() => {
  const n = Number(process.env.ARENA_MCAP_TTL_DIAS_BORDE);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

// Cuántos días vale esta foto. Un cap por DEBAJO del piso también es de borde:
// un nombre rechazado puede recuperarse y no queremos que la caché lo condene
// una semana entera.
export function ttlDiasPara(marketCap, piso = PISO_MCAP_DEFAULT) {
  const m = Number(marketCap);
  if (!Number.isFinite(m) || m <= 0) return 0;          // sin dato no se cachea
  return m >= piso * MULTIPLO_LEJOS ? TTL_DIAS_LEJOS : TTL_DIAS_BORDE;
}

// ¿Sigue vigente esta fila? Pura: se prueba sin DB ni reloj real.
export function vigente(fila, { now = new Date(), piso = PISO_MCAP_DEFAULT } = {}) {
  if (!fila || fila.market_cap == null || !fila.fetched_at) return false;
  const cap = Number(fila.market_cap);
  const ttl = ttlDiasPara(cap, piso);
  if (ttl <= 0) return false;
  const edadMs = now.getTime() - new Date(fila.fetched_at).getTime();
  if (!Number.isFinite(edadMs) || edadMs < 0) return false;   // reloj raro → no se confía
  return edadMs <= ttl * 86400000;
}

const up = (s) => String(s || '').trim().toUpperCase();

// Lee las fotos VIGENTES de un lote. Devuelve { SYMBOL: marketCap } solo con
// las que siguen valiendo — una fila vencida no viaja, para que el llamador no
// tenga que volver a decidir lo mismo.
export async function leerMarketCaps(symbols = [], { now = new Date(), piso = PISO_MCAP_DEFAULT } = {}) {
  const wanted = [...new Set((symbols || []).map(up).filter(Boolean))];
  if (!wanted.length) return {};
  try {
    await ensureSchema();
    const filas = await sql(
      `select symbol, market_cap, fetched_at from arena_market_cap where symbol = any($1::text[])`,
      [wanted],
    );
    const out = {};
    for (const f of filas || []) {
      if (vigente(f, { now, piso })) out[up(f.symbol)] = Number(f.market_cap);
    }
    return out;
  } catch (e) {
    // El peor caso de no poder leer es pedirle a Finnhub lo que ya sabíamos.
    return {};
  }
}

// Guarda las fotos nuevas. `caps` es { SYMBOL: marketCap }; los null/0 se
// ignoran (no se cachea "no se pudo": eso hay que reintentarlo).
export async function guardarMarketCaps(caps = {}, { now = new Date(), source = 'finnhub' } = {}) {
  const filas = Object.entries(caps || {})
    .map(([sym, cap]) => [up(sym), Number(cap)])
    .filter(([sym, cap]) => sym && Number.isFinite(cap) && cap > 0);
  if (!filas.length) return 0;
  try {
    await ensureSchema();
    // Un solo INSERT con unnest en vez de N: 100 round-trips a Neon desde una
    // lambda cuestan más que la llamada a Finnhub que se está ahorrando.
    await sql(
      `insert into arena_market_cap (symbol, market_cap, fetched_at, source)
       select * from unnest($1::text[], $2::numeric[], $3::timestamptz[], $4::text[])
       on conflict (symbol) do update
         set market_cap = excluded.market_cap,
             fetched_at = excluded.fetched_at,
             source     = excluded.source`,
      [filas.map((f) => f[0]), filas.map((f) => f[1]),
       filas.map(() => now.toISOString()), filas.map(() => source)],
    );
    return filas.length;
  } catch (e) {
    return 0;
  }
}

// El par que `resolveAdmission` recibe inyectado. Que sea un objeto y no dos
// imports sueltos es lo que mantiene a arena-admission.js SIN tocar la DB:
// se prueba entero sin Neon, como hasta ahora.
export function cachePersistente({ now = new Date(), piso = PISO_MCAP_DEFAULT } = {}) {
  return {
    leer: (symbols) => leerMarketCaps(symbols, { now, piso }),
    guardar: (caps) => guardarMarketCaps(caps, { now }),
  };
}
