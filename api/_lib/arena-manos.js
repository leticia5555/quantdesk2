// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-manos.js — CUÁNTAS MANOS JUGÓ CADA UNO.
//
// EL DATO QUE INVALIDA LA TABLA MÁS QUE EL PISO DE RUIDO (2026-09-25), contado
// sobre siete días:
//
//     control   37 vivas /  0 abortadas        deepseek   9 / 25
//     claude    30 /  0                        qwen       3 / 22
//     grok      18 /  7                        ─────────────────
//     ChatGPT   13 / 13                        liga     123 / 77
//     gemini    13 / 10
//
// **Qwen decidió TRES veces en la semana. Control decidió 37.** El ranking los
// pone en la misma tabla y publica la diferencia como si midiera al modelo.
//
// No es lo mismo que el piso de ruido y es peor. El piso dice *cuánto de la
// distancia entre dos puestos es azar*; esto dice que **dos agentes no jugaron
// el mismo juego**. Un modelo que decide tres veces en cinco sesiones tiene una
// cartera que es sobre todo deriva de precio: sus posiciones las eligió otro
// día y el mercado hizo el resto. Su retorno mide al mercado, no al modelo.
//
// Y la dirección del sesgo NO es obvia, así que no se insinúa: abortar puede
// salvar a un agente de una decisión mala tanto como impedirle una buena. Lo
// único que se puede afirmar es que **no son comparables**, y eso es lo que la
// pantalla dice.
//
// ── UNA ABORTADA NO ES UNA DECISIÓN DE NO OPERAR ─────────────────────
// `ok_no_actions` (miró y decidió quedarse quieto) y `aborted_cuerpo_vacio` (el
// proveedor no contestó) son cosas opuestas: la primera es el modelo actuando,
// la segunda es el modelo ausente. Contarlas juntas haría parecer prudente lo
// que es una falla de infraestructura.
// ═══════════════════════════════════════════════════════════════

const pct1 = (x) => +Number(x).toFixed(1);

// ── LAS FILAS QUE CUENTAN ────────────────────────────────────────────
// Solo `phase = 'decide'` y agentes reales: las filas de liga (`season_started`,
// `rules_changed`, `season_winner`) no son corridas de nadie.
export const CORRIDA_ABORTADA = (estado) => String(estado || '').startsWith('aborted');

// `filas` = [{ agent_id, status }] — lo que devuelve un group-by del journal ya
// expandido, o las filas crudas. Pura: se prueba sin DB.
export function manosPorAgente(filas = []) {
  const m = new Map();
  for (const f of (Array.isArray(filas) ? filas : [])) {
    const id = f && f.agent_id;
    if (!id || id === 'league') continue;
    if (!m.has(id)) m.set(id, { agente: id, vivas: 0, abortadas: 0 });
    const a = m.get(id);
    if (CORRIDA_ABORTADA(f.status)) a.abortadas++; else a.vivas++;
  }
  for (const a of m.values()) {
    a.corridas = a.vivas + a.abortadas;
    a.pct_abortos = a.corridas ? pct1((a.abortadas / a.corridas) * 100) : null;
  }
  return m;
}

// ── ¿SE PUEDEN COMPARAR ESTOS DOS? ───────────────────────────────────
// El criterio es el COCIENTE entre el que más jugó y el que menos, no la
// diferencia: 37 contra 3 y 370 contra 30 son el mismo problema. El corte en 2×
// no sale de una tabla estadística — sale de que a partir de ahí uno tuvo el
// doble de oportunidades de corregir que el otro, y eso ya no es el mismo
// experimento. Se declara como lo que es: un corte elegido, no derivado.
export const RATIO_INCOMPARABLE = 2;

export function comparabilidad(mapa) {
  const filas = [...(mapa instanceof Map ? mapa.values() : (mapa || []))]
    .filter((a) => a && Number.isFinite(a.vivas))
    .sort((x, y) => y.vivas - x.vivas);
  if (filas.length < 2) {
    return { disponible: false, motivo: 'hacen falta al menos dos agentes con corridas para comparar.' };
  }
  const max = filas[0];
  const min = filas[filas.length - 1];
  // Con cero corridas vivas el cociente no existe, y es el caso MÁS grave:
  // un agente que no decidió nunca tiene un retorno que es puro mercado.
  const ratio = min.vivas > 0 ? +(max.vivas / min.vivas).toFixed(1) : null;
  const totalVivas = filas.reduce((s, a) => s + a.vivas, 0);
  const totalAbortos = filas.reduce((s, a) => s + a.abortadas, 0);
  const incomparable = ratio == null || ratio >= RATIO_INCOMPARABLE;

  return {
    disponible: true,
    agentes: filas.length,
    vivas_totales: totalVivas,
    abortadas_totales: totalAbortos,
    pct_abortos_liga: (totalVivas + totalAbortos) ? pct1((totalAbortos / (totalVivas + totalAbortos)) * 100) : null,
    mas: { agente: max.agente, vivas: max.vivas },
    menos: { agente: min.agente, vivas: min.vivas },
    ratio,
    comparables: !incomparable,
    lectura: ratio == null
      ? `${min.agente} no completó NINGUNA corrida en la ventana: su retorno es deriva de precio sobre una cartera que eligió otro día. No está midiendo al modelo.`
      : incomparable
        ? `NO SON COMPARABLES: ${max.agente} decidió ${max.vivas} veces y ${min.agente} ${min.vivas} — ${ratio}× más manos. Un modelo que decide pocas veces tiene una cartera que es sobre todo deriva de precio, y su puesto mide el mercado más que al modelo.`
        : `El que más decidió (${max.agente}, ${max.vivas}) y el que menos (${min.agente}, ${min.vivas}) están dentro de ${ratio}×: la tabla se puede leer como una comparación.`,
    // La dirección del sesgo NO se insinúa: abortar puede salvar a un agente de
    // una decisión mala tanto como impedirle una buena.
    caveat: 'Abortar no es ni bueno ni malo para el resultado: puede ahorrarle a un agente una decisión mala tanto como impedirle una buena. Lo único que se afirma es que dos agentes con muy distinto número de manos NO midieron lo mismo.',
  };
}

// El bloque completo, que es lo que la pantalla publica.
export function manosDeLaLiga(filas = []) {
  const mapa = manosPorAgente(filas);
  return {
    por_agente: Object.fromEntries([...mapa].map(([id, a]) => [id, a])),
    resumen: comparabilidad(mapa),
  };
}
