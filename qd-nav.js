// ═══════════════════════════════════════════════════════════════════════
// qd-nav.js — EL MENÚ COMPARTIDO (R9, punto 1)
//
// UN SOLO COMPONENTE, no una copia por página. Eso no es prolijidad: acabamos
// de pasar dos días con un `&amp;` en pantalla porque había DOS `xval`
// idénticos y el arreglo se hizo en uno (2026-10-21). Un menú copiado en
// cinco archivos es el mismo cuento esperando a pasar.
//
// SE CARGA ASÍ, y nada más:   <script src="/qd-nav.js"></script>
//
// LO QUE HACE, de arriba abajo:
//   · En computadora: logo · las cinco pestañas · buscador a la derecha.
//   · En celular: arriba una TIRA DE 44 px con el logo y la lupa, sin
//     pestañas —porque las cuatro ya están abajo, y repetirlas era cobrar dos
//     veces el mismo ancho—; y esa tira SE ESCONDE al bajar con el dedo y
//     vuelve al subir. Abajo, una barra FIJA con cuatro íconos (Mercado,
//     Noticias, Liga, Insiders). La razón es el pulgar: las cuatro que se
//     usan todo el día van al alcance.
//
//     El cromo del teléfono pasó de 136 px a 110, y de 110 a 66 en cuanto se
//     baja un dedo. Lo pidió Lety con el teléfono en la mano (2026-10-22):
//     *"deja arriba solo una tira de ~44 px con logo y lupa"*.
//
// TRAE SU PROPIA PALETA, los tokens del §4 de `/mercado`, y los declara en
// variables PROPIAS (`--qdnav-*`) en vez de leer las de la página. A
// propósito: `/app` y `/liga` tienen sus propios `:root`, y si el menú
// heredara sus colores se vería distinto en cada pantalla —justo lo que el
// encargo prohíbe—. Y al no tocar los tokens de la página, el menú no puede
// repintarle nada a nadie.
//
// LO QUE NO HACE: no pide nada al cargar (regla 7 — una petición por pantalla
// para abrir, y ésta no gasta la de nadie). El buscador sólo sale a la red
// cuando alguien escribe. Y no hay una sola llamada de IA acá.
// ═══════════════════════════════════════════════════════════════════════

/* eslint-disable no-var */

