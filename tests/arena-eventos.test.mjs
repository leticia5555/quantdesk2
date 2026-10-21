// ═══════════════════════════════════════════════════════════════
// tests/arena-eventos.test.mjs — la quinta herramienta: eventos(ticker).
//
// Lo que se blinda:
//   1. SOLO EL ITEM: una línea por 8-K, con su código y la etiqueta corta.
//      Nunca el cuerpo del filing. El 9.01 se omite y se DECLARA.
//   2. EL CERO Y LA FALLA NO SE CONFUNDEN: EDGAR caído → "eventos: sin datos
//      hoy" con `error: true` (no se cachea); sin 8-K → cero honesto.
//   3. CACHEADO POR DÍA: dos llamadas iguales pagan una bajada.
//   4. LOS TOKENS DE CADA LLAMADA se journalean en el resumen.
//   5. APAGADA POR DEFECTO: ningún agente la ve ni la puede llamar hasta que
//      `ARENA_TOOLS_EXTRA=eventos` lo decida.
//
// Sin red: EDGAR se inyecta.
// Correr con `node tests/arena-eventos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { runEventos, eventosDeSubmissions, etiquetaItem, _resetMemoMapa } from '../api/_lib/arena-tools-eventos.js';
import { createToolExecutor, toolsForProvider, herramientasActivas, TOOL_DEFS, clampArgs, estimateTokens } from '../api/_lib/arena-tools.js';
import { secuenciaPublicable } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const HOY = new Date('2026-10-20T15:00:00Z');
const SUB = {
  filings: {
    recent: {
      form: ['4', '8-K', '10-Q', '8-K', '8-K/A', '8-K', '8-K'],
      filingDate: ['2026-10-19', '2026-10-15', '2026-10-10', '2026-10-02', '2026-09-30', '2026-09-01', '2026-10-12'],
      items: ['', '2.02,9.01', '', '5.02', '1.01,9.01', '8.01', '9.01'],
      // El cuerpo NO viaja nunca, aunque EDGAR lo describa.
      primaryDocDescription: ['', 'PRESS RELEASE Q3 RESULTS ' + 'X'.repeat(3000), '', '', '', '', ''],
    },
  },
};
const MAPA = { MU: { cik: '723125' }, 'BRK-B': { cik: '1067983' } };
const deps = (over = {}) => ({ tickerMap: async () => MAPA, submissions: async () => SUB, ...over });
const ctx = (over = {}) => ({ now: HOY, deps: deps(over) });

console.log('\n── 1) solo el item, una línea por evento ──');
{
  ok(etiquetaItem('2.02') === 'resultados' && etiquetaItem('1.01') === 'acuerdo material'
    && etiquetaItem('5.02') === 'cambio de directivo' && etiquetaItem('8.01') === 'otros eventos',
  'las cuatro etiquetas, con la redacción pedida');
  ok(etiquetaItem('7.01') === 'divulgación bajo Regulation FD', 'el resto sale del glosario de HISTORIA', etiquetaItem('7.01'));
  ok(etiquetaItem('9.99') === 'item 9.99', 'un código desconocido no se inventa');

  const r = await runEventos({ ticker: 'MU', days: 30 }, ctx());
  const lineas = r.text.split('\n');
  ok(r.rows === 4 && !r.error, 'cuatro 8-K en 30 días (el 10-Q, el Form 4 y el del 1-sep no cuentan)', r.text);
  ok(lineas[1] === '2026-10-15 · 8-K · 2.02 resultados', 'el más nuevo primero, con el 9.01 omitido', lineas[1]);
  ok(lineas.includes('2026-10-02 · 8-K · 5.02 cambio de directivo'), 'el 5.02');
  ok(lineas.includes('2026-09-30 · 8-K/A · 1.01 acuerdo material'), 'las enmiendas 8-K/A también');
  ok(lineas.includes('2026-10-12 · 8-K · solo anexos (9.01)'), 'un 8-K que solo trae 9.01 se dice así, no desaparece');
  ok(/9\.01 anexos se omite/.test(lineas[0]), 'la omisión se DECLARA en la cabecera');
  ok(!/PRESS RELEASE|XXXX/.test(r.text) && r.text.length < 600, 'nunca el cuerpo del filing', String(r.text.length));

  const dos = await runEventos({ ticker: 'MU', days: 14 }, ctx());
  ok(dos.rows === 2, 'la ventana se respeta (14 días → 2)', dos.text);

  const muchos = { filings: { recent: { form: Array(40).fill('8-K'), filingDate: Array(40).fill('2026-10-19'), items: Array(40).fill('8.01') } } };
  const m = eventosDeSubmissions(muchos, { desde: '2026-10-01', max: 15 });
  ok(m.eventos.length === 15 && m.total === 40, 'acotado a 15 líneas, contando los 40');
  const rm = await runEventos({ ticker: 'MU' }, ctx({ submissions: async () => muchos }));
  ok(/40 8-K de MU.*se muestran los 15 más recientes/.test(rm.text), 'y el recorte se dice', rm.text.split('\n')[0]);
}

