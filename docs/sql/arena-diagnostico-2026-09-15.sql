-- ═══════════════════════════════════════════════════════════════════════
-- Diagnóstico del Arena — listo para pegar en Neon (psql o el SQL editor).
-- Dos preguntas abiertas del journal del 14/15 que no puedo resolver desde
-- mi entorno (sin acceso a Neon). Cada bloque es independiente.
--
--   §0  LAS DOS RESPUESTAS, en una sola consulta cada una. Pegá esto primero.
--   §1  ¿Por qué abortó grok el 14 y el 15? (2 de 2, determinista)
--   §2  ¿De dónde salió el "ZM filled at $95.5" de claude?
--   §3  Verificación del RESET (después de correr /api/arena-reset).
--
-- Nada de esto escribe. Todo es SELECT.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══ §0 · LAS DOS RESPUESTAS ══════════════════════════════════════════
-- Si solo vas a pegar dos bloques, pegá estos dos. Cada uno devuelve la
-- respuesta ya interpretada en una columna de texto, además de la evidencia.

-- 0.a — GROK: la causa de cada aborto, NOMBRADA.
select run_date,
       status,
       case
         when status = 'aborted_unverified_model'
           then 'CANDADO DE SLUG: ni siquiera se llamó al modelo. Falta ARENA_MODEL_GROK. Cero tokens gastados.'
         when status = 'aborted_scan_malformed_json'
              and context -> 'scan' ->> 'stop_reason' = 'max_tokens'
           then 'TECHO DE SALIDA: se quedó sin tokens a mitad del JSON. Causa raíz #1. YA ARREGLADO (techo 500 -> 6000).'
         when status = 'aborted_scan_malformed_json'
              and coalesce(length(context -> 'scan' ->> 'response'), 0) = 0
           then 'RESPUESTA VACIA: content vino vacio (la respuesta iba en message.reasoning). YA ARREGLADO (fallback a reasoning).'
         when status = 'aborted_scan_malformed_json'
           then 'PARLOTEO: contestó, pero fuera del formato JSON. Mirá scan_respuesta en §1.1 — esto NO está arreglado por el techo.'
         when status = 'aborted_llm_error' and error like '%fechas rotas%'
           then 'GUARD ANTI-FECHAS: reincidió tras el retry. NO está arreglado — mandámelo.'
         when status = 'aborted_llm_error' and error like '%404%'
           then 'SLUG RETIRADO: el modelo no existe con ese nombre. Lo resuelve /api/arena-smoke?catalog=1.'
         when status = 'aborted_llm_error' and error like '%429%'
           then 'RATE LIMIT de OpenRouter.'
         when status = 'aborted_llm_error'
           then 'ERROR DEL PROVEEDOR: ver la columna error.'
         when status = 'aborted_llm_refusal'
           then 'RECHAZO del clasificador (stop_reason=refusal). No es un problema de formato.'
         when status like 'aborted%' then 'OTRO ABORTO: ver status y error.'
         else 'NO ABORTÓ.'
       end                                              as causa,
       context -> 'scan' ->> 'stop_reason'              as scan_stop_reason,
       coalesce(length(context -> 'scan' ->> 'response'), 0) as scan_chars,
       (context -> 'scan' -> 'usage' ->> 'output_tokens')::int as output_tokens,
       context -> 'params' ->> 'max_tokens'             as techo_de_salida,
       model,
       left(coalesce(error, ''), 200)                   as error
from arena_journal
where agent_id = 'grok'
  and phase = 'decide'
  and run_date in (date '2026-09-14', date '2026-09-15')
order by run_date, created_at;

-- 0.b — ZM: ¿el "filled at $95.5" es de esta temporada o de la anterior?
with fills_zm as (
  select j.run_date, j.created_at, a ->> 'symbol' as symbol, a ->> 'side' as side,
         a ->> 'filled_avg_price' as filled_avg_price, a ->> 'order_status' as order_status
  from arena_journal j, lateral jsonb_array_elements(coalesce(j.actions, '[]'::jsonb)) a
  where j.agent_id = 'claude' and j.phase = 'decide' and a ->> 'symbol' = 'ZM'
)
select run_date, side, filled_avg_price, order_status,
       case when run_date < date '2026-09-14'
            then 'DE OTRA TEMPORADA: el PM del 14 lo recibió por las consultas de memoria SIN corte. Bug confirmado.'
            else 'de esta temporada'
       end as veredicto
