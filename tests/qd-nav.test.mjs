// ═══════════════════════════════════════════════════════════════════════
// tests/qd-nav.test.mjs — EL MENÚ COMPARTIDO (R9, punto 1)
//
// Lo que se prueba acá es la parte PURA: qué pestaña le toca a cada ruta, a
// dónde manda el buscador, y que el CSS declare las piezas de las que
// dependen las doce páginas. La geometría —que el menú esté, que mida 44 px
// de tap, que no desborde— se mide en `scripts/menu-chromium.mjs`, que carga
// las páginas de verdad.
//
// LA REGLA UNO DEL ENCARGO: no se borra ninguna página. Así que las rutas
// viejas —`/hoy`, `/leaderboard`, `/libros`, `/terminal`, `/inicio`— también
// tienen que poder encender su pestaña, o quedarían como huérfanas dentro de
// su propia sección.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const NAV = require(join(ROOT, 'qd-nav.js'));

test('las cinco pestañas del encargo, en su orden', () => {
  assert.deepEqual(NAV.QD_NAV_TABS.map((t) => t.texto),
    ['Mercado', 'Noticias', 'La Liga', 'Insiders', 'Herramientas']);
});

test('en celular la barra de abajo son CUATRO, y Herramientas no es una de ellas', () => {
  const abajo = NAV.QD_NAV_TABS.filter((t) => t.movil);
  assert.equal(abajo.length, 4);
  assert.ok(!abajo.some((t) => t.id === 'herramientas'),
    'Herramientas no va en la barra de abajo (encargo R9, punto 1)');
});

test('y lo que no está en la barra de abajo SÍ está en el pie de la hoja', () => {
  // La tira de celular se quedó sin pestañas (*"solo una tira de ~44 px con
  // logo y lupa"*), así que el pie de la hoja del buscador es la ÚNICA puerta
  // que le queda a "Herramientas" en el teléfono. Sin ella, `/app`,
  // `/terminal` y `/historia` se vuelven inalcanzables desde el celular, y la
  // regla uno del encargo es "no borres ninguna página ni función".
  const pie = NAV.qdNavHtmlHojaPie();
  for (const t of NAV.QD_NAV_TABS.filter((x) => !x.movil)) {
    assert.ok(pie.includes('href="' + t.href + '"'),
      `"${t.texto}" no tiene cómo abrirse en el teléfono: no está abajo ni en el pie`);
  }
  // Y al revés: lo que ya está al alcance del pulgar no se repite.
  for (const t of NAV.QD_NAV_TABS.filter((x) => x.movil)) {
    assert.ok(!pie.includes('href="' + t.href + '"'),
      `"${t.texto}" ya está en la barra de abajo; repetirlo en el pie es cobrar dos veces`);
  }
});

test('el pie sale de QD_NAV_TABS, no de una lista aparte', () => {
  // Si mañana una pestaña entra o sale de la barra de abajo, el pie se tiene
  // que acomodar solo. Se comprueba moviendo "Herramientas" a `movil:true` y
  // viendo que el pie se queda vacío.
  const tab = NAV.QD_NAV_TABS.find((t) => t.id === 'herramientas');
  const antes = tab.movil;
  try {
    tab.movil = true;
    assert.equal(NAV.qdNavHtmlHojaPie(), '',
      'con las cinco abajo, el pie no tiene nada que mostrar');
  } finally { tab.movil = antes; }
});

test('cada pestaña lleva a una ruta que existe en vercel.json', async () => {
  const { readFileSync } = await import('node:fs');
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rutas = new Set((vercel.rewrites || []).map((r) => r.source));
  for (const t of NAV.QD_NAV_TABS) {
    assert.ok(rutas.has(t.href), `${t.href} no está en los rewrites: la pestaña llevaría a un 404`);
  }
});

test('la pestaña activa sale del prefijo MÁS LARGO, no del primero', () => {
  // Con "el primero que coincide", `/mercado/insiders` se marcaría como
  // Mercado —porque `/mercado` también es su prefijo— y se verían dos
  // pestañas encendidas a la vez.
  assert.equal(NAV.qdNavActivo('/mercado'), 'mercado');
  assert.equal(NAV.qdNavActivo('/mercado/noticias'), 'noticias');
  assert.equal(NAV.qdNavActivo('/mercado/insiders'), 'insiders');
});

test('la ficha de un índice es Mercado, no una pestaña suelta', () => {
  assert.equal(NAV.qdNavActivo('/mercado/indice/SPX'), 'mercado');
  assert.equal(NAV.qdNavActivo('/mercado/indice/IPC'), 'mercado');
});

