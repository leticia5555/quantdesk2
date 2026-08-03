// ═══════════════════════════════════════════════════════════════════
// api/_lib/pead-db.js — capa de datos del backtest PEAD (Fase 1).
//
// Cosecha por goteo del historial de earnings (Alpha Vantage) + la hora
// del anuncio (SEC 8-K). Todo en Neon, sobre la frontera de _lib/db.js.
// Ver docs/pead-backtest-scope.md → "Plan de cosecha de datos (v0)".
//
// Tres tablas:
//   pead_earnings        — un renglón por evento. GUARDA TODA la historia
//                          que AV devuelva (sin recorte temporal); el recorte
//                          a ~3 años es del query de análisis, no de la ingesta.
//   pead_harvest_ledger  — qué símbolos ya bajamos (hace el goteo reanudable).
//   pead_event_hour      — BMO/AMC por evento (job SEC, independiente de AV).
//   pead_api_budget      — guard del presupuesto diario de AV (25/día).
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './db.js';

const PEAD_SCHEMA = [
  `create table if not exists pead_earnings (
     symbol             text not null,
     fiscal_date_ending date not null,
     reported_date      date not null,
     reported_eps       numeric,
     estimated_eps      numeric,
     surprise           numeric,
     surprise_pct       numeric,
     source             text not null default 'alphavantage',
     ingested_at        timestamptz not null default now(),
     primary key (symbol, reported_date)
   )`,
  `create table if not exists pead_harvest_ledger (
     symbol           text primary key,
     priority         int  not null default 100,
     status           text not null default 'pending',
     quarters_fetched int  not null default 0,
     attempts         int  not null default 0,
     last_attempt_at  timestamptz,
     error_msg        text
   )`,
  `create table if not exists pead_event_hour (
     symbol         text not null,
     reported_date  date not null,
     hour           text,           -- 'bmo' | 'amc' | 'dmh' | null
     source         text,           -- 'sec_8k' | 'gap_heuristic'
     accepted_at_et text,           -- timestamp de aceptación del 8-K (ET)
     accession      text,
     tagged_at      timestamptz not null default now(),
     primary key (symbol, reported_date)
   )`,
  `create table if not exists pead_api_budget (
     day   date primary key,
     calls int not null default 0
   )`,
];

let peadSchemaReady = false;
async function ensurePeadSchema() {
  if (peadSchemaReady) return;
  await sqlBatch(PEAD_SCHEMA.map((q) => [q, []]));
  peadSchemaReady = true;
}

// ─────────────────── Ledger ───────────────────

// Siembra idempotente: inserta símbolos que falten con su prioridad.
// No pisa el estado de los que ya existen (on conflict do nothing).
async function seedLedger(entries) {
  if (!entries || !entries.length) return 0;
  const values = entries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  const params = entries.flatMap((e) => [e.symbol, e.priority]);
  const rows = await sql(
    `insert into pead_harvest_ledger (symbol, priority) values ${values}
     on conflict (symbol) do nothing returning symbol`,
    params
  );
  return rows.length;
}

// Los próximos N símbolos pendientes, por prioridad (v0 primero).
async function pickPending(n) {
  if (n <= 0) return [];
  return sql(
    `select symbol, priority, attempts from pead_harvest_ledger
     where status = 'pending'
     order by priority asc, symbol asc
     limit $1`,
    [n]
  );
}

async function markLedger(symbol, patch) {
  const fields = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    params.push(v);
  }
  fields.push(`last_attempt_at = now()`);
  params.push(symbol);
  await sql(`update pead_harvest_ledger set ${fields.join(', ')} where symbol = $${i}`, params);
}

