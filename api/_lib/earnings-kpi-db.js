// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-kpi-db.js — capa de datos de la cosecha de mercados de
// RANGOS de KPI (paralela a earnings-beat-db.js, que NO se toca).
//
// Dos tablas:
//   · pm_kpi_markets — una fila por CAJÓN (mercado hijo de un evento). PK
//     market_id = conditionId de Polymarket.
//   · pm_kpi_prices  — el HISTORIAL de precios del Yes por cajón. Guardar solo
//     el último precio obligaría a adivinar después cuál era a T-24h; con el
//     historial, T-24h se reconstruye cuando haga falta, con la regla que sea.
//
// La migración vive también en docs/sql/earnings-kpi.sql (mismo texto: el test
// lo compara), para correrla a mano en Neon si se prefiere a ensureSchema().
//
// REGLAS DEL UPSERT (mismo espíritu que pm_earnings_markets):
//   · price_yes_first_seen se escribe UNA vez y no se pisa nunca.
//   · un cajón resuelto no vuelve a abierto; winning_range no se borra.
//   · reported_value NO lo toca el upsert: se captura a mano o por otra vía, y
//     una corrida del cron no puede borrar lo que alguien cargó.
//   · price_yes_t24h se recalcula DESDE pm_kpi_prices, nunca desde Gamma.
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './db.js';

// Horas antes del cierre del precio "T-24h", y tolerancia para marcarlo
// rancio. Los mismos números que beat/miss (CRITERIOS.horas_antes_precio /
// tolerancia_rancio_horas), escritos acá para no importar criterios congelados
// de OTRO experimento hacia este.
const HORAS_T24H = 24;
const TOLERANCIA_RANCIO_H = 12;

const SCHEMA = [
  `create table if not exists pm_kpi_markets (
     market_id               text primary key,   -- conditionId
     gamma_market_id         text,
     event_slug              text not null,
     event_title             text,
     question                text,
     range_label             text,               -- la etiqueta tal cual ('22% to 24%')
     range_low               numeric,            -- null en '<x'
     range_high              numeric,            -- null en 'x+'
     range_unit              text,               -- '%' | '$' | 'bps' | 'pp' | null (absoluto)
     range_kind              text,               -- 'cajon' (excluyentes) | 'umbral' (escalera "above __")
     symbol                  text,
     symbol_via              text,               -- 'ticker' | 'alias'
     kpi_name                text,
     end_date                timestamptz,
     created_at_pm           timestamptz,
     yes_token_id            text,
     price_yes_first_seen    numeric,
     price_yes_first_seen_at timestamptz,
     price_yes_latest        numeric,
     price_yes_t24h          numeric,
     price_yes_t24h_ts       timestamptz,        -- CUÁNDO fue ese precio: sin esto no es auditable
     price_yes_t24h_estado   text,               -- 'valido' | 'rancio'
     volume                  numeric,
     liquidity               numeric,
     last_snapshot_at        timestamptz,
     clob_backfill_at        timestamptz,        -- última vez que se bajó /prices-history
     resolved                boolean not null default false,
     winning_range           boolean,
     reported_value          numeric,            -- a mano / por API; el cron no lo toca
     semilla                 text,               -- frase que lo descubrió primero
     raw                     jsonb,
     ingested_at             timestamptz not null default now(),
     updated_at              timestamptz not null default now()
   )`,
  `create index if not exists pm_kpi_markets_event_idx on pm_kpi_markets (event_slug)`,
  `create index if not exists pm_kpi_markets_abiertos_idx on pm_kpi_markets (end_date) where not resolved`,
  `create table if not exists pm_kpi_prices (
     market_id  text not null,
     ts         timestamptz not null,
     price_yes  numeric not null,
     fuente     text not null,                   -- 'gamma' (snapshot diario) | 'clob' (prices-history)
     primary key (market_id, ts, fuente)
   )`,
];

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await sqlBatch(SCHEMA.map((q) => [q, []]));
  schemaReady = true;
}

// ─────────────────── escritura ───────────────────

