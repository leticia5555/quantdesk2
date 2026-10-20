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
