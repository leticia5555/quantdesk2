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
const LEADERBOARD = { enabled: true, agents: [agente('grok', 'Grok', 1), agente('deepseek', 'DeepSeek', 2), agente('qwen', 'Qwen', 3)], baseline_equity: 100000,
  // El saldo que leyó el vigilante (2026-10-21): bajo el piso → aviso arriba de la tabla.
  saldo_openrouter: { usd: 6.79, piso: 10, bajo: true, fuente: 'credits', at: '2026-10-21T18:10:00.000Z',
    aviso: 'SALDO DE OPENROUTER BAJO: $6.79, por debajo del piso de $10. Los cinco agentes de OpenRouter dependen de esa cuenta: sin créditos, cada corrida aborta con causa "cuenta" (nuestra, no del modelo).' } };

// Técnicos por posición (2026-10-23): MU con historia completa y SPCX recién
// listada (sin SMA200 ni 6m) → "n/d", nunca 0. Salen de la MISMA función que
// usa /api/leaderboard.
const { tecnicosDeCierres } = await import('../api/_lib/tecnicos.js');
LEADERBOARD.agents[0].positions = [
  { symbol: 'MU', qty: 40, avg_entry: 110, market_value: 12000, unrealized_pl: 400, unrealized_plpc: 0.034,
    tecnicos: tecnicosDeCierres(Array.from({ length: 215 }, (_, i) => 100 + i + (i % 3 === 0 ? -2 : 0))) },
  { symbol: 'SPCX', qty: 10, avg_entry: 50, market_value: 1100, unrealized_pl: 100, unrealized_plpc: 0.1,
    tecnicos: tecnicosDeCierres(Array.from({ length: 60 }, (_, i) => 50 + i)) },
  // Recién llegada al feed: 10 sesiones, ni RSI(14). Todo n/d.
  { symbol: 'NEWX', qty: 5, avg_entry: 20, market_value: 100, unrealized_pl: 0, unrealized_plpc: 0,
    tecnicos: tecnicosDeCierres(Array.from({ length: 10 }, (_, i) => 20 + i)) },
];

// Comportamiento (2026-10-23): sale de las MISMAS funciones que usa el
// endpoint, con datos chicos. grok con persecución medida y acierto a 5
// sesiones todavía null; deepseek sin nada.
const C = await import('../api/_lib/liga-comportamiento.js');
const datosComp = {
  decisiones: [
    { agent_id: 'grok', symbol: 'T', lado: 'buy', cantidad: 457, precio_ejecucion: 21.92, dia_fill: '2026-10-21', filled_at: '2026-10-21T16:02:22Z', resultado_1_pct: 3.74, resultado_5_pct: null },
    { agent_id: 'control', symbol: 'VRT', lado: 'buy', cantidad: 22, precio_ejecucion: 215.49, dia_fill: '2026-10-21', filled_at: '2026-10-21T14:01:13Z', resultado_1_pct: -9.24, resultado_5_pct: null },
  ],
  equityDiario: [], libros: [], spy: {}, aperturas: { T: { '2026-10-21': 21.9 }, VRT: { '2026-10-21': 216.5 } },
};
const compControl = C.comportamientoDe('control', datosComp);
const COMPORTAMIENTO = { desde: '2026-10-20', agentes: ['grok', 'deepseek'].map((id) => {
  const m = C.comportamientoDe(id, datosComp);
  return { agent: id, metricas: m, con_control: C.ladoALado(m, compControl) };
}).concat([{ agent: 'qwen', metricas: compControl, con_control: null }]) };

