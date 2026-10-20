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

// ═══════════════════════════════════════════════════════════════════
// EDGAR, CON LA FORMA DE NVDA DE VERDAD.
//
// El concepto preferido —`RevenueFromContractWithCustomerExcludingAssessedTax`—
// existe y SÓLO trae el ejercicio completo; el trimestre vive bajo `Revenues`.
// Es lo que dejó los ingresos en "—" en los ocho trimestres de producción
// (Lety, 2026-10-21) mientras la utilidad salía perfecta: se elegía el primer
// concepto que EXISTIERA, no el que sirviera.
//
// Los trimestres son los fiscales de NVDA (cierran en abril, julio, octubre y
// enero), no los del calendario: es lo que hace que el año fiscal vaya
// adelantado y que la UPA pudiera contar el mismo trimestre dos veces.
// ═══════════════════════════════════════════════════════════════════
const FACTS = {
  facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      // El concepto preferido existe y SÓLO trae el ejercicio completo: es lo
      // que dejó los ingresos en "—" en los ocho trimestres de producción.
      { start: '2024-01-29', end: '2025-01-26', val: 60_922_000_000, accn: '0001045810-25-000090', form: '10-K', filed: '2025-02-26' },
    ] } },
    Revenues: { units: { USD: [
      { start: '2026-04-27', end: '2026-07-26', val: 46_743_000_000, accn: '0001045810-26-000070', form: '10-Q', filed: '2026-08-27' },
      { start: '2026-01-26', end: '2026-04-26', val: 44_062_000_000, accn: '0001045810-26-000050', form: '10-Q', filed: '2026-05-28' },
      { start: '2025-07-28', end: '2025-10-26', val: 35_082_000_000, accn: '0001045810-25-000030', form: '10-Q', filed: '2025-11-20' },
      { start: '2025-04-28', end: '2025-07-27', val: 30_040_000_000, accn: '0001045810-25-000020', form: '10-Q', filed: '2025-08-27' },
      { start: '2025-01-27', end: '2025-04-27', val: 26_044_000_000, accn: '0001045810-25-000010', form: '10-Q', filed: '2025-05-28' },
      // EL EJERCICIO COMPLETO. El trimestre que cierra el 2026-01-25 no tiene
      // 10-Q propio —ninguna emisora lo presenta— y sale de restarle a esto
      // los tres trimestres de arriba: 130,497 − 26,044 − 30,040 − 35,082.
      { start: '2025-01-27', end: '2026-01-25', val: 130_497_000_000, accn: '0001045810-26-000090', form: '10-K', filed: '2026-02-26' },
      // REEXPRESIÓN del trimestre de julio: gana el filing más reciente.
      { start: '2026-04-27', end: '2026-07-26', val: 46_800_000_000, accn: '0001045810-26-000099', form: '10-Q/A', filed: '2026-09-15' },
    ] } },
    NetIncomeLoss: { units: { USD: [
      { start: '2026-04-27', end: '2026-07-26', val: 26_422_000_000, accn: '0001045810-26-000070', form: '10-Q', filed: '2026-08-27' },
      { start: '2026-01-26', end: '2026-04-26', val: 18_775_000_000, accn: '0001045810-26-000050', form: '10-Q', filed: '2026-05-28' },
      { start: '2025-07-28', end: '2025-10-26', val: 19_309_000_000, accn: '0001045810-25-000030', form: '10-Q', filed: '2025-11-20' },
      { start: '2025-04-28', end: '2025-07-27', val: 16_599_000_000, accn: '0001045810-25-000020', form: '10-Q', filed: '2025-08-27' },
      // Un trimestre en pérdida: tiene que verse como negativo.
      { start: '2025-01-27', end: '2025-04-27', val: -1_200_000_000, accn: '0001045810-25-000010', form: '10-Q', filed: '2025-05-28' },
      { start: '2025-01-27', end: '2026-01-25', val: 72_880_000_000, accn: '0001045810-26-000090', form: '10-K', filed: '2026-02-26' },
    ] } },
  } },
};