// ── LAS PESTAÑAS ────────────────────────────────────────────────────────
// `movil` marca las cuatro de la barra de abajo. "Herramientas" no está:
// vive arriba, en las dos presentaciones.
var QD_NAV_TABS = [
  { id: 'mercado', texto: 'Mercado', href: '/mercado', movil: true,
    // Los íconos son SVG en línea: una dependencia menos y nada que falle en
    // 4G. `currentColor` para que el estado activo los pinte solos.
    icono: '<path d="M3 17l5-6 4 4 5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'noticias', texto: 'Noticias', href: '/mercado/noticias', movil: true,
    icono: '<rect x="3" y="4" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 8h8M6 11h8M6 14h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  { id: 'liga', texto: 'La Liga', href: '/liga', movil: true,
    icono: '<path d="M6 18V9M10 18V4M14 18v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  { id: 'insiders', texto: 'Insiders', href: '/mercado/insiders', movil: true,
    icono: '<circle cx="10" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 18c0-3.3 2.7-6 6-6s6 2.7 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  { id: 'herramientas', texto: 'Herramientas', href: '/app', movil: false,
    icono: '<path d="M4 7h12M4 11h12M4 15h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
];

/**
 * QUÉ PESTAÑA ESTÁ ACTIVA, para una ruta.
 *
 * Se resuelve por el prefijo MÁS LARGO que coincide, no por el primero: con
 * "el primero que coincide", `/mercado/insiders` se marcaría como Mercado
 * —porque `/mercado` también es prefijo suyo— y las dos pestañas se verían
 * encendidas a la vez.
 *
 * Las rutas que el encargo manda NO tocar también se resuelven: `/liga/libros`
 * y `/liga/equity` encienden La Liga, `/terminal` enciende Herramientas.
 */
function qdNavActivo(ruta) {
  var p = String(ruta || '/').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  // Alias: rutas viejas y hermanas que pertenecen a una pestaña aunque su
  // prefijo no lo diga. Ninguna página se borra (regla uno del encargo), así
  // que todas tienen que poder encender su pestaña.
  var alias = {
    '/': 'mercado', '/hoy': 'mercado', '/terminal': 'herramientas',
    '/leaderboard': 'liga', '/libros': 'liga', '/historia': 'herramientas',
    '/analiza': 'mercado', '/calcula': 'herramientas', '/inicio': 'herramientas',
  };
  if (alias[p]) return alias[p];
  for (var k in alias) {
    if (k !== '/' && p.indexOf(k + '/') === 0) return alias[k];
  }
  var mejor = null;
  for (var i = 0; i < QD_NAV_TABS.length; i++) {
    var t = QD_NAV_TABS[i];
    if (p === t.href || p.indexOf(t.href + '/') === 0) {
      if (!mejor || t.href.length > mejor.href.length) mejor = t;
    }
  }
  return mejor ? mejor.id : null;
}

/** A dónde manda el buscador. Un símbolo es una ficha de `/analiza`. */
function qdNavDestino(simbolo) {
  var s = String(simbolo || '').trim().toUpperCase();
  if (!s) return null;
  return '/analiza/' + encodeURIComponent(s);
}

// ── EL CSS, UNA VEZ ─────────────────────────────────────────────────────
// Va en un `<style>` que el componente inyecta, con todo bajo `.qdnav` para
// no poder pisarle nada a la página que lo hospeda.
var QD_NAV_CSS = [
  '.qdnav,.qdnav *{box-sizing:border-box}',
  /* ── RESET DEFENSIVO: LA PÁGINA SÍ PUEDE PINTAR EL MENÚ ────────────
     Este componente presume de traer su propia paleta para que ninguna
     página le cambie los colores. Pero los colores no eran el agujero: el
     menú usa `<header>`, `<nav>`, `<a>`, `<button>` e `<input>`, y las doce
     páginas tienen reglas POR ETIQUETA para esos mismos elementos. Con eso
     basta para deformarlo sin tocar un solo token.
     Y pasó: `.qdnav-tabs` es un `<nav>`, y el `nav{padding:8px 0}` de la
     página se le aplicaba. 8 arriba más 8 abajo sobre pestañas de 32 px: la
     tira de escritorio medía 58 px en vez de 40, en TODAS las pantallas, y
     en la ficha de índice esos 18 px salían del alto de la gráfica (medido:
     298 px con menú contra 356 sin él). El arnés lo veía como un `<nav>` de
     49 px con hijos de 32 y yo lo había estado leyendo como un hueco de
     barra de desplazamiento.
     Y NO ERA SÓLO EL `padding`. Esa misma regla de `/inicio` es
     `nav{position:sticky;top:0}`. `.qdnav-abajo` también es un `<nav>` y se
     apoya en `position:fixed` con `left/right/bottom` — pero nunca declaraba
     `top`. Con el `top:0` de la página puesto encima, la barra de cuatro
     íconos quedaba fijada ARRIBA Y ABAJO a la vez: 851 px de alto, la
     pantalla entera tapada en `/inicio`. Eso estaba así desde que escribí el
     componente y las 253 comprobaciones de la corrida anterior lo dejaron
     pasar, porque medían que los cuatro íconos fueran tocables y no cuánto
     medía la barra.
     Así que el menú declara TODO lo que usa, incluidos los cuatro lados y
     `position`. Lo que el componente sí pone a propósito —`fixed` en las dos
     barras, `relative` en el buscador, `absolute` en los resultados— se
     vuelve a declarar más abajo y gana por orden. */
  '.qdnav,.qdnav *,.qdnav-abajo,.qdnav-abajo *{',
  '  margin:0;padding:0;border:0;box-shadow:none;background:transparent;',
  '  font:inherit;letter-spacing:normal;text-transform:none;text-align:left;',
  '  text-indent:0;list-style:none;float:none;',
  '  position:static;top:auto;right:auto;bottom:auto;left:auto;z-index:auto;',
  '  transform:none;filter:none;backdrop-filter:none}',
  '.qdnav{',
  '  --qdnav-bg:#0b0f14; --qdnav-panel:#0e141b; --qdnav-linea:#161c24;',
  '  --qdnav-texto:#e6edf3; --qdnav-tenue:#8b98a5; --qdnav-apagado:#7d8793;',
  '  --qdnav-es:#00c97d; --qdnav-tap:44px;',
  '  --qdnav-sans:"IBM Plex Sans Condensed","IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  '  --qdnav-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
  /* ── FIJO, Y FUERA DEL FLUJO. NO ES NEGOCIABLE ─────────────────────
     Primero se insertó como primer hijo de `<body>`, y en `/mercado` el
     `body` ES un grid con filas declaradas: el menú se volvió un ITEM de ese
     grid, corrió todo una fila y terminó tapando el botón de compartir
     (Playwright: "el subtree de #qdnav intercepta los eventos de puntero").
     Es el mismo defecto que el aviso de fuentes caídas en `noticias.html`,
     que se insertó como hermano y estrenó una cuarta fila en una rejilla de
     tres.
     Con `position:fixed` el menú no participa de NINGÚN layout: ni grid, ni
     flex, ni flujo normal. Las doce páginas tienen maquetas distintas y
     ninguna tiene que saber que el menú existe — sólo dejarle el hueco, y
     ese hueco lo pone el propio componente con `padding-top`. */
  '  display:flex;align-items:center;gap:10px;',
  '  background:var(--qdnav-bg);color:var(--qdnav-texto);',
  '  border-bottom:1px solid var(--qdnav-linea);',
  '  padding:6px 16px;padding-top:calc(6px + env(safe-area-inset-top));',
  '  font-family:var(--qdnav-sans);',
  '  position:fixed;top:0;left:0;right:0;bottom:auto;z-index:50}',
  '.qdnav a{color:inherit;text-decoration:none}',
  '.qdnav-marca{font-family:var(--qdnav-mono);font-size:14px;letter-spacing:.5px;',
  '  white-space:nowrap;flex:0 0 auto;min-height:var(--qdnav-tap);display:flex;align-items:center}',
  '.qdnav-marca b{color:var(--qdnav-es);font-weight:600}',
  /* `flex:0 0 auto` + `nowrap`: sin eso, en un contenedor flex los botones se
     encogen por debajo del ancho de su texto y las pestañas se ENCIMAN. Ya
     pasó en este repo a 390 px ("MercadoMéxico · LATAM") y hay comentario de
     eso en noticias.html. */
  '.qdnav-tabs{display:flex;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}',
  '.qdnav-tabs::-webkit-scrollbar{display:none}',
  '.qdnav-tab{flex:0 0 auto;white-space:nowrap;min-height:var(--qdnav-tap);',
  '  display:inline-flex;align-items:center;padding:0 11px;border-radius:6px;',
  '  font-family:var(--qdnav-mono);font-size:13px;color:var(--qdnav-tenue);',
  '  border:1px solid transparent;-webkit-tap-highlight-color:transparent}',
  '.qdnav-tab:hover{color:var(--qdnav-texto)}',
  '.qdnav-tab[aria-current="page"]{background:#18212b;border-color:#2b3845;color:var(--qdnav-texto)}',
  '.qdnav-tab svg{display:none}',
  /* ── LA LUPA, SÓLO EN CELULAR ─────────────────────────────────────
     En la tira de 44 px no cabe un campo de texto que se pueda leer, así que
     el buscador se abre en una hoja a pantalla completa. En escritorio la
     lupa no existe: ahí el campo está siempre a la vista. */
  '.qdnav-lupa{display:none;flex:0 0 auto;width:var(--qdnav-tap);height:var(--qdnav-tap);',
  '  align-items:center;justify-content:center;background:transparent;border:0;',
  '  color:var(--qdnav-tenue);padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent}',
  '.qdnav-lupa svg{width:20px;height:20px;display:block}',
  '.qdnav-lupa[aria-expanded="true"]{color:var(--qdnav-texto)}',
  /* ── EL BUSCADOR ─────────────────────────────────────────────────── */
  '.qdnav-busca{flex:0 0 auto;position:relative;display:flex;align-items:center}',
  '.qdnav-busca input{width:208px;min-height:36px;background:#0b1118;',
  '  border:1px solid var(--qdnav-linea);border-radius:6px;color:var(--qdnav-texto);',
  '  font-family:var(--qdnav-mono);font-size:12px;padding:0 10px}',
  '.qdnav-busca input::placeholder{color:var(--qdnav-apagado)}',
  '.qdnav-res{position:absolute;top:calc(100% + 4px);right:0;min-width:280px;',
  '  background:var(--qdnav-panel);border:1px solid var(--qdnav-linea);border-radius:8px;',
  '  overflow:hidden;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,.5)}',
  '.qdnav-res[hidden]{display:none}',
  '.qdnav-res button{display:block;width:100%;text-align:left;background:transparent;',
  '  border:0;border-bottom:1px solid var(--qdnav-linea);color:var(--qdnav-texto);',
  '  font-family:var(--qdnav-sans);font-size:13px;padding:8px 10px;min-height:var(--qdnav-tap);cursor:pointer}',
  '.qdnav-res button:last-child{border-bottom:0}',
  '.qdnav-res button:hover,.qdnav-res button:focus{background:#18212b}',
  '.qdnav-res .sim{font-family:var(--qdnav-mono);color:var(--qdnav-es);margin-right:7px}',
  '.qdnav-res .ex{font-family:var(--qdnav-mono);font-size:10px;color:var(--qdnav-apagado);margin-left:6px}',
  /* El estado del buscador se DICE: "buscando…", "sin resultados", o la causa
     del fallo. Un desplegable vacío no distingue "no hay" de "se cayó". */
  '.qdnav-res .nota{font-family:var(--qdnav-mono);font-size:11px;color:var(--qdnav-tenue);padding:9px 10px}',
  /* EL PIE DE LA HOJA ESTÁ ESCONDIDO POR OMISIÓN, no sólo en escritorio.
     Lo tuve dentro del `@media (max-width:999px)` y en escritorio quedaba
     visible dentro del buscador: el menú creció de 40 px a 122 y se comió 80
     px de todas las pantallas anchas. Lo marcó el arnés en las once rutas a
     la vez. Una regla que esconde algo tiene que vivir en la base; el `@media`
     sólo lo vuelve a mostrar donde hace falta. */
  '.qdnav-hoja-pie{display:none}',
  /* ── CELULAR: UNA TIRA DE 44 px, Y SE ESCONDE ─────────────────────
     Arriba no va NINGUNA pestaña. Las cuatro de todos los días están en la
     barra de abajo, al alcance del pulgar, y "Herramientas" vive en el pie de
     la hoja del buscador (ver `qdNavHtmlHojaPie`): así nada deja de ser
     alcanzable y la tira se queda en 44 px, que es su único trabajo.

     EL ALTO ES EXACTAMENTE EL DEL TAP. No 44 "más o menos": la tira la ocupan
     el logo y la lupa, que son los dos elementos tocables, y los dos miden
     `--qdnav-tap`. Si mañana ese token cambia, la tira lo sigue. */
  '@media (max-width:999px){',
  '  .qdnav{gap:8px;padding:0 12px;padding-top:env(safe-area-inset-top);',
  '    min-height:calc(var(--qdnav-tap) + env(safe-area-inset-top));',
  /* La transición es sobre `transform`, no sobre `top` ni sobre el alto: ver
     el comentario largo de `qdnav-oculto`. */
  '    transition:transform .18s ease}',
  '  .qdnav-tabs{display:none}',
  '  .qdnav-marca{flex:1 1 auto;min-width:0}',
  '  .qdnav-lupa{display:inline-flex}',
  '  .qdnav-busca{display:none}',
  '  .qdnav-abajo{display:flex}',
  /* ── SE ESCONDE AL BAJAR, VUELVE AL SUBIR ───────────────────────
     Con `transform:translateY(-100%)`, no bajando el alto a cero ni
     quitándola del DOM. La razón no es la animación: el hueco que la tira
     reserva (`body{padding-top:--qdnav-alto}`) NO CAMBIA, porque el alto
     medido sigue siendo 44 px aunque esté corrida. Si el hueco cambiara, cada
     dedo que baja re-maquetaría la página entera, y en `/mercado` eso quiere
     decir RECALCULAR Y REDIBUJAR EL TREEMAP de 554 cuadros a 60 fps. Con
     `transform` el navegador sólo mueve una capa y nadie más se enteró. */
  '  .qdnav.qdnav-oculto{transform:translateY(-100%)}',
  /* ── LA HOJA DEL BUSCADOR, A PANTALLA COMPLETA ──────────────────
     `position:absolute` y no `fixed`: la hoja es hija de la tira, que es
     `position:fixed`, y un `transform` en un ancestro LO VUELVE el bloque
     contenedor de sus descendientes fijos. O sea que durante los 180 ms en
     que la tira vuelve de `translateY(-100%)`, una hoja `fixed` viajaría con
     ella. Con `absolute` + `top:100%` cuelga de la tira y siempre arranca
     justo abajo del borde, corrida o no.
     Se detiene arriba de la barra de abajo (`bottom` = su alto medido) para
     no taparla: con el buscador abierto se puede seguir saliendo de ahí. */
  '  .qdnav.qdnav-abierto{transform:none}',
  '  .qdnav.qdnav-abierto .qdnav-busca{display:block;position:absolute;',
  '    top:100%;left:0;right:0;',
  '    height:calc(100dvh - var(--qdnav-alto,44px) - var(--qdnav-abajo,0px));',
  '    background:var(--qdnav-bg);border-top:1px solid var(--qdnav-linea);',
  '    padding:10px 12px;overflow-y:auto;z-index:70}',
  /* 16 px no es estético: iOS Safari HACE ZOOM a la página entera en cuanto
     recibe el foco un campo de menos de 16 px, y de ese zoom no se vuelve. */
  '  .qdnav.qdnav-abierto .qdnav-busca input{width:100%;min-height:var(--qdnav-tap);font-size:16px}',
  '  .qdnav.qdnav-abierto .qdnav-res{position:static;min-width:0;margin-top:10px;box-shadow:none}',
  '  .qdnav.qdnav-abierto .qdnav-hoja-pie{display:block;margin-top:14px;',
  '    border-top:1px solid var(--qdnav-linea);padding-top:10px}',
  '  .qdnav-hoja-pie a{display:flex;align-items:center;gap:9px;min-height:var(--qdnav-tap);',
  '    font-family:var(--qdnav-mono);font-size:13px;color:var(--qdnav-tenue)}',
  '  .qdnav-hoja-pie svg{width:18px;height:18px}',
  '}',
  /* ── EN ESCRITORIO EL MENÚ ES COMPACTO ─────────────────────────────
     Los 44 px de alto mínimo son la regla del TAP: existen para el dedo. Con
     puntero fino no hacen falta, y 57 px de cromo en todas las pantallas se
     los come el contenido — en la ficha de índice salieron directo del alto
     de la gráfica, que es lo que la pantalla viene a mostrar.
     En celular se quedan los 44 px intactos. */
  '@media (min-width:1000px){',
  '  .qdnav-abajo{display:none}',
  /* En escritorio la lupa no existe y la tira NUNCA se esconde: Lety lo pidió
     así —*"en computadora déjalo como está"*— y con puntero fino no hay
     pulgar que recuperar. `transform:none` lo deja clavado incluso si la
     clase llegara por otro lado. */
  '  .qdnav-lupa{display:none}',
  '  .qdnav{transform:none}',
  '  .qdnav{padding-top:4px;padding-bottom:4px}',
  '  .qdnav-marca{min-height:32px}',
  '  .qdnav-tab{min-height:32px}',
  '  .qdnav-busca input{min-height:32px}',
  '}',
  /* `top:auto` NO es decorativo: ver el reset de arriba. Sin él, el
     `nav{position:sticky;top:0}` de `/inicio` dejaba esta barra fijada arriba
     Y abajo, de 851 px, tapando la pantalla entera. */
  '.qdnav-abajo{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:60;',
  '  background:var(--qdnav-bg,#0b0f14);border-top:1px solid #161c24;',
  '  padding-bottom:env(safe-area-inset-bottom)}',
  '.qdnav-abajo a{flex:1 1 0;min-width:0;min-height:56px;display:flex;flex-direction:column;',
  '  align-items:center;justify-content:center;gap:2px;color:#8b98a5;text-decoration:none;',
  '  font-family:var(--qdnav-mono,ui-monospace);font-size:10px;-webkit-tap-highlight-color:transparent}',
  '.qdnav-abajo a[aria-current="page"]{color:#00c97d}',
  '.qdnav-abajo svg{width:20px;height:20px;display:block}',
  /* El hueco que deja la barra fija. Sin esto, la última fila de cada lista
     queda tapada por la barra y se lee como que la página está cortada. */
  /* EL HUECO LO PONE EL COMPONENTE. `box-sizing:border-box` —que las doce
     páginas ya declaran— hace que un `body{height:100dvh}` con este
     `padding-top` deje su caja de contenido en 100dvh menos el menú, sin que
     la página tenga que restar nada. */
  'body.qdnav-con-barra{padding-top:var(--qdnav-alto,0px)}',
  '@media (max-width:999px){ body.qdnav-con-barra{padding-bottom:var(--qdnav-abajo,0px)} }',
].join('\n');

function qdNavSvg(icono) {
  return '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">' + icono + '</svg>';
}

function qdNavHtml(activo) {
  var tabs = QD_NAV_TABS.map(function (t) {
    return '<a class="qdnav-tab" href="' + t.href + '" data-tab="' + t.id + '"'
      + ' data-movil="' + (t.movil ? 'si' : 'no') + '"'
      + (t.id === activo ? ' aria-current="page"' : '') + '>'
      + qdNavSvg(t.icono) + '<span>' + t.texto + '</span></a>';
  }).join('');
  return '<a class="qdnav-marca" href="/" aria-label="QuantDesk, ir a la portada">'
    + 'QUANT<b>DESK</b></a>'
    + '<nav class="qdnav-tabs" aria-label="Secciones de QuantDesk">' + tabs + '</nav>'
    + '<button type="button" class="qdnav-lupa" id="qdnav-lupa" aria-expanded="false"'
    + ' aria-controls="qdnav-busca" aria-label="Buscar empresa o ticker">'
    + qdNavSvg('<circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>'
      + '<path d="M13 13l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')
    + '</button>'
    + '<div class="qdnav-busca" id="qdnav-busca">'
    + '<input type="search" id="qdnav-q" autocomplete="off" spellcheck="false"'
    + ' placeholder="buscar empresa o ticker" aria-label="Buscar empresa o ticker">'
    + '<div class="qdnav-res" id="qdnav-res" role="listbox" hidden></div>'
    + qdNavHtmlHojaPie()
    + '</div>';
}

/**
 * EL PIE DE LA HOJA DEL BUSCADOR: las pestañas que NO están en la barra de
 * abajo.
 *
 * Hoy es una sola, "Herramientas". Está acá porque la tira de celular se
 * quedó sin pestañas y la barra de abajo lleva cuatro: sin este pie,
 * "Herramientas" —y con ella `/app`, `/terminal` y `/historia`— dejaría de
 * tener cómo abrirse desde el teléfono, y la regla uno del encargo es *"no
 * borres ninguna página ni función"*.
 *
 * Sale de `QD_NAV_TABS` filtrando por `movil`, no de una lista aparte: el día
 * que una pestaña entre o salga de la barra de abajo, este pie se acomoda
 * solo. En escritorio no se dibuja (`display:none`), porque allá la pestaña
 * está arriba.
 */
function qdNavHtmlHojaPie() {
  var fuera = QD_NAV_TABS.filter(function (t) { return !t.movil; });
  if (!fuera.length) return '';
  return '<div class="qdnav-hoja-pie">' + fuera.map(function (t) {
    return '<a href="' + t.href + '" data-tab="' + t.id + '">'
      + qdNavSvg(t.icono) + '<span>' + t.texto + '</span></a>';
  }).join('') + '</div>';
}

function qdNavHtmlAbajo(activo) {
  var items = QD_NAV_TABS.filter(function (t) { return t.movil; }).map(function (t) {
    return '<a href="' + t.href + '" data-tab="' + t.id + '"'
      + (t.id === activo ? ' aria-current="page"' : '') + '>'
      + qdNavSvg(t.icono) + '<span>' + t.texto + '</span></a>';
  }).join('');
  return items;
}

// ── EL BUSCADOR ─────────────────────────────────────────────────────────
// Usa `/api/ticker-search?q=`, que ya existe y ya cubre cualquier bolsa
// (.MX de la BMV, .SA de B3). No se agrega endpoint y no hay IA: es la
// búsqueda de símbolos de Yahoo.
function qdNavAtaBuscador(raiz) {
  var input = raiz.querySelector('#qdnav-q');
  var caja = raiz.querySelector('#qdnav-res');
  if (!input || !caja) return;
  var pedido = 0;
  var timer = null;

  function cierra() { caja.hidden = true; caja.innerHTML = ''; }
  function nota(texto) { caja.hidden = false; caja.innerHTML = '<div class="nota">' + qdNavEsc(texto) + '</div>'; }

  function pinta(resultados) {
    if (!resultados.length) return nota('sin resultados');
    caja.hidden = false;
    caja.innerHTML = resultados.slice(0, 8).map(function (r) {
      return '<button type="button" data-sim="' + qdNavEsc(r.symbol) + '">'
        + '<span class="sim">' + qdNavEsc(r.symbol) + '</span>'
        + qdNavEsc(r.name || '')
        + (r.exchange ? '<span class="ex">' + qdNavEsc(r.exchange) + '</span>' : '')
        + '</button>';
    }).join('');
  }

  function busca(q) {
    var mio = ++pedido;
    nota('buscando…');
    fetch('/api/ticker-search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // Una respuesta vieja que llega tarde NO puede pisar a la nueva: con
        // el teclado rápido, las respuestas vuelven desordenadas.
        if (mio !== pedido) return;
        pinta((j && j.results) || []);
      })
      .catch(function (e) {
        if (mio !== pedido) return;
        // La causa, no un desplegable vacío (regla 2).
        nota('no se pudo buscar: ' + String((e && e.message) || e));
      });
  }

  input.addEventListener('input', function () {
    var q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) return cierra();
    timer = setTimeout(function () { busca(q); }, 220);
  });
  input.addEventListener('keydown', function (e) {
    // Escape cierra las dos cosas: los resultados y, en celular, la hoja.
    if (e.key === 'Escape') { cierra(); return qdNavCierraHoja(raiz); }
    if (e.key !== 'Enter') return;
    var primero = caja.querySelector('button[data-sim]');
    var sim = primero ? primero.dataset.sim : input.value.trim();
    var destino = qdNavDestino(sim);
    if (destino) location.href = destino;
  });
  caja.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-sim]') : null;
    if (!b) return;
    var destino = qdNavDestino(b.dataset.sim);
    if (destino) location.href = destino;
  });
  document.addEventListener('click', function (e) {
    if (!raiz.contains(e.target)) cierra();
  });
}

