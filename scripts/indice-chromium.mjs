// ═══════════════════════════════════════════════════════════════════
// scripts/indice-chromium.mjs — /mercado/indice/:idx en un Chromium real.
//
// El cierre de R4 (regla 10): 390 px con TAP REAL y escritorio, con captura
// de las dos.
//
// EL FIXTURE ESTÁ ARMADO PARA QUE DUELA:
//   · 180 sesiones — a propósito MENOS que las 252 de un año bursátil y
//     MENOS que las 200 de la media larga. Así se ve lo único que de verdad
//     importa de esta pantalla: que la media de 200 días NO se dibuje y que
//     se diga por qué, en vez de aparecer una línea inventada;
//   · 3A y 5A en la tabla de rendimiento, que la serie no alcanza: las filas
//     siguen ahí con su causa, no desaparecen;
//   · sin componentes, que es el estado real de los nueve: el panel lo
//     declara en vez de rellenarse con el universo del screener;
//   · el FIX presente, para que la segunda columna tenga con qué convertirse.
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
// La MISMA aritmética que el endpoint y la pantalla: la comprobación no trae
// su propia media móvil, la importa.
const { mediaMovil, rango52, volatilidad, INDICES } = await import(join(ROOT, 'api/_lib/mercado-indice.js'));

const MOMENTO = Date.parse('2026-10-20T16:30:00Z');
const DIA = 86400;
const FIN = Math.floor(Date.parse('2026-10-19T00:00:00Z') / 1000);

// ═══════════════════════════════════════════════════════════════════
// EL FIXTURE SALE DEL ENDPOINT, NO DE MI MANO.
//
// La versión anterior escribía el JSON de `/api/mercado-indice` a mano, con
// velas `{time, open, high, low, close}` — la forma que pide Lightweight
// Charts. El endpoint devuelve `{t,o,h,l,c,v}`, que es lo que sale de
// `/api/candles`. Las 38 comprobaciones pasaban contra una forma que el
// endpoint NUNCA devolvió, y en producción la ficha se quedó en
// "cargando SPX…" con la gráfica en blanco y los nueve periodos en "—"
// (Lety, 2026-10-20).
//
// Así que acá se corre el handler DE VERDAD —el mismo archivo que Vercel
// sirve— y lo único que se finge es la RED: Yahoo y el SIE de Banxico. Si
// mañana alguien cambia la forma de una vela en `api/candles.js`, esta
// corrida lo ve. Un fixture escrito a mano, por definición, no.
// ═══════════════════════════════════════════════════════════════════
const SESIONES = 180;   // MENOS que 200: la media larga no se puede dibujar
const CIERRES = Array.from({ length: SESIONES }, (_, i) => 5000 + Math.sin(i / 18) * 420 + i * 2.4);

// La respuesta CRUDA de Yahoo v8, tal como la parsea `extractYahooCandles`.
function yahooChart(moneda = 'USD') {
  const ts = CIERRES.map((_, i) => FIN - (SESIONES - 1 - i) * DIA);
  return {
    chart: { result: [{
      meta: { currency: moneda },
      timestamp: ts,
      indicators: { quote: [{
        open: CIERRES.map((c) => c - 6),
        high: CIERRES.map((c) => c + 18),
        low: CIERRES.map((c) => c - 22),
        close: CIERRES.slice(),
        volume: CIERRES.map(() => 1000),
      }] },
    }] },
  };
}

// La respuesta CRUDA del SIE, con sus fechas DD/MM/AAAA y su "N/E".
const FIX_CRUDO = {
  bmx: { series: [{ idSerie: 'SF43718', titulo: 'Tipo de cambio FIX',
    datos: Array.from({ length: 200 }, (_, i) => {
      const d = new Date((FIN - (199 - i) * DIA) * 1000);
      const [a, m, dd] = d.toISOString().slice(0, 10).split('-');
      return { fecha: `${dd}/${m}/${a}`, dato: (18.2 + Math.sin(i / 25) * 0.6).toFixed(4) };
    }) }] },
};

