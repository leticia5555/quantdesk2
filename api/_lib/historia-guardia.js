// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-guardia.js — los guardias de la salida. Rebanada I.
//
// El módulo entero descansa en dos promesas: *toda afirmación lleva su cita*
// y *nada de predecir precio, calificar ni recomendar*. Un prompt que las
// pide es una intención; esto es lo que las hace propiedades.
//
// ── POR QUÉ VA ANTES DE LA EXTRACCIÓN ───────────────────────────────
// La extracción de cuerpos (§11.8) es exactamente por donde entraría una cita
// inventada: hoy el modelo no puede alucinar el nombre de un CFO porque no
// tiene ninguno. El guardia tiene que estar ANTES, no después — y el
// verificador literal de abajo es el mismo que la compuerta H3 va a usar para
// los fragmentos textuales.
//
// ── QUÉ SE CORTA, Y CON QUÉ GRANULARIDAD ────────────────────────────
// Decisión 4 de la Fase B: se corta la afirmación si se puede aislar, la
// sección si no, y se dice en pantalla que se cortó. **Un hueco declarado es
// un dato; uno silencioso es un bug.**
//
// La unidad de corte es la ORACIÓN, no el párrafo: una cita inventada en la
// tercera oración no tiene por qué llevarse las dos buenas. Y si después de
// cortar no queda nada, se cae la sección entera — una sección vacía que se
// muestra como si fuera corta miente por omisión.
//
// ── LOS TRES GUARDIAS ───────────────────────────────────────────────
//   1. CITAS      — una `[accession]` que no está en el inventario. Es el
//                   guardia que sostiene el diferenciador del producto.
//   2. OPINIÓN    — precio, calificación, recomendación. Prohibido por §8 y
//                   por el encargo, no por gusto.
//   3. RELATIVO A HOY — "recientemente", "actualmente". La narración se
//                   guarda con el hash de su evidencia y se sirve durante
//                   meses (§11.3); "hace poco" envejece mintiendo. Es la
//                   decisión de no meter nada relativo a hoy, hecha
//                   ejecutable.
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// El verificador literal
// ─────────────────────────────────────────────────────────────────────────
//
// Subcadena exacta, normalizando SOLO espacios en blanco. Nada difuso: ni
// distancia de edición, ni "equivalente en significado", ni umbral de
// parecido. Un umbral convierte la cita en una afirmación con buena
// presentación, y ahí se pierde todo lo que el módulo tiene para ofrecer.
//
// Lo que sí se normaliza y por qué: el HTML de EDGAR parte las frases con
// saltos de línea y tabulaciones en lugares arbitrarios, así que una corrida
// de espacios no es una diferencia de contenido. Mayúsculas, acentos,
// comillas y guiones SÍ lo son y no se tocan.
export const normalizarEspacios = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

export function apareceLiteral(fragmento, cuerpo) {
  const f = normalizarEspacios(fragmento);
  if (!f) return false;
  return normalizarEspacios(cuerpo).includes(f);
}

// ─────────────────────────────────────────────────────────────────────────
// Partir en afirmaciones
// ─────────────────────────────────────────────────────────────────────────
//
// La unidad de corte. Partir prosa en oraciones es fácil de hacer mal, y acá
// hacerlo mal tiene consecuencias: una oración partida a la mitad por un
// punto decimal deja media afirmación en pantalla.
//
// Los tres casos que rompen un split ingenuo, y que están probados:
//   · `12.3%` y `1.234,5` — un punto entre dígitos no termina una oración.
//     Lo resuelve la regla de "tiene que seguir un espacio", no un caso
//     especial: había uno y lo saqué porque al mutarlo NO rompía ninguna
//     prueba. Código que parece cargar peso y no lo carga es peor que no
//     tenerlo, porque el próximo que lo lea va a creer que ahí está la
//     defensa.
//   · `EE.UU.` — abreviatura; el texto de §8 la usa. Ésta SÍ hace falta: el
//     punto va seguido de espacio, así que sin la lista se parte al medio.
//   · `[0000320193-25-000073].` — la cita va ANTES del punto, así que el
//     punto sí corta, pero el corchete no puede quedar en la oración que
//     sigue o la cita se le atribuye a la afirmación equivocada.
const ABREVIATURAS = ['EE.UU.', 'ee.uu.', 'S.A.', 'Inc.', 'Corp.', 'Ltd.', 'Co.', 'etc.', 'p.ej.', 'vs.'];

