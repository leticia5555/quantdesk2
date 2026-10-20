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
  // UNA POR FUENTE.
  //
  // La primera versión era `conFoto.slice(0, cuantas)`, y en producción eso
  // dio las cuatro destacadas del MISMO medio (Valor BR, que publica todas
  // sus notas con imagen — Lety, 2026-10-20). No era un empate casual: el
  // medio que más publica con foto se lleva la fila entera, siempre, y la
  // franja de arriba deja de ser "lo destacado" para ser "quién publica más".
  //
  // Así que se elige por FUENTE y no por nota: de cada fuente, su mejor
  // candidata —la que trae foto si alguna la trae, y entre ésas la más
  // nueva—, y después se ordenan esas candidatas. Las que tienen foto van
  // primero porque la fila del artboard es de tarjetas con imagen; a igualdad,
  // manda la hora.
  const porRecencia = (a, b) => String(b.publicado_en || '').localeCompare(String(a.publicado_en || ''));
  const ordenadas = [...(notas || [])].sort(porRecencia);

  const mejorPorFuente = new Map();
  for (const n of ordenadas) {
    const k = n.fuente_id || n.fuente_nombre || 'sin_fuente';
    const previa = mejorPorFuente.get(k);
    // Ya ordenadas por hora, la primera que entra es la más nueva; sólo la
    // desbanca una CON foto cuando la que estaba no la tenía.
    if (!previa) { mejorPorFuente.set(k, n); continue; }
    if (!previa.imagen && n.imagen) mejorPorFuente.set(k, n);
  }
  const candidatas = [...mejorPorFuente.values()].sort((a, b) => {
    if (!!a.imagen !== !!b.imagen) return a.imagen ? -1 : 1;
    return porRecencia(a, b);
  });

  const destacadas = candidatas.slice(0, cuantas);
  const fuentes = destacadas.length;

  // SI NO ALCANZAN LAS FUENTES, SE REPITE Y SE DICE.
  // Con dos fuentes vivas no hay cuatro medios distintos que mostrar, y
  // dejar dos huecos sería peor que repetir. Lo que no se hace es repetir
  // en silencio: `motivo_repetidas` lo declara y la pantalla lo pinta.
  let repetidas = 0;
  if (destacadas.length < cuantas) {
    const yaEstan = new Set(destacadas.map((n) => n.url));
    for (const n of ordenadas) {
      if (destacadas.length >= cuantas) break;
      if (yaEstan.has(n.url)) continue;
      destacadas.push(n); yaEstan.add(n.url); repetidas++;
    }
  }
  return {
    destacadas,
    fuentes_distintas: fuentes,
    repetidas,
    motivo_repetidas: repetidas
      ? `sólo ${fuentes} fuente(s) con notas en la ventana: ${repetidas} de las ${cuantas} son del mismo medio que otra`
      : null,
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
    destacadas_fuentes: dest.fuentes_distintas,
    motivo_sin_foto: dest.motivo_sin_foto,
    motivo_repetidas: dest.motivo_repetidas,
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
