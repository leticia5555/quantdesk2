// ═══════════════════════════════════════════════════════════════════════
// scripts/menu-chromium.mjs — EL MENÚ COMPARTIDO, EN TODAS LAS PÁGINAS
//
// Lo que pidió el encargo R9 como prueba: *"Una comprobación de que no hay
// scroll horizontal"* y *"Una comprobación de que el menú aparece en todas"*.
//
// POR QUÉ UN ARNÉS APARTE Y NO UNA LÍNEA EN CADA UNO DE LOS CINCO. Porque la
// pregunta es sobre TODAS las páginas a la vez, y las que no tienen arnés
// —`/liga`, `/liga/libros`, `/liga/equity`, `/app`, `/inicio`, `/historia`—
// son justamente las que nadie estaba mirando. Un menú que aparece en cuatro
// de doce es el defecto que esta prueba existe para encontrar.
//
// LAS PÁGINAS SE SIRVEN SIN SUS APIs, a propósito: `/api/*` devuelve 500. El
// menú no depende de ningún dato, así que tiene que estar igual —y de paso
// queda fijado que una página sin datos sigue teniendo cómo salir de ahí—.
// ═══════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : join(ROOT, '.capturas'); })();
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
const PW = (() => {
  const candidatos = [
    process.env.PW_PATH, 'playwright-core',
    '/opt/node-tools/node_modules/playwright-core',
    join(ROOT, 'node_modules/playwright-core'),
  ].filter(Boolean);
  for (const c of candidatos) { try { return require.resolve(c); } catch { /* el siguiente */ } }
  throw new Error('no se encontró playwright-core; poné PW_PATH apuntando a su carpeta');
})();
const { chromium } = require(PW);
const NAV = require(join(ROOT, 'qd-nav.js'));

