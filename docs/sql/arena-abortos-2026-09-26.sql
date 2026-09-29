-- ═══════════════════════════════════════════════════════════════
-- LOS 77 ABORTOS — las cuatro consultas
--
-- Contexto (2026-09-25, siete días): 123 corridas vivas contra 77 abortadas,
-- 38.5% de la liga. Pero repartido de una manera que no es ruido:
--
--     control 37/0     claude 30/0     grok 18/7    ChatGPT 13/13
--     gemini 13/10     deepseek 9/25   qwen 3/22
--
-- Los dos de Anthropic DIRECTO llevan CERO en 67 corridas. Los cinco de
-- OpenRouter concentran los 77. Eso no concluye —son además modelos
-- distintos, sin caché de prompt, y comparten el reparto de reloj de esa
-- ruta— pero dice dónde mirar.
--
-- ORDEN: correr la 1, la 2 y la 2b primero. La 2b es la que puede volver
-- innecesaria a la sonda de ruta: si los abortos son cortes de RELOJ
-- (`time_budget`), el transporte no es la pregunta y no hay que gastar los
-- $5-8. Si son `cuerpo_vacio`, el proveedor cortó el stream y la sonda sí
-- decide algo.
--
-- Son cuatro preguntas en seis consultas: la 2 se partió en tres porque
-- mezclar "cuánto reloj tuvo", "qué techo cortó" y "la sombra tiene el mismo
-- reloj que la liga" en un solo select daba una tabla que no se lee.
--
-- Todas leen `arena_journal`, todas son SELECT, ninguna escribe.
-- Ventana: desde el arranque de la T2 (2026-09-14).
-- ═══════════════════════════════════════════════════════════════


-- ── 1 · QUÉ SE ROMPIÓ, POR AGENTE ────────────────────────────────────
-- El desglose que falta: 77 abortos no es un número, son varios problemas
-- distintos sumados. `status` dice en qué etapa murió; `error` dice por qué.
-- Se recorta el error a su PREFIJO para que dos fallos iguales con distinto
-- id de request se agrupen juntos en vez de contar como dos causas.
select
  agent_id,
  status,
  left(coalesce(error, '(sin error)'), 60) as motivo,
  count(*)                                  as veces,
  min(created_at)                           as primera,
  max(created_at)                           as ultima
from arena_journal
where run_date >= '2026-09-14'
  and agent_id <> 'league'
  and status like 'aborted%'
group by 1, 2, 3
order by veces desc, agent_id;


-- ── 2 · ¿ES EL RELOJ? ────────────────────────────────────────────────
-- LA CONSULTA QUE DECIDE SI LA SONDA DE RUTA HACE FALTA.
--
-- El loop escribe en cada corrida cuánto reloj tuvo y cuánto usó
-- (`context.tools.limites.reloj_ms`) y cuál de los tres techos cortó
-- (`stopped_by`). Con eso se contesta sin gastar un peso:
--
--   · ¿el tope de reloj es el MISMO para todos? Si la liga corriera con un
--     número y la sombra con otro, comparar las dos sería inválido — y
--     cualquier conclusión de la sonda valdría solo entre brazos.
--   · ¿los que abortan venían al 95% del reloj, o murieron al 20%?
--     Al 95% es tiempo. Al 20% no es tiempo, y ahí sí la ruta es candidata.
--
-- `pct_p50` es la mediana, no el promedio: un solo timeout de 185s arrastra
-- un promedio y no mueve una mediana.
select
  agent_id,
  case when status like 'aborted%' then 'abortada' else 'viva' end as clase,
  count(*) as corridas,
  -- El TOPE que tuvo. Si esta columna no es idéntica en todas las filas,
  -- ahí está la respuesta y no hace falta seguir.
  min((context->'tools'->'limites'->'reloj_ms'->>'tope')::numeric)  as tope_ms_min,
  max((context->'tools'->'limites'->'reloj_ms'->>'tope')::numeric)  as tope_ms_max,
  -- Cuánto del reloj consumió, en porcentaje de su propio tope.
  round(percentile_cont(0.5) within group (
    order by (context->'tools'->'limites'->'reloj_ms'->>'pct')::numeric), 1) as pct_p50,
  max((context->'tools'->'limites'->'reloj_ms'->>'pct')::numeric)   as pct_max,
  -- Si hay `murio_en`, el turno de cierre NUNCA ocurrió.
  count(*) filter (where context ? 'murio_en')                             as sin_cierre
from arena_journal
where run_date >= '2026-09-14'
  and agent_id <> 'league'
  and phase = 'decide'
group by 1, 2
order by agent_id, clase;


