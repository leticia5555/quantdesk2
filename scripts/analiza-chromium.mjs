// ═══════════════════════════════════════════════════════════════════
// scripts/analiza-chromium.mjs — /analiza/:ticker en un Chromium real.
//
// El cierre de R6 (regla 10): 390 px con TAP REAL y escritorio, con captura.
//
// EL FIXTURE ESTÁ ARMADO PARA QUE LOS HUECOS SE VEAN, que es la mitad de lo
// que esta pantalla promete:
//   · la serie SIN cierre ajustado → la tabla tiene que decir "de precio",
//     no "total". Es el error que no se nota mirando el número;
//   · un trimestre de UPA sin estimado y otro que todavía no reporta → dos
//     causas distintas, no un "—" mudo;
//   · EDGAR con un trimestre reexpresado y un anual → el anual no entra y
//     gana el filing más reciente, con su link;
//   · el precio objetivo AUSENTE, que es el caso real (Fase 0.8 NO-GO) →
//     panel punteado con su causa, nunca el precio actual;
//   · la tarjeta de la calificación con nombre de casa, SIEMPRE punteada.
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
const A = await import(join(ROOT, 'api/_lib/analiza.js'));

const MOMENTO = Date.parse('2026-10-20T16:30:00Z');
const DIA = 86400;
const FIN = Math.floor(Date.parse('2026-10-19T00:00:00Z') / 1000);

// 400 sesiones: alcanza para YTD y 1A, NO para 3A ni 5A — así se ve que esas
// filas salen en "—" con su causa en vez de desaparecer.
const N = 400;
const velas = (base, drift) => Array.from({ length: N }, (_, i) => ({
  time: FIN - (N - 1 - i) * DIA,
  close: base * (1 + drift * i / N) + Math.sin(i / 23) * base * 0.03,
}));
const VELAS = velas(180, 0.42);
const BENCH = velas(5200, 0.18);
const FIX = Array.from({ length: 500 }, (_, i) => ({
  date: new Date((FIN - (499 - i) * DIA) * 1000).toISOString().slice(0, 10),
  value: 18.4 + Math.sin(i / 40) * 0.8,
}));

const UPA = [
  { date: '2026-07-30', quarter: 2, year: 2026, eps_actual: 1.26, eps_est: 1.20 },
  { date: '2026-04-30', quarter: 1, year: 2026, eps_actual: 1.10, eps_est: 1.15 },
  { date: '2026-01-29', quarter: 4, year: 2025, eps_actual: 1.40, eps_est: 1.33 },
  { date: '2025-10-29', quarter: 3, year: 2025, eps_actual: 0.98, eps_est: null },
  { date: '2026-11-05', quarter: 3, year: 2026, eps_actual: null, eps_est: 1.31 },
];

const FACTS = {
  facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      { start: '2026-04-01', end: '2026-06-30', val: 30_000_000_000, accn: '0000320193-26-000070', form: '10-Q', filed: '2026-08-01' },
      { start: '2026-01-01', end: '2026-03-31', val: 27_500_000_000, accn: '0000320193-26-000050', form: '10-Q', filed: '2026-05-02' },
      { start: '2025-10-01', end: '2025-12-31', val: 26_100_000_000, accn: '0000320193-26-000010', form: '10-Q', filed: '2026-02-01' },
      { start: '2025-07-01', end: '2026-06-30', val: 110_000_000_000, accn: '0000320193-26-000090', form: '10-K', filed: '2026-09-01' },
      { start: '2026-04-01', end: '2026-06-30', val: 30_400_000_000, accn: '0000320193-26-000099', form: '10-Q/A', filed: '2026-09-15' },
    ] } },
    NetIncomeLoss: { units: { USD: [
      { start: '2026-04-01', end: '2026-06-30', val: 9_000_000_000, accn: '0000320193-26-000070', form: '10-Q', filed: '2026-08-01' },
      { start: '2026-01-01', end: '2026-03-31', val: 7_900_000_000, accn: '0000320193-26-000050', form: '10-Q', filed: '2026-05-02' },
      { start: '2025-10-01', end: '2025-12-31', val: -1_200_000_000, accn: '0000320193-26-000010', form: '10-Q', filed: '2026-02-01' },
    ] } },
  } },
};

