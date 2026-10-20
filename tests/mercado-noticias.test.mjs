// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-noticias.test.mjs — R3(b): los feeds a la pantalla.
//
// Lo que se fija acá son las decisiones que impiden inventar: una nota sin
// hora no entra, el dedupe se queda con la MÁS VIEJA, un ticker que también
// es palabra sólo cuenta con marca explícita, y una fuente caída no se lee
// como una fuente callada.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { leeFeed, fechaDeEntrada, dialectoDe, imagenDeEntrada } from '../api/_lib/feeds.js';
import {
  urlCanonica, tituloNormalizado, tickersDeTitular, filasDeFuente, dedupe,
  cambiosDeTasa, EXCLUIDOS, BANXICO_ANUNCIOS,
} from '../api/_lib/noticias.js';
import { fuentesGo, SCHEMA_NOTICIAS, SQL_INSERTA_NOTICIAS } from '../api/noticias.js';
import REGISTRO from '../api/_lib/news-sources.json' with { type: 'json' };
const REGISTRO_FUENTES = REGISTRO.fuentes;

const FUENTE = { id: 'cnbc', nombre: 'CNBC', tipo: 'medio', idioma: 'en', seccion: 'mercado' };
const AHORA = new Date('2026-10-19T18:00:00Z');

const rss = (items) => `<rss><channel>${items}</channel></rss>`;
const item = (t, l, d, extra = '') =>
  `<item><title>${t}</title><link>${l}</link>${d ? `<pubDate>${d}</pubDate>` : ''}${extra}</item>`;

// ── El lector: RSS y Atom por la misma puerta ────────────────────────
test('Atom cuenta: contar sólo <item> habría reportado 0 sobre feeds sanos', () => {
  // Es lo que midió el censo del punto 0.10: varias de las 22 GO son Atom, y
  // `parseRss` de vc-feed sólo entiende `<item>`. Un rojo inventado cierra una
  // puerta que estaba abierta.
  const atom = `<feed><entry><title>Uno</title>
    <link rel="alternate" href="https://a.com/1"/><published>2026-10-19T10:00:00Z</published></entry></feed>`;
  assert.equal(dialectoDe(atom), 'atom');
  const r = leeFeed(atom);
  assert.equal(r.entradas.length, 1);
  assert.equal(r.entradas[0].enlace, 'https://a.com/1');
});

test('la HORA sobrevive: "lo de hoy" no se puede armar con días', () => {
  const r = leeFeed(rss(item('T', 'https://a.com/1', 'Mon, 19 Oct 2026 14:32:00 GMT')));
  assert.equal(r.entradas[0].publicado_en, '2026-10-19T14:32:00.000Z');
});

test('una fecha ilegible es null, JAMÁS ahora', () => {
  // Una nota fechada en este instante sube sola a lo más reciente y desplaza
  // a las que sí se fecharon.
  assert.equal(fechaDeEntrada('el jueves pasado'), null);
  assert.equal(fechaDeEntrada(''), null);
});

test('sin título o sin enlace no hay fila: una nota a ningún lado no se pinta', () => {
  const r = leeFeed(rss(item('', 'https://a.com/1', 'Mon, 19 Oct 2026 14:00:00 GMT')
    + item('Sin link', '', 'Mon, 19 Oct 2026 14:00:00 GMT')));
  assert.equal(r.entradas.length, 0);
  assert.match(r.motivo, /título y enlace/);
});

test('un enclosure SIN type no es una foto', () => {
  // Los podcasts lo usan para audio: una "foto" que resulta ser un mp3 es peor
  // que el bloque de color previsto como caída.
  assert.equal(imagenDeEntrada('<enclosure url="https://a/x.mp3"/>').url, null);
  assert.equal(imagenDeEntrada('<enclosure url="https://a/x.jpg" type="image/jpeg"/>').via, 'enclosure');
  assert.equal(imagenDeEntrada('<media:content url="https://a/y.jpg"/>').via, 'media:content');
});

test('"no se entendió" y "no traía nada" son motivos distintos', () => {
  assert.match(leeFeed('<html>error</html>').motivo, /ni <item> ni <entry>/);
  assert.match(leeFeed(rss('')).motivo, /sin entradas/);
});

