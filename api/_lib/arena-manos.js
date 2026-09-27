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
export const errorDeFila = (fila) =>
  (fila && (fila.llm_error || (fila.context && fila.context.llm_error))) || {};

export function esAbortoDeSaldo(fila) {
  if (!fila || !CORRIDA_ABORTADA(fila.status)) return false;
  const e = errorDeFila(fila);
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
    if (!m.has(id)) {
      m.set(id, {
        agente: id, vivas: 0, abortadas: 0,
        // TRES culpas, no dos. Las tres suman `abortadas`, que se conserva: el
        // total sigue siendo el total. Lo que cambia es que se puede decir de
        // quién es cada uno — y DOS de las tres no dicen nada del modelo.
        abortadas_saldo: 0, abortadas_nuestras: 0, abortadas_modelo: 0,
      });
    }
    const a = m.get(id);
    if (!CORRIDA_ABORTADA(f.status)) { a.vivas++; continue; }
    a.abortadas++;
    const culpa = culpaDelAborto(f);
    if (culpa === 'saldo') a.abortadas_saldo++;
    else if (culpa === 'nuestra') a.abortadas_nuestras++;
    else a.abortadas_modelo++;
  }
  for (const a of m.values()) {
    a.corridas = a.vivas + a.abortadas;
    a.pct_abortos = a.corridas ? pct1((a.abortadas / a.corridas) * 100) : null;
    // ── `abortadas_modelo` ES UN RESIDUAL, NO UNA MEDICIÓN ───────────
    // Es "lo que quedó después de sacar lo que sabemos que no es del modelo".
    // Adentro puede seguir habiendo causas nuestras que todavía no sabemos
    // reconocer —el corte por `time_budget`, por ejemplo, es el presupuesto
    // funcionando, no el modelo fallando— así que este número es una COTA
    // SUPERIOR de la culpa del modelo, y la pantalla lo dice como cota.
    //
    // La distinción importa: un residual que se lee como medición convierte
    // "no pudimos atribuirlo" en "fue el modelo".
    a.pct_abortos_modelo = a.corridas ? pct1((a.abortadas_modelo / a.corridas) * 100) : null;
    a.abortadas_no_suyas = a.abortadas_saldo + a.abortadas_nuestras;
    // Las manos que el agente HABRÍA jugado si no le hubiéramos sacado
    // corridas nosotros —sin saldo, o con una vuelta que no podía pagar—.
    // No es un contrafáctico fuerte —un modelo puede abortar por su cuenta en
    // una corrida que otra cosa le impidió intentar— y por eso se llama `techo`
    // y no `vivas_reales`: es una COTA, no una estimación.
    a.techo_de_manos = a.vivas + a.abortadas_no_suyas;
  }
  return m;
}

// ── Y LA TERCERA CULPA: NUESTRA ─────────────────────────────────────
// Encontrada el 2026-09-27, al separar el saldo: **con dos columnas, nuestro
// propio bug caía en la del modelo.**
//
// B45: el loop arrancaba vueltas con diez segundos —una banda de exactamente
// el ancho del piso, entre la guarda y el techo— y esas vueltas se morían
// leyendo el cuerpo. De los 23 `cuerpo_vacio` de la temporada, **13 eran
// nuestro reloj**, y estaban concentrados en Qwen y DeepSeek: los dos que peor
// se ven en la tabla. O sea que nuestro error de aritmética estaba anotado en
// el expediente de los dos agentes a los que más perjudicaba.
//
// LA FIRMA NO ES UN MENSAJE, ES UN CAMPO. `timeout_nuestro` lo instrumentó B23
// justamente para distinguir nuestro corte del suyo, así que acá no hace falta
// ninguna lista de literales — y una lista sería peor: el mensaje cambia con el
// proveedor, el campo no.
//
// Se miran los DOS lugares donde vive: el resumen de la corrida, y cada vuelta
// por separado en `cuerpos_vacios[]`. Una corrida puede tener un corte suyo en
// la vuelta 3 y uno nuestro en el cierre; si UNO fue nuestro, la corrida no se
// le carga al modelo. La duda se resuelve a favor del modelo a propósito: es
// el que no puede defenderse en el journal.
export function esAbortoNuestro(fila) {
  if (!fila || !CORRIDA_ABORTADA(fila.status)) return false;
  const e = errorDeFila(fila);
  if (e.timeout_nuestro === true) return true;
  const cortes = Array.isArray(e.cuerpos_vacios) ? e.cuerpos_vacios : [];
  return cortes.some((c) => c && c.timeout_nuestro === true);
}

// ── EL ORDEN DE PRECEDENCIA, DECLARADO ───────────────────────────────
// No se solapan en la práctica —una cuenta sin saldo devuelve un cuerpo de
// error rápido, no un stream que se corta— pero el orden se declara igual: si
// algún día se solapan, que la clasificación sea la misma todos los días y no
// dependa de cómo quedó escrito el if.
//
// SALDO primero: si no había dinero, la llamada no podía ocurrir, y cualquier
// otra cosa que se observe es consecuencia de eso.
export const CULPAS = ['saldo', 'nuestra', 'modelo'];
export function culpaDelAborto(fila) {
  if (!CORRIDA_ABORTADA(fila && fila.status)) return null;
  if (esAbortoDeSaldo(fila)) return 'saldo';
  if (esAbortoNuestro(fila)) return 'nuestra';
  // RESIDUAL, no medición. Ver el comentario de `abortadas_modelo`.
  return 'modelo';
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
  const totalNuestras = filas.reduce((s, a) => s + (a.abortadas_nuestras || 0), 0);
  const totalModelo = totalAbortos - totalSaldo - totalNuestras;
  const incomparable = ratio == null || ratio >= RATIO_INCOMPARABLE;

  return {
    disponible: true,
    agentes: filas.length,
    vivas_totales: totalVivas,
    abortadas_totales: totalAbortos,
    // El corte que cambia a quién se le carga la falla. TRES, no dos.
    abortadas_saldo: totalSaldo,
    abortadas_nuestras: totalNuestras,
    // Residual: cota SUPERIOR de la culpa del modelo, no una medición.
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
    culpa: (totalSaldo + totalNuestras) > 0
      ? `De los ${totalAbortos} abortos, ${totalSaldo + totalNuestras} NO son de los modelos: `
        + [
          totalSaldo ? `${totalSaldo} fueron LA CUENTA SIN SALDO` : null,
          totalNuestras ? `${totalNuestras} fueron NUESTRO reparto de reloj (el loop arrancaba vueltas que no podía pagar)` : null,
        ].filter(Boolean).join(' y ')
        + '. Un agente no jugó menos manos por ser peor'
        // El número que Lety quiere poder leer de un saque, y con la palabra
        // que lo vuelve honesto: COMO MUCHO. `abortadas_modelo` es lo que
        // quedó sin atribuir, no lo que se midió del modelo.
        + `. Como mucho ${totalModelo} son de los modelos, y ése es un residual —lo que no pudimos atribuir— no una medición: adentro puede seguir habiendo causas nuestras que todavía no sabemos reconocer.`
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
