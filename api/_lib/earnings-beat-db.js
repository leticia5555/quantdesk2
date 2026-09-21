// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-beat-db.js — capa de datos de la cosecha (Fase 1).
//
// Una tabla: pm_earnings_markets, un renglón por mercado de earnings de
// Polymarket. La PK (market_id) hace el upsert idempotente.
// Ver docs/earnings-beat-scope.md → "FASE 1 — Cosecha".
//
// DOS DECISIONES QUE VIVEN ACÁ, Y POR QUÉ:
//
//   1. **El filtro v1 se aplica ANTES de insertar, no después.** Lo que entra
//      a la tabla ya está filtrado, y el motivo queda guardado (`filtro_motivo`)
//      para poder auditarlo sin re-cosechar. Filtrar en tiempo de análisis
//      significaría que cada consumidor futuro tiene que acordarse de filtrar
//      igual — y el día que uno se olvide, los mercados de mención vuelven a
//      contar como beat/miss.
//
//   2. **Un upsert NUNCA pisa un dato bueno con uno peor.** Es la parte
//      delicada de "idempotente": correr el cron dos veces no puede degradar
//      la tabla. Un mercado que ya resolvió no vuelve a `outcome = null`
//      porque una corrida lo haya visto abierto en cache, y un precio válido
//      a T-24h no lo pisa un `sin_ticks` de un reintento con el CLOB caído.
//      Las reglas están en `debeReemplazarPrecio` / `mejorOutcome`, que son
//      puras y testeadas.
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './db.js';

const SCHEMA = [
  `create table if not exists pm_earnings_markets (
     market_id        text primary key,
     slug             text,
     question         text,
     symbol           text,
     symbol_via       text,            -- 'ticker' | 'alias' | 'symbol_map'
     camino           text,            -- 'simbolo' | 'busqueda' | 'tags' | 'cluster'
     filtro_motivo    text not null,   -- siempre 'ok' en la tabla; se guarda para auditar
     creado           timestamptz,     -- createdAt del mercado (ancla del emparejamiento)
     report_date      date,            -- reported_date de pead_earnings al cruzar
     resolved_date    date,            -- fecha de resolución del mercado
     consensus_pm     numeric,         -- el consenso que Polymarket DECLARA
     outcome          text,            -- 'yes' | 'no' | null (abierto)
     abierto          boolean not null default false,
     yes_token_id     text,
     yes_price_t24h   numeric,
     yes_price_ts     timestamptz,     -- CUÁNDO fue ese tick: sin esto el precio no es auditable
     yes_price_estado text,            -- valido | rancio | sin_ticks | sin_ticks_antes | error | sin_token
     volume           numeric,
     raw              jsonb,           -- el mercado crudo: el esquema de Gamma cambia
     ingested_at      timestamptz not null default now(),
     updated_at       timestamptz not null default now()
   )`,
  `create index if not exists pm_earnings_markets_symbol_idx
     on pm_earnings_markets (symbol, report_date)`,
  `create index if not exists pm_earnings_markets_abierto_idx
     on pm_earnings_markets (abierto) where abierto`,
];

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await sqlBatch(SCHEMA.map((q) => [q, []]));
  schemaReady = true;
}

// ─────────────────── reglas puras del upsert ───────────────────

// Orden de calidad de un precio a T-24h. Un upsert solo reemplaza hacia
// arriba: correr el cron de nuevo con el CLOB caído no puede borrar un precio
// que ya teníamos bueno.
const CALIDAD_PRECIO = { valido: 4, rancio: 3, sin_ticks_antes: 2, sin_ticks: 1, sin_precio: 1, error: 0, sin_token: 0 };

function debeReemplazarPrecio(estadoViejo, estadoNuevo) {
  if (!estadoNuevo) return false;                 // nada nuevo que escribir
  if (!estadoViejo) return true;                  // no había nada
  return (CALIDAD_PRECIO[estadoNuevo] ?? 0) > (CALIDAD_PRECIO[estadoViejo] ?? 0);
}

// Un mercado resuelto no vuelve a abierto. La resolución es un hecho; verlo
// abierto otra vez solo puede ser cache o un error de lectura.
function mejorOutcome(viejo, nuevo) {
  if (viejo && !nuevo) return viejo;
  return nuevo || viejo || null;
}

// Mercado clasificado (del descubrimiento) → fila de la tabla. Puro.
function preparaFila(m, { raw = null, precio = null } = {}) {
  const yes = precio || {};
  return {
    market_id: m.id ? String(m.id) : null,
    slug: m.slug || null,
    question: m.pregunta || null,
    symbol: m.symbol || null,
    symbol_via: m.symbol_via || null,
    camino: m.via || null,
    filtro_motivo: 'ok',
    creado: m.creado || null,
    report_date: m.cruce ? m.cruce.reported_date : null,
    resolved_date: m.fecha_resolucion || null,
    consensus_pm: m.consenso_pm ?? null,
    // 'yes'/'no' en minúsculas: la tabla no hereda el casing de Polymarket.
    outcome: m.outcome ? String(m.outcome).toLowerCase() : null,
    // ABIERTO = todavía sin outcome. Se guardan igual: resuelven después y el
    // cron del día siguiente los completa (por eso el upsert no pisa hacia
    // abajo). Un dataset que solo mira resueltos nace con sesgo de
    // supervivencia y además obliga a re-descubrir lo que ya vimos.
    abierto: !m.outcome,
    yes_token_id: m.token_yes || null,
    yes_price_t24h: yes.precio ?? null,
    yes_price_ts: yes.ts || null,
    yes_price_estado: yes.estado || null,
    volume: m.volumen ?? null,
    raw: raw ? JSON.stringify(raw) : null,
  };
}