function chromePath() {
  for (const p of [process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome']) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

// Las rutas tal como las sirve `vercel.json`, y las que el encargo manda NO
// borrar. Si una deja de responder, esta lista lo dice por su nombre.
const RUTAS = [
  { url: '/mercado', archivo: 'mercado.html', tab: 'mercado' },
  { url: '/mercado/noticias', archivo: 'noticias.html', tab: 'noticias' },
  { url: '/mercado/insiders', archivo: 'insiders.html', tab: 'insiders' },
  { url: '/mercado/indice/SPX', archivo: 'indice.html', tab: 'mercado' },
  { url: '/analiza/NVDA', archivo: 'analiza.html', tab: 'mercado' },
  { url: '/liga', archivo: 'leaderboard.html', tab: 'liga' },
  { url: '/liga/libros', archivo: 'libros.html', tab: 'liga' },
  { url: '/liga/equity', archivo: 'equity.html', tab: 'liga' },
  { url: '/app', archivo: 'app.html', tab: 'herramientas' },
  // `/inicio` es la calculadora. NO es responsiva y nunca lo fue: a 390 px su
  // maqueta mide 422 y el navegador escala la ventana. Medido con el menú y
  // SIN el menú: idéntico, así que no lo trajo R9.
  // El encargo manda mudarla "sin cambiarle nada", así que acá se DECLARA en
  // vez de esconderse: se exige que su desborde sea exactamente el conocido.
  // Si crece, esto se pone rojo.
  { url: '/inicio', archivo: 'index.html', tab: 'herramientas', desbordePreexistente: true },
  { url: '/historia', archivo: 'historia.html', tab: 'herramientas' },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Sin datos: el menú no depende de ninguna API y tiene que estar igual.
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end('{"error":"sin API a propósito en esta corrida"}');
  }
  const ruta = RUTAS.find((r) => r.url === url.pathname);
  const p = ruta ? '/' + ruta.archivo : url.pathname;
  try {
    const buf = await readFile(join(ROOT, p.replace(/^\//, '')));
    res.writeHead(200, { 'content-type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('no'); }
});

const fallos = [];
const ok = [];
function chequeo(nombre, cond, detalle) {
  (cond ? ok : fallos).push(detalle ? `${nombre} — ${detalle}` : nombre);
  console.log(`${cond ? '  ✓' : '  ✗'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
}

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });

// El mismo detector de desborde que `noticias-chromium`: mide
// `body.scrollWidth` —que SÍ ve el desborde recortado por un
// `overflow:hidden`— y además recorre el DOM nombrando al culpable.
const detector = () => {
  const sel = (e) => {
    if (e.id) return '#' + e.id;
    const c = (e.className || '').toString().trim().split(/\s+/).filter(Boolean)[0];
    return e.tagName.toLowerCase() + (c ? '.' + c : '');
  };
  const recorredor = (e) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      // `hidden` también: lo que un padre recorta no puede desbordar la
      // página. En `/app` la cinta de precios se traslada a −1px y queda
      // recortada por su caja; en `/mercado` la hoja de detalle vive
      // estacionada fuera de la pantalla hasta que se abre. Ninguna de las
      // dos es un desborde, y `body.scrollWidth` sigue vigilando el de verdad.
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
    }
    return false;
  };
  const vp = window.innerWidth;
  const fuera = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (recorredor(e)) continue;
    if (r.left < -0.5 || r.right > vp + 0.5) fuera.push(sel(e) + `[${Math.round(r.left)}→${Math.round(r.right)}]`);
  }
  return {
    anchoCuerpo: document.body.scrollWidth,
    bodyDesborda: document.body.scrollWidth > document.body.clientWidth,
    htmlDesborda: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    fuera: fuera.slice(0, 6), cuantos: fuera.length,
  };
};

const estadoMenu = () => {
  const n = document.getElementById('qdnav');
  if (!n) return { hay: false };
  const tabs = [...n.querySelectorAll('.qdnav-tab')].map((a) => ({
    id: a.dataset.tab, texto: a.textContent.trim(), href: a.getAttribute('href'),
    activo: a.getAttribute('aria-current') === 'page',
    alto: Math.round(a.getBoundingClientRect().height),
    // Igual que en el componente: `offsetParent` es null para todo lo que
    // está dentro de un `position:fixed`, así que no distingue escondido de
    // fijo. Se mira el `display` computado y el de sus padres.
    visible: (() => { for (let e = a; e; e = e.parentElement) {
      if (getComputedStyle(e).display === 'none') return false; } return true; })(),
  }));
  const abajo = document.getElementById('qdnav-abajo');
  const abajoVisible = !!(abajo && getComputedStyle(abajo).display !== 'none');
  const items = abajo ? [...abajo.querySelectorAll('a')].map((a) => ({
    id: a.dataset.tab, alto: Math.round(a.getBoundingClientRect().height),
    activo: a.getAttribute('aria-current') === 'page',
  })) : [];
  const cs = getComputedStyle(n);
  return {
    hay: true,
    posicion: cs.position,
    marca: (n.querySelector('.qdnav-marca') || {}).textContent || '',
    tabs,
    activo: (tabs.find((t) => t.activo) || {}).id || null,
    buscadorVisible: (() => { const b = n.querySelector('.qdnav-busca');
      return !!(b && getComputedStyle(b).display !== 'none'); })(),
    abajoVisible,
    abajoItems: items,
    // El hueco: sin él, el menú fijo tapa lo primero de la página.
    padTop: Math.round(parseFloat(getComputedStyle(document.body).paddingTop) || 0),
    navAlto: Math.round(n.getBoundingClientRect().height),
  };
};

try {
  for (const ancho of [390, 1440]) {
    console.log(`\n══════ ${ancho} px ══════`);
    const ctx = await browser.newContext({
      viewport: { width: ancho, height: ancho === 390 ? 844 : 1000 },
      ...(ancho === 390 ? { hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : {}),
    });
    const page = await ctx.newPage();
    for (const r of RUTAS) {
      const resp = await page.goto(`${BASE}${r.url}`, { waitUntil: 'domcontentloaded' });
      chequeo(`${r.url} responde 200`, resp && resp.status() === 200, String(resp && resp.status()));
      // El menú se monta en `DOMContentLoaded`; se espera por el nodo.
      try { await page.waitForSelector('#qdnav', { timeout: 5000 }); } catch { /* lo dirá el chequeo */ }
      const m = await page.evaluate(estadoMenu);

      chequeo(`${r.url}: el menú está`, m.hay === true);
      if (!m.hay) continue;

      chequeo(`${r.url}: es el componente compartido, fijo y fuera del flujo`,
        m.posicion === 'fixed', m.posicion);
      chequeo(`${r.url}: el logo dice QUANTDESK`, /QUANTDESK/i.test(m.marca.replace(/\s/g, '')), m.marca);
      chequeo(`${r.url}: están las cinco pestañas`,
        m.tabs.length === 5 && NAV.QD_NAV_TABS.every((t) => m.tabs.some((x) => x.id === t.id)),
        JSON.stringify(m.tabs.map((t) => t.id)));
      // La pestaña encendida es la que le toca a ESA ruta, y es una sola.
      chequeo(`${r.url}: la pestaña activa es "${r.tab}", y sólo una`,
        m.activo === r.tab && m.tabs.filter((t) => t.activo).length === 1,
        `${m.activo} · ${m.tabs.filter((t) => t.activo).length}`);
      // El hueco del menú fijo: la página no puede empezar debajo de él.
      chequeo(`${r.url}: la página deja el hueco del menú`,
        m.padTop >= m.navAlto - 1, `padTop=${m.padTop} navAlto=${m.navAlto}`);

      if (ancho === 390) {
        chequeo(`${r.url}: en celular la barra de abajo está, con sus cuatro`,
          m.abajoVisible && m.abajoItems.length === 4,
          `${m.abajoVisible} · ${m.abajoItems.length}`);
        chequeo(`${r.url}: los cuatro miden 44 px o más (tap, regla 8)`,
          m.abajoItems.every((i) => i.alto >= 44), JSON.stringify(m.abajoItems.map((i) => i.alto)));
        chequeo(`${r.url}: el buscador NO ocupa ancho en celular`, !m.buscadorVisible);
        chequeo(`${r.url}: "Herramientas" sí está arriba en celular`,
          m.tabs.some((t) => t.id === 'herramientas' && t.visible),
          JSON.stringify(m.tabs.filter((t) => t.visible).map((t) => t.id)));
      } else {
        chequeo(`${r.url}: en escritorio el buscador está`, m.buscadorVisible);
        chequeo(`${r.url}: y la barra de abajo NO`, !m.abajoVisible);
        chequeo(`${r.url}: las cinco pestañas se ven en escritorio`,
          m.tabs.filter((t) => t.visible).length === 5,
          JSON.stringify(m.tabs.filter((t) => t.visible).map((t) => t.id)));
      }

      const d = await page.evaluate(detector);
      if (r.desbordePreexistente && ancho === 390) {
        // ── LA CICATRIZ DE LA CALCULADORA ──────────────────────────────
        // `/inicio` no es responsiva y nunca lo fue: a 390 px su maqueta es
        // más ancha que la ventana y el navegador la escala. Se midió con el
        // menú y SIN el menú (bloqueando `qd-nav.js` en la red): idéntico.
        // No lo trajo R9, y el encargo manda mudar la calculadora "sin
        // cambiarle nada".
        //
        // No se fija el número exacto porque depende del
        // `deviceScaleFactor` del contexto —408 acá, 422 en otro—, y un
        // número que cambia con el aparato mediría el aparato. Se fija lo
        // que importa: que NINGÚN elemento se salga por su cuenta y que el
        // desborde siga siendo el chico de siempre, no uno nuevo y grande.
        chequeo(`${r.url}: su desborde es el preexistente y no creció (cicatriz declarada)`,
          d.cuantos === 0 && d.anchoCuerpo - 390 <= 48,
          JSON.stringify({ sobra: d.anchoCuerpo - 390, ...d }));
      } else {
        chequeo(`${r.url}: sin scroll ni recorte horizontal a ${ancho} px`,
          !d.bodyDesborda && !d.htmlDesborda && d.cuantos === 0, JSON.stringify(d));
      }
    }
    await page.goto(`${BASE}/mercado`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#qdnav');
    await page.screenshot({ path: join(OUT, `menu-${ancho}.png`) });
    console.log(`  → ${join(OUT, `menu-${ancho}.png`)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
