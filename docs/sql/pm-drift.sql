-- ═══════════════════════════════════════════════════════════════
-- docs/sql/pm-drift.sql — tablas nuevas del backtest PM-DRIFT.
--
-- Es la misma DDL que SCHEMA de api/_lib/pm-drift-analyze.js; el endpoint
-- también la corre sola (create table if not exists), así que correrla a mano
-- es opcional pero recomendado antes del primer link.
-- tests/pm-drift-analyze.test.mjs exige que no diverjan.
--
-- No toca pm_earnings_markets, pm_earnings_markets_v2 ni pead_event_hour.
--
-- pm_price_hist        — historial del "Yes" del CLOB (prices-history,
--                        fidelity 60) en la ventana [fecha−4d, fecha+1d).
--                        Idempotente por (market_id, ts).
-- pm_price_hist_fetch  — una fila por mercado ya pedido: 'ok' (aunque venga
--                        vacío) no se vuelve a pedir; 'error' se reintenta.
-- ═══════════════════════════════════════════════════════════════

create table if not exists pm_price_hist (
     market_id  text not null,
     ts         timestamptz not null,
     price      numeric not null,
     primary key (market_id, ts)
   );

create table if not exists pm_price_hist_fetch (
     market_id  text primary key,
     token_id   text,
     estado     text not null,
     puntos     int not null default 0,
     http       int,
     forma      text,
     desde      timestamptz,
     hasta      timestamptz,
     bajado_en  timestamptz not null default now()
   );