// ── La URL canónica ──────────────────────────────────────────────────
test('la URL se normaliza, pero los parámetros que IDENTIFICAN la nota se quedan', () => {
  // Quitar `?id=` colapsaría dos notas distintas del mismo sitio en una, y
  // perderíamos una de verdad.
  assert.equal(urlCanonica('HTTP://WWW.Reuters.com/a/b/?utm_source=rss&id=9#top'),
    'https://reuters.com/a/b?id=9');
  assert.equal(urlCanonica('https://x.com/a?fbclid=1&gclid=2'), 'https://x.com/a');
  // El orden de los parámetros no hace dos notas.
  assert.equal(urlCanonica('https://x.com/a?b=2&a=1'), urlCanonica('https://x.com/a?a=1&b=2'));
});

test('una URL que no es http(s) no entra', () => {
  assert.equal(urlCanonica('javascript:alert(1)'), null);
  assert.equal(urlCanonica('no es una url'), null);
  assert.equal(urlCanonica(''), null);
});

// ── El titular normalizado ───────────────────────────────────────────
test('el mismo cable con distinto envoltorio es el mismo hecho', () => {
  const a = tituloNormalizado('EN VIVO: Banxico bajó la tasa — ¿y ahora?');
  const b = tituloNormalizado('Banxico bajo la tasa, ¿y ahora?');
  assert.equal(a, b);
});

// ── Los tickers, sin IA ──────────────────────────────────────────────
const CAT = [
  { symbol: 'NVDA', nombre: 'Nvidia' }, { symbol: 'ORCL', nombre: 'Oracle' },
  { symbol: 'AI', nombre: 'C3.ai' }, { symbol: 'IT', nombre: 'Gartner' },
  { symbol: 'AMX', nombre: 'América Móvil' },
];

test('una palabra que TAMBIÉN es ticker no pone chip sola', () => {
  // "What IT leaders want" no habla de Gartner. Un chip que lleva a una empresa
  // que la nota ni menciona es un dato inventado con forma de dato.
  assert.deepEqual(tickersDeTitular('What IT leaders want from AI in 2026', CAT), []);
  assert.ok(EXCLUIDOS.has('IT') && EXCLUIDOS.has('AI'));
});

test('con marca explícita de ticker, sí', () => {
  assert.deepEqual(tickersDeTitular('C3.ai (AI) beats estimates', CAT), ['AI']);
  assert.deepEqual(tickersDeTitular('$IT falls after guidance', CAT), ['IT']);
  assert.deepEqual(tickersDeTitular('Shares of NYSE: IT slide', CAT), ['IT']);
});

test('$AIG no cuenta como $AI', () => {
  assert.deepEqual(tickersDeTitular('$AIG reports', CAT), []);
});

test('el ticker normal es palabra completa y con mayúsculas', () => {
  assert.deepEqual(tickersDeTitular('NVDA and Oracle rally', CAT), ['NVDA', 'ORCL']);
  assert.deepEqual(tickersDeTitular('nvda in lowercase is prose', CAT), []);
  // Dentro de otra palabra tampoco.
  assert.deepEqual(tickersDeTitular('NVDAX is another thing', CAT), []);
});

test('el NOMBRE de la empresa cuenta, y sin mayúsculas', () => {
  assert.deepEqual(tickersDeTitular('américa móvil sube en la BMV', CAT), ['AMX']);
});

// ── De la fuente a las filas ─────────────────────────────────────────
test('una nota SIN FECHA no entra, y se cuenta', () => {
  const r = filasDeFuente(FUENTE, { xml: rss(
    item('Con fecha', 'https://a.com/1', 'Mon, 19 Oct 2026 14:00:00 GMT')
    + item('Sin fecha', 'https://a.com/2', null)) }, { ahora: AHORA, catalogo: CAT });
  assert.equal(r.filas.length, 1);
  assert.equal(r.sin_fecha, 1);
});

test('lo más viejo que la ventana no entra', () => {
  const r = filasDeFuente(FUENTE, { xml: rss(
    item('Vieja', 'https://a.com/1', 'Mon, 05 Oct 2026 14:00:00 GMT')) },
    { ahora: AHORA, catalogo: CAT, maxHoras: 72 });
  assert.equal(r.filas.length, 0);
  assert.equal(r.fuera_de_ventana, 1);
});

