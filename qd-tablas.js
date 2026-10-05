// ═══════════════════════════════════════════════════════════════════════
// qd-tablas.js — las tablas densas de R3: más suben, más bajan, más operadas.
//
// PURA Y COMPARTIDA. No pide red, no toca el DOM, no sabe de qué país es la
// fila. Recibe filas YA MEDIDAS —el % viene de `qdPeriodChange`, como manda la
// regla 1— y devuelve tres listas ordenadas más el recuento de lo que quedó
// fuera y por qué.
//
// TRES COSAS QUE ESTE ARCHIVO DECIDE, y las tres son la regla 2 aplicada a una
// tabla:
//
//   1. UNA FILA SIN NÚMERO NO ENTRA, Y SE CUENTA. Un cuadro sin % en el periodo
//      no es "el que menos subió": es uno que no se pudo medir. Ordenarlo con
//      los demás lo colaría al medio de la lista como si valiera cero.
//
//   2. "MÁS SUBEN" SÓLO LLEVA LAS QUE SUBEN. Si en el día sólo subieron tres,
//      la tabla trae tres y lo dice. Rellenar hasta ocho con las que menos
//      bajaron pondría cuatro números rojos bajo un título que promete verdes
//      — y en un universo chico como el de México eso pasa seguido.
//
//   3. EL EMPATE SE ROMPE POR TICKER, no por el orden en que llegaron. Dos
//      cuadros con el mismo % tienen que salir siempre en el mismo orden, o la
//      tabla cambia sola entre repintados y parece que algo se movió.
//
// `module.exports` va detrás de un `typeof` porque el navegador lo carga con un
// <script> clásico: un `export` suelto es SyntaxError y el archivo entero no
// cargaría (ya pasó con `qd-mundo.js`).
// ═══════════════════════════════════════════════════════════════════════

/** Cuántas filas pide el encargo por bloque. */
const FILAS_TABLA = 8;

const numTablas = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Comparador estable: primero el criterio, y los empates por ticker. */
function porValor(clave, desc) {
  return (a, b) => {
    const va = numTablas(a[clave]), vb = numTablas(b[clave]);
    if (va !== vb) return desc ? vb - va : va - vb;
    return String(a.symbol).localeCompare(String(b.symbol));
  };
}

/**
 * Las tres tablas de un mercado.
 *
 * `filas` son objetos `{ symbol, nombre, pct, motivo, precio, importe,
 * importe_motivo }`. El `pct` ya pasó por `qdPeriodChange`: acá no se resta ni
 * se divide ningún precio.
 */
function tablasDeMercado(filas, { n = FILAS_TABLA, error = null } = {}) {
  const todas = Array.isArray(filas) ? filas : [];
  const conPct = todas.filter((f) => numTablas(f.pct) != null);
  const conImporte = todas.filter((f) => numTablas(f.importe) != null);

  const suben = conPct.filter((f) => f.pct > 0).sort(porValor('pct', true)).slice(0, n);
  const bajan = conPct.filter((f) => f.pct < 0).sort(porValor('pct', false)).slice(0, n);
  const operadas = conImporte.sort(porValor('importe', true)).slice(0, n);

  return {
    suben, bajan, operadas,
    // EL RECUENTO DE LO QUE NO ENTRÓ, para que la pantalla lo pueda decir en
    // vez de enseñar una lista corta sin explicación. `sin_cambio` son las que
    // cerraron exactamente planas: no suben ni bajan, y no faltan.
    conteo: {
      // SIN DATO NO ES CERO. Cuando el mapa no se pudo leer, no llega ninguna
      // fila y los conteos quedan todos en 0 — que leídos como un día de
      // mercado dicen "ninguna subió", y eso es FALSO: no hubo con qué medir.
      // El error viaja para que la frase sea la correcta.
      error: error || null,
      total: todas.length,
      con_pct: conPct.length,
      sin_pct: todas.length - conPct.length,
      sin_cambio: conPct.filter((f) => f.pct === 0).length,
      suben_disponibles: conPct.filter((f) => f.pct > 0).length,
      bajan_disponibles: conPct.filter((f) => f.pct < 0).length,
      con_importe: conImporte.length,
      sin_importe: todas.length - conImporte.length,
    },
  };
}

