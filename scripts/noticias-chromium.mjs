// ═══════════════════════════════════════════════════════════════════
// scripts/noticias-chromium.mjs — /mercado/noticias en un Chromium de verdad.
//
// El cierre que el encargo pide para R3b (regla 10): 390 px con TAP REAL
// —`hasTouch + isMobile`, `tap()`, no un click sintético— y escritorio
// 1440×1000 SIN SCROLL, con captura de las dos.
//
//   node scripts/noticias-chromium.mjs [--out DIR]
//
// EL FIXTURE ESTÁ ARMADO PARA QUE DUELA, no para que salga bonito:
//   · dos notas con foto y el resto sin ella → se ve que las destacadas se
//     completan sin inventar imagen y que el bloque de color dice la fuente;
//   · una foto con URL que NO EXISTE → se ve la caída del hotlink al bloque,
//     que es lo único que esta comprobación puede ver y una prueba unitaria no;
//   · una fuente CAÍDA con su motivo → el chip punteado y el aviso;
//   · una fuente SIN COSECHAR → el tercer estado, que no es ninguno de los dos;
//   · un titular con el "menor que" en prosa y otro con un invisible → el
//     arreglo del espacio perdido, visto en pantalla y no en un string.
//
// Sale 0 si todo pasa, 1 si algo falla.
// ═══════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : join(ROOT, '.capturas'); })();
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
const PW = process.env.PW_PATH || '/tmp/claude-0/-home-user-quantdesk2/978a1f3c-866a-59be-9b12-d16e6c760a3e/scratchpad/node_modules/playwright-core';
const { chromium } = require(PW);
// El MISMO armador que el endpoint (una sola definición de qué es la página).
const { armaPagina, chipsDeFuente, seccionesSinFuente } = await import(join(ROOT, 'api/_lib/noticias-pagina.js'));

const MOMENTO = Date.parse('2026-10-20T16:30:00Z');   // 11:30 CT, lunes: NYSE y BMV abiertos
const hace = (min) => new Date(MOMENTO - min * 60000).toISOString();

// Una imagen de 1×1 que SÍ existe, servida por el fixture: sin ella, "la foto
// se pintó" no se podría distinguir de "la foto falló y cayó al bloque".
// Gris oscuro y no blanco: en la captura, un 1×1 blanco estirado a 16/9 se
// ve como un hueco vacío y no como una foto, y la captura es donde se revisan
// estas pantallas.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAACYwOwAAACwAAAAAAQABAAACAkQBADs=', 'base64');

