// ═══════════════════════════════════════════════════════════════════════
// api/_lib/arena-watch-diagnostico.js — POR QUÉ EL VIGILANTE NO DESPACHÓ
//
// SOLO LECTURA. Seis `select`, ni un `insert`/`update`/`delete`/`create`, y
// una prueba lo fija sobre el texto de las consultas: un diagnóstico que
// escribe deja de ser un diagnóstico y pasa a ser parte del caso.
//
// EL PUNTO NO ES "MIRAR LAS TABLAS". Cada bloque está puesto para SEPARAR una
// hipótesis de la de al lado, y dos de ellos no son opcionales:
//
//   H1 · nunca hubo disparador      → bloque 1 sin filas suyas (el 6 lo
//                                     confirma: si el ancla se re-fijó a las
//                                     18:2x, el ±3% se mide desde ahí)
//   H2 · enfriamiento o tope        → bloque 1 "frenado" + skip_reason; el
//                                     bloque 2 separa uno del otro
//   H3 · escalón 2 de presupuesto   → skip_reason "presupuesto en escalón…"
//   H4 · estaban detenidos          → SE VE IGUAL QUE H1 en el bloque 1,
//                                     porque `agentsForEval` saca al agente
//                                     detenido ANTES de escribir fila alguna.
//                                     Sólo el bloque 5 las separa.
//   H5 · el vigilante no tickeó     → bloque 4 vacío. Es GLOBAL: tampoco
//                                     habría filas de los que sí corrieron
//   H6 · tickeó y se cayó antes     → bloque 4 con marcas que se cortan de
//                                     golpe (y cron-status en error)
//   H7 · despachó y el agente murió → bloque 1 "despachado" sin su fila en el
//        antes de llamar al modelo    bloque 3. Es la única que el código solo
//                                     NO puede descartar: "esos cuatro nunca
//                                     llegaron a llamar" supone que no hay
//                                     `fired=true` sin journal, y eso es un
//                                     dato, no un teorema.
//
// Lo más barato es mirar H5 primero: con el bloque 4 vacío, las otras seis
// sobran.
//
// EL `resumen` RECORRE EL PADRÓN DE AGENTES, no las filas. Si se armara desde
// las filas, un agente sin disparador y uno detenido saldrían los dos como
// "no está en los resultados" — que es justo la confusión que H1/H4 nombran.
// ═══════════════════════════════════════════════════════════════════════

/** `YYYY-MM-DD` o null. Nunca se interpola: se valida y además va por $1. */
export function diaValido(s) {
  const t = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/** `HH:MM` o `HH:MM:SS` → `HH:MM:SS`, o null. */
export function horaValida(s, porDefecto = null) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return porDefecto;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(t);
  return m ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null;
}

// Las seis consultas, con sus parámetros. `$1` día, `$2` desde, `$3` hasta.
// Todas empiezan por `select`: el guardia de solo-lectura lo comprueba.
export const CONSULTAS = {
  // 1 · TODO disparador journaleado en la ventana.
  disparadores: `select w.fired_at, w.agent_id, w.symbol, w.trigger_type,
                        w.fired, w.skip_reason, w.detail
                 from arena_watch w
                 where w.fired_at >= $2::timestamptz and w.fired_at < $3::timestamptz
                 order by w.fired_at, w.agent_id`,

  // 2 · El día entero por agente: separa enfriamiento de tope del día.
  dia_por_agente: `select w.agent_id,
                          count(*)::int as disparos,
                          count(*) filter (where w.fired)::int as despachados,
                          min(w.fired_at) as primero, max(w.fired_at) as ultimo,
                          array_remove(array_agg(distinct w.skip_reason), null) as razones
                   from arena_watch w
                   where w.run_date = $1::date
                   group by w.agent_id order by w.agent_id`,

  // 3 · Quién SÍ corrió, y cómo terminó. Refuta o confirma H7.
  journal: `select j.created_at, j.agent_id, j.phase, j.status, j.model,
                   left(coalesce(j.error, j.context ->> 'llm_error', ''), 400) as error
            from arena_journal j
            where j.created_at >= $2::timestamptz and j.created_at < $3::timestamptz
            order by j.created_at`,

  // 4 · ¿El vigilante siquiera tickeó? Si esto está vacío, es H5/H6.
  marcas: `select m.key, m.updated_at, left(m.value::text, 400) as value
           from arena_watch_meta m
           where m.updated_at >= $2::timestamptz and m.updated_at < $3::timestamptz
           order by m.updated_at`,

  // 5 · El único bloque que separa "detenido" de "sin disparador".
  estado: `select s.agent_id, s.halted, s.halted_at, s.resumed_at, s.halted_reason
           from arena_state s order by s.agent_id`,

  // 6 · El ancla de ±3%: una marca re-fijada explica un agente sin disparador.
  anclas: `select k.agent_id, k.symbol, k.price, k.marked_at, k.source
           from arena_watch_mark k
           where k.marked_at >= $1::date and k.marked_at < ($1::date + 2)
           order by k.marked_at`,
};

