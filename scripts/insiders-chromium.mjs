// ═══════════════════════════════════════════════════════════════════
// scripts/insiders-chromium.mjs — /mercado/insiders en un Chromium real.
//
// El cierre de R5 (regla 10): 390 px con TAP REAL y escritorio, con captura.
//
// EL FIXTURE SALE DEL PARSER DE VERDAD: se le da el Form 4 de
// `tests/fixtures/form4.mjs` a `form4Completo` + `filasDeForm4`, que es
// exactamente lo que hace el endpoint. Así la pantalla se prueba contra las
// filas que va a recibir, no contra un JSON escrito a mano que podría no
// parecerse a la realidad.
//
// Lo que el fixture obliga a ver:
//   · una venta con "le quedan" = 0 → "vendió todo", la afirmación más
//     fuerte de la pantalla;
//   · una retención de impuestos SIN tenencia posterior → "—" con causa,
//     NUNCA cero;
//   · un otorgamiento sin precio → valor "—" con causa, y fuera del neto;
//   · el chip "Venta propuesta" deshabilitado con su motivo (Form 144).
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
const { form4Completo, filasDeForm4, topDeLaSemana } = await import(join(ROOT, 'api/_lib/form4.js'));
const { FORM4_COMPLETO, FORM4_CON_NAMESPACE } = await import(join(ROOT, 'tests/fixtures/form4.mjs'));

const MOMENTO = Date.parse('2026-10-20T16:30:00Z');

const FILAS = [
  ...filasDeForm4(form4Completo(FORM4_COMPLETO), {
    accession: '0000320193-26-000111', updated: '2026-10-16T18:04:00-04:00',
    link: 'https://www.sec.gov/Archives/edgar/data/320193/x.html' }),
  ...filasDeForm4(form4Completo(FORM4_CON_NAMESPACE), {
    accession: '0000000111-26-000222', updated: '2026-10-19T09:30:00-04:00',
    link: 'https://www.sec.gov/Archives/edgar/data/111/y.html' }),
];
// Una compra grande, para que "compras destacadas" tenga qué mostrar.
FILAS.push({
  ...FILAS[0], id: 'grande#0', accession: '0000999-26-000333', ticker: 'BIGC',
  emisora: 'Big Corp', quien: 'Garza Luis', cargo: 'Chief Executive Officer',
  codigo: 'P', tipo: 'compra', nombre: 'Compra en mercado abierto',
  acciones: 20000, precio: 40, valor: 800000, le_quedan: 120000, le_quedan_motivo: null,
  salio_del_todo: false, fecha: '2026-10-17', filing_en: '2026-10-18T10:00:00-04:00',
  filing_fecha: '2026-10-18', firmantes: 1, es_duenio_10: false, plan_10b5: false,
});

const FONDOS = {
  cat: '13f',
  funds: [{ name: 'Fondo Ejemplo LP', cik: '0001', quarterEnd: '2026-09-30', totalValue: 4.2e9,
            counts: { added: 7, closed: 3, increased: 12, reduced: 9 },
            top: { added: [{ ticker: 'NVDA', value: 2e8 }, { ticker: 'MSFT', value: 1e8 }],
                   closed: [{ ticker: 'INTC', value: 5e7 }], increased: [], reduced: [] } }],
  lag_note: 'SEC 13F: foto al cierre del trimestre, publicada hasta 45 días después — no es el portafolio de hoy',
  sources: { edgar: { ok: true } },
  generated_at: new Date(MOMENTO).toISOString(),
};

