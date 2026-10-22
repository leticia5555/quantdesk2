-- ════════════════════════════════════════════════════════════════════════
-- QuantDesk · POR QUÉ EL VIGILANTE NO DESPACHÓ A LOS OTROS CUATRO
-- 2026-10-21, el hueco de 18:27 a 19:18 UTC (se mira 18:00–19:30).
--
-- Queda acá porque #319 dejó la pregunta abierta: por el camino real, un
-- agente que llama a OpenRouter y recibe el 402 DEJA SU FILA, así que esos
-- cuatro nunca llegaron a llamar. Por qué no los despachó el vigilante no se
-- ve en el código; se ve en estas tablas.
--
-- UNA sola consulta, seis bloques. Cada bloque separa una hipótesis de la de
-- al lado, y ésa es toda su razón de ser:
--
--   H1 · nunca hubo disparador        → bloque 1 sin filas suyas (y el 6 lo
--                                       confirma: el ancla re-fijada a las
--                                       18:2x hace que el ±3% se mida desde ahí)
--   H2 · enfriamiento o tope          → bloque 1 "frenado" + skip_reason;
--                                       el bloque 2 separa uno del otro
--   H3 · escalón 2 de presupuesto     → skip_reason "presupuesto en escalón…"
--   H4 · estaban halted               → SE VE IGUAL QUE H1 en el bloque 1,
--                                       porque `agentsForEval` los saca ANTES
--                                       de escribir fila. Sólo el bloque 5 las
--                                       separa, y por eso está acá.
--   H5 · el vigilante no tickeó       → bloque 4 vacío en la ventana. Es
--                                       global: tampoco habría filas de los
--                                       que sí corrieron
--   H6 · tickeó y se cayó antes       → bloque 4 con marcas que se cortan de
--                                       golpe, más cron-status en error
--   H7 · despachó y el agente murió   → bloque 1 "DESPACHADO" sin su fila en
--        antes de llamar al modelo      el bloque 3. Es la única que el código
--                                       solo no puede descartar
--
-- Lo más barato es mirar H5 primero: si el bloque 4 está vacío, las otras seis
-- sobran.
--
-- PREPARADA contra un Postgres real con el DDL de `api/_lib/db.js`, y corrida
-- con filas de prueba para que ningún bloque quede mudo por un tipo mal puesto.
-- ════════════════════════════════════════════════════════════════════════
with v as (
  select date '2026-10-21'                     as dia,
         timestamptz '2026-10-21 18:00:00+00'  as desde,
         timestamptz '2026-10-21 19:30:00+00'  as hasta
),
t as (

-- ── 1 · TODO disparador journaleado en la ventana ──────────────────────
-- Un agente que NO aparece acá nunca tuvo disparador (H1/H4/H5).
-- Si aparece con "frenado", el skip_reason dice quién lo frenó (H2/H3).
select 1 as orden, '1 · disparadores en la ventana' as bloque,
       to_char(w.fired_at at time zone 'UTC', 'HH24:MI:SS')      as col1,
       w.agent_id                                                as col2,
       w.trigger_type || ' · ' || w.symbol                       as col3,
       case when w.fired then 'DESPACHADO' else 'frenado' end    as col4,
       coalesce(w.skip_reason, '—')                              as col5
from arena_watch w, v
where w.fired_at >= v.desde and w.fired_at < v.hasta

union all
-- ── 2 · El día completo, por agente ────────────────────────────────────
-- Separa "cooldown" de "tope del día": si ya tenía sus corridas gastadas,
-- el hueco no es un bug del despacho.
select 2, '2 · el dia completo, por agente',
       w.agent_id,
       count(*)::text || ' disparos',
       count(*) filter (where w.fired)::text || ' despachados',
       to_char(min(w.fired_at) at time zone 'UTC', 'HH24:MI') || ' → '
         || to_char(max(w.fired_at) at time zone 'UTC', 'HH24:MI'),
       coalesce(string_agg(distinct w.skip_reason, ' | '), '—')
from arena_watch w, v
where w.run_date = v.dia
group by w.agent_id

union all
-- ── 3 · Quién SÍ corrió en la ventana, y cómo terminó ──────────────────
-- Un `fired=true` en el bloque 1 sin fila acá quiere decir que se despachó
-- y el agente murió ANTES de llamar al modelo (H7), que es justo lo que el
-- PR #319 da por descartado.
select 3, '3 · corridas (journal) en la ventana',
       to_char(j.created_at at time zone 'UTC', 'HH24:MI:SS'),
       coalesce(j.agent_id, '(sin agent_id)'),
       j.phase || ' · ' || j.status,
       coalesce(j.model, '—'),
       left(coalesce(j.error, coalesce(j.context ->> 'llm_error', '—')), 180)
from arena_journal j, v
where j.created_at >= v.desde and j.created_at < v.hasta

union all
-- ── 4 · ¿El vigilante siquiera tickeó? ─────────────────────────────────
-- Las marcas que escribe cada tick (risknet, round:*, floor:*, reconcile:*,
-- openrouter_saldo). Si no hay NADA tocado en la ventana, el hueco es del
-- cron o del gate de sesión (H5/H6), no del despacho por agente.
select 4, '4 · marcas del vigilante en la ventana',
       to_char(m.updated_at at time zone 'UTC', 'HH24:MI:SS'),
       m.key, '—', '—',
       left(m.value::text, 180)
from arena_watch_meta m, v
where m.updated_at >= v.desde and m.updated_at < v.hasta

union all
-- ── 5 · ¿Estaban detenidos? ────────────────────────────────────────────
-- `halted` saca al agente de la evaluación, y entonces el bloque 1 se ve
-- idéntico a "no hubo disparador" (H4 contra H1).
select 5, '5 · estado de cada agente (halted)',
       coalesce(s.agent_id, '(sin agent_id)'),
       case when s.halted then 'DETENIDO' else 'activo' end,
       coalesce(to_char(s.halted_at  at time zone 'UTC', 'DD HH24:MI'), '—'),
       coalesce(to_char(s.resumed_at at time zone 'UTC', 'DD HH24:MI'), '—'),
       coalesce(s.halted_reason, '—')
from arena_state s

union all
-- ── 6 · El ancla de ±3%, para los que no tuvieron disparador ───────────
-- Si la marca se re-fijó a las 18:2x, el ±3% se midió desde ahí y por eso
-- no volvió a dispararse: eso es el vigilante funcionando, no fallando.
select 6, '6 · anclas re-fijadas ese dia',
       to_char(k.marked_at at time zone 'UTC', 'DD HH24:MI'),
       k.agent_id, k.symbol, k.price::text, coalesce(k.source, '—')
from arena_watch_mark k, v
where k.marked_at >= v.dia and k.marked_at < v.dia + 2

)
select bloque, col1, col2, col3, col4, col5
from t
order by orden, col1, col2;