// ─────────────────── escritura ───────────────────

// Upsert idempotente por market_id. El ON CONFLICT aplica las dos reglas de
// arriba en SQL para que valgan aunque dos corridas se pisen.
async function upsertMercados(filas) {
  const validas = (filas || []).filter((f) => f && f.market_id);
  if (!validas.length) return { insertados: 0, actualizados: 0 };

  const cols = ['market_id', 'slug', 'question', 'symbol', 'symbol_via', 'camino', 'filtro_motivo',
    'creado', 'report_date', 'resolved_date', 'consensus_pm', 'outcome', 'abierto',
    'yes_token_id', 'yes_price_t24h', 'yes_price_ts', 'yes_price_estado', 'volume', 'raw'];

  let n = 0;
  const values = [];
  const params = [];
  for (const f of validas) {
    const ph = cols.map(() => `$${++n}`);
    // raw va a jsonb; el resto se deja que Postgres lo castee por la columna.
    ph[cols.indexOf('raw')] = `$${n}::jsonb`;
    values.push(`(${ph.join(', ')})`);
    for (const c of cols) params.push(f[c] ?? null);
  }

  const rows = await sql(
    `insert into pm_earnings_markets (${cols.join(', ')})
     values ${values.join(', ')}
     on conflict (market_id) do update set
       slug = excluded.slug,
       question = excluded.question,
       symbol = coalesce(excluded.symbol, pm_earnings_markets.symbol),
       symbol_via = coalesce(excluded.symbol_via, pm_earnings_markets.symbol_via),
       camino = coalesce(pm_earnings_markets.camino, excluded.camino),
       creado = coalesce(excluded.creado, pm_earnings_markets.creado),
       report_date = coalesce(excluded.report_date, pm_earnings_markets.report_date),
       resolved_date = coalesce(excluded.resolved_date, pm_earnings_markets.resolved_date),
       consensus_pm = coalesce(excluded.consensus_pm, pm_earnings_markets.consensus_pm),
       -- un mercado resuelto NO vuelve a abierto
       outcome = coalesce(pm_earnings_markets.outcome, excluded.outcome),
       abierto = (coalesce(pm_earnings_markets.outcome, excluded.outcome) is null),
       yes_token_id = coalesce(excluded.yes_token_id, pm_earnings_markets.yes_token_id),
       -- el precio solo se reemplaza HACIA ARRIBA en calidad
       yes_price_t24h = case when ${calidadSql('excluded.yes_price_estado')} > ${calidadSql('pm_earnings_markets.yes_price_estado')}
                             then excluded.yes_price_t24h else pm_earnings_markets.yes_price_t24h end,
       yes_price_ts = case when ${calidadSql('excluded.yes_price_estado')} > ${calidadSql('pm_earnings_markets.yes_price_estado')}
                           then excluded.yes_price_ts else pm_earnings_markets.yes_price_ts end,
       yes_price_estado = case when ${calidadSql('excluded.yes_price_estado')} > ${calidadSql('pm_earnings_markets.yes_price_estado')}
                               then excluded.yes_price_estado else pm_earnings_markets.yes_price_estado end,
       volume = coalesce(excluded.volume, pm_earnings_markets.volume),
       raw = coalesce(excluded.raw, pm_earnings_markets.raw),
       updated_at = now()
     returning (xmax = 0) as insertado`,
    params
  );
  const insertados = rows.filter((r) => r.insertado === true || r.insertado === 't').length;
  return { insertados, actualizados: rows.length - insertados };
}

// La escala de calidad, en SQL. Se genera desde la MISMA tabla que usa
// debeReemplazarPrecio() para que no puedan divergir.
function calidadSql(expr) {
  const casos = Object.entries(CALIDAD_PRECIO).map(([k, v]) => `when '${k}' then ${v}`).join(' ');
  return `(case ${expr} ${casos} else -1 end)`;
}

// ─────────────────── lectura ───────────────────

async function statsMercados() {
  const [total] = await sql(
    `select count(*)::int as n,
            count(*) filter (where abierto)::int as abiertos,
            count(*) filter (where outcome is not null)::int as resueltos,
            count(*) filter (where yes_price_estado = 'valido')::int as con_precio_valido,
            count(*) filter (where report_date is not null)::int as cruzados,
            count(distinct symbol)::int as simbolos,
            to_char(max(updated_at), 'YYYY-MM-DD HH24:MI') as ultima_actualizacion
       from pm_earnings_markets`
  );
  return total || { n: 0 };
}

// Mercados que hay que volver a mirar: los abiertos (pueden haber resuelto) y
// los que no tienen precio bueno a T-24h todavía.
async function mercadosPendientes(limite = 100) {
  return sql(
    `select market_id, slug, question, symbol, yes_token_id,
            to_char(resolved_date, 'YYYY-MM-DD') as resolved_date,
            yes_price_estado, abierto
       from pm_earnings_markets
      where abierto = true
         or yes_price_estado is null
         or yes_price_estado not in ('valido', 'rancio')
      order by resolved_date desc nulls last
      limit $1`,
    [limite]
  );
}

export {
  ensureSchema, upsertMercados, statsMercados, mercadosPendientes,
  preparaFila, debeReemplazarPrecio, mejorOutcome, CALIDAD_PRECIO, SCHEMA,
};
