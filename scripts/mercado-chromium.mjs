// ═══════════════════════════════════════════════════════════════════
// scripts/mercado-chromium.mjs — /mercado en un Chromium de verdad.
//
// No es un test unitario: es la comprobación que el encargo pide al cierre
// de cada rebanada — 390 px con TAP REAL, y escritorio con hover. Levanta un
// servidor estático con la API servida desde un fixture (este sandbox no
// llega a Neon) y maneja el navegador.
//
//   node scripts/mercado-chromium.mjs [--out DIR]
//
// Sale 0 si todas las comprobaciones pasan, 1 si alguna falla, y deja dos
// capturas: mercado-390.png y mercado-1440.png.
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

// ── El fixture: un mapa con todo lo que tiene que saberse pintar ───
// Incluye a propósito un cuadro SIN serie y uno SIN ancla YTD: si el "—" con
// su causa se rompe, esta corrida lo tiene que ver.
const DIA = 86400;
const HOY = Math.floor(Date.parse('2026-09-18T00:00:00Z') / 1000);
// La serie se arma con un movimiento POR DÍA, no con una deriva repartida:
// con la deriva, el cambio de 1D salía ~0.05% y los 300 cuadros aparecían
// grises — la captura no mostraba la escala de color que hay que revisar.
function serie(base, pasos, porDia) {
  const out = [];
  let c = base;
  for (let i = pasos; i >= 0; i--) {
    out.push({ t: HOY - i * DIA, c: c });
    c = c * (1 + porDia);
  }
  return out;
}
const SECTORES = ['XLK', 'XLF', 'XLV', 'XLY', 'XLE', 'XLI'];
function cuadrosUs() {
  const cs = [];
  for (let s = 0; s < SECTORES.length; s++) {
    for (let i = 0; i < 9; i++) {
      // −3.5% a +3.5% por día: cubre los siete pasos de la escala, incluido
      // el gris de ±0.5%, para que la captura se pueda revisar de verdad.
      const drift = (((s * 3 + i * 5) % 15) - 7) / 200;
      const base = 40 + i * 7;
      cs.push({
        symbol: `S${s}${i}`, nombre: `Empresa ${s}-${i}`, sector: SECTORES[s],
        cap: (60 - s * 8 - i) * 1e9, cap_fuente: 'finnhub:metric', cap_medida_en: '2026-09-21',
        serie: serie(base, 21, drift),
        ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: base * 0.9 },
        ytd_motivo: null, puntos: 180, precio: base * (1 + drift), fecha_precio: '2026-09-18',
      });
    }
  }
  // Uno sin serie y uno sin ancla YTD: los dos huecos que el mapa tiene que
  // saber decir en voz alta.
  cs.push({ symbol: 'SINSERIE', nombre: 'Sin serie', sector: 'XLK', cap: 5e9,
    cap_fuente: 'neon:arena_market_cap', serie: [], ytd: null, ytd_motivo: 'no_hay_serie', puntos: 0, precio: null, fecha_precio: null });
  cs.push({ symbol: 'SINYTD', nombre: 'Sin ancla', sector: 'XLF', cap: 4e9,
    cap_fuente: 'finnhub:metric', serie: serie(30, 21, 0.02), ytd: null,
    ytd_motivo: 'la serie empieza en 2026-07-01 y no llega al año anterior: no hay cierre de fin de año contra el cual anclar',
    puntos: 55, precio: 30.6, fecha_precio: '2026-09-18' });
  return cs;
}
const FIXTURES = {
  us: {
    mapa: 'us', bolsa: 'us', cuadros: cuadrosUs(),
    mas: { n: 253, cap: 4.2e12, pct: 18.7, sin_cap_excluidos: 12, nota: '12 nombres quedan fuera del porcentaje porque no tienen capitalización medida' },
    fuente: { cuadros: 'neon:mercado_universo_us (sector y cap)', series: 'neon:mercado_precios_us (cierre y cierre ajustado, cosecha diaria)' },
    faltantes: { total: 2, por_motivo: { no_hay_serie: 1, sin_ancla_ytd: 1 }, ejemplos: [] },
    periodos: ['1D', '1S', '1M', 'YTD'], generado_en: '2026-09-21T22:00:00.000Z',
  },
  mx: {
    mapa: 'mx', bolsa: 'mx',
    cuadros: [
      { symbol: 'WALMEX', nombre: 'Wal-Mart de México', sector: 'Consumo', serie_liquida: 'WALMEX*',
        cap: 7.9e11, cap_fuente: 'calc (acciones × precio / unidades)', estado: 'verificada', via: 'individual',
        etiqueta: 'cap: calc · verificada vs yahoo-finance-market-cap-intraday', acciones_por_unidad: 1,
        serie: serie(60, 21, 0.015), ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 54 },
        puntos: 180, precio: 60.9, fecha_precio: '2026-09-18' },
      { symbol: 'AMX', nombre: 'América Móvil', sector: 'Comunicaciones', serie_liquida: 'AMXB',
        cap: 1.1e12, cap_fuente: 'calc (acciones × precio / unidades)', estado: 'verificada_por_metodo', via: 'metodo',
        etiqueta: 'cap: calc · método validado (3 muestras ≤2%)', acciones_por_unidad: 1,
        serie: serie(19, 21, -0.01), ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 17.5 },
        puntos: 180, precio: 18.8, fecha_precio: '2026-09-18' },
      { symbol: 'FEMSA', nombre: 'FEMSA', sector: 'Consumo', serie_liquida: 'FEMSAUBD',
        cap: null, cap_fuente: null, estado: 'gris_punteado', via: 'requiere_desglose',
        motivo: 'series con precio distinto, sin desglose: UB y UBD cotizan a 165 y 207.66, y el XBRL da un total sin desglose por serie',
        acciones_por_unidad: 5, serie: serie(207, 21, 0.004), ytd: null, ytd_motivo: null, puntos: 180, precio: 207.66, fecha_precio: '2026-09-18' },
    ],
    mas: null,
    fuente: { cuadros: 'emisoras.json + xbrl_reports (acciones) + bmv_precios (precio)', series: 'neon:bmv_precios (cierre diario por serie)' },
    cosecha: { ultima_fecha: '2026-09-18', sesiones_de_atraso: 0, alerta: false, lectura: null },
    faltantes: { total: 1, por_motivo: { requiere_desglose: 1 }, ejemplos: [] },
    periodos: ['1D', '1S', '1M', 'YTD'], generado_en: '2026-09-21T22:00:00.000Z',
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidosApi = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/mercado-mapa') {
    pedidosApi++;
    const m = url.searchParams.get('map') === 'mx' ? 'mx' : 'us';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(FIXTURES[m]));
  }
  const p = url.pathname === '/mercado' ? '/mercado.html' : url.pathname;
  try {
    const buf = await readFile(join(ROOT, p.replace(/^\//, '')));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
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

// El binario que trae el entorno. Se busca en vez de fijarse: la versión
// viene en el nombre de la carpeta y cambia con la imagen.
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
  // ══════════ MÓVIL 390 px, con TAP REAL ══════════
  console.log('\n── 390 × 844, táctil ──');
  const movil = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const p = await movil.newPage();
  const errores = [];
  p.on('pageerror', (e) => errores.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  await p.goto(`${BASE}/mercado`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.cuadro');

  chequeo('la página carga sin errores de consola', errores.length === 0, errores.slice(0, 2).join(' | '));

  const scroll = await p.evaluate(() => ({
    h: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    v: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  }));
  chequeo('sin scroll horizontal a 390 px', !scroll.h);
  chequeo('sin scroll vertical: el mapa cabe en la pantalla', !scroll.v);

  const taps = await p.evaluate(() => {
    const sel = ['nav button', '.toggle button', '#cerrar'];
    const malos = [];
    for (const s of sel) for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) malos.push(`${s}[${el.textContent.trim()}] ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return malos;
  });
  chequeo('todo control interactivo mide ≥44 px', taps.length === 0, taps.join(', '));

  const nSectores = await p.locator('.cuadro').count();
  chequeo('el primer nivel son sectores, no 300 cuadros', nSectores <= 12, `${nSectores} cuadros`);

  const sectoresTocables = await p.evaluate(() => [...document.querySelectorAll('.cuadro')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).length);
  chequeo('cada sector es tocable (≥44 px)', sectoresTocables === 0, `${sectoresTocables} chicos`);

  // TAP REAL en un sector → entra
  const pedidosAntes = pedidosApi;
  await p.locator('.cuadro').first().tap();
  await p.waitForSelector('.volver');
  chequeo('un tap en un sector entra a sus nombres', (await p.locator('.volver').count()) === 1);
  chequeo('entrar a un sector es estado en la URL', p.url().includes('sector='));

  // TAP REAL en un nombre → hoja
  await p.locator('.cuadro').first().tap();
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hoja = await p.locator('#hojaCuerpo').innerText();
  chequeo('un tap en un nombre abre la hoja', hoja.length > 20);
  chequeo('la hoja declara la fuente de la capitalización', /fuente de la cap/i.test(hoja));
  chequeo('la hoja lleva el % con su etiqueta de periodo', (await p.locator('.hoja .qd-pct-per').count()) > 0);
  chequeo('el toggle no volvió a pedir el mapa', pedidosApi === pedidosAntes, `${pedidosApi - pedidosAntes} peticiones nuevas`);

  await p.locator('#cerrar').tap();
  await p.locator('.volver').tap();
  await p.waitForSelector('.cuadro');

  // El toggle cambia el periodo SIN pedir nada
  const antesToggle = pedidosApi;
  await p.locator('.toggle button[data-per="YTD"]').tap();
  await p.waitForTimeout(150);
  chequeo('cambiar a YTD no pide el mapa de nuevo', pedidosApi === antesToggle);
  chequeo('el periodo viaja en la URL', p.url().includes('periodo=YTD'));

  // El hueco con su causa: SINSERIE tiene que decir por qué
  await p.goto(`${BASE}/mercado?mapa=us&periodo=YTD&sector=XLK&symbol=SINSERIE`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hojaHueco = await p.locator('#hojaCuerpo').innerText();
  chequeo('un cuadro sin dato dice "—"', /—/.test(hojaHueco));
  chequeo('y dice POR QUÉ no hay dato', (await p.locator('.hoja .motivo').count()) === 1, hojaHueco.slice(0, 60).replace(/\n/g, ' '));

  // México: el chip cambia de bolsa y el gris lleva su motivo
  await p.goto(`${BASE}/mercado?mapa=mx&periodo=1M`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.cuadro');
  const chipMx = await p.locator('#chip').innerText();
  chequeo('el chip de estado es el de la BMV en el mapa MX', /BMV/.test(chipMx), chipMx);

  await p.goto(`${BASE}/mercado?mapa=mx&periodo=1M&symbol=FEMSA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const femsa = await p.locator('#hojaCuerpo').innerText();
  chequeo('FEMSA sale gris CON su motivo, no gris a secas', /sin desglose/.test(femsa));

  await p.goto(`${BASE}/mercado?mapa=us&periodo=1D`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.cuadro');
  await p.screenshot({ path: join(OUT, 'mercado-390.png') });
  console.log(`  → ${join(OUT, 'mercado-390.png')}`);

  // Una tercera captura: adentro de un sector y con la hoja abierta. Es
  // donde se ve la regla que más importa — el "—" con su causa — y donde un
  // cuadro chico o un texto cortado se notarían.
  await p.goto(`${BASE}/mercado?mapa=us&periodo=YTD&sector=XLF&symbol=SINYTD`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  await p.waitForTimeout(250);
  await p.screenshot({ path: join(OUT, 'mercado-390-hoja.png') });
  console.log(`  → ${join(OUT, 'mercado-390-hoja.png')}`);
  await movil.close();

  // ══════════ ESCRITORIO 1440 px, con HOVER ══════════
  console.log('\n── 1440 × 900, puntero fino ──');
  const esc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const d = await esc.newPage();
  await d.goto(`${BASE}/mercado?mapa=us&periodo=1M`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.cuadro');

  const scrollD = await d.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1);
  chequeo('escritorio sin scroll: el mapa cabe en 1440×900', !scrollD);

  await d.locator('.cuadro').first().hover();
  await d.waitForTimeout(120);
  const tipVisible = await d.evaluate(() => getComputedStyle(document.getElementById('tip')).display !== 'none');
  chequeo('el hover muestra el tooltip en puntero fino', tipVisible);
  const tipTxt = await d.locator('#tip').innerText();
  chequeo('el tooltip también lleva la etiqueta de periodo', (await d.locator('#tip .qd-pct-per').count()) > 0, tipTxt.replace(/\n/g, ' '));

  await d.locator('.cuadro').first().click();
  await d.waitForSelector('.volver');
  await d.locator('.cuadro').first().click();
  await d.waitForSelector('.hoja[data-abierta="1"]');
  // La hoja entra con una transición de 180 ms: medirla antes de que termine
  // da la posición de salida y una comprobación que pasa por accidente.
  await d.waitForFunction(() => {
    const r = document.getElementById('hoja').getBoundingClientRect();
    return Math.abs(r.right - window.innerWidth) < 2;
  }, null, { timeout: 2000 });
  const panel = await d.evaluate(() => {
    const r = document.getElementById('hoja').getBoundingClientRect();
    return { izq: Math.round(r.left), der: Math.round(r.right), ancho: Math.round(r.width), vp: window.innerWidth };
  });
  chequeo('en escritorio la hoja es un panel lateral, pegado al borde y DENTRO de la pantalla',
    panel.ancho > 300 && panel.der === panel.vp && panel.izq > 0, JSON.stringify(panel));

  await d.goto(`${BASE}/mercado?mapa=us&periodo=1M`, { waitUntil: 'networkidle' });
  await d.waitForSelector('.cuadro');
  await d.screenshot({ path: join(OUT, 'mercado-1440.png') });
  console.log(`  → ${join(OUT, 'mercado-1440.png')}`);
  await esc.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${ok.length} comprobaciones en verde, ${fallos.length} en rojo`);
if (fallos.length) { console.log('ROJAS:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
