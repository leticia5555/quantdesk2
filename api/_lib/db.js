// ═══════════════════════════════════════════════════════════════
// api/_lib/db.js — SQL sobre HTTP contra Neon (Vercel Postgres).
//
// Primera base de datos del proyecto. Sin driver npm: el repo entero habla
// HTTP con fetch y aquí igual — se usa el protocolo SQL-over-HTTP del proxy
// de Neon (el mismo que usa @neondatabase/serverless en modo http, verificado
// contra su código fuente):
//
//   POST https://api.<region-host>/sql       (primer label del host → 'api.')
//   headers: Neon-Connection-String: <postgres://...>
//            Neon-Raw-Text-Output: true      (valores como texto crudo)
//            Neon-Array-Mode: true           (filas como arrays + fields)
//   body:    {"query":"...", "params":[...]}          (una consulta)
//            {"queries":[{query,params},...]}          (batch transaccional)
//   200 →    {command, rowCount, fields:[{name,dataTypeID}], rows:[[...]]}
//            (batch: {results:[...]})
//
// Si algún día esto se queda corto, cambiar a @neondatabase/serverless es
// trivial: este archivo es la única frontera con la DB.
//
// ENV VARS: DATABASE_URL (connection string de Neon, postgres://...)
// ═══════════════════════════════════════════════════════════════

// Coerción por OID de Postgres: Raw-Text-Output manda todo como texto.
const OID_NUM = new Set([20, 21, 23, 26, 700, 701, 1700]); // ints, floats, numeric
const OID_BOOL = 16;
const OID_JSON = new Set([114, 3802]); // json, jsonb

function coerce(value, oid) {
  if (value === null) return null;
  if (OID_NUM.has(oid)) return Number(value);
  if (oid === OID_BOOL) return value === 't' || value === 'true';
  if (OID_JSON.has(oid)) { try { return JSON.parse(value); } catch (e) { return value; } }
  return value;
}

function rowsToObjects(result) {
  const fields = result.fields || [];
  return (result.rows || []).map((row) =>
    Object.fromEntries(fields.map((f, i) => [f.name, coerce(row[i], f.dataTypeID)])));
}

// postgres://user:pass@ep-xxx.region.aws.neon.tech/db → https://api.region.aws.neon.tech/sql
function sqlEndpoint(connectionString) {
  const host = new URL(connectionString.replace(/^postgres(ql)?:/, 'https:')).hostname;
  return 'https://' + host.replace(/^[^.]+\./, 'api.') + '/sql';
}

function connString() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('Falta DATABASE_URL (connection string de Neon) en las env vars.');
  return cs;
}

async function neonFetch(body) {
  const cs = connString();
  const r = await fetch(sqlEndpoint(cs), {
    method: 'POST',
    headers: {
      'Neon-Connection-String': cs,
      'Neon-Raw-Text-Output': 'true',
      'Neon-Array-Mode': 'true',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error('Neon: ' + ((data && (data.message || data.error)) || `HTTP ${r.status}`));
  }
  return data;
}

// Una consulta: sql('select * from agents where user_id = $1', [uid]) → [{...}]
async function sql(query, params = []) {
  return rowsToObjects(await neonFetch({ query, params }));
}

// Varias consultas en UNA transacción (el proxy de Neon las envuelve).
async function sqlBatch(queries) {
  const data = await neonFetch({ queries: queries.map(([query, params]) => ({ query, params: params || [] })) });
  return (data.results || []).map(rowsToObjects);
}

// ─────────────────── Schema (idempotente) ───────────────────
// Se asegura on-demand y se cachea por instancia de lambda: la primera
// request de una instancia paga un round-trip extra, las demás no.

const SCHEMA = [
  `create table if not exists users (
     id text primary key,
     email text,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists edges (
     id text primary key,
     user_id text not null references users(id),
     edge_schema_version int not null default 1,
     engine text not null,
     config jsonb not null,
     verdict text,
     metrics jsonb,
     verdict_history jsonb,
     source text,
     notes text,
     created_at timestamptz,
     validated_at timestamptz
   )`,
  `create table if not exists agents (
     id text primary key,
     user_id text not null references users(id),
     name text not null,
     status text not null default 'alive',
     died_at timestamptz,
     capital_start numeric not null default 10000,
     cash numeric not null default 10000,
     equity numeric not null default 10000,
     equity_peak numeric not null default 10000,
     last_run_date date,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists agent_edges (
     agent_id text not null references agents(id) on delete cascade,
     edge_id text not null references edges(id),
     primary key (agent_id, edge_id)
   )`,
  `create table if not exists positions (
     id text primary key,
     agent_id text not null references agents(id) on delete cascade,
     edge_id text,
     symbol text not null,
     direction text not null,
     legs jsonb,
     qty numeric not null,
     entry_price numeric not null,
     entry_date date not null,
     stop_price numeric,
     notional numeric not null,
     status text not null default 'open',
     exit_price numeric,
     exit_date date,
     exit_reason text,
     pnl numeric
   )`,
  `create table if not exists equity_history (
     agent_id text not null references agents(id) on delete cascade,
     date date not null,
     equity numeric not null,
     primary key (agent_id, date)
   )`,
  `create table if not exists arena_journal (
     id text primary key,
     run_date date not null,
     phase text not null,
     status text not null,
     prompt_version text,
     prompt_hash text,
     model text,
     plan text,
     llm_response text,
     actions jsonb,
     account jsonb,
     error text,
     created_at timestamptz not null default now()
   )`,
];

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await sqlBatch(SCHEMA.map((q) => [q, []]));
  schemaReady = true;
}

export { sql, sqlBatch, ensureSchema, sqlEndpoint, rowsToObjects, coerce };
