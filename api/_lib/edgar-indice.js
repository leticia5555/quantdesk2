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
      // Desde la derecha: archivo, fecha, CIK; el resto es el nombre.
      const m = l.match(/^(\S+)\s+(.*?)\s+(\d{1,10})\s+(\d{4}-\d{2}-\d{2})\s+(\S+)$/);
      if (m) fila = { form: m[1], empresa: m[2].trim(), cik: m[3], fecha: m[4], archivo: m[5] };
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
export function coberturaDeDia({ fecha, enIndice, guardados, motivo = null } = {}) {
  if (motivo) return { fecha, pct: null, en_indice: enIndice ?? null, guardados: guardados ?? null, completa: false, texto: motivo };
  const total = Number(enIndice);
  const nuestros = Number(guardados);
  if (!Number.isFinite(total) || total <= 0) {
    return { fecha, pct: null, en_indice: total || 0, guardados: nuestros || 0, completa: false,
      texto: `no hay índice de Form 4 para el ${fecha}: EDGAR no publicó ese día` };
  }
  const pct = (nuestros / total) * 100;
  const completa = nuestros >= total;
  return {
    fecha, pct, en_indice: total, guardados: nuestros, completa,
    texto: completa
      ? `Cobertura: 100% de los Form 4 del día (${nuestros} de ${total})`
      : `Cobertura: ${pct.toFixed(1)}% de los Form 4 del día (${nuestros} de ${total}) — faltan ${total - nuestros}`,
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
