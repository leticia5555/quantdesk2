// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-buffet-cache.js — caché POR DÍA de los canales lentos.
//
// EL PROBLEMA, medido: el canal `insiders` del buffet le pega a
// /api/stock-tracker?cat=insider, que baja el feed Atom de Form 4 de SEC EDGAR
// y después inspecciona hasta 60 XML sueltos de sec.gov/Archives. Con la caché
// EN MEMORIA fría —o sea, en cada lambda nueva, que es casi siempre— son ~61
// requests a un servidor que throttlea a propósito. El techo de 12s no
// alcanzaba nunca, y subirlo a 30s fue un torniquete: el canal seguía costando
// 30 segundos de wall-clock, y seguía cayéndose cuando EDGAR andaba lento.
//
// LA CURA es la que el comentario de arena-run ya proponía: no volver a pedirlo.
// Los insider buys de Form 4 son un hecho del DÍA — el mismo contenido para la
// corrida de las 14:00 y para la de las 20:00. Traerlo una vez y guardarlo en
// Neon convierte ~61 requests a EDGAR por lambda en UNA lectura de tabla.
//
// POR QUÉ NEON Y NO LA CACHÉ EN MEMORIA: la memoria de una lambda muere con la
// lambda. Con el vigilante corriendo cada 5 minutos y los siete agentes en
// paralelo, "la caché en memoria" es un proceso que casi nunca encuentra la
// entrada caliente. Neon la comparte entre lambdas, entre agentes y entre
// corridas del día.
//
// DOS COSAS QUE ESTA CACHÉ NO HACE, a propósito:
//   · NO sirve datos rancios en silencio. Si la entrada es de otro día, no
//     cuenta como hit: se vuelve a pedir. El `fetched_at` viaja con el dato
//     para que el journal pueda decir de cuándo es.
//   · NO convierte un canal caído en un canal vivo. Si EDGAR falla y no hay
//     entrada de hoy, el canal sale como no disponible, igual que antes. Una
//     caché que tapa una caída es peor que la caída.
//
// La clave es (canal, fecha ET). Fecha del ESTE, no UTC: el buffet es del día
// de mercado, y a las 22:40 UTC —la hora de la nocturna— UTC ya cambió de día
// pero el mercado no.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

const SCHEMA = `create table if not exists arena_buffet_cache (
   channel    text not null,
   day        date not null,
   payload    jsonb,
   fetched_at timestamptz not null default now(),
   primary key (channel, day)
 )`;

let ready = false;
async function ensure() {
  if (ready) return;
  await sql(SCHEMA);
  ready = true;
}

// Fecha de mercado ('YYYY-MM-DD') en horario del Este.
export function marketDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Lee la entrada de HOY. null si no existe, si es de otro día, o si la DB falla
// — en los tres casos el caller tiene que ir a buscar el dato, que es lo
// correcto: esta caché acelera, no sustituye.
export async function readDayCache(channel, now = new Date()) {
  try {
    await ensure();
    const rows = await sql(
      `select payload, fetched_at from arena_buffet_cache where channel = $1 and day = $2::date`,
      [channel, marketDay(now)],
    );
    if (!rows.length || rows[0].payload == null) return null;
    return { payload: rows[0].payload, fetched_at: rows[0].fetched_at };
  } catch { return null; }
}

// Guarda la entrada de HOY. Best-effort: que la escritura falle NO puede tumbar
// una corrida — el dato ya se tiene, solo se pierde el ahorro de la próxima.
export async function writeDayCache(channel, payload, now = new Date()) {
  try {
    await ensure();
    await sql(
      `insert into arena_buffet_cache (channel, day, payload, fetched_at)
       values ($1, $2::date, $3, now())
       on conflict (channel, day) do update set payload = excluded.payload, fetched_at = now()`,
      [channel, marketDay(now), JSON.stringify(payload)],
    );
    return true;
  } catch { return false; }
}

// ── El envoltorio: "traelo, pero solo una vez por día" ───────────────
// Devuelve { data, source, fetched_at, error }:
//   source 'cache' — entrada de hoy, cero llamadas a terceros.
//   source 'fetch' — se pidió de verdad y se guardó para el resto del día.
//   source 'none'  — falló y no había entrada de hoy. `data` es null y el
//                    canal sale como no disponible, con su error.
//
// `fetcher` puede lanzar: acá se atrapa y se devuelve como `error`, porque un
// canal caído es un resultado normal del buffet, no una excepción.
export async function cachedDayFetch(channel, fetcher, { now = new Date(), force = false } = {}) {
  if (!force) {
    const hit = await readDayCache(channel, now);
    if (hit) return { data: hit.payload, source: 'cache', fetched_at: hit.fetched_at, error: null };
  }
  try {
    const data = await fetcher();
    // Un fetch que devuelve null/undefined NO se cachea: guardar "no había
    // nada" durante todo el día convertiría un hipo de 30 segundos en un canal
    // muerto hasta la medianoche.
    if (data != null) await writeDayCache(channel, data, now);
    return { data, source: 'fetch', fetched_at: new Date().toISOString(), error: null };
  } catch (e) {
    return { data: null, source: 'none', fetched_at: null, error: String((e && e.message) || e) };
  }
}