console.log('\n── 2) el cero y la falla no se confunden ──');
{
  const caido = await runEventos({ ticker: 'MU' }, ctx({ submissions: async () => { throw new Error('HTTP 503'); } }));
  ok(caido.error === true && /^eventos: sin datos hoy/.test(caido.text) && caido.rows === null,
    'EDGAR caído → "eventos: sin datos hoy", error, y filas null (no cero)', caido.text);
  ok(/NO significa que MU no haya presentado/.test(caido.text), 'y dice que no es un "no hubo"');
  const sinMapa = await runEventos({ ticker: 'MU' }, ctx({ tickerMap: async () => { throw new Error('timeout'); } }));
  ok(sinMapa.error === true && /sin datos hoy/.test(sinMapa.text), 'el padrón caído es la misma falla');

  const vacio = await runEventos({ ticker: 'MU', days: 1 }, ctx());
  ok(vacio.rows === 0 && !vacio.error && /Sin 8-K de MU en los últimos 1 día/.test(vacio.text),
    'sin 8-K en la ventana → cero honesto, con cuántos filings se revisaron', vacio.text);
  const etf = await runEventos({ ticker: 'SPY' }, ctx());
  ok(etf.rows === 0 && etf.sin_cik && /no está en el padrón/.test(etf.text), 'un ticker sin CIK lo dice');
  const brk = await runEventos({ ticker: 'BRK.B' }, ctx());
  ok(brk.rows > 0, 'BRK.B se busca como BRK-B, como lo escribe EDGAR');
  ok((await runEventos({}, ctx())).error === true, 'sin ticker es error');

  // El mapa ticker→CIK se memoriza por día en el proceso, y un fallo no.
  _resetMemoMapa();
  let bajadas = 0;
  const cli = { json: async (url) => { bajadas++; if (/company_tickers/.test(url)) return { json: { 0: { ticker: 'MU', cik_str: 723125, title: 'Micron' } }, bytes: 1 }; return { json: SUB, bytes: 1 }; } };
  await runEventos({ ticker: 'MU' }, { now: HOY, deps: { edgarCliente: cli } });
  await runEventos({ ticker: 'MU' }, { now: HOY, deps: { edgarCliente: cli } });
  ok(bajadas === 3, 'el padrón se baja una vez por día y proceso (1 padrón + 2 submissions)', String(bajadas));
  _resetMemoMapa();
}

console.log('\n── 3) y 4) cacheado por día, tokens journaleados, apagada por defecto ──');
{
  ok(herramientasActivas({}).join(',') === 'screener,noticias,ficha,sector', 'por defecto: las cuatro de siempre');
  ok(toolsForProvider('anthropic', null, {}).length === TOOL_DEFS.length && !toolsForProvider('openrouter', null, {}).some((t) => t.function.name === 'eventos'),
    'ningún agente ve `eventos` sin la bandera');
  const env = { ARENA_TOOLS_EXTRA: 'eventos' };
  ok(herramientasActivas(env).includes('eventos'), 'ARENA_TOOLS_EXTRA=eventos la enciende');
  const def = toolsForProvider('anthropic', null, env).find((t) => t.name === 'eventos');
  ok(def && def.input_schema.required.includes('ticker'), 'y viaja con su schema');
  ok(!herramientasActivas({ ARENA_TOOLS_EXTRA: 'borrar_todo' }).includes('borrar_todo'), 'una bandera con un nombre que no existe no inventa herramientas');

  const { args, notes } = clampArgs('eventos', { ticker: 'mu', days: 500 });
  ok(args.ticker === 'MU' && args.days === 60 && notes.length === 1, 'los días se ACOTAN a 60 y se avisa');

  const apagada = createToolExecutor({ now: HOY, cache: false, herramientas: herramientasActivas({}), deps: deps() });
  const r0 = await apagada.call('eventos', { ticker: 'MU' });
  ok(r0.unknown_tool === true, 'apagada: llamarla es llamar una herramienta inexistente');

  let consultas = 0;
  const ex = createToolExecutor({
    now: HOY, cache: false, herramientas: herramientasActivas(env),
    deps: deps({ submissions: async () => { consultas++; return SUB; } }),
  });
  const r1 = await ex.call('eventos', { ticker: 'MU', days: 30 });
  ok(r1.rows === 4, 'encendida: corre');
  const paso = ex.summary()[0];
  ok(paso.tokens === estimateTokens(r1.text) && paso.tokens > 0, 'el resumen journalea los tokens que agregó la llamada', String(paso.tokens));
  const pub = secuenciaPublicable({ tools: { summary: ex.summary() } });
  ok(pub.pasos[0].tokens === paso.tokens, 'y /api/liga/libros los publica por paso');
  ok(consultas === 1, 'una consulta a EDGAR por llamada (con `cache: false`)');
}

// La caché del ejecutor es la de arena_buffet_cache (por día). Se verifica la
// regla que importa sin base: un ERROR no se escribe, un resultado sí.
console.log('\n── la caché por día no guarda la falla ──');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/_lib/arena-tools.js', import.meta.url), 'utf8');
  // Desde #302 la condición suma `no_cachear` (429 de Finnhub) y la cobertura
  // parcial de noticias; lo que importa acá sigue siendo `!out.error`.
  ok(/if \(cache && !out\.error[^)]*\) await writeDayCache\(key, out, now\)/.test(src),
    'el ejecutor solo cachea lo que no es error: "sin datos hoy" se reintenta en la próxima llamada');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