/**
 * La frase que acompaña a un bloque corto. Devuelve null cuando la tabla salió
 * completa: una explicación que sobra es ruido, y la pantalla no la pinta.
 */
function faltanteDeTabla(bloque, conteo, { n = FILAS_TABLA } = {}) {
  if (!conteo) return null;
  // PRIMERO EL ERROR, SIEMPRE. Sin dato no es un día plano: decir "ninguna
  // subió" cuando la lectura falló afirma algo del mercado que nadie midió, y
  // encima manda a mirar la bolsa en vez de la consulta.
  if (conteo.error) return `sin dato: ${conteo.error}`;
  // Y sin una sola emisora tampoco hay nada que afirmar del periodo.
  if (!conteo.total) return 'sin dato: el mapa no trajo ninguna emisora';

  if (bloque === 'operadas') {
    if (conteo.con_importe >= n) return null;
    if (!conteo.con_importe) {
      return 'ninguna emisora trae todavía lo operado: la columna de volumen se llena en la próxima cosecha';
    }
    return `sólo ${conteo.con_importe} de ${conteo.total} ${conteo.con_importe === 1 ? 'trae' : 'traen'} lo operado`;
  }
  const hay = bloque === 'suben' ? conteo.suben_disponibles : conteo.bajan_disponibles;
  if (hay >= n) return null;
  // La concordancia importa: "ninguna subieron" se lee como un error de la
  // pantalla y hace dudar del número que está al lado.
  const verbo = bloque === 'suben'
    ? (hay === 1 ? 'subió' : 'subieron')
    : (hay === 1 ? 'bajó' : 'bajaron');
  if (!hay) return `ninguna ${bloque === 'suben' ? 'subió' : 'bajó'} en este periodo`;
  return `sólo ${hay} ${verbo} en este periodo`;
}

/**
 * LA FRASE DE UNA FUENTE DE "ESTA SEMANA" QUE NO LLENÓ SU PARTE.
 * Devuelve null cuando no hay nada que explicar: una explicación que sobra es
 * ruido, y la pantalla no la pinta.
 *
 * TRES ESTADOS QUE SE CONFUNDÍAN EN UNO. La pantalla decía "sin eventos ni
 * reportes" mientras `/api/mercado-paneles` traía `reportes.filas: 9` (Lety,
 * 2026-10-05). Los nueve existían: caían DESPUÉS de los siete días que se
 * pintan, y el filtro los tiraba sin contarlos. Un conteo que no describe lo
 * que se ve es peor que no tenerlo.
 *
 *   · la fuente falló                          → se dice el error;
 *   · contestó y está vacía de verdad          → "sin cargar" / "sin nada";
 *   · tiene cosas, pero más adelante           → se dice CUÁNTAS.
 *
 * El caso vacío de macro no es igual al de los reportes: `macro_events` es una
 * tabla CURADA A MANO, así que cero eventos significa que nadie la cargó, no
 * que no vaya a pasar nada. Mandar a "mirar otra semana" cuando lo que hace
 * falta es abrir el admin es mandar al lugar equivocado.
 */
function fraseDeFuente(cual, fuentes) {
  const f = fuentes && fuentes[cual];
  if (!f) return null;
  const quien = cual === 'macro' ? 'macro' : 'de reportes';
  if (!f.ok) return `el calendario ${quien} no respondió: ${f.motivo}`;
  if (f.en_ventana > 0) return null;
  if (f.mas_adelante > 0) {
    return cual === 'macro'
      ? `sin eventos macro esta semana · ${f.mas_adelante} más adelante`
      : `sin reportes esta semana · ${f.mas_adelante} más adelante`;
  }
  // `horizonte_dias` lo manda el servidor: sin él, "no hay nada" no dice
  // "nada ¿hasta cuándo?". El 30 es sólo el piso por si llegara una respuesta
  // vieja, no una segunda definición del horizonte.
  const d = f.horizonte_dias || 30;
  return cual === 'macro'
    ? `calendario macro sin cargar: ningún evento en los próximos ${d} días`
    : `el calendario no trae reportes de mega-caps en los próximos ${d} días`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FILAS_TABLA, tablasDeMercado, faltanteDeTabla, fraseDeFuente };
}