// ── LA LUPA Y LA HOJA ───────────────────────────────────────────────────
// Un solo campo de texto y un solo manejador para las dos presentaciones: en
// escritorio vive inline en la tira, en celular el CSS lo vuelve una hoja a
// pantalla completa. Dos campos con la misma lógica es exactamente el defecto
// que este componente existe para no repetir.

/** Cierra la hoja del buscador, si está abierta. Idempotente. */
function qdNavCierraHoja(raiz) {
  if (!raiz || !raiz.classList.contains('qdnav-abierto')) return;
  raiz.classList.remove('qdnav-abierto');
  var lupa = raiz.querySelector('#qdnav-lupa');
  if (lupa) lupa.setAttribute('aria-expanded', 'false');
}

function qdNavAtaLupa(raiz) {
  var lupa = raiz.querySelector('#qdnav-lupa');
  var input = raiz.querySelector('#qdnav-q');
  var caja = raiz.querySelector('#qdnav-res');
  if (!lupa) return;
  lupa.addEventListener('click', function () {
    var abierto = !raiz.classList.contains('qdnav-abierto');
    if (!abierto) {
      qdNavCierraHoja(raiz);
      if (input) input.value = '';
      if (caja) { caja.hidden = true; caja.innerHTML = ''; }
      return;
    }
    raiz.classList.add('qdnav-abierto');
    // Con la hoja abierta la tira TIENE que estar a la vista: es su borde
    // superior el que sostiene la hoja (`top:100%`).
    raiz.classList.remove('qdnav-oculto');
    lupa.setAttribute('aria-expanded', 'true');
    if (input) input.focus();
  });
}