-- ── 2b · CUÁL DE LOS TECHOS CORTÓ ────────────────────────────────────
-- Complemento de la 2. Se AGRUPA por `stopped_by` en vez de contar valores
-- que yo escriba a mano: el vocabulario del loop tiene nueve valores
-- (`time_budget`, `call_budget`, `context_budget`, `cuerpo_vacio`,
-- `max_turns`, `end_turn`, `no_tools`, `error`, `error_cierre`) y una
-- consulta que nombre los que yo recuerde esconde justo el que no recordé.
--
-- LECTURA: si los abortos se concentran en `time_budget`, es reloj y la sonda
-- de ruta no hace falta. Si se concentran en `cuerpo_vacio`, el proveedor
-- cortó el stream — y ahí la ruta SÍ es candidata.
select
  agent_id,
  coalesce(context->'tools'->>'stopped_by', '(sin loop)') as corto_por,
  count(*)                                       as corridas,
  count(*) filter (where status like 'aborted%')  as abortadas,
  round(percentile_cont(0.5) within group (
    order by (context->'tools'->'limites'->'reloj_ms'->>'pct')::numeric), 1) as pct_reloj_p50
from arena_journal
where run_date >= '2026-09-14'
  and agent_id <> 'league'
  and phase = 'decide'
group by 1, 2
order by agent_id, corridas desc;


-- ── 2c · EL RELOJ DE LA SOMBRA CONTRA EL DE LA LIGA ──────────────────
-- La sombra escribe en OTRA tabla (`arena_shadow_journal`), a propósito: una
-- bandera en la misma tabla está a una consulta mal escrita de contaminar el
-- post-mortem.
--
-- Leyendo el código, el tope es el MISMO (185s): la liga viva y la sombra
-- corren la MISMA función (`runAgenteObjetivo`), y el `budgetMs` se calcula
-- con `relojDisponible({scanMs: 0})` sin ninguna rama por `vivo`. Esta
-- consulta es para no creerme: si las dos columnas no dan el mismo número, el
-- código dice una cosa y producción otra, y gana producción.
select 'liga'   as donde, min(tope) as tope_ms_min, max(tope) as tope_ms_max, count(*) as corridas
from (select (context->'tools'->'limites'->'reloj_ms'->>'tope')::numeric as tope
      from arena_journal where run_date >= '2026-09-14' and phase = 'decide'
        and agent_id <> 'league' and context ? 'tools') a
where tope is not null
union all
select 'sombra' as donde, min(tope), max(tope), count(*)
from (select (context->'tools'->'limites'->'reloj_ms'->>'tope')::numeric as tope
      from arena_shadow_journal where run_date >= '2026-09-14' and context ? 'tools') b
where tope is not null;


-- ── 3 · RUTA Y RONDA ─────────────────────────────────────────────────
-- Las dos variables que la tabla de arriba confunde. `model` empieza con el
-- proveedor en OpenRouter (`x-ai/…`, `qwen/…`) y no lo lleva en Anthropic, así
-- que la ruta se deduce del slug sin depender del registry.
--
-- Y el TIPO de corrida: una ronda fija y un disparador no tienen el mismo
-- presupuesto de herramientas (20 contra 3), así que si los abortos se
-- concentran en un tipo, el reloj tampoco es el mismo para los dos.
select
  case when model like '%/%' then 'openrouter' else 'anthropic' end as ruta,
  coalesce(context->'event'->>'type', 'ronda_fija')                 as desperto,
  count(*)                                                          as corridas,
  count(*) filter (where status like 'aborted%')                    as abortadas,
  round(100.0 * count(*) filter (where status like 'aborted%') / nullif(count(*), 0), 1) as pct_abortos,
  -- Herramientas: el tope que tuvo y las que llegó a usar.
  round(avg((context->'tools'->>'budget')::numeric), 1)             as htas_tope_prom,
  round(avg((context->'tools'->>'used')::numeric), 1)               as htas_usadas_prom
from arena_journal
where run_date >= '2026-09-14'
  and agent_id <> 'league'
  and phase = 'decide'
group by 1, 2
order by pct_abortos desc nulls last;


