-- ═══════════════════════════════════════════════════════════════
-- docs/sql/earnings-beat-v2-4.sql — snapshot diario del consenso (26-oct).
--
-- Se corre DESPUÉS de -v2.sql, -v2-1.sql, -v2-2.sql y -v2-3.sql. Solo DDL; el
-- job ?job=diario también lo crea solo (SCHEMA_V2). tests/earnings-beat-v2.test.mjs
-- exige que no diverjan.
--
-- pm_v2_consenso_snap: un snapshot por día de Alpha Vantage EARNINGS_CALENDAR
-- (una llamada, todos los reportes de los próximos 3 meses). De acá sale
-- consenso_vigente: el estimate del snapshot más reciente ANTES del T-24h de
-- cada mercado. Nunca se rellena hacia atrás.
-- ═══════════════════════════════════════════════════════════════

create table if not exists pm_v2_consenso_snap (
   symbol             text not null,
   fiscal_date_ending date not null,
   report_date        date,
   estimate           numeric,
   capturado_en       timestamptz not null default now(),
   dia                date not null default current_date,
   primary key (symbol, fiscal_date_ending, dia)
 );

create index if not exists pm_v2_consenso_snap_symbol_idx on pm_v2_consenso_snap (symbol, capturado_en);

alter table pm_earnings_v2_features add column if not exists consenso_vigente_snap timestamptz;