let caido = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidos = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__romper') { caido = url.searchParams.get('v') === '1'; res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/stock-tracker') {
    pedidos++;
    res.writeHead(200, { 'content-type': 'application/json' });
    const cat = url.searchParams.get('cat');
    if (cat === '13f') return res.end(JSON.stringify(FONDOS));
    if (caido) {
      return res.end(JSON.stringify({
        cat: 'form4', items: [],
        sources: { edgar_form4_atom: { ok: false, error: 'HTTP 403' } },
        generated_at: new Date(MOMENTO).toISOString(),
      }));
    }
    return res.end(JSON.stringify({
      cat: 'form4', items: FILAS,
      scan: { atom_entries: 200, inspected: 40, xml_fetched: 38, accumulated: 3 },
      sources: { edgar_form4_atom: { ok: true, items: 200 } },
      cobertura: 'la ventana del feed `getcurrent` de EDGAR más lo que la instancia acumuló; un arranque en frío sólo ve la ventana',
      lag_note: 'SEC Form 4: reportado máx. 2 días hábiles después de la operación',
      generated_at: new Date(MOMENTO).toISOString(),
    }));
  }
  const p = url.pathname === '/mercado/insiders' ? '/insiders.html' : url.pathname;
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

  await p.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#contenido table tbody tr');

  chequeo('la pantalla carga sin errores de consola', errores.length === 0, errores.slice(0, 2).join(' | '));
  chequeo('sin scroll horizontal de página a 390 px',
    !(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));

  // ── EL DEFAULT ES "TODAS" ───────────────────────────────────────────
  const filas = await p.evaluate(() => [...document.querySelectorAll('#contenido tbody tr')].map((tr) => ({
    clase: tr.className,
    celdas: [...tr.children].map((td) => td.textContent.trim()),
    titulos: [...tr.children].map((td) => td.getAttribute('title') || ''),
  })));
  chequeo('el default son TODAS las transacciones, no sólo las compras',
    filas.length === FILAS.length, `${filas.length} de ${FILAS.length}`);
  const tipos = new Set(filas.map((f) => f.clase));
  chequeo('y se ven varios tipos a la vez (compra, venta, opción, impuesto…)',
    tipos.size >= 4, [...tipos].join(','));

  // ── "LE QUEDAN" ─────────────────────────────────────────────────────
  const conCero = filas.find((f) => f.celdas[8].startsWith('0 ·'));
  chequeo('la venta que dejó la tenencia en CERO se marca "vendió todo"',
    !!conCero && /todo/.test(conCero.celdas[8]), conCero ? conCero.celdas[8] : 'no está');
  const sinDato = filas.find((f) => f.celdas[4].startsWith('F ·'));
  chequeo('la que NO declaró tenencia posterior va "—" con su causa, nunca cero',
    sinDato && sinDato.celdas[8] === '—' && /no declaró la tenencia posterior/.test(sinDato.titulos[8]),
    sinDato ? `${sinDato.celdas[8]} · ${sinDato.titulos[8]}` : 'no está');

  // ── EL VALOR ────────────────────────────────────────────────────────
  const otorg = filas.find((f) => f.celdas[4].startsWith('A ·'));
  chequeo('el otorgamiento sin precio va "—" con su causa, no en cero',
    otorg && otorg.celdas[7] === '—' && /no declaró precio/.test(otorg.titulos[7]),
    otorg ? `${otorg.celdas[7]} · ${otorg.titulos[7]}` : 'no está');

  // ── LOS CHIPS ───────────────────────────────────────────────────────
  const chips = await p.evaluate(() => [...document.querySelectorAll('#chips button')].map((b) => ({
    id: b.dataset.chip, off: b.disabled, txt: b.textContent.trim(), titulo: b.getAttribute('title') || '',
    alto: Math.round(b.getBoundingClientRect().height),
  })));
  chequeo('los cinco chips del artboard están', chips.length === 5, chips.map((c) => c.id).join(','));
  const vp = chips.find((c) => c.id === 'venta_propuesta');
  chequeo('"Venta propuesta" va deshabilitada y dice que es un Form 144',
    vp.off && /pronto/.test(vp.txt) && /Form 144/.test(vp.titulo), vp.titulo);
  chequeo('y los chips se pueden tocar (≥34 px)',
    chips.every((c) => c.alto >= 34), JSON.stringify(chips.map((c) => c.alto)));

  await p.locator('#chips button[data-chip="compra"]').tap();
  await p.waitForFunction(() => location.search.includes('chips=compra'), null, { timeout: 2000 });
  const soloCompras = await p.evaluate(() =>
    [...document.querySelectorAll('#contenido tbody tr')].map((tr) => tr.className));
  chequeo('el chip de compras deja sólo compras',
    soloCompras.length > 0 && soloCompras.every((c) => c === 'compra'), JSON.stringify(soloCompras));
  await p.locator('#chips button[data-chip="compra"]').tap();
  await p.waitForFunction(() => !location.search.includes('chips='), null, { timeout: 2000 });

  // ── LAS VISTAS ──────────────────────────────────────────────────────
  await p.locator('#barra-vistas button[data-vista="semana"]').tap();
  await p.waitForFunction(() => /Top de la semana/.test(document.getElementById('titulo-tabla').textContent),
    null, { timeout: 2000 });
  const top = await p.evaluate(() => [...document.querySelectorAll('#contenido tbody tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent.trim())));
  chequeo('el Top de la semana agrupa por emisora con su neto', top.length >= 2, `${top.length} emisoras`);
  // El neto se re-deriva con el MISMO módulo: no se le cree a la pantalla.
  const esperado = topDeLaSemana(FILAS).grupos[0];
  chequeo('y el neto de la primera es el que calcula el módulo',
    top[0][0] === esperado.ticker, `${top[0][0]} vs ${esperado.ticker}`);
  chequeo('la columna "vendió todo" nombra a la persona',
    top.some((t) => /Ruiz Ana/.test(t[6])), JSON.stringify(top.map((t) => t[6])));

  await p.locator('#barra-vistas button[data-vista="destacadas"]').tap();
  await p.waitForFunction(() => /Compras destacadas/.test(document.getElementById('titulo-tabla').textContent),
    null, { timeout: 2000 });
  const dest = await p.evaluate(() => ({
    filas: [...document.querySelectorAll('#contenido tbody tr')].length,
    nota: document.getElementById('nota-tabla').textContent,
  }));
  chequeo('"Compras destacadas" dice su criterio, no lo esconde',
    /100 mil/.test(dest.nota), dest.nota);
  chequeo('y trae sólo la compra que llega al umbral', dest.filas === 1, String(dest.filas));

  await p.locator('#barra-vistas button[data-vista="ultimas"]').tap();
  await p.waitForFunction(() => /Todas las transacciones/.test(document.getElementById('titulo-tabla').textContent),
    null, { timeout: 2000 });

  // ── EL ORDEN ────────────────────────────────────────────────────────
  // LA COMPROBACIÓN TIENE QUE COMPROBAR EL ORDEN. La primera versión sólo
  // miraba que hubiera más de una fila y pasaba sobre una lista DESORDENADA:
  // el fixture devuelve las filas como vienen y la pantalla las pintaba así.
  // La marca completa vive en la propia celda (`data-filing`, y el mismo
  // valor en el `title`, que al lector le sirve porque la hora corta no trae
  // año ni zona). Nada de ganchos de prueba dentro de la página.
  const ordenIso = await p.evaluate(() =>
    [...document.querySelectorAll('#contenido tbody tr')].map((tr) => tr.children[9].dataset.filing || ''));
  const orden = ordenIso;
  chequeo('el orden es por hora de filing, de lo más nuevo a lo más viejo',
    orden.length > 1 && ordenIso && ordenIso.every((v, i, a) => i === 0 || a[i - 1] >= v),
    JSON.stringify((ordenIso || orden).slice(0, 4)));

  // ── LAS PESTAÑAS ────────────────────────────────────────────────────
  const congreso = p.locator('#pestanas button[data-tab="congreso"]');
  chequeo('Congreso va deshabilitada y punteada, con su motivo',
    await congreso.isDisabled() && /pronto/.test(await congreso.textContent()), await congreso.textContent());
  await p.locator('#pestanas button[data-tab="13f"]').tap();
  await p.waitForFunction(() => /Gestores/.test(document.getElementById('titulo-tabla').textContent),
    null, { timeout: 2000 });
  const t13f = await p.textContent('#contenido');
  chequeo('la pestaña de 13F muestra el fondo y su caveat de 45 días',
    /Fondo Ejemplo/.test(t13f) && /45 días/.test(await p.textContent('#nota-tabla')),
    await p.textContent('#nota-tabla'));
  await p.locator('#pestanas button[data-tab="form4"]').tap();
  await p.waitForSelector('#contenido tbody tr');

  // ── EL AVISO DE COBERTURA ───────────────────────────────────────────
  const aviso = await p.textContent('#aviso-cobertura');
  chequeo('la cobertura se declara: lo que no está puede no haberse cosechado',
    /no haberse cosechado/.test(aviso), aviso.slice(0, 80));

  // ── LA FUENTE CAÍDA ─────────────────────────────────────────────────
  await p.goto(`${BASE}/__romper?v=1`);
  await p.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#contenido .vacio');
  const vacio = await p.textContent('#contenido .vacio');
  chequeo('con la SEC caída se dice el motivo, no "no hubo transacciones"',
    /403/.test(vacio), vacio.slice(0, 80));
  await p.goto(`${BASE}/__romper?v=0`);

  await p.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#contenido tbody tr');
  await p.screenshot({ path: join(OUT, 'insiders-390.png'), fullPage: true });
  console.log(`  → ${join(OUT, 'insiders-390.png')}`);
  await movil.close();

  console.log('\n── 1440 × 1000 ──');
  const esc2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await esc2.addInitScript(RELOJ_FIJO);
  const d = await esc2.newPage();
  const erroresD = [];
  d.on('pageerror', (e) => erroresD.push(String(e)));
  await d.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await d.waitForSelector('#contenido tbody tr');
  chequeo('escritorio sin errores de consola', erroresD.length === 0, erroresD.slice(0, 2).join(' | '));
  const caja = await d.evaluate(() => ({
    cols: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
    scrollH: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    top: document.querySelectorAll('#top-semana .fila-lado').length,
    dest: document.querySelectorAll('#destacadas .fila-lado').length,
    fondos: document.querySelectorAll('#fondos .fila-lado').length,
  }));
  chequeo('dos columnas, con el lateral de 340 px', /340px/.test(caja.cols), caja.cols);
  chequeo('sin scroll horizontal', !caja.scrollH);
  chequeo('el lateral trae el top, las destacadas y el teaser de fondos',
    caja.top > 0 && caja.dest > 0 && caja.fondos > 0, JSON.stringify(caja));

  const pie = await d.textContent('#pie');
  chequeo('el pie nombra la fuente, el lag y de dónde sale "le quedan"',
    /SEC EDGAR/.test(pie) && /2 días hábiles/.test(pie)
    && /sharesOwnedFollowingTransaction/.test(pie) && /Información, no asesoría/.test(pie),
    pie.slice(0, 90));

  await d.screenshot({ path: join(OUT, 'insiders-1440.png') });
  console.log(`  → ${join(OUT, 'insiders-1440.png')}`);
  await esc2.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