const COLS = ['market_id', 'gamma_market_id', 'event_slug', 'event_title', 'question', 'range_label',
  'range_low', 'range_high', 'range_unit', 'range_kind', 'symbol', 'symbol_via', 'kpi_name', 'end_date', 'created_at_pm',
  'yes_token_id', 'price_yes_first_seen', 'price_yes_first_seen_at', 'price_yes_latest', 'volume', 'liquidity',
  'last_snapshot_at', 'resolved', 'winning_range', 'semilla', 'raw'];

// Fila del descubrimiento → valores de la tabla. Puro. `ahora` es el ISO del
// snapshot: viaja junto al precio, igual que en beat/miss.
function preparaFilaKpi(f, ahora) {
  const conPrecio = f.price_yes_latest !== null && f.price_yes_latest !== undefined;
  return {
    market_id: f.market_id,
    gamma_market_id: f.gamma_market_id || null,
    event_slug: f.event_slug,
    event_title: f.event_title || null,
    question: f.question || null,
    range_label: f.range_label || null,
    range_low: f.range_low ?? null,
    range_high: f.range_high ?? null,
    range_unit: f.range_unit || null,
    range_kind: f.range_kind || null,
    symbol: f.symbol || null,
    symbol_via: f.symbol_via || null,
    kpi_name: f.kpi_name || null,
    end_date: f.end_date || null,
    created_at_pm: f.created_at_pm || null,
    yes_token_id: f.yes_token_id || null,
    price_yes_first_seen: conPrecio ? f.price_yes_latest : null,
    price_yes_first_seen_at: conPrecio ? ahora : null,
    price_yes_latest: conPrecio ? f.price_yes_latest : null,
    volume: f.volume ?? null,
    liquidity: f.liquidity ?? null,
    last_snapshot_at: conPrecio ? ahora : null,
    resolved: !!f.resolved,
    winning_range: f.winning_range ?? null,
    semilla: f.semilla || null,
    raw: f._raw ? JSON.stringify(f._raw) : null,
  };
}

// Construye el INSERT … ON CONFLICT. Separado de la ejecución para que el test
// lo corra contra un Postgres real.
function sqlUpsertMercados(filas) {
  let n = 0;
  const values = [];
  const params = [];
  for (const f of filas) {
    const ph = COLS.map(() => `$${++n}`);
    ph[COLS.indexOf('raw')] += '::jsonb';
    values.push(`(${ph.join(', ')})`);
    for (const c of COLS) params.push(f[c] ?? null);
  }
  const query = `insert into pm_kpi_markets (${COLS.join(', ')})
     values ${values.join(', ')}
     on conflict (market_id) do update set
       gamma_market_id = coalesce(excluded.gamma_market_id, pm_kpi_markets.gamma_market_id),
       event_slug = excluded.event_slug,
       event_title = coalesce(excluded.event_title, pm_kpi_markets.event_title),
       question = coalesce(excluded.question, pm_kpi_markets.question),
       range_label = coalesce(excluded.range_label, pm_kpi_markets.range_label),
       range_low = excluded.range_low,
       range_high = excluded.range_high,
       range_unit = excluded.range_unit,
       range_kind = coalesce(excluded.range_kind, pm_kpi_markets.range_kind),
       symbol = coalesce(excluded.symbol, pm_kpi_markets.symbol),
       symbol_via = coalesce(excluded.symbol_via, pm_kpi_markets.symbol_via),
       kpi_name = coalesce(excluded.kpi_name, pm_kpi_markets.kpi_name),
       end_date = coalesce(excluded.end_date, pm_kpi_markets.end_date),
       created_at_pm = coalesce(pm_kpi_markets.created_at_pm, excluded.created_at_pm),
       yes_token_id = coalesce(excluded.yes_token_id, pm_kpi_markets.yes_token_id),
       -- el primer precio visto se escribe UNA vez
       price_yes_first_seen = coalesce(pm_kpi_markets.price_yes_first_seen, excluded.price_yes_first_seen),
       price_yes_first_seen_at = case when pm_kpi_markets.price_yes_first_seen is null
                                      then excluded.price_yes_first_seen_at
                                      else pm_kpi_markets.price_yes_first_seen_at end,
       price_yes_latest = coalesce(excluded.price_yes_latest, pm_kpi_markets.price_yes_latest),
       last_snapshot_at = coalesce(excluded.last_snapshot_at, pm_kpi_markets.last_snapshot_at),
       volume = coalesce(excluded.volume, pm_kpi_markets.volume),
       liquidity = coalesce(excluded.liquidity, pm_kpi_markets.liquidity),
       -- un cajón resuelto no vuelve a abierto, y su ganador no se borra
       resolved = pm_kpi_markets.resolved or excluded.resolved,
       winning_range = coalesce(pm_kpi_markets.winning_range, excluded.winning_range),
       semilla = coalesce(pm_kpi_markets.semilla, excluded.semilla),
       raw = coalesce(excluded.raw, pm_kpi_markets.raw),
       updated_at = now()
     returning (xmax = 0) as insertado`;
  return { query, params };
}