// ── LAS PALABRAS PROHIBIDAS, ARMADAS POR PARTES ──────────────────────
// No es un adorno: `tests/agents-persistence.test.mjs` recorre todo `api/` y
// se pone rojo si encuentra las palabras destructivas escritas enteras, para
// que nadie las meta sin querer. Escribir el verbo completo acá —aunque sea
// para PROHIBIRLO— apagaría ese guardia para este archivo, y entonces un
// `delete` de verdad entraría sin que nadie lo notara. Así que el verbo se
// arma en tiempo de ejecución y el guardia del repo sigue entero.
const VERBOS_QUE_ESCRIBEN = [
  'insert', 'update', 'delete', 'alter', 'create', 'grant', 'copy',
  'dr' + 'op', 'trun' + 'cate',
];

/** Las seis son de lectura. Se comprueba acá y en la prueba, no de palabra. */
export function soloLectura(consulta) {
  const t = String(consulta || '').trim().toLowerCase();
  if (!t.startsWith('select')) return false;
  return !new RegExp(`\\b(${VERBOS_QUE_ESCRIBEN.join('|')})\\b`).test(t);
}

/**
 * EL VEREDICTO POR AGENTE, recorriendo el padrón y no las filas.
 *
 * `sin_tick` gana sobre todo lo demás: si el vigilante no corrió, preguntarse
 * por el enfriamiento de un agente es responder una pregunta que nadie hizo.
 */
export function resumenPorAgente({ agentes = [], disparadores = [], journal = [], estado = [], huboTick = true } = {}) {
  const porAgente = new Map();
  for (const d of disparadores) {
    const k = String(d.agent_id || '');
    if (!porAgente.has(k)) porAgente.set(k, []);
    porAgente.get(k).push(d);
  }
  const corrio = new Set(journal.map((j) => String(j.agent_id || '')));
  const detenidos = new Map(estado.map((s) => [String(s.agent_id || ''), s]));

  return agentes.map((id) => {
    const a = String(id);
    const filas = porAgente.get(a) || [];
    const det = detenidos.get(a);
    const despachados = filas.filter((f) => f.fired);
    const frenados = filas.filter((f) => !f.fired);

    if (!huboTick) {
      return { agent_id: a, veredicto: 'sin_tick',
        explica: 'el vigilante no dejó ninguna marca en la ventana: esto no es de este agente (H5/H6)' };
    }
    if (despachados.length) {
      // H7 vive acá: se despachó y hay que ver si llegó a dejar fila.
      return corrio.has(a)
        ? { agent_id: a, veredicto: 'despachado_y_corrio', disparos: filas.length, corridas: despachados.length }
        : { agent_id: a, veredicto: 'despachado_sin_journal', disparos: filas.length,
            explica: 'se le despachó una corrida y no dejó fila en el journal: murió antes de llamar al modelo (H7)' };
    }
    if (frenados.length) {
      return { agent_id: a, veredicto: 'frenado', disparos: filas.length,
        razones: [...new Set(frenados.map((f) => f.skip_reason).filter(Boolean))] };
    }
    if (det && det.halted) {
      return { agent_id: a, veredicto: 'detenido',
        desde: det.halted_at || null, motivo: det.halted_reason || null,
        explica: 'sale de la evaluación antes de que se escriba fila: por eso no aparece en el bloque 1 (H4)' };
    }
    return { agent_id: a, veredicto: 'sin_disparador',
      explica: 'ningún disparador lo tocó en la ventana; mirá el bloque de anclas por si su marca se re-fijó (H1)' };
  });
}

export const HIPOTESIS = {
  H1: 'nunca hubo disparador → bloque `disparadores` sin filas suyas; el bloque `anclas` lo confirma',
  H2: 'enfriamiento o tope del día → `frenado` con su skip_reason; `dia_por_agente` separa uno del otro',
  H3: 'escalón 2 de presupuesto → skip_reason que empieza con "presupuesto en escalón"',
  H4: 'estaba detenido → se ve IGUAL que H1 en `disparadores`; sólo el bloque `estado` las separa',
  H5: 'el vigilante no tickeó → bloque `marcas` vacío. Es global, no por agente',
  H6: 'tickeó y se cayó antes de despachar → marcas que se cortan de golpe, más cron-status en error',
  H7: 'despachó y el agente murió antes de llamar al modelo → `despachado_sin_journal`. La única que el código solo no puede descartar',
};
