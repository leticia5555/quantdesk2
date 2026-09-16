// ═══════════════════════════════════════════════════════════════
// api/_lib/bmv-inspect.js — lectura de las páginas de BMV para el CENSO del
// histórico (Fase 1b). Sólo lee y describe; no baja documentos ni escribe nada.
//
// POR QUÉ ESTO EXISTE: el sandbox donde se escribe este código no llega a
// bmv.com.mx, pero Vercel sí. Entonces el censo se hace como un endpoint que
// se corre desde prod y devuelve JSON.
//
// PRINCIPIO DE DISEÑO — describir antes que interpretar:
// Los parsers de abajo están escritos a ciegas, contra una descripción de las
// páginas, no contra el HTML real. Pueden equivocarse. Por eso `estructuraCruda`
// devuelve lo que hay **sin interpretarlo** (encabezados, tipos de documento
// bajo docs-pub, conteos, ejemplos de nombre): aunque mis parsers fallen, UNA
// corrida alcanza para saber qué hay y arreglar el parser sin volver a pedir.
// ═══════════════════════════════════════════════════════════════

const RE_DOC = /(?:docs-pub|docins=\.\.)\/([A-Za-z0-9_-]+)\/([^"'\s>)&]+)/;

/** Texto plano de un pedazo de HTML, con entidades comunes resueltas. */
export function limpiar(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── 1. Descripción cruda, sin interpretar ──────────────────────── */

/**
 * Qué hay en la página, dicho sin suposiciones.
 *
 * Es el seguro contra que mis parsers estén mal: si `documentos()` devuelve 0
 * pero acá aparecen 40 enlaces bajo docs-pub/anexon/, el problema es mío y se
 * arregla mirando los ejemplos, no pidiendo otra corrida.
 */
export function estructuraCruda(html) {
  const s = String(html || '');

  const encabezados = [...s.matchAll(/<h[1-6][^>]*>([\s\S]{0,200}?)<\/h[1-6]>/gi)]
    .map((m) => limpiar(m[1])).filter(Boolean).slice(0, 40);

  // Cualquier documento, sea cual sea el tipo.
  const docsPub = {};
  for (const m of s.matchAll(new RegExp(RE_DOC.source, 'g'))) {
    const [, tipo, archivo] = m;
    if (!docsPub[tipo]) docsPub[tipo] = { n: 0, ejemplos: [] };
    docsPub[tipo].n++;
    if (docsPub[tipo].ejemplos.length < 5 && !docsPub[tipo].ejemplos.includes(archivo)) {
      docsPub[tipo].ejemplos.push(archivo);
    }
  }

  // Años mencionados en la página: pista barata de hasta dónde llega el listado.
  const anios = {};
  for (const m of s.matchAll(/\b(19|20)\d{2}\b/g)) {
    const a = Number(m[0]);
    if (a >= 2000 && a <= 2035) anios[a] = (anios[a] || 0) + 1;
  }

  return {
    bytes: s.length,
    filas_tr: (s.match(/<tr[\s>]/gi) || []).length,
    tablas: (s.match(/<table[\s>]/gi) || []).length,
    encabezados,
    docs_pub_por_tipo: docsPub,
    anios_vistos: Object.keys(anios).map(Number).sort((a, b) => a - b),
    /* Si esto es true, la página trae el listado en el HTML y un script la puede
     * leer. Si es false pero el navegador sí muestra filas, el listado se carga
     * por JavaScript y esto es trabajo de navegador, no de script. */
    tiene_listado_en_html: Object.keys(docsPub).length > 0,
  };
}

/* ── 2. Documentos por fila ─────────────────────────────────────── */

const RE_FECHA = /(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóú]{3,4})\.?-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/;

/*
 * Un documento de BMV aparece en el HTML de DOS formas, y hay que cazar las dos:
 *
 *   /docs-pub/anexon/anexon_998877_2024.zip          ← enlace directo
 *   visorXbrl.html?docins=../ifrsxbrl/ifrsxbrl_...zip ← a través del visor
 *
 * La segunda no contiene la cadena "docs-pub", y es justamente la del XBRL
 * trimestral — la sección que este censo existe para mirar. Cazarlas por
 * separado sería exactamente el error de quedarse ciego en lo que importa.
 */
/**
 * Todas las filas que apuntan a un documento de docs-pub, del tipo que sea.
 * Generaliza `filasXbrl` de /api/xbrl-capture: aquí no filtramos por ifrsxbrl
 * porque justamente queremos ver QUÉ tipos hay.
 */
export function documentos(html, parseFecha) {
  const filas = [];
  const vistos = new Set();

  for (const bloque of String(html || '').split(/<tr[\s>]/i)) {
    const m = RE_DOC.exec(bloque);
    if (!m) continue;
    const [, tipo, archivo] = m;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);

    const texto = limpiar(bloque);
    const fechaTxt = (RE_FECHA.exec(texto) || [])[0] || null;
    filas.push({
      tipo,
      archivo,
      url: `https://www.bmv.com.mx/docs-pub/${tipo}/${archivo}`,
      fecha_publicacion: parseFecha ? parseFecha(texto) : null,
      fecha_texto: fechaTxt,
      titulo: texto.slice(0, 180) || null,
      ...periodoDeNombre(archivo),
      ...periodoDeTitulo(texto),
    });
  }
  return filas;
}

/** Año y trimestre que se pueden leer del NOMBRE del archivo. */
export function periodoDeNombre(archivo) {
  // ifrsxbrl_1576474_2026-02_1.zip  ·  anexon_12345_2019.zip
  let m = /_(\d{4})-(\d{1,2})_/.exec(archivo);
  if (m) {
    const t = Number(m[2]);
    return { anio_archivo: Number(m[1]), trimestre_archivo: t >= 1 && t <= 4 ? t : null };
  }
  m = /_(20\d{2})[._]/.exec(archivo);
  if (m) return { anio_archivo: Number(m[1]), trimestre_archivo: null };
  return { anio_archivo: null, trimestre_archivo: null };
}

const ORDINALES = { primer: 1, segundo: 2, tercer: 3, cuarto: 4, primero: 1, tercero: 3 };

/** Año y trimestre que se pueden leer del TÍTULO de la fila. */
export function periodoDeTitulo(texto) {
  const t = String(texto || '');
  let m = /Trimestre\s+(\d)\s+Del\s+A[nñ]o\s+(\d{4})/i.exec(t);
  if (m) return { anio_titulo: Number(m[2]), trimestre_titulo: Number(m[1]) };
  m = /(primer|segundo|tercer|cuarto)\w*\s+trimestre\s+(?:de\s+)?(?:l\s+)?(\d{4})/i.exec(t);
  if (m) return { anio_titulo: Number(m[2]), trimestre_titulo: ORDINALES[m[1].toLowerCase()] || null };
  m = /\b([1-4])[TQ]\s?(\d{2,4})\b/i.exec(t);
  if (m) {
    const a = Number(m[2]);
    return { anio_titulo: a < 100 ? 2000 + a : a, trimestre_titulo: Number(m[1]) };
  }
  return { anio_titulo: null, trimestre_titulo: null };
}

/* ── 3. ¿Un evento relevante es un reporte de resultados? ────────── */

/**
 * Los eventos relevantes son de todo: cambios de consejo, emisiones, avisos…
 * Sólo unos pocos son el comunicado trimestral. Se clasifica por título y se
 * devuelve la confianza, porque a media confianza conviene mirar antes de bajar.
 */
export function clasificarEvento(titulo) {
  const t = limpiar(titulo).toLowerCase();
  const periodo = periodoDeTitulo(titulo);
  const tienePeriodo = periodo.trimestre_titulo != null;

  // Señal fuerte: el verbo de reporte junto a "resultados".
  if (/\b(reporta|anuncia|informa|presenta|da a conocer)\b[^.]{0,40}\bresultados\b/.test(t)) {
    return { clase: 'resultados_trimestrales', confianza: tienePeriodo ? 'alta' : 'media', ...periodo };
  }
  // "resultados del N trimestre" sin verbo.
  if (/resultados\b[^.]{0,30}\btrimestre\b/.test(t) || /\btrimestre\b[^.]{0,30}\bresultados\b/.test(t)) {
    return { clase: 'resultados_trimestrales', confianza: tienePeriodo ? 'alta' : 'media', ...periodo };
  }
  // Informe/reporte trimestral sin la palabra resultados.
  if (/\b(informe|reporte)\s+(trimestral|del?\s+\w*\s*trimestre)/.test(t)) {
    return { clase: 'resultados_trimestrales', confianza: 'media', ...periodo };
  }
  return { clase: 'otro', confianza: 'alta', ...periodo };
}

/* ── 4. ¿Los ids de docs-pub son contiguos? ──────────────────────── */

/** El id numérico que lleva el nombre del archivo, si lo trae. */
export function idDeArchivo(archivo) {
  const m = /_(\d{5,})[_.]/.exec(String(archivo || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Mide si los ids de documentos de una misma emisora quedan cerca entre sí.
 *
 * El antecedente: el evento relevante de WALMEX (1576009) y su XBRL (1576010)
 * salieron consecutivos. Esto mide si eso se repite.
 *
 * LO QUE ESTO **NO** DEMUESTRA, y hay que decirlo fuerte: que dos ids sean
 * contiguos NO hace que `id-1` sea una URL válida. Los ids son de un contador
 * global de TODA la BMV; entre dos documentos de una emisora hay cientos de
 * otras. Un id adyacente pertenece casi seguro a otra empresa, o a nada.
 * Sirve para ENTENDER cómo se asignan, no para enumerar hacia atrás.
 */
export function analizarIds(filas) {
  const ids = filas.map((f) => ({ ...f, id: idDeArchivo(f.archivo) })).filter((f) => f.id != null);
  if (ids.length < 2) return { n: ids.length, pares_contiguos: [], rango: null, conclusion: 'muy pocos ids para decir nada' };

  const orden = [...ids].sort((a, b) => a.id - b.id);
  const pares = [];
  for (let i = 1; i < orden.length; i++) {
    const d = orden[i].id - orden[i - 1].id;
    if (d <= 5) pares.push({ delta: d, a: orden[i - 1].archivo, b: orden[i].archivo, tipos: [orden[i - 1].tipo, orden[i].tipo] });
  }
  const deltas = [];
  for (let i = 1; i < orden.length; i++) deltas.push(orden[i].id - orden[i - 1].id);
  deltas.sort((a, b) => a - b);

  return {
    n: ids.length,
    rango: { min: orden[0].id, max: orden[orden.length - 1].id, span: orden[orden.length - 1].id - orden[0].id },
    delta_mediano: deltas[Math.floor(deltas.length / 2)],
    delta_min: deltas[0],
    pares_contiguos: pares.slice(0, 10),
    conclusion: pares.length
      ? `${pares.length} par(es) con delta<=5 — consistente con que un envío genere varios documentos seguidos`
      : 'ningún par contiguo: los documentos de esta emisora quedan dispersos en el contador global',
    advertencia: 'ids contiguos NO implican URLs adivinables: el contador es global de la BMV, un id vecino es de otra emisora o de nada',
  };
}

/* ── 5. Resumen por sección ──────────────────────────────────────── */

/** Agrupa los documentos por tipo y describe qué periodos cubre cada uno. */
export function resumirPorTipo(filas) {
  const out = {};
  for (const f of filas) {
    const t = (out[f.tipo] ||= { n: 0, anios: new Set(), con_fecha: 0, sin_fecha: 0, ejemplos: [] });
    t.n++;
    const anio = f.anio_titulo || f.anio_archivo;
    if (anio) t.anios.add(anio);
    if (f.fecha_publicacion) t.con_fecha++; else t.sin_fecha++;
    if (t.ejemplos.length < 3) t.ejemplos.push({ archivo: f.archivo, titulo: f.titulo, fecha: f.fecha_publicacion || f.fecha_texto });
  }
  for (const t of Object.values(out)) {
    const a = [...t.anios].sort((x, y) => x - y);
    t.anios = a;
    t.anio_min = a[0] ?? null;
    t.anio_max = a[a.length - 1] ?? null;
  }
  return out;
}
