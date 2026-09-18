// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-rechazos.js — que un rechazo ENSEÑE algo.
//
// EL CASO (2026-09-18): deepseek no operó en todo el día. Cuatro corridas, un
// `aborted_malformed_target` y TRES `rejected_tickers` seguidas, las tres por
// pedir el mismo ticker. Su libro quedó congelado desde el día anterior —y no
// por una decisión suya, sino porque cada objetivo se rechazó entero.
//
// LA RAÍZ NO ES QUE EL MODELO SEA TERCO. Es que cada corrida arranca SIN
// MEMORIA de la anterior: el prompt le dice qué tiene y qué puede pedir, pero
// nunca qué pidió y le fue rechazado. Sin esa línea, insistir con el mismo
// nombre no es obstinación — es la única conducta posible. Un rechazo que no
// vuelve al que lo causó se repite siempre, y el costo no es un error en un
// log: son días de temporada sin operar.
//
// Esto NO es una reparación automática ni una sugerencia de qué comprar. Es un
// HECHO sobre la corrida anterior, en el mismo tono que el resto del prompt:
// pediste X, no existe en el universo, tu libro no cambió por eso.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

// Cuántas corridas hacia atrás se miran. Tres cubre el día entero (la cadencia
// son 3 rondas fijas) sin arrastrar el error de anteayer a una sesión nueva.
export const CORRIDAS_ATRAS = 3;

// Tope de nombres que viajan al prompt. Si un modelo emitió veinte símbolos
// inventados, el problema no se arregla listándoselos: se arregla mirando el
// `llm_response`. Cinco alcanzan para el caso real —uno o dos nombres— y
// evitan que un objetivo corrupto se lleve medio prompt.
export const MAX_NOMBRES = 5;

const up = (s) => String(s || '').trim().toUpperCase();

// ── EL BLOQUE DEL PROMPT (puro: se prueba sin DB) ────────────────────
// `filas` son corridas recientes, más nueva primero:
//   { status, created_at, tickers: { desconocidos: [{pedido, normalizado, motivo}] } }
// Devuelve '' cuando no hay nada que enseñar — un prompt no lleva secciones
// vacías que el modelo tenga que aprender a ignorar.
export function bloqueDeRechazos(filas = []) {
  const porNombre = new Map();
  let corridas = 0;

  // `= []` solo cubre `undefined`, no `null` — y `null` es justo lo que
  // devuelve un lector que falló. Sin esta guarda, un hipo de Neon no dejaba
  // al agente sin memoria: lo dejaba sin corrida.
  for (const f of (Array.isArray(filas) ? filas : [])) {
    const desconocidos = (f && f.tickers && f.tickers.desconocidos) || [];
    if (!desconocidos.length) continue;
    corridas++;
    for (const d of desconocidos) {
      // El ticker que se muestra es el que el MODELO escribió, no el
      // normalizado: es el que tiene que dejar de escribir. Si además se
      // normalizó a otra cosa, se dice, porque "SUPERMICRO" y "SMCI" son dos
      // errores distintos.
      const clave = up(d && (d.pedido || d.normalizado));
      if (!clave) continue;
      const prev = porNombre.get(clave) || { pedido: clave, normalizado: null, motivo: null, veces: 0 };
      prev.veces++;
      if (d.normalizado && up(d.normalizado) !== clave) prev.normalizado = up(d.normalizado);
      prev.motivo = prev.motivo || d.motivo || null;
      porNombre.set(clave, prev);
    }
  }

  if (!porNombre.size) return '';

  const nombres = [...porNombre.values()].sort((a, b) => b.veces - a.veces).slice(0, MAX_NOMBRES);
  const lineas = nombres.map((n) => {
    const norm = n.normalizado ? ` (you wrote it in a form that normalises to "${n.normalizado}", which is not in the universe either)` : '';
    const veces = n.veces > 1 ? ` — you have asked for it ${n.veces} times` : '';
    return `- ${n.pedido}${norm}: not in today's universe${veces}.`;
  });

  return [
    'REJECTED IN YOUR PREVIOUS RUN(S) — READ THIS BEFORE WRITING YOUR BOOK:',
    ...lineas,
    '',
    // LA CONSECUENCIA, dicha. Sin ella el modelo puede leer esto como una nota
    // de color y volver a pedirlo: el punto es que ya pagó por hacerlo.
    corridas > 1
      ? `Your last ${corridas} targets were rejected ENTIRELY for this, so NONE of your decisions were executed and your book is unchanged — including the positions you meant to exit.`
      : 'Your last target was rejected ENTIRELY for this, so NONE of your decisions were executed and your book is unchanged — including the positions you meant to exit.',
    'A name that is not in the universe cannot be held today, no matter how good the thesis is. Use the screener to find a name that IS in it, or state your book without that position. Do not ask for it again.',
  ].join('\n');
}

// ── LA LECTURA (toca DB, nunca lanza) ────────────────────────────────
// `tabla` la decide el llamador porque la liga en vivo y la sombra escriben en
// tablas distintas a propósito —una bandera en la misma tabla está a una
// consulta mal escrita de contaminar el post-mortem— y este módulo no tiene
// por qué saber cuál corre.
const TABLAS = { vivo: 'arena_journal', sombra: 'arena_shadow_journal' };

export async function rechazosPrevios(agentId, { vivo = true, corridas = CORRIDAS_ATRAS, deps = {} } = {}) {
  const tabla = TABLAS[vivo ? 'vivo' : 'sombra'];
  const consulta = deps.sql || sql;
  try {
    // Solo las corridas que REALMENTE fueron rechazadas por tickers. Una
    // corrida buena intermedia no borra el aprendizaje —el modelo pudo haber
    // acertado por otro camino— pero tampoco se cuenta como insistencia.
    const filas = await consulta(
      `select status, created_at, context->'tickers' as tickers
         from ${tabla}
        where agent_id = $1
          and status = 'rejected_tickers'
          and created_at > now() - interval '2 days'
        order by created_at desc
        limit $2`,
      [agentId, corridas],
    );
    return (filas || []).map((f) => ({
      status: f.status,
      created_at: f.created_at,
      tickers: typeof f.tickers === 'string' ? JSON.parse(f.tickers) : f.tickers,
    }));
  } catch (e) {
    // Sin memoria se corre como siempre: el peor caso es el comportamiento de
    // hoy, no una corrida menos.
    return [];
  }
}
