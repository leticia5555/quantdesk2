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

// ── UN ABORTO POR FALTA DE SALDO NO DICE NADA DEL MODELO ─────────────
// Medido en producción el 2026-09-26, sobre los 84 abortos de la temporada:
// **48 eran las cuentas sin crédito.** El 57% de todos los abortos. No era el
// proveedor fallando ni el modelo colgándose: se había acabado el dinero, en
// las DOS cuentas (OpenRouter y Anthropic), en días distintos.
//
// Contarlos junto con "el modelo no contestó" es el mismo error de categoría
// que contar `ok_no_actions` como aborto, y en la dirección opuesta: le carga
// al modelo una falla de la cuenta. Si Qwen tiene 31 abortos y la mitad son
// saldo, sus manos jugadas no son culpa suya, y la tabla que las publica junto
// al retorno está atribuyendo mal.
//
// LAS FIRMAS son literales de producción, cada una con su origen. No se
// generalizó a /credit/i sola: "credit" aparece también en textos que NO son
// falta de fondos (límites de tarjeta, mensajes de crédito de API distintos),
// y un falso positivo acá BORRA un fallo real del modelo de la columna que lo
// tiene que mostrar. Cuando aparezca una firma nueva, se agrega con su fecha.
export const FIRMAS_SIN_SALDO = [
  /requires more credits/i,              // OpenRouter · 33 casos
  /credit balance is too low/i,          // Anthropic  · 13 casos
  /would exceed your available/i,        // OpenRouter ·  2 casos
  /maximum cost exceeds/i,               // OpenRouter ·  1 caso
  /could not verify.{0,20}avail/i,       // OpenRouter ·  1 caso (verificación de saldo)
  /insufficient (funds|credit|balance)/i, // no observada todavía: la forma genérica
];

// El texto puede llegar en `error` (la columna) o dentro de `context.llm_error`
// (el detalle del proveedor). Se miran los dos: la columna se perdía hasta el
// 2026-09-26 y las filas viejas de la temporada la tienen en null.
export function esAbortoDeSaldo(fila) {
  if (!fila || !CORRIDA_ABORTADA(fila.status)) return false;
  const e = fila.llm_error || (fila.context && fila.context.llm_error) || {};
  const texto = [fila.error, e.detail, e.provider_error, e.raw_body]
    .filter((x) => typeof x === 'string').join(' \n ');
  if (!texto) return false;
  return FIRMAS_SIN_SALDO.some((re) => re.test(texto));
}

// `filas` = [{ agent_id, status }] — lo que devuelve un group-by del journal ya
// expandido, o las filas crudas. Pura: se prueba sin DB.
export function manosPorAgente(filas = []) {
  const m = new Map();
  for (const f of (Array.isArray(filas) ? filas : [])) {
    const id = f && f.agent_id;
    if (!id || id === 'league') continue;
    if (!m.has(id)) m.set(id, { agente: id, vivas: 0, abortadas: 0, abortadas_modelo: 0, abortadas_saldo: 0 });
    const a = m.get(id);
    if (!CORRIDA_ABORTADA(f.status)) { a.vivas++; continue; }
    a.abortadas++;
    // Las dos columnas suman `abortadas`, que se conserva: el total sigue
    // siendo el total. Lo que cambia es que ahora se puede decir CUÁL de los
    // dos, y solo una de las dos dice algo del modelo.
    if (esAbortoDeSaldo(f)) a.abortadas_saldo++; else a.abortadas_modelo++;
  }
  for (const a of m.values()) {
    a.corridas = a.vivas + a.abortadas;
    a.pct_abortos = a.corridas ? pct1((a.abortadas / a.corridas) * 100) : null;
    // El porcentaje que SÍ es atribuible al modelo. Es el número que debería
    // leerse al lado del retorno; `pct_abortos` incluye la falla de la cuenta.
    a.pct_abortos_modelo = a.corridas ? pct1((a.abortadas_modelo / a.corridas) * 100) : null;
    // Las manos que el agente HABRÍA jugado si la cuenta hubiera tenido saldo.
    // No es un contrafáctico fuerte —un modelo puede abortar por su cuenta en
    // una corrida que el saldo le impidió intentar— y por eso se llama `techo`
    // y no `vivas_reales`: es una COTA, no una estimación.
    a.techo_de_manos = a.vivas + a.abortadas_saldo;
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
  const totalSaldo = filas.reduce((s, a) => s + (a.abortadas_saldo || 0), 0);
  const totalModelo = totalAbortos - totalSaldo;
  const incomparable = ratio == null || ratio >= RATIO_INCOMPARABLE;

  return {
    disponible: true,
    agentes: filas.length,
    vivas_totales: totalVivas,
    abortadas_totales: totalAbortos,
    // El corte que cambia a quién se le carga la falla.
    abortadas_saldo: totalSaldo,
    abortadas_modelo: totalModelo,
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
    // ── DE QUIÉN ES LA FALLA ─────────────────────────────────────────
    // Sale aparte de `lectura` y no mezclado adentro: son dos objeciones
    // distintas a la tabla y juntarlas en un párrafo hace que se lea una sola.
    // `lectura` dice que no jugaron el mismo juego; esto dice que una parte de
    // la diferencia no es del modelo.
    culpa: totalSaldo > 0
      ? `${totalSaldo} de los ${totalAbortos} abortos fueron LA CUENTA SIN SALDO, no el modelo (${pct1((totalSaldo / totalAbortos) * 100)}%). Esos no dicen nada sobre el modelo: un agente cuya cuenta se quedó sin crédito no jugó menos manos por ser peor. Los ${totalModelo} restantes sí son del modelo o de su proveedor.`
      : null,
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
