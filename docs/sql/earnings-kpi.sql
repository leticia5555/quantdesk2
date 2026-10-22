-- ═══════════════════════════════════════════════════════════════════
-- docs/sql/earnings-kpi.sql — migración de la cosecha de rangos de KPI.
--
-- Mismo texto que SCHEMA en api/_lib/earnings-kpi-db.js (ensureSchema() la
-- corre sola en la primera corrida del cron; tests/earnings-kpi-db.test.mjs
-- exige que este archivo y SCHEMA no diverjan). Idempotente: se puede correr
-- a mano en Neon cuantas veces haga falta. NO toca pm_earnings_markets.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists pm_kpi_markets (
   market_id               text primary key,   -- conditionId
   gamma_market_id         text,
   event_slug              text not null,
   event_title             text,
   question                text,
   range_label             text,               -- la etiqueta tal cual ('22% to 24%')
   range_low               numeric,            -- null en '<x'
   range_high              numeric,            -- null en 'x+'
   range_unit              text,               -- '%' | '$' | 'bps' | 'pp' | null (absoluto)
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
 );

create index if not exists pm_kpi_markets_event_idx on pm_kpi_markets (event_slug);

create index if not exists pm_kpi_markets_abiertos_idx on pm_kpi_markets (end_date) where not resolved;

create table if not exists pm_kpi_prices (
   market_id  text not null,
   ts         timestamptz not null,
   price_yes  numeric not null,
   fuente     text not null,                   -- 'gamma' (snapshot diario) | 'clob' (prices-history)
   primary key (market_id, ts, fuente)
 );