/**
 * LA TIRA SE ESCONDE AL BAJAR CON EL DEDO Y VUELVE AL SUBIR.
 *
 * Sólo en celular. En escritorio la clase se quita siempre, y el CSS de
 * `min-width:1000px` además clava `transform:none`: dos candados, porque este
 * es el único comportamiento de R9 que Lety pidió explícitamente NO llevar a
 * la computadora.
 *
 * TRES DECISIONES QUE NO SON OBVIAS:
 *
 * 1. EL SCROLL NO SIEMPRE ES EL DE LA VENTANA. `/mercado` mide una pantalla
 *    exacta (`.pantalla{height:calc(100dvh - …)}` con `overflow:hidden`) y
 *    ahí la ventana NO se mueve nunca: lo que se recorre es un contenedor de
 *    adentro. Con un `window.addEventListener('scroll')` a secas, la tira no
 *    se escondería en la mitad de las pantallas. Así que se escucha en
 *    `document` EN FASE DE CAPTURA —el evento `scroll` no burbujea, pero la
 *    captura sí lo ve— y la posición se lee del elemento que lo disparó.
 *
 * 2. CADA CONTENEDOR LLEVA SU PROPIA CUENTA, en un `WeakMap`. Con una sola
 *    variable, el primer evento de un segundo contenedor compara su
 *    `scrollTop` contra el del primero y da un salto enorme hacia un lado
 *    cualquiera: la tira se escondería al tocar una tabla que se recorre
 *    sola.
 *
 * 3. UN UMBRAL QUE ACUMULA. Debajo de `UMBRAL` no se hace nada Y NO SE
 *    ACTUALIZA la última posición: así un arrastre lento suma hasta cruzarlo,
 *    en vez de perderse píxel a píxel y no esconder nunca. Y arriba de todo
 *    (`y <= PISO`) la tira siempre se ve, porque esconder el encabezado de una
 *    página que no se ha movido es sólo quitarle el logo a nadie.
 */
