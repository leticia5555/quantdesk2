// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-noticias-pagina.test.mjs — R3b: la página de noticias.
//
// LO QUE SE FIJA ACÁ es el contrato de `armaPagina`, que es lo que la pantalla
// pinta. Está en un módulo y no dentro del HTML a propósito: así "Solo
// español filtra bien" se prueba sin levantar un navegador, y el Chromium se
// queda para lo que sólo se ve en un navegador (el tap, el layout, la caída
// de la foto).
//
// Las tres que más importan, y por qué:
//   · LAS DESTACADAS NO INVENTAN FOTO. El encargo prohíbe scrapear og:image,
//     así que con menos de cuatro fotos se completan SIN foto y se dice.
//   · UNA SECCIÓN SIN FUENTE SE DECLARA. Cripto y ETFs están en la cabecera
//     del artboard y ninguna fuente del registro publica ahí: la pestaña va
//     punteada con "pronto", calculado, no escrito a mano.
//   · "ACCIONES" NO ES UNA FUENTE. El encargo la define como las notas con al
//     menos un ticker, y eso es por nota.
// ═══════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECCIONES, seccionesSinFuente, enSeccion, filtra, destacadasDe,
  imagenDeLaPagina, normalizaUrlImagen, candidatasDeFoto,
  porFuente, chipsDeFuente, armaPagina, paraBuscar,
} from '../api/_lib/noticias-pagina.js';

const nota = (o = {}) => ({
  url: 'https://x/' + (o.url || Math.random().toString(36).slice(2)),
  titular: 'Un titular', fuente_id: 'cnbc', fuente_nombre: 'CNBC',
  tipo: 'medio', idioma: 'en', seccion: 'mercado',
  publicado_en: '2026-10-20T12:00:00.000Z', imagen: null, tickers: [], fuente_dato: null,
  ...o,
});

test('las seis secciones del artboard, en su orden', () => {
  assert.deepEqual(SECCIONES.map((s) => s.id),
    ['mercado', 'mexico_latam', 'acciones', 'etfs', 'cripto', 'oficiales']);
});

test('una sección sin ninguna fuente que la alimente se calcula, no se escribe a mano', () => {
  const fuentes = [
    { id: 'cnbc', seccion: 'mercado' },
    { id: 'el_financiero', seccion: 'mexico_latam' },
    { id: 'sec_8k', seccion: 'oficiales' },
  ];
  // Cripto y ETFs: ninguna fuente del registro publica ahí → "pronto".
  assert.deepEqual(seccionesSinFuente(fuentes), ['etfs', 'cripto']);
  // Y "Acciones" NUNCA sale como sin fuente: se alimenta de las demás.
  assert.ok(!seccionesSinFuente(fuentes).includes('acciones'));
});

test('el registro REAL no deja Cripto ni ETFs con fuente: la pestaña va punteada', async () => {
  const { fuentesGo } = await import('../api/noticias.js');
  const sin = seccionesSinFuente(fuentesGo());
  assert.ok(sin.includes('etfs'), 'ETFs sin fuente declarada');
  assert.ok(sin.includes('cripto'), 'Cripto sin fuente declarada');
  assert.ok(!sin.includes('mercado'), 'Mercado sí tiene fuentes');
  assert.ok(!sin.includes('oficiales'), 'Oficiales sí tiene fuentes');
});

test('"Acciones" es por NOTA (tiene ticker), no por fuente', () => {
  assert.equal(enSeccion(nota({ tickers: ['NVDA'] }), 'acciones'), true);
  assert.equal(enSeccion(nota({ tickers: [] }), 'acciones'), false);
  // Y no importa en qué sección venga la fuente: una nota de México con
  // ticker cuenta como acción.
  assert.equal(enSeccion(nota({ seccion: 'mexico_latam', tickers: ['WALMEX'] }), 'acciones'), true);
});