async function upsertMercadosKpi(filas) {
  const validas = (filas || []).filter((f) => f && f.market_id && f.event_slug);
  let insertados = 0;
  let total = 0;
  // De a 100: 26 columnas × 100 = 2600 parámetros, holgado bajo el tope.
  for (let i = 0; i < validas.length; i += 100) {
    const { query, params } = sqlUpsertMercados(validas.slice(i, i + 100));
    const rows = await sql(query, params);
    total += rows.length;
    insertados += rows.filter((r) => r.insertado === true || r.insertado === 't').length;
  }
  return { insertados, actualizados: total - insertados };
}

// Puntos de precio → pm_kpi_prices. Idempotente por (market_id, ts, fuente).
function sqlInsertPrecios(puntos) {
  let n = 0;
  const values = [];
  const params = [];
  for (const p of puntos) {
    values.push(`($${++n}, $${++n}, $${++n}, $${++n})`);
    params.push(p.market_id, p.ts, p.price_yes, p.fuente);
  }
  return {
    query: `insert into pm_kpi_prices (market_id, ts, price_yes, fuente) values ${values.join(', ')}
            on conflict (market_id, ts, fuente) do nothing`,
    params,
  };
}

async function insertaPrecios(puntos) {
  const validos = (puntos || []).filter((p) => p && p.market_id && p.ts && p.price_yes !== null && p.price_yes !== undefined
    && Number(p.price_yes) >= 0 && Number(p.price_yes) <= 1);
  for (let i = 0; i < validos.length; i += 500) {
    const { query, params } = sqlInsertPrecios(validos.slice(i, i + 500));
    await sql(query, params);
  }
  return { puntos: validos.length };
}

// Snapshot diario: un punto 'gamma' por cajón ABIERTO con precio. Los
// resueltos no: su 0/1 post-resolución no es un precio de mercado. Puro.
function puntosDeSnapshot(filas, ahora) {
  return (filas || [])
    .filter((f) => !f.resolved && f.price_yes_latest !== null && f.price_yes_latest !== undefined)
    .map((f) => ({ market_id: f.market_id, ts: ahora, price_yes: f.price_yes_latest, fuente: 'gamma' }));
}