const CUERPO = () => {
  const fin = A.trimestresDeCompanyFacts(FACTS);
  return {
    ticker: 'NVDA', nombre: 'NVIDIA Corporation', bolsa: 'NasdaqGS',
    sector: 'Technology', moneda: 'USD', es_mexicana: false,
    serie: { velas: VELAS, moneda: 'USD', rango: '5y', fuente: 'yahoo:v8/chart (interval=1d, range=5y)', motivo: null },
    rendimiento: A.serieDeRendimiento(VELAS),
    benchmark: { symbol: '^GSPC', nombre: 'S&P 500',
      serie: { velas: BENCH, fuente: 'yahoo:v8/chart', motivo: null },
      rendimiento: A.serieDeRendimiento(BENCH) },
    fix: { serie: FIX.map((p) => ({ t: Date.parse(p.date + 'T12:00:00Z') / 1000, c: p.value })),
           valor: FIX[FIX.length - 1].value, fecha: FIX[FIX.length - 1].date,
           fuente: 'banxico:SF43718 (FIX)', motivo: null },
    upa: A.upaRealVsEstimado(UPA),
    proximo_reporte: { fecha: '2026-11-05', cuando: 'AMC', eps_estimado: 1.31, fuente: 'finnhub:earnings' },
    financieros: { ...fin, cik: 320193, filas: fin.filas.map((f) => ({
      ...f,
      ingresos_link: A.linkDeFiling(320193, f.ingresos_accn),
      utilidad_link: A.linkDeFiling(320193, f.utilidad_accn),
    })) },
    analistas: {
      // EL CASO REAL: la Fase 0.8 dio NO-GO para el precio objetivo.
      precio_objetivo: A.precioObjetivo({}),
      recomendaciones: A.recomendaciones([
        { period: '2026-10-01', strongBuy: 28, buy: 11, hold: 4, sell: 1, strongSell: 0 },
        { period: '2026-09-01', strongBuy: 26, buy: 12, hold: 5, sell: 1, strongSell: 0 },
      ]),
      de_pago: A.DE_PAGO,
    },
    valuacion: { filas: A.tablaValuacion({
      summaryDetail: { trailingPE: { raw: 48.2 }, dividendYield: { raw: 0.0003 } },
      defaultKeyStatistics: { priceToBook: { raw: 42.1 } },
      financialData: { returnOnEquity: { raw: 0.91 } },
    }), fuente: 'yahoo:quoteSummary', motivo: null },
    insiders: {
      ultimas: [
        { name: 'Huang Jensen', type: 'SELL', shares: 120000, value: 21_600_000, transactionDate: '2026-10-02' },
        { name: 'Kress Colette', type: 'SELL', shares: 30000, value: 5_400_000, transactionDate: '2026-09-28' },
      ],
      neto_90: A.netoInsiders([
        { transactionDate: '2026-10-02', type: 'SELL', value: 21_600_000 },
        { transactionDate: '2026-09-28', type: 'SELL', value: 5_400_000 },
        { transactionDate: '2026-09-10', type: 'BUY', value: 2_000_000 },
      ], { hoy: new Date(MOMENTO) }),
      total: 3, fuente: 'finnhub:insider-transactions (SEC Form 4)', motivo: null,
    },
    historia: { hitos: [], fuente: 'neon:historia', motivo: 'sin hitos registrados para este ticker' },
    noticias: { filas: [{ url: 'https://medio.test/nvda', titular: 'Nvidia presenta su nueva generación',
                          fuente_nombre: 'CNBC', publicado_en: '2026-10-20T14:00:00.000Z' }],
                de: 60, fuente: 'neon:mercado_noticias',
                metodo: 'cruce con el arreglo de tickers que calculó el job de noticias, sin IA', motivo: null },
    agentes: { ruta: '/app?tab=analyze&ticker=NVDA' },
    generado_en: new Date(MOMENTO).toISOString(),
  };
};

