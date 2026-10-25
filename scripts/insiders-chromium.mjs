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
// ── DÓNDE ESTÁ PLAYWRIGHT ───────────────────────────────────────────
// Acá había clavada una ruta absoluta a un scratchpad con el id de UNA
// sesión adentro. O sea que estos arneses corrían en un solo contenedor y
// nada más: en CI, en otra máquina o en una sesión nueva tiraban
// MODULE_NOT_FOUND antes de abrir el navegador. Y de hecho dejaron de
// correr acá mismo cuando ese scratchpad se limpió.
// Ahora se busca por candidatos, con `PW_PATH` ganando por si hace falta
// apuntarlo a mano.
const PW = (() => {
  const candidatos = [
    process.env.PW_PATH,
    'playwright-core',
    '/opt/node-tools/node_modules/playwright-core',
    join(ROOT, 'node_modules/playwright-core'),
  ].filter(Boolean);
  for (const c of candidatos) { try { return require.resolve(c); } catch { /* el siguiente */ } }
  throw new Error('no se encontró playwright-core; poné PW_PATH apuntando a su carpeta');
})();
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
  emisora: 'Big Corp', quien: 'Garza Luis', cargo: 'EVP, CFO & COO',
  codigo: 'P', tipo: 'compra', nombre: 'Compra en mercado abierto',
  acciones: 20000, precio: 40, valor: 800000, le_quedan: 120000, le_quedan_motivo: null,
  salio_del_todo: false, fecha: '2026-10-17', filing_en: '2026-10-18T10:00:00-04:00',
  filing_fecha: '2026-10-18', firmantes: 1, es_duenio_10: false, plan_10b5: false,
});

// ═══════════════════════════════════════════════════════════════════
// LOS FONDOS SALEN DEL ENDPOINT, NO DE MI MANO.
//
// La versión anterior escribía el fondo a mano con `name: 'Fondo Ejemplo
// LP'`. El endpoint devuelve `fund`, no `name`, así que en producción la
// pestaña enseñaba el CIK —1067983— en vez de "Berkshire Hathaway" (Lety,
// 2026-10-20), y la comprobación pasaba igual porque medía mi invento.
//
// Acá se corre `build13F` de verdad, fingiendo a la SEC: submissions, el
// índice del filing y el infoTable, en su forma cruda. Si alguien cambia una
// llave de la fila del fondo, esto lo ve.
// ═══════════════════════════════════════════════════════════════════
const CIK_BERKSHIRE = '1067983';
const ACC = ['0000950123-26-000111', '0000950123-26-000222'];

function infoTable(filas) {
  return '<?xml version="1.0"?><informationTable>' + filas.map((f) => `
    <infoTable><nameOfIssuer>${f.n}</nameOfIssuer><cusip>${f.cusip}</cusip>
      <value>${f.valor}</value>
      <shrsOrPrnAmt><sshPrnamt>${f.acciones}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
    </infoTable>`).join('') + '</informationTable>';
}
// Trimestre actual contra el anterior: una posición nueva, una cerrada, una
// que crece y una que baja. Es lo que el diff tiene que encontrar.
const CARTERA_HOY = [
  { n: 'NVIDIA CORP', cusip: '67066G104', valor: 2_000_000_000, acciones: 10_000_000 },
  { n: 'APPLE INC', cusip: '037833100', valor: 60_000_000_000, acciones: 300_000_000 },
  { n: 'COCA COLA CO', cusip: '191216100', valor: 25_000_000_000, acciones: 400_000_000 },
];
const CARTERA_ANTES = [
  { n: 'APPLE INC', cusip: '037833100', valor: 70_000_000_000, acciones: 400_000_000 },
  { n: 'COCA COLA CO', cusip: '191216100', valor: 24_000_000_000, acciones: 400_000_000 },
  { n: 'INTEL CORP', cusip: '458140100', valor: 1_000_000_000, acciones: 50_000_000 },
];

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (recurso, opciones) => {
  const u = String((recurso && recurso.url) || recurso || '');
  const texto = (t, tipo = 'application/json') => new Response(t, {
    status: 200, headers: { 'content-type': tipo },
  });
  if (u.includes('data.sec.gov/submissions/')) {
    // Sólo Berkshire contesta: los otros cinco fondos quedan con su causa
    // declarada, que es el estado normal de una corrida real.
    if (!u.includes(String(CIK_BERKSHIRE).padStart(10, '0'))) {
      return new Response('no', { status: 404 });
    }
    return texto(JSON.stringify({ filings: { recent: {
      form: ['13F-HR', '8-K', '13F-HR'],
      accessionNumber: [ACC[0], '0000950123-26-000999', ACC[1]],
      reportDate: ['2026-09-30', '2026-10-01', '2026-06-30'],
      filingDate: ['2026-11-14', '2026-10-02', '2026-08-14'],
    } } }));
  }
  if (u.includes('/index.json')) {
    return texto(JSON.stringify({ directory: { item: [
      { name: 'primary_doc.xml', size: '900' },
      { name: 'infotable.xml', size: '120000' },
    ] } }));
  }
  if (/\/infotable\.xml$/.test(u)) {
    const cartera = u.includes(ACC[0].replace(/-/g, '')) ? CARTERA_HOY : CARTERA_ANTES;
    return texto(infoTable(cartera), 'text/xml');
  }
  if (u.includes('openfigi')) return texto(JSON.stringify([{ data: [{ ticker: 'NVDA' }] }]));
  throw new Error('la corrida intentó salir a la red: ' + u);
};