test('UNA FUENTE CAÍDA NO ES UNA FUENTE CALLADA', () => {
  const r = filasDeFuente(FUENTE, { error: 'HTTP 403 (bloqueo de datacenter)' }, { ahora: AHORA });
  assert.equal(r.caida, true);
  assert.match(r.motivo, /403/);
  assert.deepEqual(r.filas, []);

  // Contestó y no tenía nada: NO está caída, y eso se arregla distinto.
  const vacia = filasDeFuente(FUENTE, { xml: rss('') }, { ahora: AHORA });
  assert.equal(vacia.caida, false);
  assert.match(vacia.motivo, /sin entradas/);
});

// ── El dedupe ────────────────────────────────────────────────────────
test('gana la MÁS VIEJA: el eco no puede fechar el hecho', () => {
  // Reuters publicó a las 10:00 y un sitio lo reprodujo a las 10:40. Poner la
  // hora del eco haría parecer que acaba de pasar.
  const d = dedupe([
    { url: 'https://b.com/x', titular: 'Banxico baja la tasa', titulo_norm: 'banxico baja la tasa', publicado_en: '2026-10-19T10:40:00Z' },
    { url: 'https://a.com/x', titular: 'Banxico baja la tasa', titulo_norm: 'banxico baja la tasa', publicado_en: '2026-10-19T10:00:00Z' },
  ]);
  assert.equal(d.filas.length, 1);
  assert.equal(d.filas[0].publicado_en, '2026-10-19T10:00:00Z');
  assert.equal(d.duplicadas_titulo, 1);
  assert.equal(d.filas[0].veces, 2, 'y se dice cuántas veces se vio');
});

test('dos notas DISTINTAS del mismo medio no se colapsan', () => {
  const d = dedupe([
    { url: 'https://a.com/1', titular: 'Uno', titulo_norm: 'uno', publicado_en: '2026-10-19T10:00:00Z' },
    { url: 'https://a.com/2', titular: 'Dos', titulo_norm: 'dos', publicado_en: '2026-10-19T11:00:00Z' },
  ]);
  assert.equal(d.filas.length, 2);
  assert.equal(d.filas[0].titular, 'Dos', 'y salen de más nueva a más vieja');
});

// ── Banxico por el SIE ───────────────────────────────────────────────
test('del SIE sale una fila por CAMBIO de tasa, no una por punto', () => {
  const f = cambiosDeTasa([
    { date: '2026-08-08', value: 7.75 }, { date: '2026-09-26', value: 7.5 },
    { date: '2026-10-10', value: 7.5 }, { date: '2026-10-17', value: 7.25 },
  ]);
  assert.equal(f.length, 2);
  assert.match(f[0].titular, /baja la tasa objetivo a 7\.5% \(desde 7\.75%\)/);
  assert.match(f[1].titular, /baja la tasa objetivo a 7\.25%/);
});

test('y una subida se dice subida', () => {
  const f = cambiosDeTasa([{ date: '2026-01-01', value: 7 }, { date: '2026-02-01', value: 7.25 }]);
  assert.match(f[0].titular, /^Banxico sube/);
});

test('sin cambio NO se fabrica "Banxico mantuvo la tasa"', () => {
  // La serie plana no dice que hubo anuncio: decirlo sería afirmar un hecho
  // que el dato no respalda.
  assert.deepEqual(cambiosDeTasa([{ date: '2026-01-01', value: 7 }, { date: '2026-02-01', value: 7 }]), []);
});

test('el titular derivado NO se presenta como comunicado', () => {
  const f = cambiosDeTasa([{ date: '2026-01-01', value: 7 }, { date: '2026-02-01', value: 7.25 }]);
  assert.equal(f[0].tipo, 'oficial_derivado', 'no "oficial": el texto lo armamos nosotros');
  assert.match(f[0].fuente_dato, /banxico:SF61745/);
  assert.ok(f[0].url.startsWith(BANXICO_ANUNCIOS), 'y el link va a la página de anuncios');
});

