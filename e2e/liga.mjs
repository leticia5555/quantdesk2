// e2e/liga.mjs — el razonamiento, a la vista en /liga y /liga/libros.
//
// Prueba lo que se VE, con /api/leaderboard y /api/liga/libros stubbeados. El
// feed de libros se arma con las funciones REALES del endpoint (libroDeFila +
// avisosDeHerramientas) sobre filas de journal falsas: si el servidor cambia
// la forma de un paso, esto lo ve sin que nadie actualice un fixture a mano.
//
//   node e2e/server.mjs &   # sirve el repo en :8931
//   node e2e/liga.mjs

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

import { libroDeFila, avisosDeHerramientas, FUENTE_VIVA } from '../api/liga-libros.js';

let fallas = 0;
const report = (nombre, ok, detalle) => {
  if (!ok) fallas++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + nombre + (detalle ? ' | ' + detalle : ''));
};

const HOY = '2026-10-20';
const fila = (agent_id, hora, weights, theses, summary) => ({
  run_date: HOY, created_at: `${HOY}T${hora}:00Z`, agent_id, status: 'ok_target',
  plan: `Plan de ${agent_id}.`, actions: [], account: null,
  target: { weights, cash: +(1 - Object.values(weights).reduce((a, b) => a + b, 0)).toFixed(2), theses },
  rebalance: null,
  context: { lens: 'momentum', tools: { budget: 8, used: summary.length, turns: 3, stopped_by: 'end_turn', summary } },
});
const FILAS = [
  // Grok 20-oct, como vino de arena_shadow_journal: investigó y se quedó sin
  // cupo justo al explorar. Los 4 del final NO fallaron: ni corrieron.
  fila('grok', '15:40', { MU: 0.15, NVDA: 0.10 }, { MU: 'memoria en ciclo alcista', NVDA: 'demanda de centros de datos' }, [
    { n: 19, tool: 'ficha', args: { ticker: 'NVDA' }, rows: 9, ms: 700 },
    { n: 20, tool: 'noticias', args: { ticker: 'NVDA' }, rows: 5, ms: 300 },
    { tool: 'screener', args: { near_52w_high: true, limit: 25 }, intento: 21, refused: 'budget_exhausted' },
    { tool: 'ficha', args: { ticker: 'MU' }, intento: 22, refused: 'budget_exhausted' },
    { tool: 'ficha', args: { ticker: 'WDC' }, intento: 23, refused: 'budget_exhausted' },
    { tool: 'ficha', args: { ticker: 'STX' }, intento: 24, refused: 'budget_exhausted' },
  ]),
  // Una falla DE VERDAD (corrió y no devolvió nada), en otro agente.
  fila('qwen', '15:41', { AAPL: 0.10 }, { AAPL: 'caja' }, [
    { n: 1, tool: 'screener', args: {}, rows: 0, error: true, sin_resultado: true, ms: 30 },
    { n: 2, tool: 'noticias', args: { ticker: 'AAPL' }, rows: 0, error: true, ms: 200 },
  ]),
  fila('deepseek', '15:42', { FICO: 0.20, MSFT: 0.10 }, { FICO: 'core holding, just less of it', MSFT: 'nube estable' }, [
    { n: 1, tool: 'screener', args: { rvol_top: true, sector: 'XLK' }, rows: 0, ms: 20 },
    { n: 2, tool: 'ficha', args: { ticker: 'FICO' }, rows: 9, truncated: true, ms: 700 },
  ]),
];
const libros = FILAS.map((r) => libroDeFila(r, FUENTE_VIVA)).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
const LIBROS = { libros, avisos: avisosDeHerramientas(libros), herramientas: null, conteos: { libros: libros.length } };

const agente = (id, name, rank) => ({
  id, name, rank, model_label: name + ' X', house: 'x',
  account: { equity: 100000, cash: 50000 }, positions: [], return_pct: 1, day_change_pct: 0.1,
  journal: { plan: `Plan de ${id}.`, created_at: `${HOY}T15:40:00Z`, run_date: HOY, status: 'ok_target', ordenes: [] },
});
const LEADERBOARD = { enabled: true, agents: [agente('grok', 'Grok', 1), agente('deepseek', 'DeepSeek', 2), agente('qwen', 'Qwen', 3)], baseline_equity: 100000 };

