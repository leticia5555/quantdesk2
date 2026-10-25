// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-beat-v2-db.js — las 4 tablas de earnings-beat v2.
//
// Migración = este SCHEMA_V2 (create if not exists, mismo patrón que
// earnings-beat-db.js / pead-db.js). El mismo DDL está en
// docs/sql/earnings-beat-v2.sql junto con las semillas; un test exige que no
// diverjan.
//
//   pm_earnings_v2_features — una fila por market_id de pm_earnings_markets.
//   pm_known_gaps           — brechas GAAP/ajustado CONOCIDAS, con URL.
//   pm_company_guidance     — guía de la empresa (trimestral o anual), con URL.
//   pm_v2_validation        — el set congelado de 22, con su resolución a mano
//                             para que el Brier no dependa de la API de
//                             Polymarket.
//
// NO toca pm_earnings_markets ni pead_earnings: solo las LEE.
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './db.js';
import { SCHEMA as SCHEMA_V1, CALIDAD_PRECIO } from './earnings-beat-db.js';

const SCHEMA_V2 = [
  `create table if not exists pm_earnings_v2_features (
     market_id              text primary key,
     symbol                 text,
     fecha                  date,
     quarter_end            date,
     metrica_barra          text,            -- 'GAAP' | 'NONGAAP'
     barra                  numeric,
     consenso_creacion      numeric,
     consenso_vigente       numeric,         -- AV estimatedEPS; PIT solo hacia adelante
     consenso_vigente_ts    timestamptz,     -- cuándo se capturó (nunca después de T-24h)
     sorpresa_mediana_8t    numeric,
     sorpresa_std_8t        numeric,
     n_8t                   int,
     beats_8t               int,
     sorpresa_metrica_match boolean,
     brecha_gaap_adj        numeric not null default 0,
     cargo_ambas_metricas   numeric not null default 0,
     guia_q_implicita       numeric,
     guia_q_min             numeric,
     guia_q_max             numeric,
     estimado_v2            numeric,
     margen_v2              numeric,
     prob_v2                numeric,
     std_fallback           boolean,
     prob_pm_t24            numeric,
     desacuerdo             numeric,
     fuera_universo         boolean not null default false,
     faltante               text,
     outcome                text,
     calculado_en           timestamptz not null default now()
   )`,
  `create table if not exists pm_known_gaps (
     symbol             text not null,
     quarter_end        date not null,
     concepto           text not null,       -- una fila por cargo; se suman
     brecha_por_accion  numeric not null check (brecha_por_accion >= 0),
     afecta             text not null default 'GAAP',  -- 'GAAP' | 'AMBAS'
     tipo               text not null,       -- merger_costs | legal_charge | ipr&d | mark_to_market | other
     fuente_url         text not null,
     publicado_en       date,                -- fecha del documento fuente
     verificada         boolean not null default false, -- alguien abrió el documento y vio el número
     nota               text,
     capturado_en       timestamptz not null default now(),
     primary key (symbol, quarter_end, concepto)
   )`,
  `create table if not exists pm_company_guidance (
     symbol               text not null,
     quarter_end          date not null,
     metrica              text not null,     -- 'GAAP' | 'NONGAAP'
     alcance              text not null default 'trimestre', -- 'trimestre' | 'anual'
     guia_min             numeric,
     guia_max             numeric,
     ytd_reportado        numeric,           -- solo alcance anual
     trimestres_restantes int,               -- solo alcance anual
     fuente_url           text not null,
     publicado_en         date,
     verificada           boolean not null default false,
     nota                 text,
     capturado_en         timestamptz not null default now(),
     primary key (symbol, quarter_end, metrica)
   )`,
  `create table if not exists pm_v2_validation (
     symbol           text not null,
     fecha_mercado    date not null,
     market_id        text,                  -- null si no está en pm_earnings_markets
     metrica_barra    text,
     barra            numeric,
     consenso_creacion numeric,
     prob_pm_t24      numeric,               -- a mano, solo si no está en pm_earnings_markets
     outcome          text,                  -- 'yes' | 'no' | null
     actual_eps       numeric,
     resuelto_en      date,
     fuente_url       text,
     nota             text,
     capturado_en     timestamptz not null default now(),
     primary key (symbol, fecha_mercado)
   )`,
  // ── v2.1 ──
  // El set de 22 queda como piloto: se etiqueta, no se borra.
  `alter table pm_v2_validation add column if not exists set text not null default 'piloto-oct26'`,
  // Historial para símbolos FUERA de pead_earnings. Alpha Vantage EARNINGS,
  // una llamada por símbolo. reported_date no estaba en el encargo y es
  // imprescindible: sin él no hay forma de cortar "solo trimestres reportados
  // ANTES del mercado" (cero look-ahead).
  `create table if not exists pm_v2_hist (
     symbol             text not null,
     fiscal_quarter_end date not null,
     reported_date      date,
     reported_eps       numeric,
     estimated_eps      numeric,
     surprise           numeric,
     fuente             text not null default 'alphavantage',
     capturado_en       timestamptz not null default now(),
     primary key (symbol, fiscal_quarter_end)
   )`,
  // Cosecha v2.1: MISMO esquema que pm_earnings_markets (se deriva de la DDL
  // de v1, no se copia a mano) + universo_pead. v1 no se toca.
  ...SCHEMA_V1.map((q) => q.replace(/pm_earnings_markets/g, 'pm_earnings_markets_v2')),
  `alter table pm_earnings_markets_v2 add column if not exists universo_pead boolean not null default false`,
  // prob_v2 de la tabla de features ES prob_A; prob_B va al lado.
  `alter table pm_earnings_v2_features add column if not exists estimado_b numeric`,
  `alter table pm_earnings_v2_features add column if not exists prob_b numeric`,
  // Cuándo se anunció el cargo por primera vez. Dato, no regla: la fila marca
  // si el mercado nació después, pero la brecha se aplica igual (ver
  // brechaConocida en earnings-beat-v2.js: el caso META).
  `alter table pm_known_gaps add column if not exists anunciado_en date`,
  // Snapshot diario de EARNINGS_CALENDAR (26-oct): de acá sale el consenso
  // vigente. Una fila por símbolo y trimestre y DÍA; la PK con `dia` hace que
  // correr el job dos veces el mismo día no duplique (se queda el primero).
  // Nunca se rellena hacia atrás: un día sin snapshot es un día sin dato.
  `create table if not exists pm_v2_consenso_snap (
     symbol             text not null,
     fiscal_date_ending date not null,
     report_date        date,
     estimate           numeric,
     capturado_en       timestamptz not null default now(),
     dia                date not null default current_date,
     primary key (symbol, fiscal_date_ending, dia)
   )`,
  `create index if not exists pm_v2_consenso_snap_symbol_idx on pm_v2_consenso_snap (symbol, capturado_en)`,
  `alter table pm_earnings_v2_features add column if not exists consenso_vigente_snap timestamptz`,
];