from fills_zm
order by run_date desc
limit 20;
-- Si no devuelve NINGUNA fila, el número no salió del journal: el PM lo
-- ALUCINÓ, y eso es otro bug (y otra conversación). Corré igual §2.2.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══ §1 · GROK ════════════════════════════════════════════════════════
-- 1.1 — LA CONSULTA QUE LO CIERRA. Una fila por corrida abortada, con las
--       cuatro señales que distinguen las cuatro hipótesis.
select run_date,
       status,
       error,
       model,
       context -> 'scan' ->> 'stop_reason'            as scan_stop_reason,
       length(context -> 'scan' ->> 'response')       as scan_chars,
       context -> 'dive' ->> 'stop_reason'            as dive_stop_reason,
       context -> 'dive' ->> 'truncated'              as dive_truncated,
       left(context -> 'scan' ->> 'response', 800)    as scan_respuesta
from arena_journal
where agent_id = 'grok'
  and phase = 'decide'
  and run_date in (date '2026-09-14', date '2026-09-15')
order by run_date;

-- CÓMO LEER EL RESULTADO:
--
--   status = 'aborted_scan_malformed_json'  Y  scan_chars chico/0/null
--     → HIPÓTESIS #1: el techo de 500 tokens del SCAN contra un modelo que
--       razona. Los tokens de pensamiento salen del MISMO presupuesto y se
--       consumen antes del primer '{'. YA ARREGLADO (techo 6000).
--
--   status = 'aborted_scan_malformed_json'  Y  scan_respuesta parece
--   razonamiento en prosa (no JSON)
--     → HIPÓTESIS #2: la respuesta venía en `message.reasoning` con `content`
--       vacío. YA ARREGLADO (se cae a `reasoning`).
--
--   status = 'aborted_llm_error'  Y  error contiene 'HTTP 404'
--     → HIPÓTESIS #3: el slug se retiró del catálogo. Lo resuelve
--       /api/arena-smoke?catalog=1 y el candado de slug ya lo impide.
--
--   status = 'aborted_llm_error'  Y  error contiene 'fechas rotas tras retry'
--     → HIPÓTESIS #4: el guard anti-fechas. NO está arreglado — si sale ésta,
--       mandámela y lo miro.

-- 1.2 — Contexto: ¿los otros agentes corrieron bien esos días? Si abortaron
--       todos, no es de grok: es del harness.
select run_date, agent_id, status, left(coalesce(error, ''), 120) as error
from arena_journal
where phase = 'decide'
  and run_date in (date '2026-09-14', date '2026-09-15')
  and agent_id <> 'league'
order by run_date, agent_id;

-- 1.3 — Historial de grok: ¿venía fallando de antes, o empezó con el modelo
--       nuevo? (Si abortaba desde siempre, la causa es otra.)
select run_date, status, model, left(coalesce(error, ''), 120) as error
from arena_journal
where agent_id = 'grok' and phase = 'decide'
order by run_date desc
limit 20;


-- ═══ §2 · EL "ZM filled at $95.5" DE CLAUDE ═══════════════════════════
-- Hipótesis: el prompt arrastraba memoria de la temporada anterior (ninguna de
-- las cuatro consultas de memoria tenía corte por temporada). Si el fill de ZM
-- es de una corrida ANTERIOR al arranque de la T2, queda confirmado.

-- 2.1 — ¿En qué corridas aparece ZM, y de qué fecha son?
select run_date,
       agent_id,
       status,
       jsonb_path_query_array(actions, '$[*] ? (@.symbol == "ZM")') as acciones_zm
from arena_journal
where phase = 'decide'
  and actions @> '[{"symbol":"ZM"}]'
order by run_date desc
limit 20;

-- 2.2 — LA PRUEBA DIRECTA: ¿qué plan se le reinyectó a claude el 14?
--       Es la MISMA consulta que corría el harness antes del fix, sin corte.
--       Si la fila que sale tiene run_date < 2026-09-14, el PM del 14 recibió
--       el plan de la temporada anterior → bug confirmado.
select run_date,
       created_at,
       status,
       left(plan, 400) as plan_reinyectado
from arena_journal
where phase = 'decide'
  and plan is not null
  and agent_id = 'claude'
  and status not in ('season_start', 'season_started', 'rules_changed', 'season_winner')
  and created_at < (
    select min(created_at) from arena_journal
    where agent_id = 'claude' and phase = 'decide' and run_date = date '2026-09-14'
  )
order by created_at desc
limit 1;

