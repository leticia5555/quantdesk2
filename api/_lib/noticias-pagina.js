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
 * LAS DESTACADAS: HASTA CUATRO, TODAS CON FOTO.
 *
 * El encargo de septiembre decía que la foto salía sólo si el feed la traía,
 * y prohibía ir a buscar el `og:image`. Lety lo cambió el 2026-10-22 mirando
 * el iPhone: la foto se lee ahora de la propia nota en la cosecha
 * (`imagenDeLaPagina`, más abajo), y una nota sin foto YA NO es destacada.
 *
 * Devuelve `{ destacadas, con_foto, con_foto_total, motivo_vacio }`: lo
 * último es lo que la pantalla dice cuando no hay ninguna (regla 2).
 */
export function destacadasDe(notas, { cuantas = 4 } = {}) {
  // ── SÓLO ES DESTACADA LO QUE TIENE FOTO DE VERDAD ───────────────────
  //
  // Antes se completaban las cuatro con lo que hubiera y las que no traían
  // imagen se dibujaban como un bloque de color con el nombre del medio. En
  // el iPhone eso se ve mal (Lety, 2026-10-22), y tiene razón: un rectángulo
  // plano al lado de tres fotos reales no se lee como "esta nota no trajo
  // imagen", se lee como que la página está rota.
  //
  // Entonces la franja de destacadas es exactamente lo que promete: notas con
  // foto. Si hay menos de cuatro, se muestran las que haya; si no hay
  // ninguna, la sección no aparece. Una sección vacía no es un hueco que
  // haya que llenar: es la respuesta.
  //
  // UNA POR FUENTE. La primera versión era `conFoto.slice(0, cuantas)`, y en
  // producción eso dio las cuatro del MISMO medio (Valor BR publica todo con
  // imagen). El que más publica no es "lo destacado".
  const porRecencia = (a, b) => String(b.publicado_en || '').localeCompare(String(a.publicado_en || ''));
  const conFoto = (notas || []).filter((n) => n && n.imagen).sort(porRecencia);

  const mejorPorFuente = new Map();
  for (const n of conFoto) {
    const k = n.fuente_id || n.fuente_nombre || 'sin_fuente';
    if (!mejorPorFuente.has(k)) mejorPorFuente.set(k, n);
  }
  const destacadas = [...mejorPorFuente.values()].sort(porRecencia).slice(0, cuantas);

  return {
    destacadas,
    fuentes_distintas: destacadas.length,
    // Cuántas notas con foto quedaron fuera por ser de una fuente que ya
    // estaba. Es el dato que dice si la franja se está quedando corta porque
    // faltan fotos o porque falta variedad.
    con_foto_total: conFoto.length,
    con_foto: destacadas.length,
    sin_foto: 0,
    motivo_vacio: destacadas.length ? null
      : 'ninguna de las notas de la ventana trae foto propia todavía',
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
    destacadas_fuentes: dest.fuentes_distintas,
    destacadas_candidatas: dest.con_foto_total,
    motivo_destacadas: dest.motivo_vacio,
    // La revista de la página: una portada y hasta cinco en rejilla. Sale de
    // la MISMA función que usa `/mercado`, para que las dos pantallas
    // destaquen lo mismo en el mismo momento.
    revista: (() => {
      const r = revistaDe(vistas, { medianas: 5 });
      return { portada: r.portada, medianas: r.medianas, cuantas: r.cuantas,
        con_foto_total: r.con_foto_total, motivo_vacio: r.motivo_vacio };
    })(),
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

// ═══════════════════════════════════════════════════════════════════════
// LA FOTO DE LA NOTA — leída de la propia página del artículo
//
// Hasta el 2026-10-22 la foto salía sólo si el feed la traía en
// `media:content` o `enclosure`, y las que no, se dibujaban como un bloque de
// color con el nombre del medio. En el iPhone eso se ve mal (Lety), y tiene
// razón: un rectángulo de color plano al lado de tres fotos reales no se lee
// como "esta nota no trajo imagen", se lee como que la página está rota.
//
// Así que la foto se busca donde SIEMPRE está: en la etiqueta `og:image` de
// la propia nota, que es la que el medio publica para que su enlace se vea
// bien en WhatsApp o en X. Es la misma que el medio quiere que se vea.
//
// LO QUE ESTO NO ES: no se baja la imagen, no se guarda, no se recorta y no
// se lee el cuerpo del artículo. Se lee la cabecera del HTML, se queda la URL
// y se descarta el resto. Lo que se muestra sigue siendo titular, fuente y
// hora, y el link va al sitio del medio.
// ═══════════════════════════════════════════════════════════════════════

/** Las etiquetas que publican la imagen de una nota, en orden de preferencia. */
const PROPIEDADES_IMAGEN = [
  'og:image:secure_url',
  'og:image:url',
  'og:image',
  'twitter:image',
  'twitter:image:src',
];

/**
 * La URL de la imagen que la página declara, o null con su causa.
 *
 * Se parsea con expresiones regulares y no con un DOM entero a propósito: en
 * una función serverless, traer un parser de HTML para leer cuatro etiquetas
 * de la cabecera es cargar megabytes para mirar cien bytes. Lo que se busca
 * está en `<head>` y tiene una forma muy acotada.
 *
 * Las trampas que cubre, todas vistas en feeds reales:
 *   · el orden de los atributos cambia (`content` antes que `property`);
 *   · comillas dobles, simples o ninguna;
 *   · `name=` en vez de `property=` (Twitter lo usa así);
 *   · rutas relativas y protocolo implícito (`//cdn.medio.com/foto.jpg`);
 *   · entidades HTML en la URL (`&amp;` en una query).
 */
export function imagenDeLaPagina(html, urlNota) {
  const texto = String(html || '');
  if (!texto.trim()) return { url: null, via: null, motivo: 'la página llegó vacía' };
  // Sólo la cabecera: el cuerpo de un artículo puede traer `og:image` dentro
  // de un bloque de comentarios o de un script, y además es donde está el
  // texto que NO queremos leer.
  const finHead = texto.search(/<\/head>/i);
  const cabeza = finHead > 0 ? texto.slice(0, finHead) : texto.slice(0, 200_000);

  const metas = cabeza.match(/<meta\b[^>]*>/gi) || [];
  const porPropiedad = new Map();
  for (const m of metas) {
    const prop = (m.match(/\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || [])
      .slice(1).find(Boolean);
    const cont = (m.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || [])
      .slice(1).find(Boolean);
    if (!prop || !cont) continue;
    const k = prop.trim().toLowerCase();
    if (!porPropiedad.has(k)) porPropiedad.set(k, cont.trim());
  }

  for (const prop of PROPIEDADES_IMAGEN) {
    const crudo = porPropiedad.get(prop);
    if (!crudo) continue;
    const url = normalizaUrlImagen(crudo, urlNota);
    if (url) return { url, via: prop, motivo: null };
  }
  return {
    url: null, via: null,
    motivo: porPropiedad.size
      ? 'la nota no declara og:image ni twitter:image'
      : 'la página no trae etiquetas meta legibles',
  };
}

/**
 * La URL absoluta y servible, o null.
 *
 * Se exige `https`: una imagen por `http` en una página servida por `https`
 * la bloquea el navegador y la tarjeta quedaría con el hueco — que es
 * justamente lo que se vino a quitar. Un `data:` tampoco entra: pesan y no se
 * pueden volver a pedir.
 */
export function normalizaUrlImagen(crudo, urlNota) {
  let u = String(crudo || '')
    .replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"')
    .trim();
  if (!u || /^data:/i.test(u)) return null;
  // Protocolo implícito: `//cdn.medio.com/foto.jpg`.
  if (/^\/\//.test(u)) u = 'https:' + u;
  try {
    const abs = new URL(u, urlNota || undefined);
    if (abs.protocol === 'http:') abs.protocol = 'https:';
    if (abs.protocol !== 'https:') return null;
    return abs.toString();
  } catch { return null; }
}

/**
 * A QUÉ NOTAS SE LES VA A PEDIR LA FOTO, y por qué a tan pocas.
 *
 * Leer la página de una nota es una petición al sitio del medio. Hacerlo para
 * las 300 notas de una cosecha sería 300 peticiones a terceros por corrida
 * —y a los mismos ocho dominios—, que es exactamente el tipo de cortesía que
 * hace que un medio nos bloquee. Sólo se piden las que PUEDEN llegar a ser
 * destacadas: las más nuevas, y una por fuente antes que dos de la misma.
 *
 * El orden es el mismo que usa `destacadasDe` para elegir, así que lo que se
 * pide es lo que se va a mostrar y no una muestra al azar.
 */
export function candidatasDeFoto(filas, { cuantas = 20 } = {}) {
  const sinFoto = (filas || []).filter((f) => f && f.url && !f.imagen);
  const porRecencia = (a, b) => String(b.publicado_en || '').localeCompare(String(a.publicado_en || ''));
  const ordenadas = [...sinFoto].sort(porRecencia);
  const vistas = new Set();
  const primeraVuelta = [];
  const resto = [];
  for (const f of ordenadas) {
    const k = f.fuente_id || f.fuente_nombre || 'sin_fuente';
    if (vistas.has(k)) { resto.push(f); continue; }
    vistas.add(k); primeraVuelta.push(f);
  }
  return [...primeraVuelta, ...resto].slice(0, cuantas);
}

/**
 * LA REVISTA: una portada grande y unas cuantas medianas.
 *
 * Lety, 2026-10-22: *"Noticias como revista, no escondidas."* Una portada a
 * todo lo ancho, luego cuatro medianas con foto chica, y un botón para ver
 * todas.
 *
 * SÓLO ENTRA LO QUE TIENE FOTO. Una "revista" con huecos no es una revista;
 * lo que no tiene foto va a la lista de abajo, que es donde se lee bien. Y
 * una por fuente, por lo mismo que las destacadas: el medio que más publica
 * no es "lo destacado".
 *
 * Devuelve también `resto`, que es lo que la lista tiene que pintar: sin eso,
 * cada pantalla tendría que restar por su cuenta y las dos restarían distinto.
 */
export function revistaDe(notas, { medianas = 4 } = {}) {
  const porRecencia = (a, b) => String(b.publicado_en || '').localeCompare(String(a.publicado_en || ''));
  const todas = [...(notas || [])].sort(porRecencia);
  const conFoto = todas.filter((n) => n && n.imagen);

  const mejorPorFuente = new Map();
  for (const n of conFoto) {
    const k = n.fuente_id || n.fuente_nombre || 'sin_fuente';
    if (!mejorPorFuente.has(k)) mejorPorFuente.set(k, n);
  }
  const elegidas = [...mejorPorFuente.values()].sort(porRecencia).slice(0, medianas + 1);
  const usadas = new Set(elegidas.map((n) => n.url));
  return {
    portada: elegidas[0] || null,
    medianas: elegidas.slice(1),
    cuantas: elegidas.length,
    // Lo que NO va en la revista va en la lista: las sin foto y las que se
    // repiten de fuente. Ninguna nota se pierde por no tener imagen.
    resto: todas.filter((n) => !usadas.has(n.url)),
    con_foto_total: conFoto.length,
    motivo_vacio: elegidas.length ? null
      : 'ninguna de las notas de la ventana trae foto propia todavía',
  };
}
