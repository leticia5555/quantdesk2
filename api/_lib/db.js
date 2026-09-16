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
     context jsonb,
     created_at timestamptz not null default now()
   )`,
  // Migración idempotente: la tabla ya desplegada en prod se creó sin
  // `context` (diagnóstico del buffet: unavailable + error real por endpoint).
  `alter table arena_journal add column if not exists context jsonb`,
  // LIGA multi-modelo: `agent_id` distingue a cada competidor (Claude/OpenAI/
  // control/…) en la MISMA tabla — columna, NO tabla-por-agente (una tabla por
  // agente forkearía el schema y duplicaría cada query del reconcile y del
  // post-mortem). El historial del Agente #6 (filas sin agent_id) se preserva
  // como `claude`, el insignia. Índice para el ranking/post-mortem por agente.
  `alter table arena_journal add column if not exists agent_id text`,
  `update arena_journal set agent_id = 'claude' where agent_id is null`,
  `create index if not exists arena_journal_agent_idx on arena_journal (agent_id, phase, created_at desc)`,
  // Estado del agente. El circuit breaker a −20% DETIENE al agente (análogo del
  // DEATH -20% de la flota: mata, no vacía y ya). La reactivación es MANUAL
  // (endpoint ?action=resume) — el −20% es el resultado del experimento,
  // revivirlo solo borraría el hallazgo. `resumed_at` re-basa el pico del
  // breaker: tras revivir, el drawdown se mide desde el equity de ese momento,
  // no desde el pico viejo (si no, re-dispararía el broadcut al instante).
  //
  // LIGA: el halt es POR AGENTE. La tabla nació con una sola fila (id=1). La
  // migración la re-llavea por `agent_id`: se agrega la columna, se marca la fila
  // legada como `claude` (el Agente #6), se suelta la PK vieja de `id` (queda
  // vestigial) y se hace único `agent_id`. Así cada agente tiene su propia fila
  // de halt sin colisionar en id=1. Idempotente (IF EXISTS / IF NOT EXISTS).
  `create table if not exists arena_state (
     id int primary key default 1,
     halted boolean not null default false,
     halted_at timestamptz,
     halted_reason text,
     resumed_at timestamptz
   )`,
  `alter table arena_state add column if not exists agent_id text`,
  `update arena_state set agent_id = 'claude' where agent_id is null`,
  `alter table arena_state drop constraint if exists arena_state_pkey`,
  `create unique index if not exists arena_state_agent_uidx on arena_state (agent_id)`,
  // ── BASELINE DE TEMPORADA (RESET, 2026-09-15) ──────────────────────
  // El corte por temporada (SEASON_CUTOFF en arena-run.js) arregló que el PM
  // recordara una temporada muerta, pero la fecha venía de una CONSTANTE del
  // registry: un reset a mitad de temporada —aplanar las siete cuentas y
  // arrancar de nuevo el mismo T2— no tenía dónde anotarse, y la memoria del
  // PM y el pico del breaker seguían mirando al arranque declarado.
  //
  // Estas tres columnas son ese corte, por agente y con fecha real:
  //   · baseline_at     — el instante del aplanado. TODA la memoria que se le
  //                       reinyecta al PM (plan anterior, fills, compromisos) y
  //                       el pico del breaker se cortan acá. Es el mismo
  //                       mecanismo que `resumed_at`, pero para un reset
  //                       deliberado en vez de una reanimación tras un halt.
  //   · baseline_equity — el equity DECLARADO de arranque ($100k). Es el
  //                       denominador del return de la temporada y el PISO del
  //                       pico del breaker. Que sea una columna y no una
  //                       constante es lo que permite corregirlo sin deploy.
  //   · baseline_id     — el id de la fila del journal que anunció el reset.
  //                       Sin él, "¿de qué reset viene este baseline?" se
  //                       contesta cruzando timestamps a ojo.
  `alter table arena_state add column if not exists baseline_at timestamptz`,
  `alter table arena_state add column if not exists baseline_equity numeric`,
  `alter table arena_state add column if not exists baseline_id text`,
  // ── FRENO DE MANO DEL VIGILANTE, en DB ─────────────────────────────
  // `ARENA_WATCH_ENABLED` es una env var: apagarla exige un redeploy, y un
  // redeploy en medio de un aplanado de siete cuentas es exactamente el momento
  // en que no se quiere tocar el deploy. El reset necesita pausar el vigilante
  // por unos minutos y volver a prenderlo SOLO, sin intervención.
  //
  // Tabla clave/valor a propósito: es el único flag dinámico que existe hoy y
  // una tabla genérica evita una migración por cada flag futuro. El valor
  // guarda un INSTANTE de vencimiento, no un booleano: una pausa que se olvida
  // de despausarse deja al Arena ciego indefinidamente, y un vencimiento hace
  // que el peor caso sea "el vigilante vuelve solo en N minutos".
  `create table if not exists arena_flags (
     key text primary key,
     value jsonb,
     note text,
     updated_at timestamptz not null default now()
   )`,
  // Calendario macro CURADO (decisión de producto: nada de scraping frágil).
  // Lety carga ~8 eventos/mes a mano vía el admin gated (/api/macro-events).
  // Los earnings de mega-caps NO viven aquí — se automatizan desde el
  // calendario de Finnhub (api/earnings.js ?mega=1). Esta tabla es solo lo
  // curado: Fed, CPI, jobs, PIB, subastas, discursos, lo que Lety decida.
  `create table if not exists macro_events (
     id text primary key,
     event_date date not null,
     title text not null,
     category text,
     importance text not null default 'med',
     note text,
     created_at timestamptz not null default now()
   )`,
  // Índice para la lectura pública (upcoming, ordenado por fecha).
  `create index if not exists macro_events_date_idx on macro_events (event_date)`,

  // ═══ VIGILANTE del Arena (cadencia por evento) ════════════════
  // Tres tablas chicas, todas de ESTADO del vigilante. El rastro narrativo
  // (qué decidió el agente al ser despertado) sigue viviendo donde siempre:
  // en `arena_journal`. Acá solo vive lo que el vigilante necesita para no
  // repetirse: qué disparó, cuándo despertó a quién y contra qué precio mide.
  //
  // 1. arena_watch — TODO disparador, haya despertado al agente o no. La
  //    condición #2 del reglamento de cadencia ("cada disparador se journalea con su
  //    razón aunque el agente decida no operar") se cumple aquí: `fired=false`
  //    + `skip_reason` deja auditable un disparo frenado por cooldown o tope.
  `create table if not exists arena_watch (
     id            bigserial primary key,
     run_date      date not null,
     agent_id      text not null,
     symbol        text not null,
     trigger_type  text not null,
     fired         boolean not null default false,
     skip_reason   text,
     detail        jsonb,
     fired_at      timestamptz not null default now()
   )`,
  `create index if not exists arena_watch_day_idx on arena_watch (run_date, agent_id)`,
  `create index if not exists arena_watch_symbol_idx on arena_watch (agent_id, symbol, fired_at desc)`,

  // 2. arena_watch_mark — el ANCLA del disparador de ±3%: el precio contra el
  //    que se mide "desde su último pronunciamiento". Se re-fija cada vez que
  //    el agente se pronuncia sobre el nombre, así el disparador se re-arma
  //    solo. Sin fila, el ancla es el cierre anterior (ver markPrice).
  `create table if not exists arena_watch_mark (
     agent_id   text not null,
     symbol     text not null,
     price      numeric not null,
     marked_at  timestamptz not null default now(),
     source     text,
     primary key (agent_id, symbol)
   )`,

  // 3. arena_watch_events / arena_watch_meta — cache de los eventos del día
  //    (earnings + 8-K). En la DB y no en memoria para que una lambda fría no
  //    re-escanee SEC; ver el encabezado de _lib/arena-watch-events.js.
  `create table if not exists arena_watch_events (
     run_date  date not null,
     symbol    text not null,
     kind      text not null,
     detail    jsonb,
     seen_at   timestamptz not null default now(),
     primary key (run_date, symbol, kind)
   )`,
  `create table if not exists arena_watch_meta (
     key        text primary key,
     value      jsonb,
     updated_at timestamptz not null default now()
   )`,

  // xbrl_reports — captura trimestral del XBRL de BMV (docs/xbrl-capture.md).
  // doc_id es UNIQUE: es lo que hace idempotente a /api/xbrl-capture?run=1.
  `create table if not exists xbrl_reports (
  id                bigserial primary key,
  clave             text        not null,
  bmv_id            text        not null,
  doc_id            text        not null unique,
  anio              int         not null,
  trimestre         int         not null check (trimestre between 1 and 4),
  fecha_publicacion timestamptz,
  fecha_captura     timestamptz not null default now(),
  zip_url           text,
  entry_point       text,
  raw_json          jsonb       not null,
  ingresos                          numeric,
  ingresos_tag                      text,
  ingresos_ventana                  text,
  ingresos_motivo                   text,
  utilidad_neta_atribuible          numeric,
  utilidad_neta_atribuible_tag      text,
  utilidad_neta_atribuible_ventana  text,
  utilidad_neta_atribuible_motivo   text,
  activos_totales                   numeric,
  activos_totales_tag               text,
  activos_totales_ventana           text,
  activos_totales_motivo            text,
  pasivos_totales                   numeric,
  pasivos_totales_tag               text,
  pasivos_totales_ventana           text,
  pasivos_totales_motivo            text,
  capital_contable                  numeric,
  capital_contable_tag              text,
  capital_contable_ventana          text,
  capital_contable_motivo           text,
  efectivo                          numeric,
  efectivo_tag                      text,
  efectivo_ventana                  text,
  efectivo_motivo                   text,
  deuda_corto                       numeric,
  deuda_corto_tag                   text,
  deuda_corto_ventana               text,
  deuda_corto_motivo                text,
  deuda_largo                       numeric,
  deuda_largo_tag                   text,
  deuda_largo_ventana               text,
  deuda_largo_motivo                text,
  acciones_circulacion              numeric,
  acciones_circulacion_tag          text,
  acciones_circulacion_ventana      text,
  acciones_circulacion_motivo       text,
  capital_controladora     numeric,
  participacion_no_control numeric,
  arrendamientos_corto     numeric,
  arrendamientos_largo     numeric,
  identidades      jsonb,
  identidades_ok   boolean,
  alertas          jsonb
)`,
  `create index if not exists xbrl_reports_clave_periodo_idx
     on xbrl_reports (clave, anio desc, trimestre desc)`,
  `create index if not exists xbrl_reports_publicacion_idx
     on xbrl_reports (fecha_publicacion desc)`,
];

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await sqlBatch(SCHEMA.map((q) => [q, []]));
  schemaReady = true;
}

export { sql, sqlBatch, ensureSchema, sqlEndpoint, rowsToObjects, coerce };
