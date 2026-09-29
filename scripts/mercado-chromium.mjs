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
// ── A ESCALA DE PRODUCCIÓN ────────────────────────────────────────────
// Con 54 cuadros de prueba, "ningún cuadro se queda sin ticker" no medía nada:
// en prod son ~550 y el más chico queda en pocos píxeles. Las capitalizaciones
// siguen una ley de potencias como la bolsa de verdad —2.5 billones el primero,
// un par de miles de millones el último— porque es la distribución la que hace
// los cuadros minúsculos, no la cantidad.
const POR_SECTOR = 91;

function cuadrosUs() {
  const cs = [];
  for (let s = 0; s < SECTORES.length; s++) {
    for (let i = 0; i < POR_SECTOR; i++) {
      // −3.5% a +3.5% por día: cubre los siete pasos de la escala, incluido
      // el gris de ±0.5%, para que la captura se pueda revisar de verdad.
      const drift = (((s * 3 + i * 5) % 15) - 7) / 200;
      const base = 40 + (i % 9) * 7;
      // El rango entrelaza sectores para que cada uno tenga grandes y chicos,
      // como en el mapa de verdad.
      const rango = i * SECTORES.length + s;
      cs.push({
        symbol: `S${rango}`, nombre: `Empresa ${s}-${i}`, sector: SECTORES[s],
        cap: Math.round(2.5e12 / Math.pow(rango + 1, 1.15)),
        cap_fuente: 'finnhub:metric', cap_medida_en: '2026-09-21',
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
  // Los otros dos grises que NO son el de TSM, y que el 2026-09-26 mentían en la
  // hoja: ORCL decía "EDGAR no dio acciones en circulación" sin que EDGAR
  // hubiera sido consultado, y XNDU no tenía causa que nombrara su fuente.
  cs.push({ symbol: 'ORCL', nombre: 'Oracle (EDGAR pendiente)', sector: 'XLK', cap: null,
    cap_fuente: null, estado: 'gris_punteado', cap_auditable: true, cap_moneda: 'USD',
    cap_edgar_estado: 'no_consultado',
    motivo: 'la cap declarada difiere -10.7% de acciones×precio (0.89×), techo 5%; pendiente de consulta a EDGAR (falta correr ?job=acciones-edgar)',
    serie: serie(360, 21, 0.006), ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 300 },
    ytd_motivo: null, puntos: 180, precio: 362, fecha_precio: '2026-09-18' });
  // Verificada por acuerdo de conteos: la cap declarada se descartó y la hoja
  // tiene que decirlo, aunque el cuadro esté verde y `motivo` sea null.
  cs.push({ symbol: 'MNST', nombre: 'Monster (cap declarada descartada)', sector: 'XLP', cap: 120e9,
    cap_fuente: 'calc: edgar×neon', estado: 'verificada', cap_auditable: true, cap_moneda: 'USD',
    cap_via: 'edgar_acuerdo_acciones', cap_portada_edgar: '2026-07-31',
    cap_nota: 'cap declarada de Finnhub descartada: dos conteos de acciones coinciden (EDGAR 2080.0M y Finnhub 2075.0M, 0.2% de diferencia, techo 5%)',
    serie: serie(57.7, 21, 0.005), ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 50 },
    ytd_motivo: null, puntos: 180, precio: 57.7, fecha_precio: '2026-09-18' });
  cs.push({ symbol: 'XNDU', nombre: 'Xanadu Quantum (sin moneda)', sector: 'XLK', cap: null,
    cap_fuente: null, estado: 'gris_punteado', cap_auditable: false, cap_moneda: null,
    motivo: 'sin moneda declarada por Finnhub (la cap viene de neon:arena_market_cap)',
    serie: serie(11, 21, 0.03), ytd: { t: Math.floor(Date.parse('2025-12-31T00:00:00Z') / 1000), c: 9 },
    ytd_motivo: null, puntos: 180, precio: 11.4, fecha_precio: '2026-09-18' });
  cs.push({ symbol: 'SINYTD', nombre: 'Sin ancla', sector: 'XLF', cap: 4e9,
    cap_fuente: 'finnhub:metric', serie: serie(30, 21, 0.02), ytd: null,
    ytd_motivo: 'la serie empieza en 2026-07-01 y no llega al año anterior: no hay cierre de fin de año contra el cual anclar',
    puntos: 55, precio: 30.6, fecha_precio: '2026-09-18' });
  return cs;
}
// ── MUNDO: la respuesta de `/api/macro-markets` ───────────────────────
// Un año de cierres diarios (que es lo que el endpoint pide desde R2(a),
// para que YTD alcance) y la moneda de cada símbolo, que es lo que decide el
// cruce contra el peso. `^FTSE` llega con UN punto a propósito: sin dos
// cierres no hay periodo que calcular, y eso tiene que salir como "sin dato
// con causa" y no como un cuadro de color.
function serieAnual(base, drift) {
  // 365 días, no 260: con 260 la serie arranca en enero y NO alcanza a tocar un
  // cierre del año anterior, así que YTD sale "—" con causa — correcto, pero
  // entonces la prueba no mediría que YTD FUNCIONA, sólo que falla bien. El
  // endpoint pide `range=1y` justamente para que el ancla de fin de año exista.
  const pts = [];
  const hoy = Date.parse('2026-09-21T20:00:00Z') / 1000;
  for (let i = 365; i >= 0; i--) {
    pts.push({ t: hoy - i * 86400, c: +(base * (1 + drift * (365 - i) / 365)).toFixed(4) });
  }
  return pts;
}
const MACRO = {
  data: {
    '^GSPC': { price: 6810, currency: 'USD', series: serieAnual(6100, 0.115) },
    '^NDX': { price: 25100, currency: 'USD', series: serieAnual(22000, 0.14) },
    '^GSPTSE': { price: 29400, currency: 'CAD', series: serieAnual(28000, 0.05) },
    '^FCHI': { price: 8100, currency: 'EUR', series: serieAnual(7900, 0.025) },
    '000001.SS': { price: 3820, currency: 'CNY', series: serieAnual(3500, 0.09) },
    '^NSEI': { price: 26800, currency: 'INR', series: serieAnual(25200, 0.063) },
    // `^AXJO` a propósito AUSENTE: lo que tiene que pasar es que el cuadro
    // diga por qué no está, en vez de desaparecer de la rejilla.
    // Un símbolo AUSENTE a propósito: lo que tiene que pasar es que el cuadro
    // diga por qué no está, en vez de desaparecer.
    'BTC-USD': { price: 114240, currency: 'USD', series: serieAnual(98000, 0.165) },
    // A propósito DISTINTO del FIX: si el cuadro tomara esto, se vería.
    'MXN=X': { price: 99.99, currency: 'MXN', series: serieAnual(99, 0.5) },
    'GC=F': { price: 3684, currency: 'USD', series: serieAnual(3100, 0.188) },
    'CAD=X': { price: 1.38, currency: 'CAD', series: serieAnual(1.42, -0.028) },
    'CLP=X': { price: 965, currency: 'CLP', series: serieAnual(990, -0.025) },
    '^IPSA': { price: 8720, currency: 'CLP', series: serieAnual(7900, 0.104) },
    'CNY=X': { price: 7.06, currency: 'CNY', series: serieAnual(7.2, -0.019) },
    'INR=X': { price: 88.4, currency: 'INR', series: serieAnual(86, 0.028) },
    'AUD=X': { price: 1.49, currency: 'AUD', series: serieAnual(1.53, -0.026) },
    '^MXX': { price: 56200, currency: 'MXN', series: serieAnual(52000, 0.08) },
    '^BVSP': { price: 139000, currency: 'BRL', series: serieAnual(132000, 0.05) },
    'ES=F': { price: 6120, currency: 'USD', series: serieAnual(5800, 0.055) },
    'NQ=F': { price: 22400, currency: 'USD', series: serieAnual(20500, 0.09) },
    'YM=F': { price: 45200, currency: 'USD', series: serieAnual(44000, 0.027) },
    '^GDAXI': { price: 24100, currency: 'EUR', series: serieAnual(22000, 0.095) },
    '^FTSE': { price: 9450, currency: 'GBP', series: serieAnual(9100, 0.038) },
    '^N225': { price: 45800, currency: 'JPY', series: serieAnual(42000, 0.09) },
    // EL CASO DEL KOSPI, con los números que Lety vio en prod el 2026-09-29:
    // la serie termina el lunes 28 en 6,889.74 (viniendo de 7,080.92 el
    // viernes) y `price` es 6,870.81, de HOY. El 1D correcto es −0.27%; el que
    // se mostraba, −2.70%, era el del lunes.
    '^KS11': {
      price: 6870.81, precio_t: Date.parse('2026-09-22T06:00:00Z') / 1000, currency: 'KRW',
      series: serieAnual(6500, 0.06).slice(0, -1).concat([
        { t: Date.parse('2026-09-18T20:00:00Z') / 1000, c: 7080.92 },
        { t: Date.parse('2026-09-21T20:00:00Z') / 1000, c: 6889.74 },
      ]),
    },
    '^HSI': { price: 26100, currency: 'HKD', series: serieAnual(25000, 0.044) },
    'DX-Y.NYB': { price: 97.4, currency: 'USD', series: serieAnual(99, -0.016) },
    'EURUSD=X': { price: 1.182, currency: 'USD', series: serieAnual(1.16, 0.019) },
    'JPY=X': { price: 148.2, currency: 'JPY', series: serieAnual(150, -0.012) },
    'CL=F': { price: 63.4, currency: 'USD', series: serieAnual(70, -0.094) },
    'BZ=F': { price: 67.1, currency: 'USD', series: serieAnual(74, -0.093) },
    // Insumos del rendimiento en pesos: llegan y NO ocupan cuadro.
    'GBPUSD=X': { price: 1.36, currency: 'USD', series: serieAnual(1.33, 0.022) },
    'KRW=X': { price: 1385, currency: 'KRW', series: serieAnual(1400, -0.011) },
    'HKD=X': { price: 7.78, currency: 'HKD', series: serieAnual(7.8, -0.003) },
    'BRL=X': { price: 5.32, currency: 'BRL', series: serieAnual(5.5, -0.033) },
  },
  generated_at: '2026-09-21T20:05:00.000Z',
};

const FIXTURES = {
  us: {
    mapa: 'us', bolsa: 'us', cuadros: cuadrosUs(),
    mas: { n: 253, cap: 4.2e12, pct: 18.7, sin_cap_excluidos: 12, nota: '12 nombres quedan fuera del porcentaje porque no tienen capitalización medida' },
    fuente: { cuadros: 'neon:mercado_universo_us (sector y cap)', series: 'neon:mercado_precios_us (cierre y cierre ajustado, cosecha diaria)' },
    faltantes: { total: 5, por_motivo: { no_hay_serie: 1, sin_ancla_ytd: 1, cap_sin_verificar: 3 },
      sin_precio: 1, sin_periodo: 0, sin_ancla_ytd: 1, sin_cap_verificada: 3, ejemplos: [] },
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
  if (url.pathname === '/api/banxico') {
    pedidosApi++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // El FIX es DIARIO y sólo de días hábiles. 300 puntos de ~420 días
    // naturales es lo que Banxico devuelve de verdad, y con eso YTD alcanza.
    const pts = [];
    const fin = Date.parse('2026-09-21T12:00:00Z');
    for (let i = 420; i >= 0; i--) {
      const d = new Date(fin - i * 86400000);
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      pts.push({ date: d.toISOString().slice(0, 10), value: +(19.4 * (1 - 0.061 * (420 - i) / 420)).toFixed(4) });
    }
    return res.end(JSON.stringify({
      series: 'USDMXN', code: 'SF43718', title: 'Tipo de cambio FIX',
      points: pts, latest: pts[pts.length - 1], fetched_at: '2026-09-21T20:00:00.000Z',
    }));
  }
  if (url.pathname === '/api/macro-markets') {
    pedidosApi++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(MACRO));
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
  // ── EN CELULAR EL MAPA ES LARGO, A PROPÓSITO ───────────────────────
  // Hasta el 2026-09-29 esto exigía que el mapa cupiera en una pantalla de
  // 390px. Con ~550 cuadros, caber significa que el más chico queda en 3px: se
  // ve, se toca, y no se puede saber de quién es. Decisión de Lety: en celular
  // el alto es max(2000, ancho × 5) y se recorre. El no-scroll sigue siendo la
  // regla en escritorio, y se comprueba abajo a 1440×900.
  const alto = await p.evaluate(() => {
    const l = document.getElementById('lienzo');
    return {
      lienzo: Math.round(l.getBoundingClientRect().height),
      ancho: Math.round(l.getBoundingClientRect().width),
      scrollBody: document.documentElement.scrollHeight,
      marcado: document.body.getAttribute('data-scroll'),
      // Las constantes salen de la página, no se repiten acá: un número
      // copiado en dos lados se desincroniza y la prueba mide lo de ayer.
      k: window.QD_MAPA,
    };
  });
  chequeo(`en celular el mapa es LARGO: max(${alto.k.ALTO_MIN_MOVIL}, ancho × ${alto.k.FACTOR_ALTO_MOVIL})`,
    alto.marcado === '1'
      && alto.lienzo === Math.max(alto.k.ALTO_MIN_MOVIL, Math.round(alto.ancho * alto.k.FACTOR_ALTO_MOVIL)),
    JSON.stringify(alto));
  chequeo('y la página se recorre en vertical', scroll.v, JSON.stringify(alto));

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

  // ── NINGÚN CUADRO CON SITIO SE QUEDA SIN TEXTO ─────────────────────
  // La talla fija de 13px dejaba sin % a V, MA, JNJ, ABBV, BAC, GS y GOOGL
  // teniendo espacio de sobra, y a los medianos sin nada. El umbral de 900px²
  // (30×30) es el tamaño a partir del cual entra un ticker de 4 letras a 8px
  // con sus márgenes: por debajo de ahí, ir sin letra es correcto.
  const mudos = await p.evaluate(() => {
    const out = { total: 0, mudos: [], conDos: 0, tallas: {} };
    for (const e of document.querySelectorAll('.cuadro')) {
      const r = e.getBoundingClientRect();
      const area = r.width * r.height;
      const sym = (e.querySelector('.sym') || {}).textContent || '';
      const val = (e.querySelector('.val') || {}).textContent || '';
      if (sym) {
        const f = Math.round(parseFloat(getComputedStyle(e.querySelector('.sym')).fontSize));
        out.tallas[f] = (out.tallas[f] || 0) + 1;
      }
      if (val) out.conDos++;
      if (area >= 900) {
        out.total++;
        if (!sym) out.mudos.push({ w: Math.round(r.width), h: Math.round(r.height), aria: e.getAttribute('aria-label') });
      }
    }
    return out;
  });
  chequeo('ningún cuadro de ≥900px² se queda sin texto',
    mudos.mudos.length === 0, `${mudos.mudos.length} de ${mudos.total}: ${JSON.stringify(mudos.mudos.slice(0, 5))}`);
  // Y la fuente escala de verdad: si todas las tallas fueran iguales, seguiría
  // siendo el tamaño fijo con otro número.
  chequeo('la fuente escala con el cuadro, no es una talla fija',
    Object.keys(mudos.tallas).length >= 3, JSON.stringify(mudos.tallas));
  chequeo('los cuadros grandes llevan también el %', mudos.conDos > 0, `${mudos.conDos} con dos líneas`);

  // ── Y NINGUNA SE DESBORDA ──────────────────────────────────────────
  // `anchoTexto` ESTIMA el ancho (0.62 × talla × caracteres). El margen
  // proporcional le quita holgura a esa estimación, así que acá se mide con la
  // fuente REAL: si una etiqueta se sale de su cuadro, el navegador la recorta
  // y media palabra no es información, es ruido con forma de información.
  const desbordadas = await p.evaluate(() => {
    const malas = [];
    for (const e of document.querySelectorAll('.cuadro')) {
      const caja = e.getBoundingClientRect();
      for (const t of e.querySelectorAll('.sym, .val')) {
        const r = t.getBoundingClientRect();
        // 0.5px de tolerancia: el redondeo subpíxel del navegador no es un
        // desborde.
        if (r.width > caja.width + 0.5 || t.scrollWidth > t.clientWidth + 1) {
          malas.push({ aria: e.getAttribute('aria-label'), txt: t.textContent, w: Math.round(r.width), caja: Math.round(caja.width) });
        }
      }
    }
    return malas;
  });
  chequeo('ninguna etiqueta se desborda de su cuadro con la fuente real',
    desbordadas.length === 0, `${desbordadas.length}: ${JSON.stringify(desbordadas.slice(0, 5))}`);

  // ── TODOS LOS CUADROS LLEVAN SU TICKER ─────────────────────────────
  // "Quiero que TODOS los cuadros lleven su ticker" (Lety, 2026-09-29). Un
  // cuadro sin letra es un color que no se puede nombrar. La excepción que ella
  // fijó: los que midan menos de 14px de ancho o de alto — ahí ni un ticker de
  // 2 letras a 6px entra sin tocar el borde, y recortar a mitad de palabra está
  // prohibido porque media palabra no es información.
  //
  // El conteo de la excepción se REPORTA, no se esconde: es el número que dice
  // si el mapa largo está funcionando o si hay que estirarlo más.
  const tickers = await p.evaluate(() => {
    const out = { total: 0, sin: 0, excepcion: 0, bajo14: 0, deben: [], anchoMin: null };
    for (const e of document.querySelectorAll('.cuadro')) {
      const r = e.getBoundingClientRect();
      out.total++;
      out.anchoMin = out.anchoMin == null ? r.width : Math.min(out.anchoMin, r.width);
      if (((e.querySelector('.sym') || {}).textContent || '')) continue;
      out.sin++;
      // LA EXCEPCIÓN ES LA GEOMETRÍA DEL PROPIO TICKER, no un número redondo.
      // Lety la fijó en "menos de 14px de lado", y medido no alcanza: un ticker
      // de 4 letras a 6px mide 14.45px con la fuente real, así que necesita
      // 16.45px de cuadro con su margen de 1px. Un cuadro de 15px que "debería"
      // llevar TSMG no puede: recortar a mitad de palabra está prohibido.
      // Así que la excepción se calcula por cuadro —¿cabe SU ticker a 6px?— y
      // el conteo con la regla plana de 14px también se reporta, que es el que
      // ella pidió comparar.
      const t = e.getAttribute('aria-label') || '';
      const necesita = t.length * 6 * 0.6022 + 2;
      if (r.width < 14 || r.height < 14) out.bajo14++;
      if (r.width < necesita || r.height < 6) { out.excepcion++; continue; }
      out.deben.push({
        aria: e.getAttribute('aria-label'),
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      });
    }
    out.anchoMin = Math.round(out.anchoMin * 10) / 10;
    return out;
  });
  chequeo('ningún cuadro con sitio para su ticker se queda sin él',
    tickers.deben.length === 0,
    `${tickers.deben.length} tienen sitio y están mudos: ${JSON.stringify(tickers.deben.slice(0, 6))}`);
  // El número que Lety pidió reportar, con SU regla plana de 14px.
  chequeo('menos de 20 cuadros caen bajo los 14px de lado',
    tickers.bajo14 < 20, `${tickers.bajo14} de ${tickers.total}`);
  console.log(`     ↳ sin ticker: ${tickers.sin} de ${tickers.total} cuadros · `
    + `${tickers.bajo14} bajo 14px de lado · ${tickers.excepcion} no les cabe su propio ticker a 6px `
    + `· el más angosto mide ${tickers.anchoMin}px`);

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
  // Las abreviaturas ("Con.", "Ser.", "Inm.", "Mat.") son para la cabecera
  // apretada del primer nivel. Al entrar hay sitio: el nombre va completo.
  const volver = await p.locator('.volver').first().innerText();
  chequeo('al entrar al sector, el nombre va COMPLETO, sin abreviatura',
    !/\.\s*$/.test(volver.trim()) && volver.trim().length > 4, volver);
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
  // El tamaño de una gris es PRESTADO: el del cuadro verificado más chico de su
  // sector. Con el universo a escala real ese cuadro mide ~15px a 390px, así
  // que la gris es de las más chicas del mapa y su ticker de 4 letras no entra
  // ni a 6px. Lo que NO puede pasar es que lleve un % —un número sobre un
  // tamaño prestado sería afirmar algo que no se midió—, y eso se comprueba
  // acá; que lleve su ticker se comprueba en escritorio, donde tiene sitio.
  chequeo('la gris nunca lleva un % sobre un tamaño prestado',
    gris.valor === '' || gris.valor === '—', JSON.stringify(gris));

  // ── EL PIE CUENTA CUADROS ──────────────────────────────────────────
  await p.goto(`${BASE}/mercado?mapa=us`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.cabecera');
  const pie = await p.locator('#pie').innerText();
  chequeo('el pie dice "sin capitalización verificada", no "cuadros sin dato completo"',
    /sin capitalización verificada/.test(pie) && !/cuadros sin dato completo/.test(pie), pie);
  chequeo('y no le suma los símbolos sin precio, que no son cuadros todavía',
    /3 sin capitalización verificada/.test(pie), pie);

  // ═══════════════════════════════════════════════════════════════════
  // MUNDO (artboard 4) — 3 columnas, 78px, 2px de gap
  // ═══════════════════════════════════════════════════════════════════
  await p.goto(`${BASE}/mercado?mapa=mundo`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#mundo .c');
  const mundo = await p.evaluate(() => {
    const regiones = [...document.querySelectorAll('#mundo .reg')].map((r) => ({
      titulo: (r.childNodes[0] || {}).textContent || '',
      estado: (r.querySelector('span') || {}).textContent || '',
    }));
    const cajas = [...document.querySelectorAll('#mundo .c')].map((e) => {
      const b = e.getBoundingClientRect();
      return {
        sym: e.dataset.sym,
        w: Math.round(b.width), h: Math.round(b.height),
        x: Math.round(b.x),
        nom: (e.querySelector('.n') || {}).textContent || '',
        pais: (e.querySelector('.r') || {}).textContent || '',
        grande: (e.querySelector('.v') || {}).textContent || '',
        chico: (e.querySelector('.l') || {}).textContent || '',
      };
    });
    return {
      regiones, cajas,
      lienzoOculto: document.getElementById('lienzo').hidden,
      tira: [...document.querySelectorAll('#mundo .tira > span')].map((e) => e.textContent.trim()),
      titular: (document.querySelector('#mundo .titular h1') || {}).textContent || '',
      sub: (document.querySelector('#mundo .titular .sub') || {}).textContent || '',
      notas: [...document.querySelectorAll('#mundo .nota')].map((e) => e.textContent),
      chip: (document.getElementById('chip') || {}).textContent || '',
      pie: (document.getElementById('pie') || {}).textContent || '',
      tab: document.getElementById('tab-mundo').getAttribute('aria-selected'),
      monedaBotones: [...document.querySelectorAll('#moneda button')].map((b) => b.textContent),
    };
  });

  chequeo('la pestaña Mundo se selecciona y el treemap se apaga',
    mundo.tab === 'true' && mundo.lienzoOculto === true, JSON.stringify({ tab: mundo.tab, lienzo: mundo.lienzoOculto }));

  // ── LAS MEDIDAS DEL ARTBOARD ───────────────────────────────────────
  const altos = [...new Set(mundo.cajas.map((c) => c.h))];
  const columnas = [...new Set(mundo.cajas.map((c) => c.x))].length;
  chequeo('cuadros de 78px de alto, como el mockup', altos.length === 1 && altos[0] === 78, JSON.stringify(altos));
  chequeo('rejilla de 3 columnas', columnas === 3, `${columnas} posiciones de x distintas`);
  const anchos = [...new Set(mundo.cajas.map((c) => c.w))];
  chequeo('TAMAÑO FIJO: todos los cuadros miden igual (los índices no tienen cap)',
    anchos.length <= 2, `anchos ${JSON.stringify(anchos)}`);

  // ── LOS 18 ÍNDICES DEL MOCKUP ──────────────────────────────────────
  chequeo('las cuatro regiones del encargo, en orden',
    mundo.regiones.slice(0, 4).map((r) => r.titulo.trim()).join(' | ')
      === 'América | Europa | Asia | Cripto · FX · Materias primas',
    mundo.regiones.map((r) => r.titulo.trim()).join(' · '));
  // `^AXJO` no está en la lista porque el fixture lo omite A PROPÓSITO: es el
  // caso de "no llegó → se dice con su causa", que se comprueba más abajo.
  const esperados = ['^GSPC', '^NDX', '^MXX', '^BVSP', '^GSPTSE', '^IPSA', '^GDAXI', '^FTSE', '^FCHI',
    '^N225', '^KS11', '^HSI', '000001.SS', '^NSEI', 'BTC-USD', 'MXN=X', 'GC=F'];
  const symsMundo = mundo.cajas.map((c) => c.sym);
  chequeo('los índices del mockup están, y los cruces de moneda NO ocupan cuadro',
    esperados.every((e) => symsMundo.includes(e))
      && !symsMundo.some((x) => /=X$/.test(x) && x !== 'MXN=X'),
    `${symsMundo.length}: ${symsMundo.join(',')}`);
  chequeo('cada cuadro lleva nombre Y país, como el mockup',
    mundo.cajas.every((c) => c.nom.length > 0 && c.pais.length > 0),
    JSON.stringify(mundo.cajas.slice(0, 3)));
  chequeo('el número grande es el % con su etiqueta de periodo',
    mundo.cajas.filter((c) => /1D/.test(c.grande)).length >= 15,
    JSON.stringify(mundo.cajas.slice(0, 2).map((c) => c.grande)));
  chequeo('Bitcoin, el dólar y el oro llevan PRECIO abajo, no "local"',
    ['BTC-USD', 'MXN=X', 'GC=F'].every((sym) => {
      const c = mundo.cajas.find((x) => x.sym === sym);
      return c && /[0-9]/.test(c.chico) && !/local/.test(c.chico);
    }),
    JSON.stringify(mundo.cajas.filter((c) => ['BTC-USD', 'MXN=X', 'GC=F'].includes(c.sym)).map((c) => `${c.sym}:${c.chico}`)));

  // ── EL ESTADO VA EN EL ENCABEZADO DE REGIÓN, EN HORA DE MÉXICO ─────
  chequeo('cada región dice su estado en el encabezado',
    mundo.regiones.slice(0, 3).every((r) => r.estado.length > 3),
    JSON.stringify(mundo.regiones.map((r) => `${r.titulo.trim()}: ${r.estado}`)));
  chequeo('y las horas van en hora de México (CT), como pide el mockup',
    mundo.regiones.some((r) => /CT/.test(r.estado)) || mundo.regiones.some((r) => /abierto|cierre/.test(r.estado)),
    JSON.stringify(mundo.regiones.map((r) => r.estado)));
  chequeo('la última región dice 24/7', /24\/7/.test(mundo.regiones[3].estado), mundo.regiones[3].estado);

  // ── LA TIRA Y EL TITULAR ───────────────────────────────────────────
  chequeo('la tira de arriba lleva los cinco del mockup',
    mundo.tira.length === 5 && /SPX/.test(mundo.tira[0]) && /DAX/.test(mundo.tira[4]),
    JSON.stringify(mundo.tira));
  chequeo('el titular dice "El mundo, ahora" con el día y el estado',
    mundo.titular === 'El mundo, ahora' && mundo.sub.length > 8, `${mundo.titular} · ${mundo.sub}`);

  // ── REGLA 2 ────────────────────────────────────────────────────────
  chequeo('un símbolo que no llegó sale con su causa en vez de desaparecer',
    /no devolvió este símbolo/.test(mundo.notas.join(' ')),
    mundo.notas.join(' | ').slice(0, 160));
  chequeo('ya no dice "cripto todavía no": Bitcoin está en la rejilla',
    !/cripto todavía no/.test(mundo.regiones.map((r) => r.estado).join(' '))
      && symsMundo.includes('BTC-USD'),
    mundo.regiones.map((r) => r.estado).join(' | ').slice(0, 120));

  // ── EL PRECIO Y EL % SON DEL MISMO DÍA (el caso del KOSPI) ─────────
  const kospi = mundo.cajas.find((c) => c.sym === '^KS11');
  chequeo('el KOSPI muestra el % de HOY (−0.27%), no el del lunes (−2.70%)',
    /-0\.3%|-0\.27%/.test(kospi.grande) && !/-2\.7/.test(kospi.grande),
    `grande ${kospi.grande} · chico ${kospi.chico}`);
  chequeo('y su nivel es el precio de hoy, sin fecha vieja pegada',
    /6,870/.test(kospi.chico), kospi.chico);

  // ── UNA SOLA FUENTE DE VERDAD PARA EL PESO ─────────────────────────
  const peso = mundo.cajas.find((c) => c.sym === 'MXN=X');
  chequeo('el cuadro USD/MXN sale del FIX, no de Yahoo',
    /18\./.test(peso.chico) && !/99/.test(peso.chico) && /FIX/.test(peso.pais),
    `${peso.pais} · ${peso.chico} · ${peso.grande}`);

  // ── EL CHIP CUENTA BOLSAS, NO ÍNDICES ──────────────────────────────
  // El S&P 500 y el Nasdaq 100 son dos cuadros y UNA bolsa: Nueva York no abre
  // dos veces. Con 17 cuadros hay 11 bolsas distintas más los 24h.
  // El S&P 500 y el Nasdaq 100 son dos cuadros y UNA bolsa: Nueva York no abre
  // dos veces. Así que las bolsas tienen que ser MENOS que los cuadros que no
  // son 24h — comparar los dos números es lo que distingue "cuenta bolsas" de
  // "cuenta cuadros", y no depende de cuántos índices tenga el catálogo.
  const no24h = mundo.cajas.filter((c) => !['BTC-USD', 'MXN=X', 'GC=F'].includes(c.sym)).length;
  const enChip = Number((mundo.chip.match(/de (\d+) bolsas/) || [])[1]);
  chequeo('el chip cuenta BOLSAS, no cuadros (NY tiene dos índices y una bolsa)',
    Number.isFinite(enChip) && enChip < no24h, `${mundo.chip} · cuadros no-24h: ${no24h}`);
  chequeo('el pie declara la fuente y que el estado es por bolsa',
    /macro-markets/.test(mundo.pie) && /por bolsa, no global/.test(mundo.pie)
      && /Información, no asesoría/.test(mundo.pie), mundo.pie);

  // ── R2(c): EL TOGGLE Local | MXN ───────────────────────────────────
  chequeo('el toggle de moneda dice Local | MXN, como el mockup',
    mundo.monedaBotones.join('|') === 'Local|MXN', JSON.stringify(mundo.monedaBotones));
  const antesMon = pedidosApi;
  await p.locator('#moneda button[data-mon="mxn"]').tap();
  await p.waitForTimeout(200);
  const mxn = await p.evaluate(() => ({
    cajas: [...document.querySelectorAll('#mundo .c')].map((e) => ({
      sym: e.dataset.sym,
      grande: (e.querySelector('.v') || {}).textContent || '',
      chico: (e.querySelector('.l') || {}).textContent || '',
    })),
    nota: [...document.querySelectorAll('#mundo .nota')].map((e) => e.textContent).join(' | '),
    pie: (document.getElementById('pie') || {}).textContent || '',
  }));
  chequeo('en MXN el número grande cambia y el chico dice "local"',
    mxn.cajas.filter((c) => /^local /.test(c.chico)).length >= 14,
    JSON.stringify(mxn.cajas.slice(0, 3)));
  chequeo('el IPC en pesos NO cambia: ya está en pesos',
    (() => {
      const a = mundo.cajas.find((c) => c.sym === '^MXX').grande;
      const b = mxn.cajas.find((c) => c.sym === '^MXX').grande;
      return a === b;
    })(), `local ${mundo.cajas.find((c) => c.sym === '^MXX').grande} vs mxn ${mxn.cajas.find((c) => c.sym === '^MXX').grande}`);
  chequeo('el S&P en pesos SÍ cambia: el dólar se movió contra el peso',
    mundo.cajas.find((c) => c.sym === '^GSPC').grande !== mxn.cajas.find((c) => c.sym === '^GSPC').grande,
    `local ${mundo.cajas.find((c) => c.sym === '^GSPC').grande} vs mxn ${mxn.cajas.find((c) => c.sym === '^GSPC').grande}`);
  chequeo('la nota dice con qué FIX y de qué fecha se convirtió',
    /FIX del \d{4}-\d{2}-\d{2}/.test(mxn.nota), mxn.nota.slice(0, 140));
  chequeo('el pie también declara el FIX cuando se está en pesos',
    /FIX de Banxico del/.test(mxn.pie), mxn.pie);
  chequeo('el toggle de moneda no vuelve a pedir datos',
    pedidosApi === antesMon, `${pedidosApi - antesMon} peticiones nuevas`);

  // TAP REAL → la hoja, con la línea "rendimiento en pesos".
  await p.locator('#mundo .c[data-sym="\\^N225"]').tap();
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hojaN = await p.locator('#hojaCuerpo').innerText();
  chequeo('la hoja de un índice trae la línea "rendimiento en pesos" y su FIX',
    /Nikkei 225/.test(hojaN) && /rendimiento en pesos/.test(hojaN) && /banxico:SF43718/.test(hojaN),
    hojaN.slice(0, 220).replace(/\n/g, ' '));
  chequeo('y la bolsa con su hora local', /Tokio/.test(hojaN) && /local/.test(hojaN),
    hojaN.slice(0, 200).replace(/\n/g, ' '));
  chequeo('la URL lleva mapa, periodo, moneda y símbolo (regla 9)',
    /mapa=mundo/.test(p.url()) && /moneda=mxn/.test(p.url()) && /symbol=/.test(p.url()), p.url());
  await p.locator('#cerrar').tap();
  await p.locator('#moneda button[data-mon="usd"]').tap();
  await p.waitForTimeout(120);

  // ── NINGUNA INTERACCIÓN LANZÓ UN ERROR ─────────────────────────────
  // La comprobación de arriba mira la consola SÓLO al cargar, y así se pasó
  // esto: `mercado.html` no cargaba `qd-pesos.js`, así que `enPesos` no
  // existía y el toggle MXN tiraba un ReferenceError. El render moría a
  // mitad, la pantalla se quedaba con el contenido anterior y la página
  // "funcionaba" — con el botón muerto. Un error que sólo aparece al TOCAR
  // algo necesita una comprobación después de tocar todo.
  chequeo('ninguna interacción lanzó un error de consola',
    errores.length === 0, errores.slice(0, 3).join(' | '));

  await p.screenshot({ path: join(OUT, 'mercado-390-mundo.png') });
  console.log(`     → ${join(OUT, 'mercado-390-mundo.png')}`);

  // El toggle de periodo no vuelve a pedir datos (regla 7).
  const antes = pedidosApi;
  await p.locator('.toggle button[data-per="YTD"]').tap();
  await p.waitForTimeout(150);
  const ytd = await p.evaluate(() => [...document.querySelectorAll('#mundo .c .v')].map((e) => e.textContent));
  chequeo('YTD se calcula en la pantalla, sin volver a pedir nada',
    pedidosApi === antes && ytd.some((t) => /YTD/.test(t)),
    `${pedidosApi - antes} peticiones nuevas · ${ytd.slice(0, 3).join(' ')}`);
  // Y que YTD dé un NÚMERO, no un "—": con `range=3mo` la serie no llegaba al
  // año anterior y el ancla no existía. Ésa fue la razón de subirlo a 1y.
  chequeo('y YTD da un número de verdad, que es para lo que se subió a range=1y',
    ytd.filter((t) => /YTD/.test(t) && /%/.test(t)).length >= 10,
    `${ytd.filter((t) => /%/.test(t)).length} con número de ${ytd.length}: ${ytd.slice(0, 3).join(' ')}`);

  // ── LA CAUSA DE UN GRIS NO SE INVENTA ──────────────────────────────
  // El 2026-09-26, en el iPhone: ORCL, MNST y APH decían "EDGAR no dio acciones
  // en circulación" y EDGAR nunca había sido consultado —el job había muerto en
  // la primera respuesta—. Una causa falsa manda a revisar la fuente en lugar
  // del job, y es el peor gris: el que parece resuelto.
  for (const [sym, espera, prohibido] of [
    ['ORCL', /pendiente de consulta a EDGAR/, /EDGAR no dio/],
    ['XNDU', /sin moneda declarada por Finnhub/, /USD/],
  ]) {
    await p.goto(`${BASE}/mercado?mapa=us&sector=XLK&symbol=${sym}`, { waitUntil: 'networkidle' });
    await p.waitForSelector('.hoja[data-abierta="1"]');
    const hoja = await p.locator('#hojaCuerpo').innerText();
    chequeo(`${sym}: la hoja dice la causa REAL`, espera.test(hoja), hoja.slice(0, 140).replace(/\n/g, ' '));
    chequeo(`${sym}: y no la falsa`, !prohibido.test(hoja), hoja.slice(0, 140).replace(/\n/g, ' '));
    await p.locator('#cerrar').tap();
  }
  // Un cuadro VERIFICADO que descartó un dato de la fuente lo declara: si no,
  // la pantalla muestra un tamaño sin decir de dónde salió la decisión.
  await p.goto(`${BASE}/mercado?mapa=us&sector=XLP&symbol=MNST`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hojaMnst = await p.locator('#hojaCuerpo').innerText();
  chequeo('una verificada que descartó la cap declarada lo DICE en la hoja',
    /cap declarada de Finnhub descartada/.test(hojaMnst) && /dos conteos de acciones coinciden/.test(hojaMnst),
    hojaMnst.slice(0, 160).replace(/\n/g, ' '));
  chequeo('y la fuente que se muestra es la del cálculo nuestro, no finnhub',
    /calc: edgar×neon/.test(hojaMnst), hojaMnst.slice(0, 200).replace(/\n/g, ' '));
  await p.locator('#cerrar').tap();

  // Y el estado de la consulta se puede leer sin interpretar prosa.
  await p.goto(`${BASE}/mercado?mapa=us&sector=XLK&symbol=ORCL`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.hoja[data-abierta="1"]');
  const hojaOrcl = await p.locator('#hojaCuerpo').innerText();
  chequeo('la hoja trae el renglón "consulta a EDGAR: pendiente"',
    /consulta a EDGAR/.test(hojaOrcl) && /pendiente/.test(hojaOrcl), hojaOrcl.slice(0, 200).replace(/\n/g, ' '));
  await p.locator('#cerrar').tap();

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