const { default: trackerHandler } = await import(join(ROOT, 'api/stock-tracker.js'));
// LA FRASE DE COBERTURA LA ARMA EL MISMO MÓDULO QUE EN PRODUCCIÓN.
// Antes se leía el literal del endpoint con una expresión regular; ahora el
// texto se CALCULA (depende de los dos números), así que se importa la
// función y se la llama igual que lo hace el servidor. Copiar la frase acá
// fue como el `getcurrent` con comillas de código sobrevivió en pantalla.
const { coberturaDeDia } = await import(join(ROOT, 'api/_lib/edgar-indice.js'));
// Dos modos: el día medido y completo, y el día al que le faltan filings.
let coberturaCompleta = true;
const COBERTURA = () => (coberturaCompleta
  ? coberturaDeDia({ fecha: '2026-10-19', enIndice: 1842, guardados: 1842 })
  : coberturaDeDia({ fecha: '2026-10-19', enIndice: 1842, guardados: 1700 }));
async function fondosDeVerdad() {
  let body = null;
  const res = {
    setHeader() {}, getHeader() {}, status() { return this; },
    json(o) { body = o; return this; }, send(o) { body = o; return this; }, end() { return this; },
  };
  await trackerHandler({ method: 'GET', query: { cat: '13f' }, headers: {}, url: '/' }, res);
  return body;
}
const FONDOS = await fondosDeVerdad();
if (!FONDOS || !(FONDOS.funds || []).length) {
  throw new Error('el endpoint no devolvió fondos: ' + JSON.stringify(FONDOS).slice(0, 200));
}

let caido = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidos = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__romper') { caido = url.searchParams.get('v') === '1'; res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/__cobertura') {
    coberturaCompleta = url.searchParams.get('v') !== '0';
    res.writeHead(200); return res.end('ok');
  }
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
      // La MISMA frase que arma el endpoint, importada en vez de copiada: una
      // copia en el fixture es cómo la jerga sobrevivió a que se arreglara en
      // el endpoint.
      cobertura: COBERTURA().texto,
      cobertura_completa: COBERTURA().completa,
      cobertura_ultimo: COBERTURA(),
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

