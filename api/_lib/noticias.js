// ═══════════════════════════════════════════════════════════════════════
// api/_lib/noticias.js — R3(b): de una entrada de feed a una fila de la tabla.
//
// PURA: no abre Neon, no pide red. Recibe entradas ya parseadas y devuelve
// filas listas para guardar, más el estado de cada fuente.
//
// CERO IA (regla 6) y CERO CUERPO. De cada nota viajan titular, fuente, hora y
// link. No se reescribe, no se resume, no se traduce: eso es otra sección, con
// registro de email, y no es ésta.
// ═══════════════════════════════════════════════════════════════════════

import { leeFeed } from './feeds.js';

/**
 * LA URL CANÓNICA, que es la mitad del dedupe.
 *
 * El mismo artículo llega por tres rutas —la portada, la sección y el feed de
 * la agencia— con `utm_*`, `#fragmento` y `?ref=`. Sin normalizar, las tres
 * son filas distintas y el lector ve el mismo titular tres veces.
 *
 * Lo que se quita son parámetros de SEGUIMIENTO, nunca los que identifican la
 * nota: `?id=123` y `?p=456` se quedan, porque sin ellos dos notas distintas
 * del mismo sitio colapsarían en una y perderíamos una de verdad.
 */
const PARAMS_DE_RASTREO = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|cmpid$|smid$|partner$|__twitter_impression$|guccounter$)/i;