let listo = false;
async function ensureSchemaV2() {
  if (listo) return;
  await sqlBatch(SCHEMA_V2.map((q) => [q, []]));
  listo = true;
}

const COLS_FEATURES = [
  'market_id', 'symbol', 'fecha', 'quarter_end', 'metrica_barra', 'barra', 'consenso_creacion',
  'consenso_vigente', 'sorpresa_mediana_8t', 'sorpresa_std_8t', 'n_8t', 'beats_8t',
  'sorpresa_metrica_match', 'brecha_gaap_adj', 'cargo_ambas_metricas', 'guia_q_implicita', 'guia_q_min',
  'guia_q_max', 'estimado_v2', 'margen_v2', 'prob_v2', 'std_fallback', 'prob_pm_t24', 'desacuerdo',
  'fuera_universo', 'faltante', 'outcome', 'estimado_b', 'prob_b', 'consenso_vigente_snap',
];

// Upsert por market_id. consenso_vigente NO se escribe acá (lo escribe
// guardaVigente, con su timestamp): recalcular features no puede pisar una
// captura PIT con un null.
async function upsertFeatures(filas) {
  const validas = (filas || []).filter((f) => f && f.market_id);
  if (!validas.length) return 0;
  let n = 0;
  const values = [];
  const params = [];
  for (const f of validas) {
    values.push(`(${COLS_FEATURES.map(() => `$${++n}`).join(', ')})`);
    for (const c of COLS_FEATURES) params.push(f[c] ?? (c === 'brecha_gaap_adj' || c === 'cargo_ambas_metricas' ? 0 : c === 'fuera_universo' ? false : null));
  }
  // consenso_vigente ahora se recalcula de los snapshots (inmutables y
  // anteriores al T-24h), así que se puede reescribir: da siempre lo mismo.
  const upd = COLS_FEATURES.filter((c) => c !== 'market_id')
    .map((c) => `${c} = excluded.${c}`).join(', ');
  const rows = await sql(
    `insert into pm_earnings_v2_features (${COLS_FEATURES.join(', ')})
     values ${values.join(', ')}
     on conflict (market_id) do update set ${upd}, calculado_en = now()
     returning market_id`,
    params
  );
  return rows.length;
}