// ── ¿SE VE DE VERDAD, O SÓLO EXISTE EN EL DOM? ───────────────────────
// El 2026-10-25 esta pantalla pasó en verde con la etiqueta del plan 10b5-1
// fuera de la caja visible: la tabla medía 1778 px dentro de 358 en celular y
// 1837 dentro de 1034 en escritorio, sin barra de desplazamiento — el
// contenedor recortaba y ya. A 390 px sólo quedaba la columna del ticker.
//
// Mis cinco comprobaciones de esa tanda miraban que la etiqueta EXISTIERA y
// qué color tenía. Ninguna miraba dónde caía. Un elemento correcto fuera de
// pantalla pasa en verde, y eso es peor que no tener la comprobación: afirma
// algo que nadie puede ver.
const DENTRO_DE_LA_CAJA = () => {
  const cont = document.querySelector('#contenido');
  const caja = cont.getBoundingClientRect();
  const mide = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return { hay: false };
    const r = e.getBoundingClientRect();
    // ── CONTRA TODO ANCESTRO QUE RECORTE, NO SÓLO CONTRA `#contenido` ──
    // La primera versión comparaba únicamente con el contenedor de afuera, y
    // por eso dio verde con la etiqueta recortada por SU PROPIA CELDA: se
    // leía "programada · plan" y el "10b5-1 desde AAAA-MM-DD" se perdía. El
    // rectángulo de un elemento recortado sigue midiendo lo que mide; quien
    // lo tapa es un ancestro con `overflow` distinto de `visible`.
    let cortado = null;
    for (let a = e.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.right > ar.right + 0.5 || r.left < ar.left - 0.5
        || r.bottom > ar.bottom + 0.5 || r.top < ar.top - 0.5) {
        cortado = a.className || a.tagName;
        break;
      }
    }
    return {
      hay: true,
      x: Math.round(r.x), derecha: Math.round(r.right),
      // Visible de verdad: dentro de la caja que lo contiene, dentro de la
      // ventana, y sin que ningún ancestro lo recorte. Las tres, porque
      // fallan por motivos distintos y cada una me pasó por separado.
      dentro: r.left >= caja.left - 0.5 && r.right <= caja.right + 0.5,
      enPantalla: r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.width > 0,
      cortadoPor: cortado,
    };
  };
  return {
    cajaAncho: Math.round(caja.width),
    tablaAncho: Math.round(document.querySelector('#contenido table').getBoundingClientRect().width),
    plan: mide('.lupa.plan'),
    combo: mide('.lupa.combo'),
    valor: mide('td.c-valor'),
  };
};

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
  // Siete: los cinco del artboard más "Entregó en fusión" y "Retención
  // fiscal", que salieron de Ventas cuando `D` y `F` dejaron de contar como
  // venta de mercado. Se agregan en vez de esconderse.
  chequeo('los siete chips están, y los dos que no son ventas tienen el suyo',
    chips.length === 7 && ['entrega_emisora', 'impuesto'].every((id) => chips.some((c) => c.id === id)),
    chips.map((c) => c.id).join(','));
  const vp = chips.find((c) => c.id === 'venta_propuesta');
  chequeo('"Venta propuesta" va deshabilitada y dice que es un Form 144',
    vp.off && /pronto/.test(vp.txt) && /Form 144/.test(vp.titulo), vp.titulo);
  chequeo('y los chips se pueden tocar (≥34 px)',
    chips.every((c) => c.alto >= 34), JSON.stringify(chips.map((c) => c.alto)));

  // ── LO PROGRAMADO SE VE DISTINTO, Y DICE DESDE CUÁNDO ───────────────
  // Una venta bajo un plan 10b5-1 se fijó con meses de anticipación. En
  // verde o rojo se lee como una decisión de hoy, que es justo lo que no es.
  // Se apaga —NO se esconde— y la etiqueta trae la fecha de adopción.
  const plan = await p.evaluate(() => {
    const trs = [...document.querySelectorAll('#contenido tbody tr')];
    const prog = trs.filter((tr) => tr.classList.contains('programada'));
    return {
      total: trs.length,
      programadas: prog.length,
      etiqueta: prog.length ? (prog[0].querySelector('.lupa.plan') || {}).textContent || '' : '',
      titulo: prog.length ? (prog[0].querySelector('.lupa.plan') || {}).title || '' : '',
      // Apagada: el fondo de una fila programada NO puede ser el verde ni el
      // rojo del tipo.
      fondo: prog.length ? getComputedStyle(prog[0].querySelector('td')).backgroundColor : null,
      fondoVenta: (() => { const v = trs.find((tr) => tr.classList.contains('venta') && !tr.classList.contains('programada'));
        return v ? getComputedStyle(v.querySelector('td')).backgroundColor : null; })(),
      combo: trs.some((tr) => (tr.textContent || '').includes('ejerció y vendió')),
      sinDato: trs.some((tr) => (tr.textContent || '').includes('plan: sin dato')),
    };
  });
  chequeo('las filas con plan 10b5-1 van marcadas', plan.programadas > 0, JSON.stringify(plan).slice(0, 160));
  // La fecha de adopción sale de la NOTA al pie, y este fixture sólo trae la
  // casilla del encabezado — así que acá la etiqueta va sin fecha, y eso es
  // correcto: inventarla sería peor. Lo que se exige es que no quede un
  // "desde" colgado sin nada detrás, y que CUANDO haya fecha, se pinte.
  // El caso con fecha lo cubre `tests/insiders-10b51-snow.test.mjs` contra el
  // Form 4 real de Slootman, que sí trae la nota (adoptado 2025-09-19).
  chequeo('la etiqueta es exacta, con fecha o sin ella, y nunca con un "desde" vacío',
    /^programada · plan 10b5-1( desde \d{4}-\d{2}-\d{2})?$/.test(plan.etiqueta.trim()),
    plan.etiqueta);
  chequeo('el título explica que la fecha se fijó con anticipación',
    /no es una decisión de hoy/.test(plan.titulo), plan.titulo.slice(0, 90));
  chequeo('su fondo está APAGADO, no en el color del tipo',
    plan.fondo !== plan.fondoVenta, `${plan.fondo} vs ${plan.fondoVenta}`);
  // `sin_dato` NO se pinta como programada: callar no es negar, y tampoco
  // afirmar. Si apareciera en gris, estaríamos diciendo que consta.
  chequeo('"sin dato" no se disfraza de programada',
    !/sin dato/.test(plan.etiqueta), plan.etiqueta);

  // ── Y QUE SE VEA, NO SÓLO QUE EXISTA (390) ──────────────────────────
  const visible390 = await p.evaluate(DENTRO_DE_LA_CAJA);
  chequeo('celular: la tabla NO es más ancha que su caja (nada de scroll horizontal)',
    visible390.tablaAncho <= visible390.cajaAncho + 1,
    `tabla ${visible390.tablaAncho} vs caja ${visible390.cajaAncho}`);
  chequeo('celular: la etiqueta del plan cae DENTRO de la caja, en pantalla y SIN recortar',
    visible390.plan.hay && visible390.plan.dentro && visible390.plan.enPantalla
      && !visible390.plan.cortadoPor,
    JSON.stringify(visible390.plan));
  chequeo('celular: y el "cuánto" también — una tarjeta sin monto no informa',
    visible390.valor.hay && visible390.valor.dentro, JSON.stringify(visible390.valor));

  // ── LA TARJETA SE ABRE AL TOCARLA ───────────────────────────────────
  const tarjeta = await p.evaluate(() => {
    const tr = document.querySelector('#contenido tbody tr');
    const vis = (sel) => { const e = tr.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; };
    return { alto: Math.round(tr.getBoundingClientRect().height),
      cargoAntes: vis('td.c-cargo'), precioAntes: vis('td.c-precio') };
  });
  chequeo('celular: la tarjeta mide lo que mide un dedo', tarjeta.alto >= 44, String(tarjeta.alto));
  chequeo('celular: el detalle empieza CERRADO',
    !tarjeta.cargoAntes && !tarjeta.precioAntes, JSON.stringify(tarjeta));
  await p.locator('#contenido tbody tr').first().tap();
  const abierta = await p.evaluate(() => {
    const tr = document.querySelector('#contenido tbody tr');
    const vis = (sel) => { const e = tr.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; };
    const cont = document.querySelector('#contenido').getBoundingClientRect();
    const dentro = (sel) => { const e = tr.querySelector(sel); if (!e) return false;
      const r = e.getBoundingClientRect(); return r.left >= cont.left - 0.5 && r.right <= cont.right + 0.5; };
    return { abierta: tr.classList.contains('abierta'),
      cargo: vis('td.c-cargo'), precio: vis('td.c-precio'), acciones: vis('td.c-acciones'),
      quedan: vis('td.c-quedan'), filing: vis('td.c-filing'),
      todosDentro: ['td.c-cargo', 'td.c-precio', 'td.c-acciones', 'td.c-quedan', 'td.c-filing'].every(dentro) };
  });
  chequeo('celular: al tocarla se abren los cinco que faltaban',
    abierta.abierta && abierta.cargo && abierta.precio && abierta.acciones && abierta.quedan && abierta.filing,
    JSON.stringify(abierta));
  chequeo('celular: y el detalle también cae dentro de la caja',
    abierta.todosDentro, JSON.stringify(abierta));
  await p.locator('#contenido tbody tr').first().tap();
  chequeo('celular: y se vuelve a cerrar',
    !(await p.evaluate(() => document.querySelector('#contenido tbody tr').classList.contains('abierta'))));

  await p.locator('#chips button[data-chip="compra"]').tap();
  await p.waitForFunction(() => location.search.includes('chips=compra'), null, { timeout: 2000 });
  // La clase de la fila lleva el TIPO y, desde el 10b5-1, además `programada`
  // cuando consta que salió de un plan. Comparar el `className` entero hacía
  // que agregar una clase visual rompiera una comprobación sobre el FILTRO,
  // que es otra cosa. Se mira el tipo, que es lo que el chip filtra.
  const soloCompras = await p.evaluate(() =>
    [...document.querySelectorAll('#contenido tbody tr')].map((tr) =>
      ['compra', 'venta', 'opcion', 'impuesto', 'entrega_emisora', 'otorgado', 'regalo', 'otro']
        .find((t) => tr.classList.contains(t)) || tr.className));
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
  // ── "VENDIÓ TODO" YA NO SALE DE UNA LÍNEA EN CERO ──────────────────
  // Esto exigía ver a "Ruiz Ana" porque UNA de sus líneas dejaba esa tenencia
  // en cero. `sharesOwnedFollowingTransaction` es por TENENCIA, no por
  // persona: con esa regla, alguien que vacía un fideicomiso y sigue con
  // acciones en otros cuatro y con millones en opciones salía "vendió todo".
  // Es lo que Lety vio en ATKR, y lo que el Form 4 real de Slootman confirma:
  // le quedan 19.024 acciones y 3.836.655 opciones (2026-10-23).
  //
  // El fixture de este arnés deja tenencia después, así que la columna tiene
  // que estar VACÍA. Que esté vacía es el resultado correcto, y por eso se
  // comprueba contra el módulo en vez de contra un texto: si mañana el
  // fixture cambia y alguien sí se sale del todo, los dos lados se mueven
  // juntos.
  const vendioTodoEsperado = topDeLaSemana(FILAS).grupos.flatMap((g) => g.vendio_todo);
  chequeo('la columna "vendió todo" dice lo mismo que el módulo',
    vendioTodoEsperado.every((q) => top.some((t) => t[6].includes(q)))
      && (vendioTodoEsperado.length > 0 || top.every((t) => t[6] === '—')),
    `módulo: ${JSON.stringify(vendioTodoEsperado)} · pantalla: ${JSON.stringify(top.map((t) => t[6]))}`);

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
    /Berkshire Hathaway/.test(t13f) && /45 días/.test(await p.textContent('#nota-tabla')),
    await p.textContent('#nota-tabla'));
  // EL NOMBRE, NO EL CIK. Es lo que se vio en producción: 1067983 donde
  // debía decir Berkshire Hathaway, porque la página leía `name` y el
  // endpoint manda `fund`.
  chequeo('y lo nombra por su NOMBRE, no por su CIK',
    !/\b1067983\b/.test(t13f) && /Warren Buffett/.test(t13f),
    t13f.replace(/\s+/g, ' ').slice(0, 90));
  const fondoLateral = await p.textContent('#fondos');
  chequeo('y en el lateral también va el nombre',
    /Berkshire/.test(fondoLateral) && !/\b1067983\b/.test(fondoLateral),
    fondoLateral.replace(/\s+/g, ' ').slice(0, 80));
  await p.locator('#pestanas button[data-tab="form4"]').tap();
  await p.waitForSelector('#contenido tbody tr');

  // ── EL AVISO DE COBERTURA ───────────────────────────────────────────
  // ── LO QUE SE VE EN PANTALLA VA SIN JERGA ───────────────────────────
  // Es la pantalla donde Lety lo vio: el aviso de cobertura decía
  // `getcurrent` entre comillas de código. Las fuentes declaradas sí se ven
  // —es la procedencia que pide la regla 3—; lo que no, es el nombre interno
  // de un endpoint, de un campo o de un archivo.
  const jerga = await p.evaluate(() => {
    const malas = [];
    const PROHIBIDO = [
      [/`/, 'comillas de código'],
      [/\.(js|json|mjs)\b/, 'nombre de archivo'],
      [/api\/_lib/, 'ruta del repo'],
      [/getcurrent|companyfacts|quoteSummary|metric=all|cik_str|infotable|sharesOwnedFollowing/i,
       'nombre interno de un endpoint o campo'],
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
    for (const el of document.querySelectorAll('[title]')) {
      const t = el.getAttribute('title') || '';
      for (const [re, por] of PROHIBIDO) if (re.test(t)) malas.push('en un title · ' + por + ': ' + t.slice(0, 70));
    }
    return malas;
  });
  chequeo('nada de lo que se ve en pantalla trae jerga de código',
    jerga.length === 0, JSON.stringify(jerga.slice(0, 3)));

  // ── LA COBERTURA, CON SUS DOS NÚMEROS ───────────────────────────────
  // Lety, 2026-10-22: *"Prueba de cobertura: para un día cerrado, el conteo
  // de Form 4 que guardamos debe ser igual al número de líneas Form 4 del
  // índice de ese día. Muéstralo en la pantalla."*
  const cob = await p.evaluate(() => {
    const el = document.getElementById('aviso-cobertura');
    return el ? { texto: el.textContent, clase: el.className, title: el.getAttribute('title') } : null;
  });
  chequeo('la cobertura completa se dice con sus DOS números',
    cob && /100% de los Form 4 del día \(1842 de 1842\)/.test(cob.texto), cob ? cob.texto : 'no está');
  chequeo('y ya NO pide disculpas por el arranque en frío',
    cob && !/puede no haberse cosechado|arranque en frío|ventana/.test(cob.texto), cob ? cob.texto : 'no está');
  chequeo('completa no se pinta como un aviso: es un dato medido',
    cob && cob.clase === 'cobertura-ok', cob ? cob.clase : 'no está');
  chequeo('y dice contra qué índice se midió',
    cob && /índice diario de EDGAR del 2026-10-19/.test(cob.title || ''), cob ? cob.title : 'sin title');

  // Y cuando NO cuadra, lo dice CON EL NÚMERO de los que faltan.
  await p.goto(`${BASE}/__cobertura?v=0`);
  await p.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#aviso-cobertura');
  const cobFalta = await p.evaluate(() => {
    const el = document.getElementById('aviso-cobertura');
    return { texto: el.textContent, clase: el.className };
  });
  chequeo('si NO cuadra, lo dice con el número de los que faltan',
    /1700 de 1842/.test(cobFalta.texto) && /faltan 142/.test(cobFalta.texto), cobFalta.texto);
  chequeo('y ahí sí vuelve a ser un aviso',
    cobFalta.clase === 'aviso', cobFalta.clase);
  await p.goto(`${BASE}/__cobertura?v=1`);
  await p.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#contenido tbody tr, #contenido .vacio');


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

  // ── LAS DIEZ COLUMNAS, Y QUE SE VEAN (1440) ─────────────────────────
  const visible1440 = await d.evaluate(DENTRO_DE_LA_CAJA);
  chequeo('escritorio: la tabla cabe en su caja',
    visible1440.tablaAncho <= visible1440.cajaAncho + 1,
    `tabla ${visible1440.tablaAncho} vs caja ${visible1440.cajaAncho}`);
  chequeo('escritorio: la etiqueta del plan cae DENTRO de la caja, en pantalla y SIN recortar',
    visible1440.plan.hay && visible1440.plan.dentro && visible1440.plan.enPantalla
      && !visible1440.plan.cortadoPor,
    JSON.stringify(visible1440.plan));
  // El recorte de "Quién" y "Cargo" es lo que hizo que las diez entraran: se
  // exige que recorten de verdad y que el nombre completo siga disponible.
  const recorte = await d.evaluate(() => {
    const td = document.querySelector('td.c-quien');
    const cs = getComputedStyle(td);
    return { ellipsis: cs.textOverflow, nowrap: cs.whiteSpace, title: td.getAttribute('title') || '',
      columnas: document.querySelectorAll('#contenido thead th').length };
  });
  chequeo('escritorio: están las diez columnas', recorte.columnas === 10, String(recorte.columnas));
  chequeo('escritorio: "Quién" se recorta con … y guarda el nombre entero',
    recorte.ellipsis === 'ellipsis' && recorte.nowrap === 'nowrap' && recorte.title.length > 0,
    JSON.stringify(recorte));
  chequeo('el lateral trae el top, las destacadas y el teaser de fondos',
    caja.top > 0 && caja.dest > 0 && caja.fondos > 0, JSON.stringify(caja));

  const pie = await d.textContent('#pie');
  chequeo('el pie nombra la fuente, el lag y de dónde sale "le quedan"',
    /SEC EDGAR/.test(pie) && /2 días hábiles/.test(pie)
    // La procedencia tiene que estar DICHA, en español: no con el nombre del
    // campo del XML, que era jerga en pantalla.
    && /el propio formulario 4 declara después de la operación/.test(pie)
    && /Información, no asesoría/.test(pie),
    pie.slice(0, 90));

  await d.screenshot({ path: join(OUT, 'insiders-1440.png') });
  console.log(`  → ${join(OUT, 'insiders-1440.png')}`);
  // ── Y LA TABLA SOLA, HASTA LA FILA 15 ───────────────────────────────
  // La página entera son ~11.700 px y lo que hay que mirar está arriba.
  // El recorte se calcula del DOM y no a ojo: con un número de píxeles fijo,
  // el día que cambie el alto de una fila la captura muestra otra cosa.
  const corte = await d.evaluate(() => {
    const tabla = document.querySelector('#contenido table');
    const filas = [...document.querySelectorAll('#contenido tbody tr')];
    if (!tabla || !filas.length) return null;
    const r = tabla.getBoundingClientRect();
    const ult = filas[Math.min(14, filas.length - 1)].getBoundingClientRect();
    return {
      x: Math.max(0, Math.round(r.x) - 8), y: Math.max(0, Math.round(r.y) - 8),
      width: Math.min(Math.round(r.width) + 16, window.innerWidth),
      height: Math.round(ult.bottom - r.y) + 16,
      filas: Math.min(15, filas.length),
    };
  });
  if (corte) {
    await d.screenshot({ path: join(OUT, 'insiders-1440-tabla15.png'),
      clip: { x: corte.x, y: corte.y, width: corte.width, height: corte.height } });
    console.log(`  → ${join(OUT, 'insiders-1440-tabla15.png')} (${corte.filas} filas)`);
  }
  await esc2.close();
// ── NINGUNA ENTIDAD XML LLEGA A LA PANTALLA ──────────────────────────────
// Lety, contra producción (2026-10-20): el cargo salía "EVP, CFO &amp; COO".
// El Form 4 trae `&amp;` —es XML— y se escapaba otra vez al pintar. El
// fixture ahora trae un cargo con `&`, y esto vigila que lo que SE LEE sea
// el texto y no la segunda capa de escape.
{
  const esc = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await esc.goto(`${BASE}/mercado/insiders`, { waitUntil: 'networkidle' });
  await esc.waitForSelector('tbody tr, .vacio');
  const texto = await esc.evaluate(() => document.body.innerText);
  chequeo('ninguna entidad XML cruda en pantalla (&amp;, &lt;, &quot;)',
    !/&(amp|lt|gt|quot|apos|#\d+);/.test(texto),
    (texto.match(/&(amp|lt|gt|quot|apos|#\d+);[^\n]{0,40}/g) || []).slice(0, 3).join(' | '));
  chequeo('y el cargo con `&` se lee como `&`',
    /EVP, CFO & COO/.test(texto) && !/EVP, CFO &amp; COO/.test(texto));
  await esc.close();
}
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
