-- ═══════════════════════════════════════════════════════════════════════
-- Diagnóstico del Arena — listo para pegar en Neon (psql o el SQL editor).
-- Dos preguntas abiertas del journal del 14/15 que no puedo resolver desde
-- mi entorno (sin acceso a Neon). Cada bloque es independiente.
--
--   §1  ¿Por qué abortó grok el 14 y el 15? (2 de 2, determinista)
--   §2  ¿De dónde salió el "ZM filled at $95.5" de claude?
--
-- Nada de esto escribe. Todo es SELECT.
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
