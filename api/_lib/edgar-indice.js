// ═══════════════════════════════════════════════════════════════════════
// api/_lib/edgar-indice.js — EL ÍNDICE DIARIO DE EDGAR
//
// Hasta el 2026-10-22, los insiders salían del feed `getcurrent` de EDGAR:
// una ventana de los últimos ~200 filings, de todos los formularios. Eso
// contesta "qué acaba de pasar" y NO contesta "qué pasó el martes": si en una
// hora se presentan 300 Form 4, los primeros se caen de la ventana antes de
// que el cron los vea. La pantalla lo decía ("un arranque en frío sólo ve la
// ventana"), que es honesto y es poco.
//
// EDGAR publica, además, el índice COMPLETO de cada día:
//
//   /Archives/edgar/daily-index/2026/QTR4/form.20261021.idx
//
// Una línea por filing, todos los formularios, todo el día. Es la lista
// completa contra la que se puede MEDIR si tenemos todo: si el índice del
// martes trae 1.842 líneas de Form 4 y guardamos 1.842, la cobertura es del
// 100% y se puede decir con el número. Sin esa lista no hay denominador, y
// sin denominador "cobertura" es una palabra.
//
// TODO ACÁ ES PURO: entra texto, salen filas. La red, el ritmo y el
// User-Agent los pone `crearCliente` de `edgar.js`, que ya sabe respetar el
// techo de 10 peticiones por segundo de la SEC.
// ═══════════════════════════════════════════════════════════════════════

/** El trimestre de una fecha ISO, que es parte de la ruta del índice. */
export function trimestreDe(fechaIso) {
  const m = Number(String(fechaIso).slice(5, 7));
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  return Math.floor((m - 1) / 3) + 1;
}

/**
 * La URL del índice de un día.
 *
 * `form.idx` y no `master.idx` a propósito: `form` viene ORDENADO por tipo de
 * formulario, así que los Form 4 están juntos; `master` viene por CIK y hay
 * que recorrerlo entero igual. Los dos se parsean acá, porque el de un
 * trimestre completo (`master.idx`) sirve para el relleno inicial.
 */
export function urlIndiceDiario(fechaIso, { tipo = 'form' } = {}) {
  const t = trimestreDe(fechaIso);
  if (!t) return null;
  const compacta = String(fechaIso).slice(0, 10).replace(/-/g, '');
  if (compacta.length !== 8) return null;
  return `https://www.sec.gov/Archives/edgar/daily-index/${compacta.slice(0, 4)}/QTR${t}/${tipo}.${compacta}.idx`;
}

/**
 * LOS ÚLTIMOS N DÍAS HÁBILES, del más nuevo al más viejo.
 *
 * Fines de semana fuera. LOS FERIADOS NO SE MODELAN, y es deliberado: EDGAR
 * no publica índice los días que no abre, así que el 404 ES la respuesta. Un
 * calendario de feriados escrito a mano se pudre solo —ya costó un chip
 * mintiendo tres días— y acá no hace falta: se pregunta y la ausencia del
 * archivo contesta.
 */