test('"Solo español" filtra por el idioma de la FUENTE, no del titular', () => {
  const ns = [nota({ idioma: 'es' }), nota({ idioma: 'en' }), nota({ idioma: 'pt' })];
  assert.equal(filtra(ns, { idioma: 'es' }).length, 1);
  assert.equal(filtra(ns, { idioma: 'todo' }).length, 3);
});

test('la búsqueda ignora acentos y mayúsculas, y alcanza al ticker y a la fuente', () => {
  const ns = [
    nota({ titular: 'Banxico recortó la tasa', fuente_nombre: 'El Economista' }),
    nota({ titular: 'Nvidia sube', tickers: ['NVDA'] }),
  ];
  assert.equal(filtra(ns, { q: 'recorto' }).length, 1, 'sin acento encuentra "recortó"');
  assert.equal(filtra(ns, { q: 'ECONOMISTA' }).length, 1, 'encuentra por fuente');
  assert.equal(filtra(ns, { q: 'nvda' }).length, 1, 'encuentra por ticker');
  assert.equal(filtra(ns, { q: 'zzz' }).length, 0);
  // La ñ también se descompone: "ñoño" → "nono". Es lo correcto para buscar,
  // porque los dos lados pasan por la misma normalización — quien escribe
  // "nono" o "ñoño" encuentra lo mismo. Es lo que ya hace `tituloNormalizado`.
  assert.equal(paraBuscar('Ñoño ÁÉÍ'), 'nono aei');
  assert.equal(filtra([nota({ titular: 'Peña y el peso' })], { q: 'pena' }).length, 1);
});

test('un chip de fuente filtra a esa fuente y a ninguna otra', () => {
  const ns = [nota({ fuente_id: 'cnbc' }), nota({ fuente_id: 'doomberg' })];
  assert.equal(filtra(ns, { fuente: 'doomberg' }).length, 1);
});

// ── LAS DESTACADAS ───────────────────────────────────────────────────
//
// UNA DESTACADA ES UNA NOTA CON FOTO. Lety, 2026-10-22, mirando el iPhone:
// una destacada sin foto salía como un bloque de color con el nombre del
// medio y se veía mal. Tiene razón — un rectángulo plano al lado de tres
// fotos reales no se lee como "esta nota no trajo imagen", se lee como que la
// página está rota.
//
// Y UNA POR FUENTE: la primera versión era `conFoto.slice(0, cuantas)` y en
// producción dio las cuatro del MISMO medio (Valor BR publica todo con
// imagen). El que más publica no es "lo destacado".
test('cuatro destacadas, con foto y de cuatro fuentes distintas', () => {
  const ns = [
    nota({ url: 'a', fuente_id: 'f1', imagen: 'https://i/1.jpg' }),
    nota({ url: 'b', fuente_id: 'f2', imagen: 'https://i/2.jpg' }),
    nota({ url: 'c', fuente_id: 'f3', imagen: 'https://i/3.jpg' }),
    nota({ url: 'd', fuente_id: 'f4', imagen: 'https://i/4.jpg' }),
    nota({ url: 'e', fuente_id: 'f5', imagen: 'https://i/5.jpg' }),
  ];
  const r = destacadasDe(ns);
  assert.equal(r.destacadas.length, 4);
  assert.equal(new Set(r.destacadas.map((n) => n.fuente_id)).size, 4);
  assert.ok(r.destacadas.every((n) => n.imagen));
});

test('una nota SIN foto no es destacada, ni para rellenar', () => {
  const r = destacadasDe([
    nota({ url: 'a', fuente_id: 'f1', imagen: 'https://i/1.jpg' }),
    nota({ url: 'b', fuente_id: 'f2', imagen: null }),
    nota({ url: 'c', fuente_id: 'f3', imagen: null }),
  ]);
  assert.equal(r.destacadas.length, 1, 'se muestran las que hay, no se completa');
  assert.equal(r.destacadas[0].url, 'a');
});