const NOTAS = [
  // VALOR BR: cuatro notas, TODAS con imagen. Es el caso que se vio en
  // producción (Lety, 2026-10-20): con `conFoto.slice(0,4)` las cuatro
  // destacadas salían de este solo medio. Están primero a propósito, que es
  // lo que las hacía ganar. Una de sus fotos CUELGA —el servidor no contesta
  // ni error— que es la otra mitad del defecto: los cuadros grises.
  // La MÁS NUEVA de Valor BR es la que tarda: es la que gana el lugar de
  // destacada, así que es la que tiene que caer al bloque por plazo.
  { url: 'https://valor.test/ibov', titular: 'Ibovespa fecha em alta de 1,2%',
    fuente_id: 'valor_br', fuente_nombre: 'Valor BR', tipo: 'medio', idioma: 'pt', seccion: 'mexico_latam',
    publicado_en: hace(3), imagen: '/foto-lenta.gif', imagen_via: 'media:content', tickers: [], fuente_dato: null },
  { url: 'https://valor.test/petro', titular: 'Petrobras anuncia dividendo extraordinário',
    fuente_id: 'valor_br', fuente_nombre: 'Valor BR', tipo: 'medio', idioma: 'pt', seccion: 'mexico_latam',
    publicado_en: hace(5), imagen: '/foto-ok.gif', imagen_via: 'media:content', tickers: [], fuente_dato: null },
  { url: 'https://valor.test/real', titular: 'Real se valoriza frente ao dólar',
    fuente_id: 'valor_br', fuente_nombre: 'Valor BR', tipo: 'medio', idioma: 'pt', seccion: 'mexico_latam',
    publicado_en: hace(7), imagen: '/foto-ok.gif', imagen_via: 'media:content', tickers: [], fuente_dato: null },
  { url: 'https://valor.test/vale', titular: 'Vale eleva projeção de produção',
    fuente_id: 'valor_br', fuente_nombre: 'Valor BR', tipo: 'medio', idioma: 'pt', seccion: 'mexico_latam',
    publicado_en: hace(9), imagen: '/foto-ok.gif', imagen_via: 'media:content', tickers: [], fuente_dato: null },
  { url: 'https://medio.test/nvidia', titular: 'Nvidia hits $1.4T valuation on AI demand',
    fuente_id: 'cnbc', fuente_nombre: 'CNBC', tipo: 'medio', idioma: 'en', seccion: 'acciones',
    publicado_en: hace(12), imagen: '/foto-ok.gif', imagen_via: 'media:content',
    tickers: ['NVDA'], fuente_dato: null },
  { url: 'https://medio.test/amd', titular: 'AMD <$100 es compra > 2027, dice la casa',
    fuente_id: 'marketwatch', fuente_nombre: 'MarketWatch', tipo: 'medio', idioma: 'en', seccion: 'mercado',
    publicado_en: hace(30), imagen: '/foto-rota.gif', imagen_via: 'enclosure',
    tickers: ['AMD'], fuente_dato: null },
  { url: 'https://medio.test/walmex', titular: 'Walmex sube 2% tras el reporte trimestral',
    fuente_id: 'el_financiero', fuente_nombre: 'El Financiero', tipo: 'medio', idioma: 'es', seccion: 'mexico_latam',
    publicado_en: hace(55), imagen: null, imagen_via: null, tickers: ['WALMEX'], fuente_dato: null },
  { url: 'https://medio.test/peso', titular: 'El peso cierra en 18.42 por dólar',
    fuente_id: 'el_financiero', fuente_nombre: 'El Financiero', tipo: 'medio', idioma: 'es', seccion: 'mexico_latam',
    publicado_en: hace(90), imagen: null, imagen_via: null, tickers: [], fuente_dato: null },
  { url: 'https://medio.test/fed', titular: 'La Fed no mueve la tasa y el mercado respira',
    fuente_id: 'marketwatch', fuente_nombre: 'MarketWatch', tipo: 'medio', idioma: 'en', seccion: 'mercado',
    publicado_en: hace(110), imagen: null, imagen_via: null, tickers: [], fuente_dato: null },
  { url: 'https://medio.test/apertura', titular: 'Wall Street abre mixto a la espera de la Fed',
    fuente_id: 'marketwatch', fuente_nombre: 'MarketWatch', tipo: 'medio', idioma: 'en', seccion: 'mercado',
    publicado_en: hace(120), imagen: null, imagen_via: null, tickers: [], fuente_dato: null },
  { url: 'https://news.test/klement', titular: 'Why factor investing keeps disappointing',
    fuente_id: 'klement', fuente_nombre: 'Klement on Investing', tipo: 'newsletter', idioma: 'en', seccion: 'mercado',
    publicado_en: hace(200), imagen: null, imagen_via: null, tickers: [], fuente_dato: null },
  { url: 'https://news.test/doomberg', titular: 'The uranium squeeze, revisited',
    fuente_id: 'doomberg', fuente_nombre: 'Doomberg', tipo: 'newsletter', idioma: 'en', seccion: 'mercado',
    publicado_en: hace(300), imagen: null, imagen_via: null, tickers: [], fuente_dato: null },
  { url: 'https://banxico.org.mx/anuncios#2026-10-20', titular: 'Banxico baja la tasa objetivo a 7.25% (desde 7.5%)',
    fuente_id: 'banxico_sie', fuente_nombre: 'Banxico', tipo: 'oficial_derivado', idioma: 'es', seccion: 'oficiales',
    publicado_en: hace(260), imagen: null, imagen_via: null, tickers: [],
    fuente_dato: 'banxico:SF61745 (tasa objetivo)' },
  { url: 'https://sec.gov/8k/nvda', titular: 'NVDA presenta un 8-K',
    fuente_id: 'sec_8k', fuente_nombre: 'SEC EDGAR 8-K', tipo: 'oficial', idioma: 'en', seccion: 'oficiales',
    publicado_en: hace(400), imagen: null, imagen_via: null, tickers: ['NVDA'], fuente_dato: null },
];