test('las rutas que el encargo manda NO borrar también encienden su pestaña', () => {
  assert.equal(NAV.qdNavActivo('/liga'), 'liga');
  assert.equal(NAV.qdNavActivo('/liga/libros'), 'liga');
  assert.equal(NAV.qdNavActivo('/liga/equity'), 'liga');
  assert.equal(NAV.qdNavActivo('/leaderboard'), 'liga', 'la ruta vieja del leaderboard');
  assert.equal(NAV.qdNavActivo('/libros'), 'liga', 'la ruta vieja de libros');
  assert.equal(NAV.qdNavActivo('/app'), 'herramientas');
  assert.equal(NAV.qdNavActivo('/terminal'), 'herramientas', 'el alias de la terminal');
  assert.equal(NAV.qdNavActivo('/hoy'), 'mercado');
  assert.equal(NAV.qdNavActivo('/inicio'), 'herramientas', 'la calculadora');
  assert.equal(NAV.qdNavActivo('/calcula'), 'herramientas', 'su ruta nueva (PR 3)');
});

test('la query y el hash no cambian qué pestaña se enciende', () => {
  assert.equal(NAV.qdNavActivo('/mercado/noticias?seccion=acciones&idioma=es'), 'noticias');
  assert.equal(NAV.qdNavActivo('/mercado?mapa=us#x'), 'mercado');
  assert.equal(NAV.qdNavActivo('/liga/'), 'liga', 'la barra final tampoco');
});

test('una ruta desconocida no enciende ninguna, en vez de adivinar', () => {
  assert.equal(NAV.qdNavActivo('/nada-de-esto'), null);
  assert.equal(NAV.qdNavActivo(''), 'mercado', 'vacío cae en la portada');
});

test('el buscador manda a la ficha de /analiza, en mayúsculas', () => {
  assert.equal(NAV.qdNavDestino('nvda'), '/analiza/NVDA');
  assert.equal(NAV.qdNavDestino('  walmex.mx '), '/analiza/WALMEX.MX');
  assert.equal(NAV.qdNavDestino(''), null, 'sin símbolo no se navega a ningún lado');
  assert.equal(NAV.qdNavDestino(null), null);
});

test('el símbolo se escapa en la URL: un ticker no puede inyectar ruta', () => {
  assert.equal(NAV.qdNavDestino('a/b'), '/analiza/A%2FB');
});