var QD_NAV_UMBRAL = 6;   // px: menos que esto es el temblor del dedo
var QD_NAV_PISO = 56;    // px: arriba de acá la tira no se esconde

function qdNavAtaScroll(barra) {
  var ultimos = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var tic = false;
  var pendiente = null;

  function donde(blanco) {
    if (!blanco || blanco === document || blanco === window
      || blanco === document.documentElement || blanco === document.body) {
      return { clave: document.documentElement,
        y: window.scrollY || document.documentElement.scrollTop || 0 };
    }
    return { clave: blanco, y: blanco.scrollTop || 0 };
  }

  function evalua() {
    tic = false;
    var blanco = pendiente;
    pendiente = null;
    // En escritorio nunca. Se quita la clase por si quedó de un celular que
    // rotó o de una ventana que creció.
    if (window.matchMedia && window.matchMedia('(min-width:1000px)').matches) {
      barra.classList.remove('qdnav-oculto');
      return;
    }
    // Con la hoja del buscador abierta, la tira se queda: es su sostén.
    if (barra.classList.contains('qdnav-abierto')) {
      barra.classList.remove('qdnav-oculto');
      return;
    }
    var pos = donde(blanco);
    var antes = ultimos ? ultimos.get(pos.clave) : undefined;
    if (typeof antes !== 'number') {
      if (ultimos) ultimos.set(pos.clave, pos.y);
      return;
    }
    var d = pos.y - antes;
    if (Math.abs(d) < QD_NAV_UMBRAL) return;   // sin actualizar: acumula
    if (ultimos) ultimos.set(pos.clave, pos.y);
    if (pos.y <= QD_NAV_PISO) return barra.classList.remove('qdnav-oculto');
    if (d > 0) barra.classList.add('qdnav-oculto');
    else barra.classList.remove('qdnav-oculto');
  }

  function alScroll(e) {
    pendiente = e && e.target;
    if (tic) return;
    tic = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(evalua);
    else setTimeout(evalua, 16);
  }

  // `capture:true` para ver el scroll de los contenedores de adentro (nota 1).
  // `passive:true` porque no se previene nada y así el navegador no espera a
  // este manejador para seguir desplazando.
  document.addEventListener('scroll', alScroll, { passive: true, capture: true });
  // ── SE SIEMBRA LA POSICIÓN DE LA VENTANA ACÁ MISMO ────────────────
  // Sin esto, el PRIMER evento de scroll no hace nada: no hay contra qué
  // comparar, así que sólo anota y se va. Con un dedo real eso no se nota
  // —llegan docenas de eventos—, pero cuando el desplazamiento llega de una
  // sola vez (una rueda, un `scrollIntoView`, el ancla de un `#id`) ese único
  // evento era el que había, y la tira no se escondía nunca. Lo encontró el
  // arnés: 141 px de recorrido y la tira quietita.
  if (ultimos) ultimos.set(document.documentElement,
    window.scrollY || document.documentElement.scrollTop || 0);
  // Al rotar o cambiar de tamaño, la tira vuelve: el `@media` pudo haber
  // cambiado de lado y una tira escondida en escritorio no se recuperaría.
  window.addEventListener('resize', function () { barra.classList.remove('qdnav-oculto'); });
  window.addEventListener('orientationchange', function () { barra.classList.remove('qdnav-oculto'); });
}

function qdNavEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * Monta el menú. Idempotente: si ya está, no se duplica.
 *
 * Se inserta como PRIMER hijo de `<body>`. Las páginas que miden "una
 * pantalla" (`height:100dvh` con `main{flex:1}`) se adaptan solas, que es
 * justo para lo que ese patrón existe: el alto no se calcula, main se queda
 * con lo que sobra.
 */
function qdNavMonta() {
  if (typeof document === 'undefined') return null;
  if (document.getElementById('qdnav')) return document.getElementById('qdnav');

  if (!document.getElementById('qdnav-css')) {
    var st = document.createElement('style');
    st.id = 'qdnav-css';
    st.textContent = QD_NAV_CSS;
    document.head.appendChild(st);
  }

  var activo = qdNavActivo(location.pathname);

  var barra = document.createElement('header');
  barra.className = 'qdnav';
  barra.id = 'qdnav';
  barra.innerHTML = qdNavHtml(activo);
  document.body.insertBefore(barra, document.body.firstChild);

  var abajo = document.createElement('nav');
  abajo.className = 'qdnav-abajo';
  abajo.id = 'qdnav-abajo';
  abajo.setAttribute('aria-label', 'Secciones, barra inferior');
  abajo.innerHTML = qdNavHtmlAbajo(activo);
  document.body.appendChild(abajo);
  document.body.classList.add('qdnav-con-barra');

  qdNavAtaBuscador(barra);
  qdNavAtaLupa(barra);
  qdNavAtaScroll(barra);
  qdNavPublicaAlto();
  return barra;
}