test('sin ninguna foto no hay destacadas, y se dice por qué', () => {
  const r = destacadasDe(Array.from({ length: 6 }, (_, i) => nota({ url: 'n' + i, fuente_id: 'f' + i })));
  assert.equal(r.destacadas.length, 0, 'la sección no aparece');
  assert.match(r.motivo_vacio, /foto propia/);
});

test('el medio que publica TODO con foto aporta una, no las cuatro', () => {
  const ns = [
    ...Array.from({ length: 4 }, (_, i) => nota({
      url: 'valor' + i, fuente_id: 'valor_br', fuente_nombre: 'Valor BR',
      imagen: 'https://valor/' + i + '.jpg', publicado_en: `2026-10-20T1${5 - i}:00:00.000Z`,
    })),
    nota({ url: 'x', fuente_id: 'cnbc', imagen: 'https://i/x.jpg', publicado_en: '2026-10-20T11:00:00.000Z' }),
    nota({ url: 'y', fuente_id: 'mw', imagen: 'https://i/y.jpg', publicado_en: '2026-10-20T10:00:00.000Z' }),
  ];
  const r = destacadasDe(ns);
  const ids = r.destacadas.map((n) => n.fuente_id);
  assert.equal(ids.filter((f) => f === 'valor_br').length, 1);
  // Y la que aporta es su MÁS NUEVA.
  assert.equal(r.destacadas.find((n) => n.fuente_id === 'valor_br').url, 'valor0');
  // Cuántas candidatas con foto había en total: dice si la franja se queda
  // corta por falta de fotos o por falta de variedad.
  assert.equal(r.con_foto_total, 6);
});

// ── POR FUENTE ───────────────────────────────────────────────────────
test('"Por fuente" agrupa y pone adelante a la que más publicó', () => {
  const ns = [
    nota({ fuente_id: 'cnbc', fuente_nombre: 'CNBC' }),
    nota({ fuente_id: 'mw', fuente_nombre: 'MarketWatch' }),
    nota({ fuente_id: 'cnbc', fuente_nombre: 'CNBC' }),
  ];
  const g = porFuente(ns);
  assert.equal(g.length, 2);
  assert.equal(g[0].fuente_id, 'cnbc');
  assert.equal(g[0].notas.length, 2);
});

test('y un empate de conteo se rompe por alfabeto, no por el orden de llegada', () => {
  // Sin desempate declarado, dos fuentes con el mismo número de notas salen
  // en el orden en que el `Map` las vio —o sea, en el orden de la tabla—, y la
  // columna se reordena sola entre dos cargas sin que nada haya cambiado.
  const ns = [
    nota({ url: 'z1', fuente_id: 'zebra', fuente_nombre: 'Zebra' }),
    nota({ url: 'a1', fuente_id: 'alfa', fuente_nombre: 'Alfa' }),
    nota({ url: 'z2', fuente_id: 'zebra', fuente_nombre: 'Zebra' }),
    nota({ url: 'a2', fuente_id: 'alfa', fuente_nombre: 'Alfa' }),
  ];
  assert.deepEqual(porFuente(ns).map((g) => g.fuente_nombre), ['Alfa', 'Zebra']);
});