export function partirAfirmaciones(texto) {
  const t = String(texto == null ? '' : texto).trim();
  if (!t) return [];
  const piezas = [];
  let desde = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '.' && c !== '?' && c !== '!') continue;
    // Una abreviatura conocida no termina la oración.
    const cola = t.slice(Math.max(0, i - 8), i + 1);
    if (ABREVIATURAS.some((a) => cola.endsWith(a))) continue;
    // Tiene que seguir un espacio (o el final del texto).
    const sig = t[i + 1];
    if (sig !== undefined && !/\s/.test(sig)) continue;
    piezas.push(t.slice(desde, i + 1).trim());
    desde = i + 1;
  }
  const resto = t.slice(desde).trim();
  if (resto) piezas.push(resto);
  return piezas.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────
// Guardia 1 — las citas
// ─────────────────────────────────────────────────────────────────────────
export const CITA_RE = /\[([A-Za-z0-9][A-Za-z0-9.\-]{2,})\]/g;

export const citasDe = (texto) => [...String(texto || '').matchAll(CITA_RE)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────
// Guardia 2 — la opinión
// ─────────────────────────────────────────────────────────────────────────
//
// La lista es de RAÍCES, no de palabras completas: "recomendamos",
// "recomendable" y "recomendación" son la misma prohibición, y enumerarlas
// una por una es cómo se escapa la cuarta.
//
// El límite está puesto a propósito donde está: describir lo que un documento
// dice no es calificar. *"Avisó que no se puede confiar en sus estados
// financieros [acc]"* es un hecho; *"tiene problemas contables serios"* es una
// conclusión nuestra. Por eso la lista tiene verbos de consejo y adjetivos de
// valuación, y NO tiene palabras como "riesgo" o "problema", que aparecen
// legítimamente al describir lo que un 8-K dice de sí mismo.
// ── LA PROHIBICIÓN ES SOBRE LA VOZ DEL NARRADOR ─────────────────────
//
// La primera versión tenía una sola lista con la raíz `recomend`, y eso
// cortaba **"El consejo recomendó votar a favor [acc]"** — un hecho sobre un
// proxy, y justamente lo que la pregunta 2 existe para decir. Peor: lo hacía
// de forma arbitraria, porque en español el tallo alterna. `recomend` agarra
// "recomendó" y "recomendamos" pero NO "recomienda", así que la misma frase
// pasaba o se cortaba según el tiempo verbal.
//
// El consejo en boca de otro es un HECHO; en la nuestra es una recomendación.
// Por eso la lista de consejo está marcada por persona: primera persona,
// imperativo o adjetivo deóntico. El discurso referido —"el consejo
// recomendó", "la empresa recomienda a sus accionistas"— no entra.
export const RAICES_CONSEJO = [
  'recomendamos', 'recomiendo', 'recomendaría(mos)?', 'recomendable',
  'aconsejamos', 'aconsejo', 'aconsejable',
  'sugerimos', 'sugiero', 'nuestra sugerencia',
  'conviene (comprar|vender|tomar|salir|entrar)',
  'deberías?', 'habría que (comprar|vender)',
  'vale la pena (comprar|invertir)',
  'tomar (una )?posición', 'salir de la posición',
];

// El juicio de valuación, en cambio, es voz del narrador **sin importar la
// persona**: "la acción está barata" no tiene primera persona y es una
// calificación igual. Ésta es la lista que una cita textual sí puede
// necesitar —la carta de un activista dice exactamente esto— y por eso la
// exención de abajo existe.
export const RAICES_VALUACION = [
  'sobreponder', 'infraponder', 'strong buy', 'strong sell',
  'precio objetivo', 'valuación atractiva', 'atractiva a estos precios',
  'está (barata|cara)', 'sobrevalorad', 'infravalorad', 'subvalorad',
  '(buena|mala) inversión',
  'comprar (la )?(acción|acciones)', 'vender (la )?(acción|acciones)',
  'la acción (va a|debería) (subir|bajar)', 'el precio (va a|debería) (subir|bajar)',
  'esperamos que (la acción|el precio)',
];

export const RAICES_OPINION = [...RAICES_CONSEJO, ...RAICES_VALUACION];

const RE_OPINION = new RegExp(`(${RAICES_OPINION.join('|')})`, 'i');

export const tieneOpinion = (texto) => RE_OPINION.test(String(texto || ''));

// ─────────────────────────────────────────────────────────────────────────
// La exención de la cita textual
// ─────────────────────────────────────────────────────────────────────────
//
// **El problema, previsto antes de que apareciera.** La extracción (§11.8) va
// a traer frases TEXTUALES de los documentos, y una carta de un activista
// dice "la acción está infravalorada" con todas las letras. Sin esto, el
// guardia cortaría una cita literal verificada — lo más verificable que el
// módulo tiene. La prohibición es sobre la voz del narrador, no sobre texto
// entre comillas comprobado contra el cuerpo.
//
// Las comillas son `«…»` y no `"…"` a propósito: el delimitador es
// load-bearing —decide qué se exime de un guardia— y las comillas rectas
// aparecen solas en prosa. Un delimitador inequívoco vale más que uno
// natural cuando de él cuelga una propiedad de seguridad.
//
// **FAIL-CLOSED, y es la parte que importa.** Una cita que NO se puede
// verificar contra el cuerpo se corta, no se exime. Una comilla sin respaldo
// lava la voz del narrador como si fuera la de la empresa, que es peor que
// decir la misma opinión de frente.
//
// ── CONTRA QUÉ SE VERIFICA: FRAGMENTOS, NO CUERPOS ──────────────────
//
// La primera versión verificaba contra el CUERPO del documento, y eso chocaba
// de frente con el plan de extracción: no se guardan cuerpos — ése es el
// argumento de amortización entero (§11.8). Al narrar no habría contra qué
// comparar.
//
// Lo que se verifica es contra los **fragmentos que la extracción ya
// verificó**. El universo de comillas posibles es ese conjunto, no el
// documento. Así cada comilla en pantalla queda verificada dos veces: una al
// extraer, contra el cuerpo real; otra al narrar, contra el fragmento
// guardado. Y es transitivo — si la comilla está dentro de un fragmento y el
// fragmento estuvo en el cuerpo, la comilla estuvo en el cuerpo. El cuerpo se
// puede tirar.
//
// La segunda verificación no es redundante: sin ella el narrador podría
// escribir una comilla que nunca salió de ningún fragmento, y la primera no
// se enteraría porque ya pasó.
//
// El mapa acepta una cadena o un arreglo de cadenas por accession, así que
// sirve igual con un cuerpo entero (para probar) que con la lista de
// fragmentos (en producción). Lo que NO hace es concatenarlos — ver abajo.
//
// Hoy no hay fragmentos guardados, así que ninguna cita textual verifica y
// ninguna pasa. Es el estado correcto: la exención existe y está cerrada
// hasta que la extracción la abra.
export const COMILLAS_RE = /«([^»]*)»/g;

export const entrecomillados = (texto) => [...String(texto || '').matchAll(COMILLAS_RE)].map((m) => m[1]);

// Devuelve las citas textuales de una afirmación, cada una con si verificó
// contra algún fragmento de los documentos que la afirmación cita.
export function verificarEntrecomillados(afirmacion, verificado) {
  const mapa = verificado instanceof Map ? verificado : new Map(Object.entries(verificado || {}));
  const accs = citasDe(afirmacion);
  return entrecomillados(afirmacion).map((frase) => ({
    frase,
    // Tres condiciones, y ninguna es cosmética:
    //
    //  · contra los fragmentos de ALGUNO de los documentos que la propia
    //    afirmación cita — verificar contra cualquiera dejaría atribuirle a
    //    un papel lo que dijo otro;
    //  · dentro de UN fragmento, nunca repartida entre dos. Si se
    //    concatenaran antes de comparar, el narrador podría coser una frase
    //    que nunca existió contigua en el documento: dos pedazos verdaderos
    //    pegados forman una cita falsa;
    //  · literal, con el mismo verificador de siempre.
    verificada: accs.some((a) => {
      if (!mapa.has(a)) return false;
      const v = mapa.get(a);
      const trozos = Array.isArray(v) ? v : [v];
      return trozos.some((t) => apareceLiteral(frase, t));
    }),
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Guardia 3 — lo relativo a hoy
// ─────────────────────────────────────────────────────────────────────────
//
// La narración se guarda con el hash de su evidencia y se sirve hasta que
// cambia un filing — meses, potencialmente. "Recientemente" escrito en
// septiembre se lee en marzo y miente, con la cita correcta al lado, que es
// la peor combinación.
//
// `reciente` NO entra como raíz suelta: "el filing más reciente" es una
// comparación entre documentos, no una referencia a hoy, y es correcta.
export const RAICES_RELATIVAS = [
  'recientemente', 'hace poco', 'hace unos (días|meses|años)',
  'actualmente', 'hoy en día', 'en estos momentos',
  'en los últimos (días|meses|años)', 'este año', 'el año pasado',
  'al día de hoy', 'hasta ahora', 'por ahora',
];

const RE_RELATIVA = new RegExp(`(${RAICES_RELATIVAS.join('|')})`, 'i');

export const tieneRelativoAHoy = (texto) => RE_RELATIVA.test(String(texto || ''));

// ─────────────────────────────────────────────────────────────────────────
// El guardia completo
// ─────────────────────────────────────────────────────────────────────────
//
// Devuelve las secciones sobrevivientes y el registro de TODO lo que se cortó,
// con su motivo. El registro no es opcional: es lo que la página muestra para
// que el hueco quede declarado.
//
// El texto cortado viaja en el registro. La tentación es no guardarlo —"es
// texto malo"— pero sin él no se puede ver qué dijo el modelo, que es
// exactamente la queja que originó "la cruda se guarda siempre" (§11.4).
export function guardar(secciones = [], citables = new Set(), { verificado = new Map() } = {}) {
  const validas = citables instanceof Set ? citables : new Set(citables || []);
  const cortes = [];
  const salida = [];

  for (const s of secciones) {
    const afirmaciones = partirAfirmaciones(s && s.texto);
    const quedan = [];

    for (const a of afirmaciones) {
      const malas = citasDe(a).filter((c) => !validas.has(c));
      if (malas.length) {
        cortes.push({ seccion: s.id, motivo: 'cita_desconocida', citas: malas, texto: a });
        continue;
      }

      // Una cita textual sin respaldo se corta ANTES que nada más: lava la
      // voz del narrador como si fuera la de la empresa.
      const comillas = verificarEntrecomillados(a, verificado);
      const sinRespaldo = comillas.filter((c) => !c.verificada);
      if (sinRespaldo.length) {
        cortes.push({
          seccion: s.id, motivo: 'cita_textual_no_verificada',
          frases: sinRespaldo.map((c) => c.frase), texto: a,
        });
        continue;
      }

      // Lo entrecomillado y VERIFICADO no es voz nuestra, así que sale del
      // texto antes de buscar opinión. Lo de afuera de las comillas sigue
      // bajo las mismas reglas de siempre.
      const propio = comillas.reduce((t, c) => t.replace(`«${c.frase}»`, ' '), a);

      if (tieneOpinion(propio)) {
        cortes.push({ seccion: s.id, motivo: 'opinion', texto: a });
        continue;
      }
      if (tieneRelativoAHoy(propio)) {
        cortes.push({ seccion: s.id, motivo: 'relativo_a_hoy', texto: a });
        continue;
      }
      quedan.push(a);
    }

    if (!quedan.length) {
      // Se cortó todo lo que decía. Cae la sección: mostrarla vacía o con un
      // resto inerte sería peor que decir que no quedó nada.
      if (afirmaciones.length) cortes.push({ seccion: s.id, motivo: 'seccion_vacia', texto: null });
      continue;
    }
    salida.push({ ...s, texto: quedan.join(' ') });
  }

  const porMotivo = {};
  for (const c of cortes) porMotivo[c.motivo] = (porMotivo[c.motivo] || 0) + 1;

  return {
    secciones: salida,
    cortes,
    resumen: {
      afirmaciones_cortadas: cortes.filter((c) => c.motivo !== 'seccion_vacia').length,
      secciones_cortadas: cortes.filter((c) => c.motivo === 'seccion_vacia').length,
      por_motivo: porMotivo,
    },
    // Lo PRIMERO que se mira es si quedó algo, no si se cortó algo.
    //
    // La versión anterior preguntaba por los cortes primero, y con eso un
    // modelo que devolviera secciones de texto vacío —cero afirmaciones, cero
    // cortes— quedaba en `ok` con nada adentro: una lectura vacía guardada
    // como buena, que la página habría pintado como un bloque en blanco.
    // Lo encontró una prueba escrita para intentar pasar el guardia.
    estado: !salida.length ? 'rechazada' : (cortes.length ? 'ok_con_cortes' : 'ok'),
  };
}
