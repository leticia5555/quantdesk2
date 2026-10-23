// ═══════════════════════════════════════════════════════════════
// api/_lib/liga-decisiones.js — la vista `liga_decisiones`: cada orden LLENA
// del journal en vivo, con su resultado a 1, 3 y 5 sesiones.
//
// SOLO LECTURA, Y UNA VISTA, NO UNA TABLA. No se guarda nada nuevo: se cruza lo
// que ya está en `arena_journal.actions` (los fills que escribe el reconcile)
// con los cierres que ya guarda `mercado_precios_us`. Si mañana se corrige un
// cierre, la vista lo refleja sola; una tabla derivada se quedaría con el viejo.
//
// LAS DEFINICIONES, para que el número se pueda reproducir a mano:
//   · ORDEN LLENA: `filled_qty > 0` y `filled_avg_price > 0` (las parciales
//     entran, con su cantidad llena y su `order_status`).
//   · DÍA DEL FILL: `filled_at` en hora del Este (el día de mercado, no UTC).
//   · SESIÓN k: la k-ésima fecha con cierres en `mercado_precios_us`
//     ESTRICTAMENTE posterior al día del fill. El cierre del propio día del
//     fill no cuenta: la sesión 1 es el día siguiente.
//   · RESULTADO: (cierre_k − precio de ejecución) / precio de ejecución, en %,
//     con signo según el lado: una venta gana si el precio BAJA.
//   · Con el cierre SIN AJUSTAR (`cierre`, no `cierre_ajustado`): el precio de
//     ejecución tampoco está ajustado, y compararlo contra una serie ajustada
//     por dividendos movería el resultado de cada orden vieja cada vez que
//     hay un dividendo nuevo.
//
// NULL, NUNCA 0: si el símbolo no está en `mercado_precios_us` (la tabla cubre
// el universo del mapa, no el del Arena), o si la sesión k todavía no ocurrió,
// el resultado es null. Un 0 diría "no se movió".
// ═══════════════════════════════════════════════════════════════

export const VISTA_DECISIONES = `create or replace view liga_decisiones as
with sesiones as (
  select fecha, row_number() over (order by fecha) as n
    from (select distinct fecha from mercado_precios_us) d
),
fills as (
  select j.id as corrida_id, j.agent_id, j.run_date,
         a.ord::int as orden_n,
         upper(a.x->>'symbol') as symbol,
         lower(a.x->>'side') as lado,
         a.x->>'order_status' as order_status,
         (a.x->>'filled_qty')::numeric as cantidad,
         (a.x->>'filled_avg_price')::numeric as precio_ejecucion,
         (a.x->>'filled_at')::timestamptz as filled_at,
         ((a.x->>'filled_at')::timestamptz at time zone 'America/New_York')::date as dia_fill,
         a.x->>'client_order_id' as client_order_id,
         a.x->>'alpaca_order_id' as alpaca_order_id
    from arena_journal j
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(j.actions) = 'array' then j.actions else '[]'::jsonb end
    ) with ordinality as a(x, ord)
   where (a.x->>'filled_qty') ~ '^[0-9.]+$' and (a.x->>'filled_qty')::numeric > 0
     and (a.x->>'filled_avg_price') ~ '^[0-9.]+$' and (a.x->>'filled_avg_price')::numeric > 0
     and a.x->>'filled_at' is not null
     and lower(a.x->>'side') in ('buy', 'sell')
),
base as (
  select f.*,
         (select min(s.n) from sesiones s where s.fecha > f.dia_fill) as n1
    from fills f
)
select b.corrida_id, b.agent_id, b.run_date, b.orden_n, b.symbol, b.lado, b.order_status,
       b.cantidad, b.precio_ejecucion, b.filled_at, b.dia_fill,
       b.client_order_id, b.alpaca_order_id,
       s1.fecha as fecha_1, p1.cierre as cierre_1,
       s3.fecha as fecha_3, p3.cierre as cierre_3,
       s5.fecha as fecha_5, p5.cierre as cierre_5,
       round(case when b.lado = 'sell' then -1 else 1 end * (p1.cierre - b.precio_ejecucion) / b.precio_ejecucion * 100, 4) as resultado_1_pct,
       round(case when b.lado = 'sell' then -1 else 1 end * (p3.cierre - b.precio_ejecucion) / b.precio_ejecucion * 100, 4) as resultado_3_pct,
       round(case when b.lado = 'sell' then -1 else 1 end * (p5.cierre - b.precio_ejecucion) / b.precio_ejecucion * 100, 4) as resultado_5_pct
  from base b
  left join sesiones s1 on s1.n = b.n1
  left join sesiones s3 on s3.n = b.n1 + 2
  left join sesiones s5 on s5.n = b.n1 + 4
  left join mercado_precios_us p1 on p1.symbol = b.symbol and p1.fecha = s1.fecha
  left join mercado_precios_us p3 on p3.symbol = b.symbol and p3.fecha = s3.fecha
  left join mercado_precios_us p5 on p5.symbol = b.symbol and p5.fecha = s5.fecha`;

export const COLUMNAS_NUMERICAS = ['cantidad', 'precio_ejecucion', 'cierre_1', 'cierre_3', 'cierre_5', 'resultado_1_pct', 'resultado_3_pct', 'resultado_5_pct'];

// Lo que el endpoint consulta. `agent` y `desde` opcionales; los dos van como
// parámetros, nunca interpolados.
export const SQL_DECISIONES = `select * from liga_decisiones
 where ($1::text is null or agent_id = $1)
   and ($2::date is null or dia_fill >= $2::date)
 order by filled_at, corrida_id, orden_n`;

const num = (x) => (x == null ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
const dia = (x) => (x == null ? null : (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)));

// Una fila de la vista → JSON. Los numeric de Postgres llegan como string.
export function filaDecision(r) {
  const out = { ...r };
  for (const k of COLUMNAS_NUMERICAS) out[k] = num(r[k]);
  for (const k of ['run_date', 'dia_fill', 'fecha_1', 'fecha_3', 'fecha_5']) out[k] = dia(r[k]);
  if (r.filled_at instanceof Date) out.filled_at = r.filled_at.toISOString();
  return out;
}