// ── LOS CHIPS ────────────────────────────────────────────────────────
test('el chip distingue caída de "no se ha cosechado": se arreglan distinto', () => {
  const go = [
    { id: 'cnbc', nombre: 'CNBC', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
    { id: 'zerohedge', nombre: 'ZeroHedge', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
    { id: 'klement', nombre: 'Klement', idioma: 'en', tipo: 'newsletter', seccion: 'mercado' },
  ];
  const chips = chipsDeFuente(go, [
    { fuente_id: 'cnbc', ok: true, motivo: null, guardadas: 12, ultima_corrida: '2026-10-20T12:00:00Z' },
    { fuente_id: 'zerohedge', ok: false, motivo: 'HTTP 403 (bloqueo de datacenter)', guardadas: 0, ultima_corrida: '2026-10-20T12:00:00Z' },
  ]);
  const por = Object.fromEntries(chips.map((c) => [c.id, c]));
  assert.equal(por.cnbc.estado, 'ok');
  assert.equal(por.zerohedge.estado, 'source_down');
  assert.match(por.zerohedge.motivo, /403/);
  assert.equal(por.klement.estado, 'sin_cosechar');
  assert.equal(por.klement.ok, null, 'tri-estado: null no es false');
  assert.match(por.klement.motivo, /no se ha cosechado/);
});

// ── EL ARMADO COMPLETO ───────────────────────────────────────────────
test('armaPagina reparte en medios / newsletters / oficiales y cuenta cada sección', () => {
  const ns = [
    nota({ url: 'm1', tipo: 'medio', seccion: 'mercado', tickers: ['NVDA'] }),
    nota({ url: 'm2', tipo: 'medio', seccion: 'mexico_latam', idioma: 'es' }),
    nota({ url: 'n1', tipo: 'newsletter', seccion: 'mercado' }),
    nota({ url: 'o1', tipo: 'oficial', seccion: 'oficiales' }),
    nota({ url: 'o2', tipo: 'oficial_derivado', seccion: 'oficiales', fuente_dato: 'banxico:SF61745' }),
  ];
  const r = armaPagina(ns);
  assert.equal(r.medios.length, 2);
  assert.equal(r.newsletters.length, 1);
  // `oficial_derivado` ENTRA en oficiales: es lo que arma `cambiosDeTasa`
  // desde el SIE, y sin esta línea se perdía de su columna.
  assert.equal(r.oficiales.length, 2);
  assert.equal(r.otros.length, 0);
  assert.equal(r.conteos.acciones, 1, 'una sola nota trae ticker');
  assert.equal(r.conteos.mexico_latam, 1);
  assert.equal(r.conteos.cripto, 0);
  assert.equal(r.total, 5);
});

test('un tipo desconocido NO se tira en silencio: queda en `otros`', () => {
  const r = armaPagina([nota({ tipo: 'bitacora' })]);
  assert.equal(r.otros.length, 1);
  assert.equal(r.medios.length, 0);
});

test('"Por fuente" devuelve los grupos y deja la lista plana vacía: la pantalla pinta una u otra', () => {
  const ns = [nota({ url: 'a' }), nota({ url: 'b', fuente_id: 'mw', fuente_nombre: 'MarketWatch' })];
  const r = armaPagina(ns, { orden: 'fuente' });
  assert.equal(r.medios.length, 0);
  assert.equal(r.medios_por_fuente.length, 2);
  // El TOTAL sigue siendo el real: el toggle cambia la forma, no el universo.
  assert.equal(r.medios_total, 2);
});

test('el tope por columna recorta pero el total dice cuántas había: así "cargar más" sabe', () => {
  const ns = Array.from({ length: 40 }, (_, i) => nota({ url: 'm' + i }));
  const r = armaPagina(ns, { porColumna: 10 });
  assert.equal(r.medios.length, 10);
  assert.equal(r.medios_total, 40);
});

test('lo que está arriba NO se repite en Medios', () => {
  // ESTA PRUEBA EXIGÍA LA REPETICIÓN, con el argumento de que sacarla
  // descuadraba el conteo y hacía que "cargar más" devolviera huecos.
  // Lety, mirando producción (2026-10-20): *"No repitas en Medios las notas
  // que ya están en destacadas."*
  //
  // El argumento de los huecos era real y se resolvió donde tocaba: la lista
  // se arma DESPUÉS de restar, así que `porColumna` cuenta notas que se van
  // a ver y el total no incluye lo que ya está arriba.
  const ns = Array.from({ length: 6 }, (_, i) => nota({ url: 'm' + i, imagen: 'https://i/' + i }));
  const r = armaPagina(ns);
  const urls = new Set(r.medios.map((n) => n.url));
  // Por URL y no por cuántos elementos hay: la portada de la revista y la
  // primera destacada son LA MISMA NOTA, así que contar las listas sumadas
  // la contaría dos veces. `armaPagina` resta por URL, y la prueba también.
  const arriba = new Set([r.revista.portada, ...r.revista.medianas, ...r.destacadas]
    .filter(Boolean).map((n) => n.url));
  assert.ok(arriba.size > 0, 'el fixture tiene que poner algo arriba o no mide nada');
  for (const u of arriba) {
    assert.ok(!urls.has(u), `${u} está arriba y además en Medios`);
  }
  // Y el total es lo que queda para la lista, no el total de la ventana: si
  // contara lo de arriba, "cargar más (N)" prometería notas que nunca llegan.
  assert.equal(r.medios_total, 6 - arriba.size);
});

test('un filtro que no deja nada da listas vacías, no un error', () => {
  const r = armaPagina([nota({ idioma: 'en' })], { idioma: 'es' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.destacadas, []);
  assert.equal(r.medios_total, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// LA FOTO LEÍDA DE LA PROPIA NOTA
//
// Lety, 2026-10-22: *"La foto sale de la propia nota: para las candidatas a
// destacada, el cron lee la página del artículo y toma su `og:image`."*
//
// Es un cambio sobre el encargo de septiembre, que prohibía ir a buscarla.
// Lo que NO cambia: no se baja la imagen, no se guarda, no se recorta y no se
// lee el cuerpo del artículo. Se mira la cabecera, se queda la URL.
// ═══════════════════════════════════════════════════════════════════════
const NOTA = 'https://medio.test/seccion/nota-1';

test('lee og:image de la cabecera', () => {
  const r = imagenDeLaPagina('<html><head><meta property="og:image" content="https://m.test/a.jpg"></head>', NOTA);
  assert.equal(r.url, 'https://m.test/a.jpg');
  assert.equal(r.via, 'og:image');
});

test('y aguanta las formas en que los medios la escriben', () => {
  const casos = [
    // El orden de los atributos cambia de un CMS a otro.
    ['<head><meta content="https://m.test/b.jpg" property="og:image"></head>', 'https://m.test/b.jpg'],
    // Twitter la publica con `name=`, no con `property=`.
    ['<head><meta name="twitter:image" content="https://m.test/c.jpg"></head>', 'https://m.test/c.jpg'],
    // Comillas simples.
    ["<head><meta property='og:image' content='https://m.test/d.jpg'></head>", 'https://m.test/d.jpg'],
    // Sin comillas.
    ['<head><meta property=og:image content=https://m.test/e.jpg></head>', 'https://m.test/e.jpg'],
    // Protocolo implícito: la mitad de los CDN la mandan así.
    ['<head><meta property="og:image" content="//cdn.test/f.jpg"></head>', 'https://cdn.test/f.jpg'],
    // Ruta relativa, que hay que resolver contra la URL de la nota.
    ['<head><meta property="og:image" content="/fotos/g.jpg"></head>', 'https://medio.test/fotos/g.jpg'],
    // Entidad HTML dentro de la query: sin desescapar, la URL da 404.
    ['<head><meta property="og:image" content="https://m.test/h.jpg?w=1&amp;h=2"></head>', 'https://m.test/h.jpg?w=1&h=2'],
  ];
  for (const [html, esperada] of casos) {
    assert.equal(imagenDeLaPagina(html, NOTA).url, esperada, html.slice(0, 60));
  }
});

test('prefiere og:image sobre twitter:image cuando están las dos', () => {
  const r = imagenDeLaPagina(
    '<head><meta name="twitter:image" content="https://m.test/t.jpg">'
    + '<meta property="og:image" content="https://m.test/og.jpg"></head>', NOTA);
  assert.equal(r.url, 'https://m.test/og.jpg');
});

test('sólo mira la CABECERA: una og:image en el cuerpo no cuenta', () => {
  // En el cuerpo puede venir dentro de un comentario, de un script o de una
  // nota relacionada: no es la foto de ESTA nota. Y el cuerpo es justo lo que
  // no queremos leer.
  const r = imagenDeLaPagina(
    '<head><title>t</title></head><body><meta property="og:image" content="https://m.test/x.jpg"></body>', NOTA);
  assert.equal(r.url, null);
});

test('un `data:` no entra, y un `http:` se sube a https', () => {
  // `data:` pesa y no se puede volver a pedir; una imagen `http` en una
  // página `https` la bloquea el navegador y la tarjeta quedaría con el hueco
  // que esto vino a quitar.
  assert.equal(imagenDeLaPagina('<head><meta property="og:image" content="data:image/gif;base64,AA"></head>', NOTA).url, null);
  assert.equal(normalizaUrlImagen('http://m.test/a.jpg', NOTA), 'https://m.test/a.jpg');
  assert.equal(normalizaUrlImagen('javascript:alert(1)', NOTA), null);
  assert.equal(normalizaUrlImagen('', NOTA), null);
});

test('sin og:image lo dice, y distingue "no la declara" de "no hay metas"', () => {
  assert.match(imagenDeLaPagina('<head><meta name="description" content="x"></head>', NOTA).motivo,
    /no declara og:image/);
  assert.match(imagenDeLaPagina('<head><title>sólo título</title></head>', NOTA).motivo,
    /no trae etiquetas meta/);
  assert.match(imagenDeLaPagina('', NOTA).motivo, /vacía/);
});

// ── A QUIÉN SE LE PIDE LA FOTO ───────────────────────────────────────
test('se piden las más nuevas, y una por fuente antes que dos de la misma', () => {
  // Pedir las 300 notas de una cosecha serían 300 peticiones a ocho dominios:
  // así es como un medio nos bloquea. Y el orden es el mismo con el que la
  // pantalla elige destacadas, así que lo que se pide es lo que se va a
  // mostrar.
  const n = (url, fuente_id, hora) => ({ url, fuente_id, imagen: null, publicado_en: `2026-10-22T${hora}:00:00Z` });
  const r = candidatasDeFoto([
    n('a', 'valor', '10'), n('b', 'valor', '09'), n('c', 'cnbc', '08'),
    n('d', 'mw', '07'), n('e', 'valor', '11'),
  ], { cuantas: 4 });
  assert.deepEqual(r.map((x) => x.url), ['e', 'c', 'd', 'a']);
});

test('no se le pide la foto a una nota que ya la tiene', () => {
  const r = candidatasDeFoto([
    { url: 'a', fuente_id: 'f1', imagen: 'https://i/1.jpg', publicado_en: '2026-10-22T10:00:00Z' },
    { url: 'b', fuente_id: 'f2', imagen: null, publicado_en: '2026-10-22T09:00:00Z' },
  ]);
  assert.deepEqual(r.map((x) => x.url), ['b']);
});

test('el tope se respeta: es el presupuesto de cortesía con los medios', () => {
  const muchas = Array.from({ length: 100 }, (_, i) => ({
    url: 'u' + i, fuente_id: 'f' + (i % 3), imagen: null,
    publicado_en: '2026-10-22T10:00:00Z',
  }));
  assert.equal(candidatasDeFoto(muchas).length, 20);
  assert.equal(candidatasDeFoto(muchas, { cuantas: 5 }).length, 5);
});

// ── LA PETICIÓN A LA NOTA: ACOTADA Y CON NOMBRE ──────────────────────
//
// Leer la página de una nota es ir al sitio de un tercero. Los topes no son
// decoración: son lo que distingue "leer una cabecera" de "raspar un sitio".
const { cabeceraDe, FOTO_UA, FOTOS_POR_CORRIDA } = await import('../api/noticias.js');

const respuesta = (body, { status = 200, tipo = 'text/html' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? tipo : null) },
  text: async () => body,
});

test('se presenta con un User-Agent propio, no con uno de navegador fingido', () => {
  // Fingir un navegador es mentirle al medio sobre quién está pidiendo. Un
  // agente propio deja que nos bloqueen si no nos quieren, que es su derecho.
  assert.match(FOTO_UA, /QuantDesk/);
  assert.match(FOTO_UA, /https:\/\//, 'dice dónde averiguar quiénes somos');
  assert.ok(!/Mozilla|Chrome|Safari/.test(FOTO_UA), 'no finge ser un navegador');
  assert.equal(FOTOS_POR_CORRIDA, 20);
});

test('manda ese agente en la petición', async () => {
  let visto = null;
  await cabeceraDe('https://medio.test/n', {
    fetchImpl: async (url, opts) => { visto = opts; return respuesta('<head></head>'); },
  });
  assert.equal(visto.headers['user-agent'], FOTO_UA);
  assert.match(visto.headers.accept, /html/);
});

test('una nota que contesta 404 se declara, no se reintenta sola', async () => {
  const r = await cabeceraDe('https://medio.test/n', {
    fetchImpl: async () => respuesta('no', { status: 404 }),
  });
  assert.equal(r.html, null);
  assert.match(r.motivo, /HTTP 404/);
});

test('y lo que no es HTML ni se lee', async () => {
  // Un PDF o una imagen pueden pesar megabytes y no tienen og:image.
  const r = await cabeceraDe('https://medio.test/n.pdf', {
    fetchImpl: async () => respuesta('%PDF', { tipo: 'application/pdf' }),
  });
  assert.equal(r.html, null);
  assert.match(r.motivo, /no devolvió HTML/);
});

test('un sitio que no contesta se corta por tiempo y lo dice', async () => {
  const r = await cabeceraDe('https://medio.test/lento', {
    timeoutMs: 40,
    fetchImpl: (url, opts) => new Promise((_, rechaza) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('abortada'); e.name = 'AbortError'; rechaza(e);
      });
    }),
  });
  assert.equal(r.html, null);
  assert.match(r.motivo, /no contestó en 40 ms/);
});

// ═══════════════════════════════════════════════════════════════════════
// EL LOGO DEL MEDIO NO ES UNA FOTO
//
// Lety, contra producción a 1440 (2026-10-20):
//   · *"Valor (BR) sale como bloque verde con el nombre."*
//   · *"Seeking Alpha usa su logo como og:image. Si la misma URL de imagen se
//     repite en 2 o más notas de la misma fuente, es un logo y no cuenta como
//     foto."*
//
// Lo primero NO era relleno nuestro: el relleno estaba borrado y los tres
// caminos de pintado exigen `n.imagen` y emiten un `<img>`. Era la propia
// `og:image` de Valor, que es su logo verde con su nombre encima. O sea el
// mismo defecto que Seeking Alpha, y una sola regla los tapa a los dos.
// ═══════════════════════════════════════════════════════════════════════

import { logosDeFuente, esLogoDeFuente, conFotoReal, claveDeImagen } from '../api/_lib/noticias-pagina.js';

const notaLogo = (i, fuente, imagen, extra = {}) => ({
  url: `https://${fuente}.test/${i}`, titular: `titular ${i}`,
  fuente_id: fuente, fuente_nombre: fuente, tipo: 'medio', idioma: 'en', seccion: 'mercado',
  publicado_en: `2026-10-20T1${9 - (i % 10)}:00:00Z`, imagen, tickers: [], ...extra,
});

test('dos notas de la misma fuente con la misma imagen: es el logo', () => {
  const ns = [notaLogo(1, 'sa', 'https://sa.test/logo.png'), notaLogo(2, 'sa', 'https://sa.test/logo.png')];
  const logos = logosDeFuente(ns);
  assert.equal(logos.size, 1);
  assert.ok(esLogoDeFuente(ns[0], logos));
  assert.ok(esLogoDeFuente(ns[1], logos));
});

test('UNA sola nota con esa imagen todavía no es un logo', () => {
  // El umbral es dos, y con una sola no hay forma de saberlo: una foto que
  // aparece una vez es exactamente lo que es una foto.
  const ns = [notaLogo(1, 'cnbc', 'https://cnbc.test/foto.jpg')];
  assert.equal(logosDeFuente(ns).size, 0);
  assert.equal(conFotoReal(ns).conFoto.length, 1);
});

test('el sello de caché no disfraza al logo: la query no cuenta', () => {
  // Los logos vienen con `?v=3` o un sello que cambia sin que cambie la
  // imagen. Comparando con la query adentro, dos copias del MISMO logo se
  // verían distintas y las dos entrarían a destacadas.
  assert.equal(claveDeImagen('https://sa.test/logo.png?v=3'), 'https://sa.test/logo.png');
  assert.equal(claveDeImagen('https://sa.test/logo.png#x'), 'https://sa.test/logo.png');
  const ns = [notaLogo(1, 'sa', 'https://sa.test/logo.png?v=3'),
    notaLogo(2, 'sa', 'https://sa.test/logo.png?v=7')];
  assert.equal(logosDeFuente(ns).size, 1, 'el mismo logo con dos sellos sigue siendo uno');
});

test('la misma imagen en DOS fuentes distintas no es el logo de ninguna', () => {
  // Dos medios que publican la misma foto de agencia (Reuters, AP) es normal
  // y no dice nada sobre si es un logo. La cuenta es POR FUENTE.
  const ns = [notaLogo(1, 'cnbc', 'https://agencia/foto.jpg'), notaLogo(2, 'mw', 'https://agencia/foto.jpg')];
  assert.equal(logosDeFuente(ns).size, 0);
  assert.equal(conFotoReal(ns).conFoto.length, 2);
});

test('la nota del logo NO se descarta: pierde la franja, no la lista', () => {
  const ns = [notaLogo(1, 'sa', 'https://sa.test/logo.png'), notaLogo(2, 'sa', 'https://sa.test/logo.png'),
    notaLogo(3, 'cnbc', 'https://cnbc.test/foto-real.jpg')];
  const r = armaPagina(ns);
  const arriba = new Set([r.revista.portada, ...r.revista.medianas, ...r.destacadas]
    .filter(Boolean).map((n) => n.url));
  for (const u of arriba) assert.ok(!/sa\.test/.test(u), `${u} es un logo y llegó a la franja`);
  // Y las dos notas de Seeking Alpha siguen estando: en la lista.
  const enLista = new Set(r.medios.map((n) => n.url));
  assert.ok(enLista.has('https://sa.test/1') && enLista.has('https://sa.test/2'),
    'la nota no se tira por traer el logo del medio');
});

test('el motivo dice la causa real y cuántas veces se repitió (regla 2)', () => {
  const ns = [notaLogo(1, 'valor', 'https://valor.test/logo.png'),
    notaLogo(2, 'valor', 'https://valor.test/logo.png'),
    notaLogo(3, 'valor', 'https://valor.test/logo.png')];
  const { descartadas } = conFotoReal(ns);
  assert.equal(descartadas.length, 3);
  assert.match(descartadas[0].motivo, /es su logo/);
  assert.match(descartadas[0].motivo, /3 notas/, 'el número es el dato que permite verificarlo');
});

test('si TODO lo que hay con imagen es un logo, la franja no aparece y dice por qué', () => {
  const ns = [notaLogo(1, 'sa', 'https://sa.test/logo.png'), notaLogo(2, 'sa', 'https://sa.test/logo.png')];
  const d = destacadasDe(ns);
  assert.deepEqual(d.destacadas, []);
  assert.match(d.motivo_vacio, /logo de su medio/,
    'no puede decir "ninguna trae foto": sí traen imagen, y la causa es otra');
});