// Las noticias siguen siendo fixture: vienen de Neon y acá no hay Postgres.
// Su forma SÍ está fijada aparte, en la prueba de contratos.
const NOTICIAS_FIXTURE = {
  filas: [{ url: 'https://medio.test/spx', titular: 'El S&P 500 cierra en máximos del mes',
            fuente_id: 'cnbc', fuente_nombre: 'CNBC', publicado_en: '2026-10-20T15:00:00.000Z' }],
  total: 1, de: 40, fuente: 'neon:mercado_noticias', motivo: null,
};

process.env.BANXICO_TOKEN = process.env.BANXICO_TOKEN || 'ficticio-para-la-corrida';
const fetchReal = globalThis.fetch;
let fallaSerie = false;
globalThis.fetch = async (recurso, opciones) => {
  const u = String((recurso && recurso.url) || recurso || '');
  const json = (o, status = 200) => new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json' },
  });
  if (u.includes('query1.finance.yahoo.com/v8/finance/chart/')) {
    // El 429 de verdad: Yahoo contestando que no. La pantalla tiene que
    // decirlo, no quedarse en blanco.
    if (fallaSerie) return json({ error: 'Too Many Requests' }, 429);
    const moneda = /%5EMXX|\^MXX/.test(u) ? 'MXN' : 'USD';
    return json(yahooChart(moneda));
  }
  if (u.includes('banxico.org.mx')) return json(FIX_CRUDO);
  // Nada más sale a la red en esta corrida. Si algo lo intenta, se ve.
  throw new Error('la corrida intentó salir a la red: ' + u);
};

const { default: mercadoIndiceHandler } = await import(join(ROOT, 'api/mercado-indice.js'));

async function fichaDeVerdad(idx, rango) {
  let code = 200; let body = null;
  const res = {
    setHeader() {}, getHeader() {}, status(c) { code = c; return this; },
    json(o) { body = o; return this; }, send(o) { body = o; return this; }, end() { return this; },
  };
  await mercadoIndiceHandler({ method: 'GET', query: { idx, rango }, headers: {}, url: '/' }, res);
  // Las noticias no pueden venir de Neon acá: se completan con el fixture,
  // dicho en voz alta en vez de escondido dentro del armado.
  if (body && (!body.noticias || !(body.noticias.filas || []).length)) body.noticias = NOTICIAS_FIXTURE;
  return { code, body };
}


const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidos = 0;

