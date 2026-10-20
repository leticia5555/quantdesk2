// ═══════════════════════════════════════════════════════════════════════
// api/_lib/feeds.js — leer un feed, sin red y sin librerías.
//
// PURA: recibe el XML como texto y devuelve filas. Se prueba con fixtures.
//
// POR QUÉ NO SE REUSA `parseRss` DE `vc-feed.js`. Esa función hace dos cosas
// que acá serían bugs:
//   · sólo entiende `<item>` (RSS). El censo del punto 0.10 midió que varias
//     de las 22 fuentes GO son **Atom** (`<entry>`), y contar sólo items
//     habría reportado "0 noticias" sobre feeds sanos — un rojo inventado que
//     cierra una puerta abierta;
//   · recorta la fecha a `YYYY-MM-DD`. R3 pide titulares CON HORA, y un
//     "hace 10 minutos" no se puede derivar de un día.
// Lo que sí se comparte son los ayudantes de texto, que ahora viven acá y
// `vc-feed.js` importa: una sola definición de cómo se decodifica una entidad.
//
// NUNCA SE GUARDA EL CUERPO. Se leen título, link y fecha, y de la
// descripción sólo se mira si trae imagen. El encargo es explícito: titular +
// fuente + hora + link, nada reescrito y nada republicado.
// ═══════════════════════════════════════════════════════════════════════

export function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

export function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function tagContent(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
  return m ? m[1] : '';
}

/**
 * La marca de tiempo de una entrada → ISO COMPLETO, con hora.
 *
 * Sin fecha parseable devuelve null y NUNCA "ahora": una nota sin hora puesta
 * en este instante sube sola a lo más reciente y desplaza a las que sí se
 * fecharon. Es la misma regla que `vc-feed` ya tenía para los días.
 */
export function fechaDeEntrada(raw) {
  if (!raw) return null;
  const d = new Date(decodeEntities(String(raw)));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * ¿Es RSS o Atom? Lo decide el XML, no lo que la fuente diga ser.
 *
 * Se mira el ELEMENTO RAÍZ y no la presencia de `<item>`, porque si no, un
 * feed válido que hoy no tiene notas (`<channel></channel>`) se lee igual que
 * una página de error en HTML: los dos darían "no se entendió". Son dos cosas
 * distintas —una fuente vacía se mira mañana, una respuesta que no es un feed
 * se arregla cambiando la URL— y confundirlas manda al lugar equivocado.
 */
export function dialectoDe(xml) {
  const s = String(xml || '');
  if (/<(?:\w+:)?feed[\s>]/i.test(s)) return 'atom';
  if (/<rss[\s>]|<(?:\w+:)?channel[\s>]|<rdf:RDF[\s>]/i.test(s)) return 'rss';
  // Sin raíz reconocible, el contenido manda: hay feeds servidos como
  // fragmento.
  if (/<item(?:\s[^>]*)?>/i.test(s)) return 'rss';
  if (/<entry(?:\s[^>]*)?>/i.test(s)) return 'atom';
  return null;
}

/** El `href` de un `<link>` de Atom: prefiere `rel="alternate"`, que es la nota. */
function linkDeAtom(bloque) {
  const links = [...String(bloque).matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]);
  const href = (attrs) => (/href\s*=\s*"([^"]+)"/i.exec(attrs) || [])[1] || null;
  const alterno = links.find((a) => /rel\s*=\s*"alternate"/i.test(a));
  if (alterno) return href(alterno);
  const sinRel = links.find((a) => !/rel\s*=\s*"/i.test(a));
  return sinRel ? href(sinRel) : (links.length ? href(links[0]) : null);
}

/**
 * ¿La entrada trae foto, y por cuál vía?
 *
 * El censo lo midió por separado a propósito: un `enclosure` SIN `type` no
 * cuenta, porque los podcasts lo usan para audio y una "foto" que resulta ser
 * un mp3 es peor que el bloque de color que R3b ya tiene previsto como caída.
 */
export function imagenDeEntrada(bloque) {
  const b = String(bloque);
  const url = (re) => { const m = re.exec(b); return m ? decodeEntities(m[1]) : null; };
  const mc = url(/<media:content\b[^>]*\burl\s*=\s*"([^"]+)"/i);
  if (mc) return { url: mc, via: 'media:content' };
  const mt = url(/<media:thumbnail\b[^>]*\burl\s*=\s*"([^"]+)"/i);
  if (mt) return { url: mt, via: 'media:thumbnail' };
  const enc = /<enclosure\b([^>]*)>/i.exec(b);
  if (enc && /\btype\s*=\s*"image\//i.test(enc[1])) {
    const u = /\burl\s*=\s*"([^"]+)"/i.exec(enc[1]);
    if (u) return { url: decodeEntities(u[1]), via: 'enclosure' };
  }
  return { url: null, via: null };
}

/**
 * Un feed → entradas. RSS y Atom por la misma puerta.
 *
 * Devuelve `{ entradas, dialecto, motivo }`. Sin dialecto reconocible el
 * motivo lo dice: "no se entendió la respuesta" y "la fuente no tenía nada"
 * son dos cosas distintas y se arreglan distinto.
 */
export function leeFeed(xml, { limite = 60 } = {}) {
  const dialecto = dialectoDe(xml);
  if (!dialecto) {
    return { entradas: [], dialecto: null, motivo: 'la respuesta no traía ni <item> ni <entry>' };
  }
  const re = dialecto === 'rss'
    ? /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    : /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi;
  const bloques = String(xml).match(re) || [];
  const entradas = [];
  for (const b of bloques.slice(0, limite)) {
    const titulo = stripTags(tagContent(b, 'title'));
    const enlace = dialecto === 'rss'
      ? decodeEntities(tagContent(b, 'link')).trim()
      : linkDeAtom(b);
    // Sin título o sin enlace no hay nota que mostrar ni a dónde mandar al
    // lector: se descarta en vez de pintar una fila que no lleva a ningún lado.
    if (!titulo || !enlace) continue;
    const cuando = dialecto === 'rss'
      ? fechaDeEntrada(tagContent(b, 'pubDate') || tagContent(b, 'dc:date'))
      : fechaDeEntrada(tagContent(b, 'published') || tagContent(b, 'updated'));
    entradas.push({
      titulo,
      enlace,
      publicado_en: cuando,
      categorias: [...String(b).matchAll(/<category(?:\s[^>]*)?(?:>([\s\S]*?)<\/category>|\bterm\s*=\s*"([^"]+)"[^>]*\/?>)/gi)]
        .map((m) => decodeEntities(m[1] || m[2] || '')).filter(Boolean),
      imagen: imagenDeEntrada(b),
    });
  }
  return {
    entradas, dialecto,
    motivo: entradas.length ? null
      : (bloques.length ? 'ninguna entrada traía título y enlace' : 'el feed venía sin entradas'),
  };
}
