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
// La tabla termina el VIERNES 18 a propósito: es el caso que rompió en el
// teléfono — lunes por la tarde, cosecha del día aún sin correr.
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
  // El caso TSM: cap SIN verificar pero con precio. Antes desaparecía del
  // mapa; ahora tiene que salir gris punteado, con ticker y "—", y su causa
  // al tocarlo.
  cs.push({ symbol: 'TSMG', nombre: 'ADR sin cap verificada', sector: 'XLK', cap: null,
    cap_fuente: null, estado: 'gris_punteado', cap_auditable: true, cap_moneda: 'TWD',
    motivo: 'la cap declarada viene en TWD, no en USD',
    serie: serie(200, 21, 0.01), ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 180 },
    ytd_motivo: null, puntos: 180, precio: 202, fecha_precio: '2026-09-18' });
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
    faltantes: { total: 3, por_motivo: { no_hay_serie: 1, sin_ancla_ytd: 1, cap_sin_verificar: 1 },
      sin_precio: 1, sin_periodo: 0, sin_ancla_ytd: 1, sin_cap_verificada: 1, ejemplos: [] },
    periodos: ['1D', '1S', '1M', 'YTD'], generado_en: '2026-09-21T22:00:00.000Z',
    ultimo_cierre: '2026-09-18',
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
    ultimo_cierre: '2026-09-18',
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
let pedidosApi = 0;
let roto = false;
let sinAuditar = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // EL INTERRUPTOR VIVE EN EL SERVIDOR DE PRUEBA, NO EN LA PÁGINA. Se probó
  // primero con `?mapa=roto` en la URL y no servía: la página normaliza el
  // mapa a us|mx, así que el fixture roto nunca se pedía. Meter un gancho en
  // mercado.html para que lo aceptara habría sido poner código de prueba en
  // producción — el interruptor se queda de este lado.
  if (url.pathname === '/__romper') {
    roto = url.searchParams.get('v') === '1';
    res.writeHead(200); return res.end('ok');
  }
  if (url.pathname === '/__sin-auditar') {
    sinAuditar = url.searchParams.get('v') === '1';
    res.writeHead(200); return res.end('ok');
  }
  if (url.pathname === '/api/mercado-mapa') {
    pedidosApi++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // La respuesta que da el endpoint de verdad cuando una lectura falla:
    // así llegó a producción, con un `filter` sobre `row_number()`.
    if (sinAuditar) {
      // Como quedará prod el día del despliegue: columnas nuevas vacías, así
      // que todos los cuadros grises CON RAZÓN y ningún hallazgo.
      const f = JSON.parse(JSON.stringify(FIXTURES.us));
      f.auditoria = {
        total: f.cuadros.length, verificadas: 0, sin_auditar: f.cuadros.length, hallazgos: 0,
        aviso: `la capitalización no está auditada todavía en ${f.cuadros.length} de ${f.cuadros.length} emisoras: corré /api/mercado-r0?job=universo hasta que ?job=auditoria-cap reporte sin_moneda 0`,
      };
      return res.end(JSON.stringify(f));
    }
    if (roto) {
      return res.end(JSON.stringify({
        mapa: 'us', cuadros: [], mas: null,
        error: 'no se pudieron leer los datos del mapa',
        detalle: { mercado_precios_us: 'Neon: syntax error at or near "filter"' },
      }));
    }
    const m = url.searchParams.get('map') === 'mx' ? 'mx' : 'us';
    return res.end(JSON.stringify(FIXTURES[m]));
  }
  const p = url.pathname === '/mercado' ? '/mercado.html' : url.pathname;
  try {
    const buf = await readFile(join(ROOT, p.replace(/^\//, '')));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('no'); }
});

// ── EL RELOJ, FIJO ───────────────────────────────────────────────────
// El caso que rompió en el teléfono: **lunes 17:00 CT con la tabla al
// viernes**. Sin fijar el reloj, el chip diría "abierto" o "cerrado" según
// la hora a la que alguien corra el script, y la comprobación del chip
// pasaría o fallaría por motivos que no son el código.
const MOMENTO = Date.parse('2026-09-21T23:00:00Z');   // lunes 17:00 CT / 19:00 ET
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
  await movil.addInitScript(RELOJ_FIJO);
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
  chequeo('al abrir se ven EMPRESAS, no sólo sectores', nSectores >= 20, `${nSectores} cuadros`);
  chequeo('hay cabeceras de sector', (await p.locator('.cabecera').count()) >= 3);
  chequeo('NO existe el cuadro "+N más": se pintan todas', (await p.locator('.cuadro.resto').count()) === 0);

  // TODO SECTOR CON EMPRESAS MUESTRA AL MENOS SU MAYOR CON NOMBRE. El mapa
  // llegó a enseñar "Industrial: +55 más · 100%" — un sector entero sin una
  // sola empresa. Si hay 55, la mayor tiene que aparecer con su ticker.
  const sectores = await p.evaluate(() => {
    const cabs = [...document.querySelectorAll('.cabecera')];
    const cuadros = [...document.querySelectorAll('.cuadro')].map((e) => ({
      x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight,
      txt: (e.querySelector('.sym') || {}).textContent || '',
    }));
    return cabs.map((c) => {
      // Los cuadros que caen bajo esta cabecera, por geometría.
      const x0 = c.offsetLeft, x1 = x0 + c.offsetWidth, y0 = c.offsetTop;
      const mios = cuadros.filter((q) => q.x >= x0 - 1 && q.x < x1 && q.y >= y0);
      return { sector: c.textContent, n: mios.length, conNombre: mios.filter((q) => q.txt).length };
    });
  });
  chequeo('todo sector dibujado tiene al menos una empresa con nombre',
    sectores.length > 0 && sectores.every((s) => s.n === 0 || s.conNombre >= 1),
    JSON.stringify(sectores.filter((s) => s.n > 0 && s.conNombre === 0)));

  // Los cuadros chicos EXISTEN y se tocan; simplemente no llevan letra.
  const chicos = await p.evaluate(() => {
    const cs = [...document.querySelectorAll('.cuadro')];
    const sinTexto = cs.filter((e) => !(e.querySelector('.sym') || {}).textContent);
    return { total: cs.length, sinTexto: sinTexto.length, todosTocables: sinTexto.every((e) => e.onclick !== undefined) };
  });
  // LA REGLA ES "TODAS", no "muchas": se comparan los cuadros dibujados
  // contra los que el fixture trae con capitalización. Un umbral redondo
  // (">= 60") habría pasado con 60 de 300.
  // "TODAS" son las que YA son cuadros: con cap verificada, o con precio y la
  // cap gris. Las que no tienen precio no son cuadros todavía.
  const dibujables = FIXTURES.us.cuadros.filter(
    (c) => (Number.isFinite(c.cap) && c.cap > 0) || Number.isFinite(c.precio)).length;
  chequeo('se dibujan TODAS las que ya son cuadros, no un recorte',
    chicos.total === dibujables, `${chicos.total} dibujados de ${dibujables} dibujables`);
  chequeo('los cuadros sin letra siguen siendo tocables', chicos.todosTocables, JSON.stringify(chicos));

  // REGLA 5: cero logos en el mapa. Ni <img>, ni background-image.
  const imgs = await p.evaluate(() => {
    const cont = document.getElementById('lienzo') || document.body;
    const conFondo = [...cont.querySelectorAll('*')].filter((e) => /url\(/.test(getComputedStyle(e).backgroundImage || ''));
    return { imgs: cont.querySelectorAll('img').length, conFondo: conFondo.length };
  });
  chequeo('cero logos en el mapa: ni <img> ni background-image',
    imgs.imgs === 0 && imgs.conFondo === 0, JSON.stringify(imgs));

  // NINGUNA etiqueta cortada a mitad de palabra.
  const cortadas = await p.evaluate(() => {
    const malas = [];
    for (const el of document.querySelectorAll('.cabecera')) {
      const t = el.textContent.trim();
      if (!t) continue;
      if (el.scrollWidth > el.clientWidth + 1) malas.push(t + ' (se desborda)');
      const full = el.getAttribute('title') || '';
      if (t && full && !full.startsWith(t) && !/\.$/.test(t)) malas.push(t + ' ≠ ' + full);
    }
    return malas;
  });
  chequeo('ninguna cabecera queda cortada a mitad de palabra', cortadas.length === 0, cortadas.join(' | '));

  // El chip tiene que hablar del DATO: la tabla termina el viernes.
  const chipUs = await p.locator('#chip').innerText();
  chequeo('el chip dice el cierre que se está viendo, no el que el calendario espera',
    /cierre del viernes/.test(chipUs), chipUs);

  // Y el mapa NO está vacío aunque falte el cierre de hoy: 1D se calcula
  // sobre lo que HAY —viernes contra jueves—, no sobre lo que el calendario
  // dice que debería haber.
  const pintados = await p.evaluate(() => {
    const vals = [...document.querySelectorAll('.cuadro:not(.resto) .val')].map((e) => e.textContent.trim());
    return { total: vals.length, conPct: vals.filter((v) => /%$/.test(v)).length, sinDato: vals.filter((v) => v === '—').length };
  });
  chequeo('con la tabla al viernes, 1D se pinta igual (último cierre vs el anterior)',
    pintados.conPct >= 15 && pintados.sinDato === 0, JSON.stringify(pintados));

  // TAP REAL en la cabecera → abre el sector
  const pedidosAntes = pedidosApi;
  await p.locator('.cabecera').first().tap();
  await p.waitForSelector('.volver');
  chequeo('un tap en la cabecera de sector abre ese sector', (await p.locator('.volver').count()) === 1);
  chequeo('entrar a un sector es estado en la URL', p.url().includes('sector='));

  // TAP REAL en un nombre → hoja
  await p.locator('.cuadro').first().tap();
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hoja = await p.locator('#hojaCuerpo').innerText();
  chequeo('un tap en un nombre abre la hoja', hoja.length > 20);
  chequeo('la hoja declara la fuente de la capitalización', /fuente de la cap/i.test(hoja));
  // Regla 5: en la hoja, iniciales en mono — nunca un hueco ni un ícono roto.
  chequeo('la hoja lleva las iniciales del ticker, no un logo',
    (await p.locator('.hoja .iniciales').count()) === 1
    && (await p.locator('.hoja img').count()) === 0,
    (await p.locator('.hoja .iniciales').first().textContent().catch(() => '')));
  chequeo('la hoja lleva el % con su etiqueta de periodo', (await p.locator('.hoja .qd-pct-per').count()) > 0);
  chequeo('el toggle no volvió a pedir el mapa', pedidosApi === pedidosAntes, `${pedidosApi - pedidosAntes} peticiones nuevas`);

  await p.locator('#cerrar').tap();
  await p.locator('.volver').tap();
  await p.waitForSelector('.cabecera');

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

  // ── UNA CAP SIN VERIFICAR SE VE, CON SU CAUSA ──────────────────────
  // Antes se filtraba por `cap > 0` y la emisora salía AUSENTE del mapa: el
  // único rastro era un número en el pie. Un cuadro que no está no tiene
  // dónde decir por qué le falta el dato.
  await p.goto(`${BASE}/mercado?mapa=us&sector=XLK&symbol=TSMG`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hojaGris = await p.locator('#hojaCuerpo').innerText();
  chequeo('la hoja de una cap sin verificar dice su causa', /TWD/.test(hojaGris), hojaGris.slice(0, 80).replace(/\n/g, ' '));
  await p.locator('#cerrar').tap();

  const gris = await p.evaluate(() => {
    const e = [...document.querySelectorAll('.cuadro')].find((x) => x.getAttribute('aria-label') === 'TSMG');
    if (!e) return { existe: false };
    return {
      existe: true,
      punteado: e.classList.contains('punteado'),
      ticker: ((e.querySelector('.sym') || {}).textContent || ''),
      valor: ((e.querySelector('.val') || {}).textContent || ''),
      ancho: Math.round(e.getBoundingClientRect().width),
    };
  });
  chequeo('una cap sin verificar se DIBUJA gris punteada, no desaparece',
    gris.existe === true && gris.punteado === true, JSON.stringify(gris));
  chequeo('la gris lleva su ticker y "—", nunca un % sobre un tamaño prestado',
    gris.ticker === 'TSMG' && gris.valor === '—', JSON.stringify(gris));

  // ── EL PIE CUENTA CUADROS ──────────────────────────────────────────
  await p.goto(`${BASE}/mercado?mapa=us`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.cabecera');
  const pie = await p.locator('#pie').innerText();
  chequeo('el pie dice "sin capitalización verificada", no "cuadros sin dato completo"',
    /sin capitalización verificada/.test(pie) && !/cuadros sin dato completo/.test(pie), pie);
  chequeo('y no le suma los símbolos sin precio, que no son cuadros todavía',
    /1 sin capitalización verificada/.test(pie), pie);

  // México: el chip cambia de bolsa y el gris lleva su motivo
  await p.goto(`${BASE}/mercado?mapa=mx&periodo=1M`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.cuadro');
  const chipMx = await p.locator('#chip').innerText();
  chequeo('el chip de estado es el de la BMV en el mapa MX', /BMV/.test(chipMx), chipMx);

  await p.goto(`${BASE}/mercado?mapa=mx&periodo=1M&symbol=FEMSA`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const femsa = await p.locator('#hojaCuerpo').innerText();
  chequeo('FEMSA sale gris CON su motivo, no gris a secas', /sin desglose/.test(femsa));

  // ── EL MAPA ROTO: QUE SE VEA ROTO, Y QUE EL CHIP SE CALLE ──────────
  // Con la consulta reventada el mapa salió gris en el teléfono y el chip
  // SIGUIÓ diciendo "cierre del lunes": un día que el calendario suponía y
  // que ningún dato respaldaba. Caer al texto del reloj era el mismo pecado
  // por la puerta de atrás.
  await fetch(`${BASE}/__romper?v=1`);
  await p.goto(`${BASE}/mercado?mapa=us&periodo=1D`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(150);
  const roto = await p.evaluate(() => ({
    error: (document.querySelector('.aviso[data-error="1"]') || {}).textContent || '',
    chip: (document.getElementById('chip') || {}).textContent || '',
    titulo: (document.getElementById('chip') || {}).title || '',
  }));
  chequeo('una lectura que falla se reporta como ROTA, no como "sin datos"',
    /no se pudieron leer/.test(roto.error), roto.error.trim().slice(0, 60));
  chequeo('y el mensaje nombra la tabla y el error de Postgres',
    /mercado_precios_us/.test(roto.error) && /filter/.test(roto.error));
  chequeo('sin dato, el chip NO nombra un día que nada respalda',
    !/cierre del/.test(roto.chip), roto.chip.trim());
  chequeo('y el chip dice por qué no lo nombra', /no viajó/.test(roto.titulo), roto.titulo);

  // ── UN MAPA GRIS POR FALTA DE CORRIDA SE EXPLICA SOLO ─────────────
  await fetch(`${BASE}/__sin-auditar?v=1`);
  await p.goto(`${BASE}/mercado?mapa=us&periodo=1D`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(150);
  const aviso = await p.evaluate(() => {
    const e = document.getElementById('aviso');
    return { visible: !!e && getComputedStyle(e).display !== 'none', txt: e ? e.textContent : '' };
  });
  chequeo('un mapa sin auditar lo DICE, no se hace el gris misterioso',
    aviso.visible && /no está auditada todavía/.test(aviso.txt), aviso.txt.slice(0, 70));
  chequeo('y el aviso dice exactamente qué correr', /job=universo/.test(aviso.txt));
  await fetch(`${BASE}/__sin-auditar?v=0`);

  await fetch(`${BASE}/__romper?v=0`);
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
  await esc.addInitScript(RELOJ_FIJO);
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

  // En escritorio el primer nivel también son empresas: un clic en un cuadro
  // abre su hoja directamente; el sector se abre desde la cabecera.
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