const nav = globalThis.process;
const browser = await chromium.launch();
async function abrir(ruta, { librosOk = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.route('**/api/leaderboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LEADERBOARD) }));
  await page.route('**/api/liga/libros**', (r) => (librosOk
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIBROS) })
    : r.fulfill({ status: 500, body: 'x' })));
  await page.route('**/api/**', (r) => r.fallback());
  await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
  await page.goto('http://127.0.0.1:8931' + ruta, { waitUntil: 'domcontentloaded' });
  return { page, errores };
}

// ── 1. /liga: la cadena y las tesis, sin abrir nada ──────────────────
{
  const { page, errores } = await abrir('/leaderboard.html');
  await page.waitForSelector('.decide', { timeout: 8000 }).catch(() => {});
  report('la página carga sin errores de JS', errores.length === 0, errores.join(' · '));
  report('cada agente trae su bloque "cómo decidió"', (await page.locator('.decide').count()) === 3);
  const grok = await page.locator('.row', { hasText: 'Grok' }).first().innerText();
  report('la cadena se lee como historia', /ficha NVDA → 9 líneas/.test(grok) && /noticias NVDA → 5 titulares/.test(grok), grok.slice(0, 300));
  report('un rechazo por cupo dice "rechazada: presupuesto"', /screener\(near_52w_high, limit=25\) → rechazada: presupuesto/.test(grok) && /ficha STX → rechazada: presupuesto/.test(grok));
  report('…y NO se pinta como falla', (await page.locator('.row', { hasText: 'Grok' }).locator('.cadena .fallo').count()) === 0 && !/✕/.test(grok));
  const qwen = await page.locator('.row', { hasText: 'Qwen' }).first().innerText();
  report('corrió-y-nada y corrió-y-falló se dicen distinto, en rojo', /screener\(\) → ✕ sin resultado/.test(qwen) && /noticias AAPL → ✕ falló/.test(qwen)
    && (await page.locator('.row', { hasText: 'Qwen' }).locator('.cadena .fallo').count()) === 2, qwen.slice(0, 200));
  report('las tesis están a la vista, con su peso', /MU 15\.0% — memoria en ciclo alcista/.test(grok), grok.match(/MU[^\n]*memoria[^\n]*/)?.[0]);
  const ds = await page.locator('.row', { hasText: 'DeepSeek' }).first().innerText();
  report('la tesis de FICO sale tal cual (para que se vea que no hay tesis)', /FICO 20\.0% — core holding, just less of it/.test(ds));
  report('un filtro vacío de verdad es "0 nombres", no una falla', /screener\(rvol_top, sector=XLK\) → 0 nombres/.test(ds));
  const href = await page.locator('.row', { hasText: 'Grok' }).locator('.decide a').getAttribute('href');
  report('enlaza a todas sus corridas', href === '/liga/libros?agente=grok', href);
  await page.screenshot({ path: nav.env.LIGA_SHOT || '/tmp/liga.png', fullPage: true });
  await page.close();
}

// ── 2. /liga sin /api/liga/libros: la tabla sale igual ───────────────
{
  const { page, errores } = await abrir('/leaderboard.html', { librosOk: false });
  await page.waitForSelector('.row', { timeout: 8000 }).catch(() => {});
  report('si el razonamiento no carga, el ranking sale igual', (await page.locator('.row').count()) >= 2 && errores.length === 0, errores.join(' · '));
  report('…y sin bloques vacíos', (await page.locator('.decide').count()) === 0);
  await page.close();
}

// ── 3. /liga/libros: la cadena fuera del colapsado y el aviso arriba ─
{
  const { page, errores } = await abrir('/libros.html');
  await page.waitForSelector('.cadena', { timeout: 8000 }).catch(() => {});
  report('libros carga sin errores de JS', errores.length === 0, errores.join(' · '));
  const cadena = await page.locator('.card', { hasText: 'Grok' }).locator('.cadena').first();
  report('la cadena se ve sin abrir la tarjeta', await cadena.isVisible());
  const body = await page.locator('body').innerText();
  report('avisos publica las herramientas que fallaron', /Qwen: 2 llamadas a herramientas fallaron en 1 corrida \(screener\(\), noticias AAPL\)/.test(body),
    (body.match(/Qwen: \d+ llamada[^\n]*/) || [''])[0]);
  report('Grok NO sale en avisos: sus 4 se negaron por cupo, no fallaron', !/Grok: \d+ llamada/.test(body));
  report('deepseek no sale en avisos: un 0 legítimo no es falla', !/DeepSeek: \d+ llamada/.test(body));
  await page.close();
}

await browser.close();
console.log(fallas ? `\n${fallas} FALLA(S)\n` : '\nTODO EN VERDE\n');
nav.exit(fallas ? 1 : 0);