export function diasHabiles(hasta, n) {
  const out = [];
  const d = new Date(String(hasta).slice(0, 10) + 'T12:00:00Z');
  if (!Number.isFinite(d.getTime())) return out;
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/** El accession de la ruta del documento: `edgar/data/320193/0000320193-26-000070.txt`. */
export function accessionDeArchivo(archivo) {
  const m = String(archivo || '').match(/(\d{10}-\d{2}-\d{6})/);
  return m ? m[1] : null;
}

/**
 * EL ÍNDICE, PARSEADO. Las dos formas que publica EDGAR.
 *
 *   · `master.idx` va con barras: `CIK|Empresa|Formulario|Fecha|Archivo`;
 *   · `form.idx` va en columnas de ancho fijo, y el ancho CAMBIA entre años.
 *
 * El de columnas no se parte por posición: se lee DESDE LA DERECHA, donde los
 * tres últimos campos tienen forma inconfundible —la ruta empieza con
 * `edgar/data/`, la fecha es `AAAA-MM-DD` y el CIK son dígitos— y lo que
 * queda en medio es el nombre de la empresa, que es el único campo que puede
 * traer cualquier cosa (comas, barras, varios espacios seguidos). Partir por
 * `\s{2,}` se rompe con una empresa cuyo nombre trae dos espacios, y eso
 * existe.
 */
/**
 * La fecha de una fila de índice, en ISO.
 *
 * EDGAR usa DOS formatos según el índice: `20261019` en el diario y
 * `2026-10-19` en el trimestral. Las dos entran acá y sale una sola forma,
 * que es la que la columna `date` de Neon acepta.
 */
// ═══════════════════════════════════════════════════════════════════════
// QUÉ DÍAS EXISTEN SE PREGUNTA, NO SE ADIVINA POR EL CÓDIGO DE ERROR
//
// El código viejo leía la ausencia de un día en el código de respuesta: 404 =
// "EDGAR no publicó, es feriado". Eso está mal por dos lados, y Lety los vio
// los dos contra producción (2026-10-20):
//
//   · LA SEC CONTESTA 403, NO 404, cuando el archivo no existe. Así que el
//     12 de octubre (Columbus Day) y el día de hoy —que todavía no se
//     publica— salían como ERROR en vez de como "no hay archivo".
//   · Y un 403 además es lo que contesta cuando el User-Agent no le gusta, o
//     lo que devuelve un proxy sin salida a sec.gov. O sea que el mismo
//     código significaba tres cosas distintas y el job elegía una.
//
// El directorio del trimestre dice exactamente qué archivos hay. Una
// pregunta, y el feriado deja de ser una inferencia: es un dato.
// ═══════════════════════════════════════════════════════════════════════

/**
 * "NO PUBLICÓ" Y "TODAVÍA NO PUBLICÓ" NO SON LO MISMO.
 *
 * Lety, mirando `/mercado/insiders` (2026-10-20): *"Cobertura del día de hoy:
 * dice «EDGAR no publicó índice ese día». Si es el día en curso, debe decir
 * «todavía no publicado», no lo mismo que un festivo."*
 *
 * Y tiene razón en que son dos cosas: un festivo no va a aparecer nunca y no
 * hay nada que hacer; el día en curso aparece en unas horas y hay que volver
 * a pedirlo. Decirles igual hace que el cron de mañana parezca redundante.
 *
 * EL CORTE NO ES MEDIANOCHE. EDGAR acepta presentaciones hasta las 22:00 ET y
 * publica el índice del día después, o sea alrededor de las 02:00 UTC del día
 * siguiente. Así que a las 23:50 UTC del 20 —que es cuando Lety corrió el
 * job— el índice del 20 todavía no existía, y con un corte a medianoche UTC
 * el día 20 ya contaba como "pasado" y se habría llamado festivo.
 *
 * Por eso un día ausente del listado es festivo sólo si YA pasó su hora de
 * publicación; si no, es "todavía no publicado".
 */
export function estadoDelDia(fechaIso, ahora = new Date()) {
  const f = String(fechaIso).slice(0, 10);
  const hoy = ahora.toISOString().slice(0, 10);
  if (f > hoy) return { estado: 'futuro', motivo: `el ${f} todavía no ocurrió` };
  if (f === hoy) return { estado: 'en_curso', motivo: `el índice del ${f} todavía no se publica: EDGAR lo cierra después de las 22:00 ET` };
  // El día de ayer, antes de las 03:00 UTC, tampoco tuvo su publicación.
  const ayer = new Date(Date.UTC(
    Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1, Number(hoy.slice(8, 10)) - 1,
  )).toISOString().slice(0, 10);
  // El corte es 04:00 UTC y NO 03:00: EDGAR publica a las 02:00 UTC en
  // horario de verano y a las 03:00 en invierno (22:00 ET en los dos casos).
  // Con el corte en 3, en invierno el día de ayer pasaba a "cerrado" justo
  // cuando su índice todavía no estaba, y al no encontrarlo en el listado se
  // habría llamado festivo. Es el mismo horario al que corre el cron.
  if (f === ayer && ahora.getUTCHours() < 4) {
    return { estado: 'en_curso', motivo: `el índice del ${f} todavía no se publica: EDGAR lo cierra después de las 22:00 ET` };
  }
  return { estado: 'cerrado', motivo: null };
}

/** El listado del trimestre al que pertenece esta fecha, en JSON. */
export function urlListadoTrimestre(fechaIso) {
  const t = trimestreDe(fechaIso);
  if (!t) return null;
  const anio = String(fechaIso).slice(0, 4);
  return `https://www.sec.gov/Archives/edgar/daily-index/${anio}/QTR${t}/index.json`;
}

/**
 * Las fechas ISO que el trimestre REALMENTE publicó, de su listado.
 *
 * El listado trae `form.20261019.idx`, `master.20261019.idx`, `company.*` y
 * carpetas. Nos quedamos con el tipo que se pide y se saca su fecha del
 * nombre, que es la única parte del listado en la que vale confiar.
 */
export function diasPublicados(listado, { tipo = 'form' } = {}) {
  const items = (listado && listado.directory && listado.directory.item) || [];
  const re = new RegExp(`^${tipo}\\.(\\d{8})\\.idx$`, 'i');
  const dias = new Set();
  for (const it of items) {
    const m = re.exec(String((it && it.name) || '').trim());
    if (m) dias.add(fechaIsoDeIndice(m[1]));
  }
  return dias;
}

export function fechaIsoDeIndice(crudo) {
  const s = String(crudo || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

export function parseIndiceEdgar(texto) {
  const lineas = String(texto || '').split(/\r?\n/);
  const filas = [];
  let descartadas = 0;
  for (const linea of lineas) {
    const l = linea.trim();
    if (!l) continue;
    // El preámbulo (`Description:`, `Last Data Received:`…), la cabecera de
    // columnas y la línea de guiones. Lo que NO menciona un documento de
    // EDGAR no es una fila que se nos haya escapado: es texto de encabezado.
    if (!l.includes('edgar/data/')) continue;

    let fila = null;
    if (l.includes('|')) {
      const p = l.split('|').map((x) => x.trim());
      // `master.idx`: CIK|Empresa|Formulario|Fecha|Archivo
      if (p.length >= 5 && /^\d+$/.test(p[0])) {
        fila = { cik: p[0], empresa: p[1], form: p[2], fecha: p[3], archivo: p[4] };
      }
    } else {
      // ── LAS DOS FECHAS DE EDGAR ─────────────────────────────────────
      // El índice DIARIO escribe la fecha pegada (`20261019`) y el índice
      // TRIMESTRAL la escribe con guiones (`2026-10-19`). Este regex sólo
      // aceptaba la segunda, así que contra un `form.20261019.idx` de verdad
      // NINGUNA línea casaba: las 991 se iban a `descartadas` y el día salía
      // con 0 Form 4 (Lety, contra producción, 2026-10-20).
      //
      // Y el fixture de la prueba escribía la fecha CON guiones, o sea que
      // medía el formato que yo había supuesto en vez del que EDGAR manda.
      // Es la tercera vez que un fixture escrito a mano no puede
      // desmentirme; por eso la prueba de esto va contra el archivo real.
      //
      // Se aceptan las dos y se normaliza a ISO, porque la columna de Neon es
      // `date` y `20261019` no entra ahí.
      const m = l.match(/^(\S+)\s+(.*?)\s+(\d{1,10})\s+(\d{4}-\d{2}-\d{2}|\d{8})\s+(\S+)$/);
      if (m) fila = { form: m[1], empresa: m[2].trim(), cik: m[3], fecha: fechaIsoDeIndice(m[4]), archivo: m[5] };
    }
    // De acá para abajo, la línea SÍ menciona un documento: si no se
    // entiende, es un formato que cambió y hay que saberlo. `descartadas`
    // cuenta sólo eso — si contara el preámbulo, nunca sería cero y dejaría
    // de servir como alarma.
    if (!fila || !fila.form || !fila.archivo) { descartadas++; continue; }
    const accession = accessionDeArchivo(fila.archivo);
    if (!accession) { descartadas++; continue; }
    filas.push({ ...fila, cik: String(Number(fila.cik)), accession });
  }
  return { filas, descartadas };
}

/**
 * SÓLO LOS FORM 4, y sólo el 4 pelado.
 *
 * `4/A` es una ENMIENDA: corrige un Form 4 anterior y se presenta como
 * documento aparte. Contarla en el denominador haría que la cobertura pidiera
 * guardar dos veces el mismo hecho; dejarla fuera del numerador y dentro del
 * denominador haría que no cerrara nunca. Queda fuera de los dos, y se dice
 * cuántas hubo.
 */
export function form4DelIndice(filas) {
  const todos = (filas || []).filter((f) => /^4(\/A)?$/i.test(String(f.form || '').trim()));
  const pelados = todos.filter((f) => String(f.form).trim() === '4');
  return {
    filas: pelados,
    total: pelados.length,
    enmiendas: todos.length - pelados.length,
  };
}

/**
 * LA COBERTURA DE UN DÍA: cuántos guardamos de cuántos hay.
 *
 * Devuelve el texto exacto que va a la pantalla. Un porcentaje sin los dos
 * números no se puede auditar: "100%" de un denominador equivocado también
 * dice 100%.
 */
export function coberturaDeDia({ fecha, enIndice, guardados, agotados = 0, motivo = null } = {}) {
  if (motivo) return { fecha, pct: null, en_indice: enIndice ?? null, guardados: guardados ?? null, completa: false, texto: motivo };
  const total = Number(enIndice);
  const nuestros = Number(guardados);
  if (!Number.isFinite(total) || total <= 0) {
    // ── NO SE AFIRMA LO QUE NO SE SABE ────────────────────────────────
    // Acá decía "EDGAR no publicó ese día" con total 0, y eso es una
    // AFIRMACIÓN sobre EDGAR sacada de un número nuestro. El 19 de octubre
    // EDGAR había publicado 991 Form 4 y esta línea decía que no publicó
    // (Lety, contra producción, 2026-10-20): el parser no entendía la fecha
    // del índice diario, el día se guardaba en 0, y el 0 se traducía a una
    // frase sobre la SEC.
    //
    // "No publicó" ahora sólo lo dice quien lo sabe: `jobIndice`, que lo leyó
    // del listado del trimestre, y lo manda en `motivo`. Sin motivo, el total
    // en 0 es un problema NUESTRO y se dice así — la regla 2 pide la causa
    // real, y "no se cosechó" es la causa real.
    return { fecha, pct: null, en_indice: total || 0, guardados: nuestros || 0, completa: false,
      texto: `no hay índice de Form 4 guardado para el ${fecha}: el día no se ha cosechado o la cosecha falló` };
  }
  const pct = (nuestros / total) * 100;
  const completa = nuestros >= total;
  return {
    fecha, pct, en_indice: total, guardados: nuestros, completa,
    agotados: Number(agotados) || 0,
    texto: completa
      ? `Cobertura: 100% de los Form 4 del día (${nuestros} de ${total})`
      : `Cobertura: ${pct.toFixed(1)}% de los Form 4 del día (${nuestros} de ${total}) — faltan ${total - nuestros}`
        // "Faltan N" no distingue "todavía no se leyeron" de "no se pudieron
        // leer". Lo segundo no se arregla esperando, así que se dice aparte.
        + (Number(agotados) > 0 ? `, de los cuales ${Number(agotados)} no se pudieron leer` : ''),
  };
}

/**
 * EL XML DEL FORM 4, SACADO DEL ENVÍO COMPLETO.
 *
 * El índice da la ruta del `.txt`: el envío entero, con su cabecera SGML y
 * sus adjuntos. Dentro viene el XML del Form 4. Leerlo de ahí cuesta UNA
 * petición; el camino de antes —pedir `index.json` para saber cómo se llama
 * el XML y después el XML— cuesta DOS. Con 45.000 filings en el relleno, eso
 * son 45.000 peticiones menos a la SEC y la mitad de tiempo para llenarse.
 *
 * Se recorta al documento: `form4Completo` busca con expresiones regulares
 * sobre todo el texto, y la cabecera SGML trae líneas como `ISSUER:` que no
 * son etiquetas pero que no hay por qué pasearle por delante.
 *
 * Devuelve null si el envío no trae un Form 4 — un `4` del índice que resulta
 * no tener `ownershipDocument` es un caso raro y real, y el llamador cae al
 * camino de dos peticiones en vez de darlo por perdido.
 */
export function ownershipDeEnvio(texto) {
  const s = String(texto || '');
  const ini = s.search(/<(?:\w+:)?ownershipDocument\b/i);
  if (ini < 0) return null;
  const cierre = s.search(/<\/(?:\w+:)?ownershipDocument\s*>/i);
  if (cierre < 0) return null;
  const fin = s.indexOf('>', cierre) + 1;
  return s.slice(ini, fin);
}

/** La URL absoluta de un documento del índice (`edgar/data/…/x.txt`). */
export function urlDeArchivo(archivo) {
  const a = String(archivo || '').replace(/^\/+/, '');
  if (!a) return null;
  return `https://www.sec.gov/Archives/${a}`;
}