test('el HTML del menú escapa lo que pinta', () => {
  assert.equal(NAV.qdNavEsc('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(NAV.qdNavEsc('a & b'), 'a &amp; b');
});

test('el HTML marca UNA sola pestaña como actual', () => {
  const html = NAV.qdNavHtml('noticias');
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /data-tab="noticias"[^>]*aria-current="page"/);
  // Y lleva el logo y el buscador con el texto que pidió el encargo.
  assert.match(html, /QUANT<b>DESK<\/b>/);
  assert.match(html, /placeholder="buscar empresa o ticker"/);
});

test('el CSS declara las piezas de las que dependen las doce páginas', () => {
  const css = NAV.QD_NAV_CSS;
  // FIJO: si vuelve a estar en el flujo, se convierte en item del grid de
  // `/mercado` y le corre la maqueta (pasó, y tapó el botón de compartir).
  assert.match(css, /position:fixed;top:0/);
  // El hueco lo pone el componente, no cada página.
  assert.match(css, /body\.qdnav-con-barra\{padding-top:var\(--qdnav-alto/);
  // Los tokens propios: el menú no lee la paleta de la página que lo hospeda.
  assert.match(css, /--qdnav-bg:#0b0f14/);
  assert.match(css, /--qdnav-es:#00c97d/);
  // `flex:0 0 auto` + `nowrap` en las pestañas: sin eso se encogen por debajo
  // de su texto y se enciman (ya pasó en este repo a 390 px).
  assert.match(css, /\.qdnav-tab\{flex:0 0 auto;white-space:nowrap/);
  // La barra de abajo no existe en escritorio.
  assert.match(css, /@media \(min-width:1000px\)\{[\s\S]*\.qdnav-abajo\{display:none\}/);
});

test('el reset declara lo que el menú usa, porque la página puede pintarlo', () => {
  const css = NAV.QD_NAV_CSS;
  // El agujero no eran los colores: el menú usa `<header>`, `<nav>`, `<a>`,
  // `<button>` e `<input>`, y las doce páginas tienen reglas POR ETIQUETA
  // para esos elementos. El `nav{padding:18px 0;position:sticky;top:0}` de
  // `/inicio` le metía 18+18 px de alto a las pestañas Y dejaba la barra de
  // abajo fijada arriba y abajo a la vez, de 851 px.
  const reset = css.match(/\.qdnav,\.qdnav \*,\.qdnav-abajo,\.qdnav-abajo \*\{[\s\S]*?\}/);
  assert.ok(reset, 'el reset defensivo tiene que existir');
  for (const prop of ['padding:0', 'margin:0', 'border:0', 'position:static',
    'top:auto', 'bottom:auto', 'backdrop-filter:none']) {
    assert.ok(reset[0].includes(prop), `el reset no declara ${prop}`);
  }
  // Y las dos barras declaran sus cuatro lados: un lado sin declarar es un
  // lado que la página puede poner.
  assert.match(css, /\.qdnav\{[\s\S]*?position:fixed;top:0;left:0;right:0;bottom:auto/);
  assert.match(css, /\.qdnav-abajo\{position:fixed;left:0;right:0;bottom:0;top:auto/);
});

test('en celular arriba NO hay pestañas, y la tira mide el tap', () => {
  const css = NAV.QD_NAV_CSS;
  // `QD_NAV_CSS` es el CSS ya unido, sin las comillas del arreglo: el bloque
  // cierra con una llave sola al principio de su línea.
  const movil = css.match(/@media \(max-width:999px\)\{[\s\S]*?\n\}/);
  assert.ok(movil, 'el bloque de celular tiene que existir');
  assert.match(movil[0], /\.qdnav-tabs\{display:none\}/);
  assert.match(movil[0], /min-height:calc\(var\(--qdnav-tap\)/);
  // La lupa es la única forma de buscar en el teléfono.
  assert.match(movil[0], /\.qdnav-lupa\{display:inline-flex\}/);
  // Y en escritorio no existe: *"en computadora déjalo como está"*.
  assert.match(css, /@media \(min-width:1000px\)\{[\s\S]*\.qdnav-lupa\{display:none\}/);
});

test('la tira se esconde con `transform`, no cambiando su alto', () => {
  // La razón no es la animación: el hueco que reserva
  // (`body{padding-top:--qdnav-alto}`) NO puede cambiar, porque si cambiara,
  // cada dedo que baja re-maquetaría la página — y en `/mercado` eso es
  // recalcular y redibujar el treemap de 554 cuadros.
  assert.match(NAV.QD_NAV_CSS, /\.qdnav\.qdnav-oculto\{transform:translateY\(-100%\)\}/);
  assert.doesNotMatch(NAV.QD_NAV_CSS, /\.qdnav\.qdnav-oculto\{[^}]*(height|display|top:)/);
  // En escritorio queda clavada incluso si la clase llegara por otro lado.
  assert.match(NAV.QD_NAV_CSS, /@media \(min-width:1000px\)\{[\s\S]*\.qdnav\{transform:none\}/);
});

test('el umbral del dedo acumula en vez de perderse', () => {
  const { readFileSync } = require('node:fs');
  const src = readFileSync(join(ROOT, 'qd-nav.js'), 'utf8');
  // Debajo del umbral NO se actualiza la última posición: así un arrastre
  // lento suma hasta cruzarlo. Si alguien mueve el `set` arriba del `return`,
  // la tira deja de esconderse con el dedo despacio.
  assert.match(src,
    /if \(Math\.abs\(d\) < QD_NAV_UMBRAL\) return;[^\n]*\n\s*if \(ultimos\) ultimos\.set/);
  // Arriba del todo la tira siempre se ve.
  assert.match(src, /if \(pos\.y <= QD_NAV_PISO\) return barra\.classList\.remove\('qdnav-oculto'\)/);
  // El scroll se escucha en captura: hay pantallas donde la ventana no se
  // mueve y lo que se recorre es un contenedor de adentro (`/mercado`).
  assert.match(src, /document\.addEventListener\('scroll', alScroll, \{ passive: true, capture: true \}\)/);
  assert.ok(NAV.QD_NAV_UMBRAL > 0 && NAV.QD_NAV_PISO >= NAV.QD_NAV_UMBRAL);
});

test('el menú no pide nada al cargar (regla 7) ni habla con un modelo (regla 6)', () => {
  const { readFileSync } = require('node:fs');
  const src = readFileSync(join(ROOT, 'qd-nav.js'), 'utf8');
  // El único `fetch` es el del buscador, y cuelga de un `input`.
  const fetches = src.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1, 'un solo fetch, el del buscador');
  assert.match(src, /addEventListener\('input'/, 'y sale sólo cuando alguien escribe');
  for (const prohibido of [/anthropic/i, /openai/i, /\/api\/(arena|liga)-/]) {
    assert.doesNotMatch(src, prohibido, `el menú no puede llamar a ${prohibido}`);
  }
});