let caido = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidos = 0;
let llamadasIa = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__romper') { caido = url.searchParams.get('v') === '1'; res.writeHead(200); return res.end('ok'); }
  // Cualquier llamada a un endpoint de IA se CUENTA: la regla 6 dice que no
  // puede haber ninguna al abrir la ficha.
  if (/^\/api\/(agents|claude|memo|ai-)/.test(url.pathname)) { llamadasIa++; res.writeHead(200); return res.end('{}'); }
  if (url.pathname === '/api/analiza') {
    pedidos++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (caido) return res.end(JSON.stringify({ ticker: 'NVDA', error: 'Neon: connection refused' }));
    return res.end(JSON.stringify(CUERPO()));
  }
  let p = url.pathname;
  if (/^\/analiza\//.test(p)) p = '/analiza.html';
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

  await p.goto(`${BASE}/analiza/NVDA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#col-a table');

  chequeo('la ficha carga sin errores de consola', errores.length === 0, errores.slice(0, 2).join(' | '));
  chequeo('UNA sola petición para abrir (regla 7)', pedidos === 1, `fueron ${pedidos}`);
  // REGLA 6: cero IA al abrir. Es la que más fácil se rompe sin querer.
  chequeo('CERO llamadas de IA al abrir la ficha (regla 6)', llamadasIa === 0, `fueron ${llamadasIa}`);
  chequeo('sin scroll horizontal a 390 px',
    !(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));

  // ── RENDIMIENTO ─────────────────────────────────────────────────────
  const rend = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-a h2')][0];
    const filas = [...document.querySelectorAll('#col-a table')][0].querySelectorAll('tbody tr');
    return {
      titulo: h.textContent,
      filas: [...filas].map((tr) => [...tr.children].map((td) => td.textContent.trim())),
    };
  });
  // LA QUE MÁS IMPORTA: sin cierre ajustado, NO se le puede llamar "total".
  chequeo('sin cierre ajustado la tabla dice "de precio", no "total"',
    /Rendimiento de precio/.test(rend.titulo) && /sin dividendos/.test(rend.titulo), rend.titulo.slice(0, 90));
  chequeo('compara contra el S&P 500 y saca la diferencia en puntos',
    /S&P 500/.test(rend.titulo) && rend.filas.some((f) => /pp/.test(f[3])),
    JSON.stringify(rend.filas[0]));
  // 400 sesiones alcanzan para 1A y no para 3A: la fila sigue, con su "—".
  const f3a = rend.filas.find((f) => f[0] === '3A');
  chequeo('3A sigue en la tabla con "—" porque la serie no llega',
    f3a && f3a[1].startsWith('—'), JSON.stringify(f3a));
  const f1a = rend.filas.find((f) => f[0] === '1A');
  chequeo('1A sí trae número, y la columna en pesos es DISTINTA de la local',
    f1a && !f1a[1].startsWith('—') && f1a[4] !== f1a[1], JSON.stringify(f1a));

  // ── UPA ─────────────────────────────────────────────────────────────
  const upa = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-a h2')].find((x) => /UPA/.test(x.textContent));
    const tabla = h.nextElementSibling.querySelector('table');
    return {
      titulo: h.textContent,
      filas: [...tabla.querySelectorAll('tbody tr')].map((tr) => ({
        celdas: [...tr.children].map((td) => td.textContent.trim()),
        titulos: [...tr.children].map((td) => td.getAttribute('title') || ''),
      })),
    };
  });
  chequeo('la UPA dice en cuántos trimestres MEDIDOS le ganó al consenso',
    /2 de 3 trimestres medidos/.test(upa.titulo), upa.titulo.slice(0, 80));
  const sinEst = upa.filas.find((f) => f.celdas[0] === '2025 T3');
  chequeo('el trimestre sin estimado sigue en la tabla, con su causa',
    sinEst && sinEst.celdas[3] === '—' && /no trae estimado/.test(sinEst.titulos[3]),
    sinEst ? sinEst.titulos[3] : 'no está');
  const futuro = upa.filas.find((f) => f.celdas[0] === '2026 T3');
  chequeo('y el que todavía no reporta dice ESO, que es otra causa',
    futuro && /todavía no reporta/.test(futuro.titulos[3]), futuro ? futuro.titulos[3] : 'no está');

  // ── FINANCIEROS CITANDO SU FILING ───────────────────────────────────
  const fin = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-a h2')].find((x) => /Ingresos y utilidad/.test(x.textContent));
    const tablas = [];
    let n = h.nextElementSibling;
    while (n) { if (n.querySelector && n.querySelector('table')) { tablas.push(n.querySelector('table')); break; } n = n.nextElementSibling; }
    const t = tablas[0] || h.parentElement.querySelector('table');
    return {
      titulo: h.textContent,
      barras: document.querySelectorAll('#col-a .barra').length,
      filas: [...t.querySelectorAll('tbody tr')].map((tr) => ({
        celdas: [...tr.children].map((td) => td.textContent.trim()),
        link: (tr.querySelector('a') || {}).href || null,
      })),
    };
  });
  chequeo('el título dice que cada barra cita su 10-Q', /cita su 10-Q/.test(fin.titulo), fin.titulo);
  chequeo('hay una barra por trimestre', fin.barras >= 3, String(fin.barras));
  chequeo('cada fila enlaza a EDGAR con el accn de SU filing',
    fin.filas.every((f) => f.link && /sec\.gov/.test(f.link)),
    fin.filas[0] ? fin.filas[0].link : 'sin link');
  chequeo('el trimestre reexpresado muestra el 10-Q/A, no el 10-Q viejo',
    fin.filas.some((f) => f.celdas[4].indexOf('10-Q/A') === 0), JSON.stringify(fin.filas.map((f) => f.celdas[4])));
  chequeo('el ANUAL no se coló entre los trimestres',
    fin.filas.length <= 8 && !fin.filas.some((f) => /110/.test(f.celdas[1])),
    JSON.stringify(fin.filas.map((f) => f.celdas[1])));
  const trimNeg = fin.filas.find((f) => f.celdas[0] === '2025-12-31');
  chequeo('una utilidad NEGATIVA se ve como negativa',
    trimNeg && /-/.test(trimNeg.celdas[2]), trimNeg ? trimNeg.celdas[2] : 'no está');

  // ── LO DE PAGO ──────────────────────────────────────────────────────
  const pago = await p.evaluate(() => [...document.querySelectorAll('#col-b .punteado')].map((d) => ({
    b: d.querySelector('b').textContent, p: d.querySelector('p').textContent,
    borde: getComputedStyle(d).borderStyle,
  })));
  chequeo('el precio objetivo ausente va punteado con su causa, no con un número',
    pago.some((x) => /Precio objetivo/.test(x.b) && /Fase 0\.8/.test(x.p) && x.borde === 'dashed'),
    JSON.stringify(pago.map((x) => x.b)));
  chequeo('la calificación con nombre de casa va SIEMPRE punteada y lo dice',
    pago.some((x) => /no lo mostramos, es dato de pago/.test(x.b)),
    JSON.stringify(pago.map((x) => x.b.slice(0, 50))));

  // ── VALUACIÓN ───────────────────────────────────────────────────────
  const val = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-b h2')].find((x) => /Valuación/.test(x.textContent));
    const t = h.nextElementSibling.querySelector('table');
    return [...t.querySelectorAll('tbody tr')].map((tr) => ({
      k: tr.children[0].textContent.trim(), v: tr.children[1].textContent.trim(),
      f: tr.children[2].textContent.trim(), titulo: tr.children[1].getAttribute('title') || '',
    }));
  });
  chequeo('la tabla de valuación trae las doce filas', val.length === 12, String(val.length));
  chequeo('cada fila con dato dice su fuente',
    val.filter((x) => x.v !== '—').every((x) => /yahoo/.test(x.f)),
    JSON.stringify(val.filter((x) => x.v !== '—').map((x) => x.k)));
  chequeo('y cada fila SIN dato dice por qué, en vez de desaparecer',
    val.filter((x) => x.v === '—').every((x) => x.f.length > 0 || x.titulo.length > 0),
    String(val.filter((x) => x.v === '—').length) + ' filas en "—"');

  // ── NINGUNA TABLA SE CORTA POR LA DERECHA ───────────────────────────
  // La captura enseñó la tabla de recomendaciones cortada en "VENTA | VI…":
  // seis columnas en una lateral de 380 px. Una columna recortada es un dato
  // que no está, y ninguna comprobación lo veía porque el texto SÍ estaba en
  // el DOM.
  const cortadas = await p.evaluate(() => {
    const malas = [];
    for (const t of document.querySelectorAll('.panel table')) {
      const panel = t.closest('.panel');
      // Se corta si la tabla es más ancha que su panel Y el panel no se
      // puede recorrer.
      const puedeRecorrerse = getComputedStyle(panel).overflowX === 'auto'
        || getComputedStyle(panel).overflowX === 'scroll';
      if (t.scrollWidth > panel.clientWidth + 1 && !puedeRecorrerse) {
        malas.push((t.querySelector('th') || {}).textContent + ' · ' + t.scrollWidth + '>' + panel.clientWidth);
      }
    }
    return malas;
  });
  chequeo('ninguna tabla se corta sin poder recorrerse', cortadas.length === 0, cortadas.join(' · '));

  // ── TAP REAL: las pestañas ──────────────────────────────────────────
  const tabPares = p.locator('#tabs button[data-tab="pares"]');
  chequeo('las pestañas miden ≥44 px', (await tabPares.boundingBox()).height >= 44);
  await tabPares.tap();
  await p.waitForFunction(() => /Pares/.test(document.getElementById('col-a').textContent), null, { timeout: 2000 });
  const pares = await p.textContent('#col-a');
  chequeo('"Pares" va punteada con su causa, no vacía ni inventada',
    /pronto/.test(pares) && /comparables/.test(pares), pares.trim().slice(0, 90));
  chequeo('y queda en la URL', (await p.evaluate(() => location.search)).includes('tab=pares'));

  await p.locator('#tabs button[data-tab="historia"]').tap();
  await p.waitForFunction(() => /Historia/.test(document.getElementById('col-a').textContent), null, { timeout: 2000 });
  const histo = await p.textContent('#col-a');
  chequeo('Historia sin hitos lo DICE en vez de quedarse en blanco',
    /sin hitos registrados/.test(histo), histo.trim().slice(0, 70));

  await p.locator('#tabs button[data-tab="resumen"]').tap();
  await p.waitForSelector('#col-a table');

  // ── LA FICHA CAÍDA ──────────────────────────────────────────────────
  await p.goto(`${BASE}/__romper?v=1`);
  await p.goto(`${BASE}/analiza/NVDA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#col-a .vacio');
  const caidoTxt = await p.textContent('#col-a .vacio');
  chequeo('con el endpoint caído se dice la causa, no una ficha vacía',
    /connection refused/.test(caidoTxt), caidoTxt.slice(0, 70));
  await p.goto(`${BASE}/__romper?v=0`);

  await p.goto(`${BASE}/analiza/NVDA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#col-a table');
  await p.screenshot({ path: join(OUT, 'analiza-390.png'), fullPage: true });
  console.log(`  → ${join(OUT, 'analiza-390.png')}`);
  await movil.close();

  console.log('\n── 1440 × 1000 ──');
  const esc2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await esc2.addInitScript(RELOJ_FIJO);
  const d = await esc2.newPage();
  const erroresD = [];
  d.on('pageerror', (e) => erroresD.push(String(e)));
  await d.goto(`${BASE}/analiza/NVDA`, { waitUntil: 'networkidle' });
  await d.waitForSelector('#col-a table');
  chequeo('escritorio sin errores de consola', erroresD.length === 0, erroresD.slice(0, 2).join(' | '));
  const caja = await d.evaluate(() => ({
    cols: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
    scrollH: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  chequeo('dos columnas, con la lateral de 380 px', /380px/.test(caja.cols), caja.cols);
  chequeo('sin scroll horizontal', !caja.scrollH);
  const pie = await d.textContent('#pie');
  chequeo('el pie dice las fuentes y que la IA NO corre al abrir',
    /yahoo/.test(pie) && /edgar/.test(pie) && /NO corre al abrir/.test(pie)
    && /Información, no asesoría/.test(pie), pie.slice(0, 100));

  await d.screenshot({ path: join(OUT, 'analiza-1440.png') });
  console.log(`  → ${join(OUT, 'analiza-1440.png')}`);
  await esc2.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