-- ── 4 · QUÉ COSTARON LOS ABORTOS, Y POR QUÉ NO DICE QUIÉN LOS SIRVIÓ ──
--
-- ═══ LEER ESTO ANTES DE CORRERLA (corregido el 2026-09-29) ═══════════
--
-- La versión anterior de esta consulta tenía DOS defectos, y el segundo la
-- invalidaba:
--
--   1. NO FILTRABA POR `cuerpo_vacio`. Su único filtro de aborto era
--      `status like 'aborted%'`, o sea TODOS: los 48 de saldo, los 13
--      nuestros y los 23 de cuerpo vacío, sumados. Se llamaba una cosa y
--      medía otra.
--
--   2. NO PODÍA CONTESTAR SU PROPIA PREGUNTA. OpenRouter manda el nombre del
--      proveedor DENTRO DEL CUERPO. `cuerpo_vacio` significa, literalmente,
--      que el cuerpo no llegó. Para las 23 corridas que queremos investigar,
--      **el proveedor viene vacío POR CONSTRUCCIÓN**.
--
-- Eso último estaba anotado como "lo que me desmentiría". No era un
-- desmentido: era el resultado GARANTIZADO. Corrida tal cual, iba a devolver
-- `(no declarado)` en las 23, y la lectura natural —"no se concentran en
-- ningún proveedor, no vale la pena fijar routing"— sería una conclusión
-- sacada de un dato que la consulta nunca pudo ver. El mismo
-- null-leído-como-medición que ya nos mordió en la consulta de caché.
--
-- ═══ ENTONCES, ¿SE PUEDE CONTESTAR? ══════════════════════════════════
--
-- **Para las 23 de la T2: NO.** No guardábamos el id de la generación (el
-- único con el que OpenRouter podría decirnos después quién la sirvió), así
-- que esas corridas son inatribuibles para siempre. Se dice derecho y no se
-- rellena con una inferencia.
--
-- **Desde la T3: SÍ.** Se instrumentó el 2026-09-29. Las CABECERAS de la
-- respuesta SÍ llegan cuando el cuerpo no —por eso `fetch` resuelve— y ahora
-- se capturan: `context.llm_error.generation_id` y `.cabeceras`. Con ese id,
-- `GET /api/v1/generation?id=<id>` devuelve el proveedor del lado de
-- OpenRouter aunque a nosotros no nos haya llegado nada.
--
-- ═══ QUÉ SÍ CONTESTA ESTA CONSULTA ═══════════════════════════════════
--
-- Lo que se puede saber de los `cuerpo_vacio` con lo que hay:
--   · cuántos son, por agente
--   · cuántos fueron NUESTRO reloj y cuántos del proveedor (B23 instrumentó
--     `timeout_nuestro`, y ése SÍ existe en las 23)
--   · cuánto costaron
--   · y en cuántos tenemos un id para recuperar el proveedor (0 en la T2,
--     por eso la columna: para ver el número subir en la T3)
--
-- La columna `proveedor` se deja A PROPÓSITO, con su etiqueta: verla en
-- `(no llegó el cuerpo)` es el recordatorio de que el hueco es estructural y
-- no un problema de la consulta.

select
  j.agent_id,
  count(*)                                                                as cuerpos_vacios,
  count(*) filter (where (v->>'timeout_nuestro')::boolean)                as reloj_nuestro,
  count(*) filter (where not coalesce((v->>'timeout_nuestro')::boolean, false)) as corto_el_proveedor,
  -- El proveedor, cuando existe. En la T2 esto es 0 por construcción.
  count(*) filter (where coalesce(v->>'proveedor', '') <> '')             as con_proveedor,
  coalesce(
    nullif(string_agg(distinct v->>'proveedor', ', ')
           filter (where coalesce(v->>'proveedor', '') <> ''), ''),
    '(no llegó el cuerpo — OpenRouter manda el proveedor adentro)')       as proveedores,
  -- LA COLUMNA QUE IMPORTA MIRAR EN LA T3: cuántos se pueden recuperar.
  count(*) filter (where coalesce(v->>'generation_id', '') <> '')         as con_generation_id,
  round(sum(distinct coalesce((j.context->'cost'->>'usd')::numeric, 0))::numeric, 2) as usd_tirado
from arena_journal j
left join lateral jsonb_array_elements(
  coalesce(j.context->'llm_error'->'cuerpos_vacios', '[]'::jsonb)) as v on true
where j.run_date >= '2026-09-14'
  and j.agent_id <> 'league'
  and j.phase = 'decide'
  -- EL FILTRO QUE FALTABA: solo los cuerpos vacíos, no los 84 abortos.
  and j.status = 'aborted_cuerpo_vacio'
group by 1
order by cuerpos_vacios desc;


-- ── 4b · Y EL COSTO DE TODOS LOS ABORTOS, QUE ES OTRA PREGUNTA ────────
-- La 4 vieja mezclaba las dos. Ésta es la que sí quiere TODOS los abortos:
-- cuánto se tiró, por agente y por culpa. No pretende decir quién los sirvió.
select
  agent_id,
  count(*)                                                            as abortos,
  count(*) filter (where error ~* 'credits|credit balance|available|maximum cost|verify.{0,20}avail') as saldo,
  count(*) filter (where (context->'llm_error'->>'timeout_nuestro')::boolean) as reloj_nuestro,
  round(sum(coalesce((context->'cost'->>'usd')::numeric, 0))::numeric, 2)     as usd_tirado
from arena_journal
where run_date >= '2026-09-14'
  and agent_id <> 'league'
  and phase = 'decide'
  and status like 'aborted%'
group by 1
order by usd_tirado desc nulls last;
