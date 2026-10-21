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
//   · En celular: arriba el logo y "Herramientas"; abajo una barra FIJA con
//     cuatro íconos (Mercado, Noticias, Liga, Insiders). Es lo que pidió el
//     encargo, y la razón es el pulgar: las cuatro que se usan todo el día
//     van al alcance, y la que se usa de vez en cuando va arriba.
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
  '  position:fixed;top:0;left:0;right:0;z-index:50}',
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
  /* ── CELULAR ──────────────────────────────────────────────────────── */
  '@media (max-width:999px){',
  '  .qdnav{gap:8px;padding:4px 12px;padding-top:calc(4px + env(safe-area-inset-top))}',
  '  .qdnav-busca{display:none}',
  /* Arriba, en el celular, sólo Herramientas: las otras cuatro están abajo,
     y repetirlas sería gastar el ancho en lo que ya está al alcance. */
  '  .qdnav-tabs{justify-content:flex-end}',
  '  .qdnav-tabs .qdnav-tab:not([data-movil="no"]){display:none}',
  '  .qdnav-abajo{display:flex}',
  '}',
  /* ── EN ESCRITORIO EL MENÚ ES COMPACTO ─────────────────────────────
     Los 44 px de alto mínimo son la regla del TAP: existen para el dedo. Con
     puntero fino no hacen falta, y 57 px de cromo en todas las pantallas se
     los come el contenido — en la ficha de índice salieron directo del alto
     de la gráfica, que es lo que la pantalla viene a mostrar.
     En celular se quedan los 44 px intactos. */
  '@media (min-width:1000px){',
  '  .qdnav-abajo{display:none}',
  '  .qdnav{padding-top:4px;padding-bottom:4px}',
  '  .qdnav-marca{min-height:32px}',
  '  .qdnav-tab{min-height:32px}',
  '  .qdnav-busca input{min-height:32px}',
  '}',
  '.qdnav-abajo{position:fixed;left:0;right:0;bottom:0;z-index:60;',
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
    + '<div class="qdnav-busca">'
    + '<input type="search" id="qdnav-q" autocomplete="off" spellcheck="false"'
    + ' placeholder="buscar empresa o ticker" aria-label="Buscar empresa o ticker">'
    + '<div class="qdnav-res" id="qdnav-res" role="listbox" hidden></div>'
    + '</div>';
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
    if (e.key === 'Escape') return cierra();
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
  module.exports = { QD_NAV_TABS, qdNavActivo, qdNavDestino, qdNavHtml, qdNavHtmlAbajo, QD_NAV_CSS, qdNavEsc };
}
