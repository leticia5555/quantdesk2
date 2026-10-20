// ── R3b: LA PÁGINA DE NOTICIAS, EN UNA SOLA LLAMADA ──────────────────
// Regla 7: un endpoint por pantalla, con caché. La página del artboard 9 tiene
// destacadas, dos columnas, chips de fuente y contadores por sección; pedir
// cada cosa por separado serían seis viajes para una pantalla que se abre de
// un tirón. Va todo junto y el filtrado de secciones ocurre ACÁ, con la lista
// ya en memoria: son ≤ 400 filas de 72 horas, no una tabla grande.
//
// LA PAGINACIÓN SÍ ES OTRA LLAMADA ("cargar más"), con `antes_de`. Eso no
// rompe la regla: no es un fetch por tarjeta, es la página siguiente que el
// lector pidió.

/** Las secciones de la cabecera, en el orden del artboard. */
export const SECCIONES = [
  { id: 'mercado', nombre: 'Mercado' },
  { id: 'mexico_latam', nombre: 'México · LATAM' },
  { id: 'acciones', nombre: 'Acciones' },
  { id: 'etfs', nombre: 'ETFs' },
  { id: 'cripto', nombre: 'Cripto' },
  { id: 'oficiales', nombre: 'Oficiales' },
];

/**
 * Las secciones que NINGUNA fuente declarada alimenta.
 *
 * ETFs y Cripto están en la cabecera del artboard y no hay una sola fuente del
 * registro que publique en ellas. El encargo ya decidió qué hacer con eso en
 * R3 —"vacíos con 'pronto', no fingir"— y acá se calcula en vez de escribirse
 * a mano: si mañana entra una fuente de cripto, la sección se enciende sola.
 */
export function seccionesSinFuente(fuentes, secciones = SECCIONES) {
  const conFuente = new Set((fuentes || []).map((f) => f.seccion).filter(Boolean));
  // "Acciones" no tiene fuente propia a propósito: el encargo la define como
  // "notas con al menos un ticker", así que se alimenta de las demás.
  conFuente.add('acciones');
  return secciones.filter((s) => !conFuente.has(s.id)).map((s) => s.id);
}

/**
 * ¿Esta nota entra en esta sección?
 *
 * "Acciones" es la única que NO sale del registro: el encargo la define como
 * las notas que mencionan al menos un ticker, y eso se sabe por nota, no por
 * fuente.
 */
export function enSeccion(n, seccion) {
  if (!seccion || seccion === 'todo') return true;
  if (seccion === 'acciones') return Array.isArray(n.tickers) && n.tickers.length > 0;
  return n.seccion === seccion;
}

/** Normaliza el texto para buscar: sin acentos, sin mayúsculas. */
export function paraBuscar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * El filtro de la pantalla, en un solo lugar.
 *
 * Lo usan la página Y las pruebas: si el filtro viviera en el HTML, la prueba
 * tendría que levantar un navegador para saber si "Solo español" filtra bien.
 */
export function filtra(notas, { seccion = 'todo', idioma = 'todo', q = '', fuente = null } = {}) {
  const aguja = paraBuscar(q).trim();
  return (notas || []).filter((n) => {
    if (!enSeccion(n, seccion)) return false;
    // "Solo español" filtra por el IDIOMA DE LA FUENTE, no por el del titular:
    // el encargo es explícito en que no hay traducción en v1, así que no hay
    // nada que detectar — es un dato del registro.
    if (idioma === 'es' && n.idioma !== 'es') return false;
    if (fuente && n.fuente_id !== fuente) return false;
    if (aguja) {
      const heno = paraBuscar(n.titular) + ' ' + paraBuscar(n.fuente_nombre || n.fuente_id)
        + ' ' + (Array.isArray(n.tickers) ? n.tickers.join(' ').toLowerCase() : '');
      if (!heno.includes(aguja)) return false;
    }
    return true;
  });
}

/**
 * LAS CUATRO DESTACADAS. Con foto sólo si el feed la trajo.
 *
 * El encargo prohíbe scrapear `og:image`, así que no hay forma de conseguir una
 * foto que el feed no mande. Si no hay cuatro con foto, las que faltan se
 * llenan con las más recientes SIN foto y la pantalla les pinta el bloque de
 * color con el nombre de la fuente: cuatro huecos serían peor que cuatro
 * tarjetas, y una foto traída de otra nota sería mentir sobre cuál es.
 *
 * Devuelve `{ destacadas, con_foto, sin_foto, motivo_sin_foto }` para que la
 * pantalla pueda decir POR QUÉ un bloque no tiene imagen (regla 2).
 */