const GO = [
  { id: 'valor_br', nombre: 'Valor BR', idioma: 'pt', tipo: 'medio', seccion: 'mexico_latam' },
  { id: 'cnbc', nombre: 'CNBC', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
  { id: 'marketwatch', nombre: 'MarketWatch', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
  { id: 'el_financiero', nombre: 'El Financiero', idioma: 'es', tipo: 'medio', seccion: 'mexico_latam' },
  { id: 'klement', nombre: 'Klement on Investing', idioma: 'en', tipo: 'newsletter', seccion: 'mercado' },
  { id: 'doomberg', nombre: 'Doomberg', idioma: 'en', tipo: 'newsletter', seccion: 'mercado' },
  { id: 'zerohedge', nombre: 'ZeroHedge', idioma: 'en', tipo: 'medio', seccion: 'mercado' },
  { id: 'banxico_sie', nombre: 'Banxico', idioma: 'es', tipo: 'oficial', seccion: 'oficiales' },
  { id: 'sec_8k', nombre: 'SEC EDGAR 8-K', idioma: 'en', tipo: 'oficial', seccion: 'oficiales' },
];
const CORRIDAS = [
  { fuente_id: 'valor_br', ok: true, motivo: null, guardadas: 12, ultima_corrida: hace(5) },
  { fuente_id: 'cnbc', ok: true, motivo: null, guardadas: 4, ultima_corrida: hace(5) },
  { fuente_id: 'marketwatch', ok: true, motivo: null, guardadas: 6, ultima_corrida: hace(5) },
  { fuente_id: 'el_financiero', ok: true, motivo: null, guardadas: 9, ultima_corrida: hace(5) },
  { fuente_id: 'klement', ok: true, motivo: null, guardadas: 1, ultima_corrida: hace(5) },
  { fuente_id: 'doomberg', ok: true, motivo: null, guardadas: 1, ultima_corrida: hace(5) },
  // CAÍDA, con su motivo real: el chip va punteado y el aviso lo nombra.
  { fuente_id: 'zerohedge', ok: false, motivo: 'HTTP 403 (bloqueo de datacenter)', guardadas: 0, ultima_corrida: hace(5) },
  { fuente_id: 'banxico_sie', ok: true, motivo: null, guardadas: 1, ultima_corrida: hace(5) },
  // `sec_8k` NO aparece: es el tercer estado, "sin cosechar".
];

// ── EL VOLUMEN DE PRODUCCIÓN, PARA LA GEOMETRÍA ──────────────────────
// Con tres notas por columna NINGUNA lista llega al pie, así que la
// comprobación del pie encimado pasaba sobre una página corta. El registro
// real tiene 16 fuentes y decenas de notas: con eso la lista de medios llegaba
// 600 px MÁS ABAJO que el pie y le pasaba por debajo. Este relleno existe para
// que esa geometría se pueda medir.
const RELLENO = Array.from({ length: 40 }, (_, i) => ({
  url: 'https://relleno.test/' + i,
  titular: 'Titular de relleno número ' + i + ', con el largo de un titular real de un medio',
  fuente_id: i % 2 ? 'cnbc' : 'marketwatch', fuente_nombre: i % 2 ? 'CNBC' : 'MarketWatch',
  tipo: i % 7 === 0 ? 'newsletter' : 'medio', idioma: 'en', seccion: 'mercado',
  publicado_en: hace(500 + i * 3), imagen: null, imagen_via: null, tickers: [], fuente_dato: null,
}));

let errorDeLectura = false;
let conVolumen = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.gif': 'image/gif' };
let pedidosApi = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__romper') {
    errorDeLectura = url.searchParams.get('v') === '1';
    res.writeHead(200); return res.end('ok');
  }
  if (url.pathname === '/__volumen') {
    conVolumen = url.searchParams.get('v') === '1';
    res.writeHead(200); return res.end('ok');
  }
  if (url.pathname === '/foto-ok.gif') {
    res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(PIXEL);
  }
  // La foto "rota": 404, como un hotlink que el medio no deja traer.
  if (url.pathname === '/foto-rota.gif') { res.writeHead(404); return res.end('no'); }
  // La foto LENTA: el servidor acepta la conexión y contesta seis segundos
  // después. No dispara `error` —llega bien, tarde— así que el relevo por
  // evento no entra nunca: sólo el plazo. Seis segundos de cuadro gris arriba
  // de la página es lo que se vio en producción.
  if (url.pathname === '/foto-lenta.gif') {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(PIXEL); }, 6000);
    return;
  }

  if (url.pathname === '/api/noticias' && url.searchParams.get('vista') === 'pagina') {
    pedidosApi++;
    const q = url.searchParams;
    const antesDe = q.get('antes_de');
    const base = conVolumen ? [...NOTAS, ...RELLENO] : NOTAS;
    const notas = errorDeLectura ? [] : base.filter((n) => !antesDe || n.publicado_en < antesDe);
    const armado = armaPagina(notas, {
      seccion: q.get('seccion') || 'todo',
      idioma: q.get('idioma') === 'es' ? 'es' : 'todo',
      q: q.get('q') || '',
      fuente: q.get('fuente') || null,
      orden: q.get('orden') === 'fuente' ? 'fuente' : 'hora',
      // Bajo a propósito: con 3 por columna, "cargar más" se puede ejercer.
      // Con volumen, el de producción: lo que llena las columnas.
      porColumna: conVolumen ? 30 : 3,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      vista: 'pagina',
      ...armado,
      error: errorDeLectura ? 'Neon: connection refused' : null,
      filtros: {
        seccion: q.get('seccion') || 'todo',
        idioma: q.get('idioma') === 'es' ? 'es' : 'todo',
        orden: q.get('orden') === 'fuente' ? 'fuente' : 'hora',
        q: q.get('q') || '', fuente: q.get('fuente') || null, horas: 72, antes_de: antesDe,
      },
      secciones: [
        { id: 'mercado', nombre: 'Mercado' }, { id: 'mexico_latam', nombre: 'México · LATAM' },
        { id: 'acciones', nombre: 'Acciones' }, { id: 'etfs', nombre: 'ETFs' },
        { id: 'cripto', nombre: 'Cripto' }, { id: 'oficiales', nombre: 'Oficiales' },
      ],
      secciones_sin_fuente: seccionesSinFuente(GO),
      fuentes: chipsDeFuente(GO, CORRIDAS),
      leidas: notas.length, tope: 400,
      generado_en: new Date(MOMENTO).toISOString(),
      fuente: 'neon:mercado_noticias (titulares de los feeds RSS/Atom de las fuentes registradas)',
    }));
  }
  const p = url.pathname === '/mercado/noticias' ? '/noticias.html' : url.pathname;
  try {
    const buf = await readFile(join(ROOT, p.replace(/^\//, '')));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('no'); }
});

const RELOJ_FIJO = `(() => {
  const fijo = ${MOMENTO};
  const Real = Date;
  class Falso extends Real {
    constructor(...a) { if (a.length === 0) super(fijo); else super(...a); }
    static now() { return fijo; }
  }
  window.Date = Falso;
})()`;

const fallos = [];
const ok = [];
function chequeo(nombre, cond, detalle) {
  (cond ? ok : fallos).push(detalle ? `${nombre} — ${detalle}` : nombre);
  console.log(`${cond ? '  ✓' : '  ✗'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
}

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = '/opt/pw-browsers';
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith('chromium')) : [];
  for (const d of dirs.sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const f = join(base, d, rel);
      if (existsSync(f)) return f;
    }
  }
  throw new Error('no encuentro un Chromium en ' + base + ': poné CHROME_PATH');
}
const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });

try {
  // ══════════════ MÓVIL 390 px, TÁCTIL ══════════════
  console.log('\n── 390 × 844, táctil ──');
  const movil = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await movil.addInitScript(RELOJ_FIJO);
  const p = await movil.newPage();
  const errores = [];
  p.on('pageerror', (e) => errores.push(String(e)));
  // El 404 de `foto-rota.gif` es A PROPÓSITO —es la caída del hotlink que hay
  // que ver—, así que no cuenta como error de la página. Se filtra por la URL
  // del mensaje y no por su texto: el texto que Chrome emite es genérico
  // ("Failed to load resource"), así que filtrar por texto apagaría TODOS los
  // 404 y con ellos el aviso de un script que no cargó.
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const donde = (m.location && m.location().url) || '';
    if (/foto-rota/.test(donde) || /foto-rota/.test(m.text())) return;
    // Google Fonts no se alcanza desde este sandbox. No es un error de la
    // página: es justo el caso que el respaldo del sistema cubre, y abajo hay
    // una comprobación que lo exige en vez de taparlo.
    if (/fonts\.(googleapis|gstatic)\.com/.test(donde) || /fonts\.(googleapis|gstatic)/.test(m.text())) return;
    errores.push(m.text() + (donde ? ' @ ' + donde : ''));
  });
  p.on('requestfailed', (r) => {
    if (/foto-rota/.test(r.url()) || /fonts\.(googleapis|gstatic)\.com/.test(r.url())) return;
    errores.push('petición fallida: ' + r.url());
  });

  await p.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.dest');

  chequeo('la página carga sin errores de consola', errores.length === 0, errores.slice(0, 2).join(' | '));
  chequeo('UNA sola petición al endpoint para abrir (regla 7)', pedidosApi === 1, `fueron ${pedidosApi}`);

  // ── LA PÁGINA NO DEPENDE DE QUE LLEGUE LA TIPOGRAFÍA ────────────────
  // En este sandbox Google Fonts NO responde, y eso convierte la corrida en
  // la prueba del respaldo: si la página sólo se viera bien con IBM Plex
  // cargada, acá se vería mal. Se exige que la pila declarada tenga a Plex
  // PRIMERO y una fuente del sistema detrás, y que el texto tenga tamaño real.
  const tipografia = await p.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const h = document.querySelector('.dest .tit').getBoundingClientRect();
    return { familia: cs.fontFamily, alto: Math.round(h.height), ancho: Math.round(h.width) };
  });
  chequeo('la pila declara IBM Plex primero y una del sistema de respaldo',
    /IBM Plex Sans Condensed/.test(tipografia.familia)
    && /(-apple-system|BlinkMacSystemFont|sans-serif)/.test(tipografia.familia), tipografia.familia);
  chequeo('y con la tipografía caída el titular sigue midiendo y ocupando lugar',
    tipografia.alto > 10 && tipografia.ancho > 50, JSON.stringify(tipografia));

  const scroll = await p.evaluate(() => ({
    h: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  chequeo('sin scroll horizontal a 390 px', !scroll.h);

  // ── LAS DESTACADAS ──────────────────────────────────────────────────
  // El plazo del relevo de fotos es de 4 s: se espera a que venza antes de
  // mirar, o la foto que cuelga se leería como "todavía cargando".
  await p.waitForTimeout(4600);
  const dest = await p.evaluate(() => {
    const ds = [...document.querySelectorAll('.dest')];
    return ds.map((d) => ({
      tit: d.querySelector('.tit').textContent,
      fuente: (d.querySelector('.meta b') || {}).textContent || null,
      foto: !!d.querySelector('img.foto'),
      // Alto del hueco de imagen: 0 cuando no hay NI foto NI bloque.
      alto_media: (() => {
        const m = d.querySelector('img.foto, .bloque');
        return m ? Math.round(m.getBoundingClientRect().height) : 0;
      })(),
      bloque: d.querySelector('.bloque') ? d.querySelector('.bloque').textContent.trim() : null,
    }));
  });
  chequeo('cuatro destacadas', dest.length === 4, String(dest.length));
  chequeo('la que SÍ traía foto la muestra', dest.some((d) => d.foto));

  // ── CUATRO MEDIOS, NO CUATRO NOTAS DEL MISMO ────────────────────────
  // En producción las cuatro salieron de Valor BR, que publica todo con
  // imagen: `conFoto.slice(0,4)` le daba la fila entera al medio que más
  // publica. El fixture trae ese medio con cuatro notas con foto, primeras
  // en la lista, para que esta comprobación se ponga roja si alguien vuelve
  // a elegir por nota en vez de por fuente.
  const fuentesDest = dest.map((d) => d.fuente);
  chequeo('las cuatro destacadas son de cuatro fuentes DISTINTAS',
    new Set(fuentesDest).size === 4, JSON.stringify(fuentesDest));
  chequeo('y el medio que publica todo con foto aporta una, no cuatro',
    fuentesDest.filter((f) => f === 'Valor BR').length === 1, JSON.stringify(fuentesDest));
  const notaDest = await p.textContent('#dest-nota');
  chequeo('la nota declara de cuántas fuentes son', /4 fuentes distintas/.test(notaDest), notaDest);

  // ── SIN FOTO NO SE RESERVA EL HUECO DE LA FOTO ──────────────────────
  // Lo que se vio en prod: cuadros grises vacíos arriba de la página.
  const sinFoto = dest.filter((d) => !d.foto && !d.bloque);
  chequeo('la destacada que el feed no trajo con foto NO reserva hueco de imagen',
    sinFoto.length > 0 && sinFoto.every((d) => d.alto_media === 0),
    JSON.stringify(dest.map((d) => ({ f: d.fuente, foto: d.foto, h: d.alto_media }))));
  // La foto 404 cae al bloque de color CON el nombre de la fuente: ahí el
  // hueco YA estaba medido y dejarlo vacío haría saltar la tarjeta.
  chequeo('la foto que contesta 404 cae al bloque con el nombre de la fuente',
    dest.some((d) => d.bloque === 'MarketWatch'), JSON.stringify(dest.map((d) => d.bloque)));
  chequeo('y la foto que llega tarde también cae al bloque, por plazo vencido',
    dest.some((d) => d.bloque === 'Valor BR'), JSON.stringify(dest.map((d) => d.bloque)));
  chequeo('ninguna destacada queda con un hueco de imagen vacío',
    dest.every((d) => d.alto_media === 0 || d.foto || d.bloque),
    JSON.stringify(dest.map((d) => ({ h: d.alto_media, foto: d.foto, b: d.bloque }))));

  // Y la tarjeta sin foto no se estira al alto de las que la tienen: eso
  // sería reservar el hueco de la foto por la puerta de atrás, que es como se
  // veía en la captura aunque el elemento de imagen ya no estuviera.
  const altos = await p.evaluate(() => [...document.querySelectorAll('.dest')].map((d) => ({
    media: !!d.querySelector('img.foto, .bloque'),
    alto: Math.round(d.getBoundingClientRect().height),
  })));
  const conMedia = altos.filter((a) => a.media).map((a) => a.alto);
  const sinMedia = altos.filter((a) => !a.media).map((a) => a.alto);
  chequeo('y la tarjeta sin foto es MÁS BAJA que las que sí la traen',
    sinMedia.length > 0 && conMedia.length > 0 && Math.max(...sinMedia) < Math.min(...conMedia),
    JSON.stringify({ conMedia, sinMedia }));

  // ── EL ARREGLO DEL ESPACIO PERDIDO, EN PANTALLA ─────────────────────
  const titulares = await p.evaluate(() =>
    [...document.querySelectorAll('.dest .tit, .fila .tit')].map((e) => e.textContent));
  chequeo('el titular con "menor que" llega entero, con su precio',
    titulares.some((t) => t.includes('AMD <$100') && t.includes('2027')),
    titulares.find((t) => t.includes('AMD')) || 'no está');
  chequeo('y ningún titular trae un separador invisible pegando dos palabras',
    titulares.every((t) => !/[​⁠﻿­]/.test(t)));

  // ── LAS FUENTES EN ESPAÑOL, EN VERDE ────────────────────────────────
  const colores = await p.evaluate(() => {
    const out = {};
    for (const b of document.querySelectorAll('.fchip')) {
      out[b.dataset.fuente] = {
        color: getComputedStyle(b).color,
        es: b.classList.contains('es'),
        caida: b.classList.contains('caida'),
        punto: getComputedStyle(b.querySelector('.pt')).backgroundColor,
        titulo: b.getAttribute('title'),
      };
    }
    return out;
  });
  chequeo('las fuentes en español llevan la clase verde',
    colores.el_financiero.es && colores.banxico_sie.es && !colores.cnbc.es,
    JSON.stringify({ fin: colores.el_financiero.es, cnbc: colores.cnbc.es }));
  chequeo('y el verde es el verde, no un gris cualquiera',
    colores.el_financiero.color === 'rgb(0, 201, 125)', colores.el_financiero.color);
  chequeo('la fuente caída va punteada y su chip DICE el motivo',
    colores.zerohedge.caida && /403/.test(colores.zerohedge.titulo), colores.zerohedge.titulo);
  chequeo('la fuente sin cosechar NO se pinta como caída: es otro problema',
    !colores.sec_8k.caida && /no se ha cosechado/.test(colores.sec_8k.titulo), colores.sec_8k.titulo);

  // ── NINGUNA PESTAÑA SE ENCIMA CON LA DE AL LADO ─────────────────────
  // La captura a 390 px enseñó "MercadoMéxico · LATAM" y "AcciAMEs24": los
  // botones se encogían por debajo de su texto dentro del contenedor con
  // overflow. Cada uno medía ≥44 px de alto y la URL cambiaba bien, así que
  // TODAS las comprobaciones pasaban sobre una barra ilegible. Ésta es la que
  // mira lo que el ojo ve.
  const encimados = await p.evaluate(() => {
    const malos = [];
    for (const barra of ['#secciones', '.toggles', '#fuentes']) {
      const hijos = [...document.querySelectorAll(barra + ' > *')]
        .map((e) => ({ t: (e.textContent || '').trim().slice(0, 18), r: e.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0);
      for (let i = 1; i < hijos.length; i++) {
        if (hijos[i].r.left < hijos[i - 1].r.right - 0.5) {
          malos.push(barra + ': "' + hijos[i - 1].t + '" / "' + hijos[i].t + '"');
        }
      }
    }
    return malos;
  });
  chequeo('ninguna pestaña, toggle ni chip se encima con el de al lado',
    encimados.length === 0, encimados.slice(0, 3).join(' · '));

  // ── EL TEXTO CONCUERDA EN NÚMERO ────────────────────────────────────
  // "1 caídas" y "1 notas" se leen como un error de la página.
  const textos = await p.evaluate(() => ({
    pie: document.getElementById('pie').textContent,
    aviso: (document.getElementById('aviso-caidas') || {}).textContent || '',
  }));
  chequeo('con UNA fuente caída el texto va en singular',
    /1 caída\b/.test(textos.pie) && !/1 caídas/.test(textos.pie)
    && /1 de \d+ fuentes no contestó/.test(textos.aviso),
    textos.pie.slice(-110));

  const aviso = await p.textContent('#aviso-caidas');
  chequeo('el aviso de arriba nombra la caída y dice que NO es "no pasó nada"',
    /zerohedge/.test(aviso) && /no está medido/.test(aviso), aviso.slice(0, 90));

  // ── CHIP DE ESTADO DE MERCADO (regla 4) ─────────────────────────────
  const chip = await p.textContent('#chip');
  chequeo('el chip dice el estado de LAS DOS bolsas, no una sola etiqueta',
    /NYSE/.test(chip) && /BMV/.test(chip), chip);

  // ── TAP REAL: la sección ────────────────────────────────────────────
  const botonMx = p.locator('#secciones button[data-seccion="mexico_latam"]');
  const caja = await botonMx.boundingBox();
  chequeo('el botón de sección mide ≥44 px de alto (tap)', caja.height >= 44, `${Math.round(caja.height)}px`);
  await botonMx.tap();
  await p.waitForFunction(() => location.search.includes('mexico_latam'), null, { timeout: 2000 });
  chequeo('el tap en la sección la escribe en la URL (regla 9)',
    (await p.evaluate(() => location.search)).includes('seccion=mexico_latam'),
    await p.evaluate(() => location.search));
  // La URL cambia ANTES que la lista (replaceState es inmediato, el fetch no):
  // se espera el repintado o se mide la lista vieja.
  const DE_LA_REGION = /Walmex|peso|Ibovespa|Petrobras|Real|Vale/;
  await p.waitForFunction(() => {
    const ts = [...document.querySelectorAll('.fila .tit')].map((e) => e.textContent);
    return ts.length > 0 && ts.every((t) => /Walmex|peso|Ibovespa|Petrobras|Real|Vale/.test(t));
  }, null, { timeout: 3000 }).catch(() => {});
  const trasMx = await p.evaluate(() =>
    [...document.querySelectorAll('.fila .tit')].map((e) => e.textContent));
  // "México · LATAM" es la sección, y Brasil es LATAM: la lista tiene que
  // quedar con las de la región, no sólo con las mexicanas. Lo que se exige
  // es que NO se cuele nada de fuera (la Fed, Nvidia, el Nasdaq).
  chequeo('y la lista queda sólo con las de México y LATAM',
    trasMx.length > 0 && trasMx.every((t) => DE_LA_REGION.test(t)), JSON.stringify(trasMx));

  // ── TAP REAL: las pestañas sin fuente van deshabilitadas ────────────
  const cripto = p.locator('#secciones button[data-seccion="cripto"]');
  chequeo('Cripto va deshabilitada y dice "pronto" (no se finge)',
    await cripto.isDisabled() && /pronto/.test(await cripto.textContent()),
    await cripto.textContent());
  await cripto.tap({ force: true });
  chequeo('y tocarla no cambia nada',
    (await p.evaluate(() => location.search)).includes('mexico_latam'));

  // ── TAP REAL: el toggle de idioma ───────────────────────────────────
  // LA URL CAMBIA ANTES QUE LA LISTA. `history.replaceState` es inmediato y
  // el `fetch` no, así que esperar la URL y leer la lista en la línea
  // siguiente mide la lista VIEJA — la primera versión de esta comprobación
  // falló justamente así, con CNBC todavía en pantalla tras pedir "Solo
  // español". Se espera a que el REPINTADO haya ocurrido.
  await p.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.fila');
  await p.locator('#t-idioma button[data-idioma="es"]').tap();
  await p.waitForFunction(() => {
    const fs = [...document.querySelectorAll('.fila .meta b, .dest .meta b')];
    return fs.length > 0 && fs.every((e) => /Financiero|Banxico/.test(e.textContent));
  }, null, { timeout: 3000 }).catch(() => {});
  const soloEs = await p.evaluate(() =>
    [...document.querySelectorAll('.fila .meta b, .dest .meta b')].map((e) => e.textContent));
  chequeo('"Solo español" deja solamente fuentes en español',
    soloEs.length > 0 && soloEs.every((n) => /Financiero|Banxico/.test(n)), JSON.stringify(soloEs));

  // ── TAP REAL: el chip de ticker filtra ──────────────────────────────
  // Se vuelve a abrir limpia: el filtro de idioma anterior deja fuera las
  // notas con ticker, y un `.chip-tk` que no existe no prueba nada.
  await p.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.chip-tk');
  const tk = p.locator('.chip-tk').first();
  const cajaTk = await tk.boundingBox();
  chequeo('el chip de ticker mide ≥28 px (cabe el dedo sin tapar el titular)',
    cajaTk.height >= 28, `${Math.round(cajaTk.height)}px`);
  const simbolo = await tk.textContent();
  await tk.tap();
  await p.waitForFunction((s) => location.search.includes('q=' + s), simbolo, { timeout: 2000 });
  chequeo('tocar un ticker filtra la página y lo escribe en la URL',
    (await p.evaluate(() => location.search)).includes('q=' + simbolo),
    await p.evaluate(() => location.search));
  chequeo('y el campo de búsqueda muestra lo que se filtró',
    (await p.inputValue('#q')) === simbolo);

  // ── TAP REAL: "cargar más" ──────────────────────────────────────────
  await p.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.dest');
  const antes = await p.locator('#medios .fila').count();
  const btn = p.locator('#mas-medios');
  chequeo('"cargar más" aparece cuando hay más de las que caben',
    await btn.isVisible(), `${antes} filas`);
  await btn.tap();
  await p.waitForFunction((n) => document.querySelectorAll('#medios .fila').length > n, antes, { timeout: 3000 });
  const despues = await p.locator('#medios .fila').count();
  chequeo('y trae más sin repetir las que ya estaban', despues > antes, `${antes} → ${despues}`);
  const urls = await p.evaluate(() => [...document.querySelectorAll('#medios .fila')].map((a) => a.href));
  chequeo('ninguna fila duplicada tras cargar más', new Set(urls).size === urls.length);

  // ── EL PIE (regla 5) ────────────────────────────────────────────────
  const pie = await p.textContent('#pie');
  chequeo('el pie dice fuente, hora y la leyenda',
    /neon:mercado_noticias/.test(pie) && /actualizado/.test(pie) && /Información, no asesoría/.test(pie),
    pie.slice(0, 80));
  chequeo('y dice cuántas fuentes están caídas', /caída/.test(pie),
    (pie.match(/\(.*?caída.*?\)/) || ['no lo dice'])[0]);

  // ── UNA LECTURA CAÍDA NO DICE "NO PASÓ NADA" ────────────────────────
  await p.goto(`${BASE}/__romper?v=1`);
  await p.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#medios .vacio');
  const vacio = await p.textContent('#medios .vacio');
  chequeo('con la lectura caída la pantalla dice LA CAUSA, no "no hay noticias"',
    /no se pudo leer/.test(vacio) && /connection refused/.test(vacio), vacio);
  await p.goto(`${BASE}/__romper?v=0`);

  // ── LA CAPTURA ──────────────────────────────────────────────────────
  await p.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.dest');
  const encimaPie390 = await p.evaluate(() => {
    const pie = document.getElementById('pie').getBoundingClientRect();
    const sobre = [];
    for (const sel of ['#medios', '#newsletters', '#oficiales', '#destacadas', '#mas-medios']) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.bottom > pie.top + 1 && r.top < pie.bottom - 1
          && r.right > pie.left + 1 && r.left < pie.right - 1) {
        sobre.push({ sel, bottom: Math.round(r.bottom), pieTop: Math.round(pie.top) });
      }
    }
    return sobre;
  });
  const piePlano = await p.textContent('#pie');
  chequeo('el pie no enseña rutas de archivo ni jerga de código',
    !/\.json|\.js\b|api\/_lib|`/.test(piePlano), piePlano);

  chequeo('el pie NO se encima sobre ninguna lista a 390',
    encimaPie390.length === 0, JSON.stringify(encimaPie390));

  await p.screenshot({ path: join(OUT, 'noticias-390.png'), fullPage: true });
  console.log(`  → ${join(OUT, 'noticias-390.png')}`);
  await movil.close();

  // ══════════════ ESCRITORIO 1440 × 1000 ══════════════
  console.log('\n── 1440 × 1000, puntero fino ──');
  const esc = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await esc.addInitScript(RELOJ_FIJO);
  const d = await esc.newPage();
  const erroresD = [];
  d.on('pageerror', (e) => erroresD.push(String(e)));
  await d.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.dest');
  chequeo('escritorio sin errores de consola', erroresD.length === 0, erroresD.slice(0, 2).join(' | '));

  const caja1440 = await d.evaluate(() => ({
    scrollV: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    scrollH: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    cols: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
    destacadas: document.querySelectorAll('.dest').length,
    // UNA FILA se comprueba por la coordenada vertical, no por un ancho
    // mágico: la primera versión exigía "ancho < 330 px" y las cuatro estaban
    // perfectamente en fila a 341 px cada una. El número adivinado era la
    // comprobación, no el layout.
    topes: [...document.querySelectorAll('.dest')].map((e) => Math.round(e.getBoundingClientRect().top)),
    anchoDest: Math.round(document.querySelector('.dest').getBoundingClientRect().width),
  }));
  chequeo('1440×1000 SIN scroll vertical (regla 8)', !caja1440.scrollV);
  chequeo('ni horizontal', !caja1440.scrollH);
  chequeo('las cuatro destacadas en UNA fila (misma coordenada de arriba)',
    caja1440.destacadas === 4 && new Set(caja1440.topes).size === 1,
    JSON.stringify({ n: caja1440.destacadas, topes: caja1440.topes, ancho: caja1440.anchoDest }));
  chequeo('dos columnas: la de medios y la lateral de 336 px',
    /336px/.test(caja1440.cols), caja1440.cols);

  const pieVisible = await d.evaluate(() => {
    const r = document.getElementById('pie').getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  chequeo('el pie se ve sin recorrer la página', pieVisible);

  // ── EL PIE NO SE ENCIMA SOBRE LAS LISTAS ────────────────────────────
  // Lo que Lety vio en prod. La comprobación de arriba sólo miraba que el pie
  // ENTRARA en la ventana, y un pie encimado entra igual de bien: cae dentro
  // de la ventana porque está pintado sobre el contenido. Hay que medir la
  // distancia, no la visibilidad.
  // Con el volumen de producción: 16 fuentes y 50 notas, columnas llenas.
  await d.goto(`${BASE}/__volumen?v=1`);
  await d.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.fila');
  const encimaPie = await d.evaluate(() => {
    const pie = document.getElementById('pie').getBoundingClientRect();
    const sobre = [];
    for (const sel of ['#medios', '#newsletters', '#oficiales', '#destacadas', '#mas-medios']) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      // Se tocan en vertical Y comparten horizontal: eso es encimarse.
      const cruza = r.bottom > pie.top + 1 && r.top < pie.bottom - 1
        && r.right > pie.left + 1 && r.left < pie.right - 1;
      if (cruza) sobre.push({ sel, bottom: Math.round(r.bottom), pieTop: Math.round(pie.top) });
    }
    return sobre;
  });
  chequeo('el pie NO se encima sobre ninguna lista a 1440, con columnas llenas',
    encimaPie.length === 0, JSON.stringify(encimaPie));
  // Y la lista se recorre POR DENTRO en vez de empujar la página: es la otra
  // mitad del arreglo. Sin esto, "no se encima" se podría cumplir recortando
  // la lista a la mitad sin forma de ver el resto.
  const medioScroll = await d.evaluate(() => {
    const e = document.querySelector('#medios');
    return { alto: Math.round(e.getBoundingClientRect().height), contenido: e.scrollHeight };
  });
  chequeo('y la lista de medios se recorre por dentro, no empuja la página',
    medioScroll.contenido > medioScroll.alto + 20, JSON.stringify(medioScroll));
  // Una fila partida por la mitad contra el borde se lee como "roto" o como
  // "el pie se encimó". El desvanecido dice que hay más y que se recorre.
  const desvanece = await d.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#medios'));
    return cs.maskImage || cs.webkitMaskImage || 'none';
  });
  chequeo('y la lista que se recorre lo dice con un desvanecido abajo',
    /gradient/.test(desvanece), desvanece);
  await d.goto(`${BASE}/__volumen?v=0`);
  await d.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.dest');

  // El toggle "Por fuente" agrupa, con hover de escritorio (click, no tap).
  await d.click('#t-orden button[data-orden="fuente"]');
  await d.waitForSelector('.grupo-fuente');
  const grupos = await d.evaluate(() =>
    [...document.querySelectorAll('.grupo-fuente b')].map((e) => e.textContent));
  chequeo('"Por fuente" agrupa y la que más publicó va primero',
    grupos.length >= 2 && grupos[0] === 'Valor BR', JSON.stringify(grupos));
  // El desempate por alfabeto se fija en la prueba unitaria
  // (mercado-noticias-pagina.test.mjs), donde se puede construir un empate de
  // verdad: acá las tres fuentes tienen cuentas distintas, así que "el orden
  // es alfabético" sería falso y la comprobación mediría el fixture.
  chequeo('y el orden queda en la URL',
    (await d.evaluate(() => location.search)).includes('orden=fuente'));

  // La URL con estado abre IGUAL del otro lado (regla 9).
  await d.goto(`${BASE}/mercado/noticias?seccion=acciones&idioma=todo&orden=hora`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.fila, .vacio');
  const sel = await d.evaluate(() =>
    document.querySelector('#secciones button[aria-selected="true"]').dataset.seccion);
  chequeo('una URL pegada abre con la sección ya puesta', sel === 'acciones', sel);
  const soloConTicker = await d.evaluate(() =>
    [...document.querySelectorAll('.fila')].map((f) => f.querySelectorAll('.chip-tk').length));
  chequeo('"Acciones" trae sólo notas con al menos un ticker',
    soloConTicker.length > 0 && soloConTicker.every((n) => n >= 1), JSON.stringify(soloConTicker));

  await d.goto(`${BASE}/mercado/noticias`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.dest');
  await d.screenshot({ path: join(OUT, 'noticias-1440.png') });
  console.log(`  → ${join(OUT, 'noticias-1440.png')}`);
  await esc.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