// ═══════════════════════════════════════════════════════════════════
// EL CUERPO SALE DEL ENDPOINT, NO DE MI MANO.
//
// La versión anterior armaba la respuesta llamando a las funciones de
// `api/_lib/analiza.js` una por una. O sea que probaba la aritmética y
// SALTABA `api/analiza.js`, que es justo donde estaban los dos defectos que
// Lety encontró en producción el 2026-10-20:
//
//   · pedía `cal.json.earnings` y el endpoint de reportes devuelve `history`
//     (con `period` y `eps_estimate`): el bloque de UPA salía "sin
//     trimestres" para NVDA, que tiene años de historial;
//   · no resolvía el CIK desde el ticker, así que EDGAR salía vacío salvo
//     que uno escribiera `&cik=1045810` a mano.
//
// Acá se corre el handler DE VERDAD y se finge la RED: Yahoo, la SEC,
// Finnhub y el SIE, cada uno en su forma cruda.
// ═══════════════════════════════════════════════════════════════════
process.env.FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'ficticia-para-la-corrida';
process.env.BANXICO_TOKEN = process.env.BANXICO_TOKEN || 'ficticio-para-la-corrida';

const CIK_NVDA = 1045810;

// Yahoo v8, crudo. Sin `adjclose`: así el rendimiento es DE PRECIO y la
// pantalla tiene que decirlo — es el error que no se nota mirando el número.
function yahooChart(velas, moneda = 'USD') {
  return { chart: { result: [{
    meta: { currency: moneda },
    timestamp: velas.map((v) => v.time),
    indicators: { quote: [{
      open: velas.map((v) => v.close - 0.4), high: velas.map((v) => v.close + 1.1),
      low: velas.map((v) => v.close - 1.4), close: velas.map((v) => v.close),
      volume: velas.map(() => 1000),
    }] },
  }] } };
}

const QUOTE_SUMMARY = { quoteSummary: { result: [{
  price: { longName: 'NVIDIA Corporation', exchangeName: 'NasdaqGS' },
  assetProfile: { sector: 'Technology' },
  // La capitalización de NVDA, en dólares completos: 5.16 billones (10¹²).
  // Es el número que en producción se pintó "5.16 B" y se leyó como mil
  // millones (Lety, 2026-10-21).
  summaryDetail: { trailingPE: { raw: 48.2 }, dividendYield: { raw: 0.0003 },
                   marketCap: { raw: 5_160_000_000_000 } },
  defaultKeyStatistics: { priceToBook: { raw: 42.1 }, enterpriseValue: { raw: 5_140_000_000_000 } },
  financialData: { returnOnEquity: { raw: 0.91 } },
  recommendationTrend: { trend: [
    { period: '0m', strongBuy: 28, buy: 11, hold: 4, sell: 1, strongSell: 0 },
    { period: '-1m', strongBuy: 26, buy: 12, hold: 5, sell: 1, strongSell: 0 },
  ] },
}] } };

// Finnhub `stock/earnings`, crudo: `period`, `actual`, `estimate`.
// Finnhub `stock/earnings`, crudo. NVDA cierra su ejercicio en enero, así que
// su año fiscal va ADELANTADO: el trimestre que cerró en julio de 2026 es el
// T2 del fiscal 2027. El fixture manda ese trimestre DOS VECES —una con el año
// fiscal y otra con el calendario— que es lo que en producción pintó "2027 T2"
// y "2026 T2" con el mismo real y el mismo estimado.
// Finnhub `stock/earnings`, crudo. Dos cosas que esto reproduce:
//
//   · NVDA cierra su ejercicio en enero, así que su año fiscal va ADELANTADO:
//     el trimestre que cerró en julio de 2026 es el T2 del fiscal 2027. El
//     fixture manda ese trimestre DOS VECES —una con el año fiscal y otra con
//     el calendario— que es lo que pintó "2027 T2" y "2026 T2" con el mismo
//     real y el mismo estimado;
//   · las FECHAS son las del trimestre de CALENDARIO que contiene al fiscal
//     (2026-09-30 para el que cerró el 26 de julio), no las del filing. Es lo
//     que ponía dos fechas distintas del mismo trimestre en la misma página.
const EARNINGS_CRUDO = [
  { period: '2026-09-30', quarter: 2, year: 2027, actual: 2.22, estimate: 2.14 },
  { period: '2026-09-30', quarter: 2, year: 2026, actual: 2.22, estimate: 2.14 },
  { period: '2026-06-30', quarter: 1, year: 2027, actual: 1.96, estimate: 1.90 },
  { period: '2026-03-31', quarter: 4, year: 2026, actual: 1.40, estimate: 1.33 },
  // Sin estimado: la sorpresa de ESE trimestre no se puede calcular, y se dice.
  { period: '2025-12-31', quarter: 3, year: 2026, actual: 0.98, estimate: null },
  // El que TODAVÍA NO REPORTA: otra causa distinta de "no hay estimado".
  { period: '2026-12-31', quarter: 3, year: 2027, actual: null, estimate: 1.31 },
];