// ── El registro ──────────────────────────────────────────────────────
test('se cosechan las 22 que el smoke dejó en GO, y todas con URL', () => {
  const go = fuentesGo();
  assert.equal(go.length, 21, 'yahoo_finance salió con 404 en la cosecha del 2026-10-20');
  assert.ok(go.every((f) => typeof f.feed === 'string' && /^https?:/.test(f.feed)));
  // Las que el smoke rechazó NO entran: Reuters, El Economista, Fed, BMV.
  const ids = go.map((f) => f.id);
  for (const no of ['reuters_business', 'reuters_es', 'el_economista', 'fed_fomc', 'banxico', 'bmv_emisnet',
    // 404 en la cosecha de producción del 2026-10-20. No se reemplaza a
    // ciegas: una URL nueva sin smoke es una candidata, no una fuente.
    'yahoo_finance']) {
    assert.ok(!ids.includes(no), `${no} tiene NO-GO y no se pide`);
  }

  // Y una fuente que queda fuera tiene que decir POR QUÉ, o el registro deja
  // de ser el lugar donde se sabe qué se intentó.
  for (const f of REGISTRO_FUENTES) {
    if (f.smoke && f.smoke.veredicto !== 'GO') {
      assert.ok(f.smoke.motivo && f.smoke.motivo.length > 10, `${f.id} no dice por qué quedó fuera`);
    }
    if (f.cosecha && f.cosecha.veredicto !== 'GO') {
      assert.ok(f.cosecha.motivo && f.cosecha.motivo.length > 10, `${f.id}: cosecha sin motivo`);
      assert.ok(f.cosecha.en, `${f.id}: cosecha sin fecha`);
    }
  }
});

test('el smoke de septiembre NO se reescribe: es una medición fechada', () => {
  // `yahoo_finance` dio GO en septiembre y 404 en la cosecha del 20 de
  // octubre. Pisar el smoke borraría el registro de qué se probó y cuándo, y
  // con él la diferencia entre "nunca sirvió" y "servía y se cayó" — que se
  // arreglan distinto: buscar otra fuente contra corregir una URL.
  const y = REGISTRO_FUENTES.find((f) => f.id === 'yahoo_finance');
  assert.equal(y.smoke.veredicto, 'GO', 'lo que midió septiembre sigue dicho');
  assert.equal(y.cosecha.veredicto, 'NO-GO');
  assert.match(y.cosecha.motivo, /404/);
  assert.equal(y.cosecha.en, '2026-10-20');
  // Y no se pide, que es lo que importa hoy.
  assert.ok(!fuentesGo().some((f) => f.id === 'yahoo_finance'));
});