export function urlCanonica(cruda) {
  const s = String(cruda || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = 'https:';
  for (const k of [...u.searchParams.keys()]) {
    if (PARAMS_DE_RASTREO.test(k)) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  // La barra final no distingue una nota de otra.
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * EL TITULAR NORMALIZADO, la otra mitad del dedupe.
 *
 * Dos medios publican el mismo cable de agencia con comillas distintas, un
 * "EN VIVO:" delante o el nombre del medio detrás. Comparar el texto crudo los
 * deja pasar como dos notas. Se compara en minúsculas, sin acentos, sin
 * puntuación y sin los prefijos de sección — que es lo que queda del hecho.
 */
const PREFIJOS = /^(en vivo|ultima hora|última hora|urgente|breaking|exclusiva|exclusive|opinion|opinión|video|analisis|análisis)\s*[:\-–—]\s*/i;

export function tituloNormalizado(t) {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(PREFIJOS, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * TICKERS POR COINCIDENCIA, con lista de exclusión.
 *
 * El encargo lo pide sin IA: se cruza el titular contra el mapa de símbolos que
 * ya existe. El problema conocido son las palabras que TAMBIÉN son tickers —
 * "AI", "IT", "NOW", "ON", "ALL"— y que en un titular en inglés aparecen a cada
 * rato. Marcar "IT" en "What IT leaders want" pondría un chip que lleva a una
 * empresa que la nota ni menciona: un dato inventado con forma de dato.
 *
 * Dos reglas para no inventar:
 *   · el ticker se busca como PALABRA COMPLETA y respetando mayúsculas;
 *   · los de la lista de exclusión sólo cuentan si vienen con marca explícita
 *     —`$AI`, `(AI)`, `NYSE: AI`— que es cómo se escribe un ticker cuando se
 *     quiere decir el ticker.
 * El nombre de la empresa cuenta aparte y sin sensibilidad a mayúsculas,
 * porque "Nvidia" en un titular es Nvidia.
 */
export const EXCLUIDOS = new Set([
  'AI', 'IT', 'NOW', 'ON', 'ALL', 'ARE', 'BE', 'BY', 'CAN', 'CEO', 'DD', 'EOD',
  'EU', 'FOR', 'GO', 'HAS', 'HE', 'IN', 'IS', 'LOW', 'NEW', 'NEXT', 'OR', 'OUT',
  'PM', 'REAL', 'RUN', 'SEE', 'SO', 'TV', 'UP', 'US', 'WELL', 'WOW', 'YOU',
]);

export function tickersDeTitular(titular, catalogo = [], { excluidos = EXCLUIDOS } = {}) {
  const t = String(titular || '');
  if (!t) return [];
  const encontrados = new Set();
  for (const c of catalogo) {
    const sym = String(c && c.symbol ? c.symbol : c || '').toUpperCase();
    if (!sym) continue;
    if (excluidos.has(sym)) {
      // Sólo con marca explícita de ticker. `[^A-Z]` detrás evita que `$AIG`
      // cuente como `$AI`.
      const marcado = new RegExp(`(\\$${sym}|\\(${sym}\\)|\\b(?:NYSE|NASDAQ|BMV|AMEX)\\s*:\\s*${sym})(?![A-Z0-9])`);
      if (marcado.test(t)) encontrados.add(sym);
      continue;
    }
    if (sym.length >= 2 && new RegExp(`(?<![A-Z0-9.])${sym}(?![A-Z0-9.])`).test(t)) {
      encontrados.add(sym);
      continue;
    }
    const nombre = c && c.nombre ? String(c.nombre).trim() : '';
    // Nombres de una sola letra o genéricos no se buscan: "Oracle" sí, "On" no.
    if (nombre.length >= 4 && new RegExp(`\\b${nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) {
      encontrados.add(sym);
    }
  }
  return [...encontrados].sort();
}

/**
 * Las entradas de UNA fuente → filas, con el estado de la fuente al lado.
 *
 * `fuente` es una fila del registro `news-sources.json`. Una fuente caída NO
 * devuelve lista vacía: devuelve `caida: true` con su motivo, que es lo que el
 * chip de R3b pinta como `source_down` y lo que impide leer "no publicó nada"
 * donde lo que pasó es que no contestó.
 */
export function filasDeFuente(fuente, respuesta, { ahora = new Date(), catalogo = [], maxHoras = null } = {}) {
  const base = { id: fuente.id, nombre: fuente.nombre, tipo: fuente.tipo, idioma: fuente.idioma };
  if (!respuesta || respuesta.error) {
    return { ...base, caida: true, motivo: String((respuesta && respuesta.error) || 'no se pudo pedir el feed'), filas: [], leidas: 0 };
  }
  const { entradas, dialecto, motivo } = leeFeed(respuesta.xml);
  const filas = [];
  let sinFecha = 0;
  let viejas = 0;
  const corte = maxHoras ? new Date(ahora.getTime() - maxHoras * 3600 * 1000) : null;

  for (const e of entradas) {
    const url = urlCanonica(e.enlace);
    if (!url) continue;
    // SIN FECHA NO ENTRA. Una nota sin hora se ordenaría contra las demás por
    // un valor inventado: o se va al principio o al final, y las dos mienten
    // sobre cuándo pasó. Se cuenta para que la fuente lo pueda reportar.
    if (!e.publicado_en) { sinFecha++; continue; }
    if (corte && new Date(e.publicado_en) < corte) { viejas++; continue; }
    filas.push({
      url,
      titular: e.titulo,
      fuente_id: fuente.id,
      fuente_nombre: fuente.nombre,
      tipo: fuente.tipo,
      idioma: fuente.idioma,
      seccion: fuente.seccion || null,
      publicado_en: e.publicado_en,
      titulo_norm: tituloNormalizado(e.titulo),
      imagen: e.imagen && e.imagen.url ? e.imagen.url : null,
      imagen_via: e.imagen && e.imagen.via ? e.imagen.via : null,
      tickers: tickersDeTitular(e.titulo, catalogo),
    });
  }
  return {
    ...base,
    caida: false,
    motivo: filas.length ? null : (motivo || (sinFecha ? 'ninguna entrada traía fecha' : 'sin notas nuevas')),
    dialecto,
    leidas: entradas.length,
    sin_fecha: sinFecha,
    fuera_de_ventana: viejas,
    filas,
  };
}

/**
 * DEDUPE POR URL Y POR TITULAR, en ese orden.
 *
 * Gana la MÁS VIEJA, no la primera que llegue: si Reuters publicó a las 10:00 y
 * un sitio lo reprodujo a las 10:40, el hecho es de las 10:00 y poner la hora
 * del eco haría parecer que acaba de pasar. Las repetidas no se tiran en
 * silencio: se cuentan, y la fila que queda dice cuántas veces se vio.
 */
export function dedupe(filas = []) {
  const porUrl = new Map();
  const porTitulo = new Map();
  let dupUrl = 0;
  let dupTitulo = 0;

  const masVieja = (a, b) => (String(a.publicado_en) <= String(b.publicado_en) ? a : b);

  for (const f of filas) {
    if (porUrl.has(f.url)) {
      dupUrl++;
      porUrl.set(f.url, { ...masVieja(porUrl.get(f.url), f), veces: (porUrl.get(f.url).veces || 1) + 1 });
      continue;
    }
    porUrl.set(f.url, { ...f, veces: 1 });
  }

  for (const f of porUrl.values()) {
    const k = f.titulo_norm;
    // Un titular normalizado vacío (puro emoji, por ejemplo) no agrupa: todos
    // colapsarían en uno.
    if (!k) { porTitulo.set(`__sin_titulo__${f.url}`, f); continue; }
    if (porTitulo.has(k)) {
      dupTitulo++;
      const previa = porTitulo.get(k);
      const queda = masVieja(previa, f);
      porTitulo.set(k, { ...queda, veces: (previa.veces || 1) + (f.veces || 1) });
      continue;
    }
    porTitulo.set(k, f);
  }

  const out = [...porTitulo.values()].sort((a, b) =>
    (a.publicado_en < b.publicado_en ? 1 : a.publicado_en > b.publicado_en ? -1 : a.url.localeCompare(b.url)));
  return { filas: out, duplicadas_url: dupUrl, duplicadas_titulo: dupTitulo };
}

/**
 * BANXICO POR LA API DEL SIE — y lo que el SIE PUEDE y NO PUEDE dar.
 *
 * El punto 0.10 midió que el RSS de Banxico no responde (NO-GO), así que la
 * sección "oficiales" se queda sin su fuente mexicana. La decisión de Lety
 * (2026-10-02) fue traerlo por el SIE, que es la API oficial que ya usamos
 * para el FIX.
 *
 * LO QUE EL SIE DA ES UNA SERIE DE NÚMEROS, NO COMUNICADOS. No hay titulares
 * ahí. Lo que sí hay, y es un hecho datable y oficial, es la TASA OBJETIVO
 * (`SF61745`): cuando cambia, eso ES la decisión de política monetaria, con su
 * fecha. Así que de cada cambio sale una fila —"Banxico baja la tasa objetivo
 * a 7.25% (desde 7.50%)"— y nada más.
 *
 * TRES COSAS QUE ESTA FILA DECLARA, para que nadie la lea como un comunicado:
 *   · el titular lo ARMAMOS nosotros a partir de la serie, y el `tipo` lo dice
 *     (`oficial_derivado`, no `oficial`);
 *   · el link va a la página de anuncios de Banxico, que es estable, no a un
 *     comunicado por fecha que no tenemos;
 *   · la hora es la del DATO de la serie (un día), no una hora inventada.
 *
 * Si el día que Banxico anuncie sin mover la tasa no sale fila, es correcto:
 * no hubo cambio que la serie pueda ver, y fabricar "Banxico mantuvo la tasa"
 * desde una serie que no se movió sería afirmar que hubo anuncio sin saberlo.
 */
export const BANXICO_ANUNCIOS = 'https://www.banxico.org.mx/publicaciones-y-prensa/anuncios-de-las-decisiones-de-politica-monetaria/anuncios-politica-monetaria.html';

export function cambiosDeTasa(puntos = [], { fuente_id = 'banxico_sie' } = {}) {
  const limpios = (Array.isArray(puntos) ? puntos : [])
    .map((p) => ({ fecha: String((p && p.date) || '').slice(0, 10), valor: Number(p && p.value) }))
    .filter((p) => p.fecha && Number.isFinite(p.valor))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const filas = [];
  for (let i = 1; i < limpios.length; i++) {
    const hoy = limpios[i];
    const antes = limpios[i - 1];
    // `!==` sobre números ya redondeados por el SIE: un cambio de tasa es un
    // escalón, no una deriva. Comparar con tolerancia escondería un recorte de
    // 25 puntos base si alguna vez llegara como 7.2500000001.
    if (Math.abs(hoy.valor - antes.valor) < 0.001) continue;
    const sube = hoy.valor > antes.valor;
    const titular = `Banxico ${sube ? 'sube' : 'baja'} la tasa objetivo a ${hoy.valor}% (desde ${antes.valor}%)`;
    filas.push({
      url: `${BANXICO_ANUNCIOS}#${hoy.fecha}`,
      titular,
      fuente_id,
      fuente_nombre: 'Banxico',
      // `oficial_derivado`, NO `oficial`: este titular lo armamos nosotros
      // desde la serie. Llamarlo igual que un comunicado sería atribuirle a
      // Banxico una redacción que no escribió.
      tipo: 'oficial_derivado',
      idioma: 'es',
      seccion: 'oficiales',
      // La hora es la del dato: un día. Mediodía UTC para no cruzar de día al
      // convertir a hora de México, que es lo que la pantalla muestra.
      publicado_en: new Date(`${hoy.fecha}T12:00:00Z`).toISOString(),
      titulo_norm: tituloNormalizado(titular),
      imagen: null, imagen_via: null,
      tickers: [],
      // La procedencia completa, para que la hoja pueda decirla (regla 3).
      fuente_dato: 'banxico:SF61745 (tasa objetivo)',
    });
  }
  return filas;
}
