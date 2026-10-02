-- ═══════════════════════════════════════════════════════════════
-- VERIFICACIÓN DE ARRANQUE LIMPIO — T3
--
-- UNA consulta, SIETE líneas, cada una con su veredicto y su detalle.
-- **Si cualquiera dice FALLA, no se abre.** Y dice CUÁL, no un ok/no-ok.
--
-- Se corre DESPUÉS del reset y ANTES de quitar el halt.
--
-- Las dos cosas que esta consulta NO puede ver, porque viven en Alpaca y no
-- en Neon, salen del propio reset (`?confirm=1` las devuelve) y están en las
-- líneas 1 y 7 como recordatorio de dónde mirarlas.
-- ═══════════════════════════════════════════════════════════════

with
-- El inicio REAL de la temporada, el que escribió el reset. Si esto viene
-- vacío, el reset no corrió y todo lo demás da igual.
inicio as (
  select (value->>'start')::date as start
    from arena_flags where key = 'season_start:T3'
),
-- Los agentes de la liga, para no depender de que la tabla tenga siete filas.
padron as (select unnest(array['claude','control','openai','grok','gemini','deepseek','qwen']) as agent_id)

-- 1 · LAS SIETE CUENTAS, RE-BASADAS HOY
select 1 as n, 'cuentas re-basadas hoy' as verifica,
  case when count(*) filter (where s.baseline_at::date = (select start from inicio)) = 7
       then 'OK' else 'FALLA' end as veredicto,
  count(*) filter (where s.baseline_at::date = (select start from inicio))::text || ' de 7 con baseline de hoy · '
    || coalesce(string_agg(p.agent_id || '=' || coalesce(s.baseline_at::date::text,'SIN BASELINE'), ', '
         order by p.agent_id) filter (where s.baseline_at is null
           or s.baseline_at::date <> (select start from inicio)), 'todas al día') as detalle
from padron p left join arena_state s using (agent_id)

union all
-- 2 · EL CAPITAL: ¿igual, o publicado por agente?
-- No exige que sean iguales — Alpaca no deja fijar el saldo sin recrear las
-- cuentas. Exige que TODOS tengan un número, y publica la dispersión para que
-- la asimetría se lea en vez de suponerse.
select 2, 'capital de arranque',
  case when count(*) filter (where s.baseline_equity is null) > 0 then 'FALLA' else 'OK · DECLARADO' end,
  'min $' || to_char(min(s.baseline_equity),'FM999,999') ||
  ' · max $' || to_char(max(s.baseline_equity),'FM999,999') ||
  ' · dispersión ' || to_char(100.0*(max(s.baseline_equity)-min(s.baseline_equity))/nullif(min(s.baseline_equity),0),'FM990.0') || '%' ||
  ' · ' || string_agg(p.agent_id || ' $' || to_char(s.baseline_equity,'FM999,999'), ', ' order by p.agent_id)
from padron p left join arena_state s using (agent_id)

union all
-- 3 · CERO FILAS DE JOURNAL EN LA TEMPORADA
-- Salvo el anuncio del propio reset, que es `agent_id='league'` y SÍ tiene
-- que estar: su ausencia significaría que el reset no dejó rastro.
select 3, 'journal limpio en la T3',
  case when count(*) filter (where agent_id <> 'league') = 0
        and count(*) filter (where agent_id = 'league') >= 1
       then 'OK' else 'FALLA' end,
  count(*) filter (where agent_id <> 'league')::text || ' corridas de agente (debe ser 0) · '
    || count(*) filter (where agent_id = 'league')::text || ' filas de liga (debe ser ≥1: el anuncio del reset)'
from arena_journal where run_date >= (select start from inicio)

union all
-- 4 · EL SPY, COMPRADO HOY Y PARA ESTA TEMPORADA
select 4, 'benchmark de la T3',
  case when count(*) = 1 and max(opened_at)::date = (select start from inicio) then 'OK' else 'FALLA' end,
  coalesce(string_agg(symbol || ' $' || entry || ' × ' || shares || ' acciones el ' || opened_at::date, ', '),
           'NO HAY FILA para benchmark:spy:T3 — el SPY no se abrió')
from arena_benchmark where key = 'benchmark:spy:T3'

union all
-- 5 · CERO ESTADO POR AGENTE+TICKER
-- `arena_watch_mark` es la única tabla con estado por agente+símbolo SIN
-- columna de fecha: no caduca sola y el reset no la toca. Guarda el ancla de
-- precio contra la que el vigilante mide el ±3% "desde el último
-- pronunciamiento". Una fila de la T2 arma un disparador sobre un precio de
-- septiembre, para un nombre que nadie tiene.
-- (`arena_watch` y `arena_watch_meta` llevan fecha y caducan solas; la memoria
--  del journal —trailing, escalera de stops, plan previo— ya la corta
--  `agentCutoff` con el `baseline_at` del reset.)
select 5, 'sin estado por agente+ticker',
  case when count(*) = 0 then 'OK' else 'FALLA' end,
  case when count(*) = 0 then 'arena_watch_mark vacía'
       else count(*)::text || ' anclas vivas: ' || string_agg(distinct agent_id || '/' || symbol, ', ')
            || ' — borrar con: delete from arena_watch_mark;' end
from arena_watch_mark

union all
-- 6 · EL GASTO DE LA TEMPORADA EN CERO
-- El breaker mira el gasto del DÍA, así que la T2 no le pesa. Esto verifica
-- que tampoco haya gasto de hoy antes de abrir: si lo hay, algo corrió.
select 6, 'gasto de la T3 en cero',
  case when coalesce(sum(usd),0) = 0 and count(*) = 0 then 'OK' else 'FALLA' end,
  count(*)::text || ' corridas con gasto desde el ' || (select start from inicio)::text
    || ' · $' || to_char(coalesce(sum(usd),0),'FM990.00')
from arena_spend where day >= (select start from inicio)

union all
-- 7 · LA TEMPORADA ESTÁ ABIERTA, Y CUÁNDO
select 7, 'inicio escrito por el reset',
  case when (select start from inicio) is null then 'FALLA' else 'OK' end,
  coalesce('la T3 abrió el ' || (select start from inicio)::text
             || ' (planeado: 2026-10-01)',
           'NO HAY inicio escrito: el reset no corrió, o falló al journalear')

order by n;


-- ── LO QUE ESTA CONSULTA NO PUEDE VER ───────────────────────────────
-- Posiciones y órdenes abiertas viven en ALPACA, no en Neon. Salen de la
-- respuesta del propio reset:
--
--   .accounts[] | {agent, flat, after: {position_count, open_order_count}}
--
-- `flat: true` en las siete es la línea que falta. Si alguna dice false, el
-- reset lo reporta en `warnings` con su motivo (`not_flat` o
-- `queued_market_closed`).