const CALENDARIO_CRUDO = { earningsCalendar: [
  { symbol: 'NVDA', date: '2026-11-05', hour: 'amc', epsEstimate: 1.31, quarter: 3, year: 2026 },
] };
const INSIDER_CRUDO = { data: [
  { name: 'Huang Jensen', change: -120000, transactionPrice: 180, transactionCode: 'S',
    transactionDate: '2026-10-02', filingDate: '2026-10-03' },
  { name: 'Kress Colette', change: -30000, transactionPrice: 180, transactionCode: 'S',
    transactionDate: '2026-09-28', filingDate: '2026-09-29' },
  { name: 'Dabiri John', change: 11000, transactionPrice: 181.8, transactionCode: 'P',
    transactionDate: '2026-09-10', filingDate: '2026-09-11' },
] };

const FIX_CRUDO = { bmx: { series: [{ idSerie: 'SF43718', titulo: 'FIX',
  datos: FIX.map((p) => {
    const [a, m, d] = p.date.split('-');
    return { fecha: `${d}/${m}/${a}`, dato: p.value.toFixed(4) };
  }) }] } };

// Qué hace Yahoo con `quoteSummary` en esta corrida: 'ok', '429' (dos veces
// y después bien, para ver el reintento) o 'siempre429' (para ver el relevo).
let modoYahoo = 'ok';
// Para ver el caso de producción: EDGAR con trimestres de utilidad y SIN
// ingresos bajo ningún concepto conocido.
let sinIngresos = false;
let veces429 = 0;
let pedidosYahooQS = 0;

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (recurso, opciones) => {
  const u = String((recurso && recurso.url) || recurso || '');
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

  if (u.includes('/v10/finance/quoteSummary/')) {
    pedidosYahooQS++;
    if (modoYahoo === 'siempre429') return json({ error: 'rate' }, 429, { 'retry-after': '1' });
    if (modoYahoo === '429' && veces429 < 2) { veces429++; return json({ error: 'rate' }, 429); }
    return json(QUOTE_SUMMARY);
  }
  if (u.includes('/v8/finance/chart/')) {
    const esBench = /%5EGSPC|\^GSPC/.test(u);
    return json(yahooChart(esBench ? BENCH : VELAS));
  }
  if (u.includes('sec.gov/files/company_tickers.json')) {
    return json({ 0: { cik_str: CIK_NVDA, ticker: 'NVDA', title: 'NVIDIA CORP' },
                  1: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
  }
  if (u.includes('/api/xbrl/companyfacts/')) {
    // El CIK va con diez dígitos en la URL: si el endpoint resolvió mal, esto
    // devuelve 404 y el bloque sale vacío, que es lo que se quiere ver.
    if (!u.includes(String(CIK_NVDA).padStart(10, '0'))) return json({ error: 'no' }, 404);
    if (!sinIngresos) return json(FACTS);
    const recortado = JSON.parse(JSON.stringify(FACTS));
    delete recortado.facts['us-gaap'].Revenues;
    return json(recortado);
  }
  if (u.includes('finnhub.io/api/v1/stock/earnings')) return json(EARNINGS_CRUDO);
  if (u.includes('finnhub.io/api/v1/calendar/earnings')) return json(CALENDARIO_CRUDO);
  if (u.includes('finnhub.io/api/v1/stock/financials-reported')) return json({ data: [] });
  if (u.includes('finnhub.io/api/v1/stock/insider-transactions')) return json(INSIDER_CRUDO);
  if (u.includes('finnhub.io/api/v1/stock/metric')) {
    return json({ metric: { marketCapitalization: 4_400_000, peTTM: 47.9, psTTM: 27.4,
      pbQuarterly: 41.8, roeTTM: 90.5, netProfitMarginTTM: 55.2,
      dividendYieldIndicatedAnnual: 0.03, enterpriseValue: 4_380_000 } });
  }
  if (u.includes('banxico.org.mx')) return json(FIX_CRUDO);
  throw new Error('la corrida intentó salir a la red: ' + u);
};

const { default: analizaHandler } = await import(join(ROOT, 'api/analiza.js'));

async function fichaDeVerdad(query) {
  let code = 200; let body = null;
  const res = {
    setHeader() {}, getHeader() {}, status(c) { code = c; return this; },
    json(o) { body = o; return this; }, send(o) { body = o; return this; }, end() { return this; },
  };
  await analizaHandler({ method: 'GET', query, headers: {}, url: '/' }, res);
  return { code, body };
}

let caido = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidos = 0;
let llamadasIa = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__romper') { caido = url.searchParams.get('v') === '1'; res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/__sin-ingresos') {
    sinIngresos = url.searchParams.get('v') === '1';
    res.writeHead(200); return res.end('ok');
  }
  if (url.pathname === '/__yahoo') {
    modoYahoo = url.searchParams.get('m') || 'ok';
    veces429 = 0; pedidosYahooQS = 0;
    // La caché del endpoint es por instancia y por ticker: para ver el
    // reintento y el relevo hay que preguntar por OTRO ticker, no por NVDA.
    res.writeHead(200); return res.end('ok');
  }
  if (url.pathname === '/__qs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ pedidos: pedidosYahooQS }));
  }
  // Cualquier llamada a un endpoint de IA se CUENTA: la regla 6 dice que no
  // puede haber ninguna al abrir la ficha.
  if (/^\/api\/(agents|claude|memo|ai-)/.test(url.pathname)) { llamadasIa++; res.writeHead(200); return res.end('{}'); }
  if (url.pathname === '/api/analiza') {
    pedidos++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (caido) return res.end(JSON.stringify({ ticker: 'NVDA', error: 'Neon: connection refused' }));
    const { body } = await fichaDeVerdad({
      ticker: url.searchParams.get('ticker') || 'NVDA',
      ...(url.searchParams.get('cik') ? { cik: url.searchParams.get('cik') } : {}),
    });
    return res.end(JSON.stringify(body));
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
  // LO QUE SE VIO EN PRODUCCIÓN: este bloque decía "sin trimestres" para NVDA.
  // La página pedía `earnings` y el endpoint devuelve `history`.
  chequeo('el bloque de UPA TRAE trimestres (no "sin trimestres")',
    upa.filas.length >= 4 && !/sin trimestres/.test(upa.titulo),
    `${upa.filas.length} filas · ${upa.titulo.slice(0, 50)}`);
  chequeo('la UPA dice en cuántos trimestres MEDIDOS le ganó al consenso',
    /3 de 3 trimestres medidos/.test(upa.titulo), upa.titulo.slice(0, 80));

  // ── UN TRIMESTRE, UNA FILA ──────────────────────────────────────────
  // En producción salían "2027 T2" y "2026 T2" con el mismo real y el mismo
  // estimado: el mismo trimestre contado dos veces porque NVDA cierra su
  // ejercicio en enero y la fuente mezcla el año fiscal con el calendario.
  // El fixture manda esas filas repetidas a propósito.
  const fechasUpa = upa.filas.map((f) => f.celdas[0].trim());
  chequeo('ningún trimestre de la UPA aparece dos veces',
    new Set(fechasUpa.map((t) => t.split(' ')[0])).size === fechasUpa.length,
    JSON.stringify(fechasUpa));
  chequeo('y cada fila se rotula con su FECHA DE CIERRE, no con el año fiscal',
    fechasUpa.every((t) => /^\d{4}-\d{2}-\d{2}/.test(t)), JSON.stringify(fechasUpa));
  chequeo('el nombre fiscal se conserva, dicho como fiscal',
    upa.filas.some((f) => /del fiscal 20\d\d/.test(f.celdas[0])),
    upa.filas[0] ? upa.filas[0].celdas[0] : 'no está');
  const avisoUpa = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-a h2')].find((x) => /UPA/.test(x.textContent));
    const av = h.parentElement.querySelector('.aviso');
    return av ? av.textContent : null;
  });
  chequeo('y se DICE que la fuente mandó filas repetidas',
    /repetida/.test(avisoUpa || ''), String(avisoUpa).slice(0, 80));

  const sinEst = upa.filas.find((f) => f.celdas[0].indexOf('2025-10-26') === 0);
  chequeo('el trimestre sin estimado sigue en la tabla, con su causa',
    sinEst && sinEst.celdas[3] === '—' && /no trae estimado/.test(sinEst.titulos[3]),
    sinEst ? sinEst.titulos[3] : 'no está');
  const futuro = upa.filas.find((f) => f.celdas[0].indexOf('2026-12-31') === 0);
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
  // EL CIK, RESUELTO SOLO. En producción `/analiza/NVDA` decía "EDGAR no
  // devolvió conceptos us-gaap" y con `&cik=1045810` traía todo: el único
  // motivo del hueco era que nadie había escrito el número a mano. Esta
  // corrida pide la ficha SIN `cik` en la URL.
  chequeo('hay trimestres de EDGAR sin pasarle el CIK en la URL',
    fin.filas.length >= 3, `${fin.filas.length} filas`);
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
  // ── SIN INGRESOS NO SE PINTAN BARRAS ────────────────────────────────
  // El caso de producción: EDGAR trae la utilidad por trimestre y ningún
  // ingreso. Antes se pintaban OCHO BARRAS DE LA MISMA ALTURA, que afirman
  // que ocho trimestres distintos midieron lo mismo — y lo afirman más
  // fuerte que el "—" de la tabla de abajo.
  await p.goto(`${BASE}/__sin-ingresos?v=1`);
  await p.goto(`${BASE}/analiza/NVDA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#col-a table');
  // Los bloques no tienen envoltorio propio: son un <h2> y lo que viene
  // detrás hasta el siguiente <h2>. Se recorta así, o se mide la columna
  // entera y la comprobación lee el bloque de al lado.
  const sinIng = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-a h2')].find((x) => /Ingresos y utilidad/.test(x.textContent));
    const trozos = [];
    for (let e = h.nextElementSibling; e && e.tagName !== 'H2'; e = e.nextElementSibling) trozos.push(e);
    const buscar = (sel) => trozos.flatMap((t) => [...t.querySelectorAll(sel)])
      .concat(trozos.filter((t) => t.matches && t.matches(sel)));
    const filas = buscar('table tbody tr');
    return {
      barras: buscar('.barra i').map((i) => Math.round(i.getBoundingClientRect().height)),
      aviso: (buscar('.aviso')[0] || {}).textContent || null,
      trimestres: filas.length,
      ingresos: filas.map((tr) => tr.children[1].textContent.trim()),
    };
  });
  chequeo('sin ingresos, los trimestres siguen en la tabla', sinIng.trimestres >= 3, String(sinIng.trimestres));
  chequeo('y la columna de ingresos va en "—", no en cero',
    sinIng.ingresos.every((v) => v === '—'), JSON.stringify(sinIng.ingresos));
  chequeo('NO se pintan ocho barras iguales: se dice por qué no hay ingresos',
    /no trae ingresos trimestrales/.test(sinIng.aviso || ''), String(sinIng.aviso).slice(0, 80));
  chequeo('y si se pinta alguna barra, es la de la utilidad y no todas iguales',
    sinIng.barras.length === 0 || new Set(sinIng.barras).size > 1,
    JSON.stringify(sinIng.barras));
  await p.goto(`${BASE}/__sin-ingresos?v=0`);
  await p.goto(`${BASE}/analiza/NVDA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.barra');

  // ── EL TRIMESTRE QUE NO TIENE 10-Q ──────────────────────────────────
  // Una emisora presenta tres 10-Q y un 10-K: el cuarto trimestre no tiene
  // formulario propio. La tabla saltaba de octubre a abril SIN DECIRLO (Lety,
  // 2026-10-22), y un hueco callado en una serie trimestral se lee como que
  // la empresa no operó ese trimestre.
  const q4 = fin.filas.find((f) => f.celdas[0] === '2026-01-25');
  chequeo('el trimestre de enero ESTÁ en la tabla, no se salta',
    !!q4, JSON.stringify(fin.filas.map((f) => f.celdas[0])));
  // 130,497 − 26,044 − 30,040 − 35,082 = 39,331 millones. El número exacto
  // del ejercicio menos los tres trimestres que sí tienen 10-Q.
  chequeo('y su cifra es el ejercicio menos los tres trimestres reportados',
    q4 && /39\.3 mil millones/.test(q4.celdas[1]), q4 ? q4.celdas[1] : 'no está');
  chequeo('la cita dice 10-K y que el número se DERIVÓ, no que esté escrito ahí',
    q4 && /10-K/.test(q4.celdas[4]) && /derivado/.test(q4.celdas[4]),
    q4 ? q4.celdas[4] : 'no está');
  const avisoFin = await p.evaluate(() => {
    const h = [...document.querySelectorAll('#col-a h2')].find((x) => /Ingresos y utilidad/.test(x.textContent));
    const out = [];
    for (let e = h.nextElementSibling; e && e.tagName !== 'H2'; e = e.nextElementSibling) {
      if (e.classList && e.classList.contains('aviso')) out.push(e.textContent);
    }
    return out.join(' | ');
  });
  chequeo('y el bloque DICE que ese trimestre se calculó con el 10-K',
    /se calculó con el 10-K|no tiene formulario propio/.test(avisoFin), avisoFin.slice(0, 90));
  // Y la serie no salta ningún otro trimestre.
  const saltos = await p.evaluate(() => {
    const fs = [...document.querySelectorAll('#col-a table tbody tr')]
      .map((tr) => tr.children[0].textContent.trim())
      .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t))
      .sort().reverse();
    const malos = [];
    for (let i = 0; i + 1 < fs.length; i++) {
      const d = (Date.parse(fs[i]) - Date.parse(fs[i + 1])) / 864e5;
      if (d > 120) malos.push(`${fs[i + 1]} → ${fs[i]} (${Math.round(d)} días)`);
    }
    return malos;
  });
  chequeo('ningún par de trimestres consecutivos se lleva más de un trimestre',
    saltos.length === 0, JSON.stringify(saltos));

  // ── LA UPA Y LOS INGRESOS, CON LA MISMA FECHA ───────────────────────
  // Finnhub normaliza el trimestre al cierre del trimestre de CALENDARIO que
  // lo contiene: el que cerró el 26 de julio salía fechado 2026-09-30, en la
  // misma página en la que los ingresos decían 2026-07-26.
  const fechasFin = fin.filas.map((f) => f.celdas[0]);
  const fechasUpaReal = upa.filas.map((f) => f.celdas[0].trim().split(' ')[0]);
  const reportados = fechasUpaReal.filter((f) => f !== '2026-12-31');
  chequeo('cada trimestre de la UPA usa el mismo cierre que los ingresos',
    reportados.every((f) => fechasFin.includes(f)),
    JSON.stringify({ upa: fechasUpaReal, edgar: fechasFin }));
  chequeo('y el que EDGAR no tiene conserva su fecha, DICIÉNDOLO',
    upa.filas.some((f) => /fecha de la fuente de UPA/.test(f.celdas[0])),
    JSON.stringify(fechasUpaReal));

  // ── LOS MONTOS, CON LA ESCALA DEL ESPAÑOL ───────────────────────────
  // "5.16 B" se leyó como 5.16 mil millones (Lety, 2026-10-21): esa "B" es
  // la del inglés y en español un billón son 10¹². `qdCap` escribe la escala
  // con palabras y la moneda al lado.
  const montos = await p.evaluate(() => {
    const t = document.body.innerText;
    return {
      // La abreviatura ambigua no puede quedar en ningún monto.
      conB: (t.match(/\d+\.\d+ B\b/g) || []),
      conPalabra: (t.match(/\d+(\.\d+)? (billones|billón|mil millones|millones)/g) || []).slice(0, 4),
    };
  });
  chequeo('ningún monto se abrevia con la "B" del inglés',
    montos.conB.length === 0, JSON.stringify(montos.conB));
  chequeo('los montos se escriben con la escala en palabras, como el mapa',
    montos.conPalabra.length >= 2, JSON.stringify(montos.conPalabra));
  const capTxt = await p.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find((x) => /Capitalización/.test(x.children[0].textContent));
    return tr ? tr.children[1].textContent.trim() : null;
  });
  // 5.16 × 10¹² son 5.16 BILLONES en español. Es el caso exacto de prod.
  chequeo('la capitalización de 10¹² se escribe "billones", no "B"',
    /^5\.16 billones USD$/.test(capTxt || ''), String(capTxt));

  // ── LAS BARRAS ──────────────────────────────────────────────────────
  // Ocho barras de la misma altura con los ingresos en "—" fue lo que se vio
  // en producción: la escala caía a 1 y toda barra se salía del recuadro.
  const barras = await p.evaluate(() => [...document.querySelectorAll('.barra')].map((b) => ({
    alturas: [...b.querySelectorAll('i')].map((i) => Math.round(i.getBoundingClientRect().height)),
  })));
  chequeo('hay barras y NO todas miden lo mismo',
    barras.length >= 3 && new Set(barras.map((b) => b.alturas.join('/'))).size > 1,
    JSON.stringify(barras.map((b) => b.alturas)));
  chequeo('ninguna barra se sale de su recuadro',
    barras.every((b) => b.alturas.every((h) => h <= 60)),
    JSON.stringify(barras.map((b) => b.alturas)));

  const trimNeg = fin.filas.find((f) => f.celdas[0] === '2025-04-27');
  chequeo('una utilidad NEGATIVA se ve como negativa',
    trimNeg && /-/.test(trimNeg.celdas[2]), trimNeg ? trimNeg.celdas[2] : 'no está');

  // ── LO DE PAGO ──────────────────────────────────────────────────────
  const pago = await p.evaluate(() => [...document.querySelectorAll('#col-b .punteado')].map((d) => ({
    b: d.querySelector('b').textContent, p: d.querySelector('p').textContent,
    borde: getComputedStyle(d).borderStyle,
  })));
  chequeo('el precio objetivo ausente va punteado con su causa, no con un número',
    // La causa tiene que estar, DICHA para quien lee: antes nombraba un
    // documento interno ("el NO-GO de la Fase 0.8") y el protocolo de Yahoo.
    pago.some((x) => /Precio objetivo/.test(x.b)
      && /credencial que sólo le da a un navegador/.test(x.p) && x.borde === 'dashed'),
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
  // En esta corrida no hay Postgres, así que lo que se exige es que la causa
  // se diga Y que se diga SIN jerga: el motivo crudo nombra una variable de
  // entorno nuestra, que a quien mira una ficha de NVIDIA no le dice nada.
  chequeo('Historia sin hitos lo DICE en vez de quedarse en blanco',
    /sin hitos registrados|no se pudo leer nuestra base de datos/.test(histo),
    histo.trim().slice(0, 70));
  chequeo('y lo dice sin nombrar una variable de entorno',
    !/DATABASE_URL|connection string/.test(histo), histo.trim().slice(0, 70));

  await p.locator('#tabs button[data-tab="resumen"]').tap();
  await p.waitForSelector('#col-a table');

  // ── LO QUE SE VE EN PANTALLA VA SIN JERGA ───────────────────────────
  // La misma comprobación que en la ficha de índice y en insiders. Acá
  // atrapó "es el caso NO-GO de la Fase 0.8: Yahoo quoteSummary pide crumb
  // desde el servidor", que nombra un documento interno nuestro y un detalle
  // del protocolo de Yahoo a quien está mirando una ficha de NVIDIA.
  const jerga = await p.evaluate(() => {
    const malas = [];
    const PROHIBIDO = [
      [/`/, 'comillas de código'],
      [/\.(js|json|mjs)\b/, 'nombre de archivo'],
      [/api\/_lib|DATABASE_URL|FINNHUB_API_KEY/, 'nombre interno del repo o del entorno'],
      [/getcurrent|metric=all|cik_str|crumb|NO-GO|Fase 0\.\d/i,
       'nombre interno de un endpoint, un campo o un documento nuestro'],
      [/quoteSummary|companyfacts/i, 'nombre de un endpoint suelto en la prosa'],
    ];
    // LAS FUENTES DECLARADAS NO SON JERGA, SON LA REGLA 3.
    // `yahoo:quoteSummary`, `edgar:companyfacts`, `banxico:SF43718` y
    // `finnhub:metric` son la procedencia de cada número, y el encargo pide
    // que se vean. Se quitan antes de buscar: lo que se persigue es el
    // nombre interno SUELTO dentro de una frase, que es lo que no se
    // entiende.
    const sinFuentes = (t) => t.replace(/[a-z_]+:[A-Za-z0-9_\-/.]+/g, ' ');
    const paseo = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = paseo.nextNode())) {
      const crudo = (n.textContent || '').trim();
      if (!crudo) continue;
      const padre = n.parentElement;
      if (padre && (padre.tagName === 'SCRIPT' || padre.tagName === 'STYLE')) continue;
      const t = sinFuentes(crudo);
      for (const [re, por] of PROHIBIDO) if (re.test(t)) malas.push(por + ': ' + crudo.slice(0, 70));
    }
    for (const el of document.querySelectorAll('[title]')) {
      const crudo = el.getAttribute('title') || '';
      const t = sinFuentes(crudo);
      for (const [re, por] of PROHIBIDO) if (re.test(t)) malas.push('en un title · ' + por + ': ' + crudo.slice(0, 70));
    }
    return malas;
  });
  chequeo('nada de lo que se ve en pantalla trae jerga de código',
    jerga.length === 0, JSON.stringify(jerga.slice(0, 3)));

  // ── EL 429 DE YAHOO: REINTENTO, CACHÉ Y RELEVO ──────────────────────
  // Lety, 2026-10-20: *"Yahoo `quoteSummary` da 429: agrega caché y reintento
  // con espera; si sigue fallando, que la valuación salga de Finnhub."*
  //
  // Cada caso se pide con un ticker distinto a propósito: la caché del
  // endpoint es por ticker, y reusar NVDA mediría la caché en vez del camino
  // que se quiere ver.
  await p.goto(`${BASE}/__yahoo?m=429`);
  await p.goto(`${BASE}/analiza/AMD`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#col-b table, #col-a table');
  const trasReintento = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((x) => /Valuación/.test(x.textContent));
    const cont = h.parentElement;
    return {
      fuentes: [...cont.querySelectorAll('table tbody tr td:last-child')].map((td) => td.textContent.trim()),
      aviso: (cont.querySelector('.aviso') || {}).textContent || null,
    };
  });
  // Con `fetchOriginal`: el `fetch` global está fingido para que NADA salga a
  // la red, y el propio servidor de la corrida cuenta como red.
  const pedidosQS = (await (await fetchOriginal(`${BASE}/__qs`)).json()).pedidos;
  chequeo('con dos 429 seguidos, el endpoint REINTENTA y termina con el dato de Yahoo',
    pedidosQS === 3 && trasReintento.fuentes.some((f) => /yahoo/.test(f)),
    `${pedidosQS} peticiones · ${trasReintento.fuentes.filter((f) => /yahoo/.test(f)).length} filas de Yahoo`);
  chequeo('y sin aviso: el dato es fresco, no hay nada que advertir',
    !trasReintento.aviso, String(trasReintento.aviso).slice(0, 60));

  // Ahora Yahoo no cede nunca: la valuación tiene que venir de Finnhub, y la
  // pantalla tiene que DECIR que cambió de proveedor.
  await p.goto(`${BASE}/__yahoo?m=siempre429`);
  await p.goto(`${BASE}/analiza/INTC`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#col-b table, #col-a table');
  const conRelevo = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((x) => /Valuación/.test(x.textContent));
    const cont = h.parentElement;
    const filas = [...cont.querySelectorAll('table tbody tr')].map((tr) => ({
      k: tr.children[0].textContent.trim(),
      v: tr.children[1].textContent.trim(),
      f: tr.children[2].textContent.trim(),
    }));
    return { filas, aviso: (cont.querySelector('.aviso') || {}).textContent || null };
  });
  chequeo('con Yahoo caído, la valuación llega igual: viene de Finnhub',
    conRelevo.filas.some((f) => /finnhub/.test(f.f)),
    JSON.stringify(conRelevo.filas.slice(0, 2)));
  chequeo('y la pantalla DICE que cambió de proveedor, arriba de la tabla',
    /Finnhub/.test(conRelevo.aviso || '') && /429/.test(conRelevo.aviso || ''),
    String(conRelevo.aviso).slice(0, 80));
  // LAS UNIDADES. Finnhub da la capitalización en MILLONES y el ROE en POR
  // CIENTO; Yahoo las da en unidades y en fracción. Sin convertir, una cap de
  // 4.4 billones se pintaría como 4.4 millones y un ROE de 90.5% como 9050%.
  const cap = conRelevo.filas.find((f) => /Capitalización/.test(f.k));
  const roe = conRelevo.filas.find((f) => /ROE/.test(f.k));
  chequeo('la capitalización de Finnhub se convierte de millones',
    cap && /bill|B\b|mil M/i.test(cap.v) && !/^\$?4\.4[0-9]* ?M$/.test(cap.v), cap ? cap.v : 'no está');
  chequeo('y el ROE de Finnhub no se multiplica dos veces',
    roe && /^9[01]\.\d%$/.test(roe.v), roe ? roe.v : 'no está');
  await p.goto(`${BASE}/__yahoo?m=ok`);

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