async function ledgerStats() {
  const rows = await sql(
    `select status, count(*)::int as n from pead_harvest_ledger group by status`
  );
  const out = { pending: 0, done: 0, error: 0, delisted: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ─────────────────── Earnings (upsert TODA la historia) ───────────────────

// events: [{fiscal_date_ending, reported_date, reported_eps, estimated_eps,
//           surprise, surprise_pct}]. Upsert por (symbol, reported_date).
// La PK de pead_earnings es (symbol, reported_date). Un solo INSERT ... ON
// CONFLICT DO UPDATE NO puede tocar la misma fila de conflicto dos veces —
// Postgres lo rechaza con "ON CONFLICT DO UPDATE command cannot affect row a
// second time" (→ el handler lo atrapa y responde 500). AV a veces devuelve dos
// trimestres con el MISMO reportedDate (restatements o filas duplicadas), así que
// colapsamos por reported_date ANTES de armar la sentencia, quedándonos con el
// fiscal_date_ending más reciente (el trimestre "real"; el otro suele ser un eco
// restado). Cross-invocación no importa: ON CONFLICT sí maneja duplicados entre
// sentencias distintas — el problema es solo intra-INSERT. JS puro y testeable.
function dedupeByReportedDate(events) {
  const byDate = new Map();
  for (const e of events || []) {
    const prev = byDate.get(e.reported_date);
    if (!prev || String(e.fiscal_date_ending) > String(prev.fiscal_date_ending)) {
      byDate.set(e.reported_date, e);
    }
  }
  return [...byDate.values()];
}

async function upsertEarnings(symbol, events) {
  if (!events || !events.length) return 0;
  const rows = dedupeByReportedDate(events);
  // $1 = symbol; cada evento aporta 6 columnas a partir de $2.
  const tuples = rows
    .map((_, i) => {
      const b = 2 + i * 6;
      return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    })
    .join(', ');
  const params = [
    symbol,
    ...rows.flatMap((e) => [
      e.fiscal_date_ending,
      e.reported_date,
      e.reported_eps,
      e.estimated_eps,
      e.surprise,
      e.surprise_pct,
    ]),
  ];
  await sql(
    `insert into pead_earnings
       (symbol, fiscal_date_ending, reported_date, reported_eps, estimated_eps, surprise, surprise_pct)
     values ${tuples}
     on conflict (symbol, reported_date) do update set
       fiscal_date_ending = excluded.fiscal_date_ending,
       reported_eps       = excluded.reported_eps,
       estimated_eps      = excluded.estimated_eps,
       surprise           = excluded.surprise,
       surprise_pct       = excluded.surprise_pct,
       ingested_at        = now()`,
    params
  );
  return rows.length;
}

// Eventos que aún no tienen hora etiquetada (para el job SEC).
async function eventsMissingHour(limit) {
  return sql(
    `select e.symbol, e.reported_date
       from pead_earnings e
       left join pead_event_hour h
         on h.symbol = e.symbol and h.reported_date = e.reported_date
      where h.symbol is null
      order by e.reported_date desc
      limit $1`,
    [limit]
  );
}

async function upsertEventHour(row) {
  await sql(
    `insert into pead_event_hour (symbol, reported_date, hour, source, accepted_at_et, accession)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (symbol, reported_date) do update set
       hour = excluded.hour, source = excluded.source,
       accepted_at_et = excluded.accepted_at_et, accession = excluded.accession,
       tagged_at = now()`,
    [row.symbol, row.reported_date, row.hour, row.source, row.accepted_at_et || null, row.accession || null]
  );
}

// ─────────────────── Presupuesto diario de AV ───────────────────

// Gasto de hoy (UTC). Robusto a cron doble-disparo / corridas manuales.
async function budgetUsed(day) {
  const rows = await sql(`select calls from pead_api_budget where day = $1`, [day]);
  return rows.length ? rows[0].calls : 0;
}

// Suma `n` llamadas al día (atómico vía upsert incremental).
async function budgetAdd(day, n) {
  const rows = await sql(
    `insert into pead_api_budget (day, calls) values ($1, $2)
     on conflict (day) do update set calls = pead_api_budget.calls + $2
     returning calls`,
    [day, n]
  );
  return rows.length ? rows[0].calls : n;
}

export {
  ensurePeadSchema,
  PEAD_SCHEMA,
  dedupeByReportedDate,
  seedLedger,
  pickPending,
  markLedger,
  ledgerStats,
  upsertEarnings,
  eventsMissingHour,
  upsertEventHour,
  budgetUsed,
  budgetAdd,
};