-- 2.3 — El otro vector: los FILLS de 180 días que alimentaban positions_meta.
--       Cuántos venían de ANTES del arranque de la T2 (ésos son los que el PM
--       veía como si fueran de su libro actual).
select count(*) filter (where run_date <  date '2026-09-14') as fills_de_temporadas_viejas,
       count(*) filter (where run_date >= date '2026-09-14') as fills_de_esta_temporada,
       min(run_date) as el_mas_viejo_que_se_reinyectaba
from arena_journal
where phase = 'decide'
  and agent_id = 'claude'
  and actions is not null
  and created_at > now() - interval '180 days';

-- 2.4 — Y el que más importaba para el lunes 21: ¿cuál era el PICO de equity
--       que el breaker habría usado contra el reset a $100k?
--       Si `pico_sin_corte` > 125000, el corte amplio (−20%) habría disparado
--       en la primera corrida de la temporada nueva, para ese agente.
select agent_id,
       max((account ->> 'equity')::numeric)                                              as pico_sin_corte,
       max((account ->> 'equity')::numeric) filter (where run_date >= date '2026-09-14') as pico_con_corte,
       round(100 * (max((account ->> 'equity')::numeric) - 100000)
             / nullif(max((account ->> 'equity')::numeric), 0), 2)                       as drawdown_pct_en_el_reset
from arena_journal
where account is not null and agent_id <> 'league'
group by agent_id
order by pico_sin_corte desc nulls last;


-- ═══ §3 · VERIFICACIÓN DEL RESET ══════════════════════════════════════
-- Se corre DESPUÉS de `/api/arena-reset?confirm=1`. Confirma las tres cosas
-- que el reset promete: cuentas planas, corte escrito, anuncio journaleado.

-- 3.1 — ¿Se escribió el baseline en las siete cuentas?
--       `baseline_at` null = ese agente NO quedó re-basado: su pico del
--       breaker sigue mirando al libro viejo. No dejes correr la liga así.
select agent_id,
       baseline_at,
       baseline_equity,
       baseline_id,
       halted,
       halted_reason,
       case when baseline_at is null then 'SIN RE-BASAR — el pico del breaker sigue en el libro viejo'
            when halted then 'RE-BASADO PERO DETENIDO — hay que reactivarlo'
            else 'ok' end as estado
from arena_state
order by agent_id;

-- 3.2 — El anuncio del corte, con el detalle cuenta por cuenta.
select id, run_date, created_at, left(plan, 300) as anuncio,
       jsonb_pretty(context -> 'accounts') as cuentas
from arena_journal
where status = 'rules_changed' and agent_id = 'league'
order by created_at desc
limit 3;

-- 3.3 — El pico que el breaker va a usar en la PRIMERA corrida post-reset,
--       por agente, con el corte ya aplicado. `drawdown_de_arranque_pct` es
--       lo que el breaker va a leer: a −15% desapalanca, a −20% corta amplio.
--       Cualquier valor > 0 acá merece una mirada ANTES de la corrida.
with cortes as (
  select agent_id,
         coalesce(baseline_at, '-infinity'::timestamptz) as desde,
         coalesce(baseline_equity, 100000)               as piso
  from arena_state
)
select c.agent_id,
       c.piso                                                   as baseline_declarado,
       max((j.account ->> 'equity')::numeric)                    as pico_journaleado_post_corte,
       greatest(coalesce(max((j.account ->> 'equity')::numeric), 0), c.piso) as pico_efectivo,
       round(100 * (greatest(coalesce(max((j.account ->> 'equity')::numeric), 0), c.piso)
                    - coalesce(max((j.account ->> 'equity')::numeric), c.piso))
             / nullif(greatest(coalesce(max((j.account ->> 'equity')::numeric), 0), c.piso), 0), 2)
                                                                as drawdown_de_arranque_pct
from cortes c
left join arena_journal j
  on j.agent_id = c.agent_id and j.account is not null and j.created_at > c.desde
group by c.agent_id, c.piso
order by c.agent_id;

-- 3.4 — ¿Quedó alguna orden viva de antes del corte? (debería dar 0 filas)
select agent_id, run_date, status, jsonb_array_length(coalesce(actions, '[]'::jsonb)) as n_acciones
from arena_journal
where phase = 'decide' and agent_id <> 'league'
  and created_at > (select max(created_at) from arena_journal where status = 'rules_changed' and agent_id = 'league')
order by created_at desc
limit 20;
