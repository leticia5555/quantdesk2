-- ¿QUÉ PROVEEDOR SIRVIÓ A QWEN EN LA CORRIDA DEL 1-OCT (ET)?
-- La instrumentación de cabeceras entró en 9f1d40d, antes del deploy que
-- trajo los relojes nuevos, así que los campos tienen que existir.
--
-- `campo_existe = false` → no estaba desplegado y la pregunta sigue abierta.
-- `campo_existe = true, generation_id = null` → las cabeceras no traen
--   identificador: se cierra el caso y se decide entre techo o seis agentes.
select
  agent_id,
  status,
  context->'tools'->>'stopped_by'                        as loop_corto_por,
  context->'llm_error' ? 'generation_id'                 as campo_existe,
  context->'llm_error'->>'generation_id'                 as generation_id,
  context->'llm_error'->>'proveedor'                     as proveedor_del_cuerpo,
  context->'llm_error'->'cabeceras'                      as cabeceras,
  context->'llm_error'->>'motivo'                        as motivo,
  (context->'llm_error'->>'timeout_nuestro')::boolean    as reloj_nuestro,
  (context->'llm_error'->>'techo_ms')::numeric           as techo_ms,
  -- cada corte con su tiempo y su proveedor
  (select jsonb_agg(jsonb_build_object(
            'vuelta', v->>'vuelta', 'ms', v->>'ms',
            'proveedor', v->>'proveedor', 'gen_id', v->>'generation_id',
            'reloj_nuestro', v->>'timeout_nuestro'))
     from jsonb_array_elements(coalesce(context->'llm_error'->'cuerpos_vacios','[]'::jsonb)) v) as cortes,
  -- y el proveedor de las vueltas que SÍ contestaron: ahí el cuerpo llegó,
  -- así que el nombre está. Si qwen tuvo vueltas buenas, el proveedor sale acá.
  context->'tools'->'proveedores'                        as proveedores_de_vueltas_ok
from arena_shadow_journal
where run_date >= '2026-10-01'
  and agent_id in ('qwen','deepseek')
order by created_at desc;