export function destacadasDe(notas, { cuantas = 4 } = {}) {
  const conFoto = (notas || []).filter((n) => n.imagen);
  const sinFoto = (notas || []).filter((n) => !n.imagen);
  const destacadas = [...conFoto.slice(0, cuantas)];
  for (const n of sinFoto) {
    if (destacadas.length >= cuantas) break;
    destacadas.push(n);
  }
  return {
    destacadas,
    con_foto: destacadas.filter((n) => n.imagen).length,
    sin_foto: destacadas.filter((n) => !n.imagen).length,
    motivo_sin_foto: 'el feed no trajo media:content ni enclosure de imagen',
  };
}

/**
 * "Por fuente": las notas agrupadas, la fuente con más notas primero.
 *
 * El orden DENTRO de cada fuente sigue siendo por hora: el toggle cambia cómo
 * se agrupa, no qué es lo más nuevo.
 */
export function porFuente(notas) {
  const mapa = new Map();
  for (const n of notas || []) {
    const k = n.fuente_id || 'sin_fuente';
    if (!mapa.has(k)) {
      mapa.set(k, { fuente_id: k, fuente_nombre: n.fuente_nombre || k, idioma: n.idioma || null, tipo: n.tipo || null, notas: [] });
    }
    mapa.get(k).notas.push(n);
  }
  return [...mapa.values()].sort((a, b) => b.notas.length - a.notas.length
    || String(a.fuente_nombre).localeCompare(String(b.fuente_nombre), 'es'));
}

/**
 * El estado de cada fuente para su chip: del registro + la última corrida.
 *
 * Una fuente que NUNCA corrió no es lo mismo que una caída: la primera dice
 * "corré el job", la segunda "la fuente está rota". El chip las distingue.
 */
export function chipsDeFuente(fuentesGo, corridas) {
  const porId = new Map((corridas || []).map((c) => [c.fuente_id, c]));
  return (fuentesGo || []).map((f) => {
    const c = porId.get(f.id);
    return {
      id: f.id,
      nombre: f.nombre,
      idioma: f.idioma,
      tipo: f.tipo,
      seccion: f.seccion,
      // `ok` es tri-estado a propósito: true, false, o null = sin correr.
      ok: c ? c.ok === true : null,
      motivo: c ? (c.motivo || null) : 'esta fuente no se ha cosechado todavía',
      estado: !c ? 'sin_cosechar' : (c.ok === true ? 'ok' : 'source_down'),
      guardadas: c ? (c.guardadas ?? null) : null,
      ultima_corrida: c ? c.ultima_corrida : null,
    };
  }).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
}

/**
 * El cuerpo de la respuesta de la página, armado desde la lista ya leída.
 *
 * Separado del handler para que se pruebe sin Postgres: entra la lista, salen
 * las tres columnas. La prueba de este archivo es la que fija el contrato.
 */
export function armaPagina(notas, { seccion = 'todo', idioma = 'todo', q = '', fuente = null, orden = 'hora', porColumna = 30 } = {}) {
  const vistas = filtra(notas, { seccion, idioma, q, fuente });
  const dest = destacadasDe(vistas);
  // Las destacadas NO se quitan de las columnas: en el artboard la nota
  // destacada sigue apareciendo en su lista, y sacarla haría que "cargar más"
  // devolviera huecos. Son la misma nota mostrada dos veces, a propósito.
  const medios = vistas.filter((n) => n.tipo === 'medio');
  const newsletters = vistas.filter((n) => n.tipo === 'newsletter');
  // `oficial_derivado` es lo que arma `cambiosDeTasa` desde la serie del SIE:
  // es oficial, y si no entrara acá se perdería de la columna que le toca.
  const oficiales = vistas.filter((n) => n.tipo === 'oficial' || n.tipo === 'oficial_derivado');
  const otros = vistas.filter((n) => !['medio', 'newsletter', 'oficial', 'oficial_derivado'].includes(n.tipo));
  return {
    total: vistas.length,
    destacadas: dest.destacadas,
    destacadas_con_foto: dest.con_foto,
    motivo_sin_foto: dest.motivo_sin_foto,
    medios: orden === 'fuente' ? [] : medios.slice(0, porColumna),
    medios_total: medios.length,
    medios_por_fuente: orden === 'fuente' ? porFuente(medios) : [],
    newsletters: newsletters.slice(0, porColumna),
    newsletters_total: newsletters.length,
    oficiales: oficiales.slice(0, porColumna),
    oficiales_total: oficiales.length,
    // Un `tipo` que no es ninguno de los cuatro no se tira en silencio: queda
    // acá y la pantalla lo pinta al final de la columna de medios con su tipo.
    otros,
    conteos: Object.fromEntries(SECCIONES.map((s) => [s.id,
      filtra(notas, { seccion: s.id, idioma, q, fuente }).length])),
  };
}