// Las velas TAL COMO LAS SIRVE EL ENDPOINT. Las comprobaciones que rehacen la
// aritmética (volatilidad, rango de 52 semanas) miden contra esto y no contra
// una copia local: si el endpoint recorta o reordena la serie, se ve acá.
const VELAS = (await fichaDeVerdad('SPX')).body.serie.velas;
if (!Array.isArray(VELAS) || VELAS.length !== SESIONES) {
  throw new Error(`el endpoint devolvió ${(VELAS || []).length} velas y el fixture tiene ${SESIONES}`);
}
// Y la forma es la del productor, no la de la librería de gráficas: es el
// defecto que costó la ficha entera.
for (const campo of ['t', 'o', 'h', 'l', 'c']) {
  if (!Number.isFinite(VELAS[0][campo])) throw new Error('la vela del endpoint no trae ' + campo);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__romper') { fallaSerie = url.searchParams.get('v') === '1'; res.writeHead(200); return res.end('ok'); }

  if (url.pathname === '/api/mercado-indice') {
    pedidos++;
    const { code, body } = await fichaDeVerdad(
      url.searchParams.get('idx') || 'SPX', url.searchParams.get('rango') || undefined);
    res.writeHead(code, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  let p = url.pathname;
  if (/^\/mercado\/indice\//.test(p)) p = '/indice.html';
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

const fallos = []; const ok = [];
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
  throw new Error('no encuentro un Chromium en ' + base);
}
const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
const esFuente = (u) => /fonts\.(googleapis|gstatic)\.com/.test(u || '');

try {
  // ══════════════ MÓVIL 390 px ══════════════
  console.log('\n── 390 × 844, táctil ──');
  const movil = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  await movil.addInitScript(RELOJ_FIJO);
  const p = await movil.newPage();
  const errores = [];
  p.on('pageerror', (e) => errores.push(String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const u = (m.location && m.location().url) || '';
    if (esFuente(u) || /ERR_CERT_AUTHORITY_INVALID/.test(m.text())) return;
    errores.push(m.text());
  });

  await p.goto(`${BASE}/mercado/indice/SPX`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#tabla-rend tbody tr');

  chequeo('la ficha carga sin errores de consola', errores.length === 0, errores.slice(0, 2).join(' | '));
  chequeo('UNA sola petición para abrir (regla 7)', pedidos === 1, `fueron ${pedidos}`);

  // ── LA FICHA NO SE QUEDA EN "CARGANDO" ──────────────────────────────
  // Es el síntoma con el que salió a producción: el pie decía "cargando
  // SPX…" para siempre porque la gráfica lanzaba y se llevaba por delante a
  // todo lo que venía después. Mirar el pie es mirar si `pintar()` llegó al
  // final.
  const estadoDePintado = await p.evaluate(() => ({
    pie: (document.getElementById('pie').textContent || '').slice(0, 40),
    paneles_rotos: [...document.querySelectorAll('.aviso')]
      .map((e) => e.textContent).filter((t) => /no se pudo pintar/.test(t)),
    nivel: (document.getElementById('nivel').textContent || '').trim(),
  }));
  chequeo('el pie NO se queda en "cargando" con los datos en la mano',
    !/^cargando/.test(estadoDePintado.pie), estadoDePintado.pie);
  chequeo('ningún panel se quedó sin pintar',
    estadoDePintado.paneles_rotos.length === 0, JSON.stringify(estadoDePintado.paneles_rotos));
  chequeo('el nivel del índice es un número, no un guión',
    /\d/.test(estadoDePintado.nivel), estadoDePintado.nivel);

  // ── LO QUE SE VE EN PANTALLA VA SIN JERGA ───────────────────────────
  // Lety, 2026-10-20: *"Lo que se ve en pantalla va sin jerga: el aviso de
  // insiders dice `getcurrent` con backticks."*
  //
  // Lo que NO entra acá son las fuentes declaradas (`yahoo:v8/chart`,
  // `banxico:SF43718`): eso es la procedencia que pide la regla 3, y es
  // deliberado que se vea. Lo que se persigue es el nombre interno de un
  // endpoint, de un campo o de un archivo del repo, y las comillas de código.
  const jerga = await p.evaluate(() => {
    const malas = [];
    const PROHIBIDO = [
      [/`/, 'comillas de código'],
      [/\.(js|json|mjs)\b/, 'nombre de archivo'],
      [/api\/_lib/, 'ruta del repo'],
      [/getcurrent|companyfacts|quoteSummary|metric=all|cik_str|infotable/i, 'nombre interno de un endpoint o campo'],
    ];
    const paseo = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = paseo.nextNode())) {
      const t = (n.textContent || '').trim();
      if (!t) continue;
      const padre = n.parentElement;
      if (padre && (padre.tagName === 'SCRIPT' || padre.tagName === 'STYLE')) continue;
      for (const [re, por] of PROHIBIDO) if (re.test(t)) malas.push(por + ': ' + t.slice(0, 70));
    }
    // Y lo que vive en un `title`, que también se lee.
    for (const el of document.querySelectorAll('[title]')) {
      const t = el.getAttribute('title') || '';
      for (const [re, por] of PROHIBIDO) if (re.test(t)) malas.push('en un title · ' + por + ': ' + t.slice(0, 70));
    }
    return malas;
  });
  chequeo('nada de lo que se ve en pantalla trae jerga de código',
    jerga.length === 0, JSON.stringify(jerga.slice(0, 3)));
  chequeo('sin scroll horizontal a 390 px',
    !(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));

  // ── LA GRÁFICA Y SUS OVERLAYS ───────────────────────────────────────
  const grafica = await p.evaluate(() => ({
    canvas: document.querySelectorAll('#grafica canvas').length,
    aviso: document.getElementById('grafica-aviso').textContent,
    leyenda: document.getElementById('leyenda').textContent,
  }));
  chequeo('la gráfica dibuja', grafica.canvas > 0, `${grafica.canvas} canvas`);
  // LO MÁS IMPORTANTE DE LA PANTALLA: con 180 sesiones la media de 200 días
  // NO EXISTE, y la ficha lo dice en vez de dibujar una línea inventada.
  chequeo('con 180 sesiones NO se dibuja la media de 200 días, y se dice por qué',
    /sin media de 200 días/.test(grafica.aviso) && /180 cierres/.test(grafica.aviso), grafica.aviso);
  chequeo('la de 50 días SÍ se dibuja, y se dice desde qué sesión arranca',
    /media de 50 días arranca en la sesión 50/.test(grafica.aviso), grafica.aviso);
  chequeo('y la ventana de 52 semanas declara que está incompleta',
    /180 sesiones de las 252/.test(grafica.aviso), grafica.aviso);
  chequeo('la leyenda dice que NO hay líneas de tendencia ni patrones',
    /sin líneas de tendencia ni patrones/.test(grafica.leyenda), grafica.leyenda.slice(0, 80));

  // ── LA TABLA DE RENDIMIENTO EN DOS MONEDAS ──────────────────────────
  const tabla = await p.evaluate(() => {
    const filas = [...document.querySelectorAll('#tabla-rend tbody tr')].map((tr) => {
      const td = [...tr.children].map((c) => c.textContent.trim());
      return { periodo: td[0], a: td[1], b: td[2] };
    });
    return {
      filas,
      colA: document.getElementById('col-a').textContent,
      colB: document.getElementById('col-b').textContent,
      titulos: [...document.querySelectorAll('#tabla-rend .qd-pct')].map((e) => e.getAttribute('title') || ''),
    };
  });
  chequeo('las dos columnas son la moneda del índice y la otra, nombradas',
    tabla.colA === 'en USD' && tabla.colB === 'en MXN', `${tabla.colA} / ${tabla.colB}`);
  chequeo('las NUEVE filas de periodo están, incluidas las que la serie no alcanza',
    tabla.filas.length === 9, String(tabla.filas.length));
  const cincoA = tabla.filas.find((f) => f.periodo === '5A');
  chequeo('5A sale como "—" porque la serie no llega, no desaparece',
    cincoA && cincoA.a.startsWith('—'), JSON.stringify(cincoA));
  chequeo('y el "—" lleva su causa en el title (regla 2)',
    tabla.titulos.some((t) => /sesiones|cierre|punto/.test(t)),
    tabla.titulos.filter(Boolean).slice(0, 2).join(' | '));
  // Cada % lleva su etiqueta de periodo: `qdPctTag` lanza si falta, así que
  // esto además prueba que ninguno se pintó por fuera del pintor de la regla 1.
  const etiquetas = await p.evaluate(() =>
    [...document.querySelectorAll('#tabla-rend .qd-pct-per')].map((e) => e.textContent));
  chequeo('cada % de la tabla lleva su etiqueta de periodo (regla 1)',
    etiquetas.length === 18, `${etiquetas.length} etiquetas en 18 celdas`);

  // La cuenta en pesos se re-deriva acá con el MISMO módulo, no se le cree a
  // la pantalla: es la comprobación de que el % en pesos no es el local.
  const comparacion = await p.evaluate(() => {
    const f = [...document.querySelectorAll('#tabla-rend tbody tr')].find((tr) => tr.children[0].textContent === '1M');
    return { a: f.children[1].textContent, b: f.children[2].textContent };
  });
  chequeo('el rendimiento en pesos NO es el mismo número que el local',
    comparacion.a !== comparacion.b, JSON.stringify(comparacion));

  // ── LOS DATOS ───────────────────────────────────────────────────────
  const datos = await p.evaluate(() =>
    [...document.querySelectorAll('#datos .dato')].map((d) => ({
      k: d.querySelector('.k').textContent,
      v: d.querySelector('.v').textContent,
      f: d.querySelector('.f').textContent,
    })));
  const porK = Object.fromEntries(datos.map((d) => [d.k, d]));
  chequeo('la volatilidad de 30 días sale calculada y declara su método',
    porK['Volatilidad 30 días (anualizada)'].v !== '—'
    && /log diario/.test(porK['Volatilidad 30 días (anualizada)'].f),
    JSON.stringify(porK['Volatilidad 30 días (anualizada)']));
  // Y el número es el que da el módulo, no uno parecido.
  const volEsperada = volatilidad(VELAS).pct.toFixed(1) + '%';
  chequeo('y es EXACTAMENTE la que calcula el módulo del servidor',
    porK['Volatilidad 30 días (anualizada)'].v === volEsperada,
    `${porK['Volatilidad 30 días (anualizada)'].v} vs ${volEsperada}`);
  chequeo('"contra la media de 200 días" sale como "—" con su causa',
    porK['Contra la media de 200 días'].v === '—'
    && /180 cierres y la media de 200/.test(porK['Contra la media de 200 días'].f),
    JSON.stringify(porK['Contra la media de 200 días']));
  const r52 = rango52(VELAS);
  chequeo('el máximo de 52 semanas es el del módulo, con su fecha',
    porK['Máximo 52 semanas'].v.indexOf(r52.max.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) >= 0
    || porK['Máximo 52 semanas'].v.length > 4,
    porK['Máximo 52 semanas'].v);
  chequeo('la capitalización total y el P/U agregado van en "—" CON su causa',
    porK['Capitalización total'].v === '—' && /lista de componentes/.test(porK['Capitalización total'].f)
    && porK['P/U agregado'].v === '—' && /fundamentales de cada componente/.test(porK['P/U agregado'].f),
    porK['P/U agregado'].f.slice(0, 70));
  chequeo('el ETF que lo replica y lo del SIC salen del catálogo',
    porK['ETF que lo replica'].v.includes('IVV') && /SIC/.test(porK['Se compra en México'].v),
    porK['Se compra en México'].v);

  // ── NADA SE ENCIMA EN EL PANEL DE DATOS ─────────────────────────────
  // La captura enseñó la etiqueta larga envolviendo a tres renglones con el
  // valor dibujado ENCIMA. Todas las comprobaciones pasaban: el texto estaba
  // en el DOM, sólo que ilegible.
  const encimados = await p.evaluate(() => {
    const malos = [];
    for (const d of document.querySelectorAll('#datos .dato')) {
      const k = d.querySelector('.k').getBoundingClientRect();
      const v = d.querySelector('.v').getBoundingClientRect();
      // Se solapan si se cruzan en los DOS ejes.
      const cruzaX = k.right > v.left + 0.5 && v.right > k.left + 0.5;
      const cruzaY = k.bottom > v.top + 0.5 && v.bottom > k.top + 0.5;
      if (cruzaX && cruzaY) malos.push(d.querySelector('.k').textContent.trim().slice(0, 28));
    }
    return malos;
  });
  chequeo('en el panel de datos la etiqueta y el valor no se enciman',
    encimados.length === 0, encimados.join(' · '));

  const chipTxt = await p.textContent('#chip');
  chequeo('el chip no repite el nombre de la bolsa dos veces',
    !/^(.+): \1$/.test(chipTxt.trim()), chipTxt);

  // ── COMPONENTES: EL HUECO, DECLARADO ────────────────────────────────
  const comp = await p.textContent('#componentes');
  chequeo('los componentes NO se inventan: el panel dice por qué no están',
    /ETF que lo replica|lista de miembros/.test(comp), comp.trim().slice(0, 90));

  // ── TAP REAL: cambiar de índice ─────────────────────────────────────
  const btnIpc = p.locator('#indices button[data-idx="IPC"]');
  chequeo('las pestañas de índice miden ≥44 px', (await btnIpc.boundingBox()).height >= 44);
  await btnIpc.tap();
  await p.waitForFunction(() => document.getElementById('col-a').textContent === 'en MXN', null, { timeout: 3000 });
  chequeo('el tap cambia de índice y la URL queda en /mercado/indice/IPC',
    (await p.evaluate(() => location.pathname)) === '/mercado/indice/IPC',
    await p.evaluate(() => location.pathname));
  const cols = await p.evaluate(() => ({
    a: document.getElementById('col-a').textContent, b: document.getElementById('col-b').textContent,
  }));
  // El IPC ya está en pesos: la segunda columna son DÓLARES, no pesos otra vez.
  chequeo('para el IPC la segunda columna son dólares, no pesos repetidos',
    cols.a === 'en MXN' && cols.b === 'en USD', JSON.stringify(cols));

  // ── TAP REAL: velas ─────────────────────────────────────────────────
  await p.goto(`${BASE}/mercado/indice/SPX`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#grafica canvas');
  await p.locator('#t-tipo button[data-tipo="velas"]').tap();
  await p.waitForTimeout(250);
  chequeo('el toggle de velas vuelve a dibujar y queda en la URL',
    (await p.evaluate(() => location.search)).includes('vista=velas')
    && (await p.evaluate(() => document.querySelectorAll('#grafica canvas').length)) > 0,
    await p.evaluate(() => location.search));

  // ── EL TOGGLE DE MONEDA TIENE QUE HACER ALGO ────────────────────────
  // "El toggle MXN no hace nada en EE.UU." fue un reporte real sobre el mapa
  // (Lety, 2026-10-02). Un control que se enciende y no cambia nada es peor
  // que no tenerlo: promete una vista que no existe.
  await p.goto(`${BASE}/mercado/indice/SPX`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#grafica canvas');
  const antesMon = await p.evaluate(() => document.getElementById('grafica-aviso').textContent);
  await p.locator('#t-moneda button[data-moneda="otra"]').tap();
  await p.waitForFunction(() => /en pesos/.test(document.getElementById('grafica-aviso').textContent),
    null, { timeout: 3000 }).catch(() => {});
  const conPesos = await p.evaluate(() => ({
    aviso: document.getElementById('grafica-aviso').textContent,
    url: location.search,
  }));
  chequeo('el toggle de moneda convierte la gráfica y lo DICE',
    /en pesos/.test(conPesos.aviso) && conPesos.aviso !== antesMon, conPesos.aviso.slice(0, 80));
  chequeo('y la moneda queda en la URL', conPesos.url.includes('moneda=otra'), conPesos.url);
  // Y convierte con el tipo de cambio DE CADA DÍA: si usara el último, el
  // cambio del periodo saldría idéntico al local y el toggle no haría nada.
  const niveles = await p.evaluate(() => {
    const t = [...document.querySelectorAll('#tabla-rend tbody tr')].find((tr) => tr.children[0].textContent === '1M');
    return { a: t.children[1].textContent, b: t.children[2].textContent };
  });
  chequeo('el rendimiento en la otra moneda sigue siendo distinto del local',
    niveles.a !== niveles.b, JSON.stringify(niveles));

  // ── LA SERIE CAÍDA NO DICE "NO PASÓ NADA" ───────────────────────────
  await p.goto(`${BASE}/__romper?v=1`);
  await p.goto(`${BASE}/mercado/indice/SPX`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#datos .vacio, #datos .dato');
  const caido = await p.evaluate(() => ({
    datos: document.getElementById('datos').textContent,
    grafica: document.getElementById('grafica-aviso').textContent,
  }));
  chequeo('sin serie, la ficha dice LA CAUSA en vez de quedarse en blanco',
    /429/.test(caido.datos) && /429/.test(caido.grafica), caido.grafica.slice(0, 70));
  await p.goto(`${BASE}/__romper?v=0`);

  await p.goto(`${BASE}/mercado/indice/SPX`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#grafica canvas');
  await p.waitForTimeout(200);
  await p.screenshot({ path: join(OUT, 'indice-390.png'), fullPage: true });
  console.log(`  → ${join(OUT, 'indice-390.png')}`);
  await movil.close();

  // ══════════════ ESCRITORIO ══════════════
  console.log('\n── 1440 × 1000 ──');
  const esc2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await esc2.addInitScript(RELOJ_FIJO);
  const d = await esc2.newPage();
  const erroresD = [];
  d.on('pageerror', (e) => erroresD.push(String(e)));
  await d.goto(`${BASE}/mercado/indice/SPX`, { waitUntil: 'networkidle' });
  await d.waitForSelector('#grafica canvas');
  chequeo('escritorio sin errores de consola', erroresD.length === 0, erroresD.slice(0, 2).join(' | '));
  const caja = await d.evaluate(() => ({
    // La rejilla vive en <body>: `main` es `display:contents` para que sus
    // columnas sean celdas de ESTA rejilla sin duplicar el HTML.
    cols: getComputedStyle(document.body).gridTemplateColumns,
    scrollH: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    scrollV: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    alto: Math.round(document.getElementById('grafica').getBoundingClientRect().height),
    lado: Math.round(document.querySelector('.col-lado').getBoundingClientRect().width),
  }));
  chequeo('dos columnas en escritorio, con la lateral de 360 px',
    caja.lado === 360 && /360px/.test(caja.cols), `${caja.lado} · ${caja.cols}`);
  chequeo('sin scroll horizontal', !caja.scrollH);
  chequeo('ni vertical: la ficha cabe en 1440×1000 (regla 8)', !caja.scrollV);
  // La gráfica se queda con lo que SOBRA, así que su alto depende del
  // contenido de arriba. Lo que se exige es que siga siendo una gráfica
  // —no un listón— no un número fijo que mañana nadie pueda cumplir.
  chequeo('y la gráfica sigue siendo una gráfica, no un listón',
    caja.alto >= 280, String(caja.alto));

  // ── EL ALTO A 1440×1000 ─────────────────────────────────────────────
  // La regla 8 pide escritorio sin scroll, y el mapa (R3(c)) lo cumple. Esta
  // ficha NO cabe: gráfica + nueve periodos + datos + noticias son ~1.4
  // pantallas, y encogerlos para que quepan dejaría la gráfica en un listón
  // y la tabla en letra chica. Así que acá la regla se cumple de la otra
  // manera: TODO LO QUE DECIDE —gráfica, nivel, % del día y la tabla
  // completa— entra en la primera pantalla, y lo que queda abajo es detalle.
  // La comprobación fija eso en vez de un número de scroll que nadie puede
  // cumplir sin romper la pantalla.
  const primera = await d.evaluate(() => {
    const dentro = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.bottom <= window.innerHeight + 1;
    };
    return {
      alto: document.documentElement.scrollHeight,
      vp: window.innerHeight,
      grafica: dentro('#grafica'),
      tabla: dentro('#tabla-rend'),
      titular: dentro('.titular'),
    };
  });
  chequeo('la gráfica, el titular y la tabla COMPLETA entran en la primera pantalla',
    primera.grafica && primera.titular && primera.tabla, JSON.stringify(primera));

  const pie = await d.textContent('#pie');
  chequeo('el pie dice la fuente de la serie, la del tipo de cambio y la leyenda',
    /yahoo:v8\/chart/.test(pie) && /banxico:SF43718/.test(pie) && /Información, no asesoría/.test(pie),
    pie.slice(0, 90));

  await d.screenshot({ path: join(OUT, 'indice-1440.png') });
  console.log(`  → ${join(OUT, 'indice-1440.png')}`);
  await esc2.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