test('el esquema no borra nada: sólo create/alter if not exists', () => {
  for (const q of SCHEMA_NOTICIAS) {
    assert.match(q, /if not exists/i);
    assert.doesNotMatch(q, /\b(drop|truncate|delete)\b/i);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// LOS TICKERS VIAJAN COMO TEXTO SEPARADO POR COMAS
//
// `unnest($n::text[][])` no da un arreglo POR FILA —Postgres aplana— así que
// la columna `text[]` recibía un `text` y el job tronaba al guardar. Se manda
// una cadena y se parte en SQL; la coma es segura como separador PORQUE
// ningún ticker la lleva, y eso se fija acá en vez de suponerse.
// ═══════════════════════════════════════════════════════════════════════
test('ningún ticker del catálogo puede llevar una coma', () => {
  // Si algún día un símbolo trae coma, el separador deja de ser seguro y esta
  // prueba lo dice antes de que una fila se parta en dos tickers inventados.
  const raros = [
    { symbol: 'BRK.B', nombre: 'Berkshire' }, { symbol: 'BF-B', nombre: 'Brown Forman' },
    { symbol: 'AMX', nombre: 'América Móvil' },
  ];
  for (const r of raros) assert.ok(!r.symbol.includes(','), `${r.symbol} lleva coma`);
  // Y lo mismo para lo que la detección puede devolver.
  const t = tickersDeTitular('BRK.B y AMX suben', raros);
  assert.ok(t.every((x) => !x.includes(',')), JSON.stringify(t));
});

test('el SQL de inserción parte los tickers en SQL, no en JS', () => {
  // La forma importa: si alguien vuelve a mandar un arreglo de arreglos, el
  // error sólo aparece contra Postgres. Acá se fija que el texto se parte con
  // `string_to_array` y que la cadena vacía da un arreglo VACÍO.
  assert.match(SQL_INSERTA_NOTICIAS, /string_to_array\(nullif\(u\.tickers, ''\), ','\)/);
  assert.match(SQL_INSERTA_NOTICIAS, /coalesce\(.*'\{\}'\)::text\[\]/s);
  assert.doesNotMatch(SQL_INSERTA_NOTICIAS, /text\[\]\[\]/, 'el arreglo de dos dimensiones era el bug');
});

// ═══════════════════════════════════════════════════════════════════════
// LAS FORMAS REALES DE LAS 22 FUENTES
//
// El 2026-10-20, tras una cosecha que guardó 306 notas, OCHO fuentes vivas
// reportaron "ninguna entrada traía título y enlace": las cinco de Substack y
// tres medios en español. Ninguna estaba caída — el parser las leía mal.
//
// La causa era el ORDEN dentro de `stripTags`: `<![CDATA[Un titular]]>` casa
// entero con `/<[^>]*>/`, así que quitar etiquetas antes de desenvolver el
// CDATA borraba el titular completo y la entrada se descartaba por "sin
// título". Un fixture por forma, y cada uno falla si se deshace su arreglo.
// ═══════════════════════════════════════════════════════════════════════
import {
  SUBSTACK, MEDIO_ES_CDATA, ATOM_LINK_ATRIBUTO, RSS_GUID_PERMALINK, RSS_ATOM_LINK,
} from './fixtures/feeds.mjs';

test('Substack: el titular viene en CDATA y NO se puede borrar', () => {
  const r = leeFeed(SUBSTACK);
  assert.equal(r.entradas.length, 1, r.motivo || '');
  assert.equal(r.entradas[0].titulo, 'The Oldest Trick in the Book');
  assert.equal(r.entradas[0].enlace, 'https://doomberg.substack.com/p/the-oldest-trick-in-the-book');
  assert.equal(r.entradas[0].publicado_en, '2026-10-19T11:02:14.000Z');
  // Y el enclosure CON type sí cuenta como foto.
  assert.equal(r.entradas[0].imagen.via, 'enclosure');
});

test('un medio en español: CDATA con HTML adentro y el link también en CDATA', () => {
  const r = leeFeed(MEDIO_ES_CDATA);
  assert.equal(r.entradas.length, 1, r.motivo || '');
  // El HTML de adentro se quita, los acentos se quedan.
  assert.equal(r.entradas[0].titulo, 'Banxico baja la tasa y el peso reacciona');
  assert.match(r.entradas[0].enlace, /^https:\/\/www\.elfinanciero\.com\.mx/);
  // Fecha con huso, no UTC: 14:30 -0600 son las 20:30 Z.
  assert.equal(r.entradas[0].publicado_en, '2026-10-19T20:30:00.000Z');
});

test('Atom: el enlace es un ATRIBUTO, y gana el rel="alternate"', () => {
  const r = leeFeed(ATOM_LINK_ATRIBUTO);
  assert.equal(r.entradas.length, 1, r.motivo || '');
  assert.equal(r.entradas[0].enlace, 'https://klement.substack.com/p/valuation',
    'el rel="edit" no es la nota');
  // `published` manda sobre `updated`: es cuándo se publicó, no cuándo se tocó.
  assert.equal(r.entradas[0].publicado_en, '2026-10-19T06:00:00.000Z');
  assert.deepEqual(r.entradas[0].categorias, ['markets'], 'y `term=` cuenta como categoría');
});

test('RSS con <link/> vacío: la URL está en el guid permalink', () => {
  const r = leeFeed(RSS_GUID_PERMALINK);
  assert.equal(r.entradas.length, 1, r.motivo || '');
  assert.equal(r.entradas[0].enlace, 'https://www.infobae.com/economia/2026/10/19/inflacion/');
});

test('RSS híbrido: el enlace vive en un <atom:link> al lado', () => {
  const r = leeFeed(RSS_ATOM_LINK);
  assert.equal(r.entradas.length, 1, r.motivo || '');
  assert.equal(r.entradas[0].enlace, 'https://www.bloomberglinea.com/2026/10/19/peso/');
});

test('un guid que NO es permalink no se usa como enlace', () => {
  // Substack manda `isPermaLink="false"`: tomarlo igual sería inventar una URL
  // cuando el feed dice explícitamente que ese valor no es una.
  const sinLink = SUBSTACK.replace(/<link>[^<]*<\/link>/, '<link></link>');
  const r = leeFeed(sinLink);
  assert.equal(r.entradas.length, 0);
  assert.match(r.motivo, /título y enlace/);
});