/**
 * PUBLICA SU PROPIO ALTO, MEDIDO, EN `--qdnav-alto` y `--qdnav-abajo`.
 *
 * Las páginas que miden "una pantalla exacta" tienen el alto CLAVADO
 * (`.pantalla{height:100dvh}` en `/mercado`), así que el menú las empuja
 * fuera de la ventana: a 390 px el botón de volver al mapa completo quedó
 * debajo del borde y el arnés se cayó al intentar tocarlo.
 *
 * Restar un número adivinado —"44 px"— es justo lo que este repo decidió no
 * hacer: el alto del menú cambia con la tipografía, con el `safe-area` del
 * iPhone y con el ancho. Así que se MIDE y se publica, y cada página resta la
 * variable. Es el mismo razonamiento que el comentario de `noticias.html`:
 * un alto medido nunca queda viejo.
 *
 * Se recalcula al cambiar de tamaño y al rotar, porque la barra de abajo
 * existe sólo en celular y su alto entra y sale.
 */
function qdNavPublicaAlto() {
  var raiz = document.documentElement;
  var barra = document.getElementById('qdnav');
  var abajo = document.getElementById('qdnav-abajo');
  function mide() {
    // HACIA ARRIBA, no al más cercano, y no en crudo. El treemap se dibuja
    // con píxeles MEDIDOS: con un alto fraccionario su última hilera se
    // pasaba un píxel de la caja (el arnés lo marcó con `sobra:-1`), y con
    // `Math.round` el error podía caer para cualquier lado.
    // `ceil` deja la caja entera y hace que el menú se quede, como máximo,
    // un píxel de más: la página puede perder un píxel, el mapa no puede
    // desbordarse.
    var h = barra ? Math.ceil(barra.getBoundingClientRect().height) : 0;
    // ── `offsetParent` NO SIRVE PARA UN `position:fixed` ──────────────
    // Devuelve `null` SIEMPRE para un elemento fijo, no sólo cuando está
    // escondido. Así que esto daba "escondida" en celular también, el alto
    // publicado quedaba en 0 y el hueco de abajo nunca se aplicaba: la barra
    // tapaba la última fila de cada lista. Lo encontró el arnés del menú.
    // `display` computado sí distingue: es lo que el `@media` cambia.
    var visibleAbajo = abajo && getComputedStyle(abajo).display !== 'none';
    var a = visibleAbajo ? Math.ceil(abajo.getBoundingClientRect().height) : 0;
    raiz.style.setProperty('--qdnav-alto', h + 'px');
    raiz.style.setProperty('--qdnav-abajo', a + 'px');
  }
  mide();
  if (typeof ResizeObserver !== 'undefined' && barra) {
    try { new ResizeObserver(mide).observe(barra); } catch (e) { /* sin observer, el resize alcanza */ }
  }
  window.addEventListener('resize', mide);
  window.addEventListener('orientationchange', mide);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', qdNavMonta);
  } else {
    qdNavMonta();
  }
}

// El puente a Node para las pruebas, al final, cuando todo existe ya.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QD_NAV_TABS, qdNavActivo, qdNavDestino, qdNavHtml, qdNavHtmlAbajo,
    qdNavHtmlHojaPie, QD_NAV_CSS, qdNavEsc, QD_NAV_UMBRAL, QD_NAV_PISO,
  };
}