// ─────────────────── v2.1: historial AV ───────────────────

// events: salida de parseEarnings. Solo trimestres REPORTADOS (con
// reported_eps): el que viene sin reportar es el consenso vigente, otra cosa.
async function upsertHist(symbol, events) {
  const filas = (events || []).filter((e) => e && e.fiscal_date_ending && e.reported_eps !== null && e.reported_eps !== undefined);
  if (!filas.length) return 0;
  // Si AV ahora sí trae datos (un &forzar=1), el marcador de "sin datos" deja
  // de contar. Se marca superado en vez de borrarlo: queda el rastro, y la
  // regla del repo pide que todo DELETE de api/ pase por la allowlist.
  await sql(`update pm_v2_hist set fuente = 'sin_datos_av_superado' where symbol = $1 and fuente = 'sin_datos_av'`, [symbol]);
  let n = 0;
  const values = [];
  const params = [];
  for (const e of filas) {
    values.push(`($${++n}, $${++n}, $${++n}, $${++n}, $${++n}, $${++n})`);
    params.push(symbol, e.fiscal_date_ending, e.reported_date || null, e.reported_eps, e.estimated_eps ?? null, e.surprise ?? null);
  }
  const rows = await sql(
    `insert into pm_v2_hist (symbol, fiscal_quarter_end, reported_date, reported_eps, estimated_eps, surprise)
     values ${values.join(', ')}
     on conflict (symbol, fiscal_quarter_end) do update set
       reported_date = coalesce(excluded.reported_date, pm_v2_hist.reported_date),
       reported_eps = excluded.reported_eps,
       estimated_eps = coalesce(excluded.estimated_eps, pm_v2_hist.estimated_eps),
       surprise = coalesce(excluded.surprise, pm_v2_hist.surprise),
       capturado_en = now()
     returning symbol`,
    params
  );
  return rows.length;
}

// AV contestó `empty` para el símbolo (CFLT y EA: dos días seguidos, 4
// llamadas tiradas). Se deja un marcador en pm_v2_hist (fuente =
// 'sin_datos_av', trimestre centinela 1900-01-01, reported_date null: las
// vistas lo ignoran) y ?job=hist no lo vuelve a pedir, salvo &forzar=1.
async function marcaSinDatosAv(symbol) {
  await sql(
    `insert into pm_v2_hist (symbol, fiscal_quarter_end, fuente) values ($1, '1900-01-01', 'sin_datos_av')
     on conflict (symbol, fiscal_quarter_end) do update set fuente = 'sin_datos_av', capturado_en = now()`,
    [symbol]
  );
}

// ─────────────────── v2.1: cosecha ───────────────────

// Las mismas dos reglas del upsert de v1 (earnings-beat-db.js): un mercado
// resuelto no vuelve a abierto y el precio a T-24h solo se reemplaza HACIA
// ARRIBA en calidad. Se reescribe acá en vez de parametrizar el de v1 porque
// v1 no se toca; la escala de calidad sí se importa (CALIDAD_PRECIO), así que
// no pueden divergir.
const calidad = (expr) => `(case ${expr} ${Object.entries(CALIDAD_PRECIO).map(([k, v]) => `when '${k}' then ${v}`).join(' ')} else -1 end)`;
const COLS_V2 = ['market_id', 'slug', 'question', 'symbol', 'symbol_via', 'camino', 'filtro_motivo',
  'creado', 'report_date', 'resolved_date', 'consensus_pm', 'outcome', 'abierto',
  'yes_token_id', 'yes_price_t24h', 'yes_price_ts', 'yes_price_estado', 'volume', 'raw', 'universo_pead'];

