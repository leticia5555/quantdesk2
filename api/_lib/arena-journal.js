// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-journal.js — LA LISTA DE COLUMNAS, UNA SOLA VEZ.
//
// ── POR QUÉ EXISTE ESTE ARCHIVO ──────────────────────────────────────
// `arena_journal` tenía DOS escritores de corridas completas —el del contrato
// de acciones y el del objetivo— cada uno con su `insert` y su lista de
// columnas escrita a mano. La lista del segundo se fue quedando atrás, una
// columna por vez, y cada hueco se descubrió por un síntoma distinto meses
// después:
//
//   · `account`  — el equity, el cash y las posiciones de una ronda viva
//                  quedaban SOLO dentro del texto del prompt.
//   · `error`    — 84 corridas abortadas en diez días y la ficha decía
//                  `error: null` en todas. Para encontrar los racimos que
//                  cancelaron la sonda de ruta hubo que ir a la base.
//   · `prompt_hash` — encontrado el 2026-09-26 haciendo ESTA constante: el
//                  tercero, y todavía no lo había extrañado nadie. Sin él, el
//                  post-mortem no puede agrupar corridas por versión exacta
//                  del prompt, que es la única forma de saber si un cambio de
//                  redacción movió el comportamiento.
//
// Tres huecos, tres descubrimientos por síntoma, en la MISMA lista. Acordarse
// no funcionó dos veces; no va a funcionar la tercera. Esto es B41 aplicado a
// su caso más reincidente: **la lista de columnas es UNA constante que los dos
// importan, y `tests/arena-journal-columnas.test.mjs` falla si alguien vuelve
// a escribir un `insert into arena_journal` con su propia lista.**
//
// ── LO QUE ESTE ARCHIVO NO HACE ──────────────────────────────────────
// No unifica a los dos escritores en uno. Difieren en cosas REALES —uno arma
// `actions` desde las órdenes del PM y el otro desde `ejecucion.enviadas`, uno
// es idempotente por id y el otro no— y fusionarlos sería el error simétrico
// que B41 llama "fusionar conceptos". Lo que se comparte es la regla: QUÉ
// columnas lleva una corrida. El resto se queda donde estaba.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

// ── LAS COLUMNAS DE UNA CORRIDA COMPLETA ─────────────────────────────
// El ORDEN importa y es histórico: `agent_id` va al final porque se agregó
// después, y hubo lectores por posición. No se reordena para que quede lindo.
export const COLUMNAS_CORRIDA = [
  'id', 'run_date', 'phase', 'status', 'prompt_version', 'prompt_hash',
  'model', 'plan', 'llm_response', 'actions', 'account', 'error',
  'context', 'agent_id',
];

// ── LAS COLUMNAS DE UN ANUNCIO ───────────────────────────────────────
// Las filas con `agent_id='league'` (reglamento, apertura, escalón de gasto,
// mercado cerrado) NO son corridas de nadie: no tienen modelo, ni órdenes, ni
// libro. Su lista corta es DELIBERADA, no un hueco — por eso está declarada
// acá y no se compara contra la de arriba.
export const COLUMNAS_ANUNCIO = [
  'id', 'run_date', 'phase', 'status', 'prompt_version', 'plan', 'context', 'agent_id',
];

const json = (v) => (v == null ? null : JSON.stringify(v));

// ── EL ESCRITOR ──────────────────────────────────────────────────────
// `idempotente` agrega `on conflict (id) do nothing`. Lo usa el camino del
// objetivo, cuyo id lleva el timestamp de la corrida: un reintento del cron no
// puede duplicar la fila. El camino de acciones no lo pide y no se le impone
// —cambiar eso sería cambiar su semántica, no compartir una regla.
//
// `agentePorDefecto` existe porque las filas históricas del Agente #6 no
// llevaban `agent_id`: null → el insignia.
export async function escribirCorrida(row, { idempotente = false, agentePorDefecto = null } = {}) {
  const valores = {
    id: row.id,
    run_date: row.run_date,
    phase: row.phase || 'decide',
    status: row.status,
    prompt_version: row.prompt_version ?? null,
    prompt_hash: row.prompt_hash ?? null,
    model: row.model ?? null,
    plan: row.plan ?? null,
    llm_response: row.llm_response ?? null,
    // `actions` puede venir ya serializado (el camino del objetivo lo arma
    // con su propio mapeo) o como array. Las dos formas se aceptan: obligar a
    // una sería mover trabajo del caller acá sin motivo.
    actions: typeof row.actions === 'string' ? row.actions : json(row.actions),
    account: json(row.account),
    error: row.error ?? null,
    context: typeof row.context === 'string' ? row.context : json(row.context),
    agent_id: row.agent_id ?? agentePorDefecto,
  };
  const marcadores = COLUMNAS_CORRIDA.map((_, i) => '$' + (i + 1)).join(',');
  await sql(
    `insert into arena_journal (${COLUMNAS_CORRIDA.join(', ')})
     values (${marcadores})${idempotente ? ' on conflict (id) do nothing' : ''}`,
    COLUMNAS_CORRIDA.map((c) => valores[c]),
  );
}
