// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-desagote.js — LA CORRIDA QUE EJECUTA UN ATRASO NO ES UN DÍA
// NORMAL, Y TIENE QUE DECIRLO EN SU PROPIA FILA.
//
// EL CASO: del 2026-09-21 al 24 el `client_order_id` no llevaba la corrida, así
// que cada agente podía tocar cada nombre una vez por día por lado y el resto
// moría con `Alpaca 422: client_order_id must be unique`. 180 órdenes, el 39%
// de la semana, y sobre todo VENTAS — una venta se re-pide y una compra no.
//
// La primera corrida con el id arreglado ejecuta esas ventas de golpe. **Va a
// parecer un evento de mercado y no lo es: es el sistema desagotando.** Si no
// queda marcado, dentro de dos semanas alguien lee "el jueves todos vendieron a
// la vez" y escribe una tesis sobre un bug.
//
// ── SE MIDE, NO SE ESCRIBE UNA FECHA A MANO ──────────────────────────
// La tentación era una constante con el día del deploy. Tres razones para no:
//
//   1. El día del deploy no lo sabe el código, lo sabe una persona — y una
//      constante que alguien tiene que acordarse de poner es una constante que
//      un día no se pone.
//   2. El atraso no se drena en un día parejo. Un agente que corre tres veces
//      lo suelta el primer día; uno que aborta veinte veces lo arrastra una
//      semana. Una fecha única marcaría de más a unos y de menos a otros.
//   3. Un marcador que se apaga solo no hay que acordarse de apagarlo.
//
// Así que la marca sale de los datos: una orden de esta corrida está
// "recuperada" si su (ticker, lado) venía siendo rechazado por id duplicado en
// las corridas recientes del MISMO agente. Cuando el atraso se termina, el
// bloque deja de aparecer sin que nadie toque nada.
//
// ── NUNCA TUMBA LA CORRIDA ───────────────────────────────────────────
// Es una etiqueta de post-mortem, no una decisión. Si la consulta falla se
// devuelve null y la corrida sigue: perder la marca es perder una fila de
// estudio; tumbar la corrida después de operar deja órdenes en Alpaca sin la
// fila que las explica.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

// La firma del fallo, tal como la compone `alpacaFetch`:
//   'Alpaca 422: client_order_id must be unique'
// Se busca por el TEXTO y no por el status, porque un 422 de Alpaca también
// cubre otras cosas (precio fuera de banda, cantidad inválida) y ésas no son
// atraso: son rechazos legítimos que no hay que recuperar.
export const FIRMA_CID_DUPLICADO = /client_order_id/i;

// Cuántos días hacia atrás se busca el atraso. Cuatro cubre la ventana del
// incidente (21 al 24) sin arrastrar un rechazo de la semana anterior a una
// sesión nueva.
export const DIAS_DE_ATRASO = (() => {
  const n = Number(process.env.ARENA_DESAGOTE_DIAS);
  return Number.isFinite(n) && n > 0 && n <= 30 ? Math.floor(n) : 4;
})();

const up = (s) => String(s || '').trim().toUpperCase();
const clave = (sym, side) => `${up(sym)}|${String(side || '').toLowerCase()}`;

// ── PURA: se prueba sin DB ───────────────────────────────────────────
// `ordenes` son las que ESTA corrida mandó (las `enviadas` con result
// 'approved'); `rechazadasAntes` son las filas de las corridas recientes que
// murieron por id duplicado. Devuelve null cuando no hay nada que marcar — una
// corrida normal no lleva el bloque, y un bloque en cero se leería como si
// alguien hubiera medido y dado cero.
export function marcarDesagote({ ordenes = [], rechazadasAntes = [], dias = DIAS_DE_ATRASO } = {}) {
  const atrasadas = new Map();
  for (const r of (rechazadasAntes || [])) {
    if (!r || !r.symbol) continue;
    if (!FIRMA_CID_DUPLICADO.test(String(r.error || ''))) continue;
    const k = clave(r.symbol, r.side);
    const prev = atrasadas.get(k) || { symbol: up(r.symbol), side: String(r.side || '').toLowerCase(), intentos: 0, desde: null };
    prev.intentos++;
    const d = r.run_date ? String(r.run_date).slice(0, 10) : null;
    if (d && (!prev.desde || d < prev.desde)) prev.desde = d;
    atrasadas.set(k, prev);
  }
  if (!atrasadas.size) return null;

  const recuperadas = [];
  for (const o of (ordenes || [])) {
    if (!o || !o.symbol) continue;
    const a = atrasadas.get(clave(o.symbol, o.side));
    if (!a) continue;
    recuperadas.push({
      symbol: up(o.symbol), side: String(o.side || '').toLowerCase(),
      intentos_fallidos: a.intentos, atrasada_desde: a.desde,
      // La intención original importa: es lo que dice si el desagüe es de
      // ventas (lo esperado) o de compras.
      intencion: o.intencion || null,
    });
  }
  if (!recuperadas.length) return null;

  const ventas = recuperadas.filter((r) => r.side === 'sell').length;
  return {
    ordenes_recuperadas: recuperadas.length,
    de_las_mandadas: (ordenes || []).length,
    ventas,
    compras: recuperadas.length - ventas,
    simbolos: recuperadas,
    atrasada_desde: recuperadas.map((r) => r.atrasada_desde).filter(Boolean).sort()[0] || null,
    ventana_dias: dias,
    // La frase se arma UNA vez acá: la página, la auditoría y el post-mortem
    // dicen lo mismo o un día difieren.
    nota: `DESAGÜE: ${recuperadas.length} de ${(ordenes || []).length} órdenes de esta corrida son de un (ticker, lado) que venía siendo rechazado por \`client_order_id\` duplicado. NO son actividad nueva del modelo: son el atraso saliendo. El turnover y el número de órdenes de esta corrida NO se promedian con los de un día normal; el return sí sigue siendo comparable.`,
  };
}

// ── LECTURA (toca DB, nunca lanza) ───────────────────────────────────
// Las órdenes recientes de ESTE agente que murieron en el envío. Se proyecta
// solo lo que `marcarDesagote` mira; el resto de `context` pesa y no se usa.
export async function rechazosDeEnvio(agentId, { dias = DIAS_DE_ATRASO, deps = {} } = {}) {
  const consulta = deps.sql || sql;
  try {
    const filas = await consulta(
      `select run_date, context->'ejecucion'->'enviadas' as enviadas
         from arena_journal
        where phase = 'decide' and agent_id = $1
          and context->'ejecucion' ? 'enviadas'
          and run_date >= (current_date - ($2 || ' days')::interval)
        order by created_at desc
        limit 40`,
      [agentId, String(dias)],
    );
    const out = [];
    for (const f of (filas || [])) {
      const enviadas = typeof f.enviadas === 'string' ? JSON.parse(f.enviadas) : f.enviadas;
      for (const e of (Array.isArray(enviadas) ? enviadas : [])) {
        if (!e || e.result !== 'submit_failed') continue;
        out.push({ run_date: f.run_date, symbol: e.symbol, side: e.side, error: e.error || null });
      }
    }
    return out;
  } catch {
    // Sin el atraso se corre igual: el peor caso es una corrida sin marca, no
    // una corrida menos.
    return [];
  }
}