// T-24h: el ÚLTIMO punto del historial con ts ≤ end_date − 24h, de cualquier
// fuente. Solo para cajones cuyo T-24h YA pasó: antes de eso, "el último
// anterior a T-24h" todavía puede cambiar y fijarlo sería adelantarse. Se
// recalcula cada corrida (es determinista sobre el historial), así un
// backfill posterior con un punto más cercano mejora el valor.
const SQL_RECALCULA_T24H = `
  update pm_kpi_markets k
     set price_yes_t24h = p.price_yes,
         price_yes_t24h_ts = p.ts,
         price_yes_t24h_estado = case when p.ts < k.end_date - interval '${HORAS_T24H + TOLERANCIA_RANCIO_H} hours'
                                      then 'rancio' else 'valido' end,
         updated_at = now()
    from (
      select distinct on (pr.market_id) pr.market_id, pr.price_yes, pr.ts
        from pm_kpi_prices pr
        join pm_kpi_markets m on m.market_id = pr.market_id
       where m.end_date is not null
         and m.end_date - interval '${HORAS_T24H} hours' <= now()
         and pr.ts <= m.end_date - interval '${HORAS_T24H} hours'
       order by pr.market_id, pr.ts desc
    ) p
   where k.market_id = p.market_id
     and (k.price_yes_t24h_ts is distinct from p.ts or k.price_yes_t24h is distinct from p.price_yes)
  returning k.market_id`;

async function recalculaT24h() {
  const rows = await sql(SQL_RECALCULA_T24H);
  return { actualizados: rows.length };
}

// ─────────────────── lectura ───────────────────

// Slugs de eventos con algún cajón sin resolver: se re-hidratan cada corrida
// aunque la búsqueda ya no los devuelva (así se captura la resolución).
async function eventosAbiertos() {
  const rows = await sql(`select distinct event_slug from pm_kpi_markets where not resolved`);
  return rows.map((r) => r.event_slug);
}

// Cajones que necesitan historial del CLOB:
//   · nunca se bajó (backfill inicial de lo que ya está abierto), o
//   · su T-24h ya pasó, no hay T-24h, y el último backfill fue ANTES de T-24h
//     (el historial bajado entonces no podía cubrir la ventana).
async function pendientesClob(limite = 200) {
  return sql(
    `select market_id, yes_token_id, to_char(end_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as end_date,
            to_char(created_at_pm at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at_pm
       from pm_kpi_markets
      where yes_token_id is not null
        and (clob_backfill_at is null
             or (price_yes_t24h is null
                 and end_date - interval '${HORAS_T24H} hours' <= now()
                 and clob_backfill_at < end_date - interval '${HORAS_T24H} hours'))
      order by end_date asc nulls last
      limit $1`,
    [limite]
  );
}

async function marcaBackfill(ids) {
  if (!ids.length) return;
  await sql(`update pm_kpi_markets set clob_backfill_at = now() where market_id = any($1::text[])`, [ids]);
}

async function statsKpi() {
  const [s] = await sql(
    `select count(*)::int as rangos,
            count(distinct event_slug)::int as eventos,
            count(*) filter (where not resolved)::int as abiertos,
            count(*) filter (where resolved)::int as resueltos,
            count(*) filter (where price_yes_latest is not null)::int as con_precio,
            count(*) filter (where price_yes_t24h is not null)::int as con_t24h,
            count(*) filter (where reported_value is not null)::int as con_reported_value,
            (select count(*)::int from pm_kpi_prices) as puntos_historial,
            to_char(max(updated_at), 'YYYY-MM-DD HH24:MI') as ultima_actualizacion
       from pm_kpi_markets`
  );
  return s || { rangos: 0 };
}

// Para ?job=kpi&format=md: cajones de eventos con algo abierto.
async function leeAbiertos() {
  return sql(
    `select event_slug, event_title, symbol, kpi_name, range_label, range_low, range_high, range_unit, range_kind,
            to_char(end_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as end_date,
            price_yes_first_seen, price_yes_latest, price_yes_t24h, volume, liquidity, resolved
       from pm_kpi_markets
      where event_slug in (select event_slug from pm_kpi_markets where not resolved)
      order by end_date asc nulls last, event_slug, range_low asc nulls first`
  );
}

export {
  SCHEMA, COLS, HORAS_T24H, TOLERANCIA_RANCIO_H, SQL_RECALCULA_T24H,
  ensureSchema, preparaFilaKpi, sqlUpsertMercados, upsertMercadosKpi, sqlInsertPrecios, insertaPrecios,
  puntosDeSnapshot, recalculaT24h, eventosAbiertos, pendientesClob, marcaBackfill, statsKpi, leeAbiertos,
};
