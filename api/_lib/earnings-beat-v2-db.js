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
  'fuera_universo', 'faltante', 'outcome',
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
  const upd = COLS_FEATURES.filter((c) => c !== 'market_id' && c !== 'consenso_vigente')
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

// Captura PIT del consenso vigente. Solo mientras falten > 24h para el
// reporte: después de T-24h el número ya no es comparable con el precio de
// Polymarket a T-24h, y se congela el último capturado.
async function guardaVigente(market_id, valor) {
  const rows = await sql(
    `update pm_earnings_v2_features
        set consenso_vigente = $2, consenso_vigente_ts = now()
      where market_id = $1
        and fecha is not null
        and now() < (fecha::timestamptz - interval '24 hours')
      returning market_id`,
    [market_id, valor]
  );
  return rows.length;
}

export { SCHEMA_V2, ensureSchemaV2, upsertFeatures, guardaVigente, COLS_FEATURES };