async function upsertMercadosV2(filas) {
  const validas = (filas || []).filter((f) => f && f.market_id);
  if (!validas.length) return { insertados: 0, actualizados: 0 };
  let n = 0;
  const values = [];
  const params = [];
  for (const f of validas) {
    const ph = COLS_V2.map(() => `$${++n}`);
    ph[COLS_V2.indexOf('raw')] = `${ph[COLS_V2.indexOf('raw')]}::jsonb`;
    values.push(`(${ph.join(', ')})`);
    for (const c of COLS_V2) params.push(c === 'universo_pead' ? !!f[c] : f[c] ?? null);
  }
  const t = 'pm_earnings_markets_v2';
  const mejora = `${calidad('excluded.yes_price_estado')} > ${calidad(`${t}.yes_price_estado`)}`;
  const rows = await sql(
    `insert into ${t} (${COLS_V2.join(', ')})
     values ${values.join(', ')}
     on conflict (market_id) do update set
       slug = excluded.slug,
       question = excluded.question,
       symbol = coalesce(excluded.symbol, ${t}.symbol),
       symbol_via = coalesce(excluded.symbol_via, ${t}.symbol_via),
       camino = coalesce(${t}.camino, excluded.camino),
       creado = coalesce(excluded.creado, ${t}.creado),
       report_date = coalesce(excluded.report_date, ${t}.report_date),
       resolved_date = coalesce(excluded.resolved_date, ${t}.resolved_date),
       consensus_pm = coalesce(excluded.consensus_pm, ${t}.consensus_pm),
       outcome = coalesce(${t}.outcome, excluded.outcome),
       abierto = (coalesce(${t}.outcome, excluded.outcome) is null),
       yes_token_id = coalesce(excluded.yes_token_id, ${t}.yes_token_id),
       yes_price_t24h = case when ${mejora} then excluded.yes_price_t24h else ${t}.yes_price_t24h end,
       yes_price_ts = case when ${mejora} then excluded.yes_price_ts else ${t}.yes_price_ts end,
       yes_price_estado = case when ${mejora} then excluded.yes_price_estado else ${t}.yes_price_estado end,
       volume = coalesce(excluded.volume, ${t}.volume),
       raw = coalesce(excluded.raw, ${t}.raw),
       universo_pead = excluded.universo_pead,
       updated_at = now()
     returning (xmax = 0) as insertado`,
    params
  );
  const insertados = rows.filter((r) => r.insertado === true || r.insertado === 't').length;
  return { insertados, actualizados: rows.length - insertados };
}

// ─────────────────── snapshot de EARNINGS_CALENDAR ───────────────────

// filas: salida de parseCalendarioCsv. En lotes (≈4,300 filas × 4 parámetros).
// on conflict do nothing: el primer snapshot del día es EL snapshot del día.
async function guardaSnapshotConsenso(filas, { lote = 1000 } = {}) {
  const validas = (filas || []).filter((f) => f && f.symbol && f.fiscal_date_ending);
  let insertadas = 0;
  for (let i = 0; i < validas.length; i += lote) {
    const parte = validas.slice(i, i + lote);
    let n = 0;
    const values = [];
    const params = [];
    for (const f of parte) {
      values.push(`($${++n}, $${++n}, $${++n}, $${++n})`);
      params.push(f.symbol, f.fiscal_date_ending, f.report_date || null, f.estimate ?? null);
    }
    const rows = await sql(
      `insert into pm_v2_consenso_snap (symbol, fiscal_date_ending, report_date, estimate)
       values ${values.join(', ')}
       on conflict (symbol, fiscal_date_ending, dia) do nothing
       returning symbol`,
      params
    );
    insertadas += rows.length;
  }
  return { filas: validas.length, insertadas };
}

export {
  SCHEMA_V2, ensureSchemaV2, upsertFeatures, COLS_FEATURES, guardaSnapshotConsenso,
  upsertHist, marcaSinDatosAv, upsertMercadosV2, COLS_V2,
};