const nav = globalThis.process;
const browser = await chromium.launch();
async function abrir(ruta, { librosOk = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.route('**/api/leaderboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LEADERBOARD) }));
  await page.route('**/api/liga/comportamiento**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COMPORTAMIENTO) }));
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
  const saldo = await page.locator('#saldo').innerText();
  report('el saldo bajo de OpenRouter sale arriba de la tabla', /Saldo de OpenRouter bajo/i.test(saldo) && /\$6\.79/.test(saldo) && /18:10 UTC/.test(saldo), saldo.slice(0, 160));
  const yBoard = await page.locator('#board').boundingBox();
  const ySaldo = await page.locator('#saldo').boundingBox();
  report('…y ANTES del ranking', !!(ySaldo && yBoard && ySaldo.y < yBoard.y));
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
  // ── técnicos por posición ──
  const tecs = page.locator('.row', { hasText: 'Grok' }).locator('details.tecs');
  report('Grok trae la tabla de técnicos de sus 3 posiciones', (await tecs.count()) === 1 && /técnicos de sus 3 posiciones/i.test(await tecs.locator('summary').innerText()));
  await tecs.locator('summary').click();
  const filaMu = await tecs.locator('tr', { hasText: 'MU' }).innerText();
  const tMu = LEADERBOARD.agents[0].positions[0].tecnicos;
  report('MU: RSI, vs SMA50/SMA200 y 1m/3m/6m con los números del endpoint',
    filaMu.includes(tMu.rsi14.toFixed(1)) && filaMu.includes('+' + tMu.vs_sma200_pct.toFixed(1) + '%') && filaMu.includes('+' + tMu.ret_6m_pct.toFixed(1) + '%'), filaMu.replace(/\s+/g, ' '));
  const filaSp = (await tecs.locator('tr', { hasText: 'SPCX' }).innerText()).replace(/\s+/g, ' ');
  report('SPCX con 60 sesiones: n/d en SMA200, 3m y 6m, nunca 0', (filaSp.match(/n\/d/g) || []).length === 3 && !/ 0\.0%/.test(filaSp), filaSp);
  const filaNx = (await tecs.locator('tr', { hasText: 'NEWX' }).innerText()).replace(/\s+/g, ' ');
  report('NEWX con 10 sesiones: las seis columnas en n/d, ni un 0', (filaNx.match(/n\/d/g) || []).length === 6 && !/\b0\.0/.test(filaNx), filaNx);
  // ── comportamiento con control al lado ──
  await page.waitForSelector('details.comp', { timeout: 8000 }).catch(() => {});
  const comp = page.locator('.row', { hasText: 'Grok' }).locator('details.comp');
  report('Grok trae su tarjeta de comportamiento, con control al lado', (await comp.count()) === 1 && /con control al lado/i.test(await comp.locator('summary').innerText()));
  await comp.locator('summary').click();
  const pers = (await comp.locator('tr', { hasText: 'persecución' }).innerText()).replace(/\s+/g, ' ');
  const pc = COMPORTAMIENTO.agentes[0].con_control.persecucion_prom_pct;
  report('persecución: agente, control y diferencia', pers.includes(pc.agente.toFixed(2)) && pers.includes(pc.control.toFixed(2)) && pers.includes(pc.diferencia.toFixed(2)), pers);
  const acierto = (await comp.locator('tr', { hasText: 'compras arriba' }).innerText()).replace(/\s+/g, ' ');
  report('acierto a 5 sesiones todavía sin medir: n/d en las tres columnas, ni un 0', (acierto.match(/n\/d/g) || []).length === 3 && !/\b0\.00/.test(acierto), acierto);
  report('la nota dice que la diferencia de claude es el ruido', /la de claude es el ruido del sistema/.test(await comp.innerText()));
  const ctrl = page.locator('.row', { hasText: 'Qwen' }).locator('details.comp');
  await ctrl.locator('summary').click();
  report('la tarjeta de control no se compara consigo misma (sin columna dif.)', (await ctrl.locator('th').count()) === 2);
  report('los agentes sin posiciones no traen tabla', (await page.locator('details.tecs').count()) === 1);
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  report('la tabla no desborda la página en 390 px (se desplaza adentro)', ancho);
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
