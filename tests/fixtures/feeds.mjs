// ═══════════════════════════════════════════════════════════════════════
// tests/fixtures/feeds.mjs — las FORMAS reales que mandan las 22 fuentes.
//
// No son feeds inventados: son las formas que el job encontró en producción el
// 2026-10-20, cuando ocho fuentes vivas reportaron "ninguna entrada traía
// título y enlace". Cada fixture está acá porque UNA de esas ocho lo usa, y
// cada uno falla si se quita el arreglo que lo hizo pasar.
// ═══════════════════════════════════════════════════════════════════════

/** Substack (doomberg, klement, net_interest, the_bear_cave, app_economy). */
export const SUBSTACK = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title><![CDATA[Doomberg]]></title>
  <item>
    <title><![CDATA[The Oldest Trick in the Book]]></title>
    <link>https://doomberg.substack.com/p/the-oldest-trick-in-the-book</link>
    <guid isPermaLink="false">https://doomberg.substack.com/p/the-oldest-trick-in-the-book</guid>
    <pubDate>Mon, 19 Oct 2026 11:02:14 GMT</pubDate>
    <description><![CDATA[<p>Un párrafo que NO se guarda.</p>]]></description>
    <enclosure url="https://substackcdn.com/image/x.jpg" type="image/jpeg" length="0"/>
  </item>
</channel></rss>`;

/** Medio en español con CDATA y el titular con acentos y HTML adentro. */
export const MEDIO_ES_CDATA = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Banxico <b>baja</b> la tasa y el peso reacciona]]></title>
    <link><![CDATA[https://www.elfinanciero.com.mx/mercados/2026/10/19/banxico-baja/]]></link>
    <pubDate>Mon, 19 Oct 2026 14:30:00 -0600</pubDate>
    <media:content url="https://cdn.elfinanciero.com.mx/foto.jpg" medium="image"/>
  </item>
</channel></rss>`;

/** Atom con el enlace como ATRIBUTO, no como texto. */
export const ATOM_LINK_ATRIBUTO = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Klement on Investing</title>
  <entry>
    <title type="html">Valuation is not a timing tool</title>
    <link rel="edit" href="https://ejemplo/edit/1"/>
    <link rel="alternate" type="text/html" href="https://klement.substack.com/p/valuation"/>
    <published>2026-10-19T06:00:00Z</published>
    <updated>2026-10-19T07:00:00Z</updated>
    <category term="markets"/>
  </entry>
</feed>`;

/** RSS con `<link/>` vacío y la URL en el guid: Blogger y varios CMS viejos. */
export const RSS_GUID_PERMALINK = `<rss version="2.0"><channel>
  <item>
    <title>Infobae: la inflación de septiembre</title>
    <link/>
    <guid isPermaLink="true">https://www.infobae.com/economia/2026/10/19/inflacion/</guid>
    <pubDate>Mon, 19 Oct 2026 09:15:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** RSS híbrido: `<link>` vacío y un `<atom:link>` al lado. */
export const RSS_ATOM_LINK = `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
  <item>
    <title>Bloomberg Línea: el peso cierra en 18.20</title>
    <link></link>
    <atom:link rel="alternate" href="https://www.bloomberglinea.com/2026/10/19/peso/"/>
    <pubDate>Mon, 19 Oct 2026 22:05:00 GMT</pubDate>
  </item>
</channel></rss>`;

// ── EL ESPACIO PERDIDO EN LOS TITULARES ──────────────────────────────
// EL REPORTE: "$1.4Tvaluation" (Lety, 2026-10-20). Dos mecanismos distintos
// producen titulares mal, y los dos aparecen en feeds vivos:
//
//   1. UN SEPARADOR INVISIBLE en vez de un espacio. Varios CMS meten
//      `U+200B` (espacio de ancho cero) o `&shy;` dentro de cifras largas
//      para que el navegador pueda cortar la línea ahí. En la página del
//      medio se leen dos palabras; en una lista como la nuestra, donde no
//      hay corte, se leen pegadas. `\s` de JavaScript no los incluye, así
//      que el colapso de espacios los dejaba pasar.
//
//   2. UN "MENOR QUE" EN PROSA leído como etiqueta. `/<[^>]*>/` no distingue
//      `<b>` de `<$100`, así que el patrón viejo se comía desde el `<` hasta
//      el siguiente `>` — cinco palabras y el precio, que es EL dato.
//
// Los dos están acá como feed completo y no como string suelto: lo que hay
// que fijar es lo que sale de `leeFeed`, que es lo que se guarda.
export const TITULARES_PEGADOS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Un medio</title>
  <item>
    <title>Nvidia hits $1.4T&#8203;valuation on AI demand</title>
    <link>https://medio.test/nvidia-1-4t</link>
    <pubDate>Mon, 20 Oct 2026 11:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Apple&#173;s margin squeeze</title>
    <link>https://medio.test/apple-margen</link>
    <pubDate>Mon, 20 Oct 2026 10:30:00 GMT</pubDate>
  </item>
  <item>
    <title>AMD &lt;$100 es compra &gt; 2027, dice la casa</title>
    <link>https://medio.test/amd-100</link>
    <pubDate>Mon, 20 Oct 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Tesla sube 4% <em>tras</em> el reporte]]></title>
    <link>https://medio.test/tesla</link>
    <pubDate>Mon, 20 Oct 2026 09:30:00 GMT</pubDate>
  </item>
</channel></rss>`;
